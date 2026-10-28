import { AgentOutputSchema, MultiAgentStoredGraphSchema, allocateMultiAgentNicknames, type SessionId, type SessionStorePort, type MultiAgentIdentity, type SubagentRunRequest } from "@zcode/contracts";
import { multiAgentRootId, acknowledgeMultiAgentMessage } from "./controller.js";
import type { AgentProfile } from "@zcode/shared";
import type { RuntimeTaskRegistry, RuntimeTaskSnapshot, RuntimeTaskPendingMessage } from "../runtime-task/registry.js";

const GRAPH_ENTRY_TYPE = "multi_agent/graph";
export interface MultiAgentPersistence {
  ready: Promise<void>;
  flush(): Promise<void>;
}

export function createMultiAgentPersistence(input: {
  registry: RuntimeTaskRegistry;
  identity: MultiAgentIdentity;
  store: SessionStorePort;
  restoreTask(taskId: string): void;
  onError?(error: unknown): void;
}): MultiAgentPersistence | undefined {
  if (!input.store.sessionEntries || !input.store.saveSessionEntry) return undefined;
  let revision = 0;
  let persistedRevision = -1;
  let writing: Promise<void> | undefined;
  let ready: Promise<void>;
  const flush = async (): Promise<void> => {
    await ready;
    if (writing) { await writing; if (revision !== persistedRevision) await flush(); return; }
    if (revision === persistedRevision) return;
    writing = (async () => {
      while (revision !== persistedRevision) {
        const capturedRevision = revision;
        const data = serializeMultiAgentGraph(input.registry, input.identity.rootSessionId);
        const now = Date.now();
        await input.store.saveSessionEntry!({ id: `multi_agent_graph:${input.identity.rootSessionId}`,
          sessionID: input.identity.rootSessionId as SessionId, type: GRAPH_ENTRY_TYPE,
          touchSession: false, time: { created: now, updated: now }, data });
        persistedRevision = capturedRevision;
      }
    })();
    try { await writing; } finally { writing = undefined; }
  };
  ready = (async () => {
    const entries = await input.store.sessionEntries!({ sessionID: input.identity.rootSessionId as SessionId, type: GRAPH_ENTRY_TYPE });
    const data = entries.at(-1)?.data;
    if (data !== undefined) {
      restoreMultiAgentGraph(input.registry, input.identity.rootSessionId, data);
      // A crash may happen after a message commits but before the graph acknowledgement saves.
      // Reconcile against the existing transcript idempotency anchor before re-delivering mail.
      for (const task of Object.values(input.registry.all())) {
        if (task.multiAgent?.rootSessionId !== input.identity.rootSessionId || !task.childSessionId || !task.pendingMessages?.length) continue;
        const messages = await input.store.messages({ sessionID: task.childSessionId });
        const consumed = new Set(messages.map((message) => message.info.anchor?.sourceCommandId).filter(Boolean));
        for (const pending of task.pendingMessages) if (consumed.has(pending.id)) acknowledgeMultiAgentMessage(input.registry, task.multiAgent, pending.id);
      }
      for (const task of Object.values(input.registry.all())) if (task.multiAgent?.rootSessionId === input.identity.rootSessionId && task.multiAgent.agentPath !== "/root") input.restoreTask(task.taskId);
    }
    // One live registry stays authoritative. This subscription only schedules a serialized durable projection.
    input.registry.subscribe?.(() => {
      revision += 1;
      queueMicrotask(() => { void flush().catch((error: unknown) => input.onError?.(error)); });
    });
  })();
  void ready.catch((error: unknown) => input.onError?.(error));
  return { ready, flush };
}

