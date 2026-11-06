import { assertMultiAgentTokenBudget } from "./budget.js";
import {
  CoreErrorType, createCoreError, createSessionId,
  MULTI_AGENT_DEFAULT_CAPACITY, resolveMultiAgentWaitTimeouts,
  MultiAgentInputSchemas,
  type MultiAgentControlPort, type MultiAgentIdentity, type MultiAgentV2Config,
  type MultiAgentOperation, type MultiAgentOutput, type SubagentPort,
  type SubagentRunRequest, type SubagentSendMessageRequest, type SubagentRunOptions,
  type ModelInputMessage,
} from "@zcode/contracts";
import { isTerminalRuntimeTask, type RuntimeTaskRegistry, type RuntimeTaskSnapshot, type RuntimeTaskPendingMessage } from "../runtime-task/registry.js";

const ROOT_PATH = "/root";
export function multiAgentRootId(rootSessionId: string): string { return `multi_agent_root:${rootSessionId}`; }

export interface CreateMultiAgentControlOptions {
  persistence?: import("./persistence.js").MultiAgentPersistence;
  registry: RuntimeTaskRegistry;
  runner: SubagentPort;
  identity: MultiAgentIdentity;
  config: MultiAgentV2Config;
  getForkHistory(): readonly ModelInputMessage[];
}

function failure(code: string, message: string): never {
  throw createCoreError(CoreErrorType.ToolExecutionFailed, message, { context: { code }, recoverable: true });
}
function treeTasks(registry: RuntimeTaskRegistry, rootSessionId: string): RuntimeTaskSnapshot[] {
  return Object.values(registry.all()).filter((task) => task.multiAgent?.rootSessionId === rootSessionId);
}
export function resolveMultiAgentTarget(registry: RuntimeTaskRegistry, identity: MultiAgentIdentity, target: string): RuntimeTaskSnapshot {
  const text = target.trim();
  // Canonical task paths are logical identities, never filesystem paths. Parent traversal is forbidden.
  if (!text || text.endsWith("/") || text.split("/").some((part) => part === "." || part === "..")) failure("multi_agent_invalid_target", "Invalid task path");
  const canonical = text.startsWith("/") ? text : `${identity.agentPath}/${text}`;
  const tasks = treeTasks(registry, identity.rootSessionId);
  const task = tasks.find((item) => item.multiAgent?.agentPath === canonical || item.agentId === text);
  if (!task) failure("multi_agent_unknown_target", `No agent in this root tree matches ${target}`);
  return task;
}
export function assertMultiAgentCapacity(registry: RuntimeTaskRegistry, identity: MultiAgentIdentity, config: MultiAgentV2Config): void {
  const tasks = treeTasks(registry, identity.rootSessionId);
  const executionLimit = config.maxConcurrentThreadsPerSession ?? MULTI_AGENT_DEFAULT_CAPACITY;
  const residencyLimit = config.maxResidentAgents ?? executionLimit;
  if (![executionLimit, residencyLimit].every((n) => Number.isSafeInteger(n) && n >= 1)) failure("multi_agent_invalid_capacity", "Agent capacities must be positive integers");
  if (tasks.filter((task) => !isTerminalRuntimeTask(task)).length >= executionLimit) failure("multi_agent_execution_capacity", `Root tree execution capacity ${executionLimit} is exhausted`);
  if (tasks.filter((task) => task.multiAgent?.resident).length >= residencyLimit) failure("multi_agent_residency_capacity", `Root tree residency capacity ${residencyLimit} is exhausted`);
  assertMultiAgentTokenBudget(registry, identity, config);
}

