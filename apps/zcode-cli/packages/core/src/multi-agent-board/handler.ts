import {
  AGENT_MESSAGE_BOARD_LIMITS as limits, AGENT_MESSAGE_BOARD_OPERATIONS, AgentMessageBoardInputSchemas, AgentMessageBoardOutputSchemas,
  CoreErrorType, createCoreError, multiAgentToolName, toToolJsonSchema,
  type AgentMessageBoardConfig, type AgentMessageBoardOperation, type MultiAgentV2Config,
} from "@zcode/contracts";
import type { ToolEntry } from "../tool/index.js";

const DESCRIPTIONS: Record<AgentMessageBoardOperation, string> = {
  create_channel: "Create a shared channel. channel_name is unique in this root tree. Optional description is at most 512 UTF-8 bytes. subscribe defaults to true for future top-level posts.",
  get_channels: "List shared channels by activity, newest first by default. query matches a case-insensitive part of a channel name. Use next_cursor with the same filters to continue.",
  list_threads: "List a channel's threads with first-post and latest-reply previews. sort is created by default or activity; recent_first defaults to true. Read full text with read_post.",
  search_posts: "Search shared top-level posts and replies newest first. Text queries are case-insensitive substrings. Optionally filter channel, author path or posts after a message ID. Results are previews.",
  read_thread: "Read a discussion using the first post's message ID as thread_id. Each page includes the root preview and newest replies; cursor advances through replies.",
  read_post: "Read full text by message_id. offset_chars and limit_chars count Unicode characters; continue from next_offset_chars while it is less than n_chars.",
  subscribe: "Subscribe yourself or target_agent to one channel's top-level posts or one thread's replies. Give exactly one of channel_name or thread_id. Notifications only reach a currently running turn; missed notices are not saved.",
  unsubscribe: "Unsubscribe yourself or target_agent from a channel or thread. Give exactly one destination. Posting again preserves an explicit thread unsubscribe. Explicit agents_to_notify can still send a one-time notice.",
  post: "Start a thread in channel_name or new_channel_name, or reply to thread_id; give exactly one destination and nonempty text. Posts auto-subscribe their author to the thread unless explicitly opted out. agents_to_notify sends one-time notices without subscribing or starting idle agents. Returns metadata, not evidence of reading.",
};
const MUTATIONS = new Set<AgentMessageBoardOperation>(["create_channel", "subscribe", "unsubscribe", "post"]);

export function createAgentMessageBoardToolEntries(config: AgentMessageBoardConfig & Pick<MultiAgentV2Config, "enabled" | "disableNativeTools" | "toolNamespace">): ToolEntry[] {
  if (!config.enabled || !config.messageBoardEnabled || config.disableNativeTools) return [];
  return AGENT_MESSAGE_BOARD_OPERATIONS.map((operation) => {
    const name = multiAgentToolName(operation, config.toolNamespace ?? "collaboration");
    const inputSchema = AgentMessageBoardInputSchemas[operation];
    const outputSchema = AgentMessageBoardOutputSchemas[operation];
    const readOnly = !MUTATIONS.has(operation);
    return {
      capability: DESCRIPTIONS[operation],
      metadata: { name, description: DESCRIPTIONS[operation], readOnly, destructive: false, concurrentSafe: true,
        shouldDefer: false, alwaysLoad: true, allowedInPlanMode: readOnly, timeoutMs: limits.timeoutMs, maxOutputBytes: limits.outputBytes,
        sideEffectScope: readOnly ? "none" : "session", riskLevel: "low", needsApproval: false },
      inputSchema: toToolJsonSchema(inputSchema), outputSchema: toToolJsonSchema(outputSchema),
      runtimeInputSchema: inputSchema, runtimeOutputSchema: outputSchema,
      handler: async (input, context) => {
        const port = context.subagentPort?.messageBoard;
        if (!port) throw createCoreError(CoreErrorType.ConfigurationError, "Message-board port is unavailable", {
          recoverable: false, context: { code: "message_board_unavailable" },
        });
        return port.execute(operation, inputSchema.parse(input), {
          requestId: `${context.turnId ?? context.sessionId}:${context.toolCallId}`,
          trace: context.traceContext ?? { traceId: context.traceId, spanId: context.spanId, sessionId: context.sessionId, turnId: context.turnId },
          signal: context.abortSignal,
        });
      },
      formatModelContent: (output) => JSON.stringify(outputSchema.parse(output)),
      permission: { permission: `agent.board.${operation}`, reason: DESCRIPTIONS[operation], riskLevel: "low", sideEffectScope: readOnly ? "none" : "session", needsApproval: false,
        patternSources: ["toolName", "input"], alwaysAllowPatternSources: ["toolName"], denyPriority: "beforeAsk" },
      resultBudget: { maxInlineBytes: limits.outputBytes, maxModelBytes: limits.outputBytes, strategy: "truncate", preview: { maxBytes: limits.outputBytes, direction: "head" } },
      timeout: { defaultMs: limits.timeoutMs, maxMs: limits.timeoutMs, allowCallOverride: false },
      cancellation: { supported: true, cleanup: "none", userVisibleMessage: "An accepted post remains on the shared board; notices do not start idle agents." },
      trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
    } satisfies ToolEntry;
  });
}
