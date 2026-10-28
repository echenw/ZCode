import {
  AGENT_MESSAGE_BOARD_LIMITS as limits, AgentMessageBoardInputSchemas,
  type AgentMessageBoardOperation, type AgentMessageBoardRemoteRequest,
} from "@zcode/contracts";

export function remoteBoardRequest(operation: AgentMessageBoardOperation, input: unknown, caller: string,
  requestId: string, timestamp?: string): AgentMessageBoardRemoteRequest {
  const args = AgentMessageBoardInputSchemas[operation].parse(input) as Record<string, unknown>;
  const page = { cursor: args.cursor ?? null, limit: Math.min(Number(args.limit ?? limits.pageDefault), limits.pageMax) };
  const direction = args.recent_first === false ? "OldestFirst" : "NewestFirst";
  const maxChars = Math.min(Number(args.max_chars_per_post ?? limits.previewDefault), limits.contentChars);
  const request = (method: AgentMessageBoardRemoteRequest["method"], params: Record<string, unknown>) => ({
    caller, ...(timestamp === undefined ? {} : { timestamp }), method, params,
  });
  switch (operation) {
    case "create_channel": return request(operation, {
      channel_name: args.channel_name, ...(args.description === undefined ? {} : { description: args.description }),
      subscription: args.subscribe === false ? "Unsubscribe" : "Subscribe",
    });
    case "get_channels": return request("list_channels", { query: args.query ?? null, direction, page });
    case "list_threads": return request(operation, { channel_name: args.channel_name, sort: args.sort ?? "created", direction, page, max_chars_per_post: maxChars });
    case "search_posts": return request(operation, { channel_name: args.channel_name ?? null, query: args.query ?? null,
      after_message_id: args.after_message_id ?? null, author: args.author ?? null, page, max_chars_per_post: maxChars });
    case "read_thread": return request(operation, { thread_id: args.thread_id, page, max_chars_per_post: maxChars });
    case "read_post": return request(operation, { message_id: args.message_id, offset_chars: args.offset_chars ?? 0,
      limit_chars: Math.min(Number(args.limit_chars ?? limits.contentChars), limits.contentChars) });
    case "subscribe": case "unsubscribe": return request("set_subscription", {
      target: args.channel_name === undefined ? { Thread: args.thread_id } : { Channel: args.channel_name },
      target_agent: args.target_agent ?? null, change: operation === "subscribe" ? "Subscribe" : "Unsubscribe",
    });
    case "post": return request(operation, { request_id: requestId,
      destination: args.channel_name !== undefined ? { Channel: args.channel_name }
        : args.new_channel_name !== undefined ? { NewChannel: args.new_channel_name } : { Thread: args.thread_id },
      text: args.text, agents_to_notify: args.agents_to_notify ?? [],
    });
  }
}
