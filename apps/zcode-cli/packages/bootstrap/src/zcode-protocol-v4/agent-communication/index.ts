import {
  createEventId,
  parseRuntimeInputPresentation,
  parseCompletedToolPartMetadata,
  SessionEventType,
  type MessageWithParts,
  type SessionEvent,
  type TurnSteerDrainedPayload,
} from "@zcode/contracts";
import { agentMessageFromInput } from "../projection-rows.js";

/** 只补展示别名，保留工具原始输入/输出及持久化正文。 */
export function withAgentRecipientNames(
  messages: readonly MessageWithParts[],
  names?: Readonly<Record<string, string>>,
): readonly MessageWithParts[] {
  if (!names) return messages;
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      const metadata = part.type === "tool" ? { ...part.metadata, ...("metadata" in part.state ? part.state.metadata : {}) } : {};
      if (
        part.type !== "tool" ||
        part.state.status !== "completed" ||
        (part.tool !== "SendMessage" &&
          metadata.multiAgentOperation !== "send_message" &&
          metadata.multiAgentOperation !== "followup_task")
      )
        return part;
      const target = part.state.input.to ?? part.state.input.target;
      const recipientName = typeof target === "string" ? names[target] : undefined;
      if (!recipientName) return part;
      const display =
        typeof metadata.display === "object" &&
        metadata.display !== null &&
        "kind" in metadata.display &&
        metadata.display.kind === "local_agent_message"
          ? metadata.display
          : {};
      return {
        ...part,
        state: {
          ...part.state,
          metadata: {
            ...metadata,
            display: { kind: "local_agent_message", status: "success", ...display, recipientName },
          },
        },
      };
    }),
  }));
}

/** cold drain 已保留 messageId；按同一持久化输入补来源，禁止凭文本猜测用户身份。 */
export function hydrateAgentCommunicationEvents(input: {
  events: readonly SessionEvent[];
  messages: readonly MessageWithParts[];
  agentNames?: Readonly<Record<string, string>>;
  sessionId: string;
}): SessionEvent[] {
  const messages = new Map(input.messages
    .filter((message) => String(message.info.sessionID) === input.sessionId)
    .map((message) => [String(message.info.id), message]));
  const events = input.events.map((event) => {
    if (event.type === SessionEventType.SubagentSpawned) {
      const payload = event.payload as Record<string, unknown>;
      const childId =
        typeof payload.childSessionId === "string" ? payload.childSessionId : undefined;
      const nickname = childId ? input.agentNames?.[childId] : undefined;
      return nickname ? { ...event, payload: { ...payload, nickname } } : event;
    }
    if (event.type !== SessionEventType.TurnSteerDrained) return event;
    const payload = event.payload as TurnSteerDrainedPayload;
    if (!payload.drainedInputs) return event;
    return {
      ...event,
      payload: {
        ...payload,
        drainedInputs: payload.drainedInputs.map((item) => {
          const stored = item.messageId ? messages.get(item.messageId) : undefined;
          const inputPresentation =
            parseRuntimeInputPresentation(stored?.info.metadata?.inputPresentation) ??
            item.inputPresentation;
          const communication = agentMessageFromInput(item.text, inputPresentation);
          return {
            ...item,
            ...(inputPresentation ? { inputPresentation } : {}),
            ...(communication
              ? {
                  senderName:
                    input.agentNames?.[communication.senderPath] ?? communication.senderName,
                  targetName:
                    input.agentNames?.[communication.targetPath] ?? communication.targetName,
                }
              : {}),
          };
        }),
      },
    };
  });
  return events;
}


/** Registered identity is shared by live execution and cold transcript projection. */
export function hydrateRegisteredAgentEvents(events: readonly SessionEvent[], messages: readonly MessageWithParts[]): SessionEvent[] {
  const tools = new Map(messages.flatMap((message) => message.parts.flatMap((part) =>
    part.type === "tool" ? [[part.callID, part] as const] : [])));
  return events.flatMap((event) => {
    if (event.type !== SessionEventType.ToolCallStarted && event.type !== SessionEventType.SubagentSpawned &&
        event.type !== SessionEventType.SubagentStopped) return [event];
    const payload = event.payload as Record<string, unknown>;
    const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : typeof payload.parentToolCallId === "string" ? payload.parentToolCallId : undefined;
    const part = callId ? tools.get(callId) : undefined;
    const metadata = part ? parseCompletedToolPartMetadata({ ...part.metadata, ...("metadata" in part.state ? part.state.metadata : {}) }) : undefined;
    if (!metadata?.multiAgentOperation) return [event];
    const started = { ...event, payload: { ...payload, multiAgentOperation: metadata.multiAgentOperation } };
    if (metadata.multiAgentOperation !== "spawn_agent" || !part ||
      typeof metadata.agentId !== "string" || typeof metadata.childSessionId !== "string") {
      return [event.type === SessionEventType.ToolCallStarted ? started : event];
    }
    const lifecycle = metadata.subagentLifecycle && typeof metadata.subagentLifecycle === "object"
      ? metadata.subagentLifecycle as Record<string, unknown> : {};
    const identity = { agentId: metadata.agentId, childSessionId: metadata.childSessionId,
      agentType: metadata.agentType, agentPath: metadata.agentPath, parentAgentPath: metadata.parentAgentPath,
      rootSessionId: metadata.rootSessionId, nickname: metadata.nickname, model: metadata.model,
      reasoningEffort: metadata.reasoningEffort, parentToolCallId: part.callID, description: metadata.description };
    if (event.type === SessionEventType.SubagentSpawned || event.type === SessionEventType.SubagentStopped) {
      return [{ ...event, payload: { ...payload, ...identity,
        ...(event.type === SessionEventType.SubagentStopped && typeof lifecycle.status === "string" ? { status: lifecycle.status } : {}) } }];
    }
    if (event.type !== SessionEventType.ToolCallStarted) return [event];
    if (["Agent", "Task", "subagent"].includes(part.tool)) return [started];
    // 原生 spawn 的完成只是接纳 ACK。终态取持久图；进程退出的未完成执行为 lost。
    return [started, { ...event, id: createEventId(`${event.id}:subagent-spawn`), type: SessionEventType.SubagentSpawned,
      timestamp: new Date(typeof lifecycle.startedAt === "number" ? lifecycle.startedAt : event.timestamp.getTime()),
      payload: { ...identity, status: "running" } },
      { ...event, id: createEventId(`${event.id}:subagent-stop`), type: SessionEventType.SubagentStopped,
        timestamp: new Date(typeof lifecycle.stoppedAt === "number" ? lifecycle.stoppedAt : event.timestamp.getTime()),
        payload: { ...identity, status: typeof lifecycle.status === "string" ? lifecycle.status : "lost" } }];
  });
}
