import { Buffer } from "node:buffer";
import { withPersistedSubagentIdentities, readPersistedAgentNames } from "../app/session-store.js";
import {
  createSessionId,
  SessionEventType,
  selectActiveConversationBranch,
  type BackgroundTaskInfo,
  type MessageWithParts,
  type SessionEvent,
  type SessionInfo,
  type SessionProjection,
  type SessionId,
  type SessionStorePort,
  type ToolPart,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
} from "@zcode/contracts";
import type { ZCodeSessionEndedSubagent, ZCodeSessionRunningSubagent } from "@zcode/shared";

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);
const CANCELLATION_PATTERN = /abort|cancel|interrupt|stop/i;

interface SubagentCandidate {
  nickname?: string;
  model?: string;
  reasoningEffort?: string;
  agentId?: string;
  agentPath?: string;
  parentAgentPath?: string;
  rootSessionId?: string;
  childSessionId: string;
  runInBackground: boolean;
  executionRunning?: boolean;
  output: Record<string, unknown> | null;
  part: ToolPart;
  subagentType: string;
  summary?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled" | "lost";
  title: string;
}

interface SubagentEventRelation {
  executionRunning?: boolean;
  nickname?: string;
  model?: string;
  reasoningEffort?: string;
  agentId?: string;
  agentPath?: string;
  parentAgentPath?: string;
  rootSessionId?: string;
  childSessionId?: string;
  description?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled" | "lost";
  subagentType?: string;
  summary?: string;
}

export interface SessionSubagentProjection {
  revision: number;
  running: ZCodeSessionRunningSubagent[];
  ended: ZCodeSessionEndedSubagent[];
}

