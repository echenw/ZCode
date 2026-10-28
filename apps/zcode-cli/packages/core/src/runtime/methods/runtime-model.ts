import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  hasModelUsage,
  type ModelNetworkStatusEvent,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
  type ModelRequestSessionType,
  type ModelRetryBudget,
  type ModelStatusSink,
  type ModelStreamEvent,
  type ModelUsage,
} from "@zcode/contracts";
import { assertMultiAgentTokenBudget } from "../../multi-agent/budget.js";
import {
  CoreErrorType,
  createCoreError,
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type Model,
  type ModelInvocationContext,
  type ModelRequest,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelFactoryInput } from "../types.js";
import {
  resolveModelRequestSessionTypeFromTaskType,
  resolveModelRetryBudgetFromTaskType,
} from "./model-request-session-type.js";
import { getOffPeakModelBinding } from "../off-peak/model-binding.js";
import { recordRuntimeModelUsage } from "./usage-observability.js";

interface RuntimeModelInvocationOwner {
  active: boolean;
  runtime: AgentRuntimeInternal;
  check(): void;
}
// An inherited Active Model can contain its parent's runtime wrappers. Only the outer caller
// owns this invocation; this scoped marker carries no task state or alternate usage ledger.
const runtimeModelInvocationOwner = new AsyncLocalStorage<RuntimeModelInvocationOwner>();
const activeRuntimeModelOwner = () => {
  const owner = runtimeModelInvocationOwner.getStore();
  return owner?.active ? owner : undefined;
};

export function createRuntimeModel(
  runtime: AgentRuntimeInternal,
  input: Omit<RuntimeModelFactoryInput, "selection"> & {
    selection: RuntimeModelFactoryInput["selection"] | undefined;
    scope?: "session" | "workspace";
    /**
     * 覆盖按 taskType 解析的重试预算，只绑定到本次创建的句柄，不进入 Factory 输入。
     * 目前只有带 selectionFallback 声明的执行作用域 Selection 使用 single-attempt。
     */
    retryBudget?: ModelRetryBudget;
  },
): Model {
  const { retryBudget, scope = "session", ...factoryInput } = input;
  // 未绑定 Session 可恢复历史；仅在执行入口拒绝缺失选择，Factory 契约仍严格。
  if (!factoryInput.selection) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Select a model before continuing", {
      recoverable: true,
    });
  }
  const model = withRuntimeInvocationLayer(
    runtime,
    runtime.modelFactory({ ...factoryInput, selection: factoryInput.selection }),
    scope === "workspace"
      ? "other"
      : resolveModelRequestSessionTypeFromTaskType(runtime.config.taskType),
    retryBudget,
  );
  return getOffPeakModelBinding(input.requestDependencies)?.wrap(model) ?? model;
}

/**
 * runtime 层调用上下文。
 *
 * 准入端口与重试预算回答的是「谁在调」（这个 runtime 归哪个治理器管、允许多少次重试），不是
 * 「为什么调」（agent step / web_search / compact / title）。设计缺口：它们若只在 turn step
 * 的调用上下文里注入，WebSearch / WebFetch 处理 / 压缩 / 标题 sidecar 等九处只设「为什么调」的
 * 调用点全部绕过了闸门——实测场景下治理器看不见三分之二的 429。现在这两个字段在句柄
 * 工厂绑定一次；`withModelInvocationContext` 的合并顺序让本层压过调用层，没有逐调用退出口：
 * 想不受闸门约束的 runtime 本来就不带准入端口。
 */
