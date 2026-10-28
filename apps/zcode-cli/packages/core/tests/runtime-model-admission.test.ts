import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelId,
  createModelProviderId,
  createSessionId,
  createTraceId,
  runWithModelInvocationContext,
  type ModelInvocationContext,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
  type ModelSelection,
} from "@zcode/contracts";
import { getMultiAgentUsage, recordMultiAgentUsage } from "../src/multi-agent/budget.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createRuntimeModel } from "../src/runtime/methods/runtime-model.js";
import { createInheritedSubagentModelFactory, modelSelectionFromActiveModel } from "../src/runtime/methods/subagent.js";
import { createTurnModel } from "../src/runtime/methods/turn-model.js";
import { processFetchedContent } from "../src/tool/handlers/webfetch-processing.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

// docs/dynamic-workflow/concurrency.md「Where the port is bound」：准入端口与重试预算绑定在 runtime 的模型工厂上，
// runtime 交出的每一个句柄——turn step 与工具内部的模型调用——都带它们；调用层设什么都压不过。
// 设计缺口的根因：此前只在 turn step 注入，WebSearch 这类工具侧请求全部绕过闸门。

const modelSelection: ModelSelection = { providerId: "deepseek", modelId: "deepseek-chat" };

function admissionStub(): ModelRequestAdmission {
  const ticket: ModelRequestAdmissionTicket = { publish() {}, release() {} };
  return { acquire: async () => ticket };
}

/** adapter 看到的请求：runner 把调用上下文整份铺进请求（adapters/src/model/runner.ts），这里照样记。 */
type SeenRequest = Record<string, unknown> & Partial<ModelInvocationContext>;

/** 一轮：主请求发一次 WebSearch，工具内部发流式 web_search 请求，再收口。 */
function modelFactoryWithWebSearch(requests: SeenRequest[]) {
  let mainRequestCount = 0;
  return createTestModelFactory({
    properties: { supportsNativeWebSearch: true },
    async generateText(request, observation) {
      requests.push({ ...request, ...observation.invocationContext });
      mainRequestCount += 1;
      if (mainRequestCount === 1) {
        return {
          finishReason: "tool-calls",
          model: request.model,
          providerMetadata: undefined,
          text: "",
          toolCalls: [
            { id: "call_websearch", input: { query: "latest zcode" }, name: "WebSearch" },
          ],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      return {
        finishReason: "stop",
        model: request.model,
        providerMetadata: undefined,
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async *streamText(request, observation) {
      requests.push({ ...request, ...observation.invocationContext });
      yield { type: "start" };
      yield { id: "t", type: "text_start" };
      yield { id: "t", text: "summary", type: "text_delta" };
      yield { id: "t", type: "text_end" };
      yield {
        finishReason: "stop",
        providerMetadata: { rawFinishReason: "end_turn" },
        type: "finish",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          serverToolUse: { webSearchRequests: 1 },
          totalTokens: 2,
        },
      };
    },
  } as never);
}

describe("runtime model factory binds admission and retry budget (v3 决策 42)", () => {
  it("WebSearch 工具内部的模型请求带 runtime 的准入端口与 workflow_child 的无上限预算", async () => {
    const admission = admissionStub();
    const requests: SeenRequest[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-admission-websearch"),
      { modelSelection, modelStreaming: "off", taskType: "workflow_child" },
      {
        eventStore: createTestSessionEventStore(),
        modelRequestAdmission: admission,
        modelFactory: modelFactoryWithWebSearch(requests),
      },
    );
    await runtime.executeTurn("search");

    const tool = requests.find(
      (request) =>
        (request.metadata as { querySource?: string })?.querySource === "web_search_tool",
    );
    const turn = requests.find(
      (request) =>
        (request.metadata as { querySource?: string })?.querySource !== "web_search_tool",
    );
    expect(tool).toBeDefined();
    expect(turn).toBeDefined();
    expect(tool!.modelRequestAdmission).toBe(admission);
    expect(tool!.modelRetryBudget).toBe("unbounded");
    expect(turn!.modelRequestAdmission).toBe(admission);
    expect(turn!.modelRetryBudget).toBe("unbounded");
  });

  it.each([
    ["interactive", "main"],
    ["subagent_child", "subagent"],
    ["selection_side_chat", "side_chat"],
  ] as const)(
    "%s 工具请求继承宿主类型，保持默认重试预算且无准入端口",
    async (taskType, expectedSessionType) => {
      const requests: SeenRequest[] = [];
      const runtime = createTestAgentRuntime(
        createSessionId("runtime-admission-websearch-absent"),
        { modelSelection, modelStreaming: "off", taskType },
        {
          eventStore: createTestSessionEventStore(),
          modelFactory: modelFactoryWithWebSearch(requests),
        },
      );
      await runtime.executeTurn("search");
      const tool = requests.find(
        (request) =>
          (request.metadata as { querySource?: string })?.querySource === "web_search_tool",
      );
      expect(tool).toBeDefined();
      expect(tool!.modelRequestAdmission).toBeUndefined();
      expect(tool!.modelRetryBudget).toBe("default");
      expect(tool!.modelRequestSessionType).toBe(expectedSessionType);
    },
  );

  it("runtime 层压过调用层：调用点塞的 modelRequestAdmission 到不了 adapter", async () => {
    const admission = admissionStub();
    const other = admissionStub();
    const seen: unknown[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-admission-layer-precedence"),
      { modelSelection, modelStreaming: "off", taskType: "workflow_child" },
      {
        eventStore: createTestSessionEventStore(),
        modelRequestAdmission: admission,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            const context = observation.invocationContext;
            seen.push([context?.modelRequestAdmission, context?.modelRetryBudget]);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            } as never;
          },
        }),
      },
    );
    const model = createRuntimeModel(runtime as never, { selection: modelSelection });
    await runWithModelInvocationContext(
      {
        modelRequestAdmission: other,
        modelRetryBudget: "default",
        metadata: { querySource: "probe" },
      },
      () => model.generateText({ messages: [{ role: "user", content: "hi" }] } as never),
    );
    expect(seen).toEqual([[admission, "unbounded"]]);
  });
});