export interface ProjectSessionSubagentsInput {
  revision: number;
  parentSession: SessionInfo;
  messages: readonly MessageWithParts[];
  childSessionsById: ReadonlyMap<string, SessionInfo>;
  childMessagesById: ReadonlyMap<string, readonly MessageWithParts[]>;
  childProjectionsById: ReadonlyMap<string, SessionProjection>;
  parentProjection?: SessionProjection;
  parentEvents?: readonly SessionEvent[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringField(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(source[key]);
    if (value) return value;
  }
  return undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function agentIdFromLaunchAcknowledgement(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return nonEmptyString(value.match(/(?:^|\n)agentId:\s*([^\s(]+)/)?.[1]);
}

function contentBlocksToText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((block) => nonEmptyString(asRecord(block).text))
    .filter((item): item is string => Boolean(item))
    .join("\n\n");
  return text || undefined;
}

function subagentEventRelations(
  events: readonly SessionEvent[] | undefined,
): ReadonlyMap<string, SubagentEventRelation> {
  const relations = new Map<string, SubagentEventRelation>();
  for (const event of events ?? []) {
    if (
      event.type !== SessionEventType.SubagentSpawned &&
      event.type !== SessionEventType.SubagentStopped
    ) {
      continue;
    }
    const payload = asRecord(event.payload);
    const parentToolCallId = stringField(payload, "parentToolCallId");
    if (!parentToolCallId) continue;
    const current = relations.get(parentToolCallId) ?? {};
    if (event.type === SessionEventType.SubagentSpawned) {
      relations.set(parentToolCallId, {
        ...current,
        agentId: stringField(payload, "agentId") ?? current.agentId,
        nickname: stringField(payload, "nickname") ?? current.nickname,
        agentPath: stringField(payload, "agentPath") ?? current.agentPath,
        parentAgentPath: stringField(payload, "parentAgentPath") ?? current.parentAgentPath,
        rootSessionId: stringField(payload, "rootSessionId") ?? current.rootSessionId,
        model: stringField(payload, "model") ?? current.model,
        reasoningEffort: stringField(payload, "reasoningEffort"),
        childSessionId: stringField(payload, "childSessionId") ?? current.childSessionId,
        description: stringField(payload, "description", "prompt") ?? current.description,
        startedAt: event.timestamp.getTime(),
        subagentType: stringField(payload, "agentType") ?? current.subagentType,
        // 原身份的新一轮 spawn/readiness 取代旧轮终态，不能把首次完成带入 followup。
        stoppedAt: undefined,
        executionRunning: true,
        stoppedStatus: undefined,
        summary: undefined,
      });
      continue;
    }
    const status = stringField(payload, "status");
    relations.set(parentToolCallId, {
      ...current,
      agentId: stringField(payload, "agentId") ?? current.agentId,
      childSessionId: stringField(payload, "childSessionId") ?? current.childSessionId,
      executionRunning: false,
      stoppedAt: event.timestamp.getTime(),
      stoppedStatus:
        status === "cancelled" || status === "stopped"
          ? "cancelled"
          : status === "failed" || status === "error"
            ? "failed"
            : "success",
      summary:
        stringField(payload, "summaryText", "result", "error", "description") ?? current.summary,
    });
  }
  return relations;
}

function activeBranchMessages(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
): MessageWithParts[] {
  return selectActiveConversationBranch(messages, {
    branchCutAfterMessageId: session.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session.revert?.createdMessageID,
    rewindKeptMessageIds: session.revert?.keptMessageIDs,
    rewindTargetMessageId: session.revert?.targetMessageID,
  });
}

function candidateFromToolPart(
  part: ToolPart,
  relation?: SubagentEventRelation,
): SubagentCandidate | null {

  const completedOutput =
    part.state.status === "completed" ? nonEmptyString(part.state.output) : undefined;
  const output = parseJsonObject(completedOutput);
  const input = asRecord(part.state.input);
  const stateMetadata = "metadata" in part.state ? asRecord(part.state.metadata) : {};
  const metadata = { ...asRecord(part.metadata), ...stateMetadata };
  const v2Spawn = metadata.multiAgentOperation === "spawn_agent" || relation?.agentPath !== undefined ||
    ((typeof metadata.childSessionId === "string" || relation?.childSessionId !== undefined) && typeof output?.task_name === "string" && output.task_name.startsWith("/root/")) ||
    // Published V2 histories used explicit identities in the tool result before canonical metadata existed.
    (typeof output?.agentPath === "string" && typeof output?.childSessionId === "string");
  if (!SUBAGENT_TOOL_NAMES.has(part.tool) && !v2Spawn) return null;
  const lifecycle = asRecord(metadata.subagentLifecycle);
  const storedStatus = ["success", "failed", "cancelled", "lost"].includes(String(lifecycle.status))
    ? lifecycle.status as SubagentCandidate["stoppedStatus"] : undefined;
  const agentId =
    stringField(output ?? {}, "agentId") ??
    // 后台 Agent 的持久化 launch ACK 是纯文本，cold query 未携带
    // 临时 spawn event 时无法恢复 childSessionId，导致真实 running Agent 被整条跳过。
    // 标准 ACK 自带 agentId，按该稳定字段恢复，与 runtime 的 session id 规则对齐。
    agentIdFromLaunchAcknowledgement(completedOutput) ??
    stringField(metadata, "agentId") ??
    relation?.agentId;
  const childSessionId =
    stringField(output ?? {}, "childSessionId") ??
    stringField(metadata, "childSessionId") ??
    relation?.childSessionId ??
    (agentId ? createSessionId(`subagent_${agentId}`) : undefined);
  if (!childSessionId) return null;
  const title =
    stringField(output ?? {}, "description") ??
    stringField(metadata, "description") ??
    stringField(input, "description", "task_name") ??
    relation?.description ??
    stringField(input, "prompt") ??
    "Subagent";
  return {
    childSessionId,
    nickname: stringField(output ?? {}, "nickname") ?? stringField(metadata, "nickname") ?? relation?.nickname,
    model: stringField(output ?? {}, "model") ?? stringField(metadata, "model") ?? relation?.model,
    reasoningEffort: stringField(output ?? {}, "reasoningEffort") ?? stringField(metadata, "reasoningEffort") ?? relation?.reasoningEffort,
    runInBackground: v2Spawn || input.run_in_background === true,
    ...(v2Spawn && relation?.executionRunning !== undefined ? { executionRunning: relation.executionRunning } : {}),
    agentPath: stringField(output ?? {}, "agentPath", "task_name") ?? stringField(metadata, "agentPath") ?? relation?.agentPath,
    parentAgentPath: stringField(output ?? {}, "parentAgentPath") ?? stringField(metadata, "parentAgentPath") ?? relation?.parentAgentPath,
    rootSessionId: stringField(output ?? {}, "rootSessionId") ?? stringField(metadata, "rootSessionId") ?? relation?.rootSessionId,
    part,
    output,
    agentId: agentId ?? part.callID,
    subagentType:
      stringField(output ?? {}, "agentType") ??
      stringField(metadata, "agentType") ??
      relation?.subagentType ??
      stringField(input, "subagent_type", "agent_type", "agent", "agentType") ??
      "subagent",
    title,
    summary:
      contentBlocksToText(output?.content) ??
      stringField(output ?? {}, "result", "summary") ??
      (part.state.status === "error" ? nonEmptyString(part.state.error) : undefined) ??
      relation?.summary,
    ...(typeof lifecycle.startedAt === "number" ? { startedAt: lifecycle.startedAt } : {}),
    ...(typeof lifecycle.stoppedAt === "number" ? { stoppedAt: lifecycle.stoppedAt } : {}),
    ...(storedStatus && !relation ? { stoppedStatus: storedStatus } : {}),
    ...(relation?.startedAt !== undefined ? { startedAt: relation.startedAt } : {}),
    ...(relation?.stoppedAt !== undefined ? { stoppedAt: relation.stoppedAt } : {}),
    ...(relation?.stoppedStatus ? { stoppedStatus: relation.stoppedStatus } : {}),
  };
}

function collectCandidates(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): SubagentCandidate[] {
  const candidates = new Map<string, SubagentCandidate>();
  const relations = subagentEventRelations(parentEvents);
  for (const message of activeBranchMessages(session, messages)) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const candidate = candidateFromToolPart(part, relations.get(part.callID));
      if (candidate) candidates.set(candidate.childSessionId, candidate);
    }
  }
  return [...candidates.values()];
}

