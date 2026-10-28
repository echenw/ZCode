import { isAbsolute, resolve } from "node:path";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import { resolvePath, type ConfigResult } from "@zcode/adapters/config";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
  type MessageWithParts,
  MultiAgentStoredGraphSchema,
  allocateMultiAgentNicknames,
  parseModelSelectionValue,
  type SessionId,
  type SessionStorePort,
  type CollaborationMode,
  type InputHistoryStorePort,
  type LocalSettingStorePort,
  type ProjectId,
} from "@zcode/contracts";
import type { ModelSelection } from "@zcode/provider";
import { isHighspeedProviderId } from "@zcode/shared";
import { StartupTimer } from "../startup-logging.js";

export function isClosableSessionStore(
  store: SessionStorePort,
): store is SessionStorePort & { close(): void } {
  return "close" in store && typeof store.close === "function";
}

export function asInputHistoryStore(store: SessionStorePort): InputHistoryStorePort | undefined {
  const candidate = store as Partial<InputHistoryStorePort>;
  return typeof candidate.recordInputHistory === "function" &&
    typeof candidate.recallPreviousInputHistory === "function"
    ? (store as SessionStorePort & InputHistoryStorePort)
    : undefined;
}

export function asLocalSettingStore(store: SessionStorePort): LocalSettingStorePort | undefined {
  const candidate = store as Partial<LocalSettingStorePort>;
  return typeof candidate.getProjectPermissionMode === "function" &&
    typeof candidate.saveProjectPermissionMode === "function"
    ? (store as SessionStorePort & LocalSettingStorePort)
    : undefined;
}

export function readProjectPermissionMode(
  store: LocalSettingStorePort | undefined,
  projectID: ProjectId,
): CollaborationMode | undefined {
  if (!store) return undefined;
  const mode = store.getProjectPermissionMode(projectID);
  return isPromiseLike(mode) ? undefined : (mode ?? undefined);
}

/** 读取 Session 自己最近一次显式选择；恢复时它高于 Environment 默认值。 */
export async function readSessionModelSelection(
  store: Pick<SessionStorePort, "sessionEntries">,
  sessionID: SessionId,
): Promise<ModelSelection | undefined> {
  if (!store.sessionEntries) return undefined;
  const entries = await store.sessionEntries({
    sessionID,
    type: SESSION_ENTRY_MODEL_SELECTION,
  });
  const data = entries.at(-1)?.data;
  const complete = parseModelSelectionValue(data);
  if (complete) return residentModelSelection(complete);
  // reasoning 的错误类型不能抹掉可恢复的当前模型身份；这里只读取新字段，
  // 不借旧 thoughtLevel/消息/default 补值。执行前仍由 Registry 严格校验。
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const current = data as Record<string, unknown>;
    return residentModelSelection(
      parseModelSelectionValue({ providerId: current.providerId, modelId: current.modelId }),
    );
  }
  return undefined;
}

/**
 * 加速卡 Provider 是 `selectionScope=execution` 的单轮执行身份，永远不能当作会话常驻选型
 * （highspeed-card-spec §5.1）。旧版本分叉会把分叉点消息上的加速选型写进 child 的
 * model_selection entry，这类会话恢复后常驻在一个无凭据、且不在模型列表里的隐藏 Provider 上，
 * 还会经 restoredModelSelection 投影成界面选中态与 contextWindow。读取时直接丢弃，
 * 会话回到「未绑定」而不是借默认模型补齐（恢复语义见 runtime-config 的 initialModelSelection），
 * 由用户重新选一次模型，避免隐藏身份继续在存储与投影里传播。
 */
function residentModelSelection(selection: ModelSelection | undefined): ModelSelection | undefined {
  if (!selection) return undefined;
  return isHighspeedProviderId(selection.providerId) ? undefined : selection;
}

export function closeSessionStore(store: SqliteSessionStore): void {
  store.close();
}

export async function openStartupSessionStore(
  configResult: ConfigResult,
  startupTimer: StartupTimer,
): Promise<SqliteSessionStore> {
  const dbPath = getSessionDbPath(configResult);
  startupTimer.start("ZCode SQLite migration started", {
    context: { dbPath },
    event: "bootstrap.app.startup.sqlite_migration.started",
    stage: "migrate_session_db",
  });
  const store = await SqliteSessionStore.openStartup(
    { dbPath },
    {
      onProgress: async (progress) => {
        startupTimer.mark("SQLite startup state", {
          event: "bootstrap.app.startup.storage_state",
          stage: "migrate_session_db",
          context: { ...progress },
        });
      },
    },
  );
  startupTimer.mark("ZCode SQLite migration completed", {
    context: { dbPath },
    event: "bootstrap.app.startup.sqlite_migration.completed",
    stage: "migrate_session_db",
  });
  return store;
}

export async function openStartupZCodeProtocolSessionStore(
  configResult: ConfigResult,
  startupTimer: StartupTimer,
): Promise<SqliteSessionStore> {
  const dbPath = getSessionDbPath(configResult);
  startupTimer.start("ZCode Protocol SQLite migration started", {
    context: { dbPath },
    event: "zcode_protocol.startup.sqlite_migration.started",
    stage: "migrate_session_db",
  });
  const store = await SqliteSessionStore.openStartup({ dbPath });
  startupTimer.mark("ZCode Protocol SQLite migration completed", {
    context: { dbPath },
    event: "zcode_protocol.startup.sqlite_migration.completed",
    stage: "migrate_session_db",
  });
  return store;
}

