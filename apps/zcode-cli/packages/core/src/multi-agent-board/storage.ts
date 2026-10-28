import {
  AgentMessageBoardStoredStateSchema, CoreErrorType, createCoreError,
  type AgentMessageBoardStoredState, type SessionId, type SessionStorePort,
} from "@zcode/contracts";

export const AGENT_MESSAGE_BOARD_ENTRY_TYPE = "multi_agent/message_board";
export interface BoardPersistence {
  load(): Promise<AgentMessageBoardStoredState>;
  save(state: AgentMessageBoardStoredState, timestamp: number): Promise<void>;
}

export function emptyBoard(rootSessionId: string): AgentMessageBoardStoredState {
  return { version: 1, rootSessionId, channels: [], posts: [], subscriptions: [] };
}

export function createBoardPersistence(rootSessionId: string, store: SessionStorePort | undefined): BoardPersistence {
  if (!store?.sessionEntries || !store.saveSessionEntry) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Local message boards require SessionStore session entry persistence", {
      recoverable: false, context: { code: "message_board_storage_unavailable" },
    });
  }
  // rootSessionId 已是现有会话标识；createSessionId 会再次添加 sess_，把板写进另一个会话。
  const sessionID = rootSessionId as SessionId;
  const id = `message_board:${rootSessionId}`;
  let created: number | undefined;
  return {
    async load() {
      const entries = await store.sessionEntries!({ sessionID, type: AGENT_MESSAGE_BOARD_ENTRY_TYPE });
      const entry = entries.find((item) => item.id === id);
      if (!entry) return emptyBoard(rootSessionId);
      const result = AgentMessageBoardStoredStateSchema.safeParse(entry.data);
      if (!result.success || result.data.rootSessionId !== rootSessionId) {
        throw createCoreError(CoreErrorType.ConfigurationError, "Stored message-board state is invalid for this root", {
          recoverable: false, context: { code: "message_board_invalid_snapshot" },
        });
      }
      created = entry.time.created;
      return result.data;
    },
    async save(state, timestamp) {
      const first = created ?? timestamp;
      await store.saveSessionEntry!({ id, sessionID, type: AGENT_MESSAGE_BOARD_ENTRY_TYPE,
        touchSession: false, time: { created: first, updated: timestamp }, data: state });
      created = first;
    },
  };
}