// Production Runtime/Model/Tool paths with explicit local Model fixtures; no provider or HTTP calls.
describe("root token budgets cover tool-internal and physical model requests", () => {
  const runtimes: ReturnType<typeof createTestAgentRuntime>[] = [];
  afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.beginShutdown(); });

  function createBudgetRuntime(input: {
    tokenBudget: number;
    modelFactory: ReturnType<typeof createTestModelFactory>;
    admission?: ModelRequestAdmission;
    streaming?: "on" | "off";
  }) {
    const runtime = createTestAgentRuntime(createSessionId("nested-model-budget"), {
      modelSelection, mode: "yolo", modelStreaming: input.streaming ?? "off",
      compact: { enabled: false }, titleGeneration: { enabled: false },
      multiAgentV2: { enabled: true, tokenBudget: input.tokenBudget },
    }, {
      eventStore: createTestSessionEventStore(), sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: input.modelFactory, modelRequestAdmission: input.admission,
    });
    runtimes.push(runtime);
    return { runtime, core: runtime as unknown as AgentRuntimeInternal };
  }
  const request = { messages: [{ role: "user" as const, content: "nested request" }] };
  const reported = (totalTokens: number) => ({ inputTokens: totalTokens - 1, outputTokens: 1, totalTokens });
  const result = (totalTokens: number) => ({ text: "done", finishReason: "stop", usage: reported(totalTokens) });
  const statusBase = (attempt = 1) => ({
    timestamp: new Date().toISOString(), traceId: createTraceId(), requestId: "physical-request",
    providerId: createModelProviderId(modelSelection.providerId), modelId: createModelId(modelSelection.modelId),
    transport: "http" as const, attempt, maxAttempts: 11,
  });

  it.each([
    { budget: 2, searchCalls: 0, total: 2 },
    { budget: 4, searchCalls: 1, total: 4 },
  ])("blocks later provider requests after WebSearch reaches a $budget-token root budget", async ({ budget, searchCalls, total }) => {
    const requests: SeenRequest[] = [];
    const { runtime, core } = createBudgetRuntime({ tokenBudget: budget, modelFactory: modelFactoryWithWebSearch(requests) });
    await expect(runtime.executeTurn("search then answer")).rejects.toMatchObject({
      cause: { context: { code: "multi_agent_token_budget", usedTokens: total, tokenBudget: budget } },
    });
    expect(requests.filter((entry) => entry.metadata?.querySource === "web_search_tool")).toHaveLength(searchCalls);
    expect(requests).toHaveLength(1 + searchCalls);
    expect(getMultiAgentUsage(core.multiAgentRegistry!, core.sessionId)).toMatchObject({
      totalTokens: total, modelRequestCount: 1 + searchCalls, webSearchRequests: searchCalls,
    });
  });

  it("charges WebFetch processing even though its output omits usage and blocks the next extraction", async () => {
    const generateText = vi.fn(async () => result(3));
    const { core } = createBudgetRuntime({ tokenBudget: 3, modelFactory: createTestModelFactory({ generateText }) });
    const model = createRuntimeModel(core, { selection: modelSelection }).bind({ maxOutputTokens: 64 });
    const context = { model, toolCallId: "fetch", sessionId: core.sessionId, traceId: core.rootTraceContext.traceId,
      spanId: core.rootTraceContext.spanId, abortSignal: new AbortController().signal };
    const fetched = { content: "A local content fixture", contentType: "text/html", finalUrl: "https://example.test/article",
      bytes: 23, sizeBytes: 23, status: 200, statusText: "OK", redirects: [] };
    const output = await processFetchedContent({ url: fetched.finalUrl, prompt: "summarize" }, fetched, context as never);
    expect(output).toEqual({ result: "done", truncated: false });
    expect(getMultiAgentUsage(core.multiAgentRegistry!, core.sessionId)).toMatchObject({ totalTokens: 3, modelRequestCount: 1 });
    await expect(processFetchedContent({ url: fetched.finalUrl, prompt: "again" }, fetched, context as never)).rejects.toThrow("token budget");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it.each(["off", "on"] as const)("counts result/finish plus completed status only once with streaming=%s", async (streaming) => {
    const completed = { ...statusBase(), type: "model_request_completed" as const, durationMs: 1, usage: reported(7) };
    const { runtime, core } = createBudgetRuntime({ tokenBudget: 20, streaming,
      modelFactory: createTestModelFactory({
        async generateText(_request, observation) {
          await observation.invocationContext?.statusSink?.publish(completed);
          await observation.invocationContext?.statusSink?.publish(completed);
          return result(7);
        },
        async *streamText(_request, observation) {
          await observation.invocationContext?.statusSink?.publish({ ...statusBase(), type: "model_request_started" });
          yield { type: "text_delta", text: "done" };
          yield { type: "finish", finishReason: "stop", usage: reported(7) };
          await observation.invocationContext?.statusSink?.publish(completed);
        },
      }),
    });
    await runtime.executeTurn("one request");
    // executeTurn also calls the existing UsageStore fact writer after ModelComplete.
    expect(getMultiAgentUsage(core.multiAgentRegistry!, core.sessionId)).toMatchObject({ totalTokens: 7, modelRequestCount: 1 });
  });

  it.each(["generate", "stream"] as const)("records failed %s usage without finish once and preserves publishFailure", async (kind) => {
    const original = new Error("provider connection closed");
    const failed = { ...statusBase(), type: "model_request_failed" as const, reason: "network_error" as const,
      retryable: true, message: original.message, usage: reported(3) };
    const calls = vi.fn();
    const fail = async (observation: Parameters<NonNullable<Parameters<typeof createTestModelFactory>[0]["generateText"]>>[1]) => {
      calls();
      await observation.invocationContext?.statusSink?.publishFailure?.(failed, original);
      await observation.invocationContext?.statusSink?.publishFailure?.(failed, original);
      throw original;
    };
    const { core } = createBudgetRuntime({ tokenBudget: 3, modelFactory: createTestModelFactory({
      generateText: async (_request, observation) => fail(observation),
      async *streamText(_request, observation) { await fail(observation); },
    }) });
    const model = createRuntimeModel(core, { selection: modelSelection });
    const downstream = { publish: vi.fn(), publishFailure: vi.fn() };
    const invoke = () => runWithModelInvocationContext({ statusSink: downstream }, async () => {
      if (kind === "generate") return model.generateText(request);
      const stream = model.streamText(request);
      for await (const _event of stream) { /* error before finish */ }
    });
    await expect(invoke()).rejects.toBe(original);
    expect(getMultiAgentUsage(core.multiAgentRegistry!, core.sessionId)).toMatchObject({ totalTokens: 3, modelRequestCount: 1 });
    expect(downstream.publishFailure).toHaveBeenCalledTimes(2);
    expect(downstream.publishFailure).toHaveBeenCalledWith(failed, original);
    await expect(invoke()).rejects.toMatchObject({ context: { code: "multi_agent_token_budget" } });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("rechecks actual usage before an adapter's next physical retry without replacing governor tickets", async () => {
    const release = vi.fn();
    const publish = vi.fn();
    const ticket = { release, publish };
    const acquire = vi.fn(async () => ticket);
    let providerAttempts = 0;
    const { core } = createBudgetRuntime({ tokenBudget: 3, admission: { acquire },
      modelFactory: createTestModelFactory({ async generateText(_request, observation) {
        const context = observation.invocationContext!;
        const first = await context.modelRequestAdmission!.acquire({ model: observation.model });
        expect(first).toBe(ticket);
        providerAttempts++;
        try {
          await context.statusSink!.publish({ ...statusBase(), type: "model_request_failed", reason: "network_error",
            retryable: true, message: "retryable transport failure", usage: reported(3) });
        } finally { first.release(); }
        await context.modelRequestAdmission!.acquire({ model: observation.model });
        providerAttempts++;
        return result(3);
      } }),
    });
    const model = createRuntimeModel(core, { selection: modelSelection });
    await expect(model.generateText(request)).rejects.toMatchObject({ context: { code: "multi_agent_token_budget" } });
    expect(providerAttempts).toBe(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(getMultiAgentUsage(core.multiAgentRegistry!, core.sessionId).totalTokens).toBe(3);
  });

  it("releases a granted governor ticket when another request exhausts the root budget while queued", async () => {
    const queued = Promise.withResolvers<void>();
    const grant = Promise.withResolvers<ModelRequestAdmissionTicket>();
    const release = vi.fn();
    const provider = vi.fn();
    const { core } = createBudgetRuntime({ tokenBudget: 3,
      admission: { acquire: async () => { queued.resolve(); return grant.promise; } },
      modelFactory: createTestModelFactory({ async generateText(_request, observation) {
        const ticket = await observation.invocationContext!.modelRequestAdmission!.acquire({ model: observation.model });
        try { provider(); return result(1); } finally { ticket.release(); }
      } }),
    });
    const pending = createRuntimeModel(core, { selection: modelSelection }).generateText(request);
    const rejected = expect(pending).rejects.toMatchObject({ context: { code: "multi_agent_token_budget" } });
    await queued.promise;
    recordMultiAgentUsage(core.multiAgentRegistry, core.config.multiAgentIdentity, 3, "sibling-completed");
    grant.resolve({ publish() {}, release });
    await rejected;
    expect(provider).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("waits for restored root usage before admitting a direct bound model handle", async () => {
    const generateText = vi.fn(async () => result(1));
    const { core } = createBudgetRuntime({ tokenBudget: 3, modelFactory: createTestModelFactory({ generateText }) });
    await core.multiAgentPersistence?.ready;
    const restored = Promise.withResolvers<void>();
    const persistence = core.multiAgentPersistence;
    core.multiAgentPersistence = { ready: restored.promise, flush: async () => { await persistence?.flush(); } };
    const pending = createRuntimeModel(core, { selection: modelSelection }).bind({ maxOutputTokens: 32 }).generateText(request);
    const rejected = expect(pending).rejects.toMatchObject({ context: { code: "multi_agent_token_budget" } });
    await Promise.resolve();
    expect(generateText).not.toHaveBeenCalled();
    // A delayed graph hydration fixture installs the durable usage before resolving ready.
    recordMultiAgentUsage(core.multiAgentRegistry, core.config.multiAgentIdentity, 3, "restored-usage");
    restored.resolve();
    await rejected;
    expect(generateText).not.toHaveBeenCalled();
  });

  it.each(["generate", "stream"] as const)("charges an inherited wrapped Active Model only to its child for %s", async (kind) => {
    const seen: ModelInvocationContext[] = [];
    const parentAcquire = vi.fn(async () => ({ publish() {}, release() {} }));
    const childAcquire = vi.fn(async () => ({ publish() {}, release() {} }));
    const observe = async (context: ModelInvocationContext | undefined) => {
      seen.push(context!);
      const ticket = await context!.modelRequestAdmission!.acquire({ model: {
        providerId: createModelProviderId(modelSelection.providerId), modelId: createModelId(modelSelection.modelId),
      } });
      ticket.release();
    };
    const factory = createTestModelFactory({
      async generateText(_request, observation) { await observe(observation.invocationContext); return result(4); },
      async *streamText(_request, observation) {
        await observe(observation.invocationContext);
        yield { type: "finish", finishReason: "stop", usage: reported(4) };
      },
    });
    const { core: parent } = createBudgetRuntime({ tokenBudget: 20, admission: { acquire: parentAcquire }, modelFactory: factory });
    await parent.multiAgentPersistence?.ready;
    const parentModel = createTurnModel(parent).bind({ maxOutputTokens: 64 });
    const selection = modelSelectionFromActiveModel(parentModel);
    const sessionId = createSessionId("inherited-budget-child");
    const identity = { rootSessionId: parent.sessionId, agentPath: "/root/child", parentPath: "/root" };
    parent.multiAgentRegistry!.register({ taskId: "inherited-child", agentId: "inherited-child", agentType: "worker",
      description: "inherited model budget", type: "local_agent", status: "running", startedAt: new Date(),
      childSessionId: sessionId, parentSessionId: parent.sessionId,
      multiAgent: { ...identity, resident: true, runGeneration: 1 },
    });
    const child = createTestAgentRuntime(sessionId, {
      modelSelection: selection, taskType: "subagent_child", multiAgentIdentity: identity,
      multiAgentV2: { enabled: true, tokenBudget: 20 }, compact: { enabled: false }, titleGeneration: { enabled: false },
    }, {
      eventStore: createTestSessionEventStore(), sessionStore: parent.sessionStore,
      multiAgentRegistry: parent.multiAgentRegistry, multiAgentPersistence: parent.multiAgentPersistence,
      modelRequestAdmission: { acquire: childAcquire },
      modelFactory: createInheritedSubagentModelFactory(selection, parentModel, factory),
    });
    runtimes.push(child);
    const core = child as unknown as AgentRuntimeInternal;
    const model = createRuntimeModel(core, { selection });
    await runWithModelInvocationContext({ modelCall: { operation: "agent_step" }, traceContext: core.rootTraceContext }, async () => {
      if (kind === "generate") await model.generateText(request);
      else for await (const _event of model.streamText(request)) { /* consume finish */ }
    });
    const tasks = Object.values(parent.multiAgentRegistry!.all());
    expect(tasks.find((task) => task.multiAgent?.agentPath === "/root")?.multiAgent?.totalTokens ?? 0).toBe(0);
    expect(tasks.find((task) => task.multiAgent?.agentPath === "/root/child")?.multiAgent).toMatchObject({
      totalTokens: 4, lifetimeUsage: { totalTokens: 4, modelRequestCount: 1 }, model: `${selection.providerId}/${selection.modelId}`,
    });
    expect(getMultiAgentUsage(parent.multiAgentRegistry!, parent.sessionId).totalTokens).toBe(4);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.modelRequestSessionType).toBe("subagent");
    expect(parentAcquire).not.toHaveBeenCalled();
    expect(childAcquire).toHaveBeenCalledTimes(1);
  });

  it("fences retry when adapter-style telemetry isolation catches a usage persistence failure", async () => {
    const persistenceError = new Error("usage storage unavailable");
    const release = vi.fn();
    const acquire = vi.fn(async () => ({ publish() {}, release }));
    let providerAttempts = 0;
    const { core } = createBudgetRuntime({ tokenBudget: 100, admission: { acquire },
      modelFactory: createTestModelFactory({ async generateText(_request, observation) {
        const context = observation.invocationContext!;
        const first = await context.modelRequestAdmission!.acquire({ model: observation.model });
        providerAttempts++;
        try {
          // Actual adapter publishModelStatus isolates sink failures with allSettled. This local
          // Model fixture preserves that rejection boundary instead of accidentally short-circuiting.
          await Promise.allSettled([Promise.resolve().then(() => context.statusSink!.publish({
            ...statusBase(), type: "model_request_failed", reason: "network_error", retryable: true,
            message: "transport interruption", usage: reported(3),
          }))]);
        } finally { first.release(); }
        await context.modelRequestAdmission!.acquire({ model: observation.model });
        providerAttempts++;
        return result(3);
      } }),
    });
    await core.multiAgentPersistence?.ready;
    core.multiAgentPersistence = { ready: Promise.resolve(), flush: async () => { throw persistenceError; } };
    await expect(createRuntimeModel(core, { selection: modelSelection }).generateText(request)).rejects.toBe(persistenceError);
    expect(providerAttempts).toBe(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(getMultiAgentUsage(core.multiAgentRegistry!, core.sessionId).totalTokens).toBe(3);
  });
});