export function createMultiAgentControl(options: CreateMultiAgentControlOptions): MultiAgentControlPort {
  const { registry, runner, identity, config } = options;
  let userSteerSequence = 0;
  const steerListeners = new Set<() => void>();
  const self = () => treeTasks(registry, identity.rootSessionId).find((task) => task.multiAgent?.agentPath === identity.agentPath);
  const getTarget = (target: string) => resolveMultiAgentTarget(registry, identity, target);
  return {
    config, identity,
    notifyUserSteer() { userSteerSequence += 1; for (const listener of steerListeners) listener(); },
    async controlFromUser(input, context) {
      await options.persistence?.ready;
      try {
        if (!config.enabled || identity.agentPath !== ROOT_PATH) failure("multi_agent_user_control_unavailable", "User agent control requires the original V2 root");
        const task = treeTasks(registry, identity.rootSessionId).find((candidate) => candidate.childSessionId === input.childSessionId && candidate.multiAgent!.agentPath !== ROOT_PATH);
        if (!task?.control) failure("multi_agent_unknown_target", "The child does not belong to this root or has no restorable controller");
        const result = (delivery: import("@zcode/contracts").SubagentUserControlResult["delivery"]) => ({ agentId: task.agentId, childSessionId: input.childSessionId, delivery });
        if (input.action === "stop") {
          if (isTerminalRuntimeTask(task)) return result("unchanged");
          await task.control.stop();
          return result("stopped");
        }
        if (!input.text.trim()) failure("multi_agent_empty_user_input", "User input must not be empty");
        const messageId = `user_${crypto.randomUUID()}`;
        if (isTerminalRuntimeTask(task)) {
          assertMultiAgentCapacity(registry, identity, config);
          // 孙代理的真实 parent 必须保持原值；用户从 Root 详情续接不能把它重挂到 Root。
          const original = task.resumeState?.request;
          const resumed = await task.control.resume({ ...context, userInitiated: true, messageId,
            sessionId: task.parentSessionId ?? context.sessionId, parentToolCallId: task.parentToolCallId ?? context.parentToolCallId,
            workingDirectory: original?.workingDirectory ?? context.workingDirectory, workspaceRoot: original?.workspaceRoot ?? context.workspaceRoot,
            to: task.agentId, message: input.text, summary: "", deliveryMode: "trigger_turn" });
          if (resumed.status === "failed") failure("multi_agent_resume_failed", resumed.error ?? "Agent resume failed");
          return result(resumed.delivery ?? "resumed_background");
        }
        const delivery = await deliverMultiAgentMessage(registry, task, { id: messageId, message: input.text,
          queuedAt: new Date(), origin: { kind: "user" }, messageType: "NEW_TASK", traceContext: context.trace });
        return result(delivery);
      } finally { await options.persistence?.flush(); }
    },
    async execute(operation: MultiAgentOperation, rawInput: unknown, context: SubagentSendMessageRequest, runOptions?: SubagentRunOptions): Promise<MultiAgentOutput> {
      const steerAtAdmission = userSteerSequence;
      if (options.persistence) await options.persistence.ready;
      try {
      if (!config.enabled || config.disableNativeTools) failure("multi_agent_disabled", "Multi-agent V2 tools are disabled");
      const input = MultiAgentInputSchemas[operation].parse(rawInput);
      if (runOptions?.signal?.aborted) throw runOptions.signal.reason ?? new Error("Agent operation cancelled");
      if (operation === "spawn_agent") {
        const args = MultiAgentInputSchemas.spawn_agent.parse(input);
        if (!runner.start) failure("multi_agent_unavailable", "Background subagent runner is unavailable");
        if (runOptions?.modelOverride?.background === "deny") failure("multi_agent_background_model_unavailable", "This turn-bound model cannot support an independent background agent");
        if (config.exposeSpawnAgentModelOverrides === false && (args.model || args.reasoning_effort)) failure("multi_agent_override_disabled", "Model overrides are disabled");
        const forkInput = args.fork_turns?.trim().toLowerCase() || "all";
        const forkTurns = forkInput === "none" ? "none" : forkInput === "all" || /^[1-9][0-9]*$/.test(forkInput) ? "all" : undefined;
        if (!forkTurns) failure("multi_agent_invalid_fork", "fork_turns must be none or all");
        if (forkTurns === "all" && (args.model || args.reasoning_effort)) failure("multi_agent_fork_override", "Full-history forks inherit the parent model; choose fork_turns=none for overrides");
        const taskPath = `${identity.agentPath}/${args.task_name}`;
        if (treeTasks(registry, identity.rootSessionId).some((task) => task.multiAgent?.agentPath === taskPath)) failure("multi_agent_duplicate_task", `Task path already exists: ${taskPath}`);
        assertMultiAgentCapacity(registry, identity, config);
        const agentId = `agent_${crypto.randomUUID()}`;
        const runGeneration = 1;
        const childSessionId = createSessionId(`subagent_${agentId}`);
        const request: SubagentRunRequest = {
          sessionId: context.sessionId, turnId: context.turnId, parentToolCallId: context.parentToolCallId,
          agentType: args.agent_type ?? (forkTurns === "all" && self()?.agentType !== "root" ? self()?.agentType : undefined) ?? "general-purpose", description: args.task_name, prompt: args.message,
          workingDirectory: context.workingDirectory, workspaceRoot: context.workspaceRoot, trace: context.trace,
          multiAgent: { agentId, agentPath: taskPath, parentPath: identity.agentPath, rootSessionId: identity.rootSessionId, forkTurns, roleWasExplicit: args.agent_type !== undefined,
            initiatingAgentPath: identity.agentPath, initiatingTurnId: context.turnId,
            ...(args.model ? { model: args.model } : {}), ...(args.reasoning_effort ? { reasoningEffort: args.reasoning_effort } : {}) },
          ...(forkTurns === "all" ? { forkHistory: options.getForkHistory() } : {}),
        };
        // Reservation precedes every await: two concurrent spawn calls cannot claim the same path or slot.
        registry.register({ taskId: agentId, agentId, agentType: request.agentType, description: args.task_name,
          status: "running", startedAt: new Date(), type: "local_agent", childSessionId,
          parentSessionId: context.sessionId, parentToolCallId: context.parentToolCallId,
          multiAgent: { ...request.multiAgent!, resident: true, runGeneration }, pendingMessages: [] });
        try {
          await runner.start(request, { ...runOptions, signal: undefined });
          return { task_name: taskPath, ...(config.hideSpawnAgentMetadata === false ? { nickname: registry.get(agentId)?.multiAgent?.nickname ?? null } : {}) };
        } catch (error) {
          const current = registry.get(agentId);
          // spawn 只拥有首次代次的预留；旧 setup 失败不能删除已 Stop 或已续接的同一身份。
          if (current && !isTerminalRuntimeTask(current) && current.multiAgent?.runGeneration === runGeneration) registry.remove(agentId);
          throw error;
        }
      }
      if (operation === "list_agents") {
        const { path_prefix: prefix } = MultiAgentInputSchemas.list_agents.parse(input);
        if (prefix && (!prefix.startsWith(ROOT_PATH) || prefix.endsWith("/") || prefix.includes(".."))) failure("multi_agent_invalid_prefix", "path_prefix must be a canonical task path without a trailing slash");
        return { agents: treeTasks(registry, identity.rootSessionId)
          .filter((task) => !prefix || task.multiAgent!.agentPath === prefix || task.multiAgent!.agentPath.startsWith(`${prefix}/`))
          .map((task) => ({ agent_name: task.multiAgent!.agentPath, nickname: task.multiAgent?.nickname, agent_status: multiAgentStatus(task) })) };
      }
      if (operation === "wait_agent") {
        if (config.waitAgentEnabled === false) failure("multi_agent_wait_disabled", "wait_agent is disabled");
        const args = MultiAgentInputSchemas.wait_agent.parse(input);
        const limits = resolveMultiAgentWaitTimeouts(config);
        if (args.timeout_ms !== undefined && args.timeout_ms > limits.maxMs) failure("multi_agent_invalid_timeout", `timeout_ms must be at most ${limits.maxMs}`);
        const timeoutMs = Math.max(limits.minMs, args.timeout_ms ?? limits.defaultMs);
        const receipt = (message: string, timedOut = false): MultiAgentOutput => ({
          message: args.timeout_ms !== undefined && args.timeout_ms < timeoutMs
            ? `${message}\n\nRequested timeout of ${args.timeout_ms}ms was clamped to the minimum of ${timeoutMs}ms.` : message,
          timed_out: timedOut,
        });
        const steerAtStart = steerAtAdmission;
        return await new Promise<MultiAgentOutput>((resolve, reject) => {
          let settled = false;
          let unsubscribe: (() => void) | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = (value?: MultiAgentOutput, error?: unknown) => {
            if (settled) return; settled = true; unsubscribe?.(); steerListeners.delete(check);
            if (timer) clearTimeout(timer); runOptions?.signal?.removeEventListener("abort", abort);
            if (error !== undefined) reject(error); else resolve(value!);
          };
          const abort = () => finish(undefined, runOptions?.signal?.reason ?? new Error("wait_agent cancelled"));
          const check = () => {
            if (settled) return;
            if (userSteerSequence !== steerAtStart) { finish(receipt("Wait interrupted by new input.")); return; }
            const task = self();
            if (task?.multiAgent && (task.multiAgent.activitySequence ?? 0) > (task.multiAgent.observedSequence ?? 0)) {
              const sequence = task.multiAgent.activitySequence ?? 0;
              finish(receipt("Wait completed."));
              registry.update(task.taskId, (current) => ({ ...current, multiAgent: { ...current.multiAgent!, observedSequence: sequence } }));
            }
          };
          unsubscribe = registry.subscribe?.(check);
          steerListeners.add(check); runOptions?.signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => finish(receipt("Wait timed out.", true)), timeoutMs);
          // Subscribe first, then inspect: an early delivery cannot be lost between those operations.
          if (runOptions?.signal?.aborted) abort(); else check();
        });
      }
      if (operation === "interrupt_agent") {
        const args = MultiAgentInputSchemas.interrupt_agent.parse(input);
        const task = getTarget(args.target);
        if (task.multiAgent!.agentPath === ROOT_PATH || task.multiAgent!.agentPath === identity.agentPath) failure("multi_agent_invalid_interrupt", "Cannot interrupt the root or the calling agent");
        const previousStatus = multiAgentStatus(task);
        if (!isTerminalRuntimeTask(task)) {
          if (!task.control) failure("multi_agent_not_loaded", "Target has no live execution controller");
          await task.control.stop();
        }
        return { previous_status: previousStatus };
      }
      if (config.disableDirectMessage) failure("multi_agent_message_disabled", "Direct messaging is disabled");
      const args = MultiAgentInputSchemas.send_message.parse(input);
      const task = getTarget(args.target);
      if (operation === "followup_task" && task.multiAgent!.agentPath === ROOT_PATH) failure("multi_agent_root_followup", "The root is resumed by user input, not followup_task");
      const messageId = `msg_${crypto.randomUUID()}`;
      const request: SubagentSendMessageRequest = { ...context, to: task.agentId, message: args.message, summary: "",
        senderPath: identity.agentPath, messageId, deliveryMode: operation === "send_message" ? "queue_only" : "trigger_turn" };
      if (operation === "followup_task" && isTerminalRuntimeTask(task)) {
        assertMultiAgentCapacity(registry, identity, config);
        if (!task.control) failure("multi_agent_not_loaded", "Target identity has no restorable runner binding");
        const result = await task.control.resume(request, { ...runOptions, signal: undefined, model: undefined, modelOverride: undefined });
        if (result.status === "failed") failure("multi_agent_resume_failed", result.error ?? "Agent resume failed");
        return { nickname: task.multiAgent?.nickname };
      }
      const message: RuntimeTaskPendingMessage = { id: messageId, message: args.message, queuedAt: new Date(),
        senderPath: identity.agentPath, targetPath: task.multiAgent!.agentPath,
        messageType: operation === "followup_task" ? "NEW_TASK" : "MESSAGE", traceContext: context.trace };
      await deliverMultiAgentMessage(registry, task, message);
      return { nickname: task.multiAgent?.nickname };
      } finally { await options.persistence?.flush(); }
    },
  };
}