function withRuntimeInvocationLayer(
  runtime: AgentRuntimeInternal,
  model: Model,
  sessionType: ModelRequestSessionType,
  retryBudget?: ModelRetryBudget,
): Model {
  const admission = withRootTokenAdmission(runtime, runtime.modelRequestAdmission);
  const layer: ModelInvocationContext = {
    // 原因：标题、Memory、工具调用曾按用途覆写 other，丢失宿主分类。
    // 会话类型统一绑定在句柄上；工作区独立请求即使借用会话 runtime 也保持 other。
    modelRequestSessionType: sessionType,
    // 带退回声明的执行句柄显式传入 single-attempt，其余沿用 taskType 默认预算。
    modelRetryBudget: retryBudget ?? resolveModelRetryBudgetFromTaskType(runtime.config.taskType),
    ...(admission === undefined
      ? {}
      : { modelRequestAdmission: admission }),
  };
  const contextual = withModelInvocationContext(model, () => {
    const owner = activeRuntimeModelOwner();
    return owner && owner.runtime !== runtime ? {} : layer;
  });
  return runtime.multiAgentRegistry && runtime.config.multiAgentIdentity
    ? withRootTokenUsage(runtime, contextual)
    : contextual;
}

/** Compose the root budget with the existing governor; never replace its ticket or release path. */
function withRootTokenAdmission(
  runtime: AgentRuntimeInternal,
  admission: ModelRequestAdmission | undefined,
): ModelRequestAdmission | undefined {
  if (!runtime.multiAgentRegistry || !runtime.config.multiAgentIdentity) return admission;
  const check = () => {
    // Adapter telemetry isolates sink errors. A failed durable usage write still fences retry.
    activeRuntimeModelOwner()?.check();
    assertMultiAgentTokenBudget(runtime.multiAgentRegistry, runtime.config.multiAgentIdentity, runtime.config.multiAgentV2);
  };
  const emptyTicket = (): ModelRequestAdmissionTicket => ({ publish() {}, release() {} });
  const accepted = (ticket: ModelRequestAdmissionTicket): ModelRequestAdmissionTicket => {
    try { check(); return ticket; } catch (error) { ticket.release(); throw error; }
  };
  return {
    ...(admission === undefined || admission.tryAcquire
      ? { tryAcquire(input: Parameters<NonNullable<ModelRequestAdmission["tryAcquire"]>>[0]) {
          check();
          const ticket = admission ? admission.tryAcquire!(input) : emptyTicket();
          return ticket && accepted(ticket);
        } }
      : {}),
    async acquire(input) {
      await runtime.multiAgentPersistence?.ready;
      check();
      const ticket = admission ? await admission.acquire(input) : emptyTicket();
      // Another root member can exhaust the budget while this request waits in the governor.
      return accepted(ticket);
    },
  };
}

/** Tool models use this same handle even when their outputs omit usage (for example WebFetch). */
function withRootTokenUsage(runtime: AgentRuntimeInternal, model: Model): Model {
  const prepare = async (request: ModelRequest) => {
    await runtime.multiAgentPersistence?.ready;
    assertMultiAgentTokenBudget(runtime.multiAgentRegistry, runtime.config.multiAgentIdentity, runtime.config.multiAgentV2);
    if (runtime.config.multiAgentIdentity && runtime.multiAgentMessageBoard?.prepareForTurn) {
      const trace = getCurrentModelInvocationContext()?.traceContext ?? runtime.rootTraceContext;
      await runtime.multiAgentMessageBoard.prepareForTurn(runtime.config.multiAgentIdentity, {
        requestId: `board-model:${trace.turnId ?? "none"}`, trace, signal: request.abortSignal,
      });
    }
  };
  return Object.freeze<Model>({
    ...model,
    bind(options) { return withRootTokenUsage(runtime, model.bind(options)); },
    async generateText(request) {
      if (activeRuntimeModelOwner()) return model.generateText(request);
      await prepare(request);
      const boundary = createRootUsageBoundary(runtime, model);
      const owner = { active: true, runtime, check: boundary.check };
      try {
        const result = await runtimeModelInvocationOwner.run(owner, () =>
          runWithModelInvocationContext(boundary.context, () => model.generateText(request)));
        await boundary.record(result.usage);
        return result;
      } finally { owner.active = false; boundary.check(); }
    },
    streamText(request) {
      if (activeRuntimeModelOwner()) return model.streamText(request);
      // Capture the caller context when the iterable is created, not when a different task consumes it.
      const boundary = createRootUsageBoundary(runtime, model);
      const owner = { active: true, runtime, check: boundary.check };
      const source = runWithModelInvocationContext(boundary.context, async function* () {
        try {
          await prepare(request);
          for await (const event of model.streamText(request)) {
            if (event.type === "finish") await boundary.record(event.usage);
            yield event;
          }
        } finally { owner.active = false; boundary.check(); }
      });
      return ownRuntimeModelStream(owner, source);
    },
  });
}