export function collectSubagentChildSessionIds(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): string[] {
  return collectCandidates(session, messages, parentEvents).map(
    (candidate) => candidate.childSessionId,
  );
}

function lastChildOutcome(messages: readonly MessageWithParts[] | undefined): {
  endedAt?: number;
  status?: "success" | "failed" | "cancelled";
  summary?: string;
} {
  if (!messages || messages.length === 0) return {};
  const assistantMessages = messages.filter((message) => message.info.role === "assistant");
  const last = assistantMessages.at(-1);
  if (!last || last.info.role !== "assistant") return {};
  // stream recovery 作废的半截 assistant 带 error 落盘，但子会话紧接着会从锚点
  // 重发；它是最后一条只说明恢复仍在进行或进程已退出，都不是「子会话失败」的终态。
  if (last.info.error && last.info.error.name === STREAM_RECOVERY_DISCARDED_ERROR_NAME) {
    return {};
  }
  const text = last.parts
    .flatMap((part) => (part.type === "text" && part.ignored !== true ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
  const errorName = last.info.error?.name;
  const errorSummary = last.info.error
    ? (stringField(last.info.error.data ?? {}, "message", "error", "detail") ?? errorName)
    : undefined;
  const hasToolRound = last.parts.some((part) => part.type === "tool");
  return {
    ...(last.info.time.completed ? { endedAt: last.info.time.completed } : {}),
    ...(text || errorSummary ? { summary: text || errorSummary } : {}),
    ...(errorName
      ? { status: CANCELLATION_PATTERN.test(errorName) ? "cancelled" : "failed" }
      : // Bug 根因：assistant 发出 tool call 后，该 model step 也会写 completed/finish；
        // 但 child session 仍在执行 Bash 等工具，不能把“本轮结束”当成“子会话终态”。
        // 只有不含 tool part 的最终 assistant message 才能提供成功 outcome。
        !hasToolRound && (last.info.time.completed || last.info.finish)
        ? { status: "success" }
        : {}),
  };
}

function findBackgroundTask(
  projection: SessionProjection | undefined,
  candidate: SubagentCandidate,
): BackgroundTaskInfo | undefined {
  return projection?.backgroundTasks.find(
    (task) =>
      task.taskKind === "subagent" &&
      (task.childSessionId === candidate.childSessionId ||
        task.toolCallId === candidate.part.callID ||
        task.taskId === candidate.agentId),
  );
}

function runningStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
  parentProjection?: SessionProjection;
}): ZCodeSessionRunningSubagent["status"] | undefined {
  if (input.background?.status === "running") {
    return input.background.blocked ? "blocked" : "running";
  }
  // 明确停止由任务 Owner 先结算；模型的旧 TurnStarted 可能要等在飞请求退出才更新。
  // 真实终态优先，不能继续把已中断的执行展示为 running。
  if (terminalBackgroundStatus(input.background) || input.candidate.stoppedStatus) return undefined;
  // child 的最终模型轮先于 Runner 产物/邮箱结算；只有执行器 stop 才能收口该执行。
  if (input.candidate.executionRunning) return input.childProjection?.status === "waiting" ? "waiting" : "running";
  if (input.childProjection?.status === "waiting") return "waiting";
  if (input.childProjection?.status === "running") return "running";
  // async Agent 的父 tool part 在 launch ACK 后立即标成 completed，
  // partial parent projection 又可能暂时不带仍运行的 background task。此时仅按
  // tool part 会把 child 误判为 ended，并在 cold seed 时清空 V4 running 行。
  // child 初始化可能已产生 idle projection，但尚未进入首个 TurnStarted；不能把
  // launch ACK 的 completed 当作任务成功。没有终态输出或 stop relation 时，
  // background input 仍是 running 事实；真实终态由 background/child projection/outcome 优先。
  if (
    input.candidate.runInBackground &&
    input.background === undefined &&
    (input.childProjection === undefined ||
      (input.childProjection.status === "idle" && input.childProjection.turnCount === 0)) &&
    input.candidate.stoppedStatus === undefined &&
    input.childOutcome.status === undefined
  ) {
    return "running";
  }
  if (
    input.parentProjection?.activeToolCalls.some(
      (tool) =>
        tool.toolCallId === input.candidate.part.callID &&
        (tool.status === "pending" || tool.status === "running"),
    )
  ) {
    return "running";
  }
  return input.parentProjection &&
    (input.candidate.part.state.status === "pending" ||
      input.candidate.part.state.status === "running")
    ? "running"
    : undefined;
}