export async function deliverMultiAgentMessage(registry: RuntimeTaskRegistry, task: RuntimeTaskSnapshot, message: RuntimeTaskPendingMessage): Promise<"queued" | "steered"> {
  message = namedMultiAgentMessage(registry, task, message);
  registry.queueMessage(task.taskId, message);
  if (isTerminalRuntimeTask(task) || !task.messageSink) return "queued";
  // V2 邮箱只在已经需要继续采样的边界投递；普通消息不能把最终文本收口改成额外模型轮。
  if (task.messageSink.retainsUntilConsumed && message.messageType !== "NEW_TASK" && message.origin?.kind !== "user") return "queued";
  try {
    const delivery = await task.messageSink.send(message);
    if (!task.messageSink.retainsUntilConsumed) registry.update(task.taskId, (current) => ({ ...current,
      pendingMessages: current.pendingMessages?.filter((queued) => queued.id !== message.id),
      multiAgent: current.multiAgent ? { ...current.multiAgent, deliveredMessages: (current.multiAgent.deliveredMessages ?? 0) + 1 } : undefined }));
    return delivery;
  } catch { return "queued"; }
}

export function notifyMultiAgentParent(registry: RuntimeTaskRegistry, child: RuntimeTaskSnapshot, text: string,
  options: { messageId?: string; messageType?: "MESSAGE" | "FINAL_ANSWER" } = {}): void {
  const identity = child.multiAgent;
  if (!identity?.parentPath) return;
  const parent = treeTasks(registry, identity.rootSessionId).find((task) => task.multiAgent!.agentPath === identity.parentPath);
  if (!parent) return;
  void deliverMultiAgentMessage(registry, parent, { id: options.messageId ?? `final_${child.agentId}_${identity.runGeneration}`, message: text,
    messageType: options.messageType ?? "FINAL_ANSWER", senderPath: identity.agentPath, targetPath: identity.parentPath,
    queuedAt: new Date(), traceContext: child.traceContext });
}