export function serializeMultiAgentGraph(registry: RuntimeTaskRegistry, rootSessionId: string): unknown {
  return { version: 1, rootSessionId, tasks: Object.values(registry.all())
    .filter((task) => task.multiAgent?.rootSessionId === rootSessionId)
    .map((task) => ({ taskId: task.taskId, agentId: task.agentId, agentType: task.agentType, description: task.description,
      status: task.status, startedAt: task.startedAt.toISOString(),
      ...(task.completedAt ? { completedAt: task.completedAt.toISOString() } : {}),
      childSessionId: task.childSessionId, parentSessionId: task.parentSessionId, parentToolCallId: task.parentToolCallId,
      outputFile: task.outputFile, prompt: task.prompt, error: task.error, isBackgrounded: task.isBackgrounded,
      branchGeneration: task.branchGeneration, multiAgent: task.multiAgent,
      pendingMessages: (task.pendingMessages ?? []).map((message) => ({ id: message.id, message: message.message, queuedAt: message.queuedAt.toISOString(),
        origin: message.origin,
        senderPath: message.senderPath, targetPath: message.targetPath, messageType: message.messageType,
        senderName: message.senderName, targetName: message.targetName,
        summary: message.summary, isMeta: message.isMeta, traceContext: message.traceContext })),
      resumeState: task.resumeState, output: task.output, usage: task.usage, traceContext: task.traceContext,
    })) };
}

export function restoreMultiAgentGraph(registry: RuntimeTaskRegistry, rootSessionId: string, raw: unknown): void {
  const graph = MultiAgentStoredGraphSchema.parse(raw);
  if (graph.rootSessionId !== rootSessionId) throw new Error("Persisted agent graph belongs to a different root session");
  const paths = new Set<string>();
  const ids = new Set<string>();
  const validated = graph.tasks.map((task) => {
    const identity = task.multiAgent;
    const expectedParent = identity.agentPath === "/root" ? undefined : identity.agentPath.slice(0, identity.agentPath.lastIndexOf("/"));
    if (identity.rootSessionId !== rootSessionId || !/^\/root(?:\/[a-z0-9_]+)*$/.test(identity.agentPath)
      || identity.parentPath !== expectedParent || paths.has(identity.agentPath) || ids.has(task.taskId)
      || task.taskId !== task.agentId || !task.childSessionId
      || (identity.agentPath === "/root" && (task.taskId !== multiAgentRootId(rootSessionId) || task.childSessionId !== rootSessionId))) {
      throw new Error("Invalid or duplicate identity in persisted agent graph");
    }
    paths.add(identity.agentPath); ids.add(task.taskId);
    const live = registry.get(task.taskId);
    if (live && (live.multiAgent?.rootSessionId !== rootSessionId || live.multiAgent.agentPath !== identity.agentPath)) throw new Error("Persisted identity collides with a different live tree");
    const resumeState = parseResumeState(task.resumeState, task);
    const output = task.output === undefined ? undefined : AgentOutputSchema.parse(task.output);
    return { ...task, resumeState, output };
  });
  // Complete validation precedes every owner mutation, including execution bindings and output.
  if (!paths.has("/root")) throw new Error("Persisted agent graph is missing its root");
  for (const task of validated) {
    if (task.multiAgent.parentPath && !paths.has(task.multiAgent.parentPath)) throw new Error("Persisted agent graph has an orphan parent");
    if (task.multiAgent.initiatingAgentPath && !paths.has(task.multiAgent.initiatingAgentPath)) throw new Error("Persisted completion initiator belongs to a different tree");
    if (task.pendingMessages.some((message) => message.targetPath && message.targetPath !== task.multiAgent.agentPath)) throw new Error("Persisted mailbox belongs to a different target");
  }
  // 先预留全部已存在的名称，避免旧图中前面的无名代理抢占后面已命名代理的身份。
  const names = allocateMultiAgentNicknames(validated.map((task) => ({
    ...task.multiAgent,
    nickname: registry.get(task.taskId)?.multiAgent?.nickname ?? task.multiAgent.nickname,
  })));
  for (const [index, storedTask] of validated.entries()) {
    const task = { ...storedTask, multiAgent: { ...storedTask.multiAgent, nickname: names[index]! } };
    const live = registry.get(task.taskId);
    if (live && task.multiAgent.agentPath !== "/root") continue;
    const pendingMessages = task.pendingMessages.map((message) => ({ ...message, queuedAt: new Date(message.queuedAt) })) as RuntimeTaskPendingMessage[];
    if (live && task.multiAgent.agentPath === "/root") {
      registry.update(live.taskId, (current) => ({ ...current,
        pendingMessages: [...pendingMessages, ...(current.pendingMessages ?? []).filter((message) => !pendingMessages.some((saved) => saved.id === message.id))],
        multiAgent: { ...task.multiAgent, ...current.multiAgent!, totalTokens: task.multiAgent.totalTokens,
          lifetimeUsage: task.multiAgent.lifetimeUsage, accountedUsageIds: task.multiAgent.accountedUsageIds,
          activitySequence: task.multiAgent.activitySequence, observedSequence: task.multiAgent.observedSequence } }));
      continue;
    }
    registry.register({ ...task, type: "local_agent", taskType: "local_agent",
      startedAt: new Date(task.startedAt), completedAt: task.completedAt ? new Date(task.completedAt) : undefined,
      childSessionId: task.childSessionId ? task.childSessionId as SessionId : undefined,
      parentSessionId: task.parentSessionId ? task.parentSessionId as SessionId : undefined,
      pendingMessages,
      status: task.status === "running" ? "lost" : task.status,
      error: task.status === "running" ? "Host exited while this agent was running; followup can restore its committed transcript." : task.error,
      multiAgent: { ...task.multiAgent, resident: false },
      resumeState: task.resumeState,
      output: task.output, usage: task.usage as RuntimeTaskSnapshot["usage"],
      traceContext: task.traceContext as RuntimeTaskSnapshot["traceContext"],
    });
  }
}