function ownRuntimeModelStream(
  owner: RuntimeModelInvocationOwner,
  source: AsyncIterable<ModelStreamEvent>,
): AsyncIterable<ModelStreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = runtimeModelInvocationOwner.run(owner, () => source[Symbol.asyncIterator]());
      return {
        next: (value?: unknown) => runtimeModelInvocationOwner.run(owner, () => iterator.next(value)),
        return: (value?: unknown) => runtimeModelInvocationOwner.run(owner, () => iterator.return
          ? iterator.return(value) : Promise.resolve({ done: true as const, value })),
        throw: (error?: unknown) => runtimeModelInvocationOwner.run(owner, () => iterator.throw
          ? iterator.throw(error) : Promise.reject(error)),
      };
    },
  };
}

function createRootUsageBoundary(runtime: AgentRuntimeInternal, model: Model) {
  const current = getCurrentModelInvocationContext();
  const downstream = current?.statusSink;
  const invocationId = `runtime_model_${randomUUID()}`;
  const fallbackId = `${invocationId}:result`;
  let activeUsageId = fallbackId;
  let accountingError: unknown;
  const attempts = new Map<string, string>();
  const reported = new Set<string>();
  const record = async (usage: ModelUsage | undefined) => {
    if (!hasModelUsage(usage) || reported.has(activeUsageId)) return;
    reported.add(activeUsageId);
    try {
      await recordRuntimeModelUsage(runtime, {
        agentStep: current?.modelCall?.operation === "agent_step" || current?.metadata?.querySource === "main_turn" || current?.metadata?.querySource === "subagent",
        model,
        traceContext: current?.traceContext ?? runtime.rootTraceContext,
        usage: usage!,
        usageRequestId: activeUsageId,
      });
    } catch (error) { accountingError = error; throw error; }
  };
  const observe = async (event: ModelNetworkStatusEvent) => {
    if (event.type !== "model_request_started" && event.type !== "model_request_completed" && event.type !== "model_request_failed") return;
    const key = `${event.requestId}:${event.attempt}`;
    // Some injected Models expose only a terminal status. Link it to a finish already observed.
    const usageId = attempts.get(key) ?? (attempts.size === 0 && reported.has(fallbackId) ? fallbackId : `${invocationId}:${key}`);
    attempts.set(key, usageId);
    activeUsageId = usageId;
    if (event.type !== "model_request_started") await record(event.usage);
  };
  const statusSink: ModelStatusSink = {
    async publish(event) {
      try { await observe(event); } finally { await downstream?.publish(event); }
    },
    async publishFailure(event, error) {
      try { await observe(event); } finally {
        if (downstream?.publishFailure) await downstream.publishFailure(event, error);
        else await downstream?.publish(event);
      }
    },
  };
  return {
    context: { ...current, statusSink },
    record,
    // Adapter telemetry intentionally catches sink errors; budget persistence must still fail closed.
    check() { if (accountingError !== undefined) throw accountingError; },
  };
}

export function withModelInvocationContext(
  model: Model,
  createContext: (request: ModelRequest) => ModelInvocationContext,
): Model {
  const wrapped: Model = {
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    properties: model.properties,
    requestCapabilities: model.requestCapabilities,
    optionSpecs: model.optionSpecs,
    options: model.options,
    bind(options) {
      return withModelInvocationContext(model.bind(options), createContext);
    },
    generateText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.generateText(request),
      );
    },
    streamText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.streamText(request),
      );
    },
  };
  return Object.freeze(wrapped);
}