export function multiAgentStatus(task: RuntimeTaskSnapshot): NonNullable<MultiAgentOutput["previous_status"]> {
  if (task.status === "running") return "running";
  if (task.status === "completed") return { completed: task.output?.status === "completed" ? task.output.content.map((block) => block.text).join("\n") : null };
  if (task.status === "failed") return { errored: task.error ?? "Agent execution failed" };
  if (task.status === "lost") return { errored: task.error ?? "Agent execution was lost; its identity is retained" };
  return "interrupted";
}

export function snapshotMultiAgentForkHistory(messages: readonly ModelInputMessage[], options: { preserveSystemPrefix?: boolean } = {}): ModelInputMessage[] {
  const resultIds = new Set(messages.filter((message) => message.role === "tool").map((message) => message.toolCallId));
  const callIds = new Set(messages.flatMap((message) => message.toolCalls ?? []).filter((call) => resultIds.has(call.id)).map((call) => call.id));
  return messages.filter((message) => (options.preserveSystemPrefix || message.role !== "system") && (message.role !== "tool" || callIds.has(message.toolCallId!))).map((message) => ({
    ...structuredClone(message),
    content: typeof message.content === "string" ? message.content : structuredClone(message.content.filter((block) => block.type !== "reasoning")),
    ...(message.toolCalls ? { toolCalls: structuredClone(message.toolCalls.filter((call) => callIds.has(call.id))) } : {}),
  }));
}