export function getSessionDbPath(configResult: ConfigResult, workingDirectory?: string): string {
  const configured = configResult.config.storage.sessionDbPath;
  // 存储 Worker 不能 chdir；显式传入业务实际 cwd，保持相对路径与普通 Agent 一致。
  if (workingDirectory && !isAbsolute(configured) && !configured.startsWith("~/"))
    return resolve(workingDirectory, configured);
  return resolvePath(configured);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** 旧图没有名称时按原注册顺序派生展示名；不写数据库、不修改寻址身份。 */
export async function readPersistedAgentGraph(
  store: {
    getSession(id: SessionId): Promise<{ parentID?: SessionId; projectID?: string } | null>;
    sessionEntries?: SessionStorePort["sessionEntries"];
  },
  sessionId: string,
) {
  const visited = new Set<string>();
  let current: string | undefined = sessionId;
  let project: string | undefined;
  while (current && !visited.has(current)) {
    visited.add(current);
    const session = await store.getSession(current as import("@zcode/contracts").SessionId);
    if (!session || (project && session.projectID && session.projectID !== project)) return undefined;
    project ??= session.projectID;
    const entries = await store.sessionEntries?.({
      sessionID: current as import("@zcode/contracts").SessionId,
      type: "multi_agent/graph",
    });
    const graph = MultiAgentStoredGraphSchema.safeParse(entries?.at(-1)?.data);
    if (graph.success && graph.data.rootSessionId === current) {
      const paths = new Map(graph.data.tasks.map((task) => [task.multiAgent.agentPath, task]));
      const ids = new Set(graph.data.tasks.map((task) => task.agentId));
      if (paths.size !== graph.data.tasks.length || ids.size !== graph.data.tasks.length || !paths.has("/root")) return undefined;
      for (const task of graph.data.tasks) {
        const identity = task.multiAgent;
        const parentPath = identity.agentPath === "/root" ? undefined : identity.agentPath.slice(0, identity.agentPath.lastIndexOf("/"));
        if (!/^\/root(?:\/[a-z0-9_]+)*$/.test(identity.agentPath) || identity.rootSessionId !== current ||
            (identity.parentPath !== undefined && identity.parentPath !== parentPath) || task.taskId !== task.agentId || !task.childSessionId ||
            (parentPath && !paths.has(parentPath)) ||
            (!parentPath && task.childSessionId !== current)) return undefined;
      }
      return graph.data;
    }
    current = session.parentID;
  }
  return undefined;
}

export async function readPersistedAgentNames(
  store: Parameters<typeof readPersistedAgentGraph>[0], sessionId: string,
): Promise<Record<string, string>> {
  const graph = await readPersistedAgentGraph(store, sessionId);
  if (!graph) return {};
  const names: Record<string, string> = {};
  const allocated = allocateMultiAgentNicknames(graph.tasks.map((task) => task.multiAgent));
  for (const [index, task] of graph.tasks.entries()) {
    names[task.multiAgent.agentPath] = allocated[index]!;
    names[task.agentId] = allocated[index]!;
    if (task.childSessionId) names[task.childSessionId] = allocated[index]!;
  }
  return names;
}

/** Read the Registry projection through Store, validating each actual transcript edge. No runtime is started. */
export async function withPersistedSubagentIdentities(input: {
  sessionId: string;
  messages: readonly MessageWithParts[];
  store: {
    getSession(id: SessionId): Promise<{ projectID?: string; parentID?: SessionId; taskType?: string } | null>;
    sessionEntries?: SessionStorePort["sessionEntries"];
  };
}): Promise<MessageWithParts[]> {
  const [graph, parent] = await Promise.all([
    readPersistedAgentGraph(input.store, input.sessionId), input.store.getSession(input.sessionId as SessionId),
  ]);
  if (!graph || !parent) return [...input.messages];
  const parentTask = graph.tasks.find((task) => task.childSessionId === input.sessionId);
  if (!parentTask) return [...input.messages];
  const tasks = new Map<string, typeof graph.tasks[number]>();
  for (const task of graph.tasks) {
    if (task.multiAgent.parentPath !== parentTask.multiAgent.agentPath || task.parentSessionId !== input.sessionId || !task.parentToolCallId || !task.childSessionId) continue;
    const child = await input.store.getSession(task.childSessionId as SessionId);
    // 图只提供身份；真正成员资格仍由持久父关系、项目和当前分支上的创建 call 证明。
    if (child?.taskType !== "subagent_child" || child.parentID !== input.sessionId || child.projectID !== parent.projectID) continue;
    tasks.set(task.parentToolCallId, task);
  }
  return input.messages.map((message) => ({ ...message, parts: message.parts.map((part) => {
    if (part.type !== "tool") return part;
    const task = tasks.get(part.callID);
    if (!task) return part;
    const status = task.status === "running" ? "lost" : task.status === "completed" ? "success" :
      task.status === "failed" ? "failed" : task.status === "lost" ? "lost" : "cancelled";
    const metadata = { ...part.metadata, ...("metadata" in part.state ? part.state.metadata : {}),
      schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION, multiAgentOperation: "spawn_agent", agentId: task.agentId, childSessionId: task.childSessionId,
      agentPath: task.multiAgent.agentPath, parentAgentPath: task.multiAgent.parentPath,
      rootSessionId: graph.rootSessionId, nickname: task.multiAgent.nickname,
      agentType: task.agentType, description: task.description, model: task.multiAgent.model,
      reasoningEffort: task.multiAgent.reasoningEffort,
      subagentLifecycle: { status, startedAt: Date.parse(task.startedAt),
        stoppedAt: task.completedAt ? Date.parse(task.completedAt) : undefined },
    };
    return { ...part, metadata, state: { ...part.state, metadata } };
  }) }));
}