function parseResumeState(value: unknown, task: {
  agentId: string; agentType: string; parentSessionId?: string;
  multiAgent: MultiAgentIdentity;
}): RuntimeTaskSnapshot["resumeState"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("Invalid agent resume state");
  const state = value as { request?: Partial<SubagentRunRequest>; profile?: Partial<AgentProfile> };
  const request = state.request;
  const profile = state.profile;
  const identity = request?.multiAgent;
  if (!request || !profile || !identity
    || ![request.sessionId, request.workingDirectory, request.workspaceRoot, request.parentToolCallId,
      request.agentType, request.description, request.prompt, profile.name, profile.systemPrompt].every((field) => typeof field === "string")
    || !request.trace || typeof request.trace.traceId !== "string"
    || identity.agentId !== task.agentId || identity.agentPath !== task.multiAgent.agentPath
    || identity.rootSessionId !== task.multiAgent.rootSessionId || identity.parentPath !== task.multiAgent.parentPath
    || request.sessionId !== task.parentSessionId || request.agentType !== task.agentType || profile.name !== task.agentType
    || !["all", "none"].includes(identity.forkTurns)
    || (profile.tools !== undefined && (!Array.isArray(profile.tools) || !profile.tools.every((tool) => typeof tool === "string")))
    || (request.inheritedToolAllowlist !== undefined && (!Array.isArray(request.inheritedToolAllowlist) || !request.inheritedToolAllowlist.every((tool) => typeof tool === "string")))
    || (request.inheritedPlanEnabled !== undefined && typeof request.inheritedPlanEnabled !== "boolean")
    || (request.inheritedDeveloperInstructions !== undefined && typeof request.inheritedDeveloperInstructions !== "string")
    || (request.inheritedPermissionMode !== undefined && !["plan", "guarded", "build", "edit", "auto", "yolo"].includes(request.inheritedPermissionMode))) {
    throw new Error("Incomplete or inconsistent persisted agent execution binding");
  }
  return { request: request as SubagentRunRequest, profile: profile as AgentProfile };
}