export function updateMultiAgentRootTurn(registry: RuntimeTaskRegistry | undefined, identity: MultiAgentIdentity | undefined, executing: boolean, turnId?: import("@zcode/contracts").TurnId, flushMessages = true): void {
  if (!registry || !identity) return;
  if (identity.agentPath !== ROOT_PATH) {
    if (executing) {
      const task = treeTasks(registry, identity.rootSessionId).find((candidate) => candidate.multiAgent!.agentPath === identity.agentPath);
      if (task) registry.update(task.taskId, (current) => ({ ...current, turnId }));
    }
    return;
  }
  const id = multiAgentRootId(identity.rootSessionId);
  registry.update(id, (task) => ({ ...task, status: executing ? "running" : "completed", turnId: executing ? turnId : task.turnId, multiAgent: { ...task.multiAgent!, resident: true } }));
  if (!executing || !flushMessages) return;
  const task = registry.get(id);
  if (!task?.messageSink || task.messageSink.retainsUntilConsumed) return;
  const queued = registry.drainMessages(id);
  // The root now has an active turn. Delivery enters its existing steer queue, never a separate model loop.
  void (async () => {
    for (let index = 0; index < queued.length; index++) {
      try { await task.messageSink!.send(queued[index]!); }
      catch { for (const pending of queued.slice(index)) registry.queueMessage(id, pending); return; }
    }
  })();
}

