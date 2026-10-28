// SessionEvent payload → ConversationRow 的构造纯函数。
// row 自包含原则：这里产出的每一行都必须不依赖其它行即可渲染。
import type {
  CompactTimelineStatus,
  CompactTrigger,
  GoalStatus,
  SyntheticUserMessageSource,
  ToolResultPayload,
  TurnResultType,
  TurnStartedPayload,
} from "@zcode/contracts";
import type {
  GoalState,
  TimelineMarkerPayload,
  ToolOutput,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";

export interface RowBaseInput {
  rowId: number;
  turnId: string;
  createdAt: number;
  createdAtSeq: number;
}

/** 只解析有运行时来源标记的邮箱 carrier，用户粘贴同样文本不能冒充代理来信。 */
export function agentMessageFromInput(
  text: string,
  presentation: string | undefined,
): UserInputRow["agentMessage"] | undefined {
  if (
    presentation !== "coordinator_steer" &&
    presentation !== "subagent_reply_steer" &&
    presentation !== "subagent_reply"
  )
    return undefined;
  const split = text.indexOf("\nPayload:\n");
  if (split < 0) return undefined;
  const fields = new Map(
    text
      .slice(0, split)
      .split("\n")
      .map((line) => {
        const colon = line.indexOf(": ");
        return [line.slice(0, colon), line.slice(colon + 2)] as const;
      }),
  );
  const messageType = fields.get("Message Type");
  const senderPath = fields.get("Sender");
  const targetPath = fields.get("Task name");
  if (
    (messageType !== "MESSAGE" && messageType !== "NEW_TASK" && messageType !== "FINAL_ANSWER") ||
    !senderPath || !/^\/root(?:\/|$)/.test(senderPath) ||
    !targetPath
  )
    return undefined;
  let body = text.slice(split + "\nPayload:\n".length);
  // legacy 完成通知的 envelope 仍给模型原文；视图只提取宿主生成的 result，避免 XML/ID 占满摘要。
  if (messageType === "FINAL_ANSWER" && body.startsWith("<task-notification>")) {
    const result = /<result>([\s\S]*?)<\/result>/.exec(body)?.[1]
      ?? /<error>([\s\S]*?)<\/error>/.exec(body)?.[1]
      ?? /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1];
    if (result !== undefined) {
      const entities: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };
      body = result.replace(/&(lt|gt|amp|apos|quot);/g, (_match, entity: string) => entities[entity]!);
    }
  }
  return {
    messageType,
    senderPath,
    targetPath,
    body,
    ...(fields.get("Sender name") ? { senderName: fields.get("Sender name") } : {}),
    ...(fields.get("Recipient name") ? { targetName: fields.get("Recipient name") } : {}),
  };
}

// inputSource → turnHeader.origin（10 §4.4.2）。
export function mapTurnHeaderOrigin(
  source: SyntheticUserMessageSource | undefined,
): TurnHeaderRow["origin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "rewind":
      return "editRerun";
    default:
      return "userInput";
  }
}

// inputSource → userInput.origin（10 §4.4.3）。
export function mapUserInputOrigin(
  source: SyntheticUserMessageSource | undefined,
): UserInputRow["origin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "subagent":
    case "subagent_message":
      return "mailbox";
    case "fork":
    case "plugin_reference":
    case "rewind":
    case "todo_reminder":
      return "synthetic";
    default:
      return "realUser";
  }
}

export function buildTurnHeaderRow(base: RowBaseInput, payload: TurnStartedPayload): TurnHeaderRow {
  return {
    ...base,
    kind: "turnHeader",
    origin: mapTurnHeaderOrigin(payload.inputSource),
    executionKind: payload.executionKind ?? "agent",
    ...(payload.originMeta ? { originMeta: payload.originMeta } : {}),
    state: "running",
    startedAt: base.createdAt,
  };
}

