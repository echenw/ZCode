import {
  EventReducer,
  SessionEventType,
  type SessionEvent,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type { ZCodeSessionSubagentsResult } from "@zcode/shared";
import { projectSessionTranscript, type SessionTranscriptMessage } from "../../session-transcript.js";
import {
  paginateEndedSubagents,
  readSubagentTree,
} from "../../zcode-protocol/subagent-session-query.js";

export interface SubagentTranscriptSnapshot {
  sessionId: string;
  sequenceNumber: number;
  messages: Array<SessionTranscriptMessage & { id?: string }>;
  events: SessionEvent[];
  replayMessageIds: string[];
}

type ObservationDeps = {
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  runtime: AgentRuntime;
};

/** The app owns storage and lifecycle interpretation; the TUI receives a read model. */
export function createSubagentObservation(deps: ObservationDeps) {
  return {
    async readSubagents(
      input: { endedCursor?: string; endedLimit?: number } = {},
    ): Promise<ZCodeSessionSubagentsResult> {
      const eventStore = deps.runtime.getSessionEventStore();
      const parentSession = await deps.sessionStore.getSession(deps.sessionId);
      if (!parentSession)
        return { revision: 0, childSessionIds: [], running: [], ended: { total: 0, items: [] } };
      const { projection, childSessionIds } = await readSubagentTree({
        rootSession: parentSession,
        revision: await eventStore.getLatestSequenceNumber(deps.sessionId),
        store: deps.sessionStore,
        readEvents: (id) => eventStore.getEvents(id),
        readProjection: async (id) => {
          if (id === deps.sessionId) return deps.runtime.getProjection();
          const events = await eventStore.getEvents(id);
          return events.length ? new EventReducer().reduce(events) : undefined;
        },
      });
      const ended = paginateEndedSubagents(projection.ended, {
        cursor: input.endedCursor,
        limit: Math.min(100, Math.max(1, input.endedLimit ?? 20)),
      });
      return {
        revision: projection.revision,
        childSessionIds,
        running: projection.running,
        ended: { total: projection.ended.length, ...ended },
      };
    },
    async readSubagentTranscript(childSessionId: string): Promise<SubagentTranscriptSnapshot> {
      const eventStore = deps.runtime.getSessionEventStore();
      const sessionId = childSessionId as SessionId;
      const child = await deps.sessionStore.getSession(sessionId);
      if (!child || child.taskType !== "subagent_child") {
        throw new Error("Subagent does not belong to the current session.");
      }
      // 详情访问沿持久父链校验；不能因支持孙代理而放开任意 session ID。
      const visited = new Set<string>([child.id]);
      let parentId = child.parentID;
      while (parentId && parentId !== deps.sessionId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = await deps.sessionStore.getSession(parentId);
        if (!parent || parent.projectID !== child.projectID) break;
        parentId = parent.parentID;
      }
      if (parentId !== deps.sessionId) {
        throw new Error("Subagent does not belong to the current session.");
      }
      // Read persisted history first, then the event tail. For messages with a
      // complete live stream, replay replaces persisted text instead of appending
      // it twice. Later events are admitted strictly after this watermark.
      const persisted = await deps.sessionStore.messages({ sessionID: sessionId });
      const events = await eventStore.getEvents(sessionId);
      const replayMessageIds = new Set<string>();
      for (const event of events) {
        const payload = event.payload as Record<string, unknown>;
        if (
          event.type === SessionEventType.ModelStreaming &&
          payload.kind === "start" &&
          typeof payload.assistantMessageId === "string"
        ) {
          replayMessageIds.add(payload.assistantMessageId);
        }
      }
      const messages = persisted.flatMap((message) =>
        replayMessageIds.has(message.info.id)
          ? [{ id: message.info.id, content: "", role: "agent" as const }]
          : projectSessionTranscript([message]).map((projected) => ({
              ...projected,
              id: message.info.id,
            })),
      );
      return {
        sessionId,
        messages,
        events,
        replayMessageIds: [...replayMessageIds],
        sequenceNumber: events.at(-1)?.sequenceNumber ?? 0,
      };
    },
  };
}