function terminalBackgroundStatus(
  task: BackgroundTaskInfo | undefined,
): ZCodeSessionEndedSubagent["status"] | undefined {
  switch (task?.status) {
    case "completed":
      return "success";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "timed_out":
    case "spawn_error":
      return "failed";
    case "lost":
      return "lost";
    default:
      return undefined;
  }
}

function endedStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
}): ZCodeSessionEndedSubagent["status"] {
  const backgroundStatus = terminalBackgroundStatus(input.background);
  if (backgroundStatus) return backgroundStatus;
  if (input.candidate.stoppedStatus) return input.candidate.stoppedStatus;
  if (input.childProjection?.status === "error") return "failed";
  if (input.childProjection?.status === "completed") return "success";
  if (input.candidate.part.state.status === "error") {
    return CANCELLATION_PATTERN.test(input.candidate.part.state.error) ? "cancelled" : "failed";
  }
  const outputStatus = stringField(input.candidate.output ?? {}, "status");
  if (outputStatus === "cancelled" || outputStatus === "stopped") return "cancelled";
  if (outputStatus === "failed" || outputStatus === "error") return "failed";
  if (outputStatus === "async_launched") return input.childOutcome.status ?? "lost";
  if (input.candidate.part.state.status === "completed") return "success";
  return input.childOutcome.status ?? "lost";
}

function startedAt(
  candidate: SubagentCandidate,
  background?: BackgroundTaskInfo,
): number | undefined {
  if (background?.startedAt) return background.startedAt.getTime();
  if (candidate.startedAt !== undefined) return candidate.startedAt;
  return "time" in candidate.part.state ? candidate.part.state.time.start : undefined;
}