export function buildUserInputRow(base: RowBaseInput, payload: TurnStartedPayload): UserInputRow {
  // 附件渲染：TurnStarted 携带的展示元信息 → row.attachments。
  // ref 是内容引用占位（本地路径/artifact URI）；无稳定引用时以行内序号占位，
  // 展示层只用 fileName/mime/bytes，不据 ref 取内容（attachment/get query 属后续）。
  const attachments =
    payload.intent?.attachmentRefs ??
    payload.attachments?.map((meta, index) => ({
      ref: meta.ref ?? `turn-attachment/${base.rowId}/${index}`,
      fileName: meta.fileName,
      mime: meta.mime,
      bytes: meta.bytes,
    }));
  const sourceCommandId = payload.intent?.sourceCommandId ?? payload.inputId;
  const rootSourceCommandId = payload.intent?.provenance?.sourceCommandId ?? sourceCommandId;
  return {
    ...base,
    kind: "userInput",
    ...(payload.intent?.inputOrigin ? { inputOrigin: payload.intent.inputOrigin } : {}),
    ...(payload.intent?.conversationQuotes
      ? { conversationQuotes: payload.intent.conversationQuotes }
      : {}),
    ...(payload.intent?.botGroupSource ? { botGroupSource: payload.intent.botGroupSource } : {}),
    text:
      payload.intent?.conversationQuotes || payload.intent?.botGroupSource
        ? (payload.intent.text ?? payload.input)
        : payload.input,
    origin: mapUserInputOrigin(payload.inputSource),
    ...(sourceCommandId ? { sourceCommandId } : {}),
    ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
    ...(payload.intent?.clientId ? { clientId: payload.intent.clientId } : {}),
    ...(payload.intent?.highspeed ? { highspeed: payload.intent.highspeed } : {}),
    ...(payload.epilogueStart === undefined ? {} : { epilogueStart: payload.epilogueStart }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

export function mapTurnResultToHeaderState(
  resultType: TurnResultType,
): Exclude<TurnHeaderRow["state"], "running"> {
  switch (resultType) {
    case "success":
      return "completedSuccess";
    case "cancelled":
      return "completedInterrupted";
    default:
      return "failed";
  }
}

// CompactTimelineStatus → compact marker.status。
// 语义映射：retrying 仍是运行中；skipped = 无事发生（noop）；interrupted = 被 stop（cancelled）。
export function mapCompactMarkerStatus(
  status: CompactTimelineStatus,
): Extract<TimelineMarkerPayload, { type: "compact" }>["status"] {
  switch (status) {
    case "started":
    case "retrying":
      return "running";
    case "completed":
      return "success";
    case "skipped":
      return "noop";
    case "interrupted":
      return "cancelled";
    default:
      return "failed";
  }
}

// CompactTrigger → marker.origin：manual 之外（auto/partial/reactive/session_memory）
// 一律归 auto —— UI 只区分「用户点的」与「系统触发的」。
export function mapCompactMarkerOrigin(
  trigger: CompactTrigger,
): Extract<TimelineMarkerPayload, { type: "compact" }>["origin"] {
  return trigger === "manual" ? "manual" : "auto";
}

// 旧 GoalStatus → v4 GoalState.status。
// budget_limited 归 paused：预算耗尽与被 stop 一样等待用户显式 resume；
// complete 归 verified：旧词表没有 verifying/notSatisfied 细分，终态语义等价。
export function mapGoalStatus(status: GoalStatus): GoalState["status"] {
  switch (status) {
    case "active":
      return "active";
    case "complete":
      return "verified";
    default:
      return "paused";
  }
}

// 终态截断全档统一：head+tail 各 32K，超出部分以 truncated.ref 按需拉取。
// 阶段 ref 先用 toolCallId 占位（artifact 存取属传输外壳期）。
export function buildToolOutput(result: ToolResultPayload, toolCallId: string): ToolOutput {
  const text = result.content;
  // 模型可见文本只保留图片占位符，若 V4 output 不独立携带 display，
  // 实时投影和冷恢复都会丢失 CUA 截图。Node REPL 图片仍走 ToolCallRow.display 专用通道。
  const display = result.display?.kind === "node_repl_images" ? undefined : result.display;
  const headBytes = PROTOCOL_V4_LIMITS.toolOutputFinalHeadBytes;
  const tailBytes = PROTOCOL_V4_LIMITS.toolOutputFinalTailBytes;
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= headBytes + tailBytes) {
    return { text, ...(display ? { display } : {}) };
  }
  const buffer = Buffer.from(text, "utf8");
  const head = buffer.subarray(0, headBytes).toString("utf8");
  const tail = buffer.subarray(buffer.length - tailBytes).toString("utf8");
  return {
    text: `${head}\n…\n${tail}`,
    ...(display ? { display } : {}),
    truncated: { totalBytes, ref: `tool-output/${toolCallId}` },
  };
}