/** Deliver the durable mailbox at the admitted turn boundary, before its first model request. */
export async function stageMultiAgentMailbox(
  registry: RuntimeTaskRegistry | undefined,
  identity: MultiAgentIdentity | undefined,
  turnId: import("@zcode/contracts").TurnId,
): Promise<number> {
  if (!registry || !identity) return 0;
  const task = treeTasks(registry, identity.rootSessionId).find((candidate) => candidate.multiAgent!.agentPath === identity.agentPath);
  if (!task?.messageSink?.retainsUntilConsumed || !task.messageSink.sendActive) return 0;
  const pending = [...(task.pendingMessages ?? [])];
  let staged = 0;
  for (const message of pending) {
    const current = registry.get(task.taskId);
    if (current?.turnId !== turnId || isTerminalRuntimeTask(current)
      || current.multiAgent?.runGeneration !== task.multiAgent?.runGeneration || current.messageSink !== task.messageSink) break;
    if (await task.messageSink.sendActive(namedMultiAgentMessage(registry, task, message), turnId)) staged++;
  }
  return staged;
}

function namedMultiAgentMessage(registry: RuntimeTaskRegistry, target: RuntimeTaskSnapshot, message: RuntimeTaskPendingMessage): RuntimeTaskPendingMessage {
  const sender = target.multiAgent ? treeTasks(registry, target.multiAgent.rootSessionId)
    .find((candidate) => candidate.multiAgent?.agentPath === message.senderPath) : undefined;
  return { ...message, senderName: message.senderName ?? sender?.multiAgent?.nickname,
    targetName: message.targetName ?? target.multiAgent?.nickname };
}


/** A mailbox receipt is committed only after its user-message projection is durable. */
export function acknowledgeMultiAgentMessage(registry: RuntimeTaskRegistry | undefined, identity: MultiAgentIdentity | undefined, messageId: string | undefined): void {
  if (!registry || !identity || !messageId) return;
  const task = treeTasks(registry, identity.rootSessionId).find((candidate) => candidate.multiAgent!.agentPath === identity.agentPath);
  if (!task?.pendingMessages?.some((message) => message.id === messageId)) return;
  registry.update(task.taskId, (current) => ({ ...current,
    pendingMessages: current.pendingMessages?.filter((message) => message.id !== messageId),
    multiAgent: { ...current.multiAgent!, deliveredMessages: (current.multiAgent!.deliveredMessages ?? 0) + 1 } }));
}