export function projectSessionSubagents(
  input: ProjectSessionSubagentsInput,
): SessionSubagentProjection {
  const running: ZCodeSessionRunningSubagent[] = [];
  const ended: ZCodeSessionEndedSubagent[] = [];
  for (const candidate of collectCandidates(
    input.parentSession,
    input.messages,
    input.parentEvents,
  )) {
    const childSession = input.childSessionsById.get(candidate.childSessionId);
    if (!childSession || childSession.taskType !== "subagent_child") continue;
    // 工具输出不是成员资格证明：持久父关系和项目边界必须一致。
    if (childSession.projectID !== input.parentSession.projectID ||
        (childSession.parentID !== undefined && childSession.parentID !== input.parentSession.id)) continue;
    const childProjection = input.childProjectionsById.get(candidate.childSessionId);
    const background = findBackgroundTask(input.parentProjection, candidate);
    const childOutcome = lastChildOutcome(input.childMessagesById.get(candidate.childSessionId));
    const liveStatus = runningStatus({
      background,
      candidate,
      childOutcome,
      childProjection,
      parentProjection: input.parentProjection,
    });
    const lastAssistant = input.childMessagesById.get(candidate.childSessionId)
      ?.filter((message) => message.info.role === "assistant").at(-1)?.info;
    const modelSeparator = candidate.model?.indexOf("/") ?? -1;
    // 冷目录读取真实 assistant 的执行选择；首请求前只使用已持久化的派发元数据，不猜默认档位。
    const modelMetadata = lastAssistant?.role === "assistant"
      ? { modelId: lastAssistant.modelId, providerId: lastAssistant.providerId, reasoningEffort: lastAssistant.reasoningLevel }
      : {
          ...(candidate.model && modelSeparator > 0 ? {
            providerId: candidate.model.slice(0, modelSeparator),
            modelId: candidate.model.slice(modelSeparator + 1),
          } : {}),
          ...(candidate.reasoningEffort ? { reasoningEffort: candidate.reasoningEffort } : {}),
        };
    const common = {
      ...(candidate.agentPath ? {
        agentPath: candidate.agentPath,
        parentSessionId: childSession.parentID ?? input.parentSession.id,
        ...(candidate.parentAgentPath ? { parentAgentPath: candidate.parentAgentPath } : {}),
        ...(candidate.rootSessionId ? { rootSessionId: candidate.rootSessionId } : {}),
      } : {}),
      ...modelMetadata,
      ...(childProjection ? { totalTokens: childProjection.totalTokenCount } : {}),
      childSessionId: candidate.childSessionId,
      ...(candidate.agentId ? { agentId: candidate.agentId } : {}),
      toolCallId: candidate.part.callID,
      subagentType: candidate.subagentType,
      title: candidate.nickname ? `${candidate.nickname} · ${candidate.title}` : candidate.title,
      ...(startedAt(candidate, background) !== undefined
        ? { startedAt: startedAt(candidate, background) }
        : {}),
    };
    if (liveStatus) {
      running.push({ ...common, status: liveStatus });
      continue;
    }
    const stateEndedAt =
      "time" in candidate.part.state && "end" in candidate.part.state.time
        ? candidate.part.state.time.end
        : undefined;
    ended.push({
      ...common,
      status: endedStatus({ background, candidate, childOutcome, childProjection }),
      ...(candidate.summary || childOutcome.summary
        ? { summary: candidate.summary ?? childOutcome.summary }
        : {}),
      endedAt:
        background?.completedAt?.getTime() ??
        candidate.stoppedAt ??
        stateEndedAt ??
        childOutcome.endedAt ??
        childSession.time.updated,
    });
  }
  running.sort(
    (left, right) =>
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  ended.sort(
    (left, right) =>
      (right.endedAt ?? 0) - (left.endedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  return { revision: input.revision, running, ended };
}

function encodeCursor(item: ZCodeSessionEndedSubagent): string {
  return Buffer.from(
    JSON.stringify({ childSessionId: item.childSessionId, endedAt: item.endedAt ?? 0 }),
  ).toString("base64url");
}

function decodeCursor(cursor: string | undefined): {
  childSessionId: string;
  endedAt: number;
} | null {
  if (!cursor) return null;
  try {
    const value = asRecord(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
    );
    const childSessionId = nonEmptyString(value.childSessionId);
    const endedAt = value.endedAt;
    return childSessionId && typeof endedAt === "number" ? { childSessionId, endedAt } : null;
  } catch {
    return null;
  }
}

export function paginateEndedSubagents(
  ended: readonly ZCodeSessionEndedSubagent[],
  options: { cursor?: string; limit: number },
): { items: ZCodeSessionEndedSubagent[]; nextCursor?: string } {
  const cursor = decodeCursor(options.cursor);
  const start = cursor
    ? ended.findIndex(
        (item) =>
          (item.endedAt ?? 0) < cursor.endedAt ||
          ((item.endedAt ?? 0) === cursor.endedAt &&
            item.childSessionId.localeCompare(cursor.childSessionId) < 0),
      )
    : 0;
  if (start < 0) return { items: [] };
  const items = ended.slice(start, start + options.limit);
  const last = items.at(-1);
  return {
    items,
    ...(last && start + items.length < ended.length ? { nextCursor: encodeCursor(last) } : {}),
  };
}


/** 两种客户端共享持久父关系读取；这里只构造投影，不保留另一个可变树或任务队列。 */
export async function readSubagentTree(input: {
  rootSession: SessionInfo;
  rootMessages?: readonly MessageWithParts[];
  revision: number;
  store: Pick<SessionStorePort, "getSession" | "messages" | "sessionEntries">;
  readEvents: (sessionId: SessionId) => Promise<readonly SessionEvent[]>;
  readProjection: (sessionId: SessionId) => Promise<SessionProjection | undefined>;
}): Promise<{ projection: SessionSubagentProjection; childSessionIds: string[] }> {
  const queue = [input.rootSession];
  const visited = new Set<string>([input.rootSession.id]);
  const childSessionIds: string[] = [];
  const running: ZCodeSessionRunningSubagent[] = [];
  const ended: ZCodeSessionEndedSubagent[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index]!;
    const [rawMessages, parentEvents, parentProjection] = await Promise.all([
      parent.id === input.rootSession.id && input.rootMessages
        ? Promise.resolve(input.rootMessages)
        : input.store.messages({ sessionID: parent.id }),
      input.readEvents(parent.id),
      input.readProjection(parent.id),
    ]);
    const messages = await withPersistedSubagentIdentities({ sessionId: parent.id,
      messages: activeBranchMessages(parent, rawMessages), store: input.store });
    const children = [];
    for (const id of collectSubagentChildSessionIds(parent, messages, parentEvents)) {
      if (visited.has(id)) continue;
      const child = await input.store.getSession(id as SessionId);
      if (!child || child.taskType !== "subagent_child" ||
          child.projectID !== input.rootSession.projectID ||
          (child.parentID !== undefined && child.parentID !== parent.id)) continue;
      visited.add(id);
      childSessionIds.push(id);
      queue.push(child);
      const [childMessages, childProjection] = await Promise.all([
        input.store.messages({ sessionID: child.id }),
        input.readProjection(child.id),
      ]);
      children.push({ child, childMessages, childProjection });
    }
    const projection = projectSessionSubagents({
      revision: input.revision,
      parentSession: parent,
      messages,
      parentEvents,
      parentProjection,
      childSessionsById: new Map(children.map(({ child }) => [child.id, child])),
      childMessagesById: new Map(children.map(({ child, childMessages }) => [child.id, childMessages])),
      childProjectionsById: new Map(children.flatMap(({ child, childProjection }) =>
        childProjection ? [[child.id, childProjection] as const] : [])),
    });
    running.push(...projection.running);
    ended.push(...projection.ended);
  }
  ended.sort((left, right) =>
    (right.endedAt ?? 0) - (left.endedAt ?? 0) ||
    right.childSessionId.localeCompare(left.childSessionId));
  const names = await readPersistedAgentNames(input.store, input.rootSession.id);
  for (const item of [...running, ...ended]) {
    const name = names[item.childSessionId];
    if (name && !item.title.startsWith(`${name} · `)) item.title = `${name} · ${item.title}`;
  }
  return { projection: { revision: input.revision, running, ended }, childSessionIds };
}
