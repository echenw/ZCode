import {
  AGENT_MESSAGE_BOARD_LIMITS as limits, AgentMessageBoardInputSchemas, CoreErrorType, createCoreError,
  type AgentMessageBoardOperation, type AgentMessageBoardOutput, type AgentMessageBoardPostMetadata,
  type AgentMessageBoardPostPreview, type AgentMessageBoardStoredState,
} from "@zcode/contracts";

export type BoardPost = AgentMessageBoardStoredState["posts"][number];
export function boardFailure(code: string, message: string): never {
  throw createCoreError(CoreErrorType.ToolExecutionFailed, message, { recoverable: true, context: { code } });
}
export function requirePost(state: AgentMessageBoardStoredState, id: string, root = false): BoardPost {
  const post = state.posts.find((item) => item.metadata.message_id === id);
  if (!post) boardFailure("message_board_unknown_post", "Post not found in this board");
  if (root && post.metadata.thread_id !== id) boardFailure("message_board_invalid_thread", "thread_id must identify a top-level post");
  return post;
}
export function postPreview(post: BoardPost, maxChars: number): AgentMessageBoardPostPreview {
  const chars = Array.from(post.text);
  return { ...post.metadata, text_preview: chars.slice(0, maxChars).join(""), n_chars: chars.length, truncated: chars.length > maxChars };
}
function comparePosts(state: AgentMessageBoardStoredState, left: BoardPost, right: BoardPost): number {
  return Date.parse(left.metadata.created_at) - Date.parse(right.metadata.created_at) || state.posts.indexOf(left) - state.posts.indexOf(right);
}
export function latestPost(state: AgentMessageBoardStoredState, posts: BoardPost[]): BoardPost | undefined {
  return [...posts].sort((a, b) => comparePosts(state, b, a))[0];
}
function fold(value: string): string {
  // 上游使用 Unicode default case folding；仅 lowerCase 会漏掉连字、sharp-s 和 final sigma。
  // 按字符展开大小写，保留无点 i；Cherokee 的规范 fold 使用大写。
  return Array.from(value, (character) => character === "ı" ? character
    : /\p{Script=Cherokee}/u.test(character) ? character.toUpperCase()
      : character.toUpperCase().toLowerCase().replace(/ß/g, "ss")).join("");
}
function compareText(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}
interface PageRequest { cursor?: string; limit?: number }
function page<T>(items: T[], request: PageRequest, queryKey: string) {
  let offset = 0;
  if (request.cursor !== undefined) {
    try {
      const value: unknown = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
      if (!value || typeof value !== "object" || !("offset" in value) || !("key" in value) ||
        value.key !== queryKey || typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error("Invalid cursor");
      offset = value.offset;
    } catch { boardFailure("message_board_invalid_cursor", "Invalid cursor for this query"); }
  }
  const limit = Math.min(request.limit ?? limits.pageDefault, limits.pageMax);
  const results = items.slice(offset, offset + limit);
  const next = offset + results.length;
  const hasMore = next < items.length;
  return { results, n_returned: results.length, has_more: hasMore,
    next_cursor: hasMore ? Buffer.from(JSON.stringify({ offset: next, key: queryKey })).toString("base64url") : null };
}
const metadataTime = (post: AgentMessageBoardPostMetadata) => Date.parse(post.created_at);

export function queryBoard(state: AgentMessageBoardStoredState, operation: AgentMessageBoardOperation, input: unknown): AgentMessageBoardOutput {
  if (operation === "get_channels") {
    const args = AgentMessageBoardInputSchemas.get_channels.parse(input);
    const rows = state.channels.filter((item) => fold(item.channel_name).includes(fold(args.query ?? "")));
    const activity = (channel: typeof rows[number]) => channel.last_message_id
      ? metadataTime(requirePost(state, channel.last_message_id).metadata) : Date.parse(channel.created_at);
    rows.sort((a, b) => activity(a) - activity(b) || compareText(a.channel_name, b.channel_name));
    if (args.recent_first !== false) rows.reverse();
    return page(rows, args, JSON.stringify([operation, args.query ?? "", args.recent_first !== false]));
  }
  if (operation === "read_post") {
    const args = AgentMessageBoardInputSchemas.read_post.parse(input);
    const post = requirePost(state, args.message_id);
    const chars = Array.from(post.text);
    const offset = Math.min(args.offset_chars ?? 0, chars.length);
    const text = chars.slice(offset, offset + Math.min(args.limit_chars ?? limits.contentChars, limits.contentChars));
    return { ...post.metadata, text: text.join(""), n_chars: chars.length, next_offset_chars: offset + text.length };
  }
  if (operation === "search_posts") {
    const args = AgentMessageBoardInputSchemas.search_posts.parse(input);
    const after = args.after_message_id ? requirePost(state, args.after_message_id) : undefined;
    const rows = state.posts.filter((post) => (args.channel_name === undefined || post.metadata.channel_name === args.channel_name) &&
      (args.author === undefined || args.author === post.metadata.author) && (args.query === undefined || fold(post.text).includes(fold(args.query))) &&
      (!after || comparePosts(state, post, after) > 0)).sort((a, b) => comparePosts(state, b, a));
    const selected = page(rows, args, JSON.stringify([operation, args.channel_name, args.author, args.query, args.after_message_id]));
    const chars = Math.min(args.max_chars_per_post ?? limits.previewDefault, Math.floor(limits.contentChars / Math.max(selected.n_returned, 1)));
    return { ...selected, results: selected.results.map((post) => postPreview(post, chars)) };
  }
  if (operation === "read_thread") {
    const args = AgentMessageBoardInputSchemas.read_thread.parse(input);
    const root = requirePost(state, args.thread_id, true);
    const rows = state.posts.filter((post) => post.metadata.thread_id === args.thread_id && post !== root).sort((a, b) => comparePosts(state, b, a));
    const selected = page(rows, args, JSON.stringify([operation, args.thread_id]));
    const chars = Math.min(args.max_chars_per_post ?? limits.previewDefault, Math.floor(limits.contentChars / (selected.n_returned + 1)));
    return { ...selected, root_post: postPreview(root, chars), results: selected.results.map((post) => postPreview(post, chars)) };
  }
  if (operation === "list_threads") {
    const args = AgentMessageBoardInputSchemas.list_threads.parse(input);
    if (!state.channels.some((item) => item.channel_name === args.channel_name)) boardFailure("message_board_unknown_channel", "Channel not found in this board");
    const roots = state.posts.filter((post) => post.metadata.channel_name === args.channel_name && post.metadata.thread_id === post.metadata.message_id);
    const records = roots.map((root) => {
      const replies = state.posts.filter((post) => post.metadata.thread_id === root.metadata.message_id && post !== root);
      const latest = latestPost(state, replies);
      const activity = Math.max(metadataTime(root.metadata), latest ? metadataTime(latest.metadata) : 0);
      return { root, replies, latest, activity };
    });
    records.sort((a, b) => args.sort === "activity"
      ? a.activity - b.activity || state.posts.indexOf(a.root) - state.posts.indexOf(b.root)
      : comparePosts(state, a.root, b.root));
    if (args.recent_first !== false) records.reverse();
    const selected = page(records, args, JSON.stringify([operation, args.channel_name, args.sort ?? "created", args.recent_first !== false]));
    const chars = Math.min(args.max_chars_per_post ?? limits.previewDefault, Math.floor(limits.contentChars / (2 * Math.max(selected.n_returned, 1))));
    return { ...selected, results: selected.results.map((item) => ({ thread_id: item.root.metadata.message_id,
      root_post: postPreview(item.root, chars), reply_count: item.replies.length, last_activity_at: new Date(item.activity).toISOString(),
      latest_reply: item.latest ? postPreview(item.latest, chars) : null })) };
  }
  return boardFailure("message_board_invalid_operation", "This operation is not a message-board read");
}

export function boundedBoardQuery(state: AgentMessageBoardStoredState, operation: AgentMessageBoardOperation, input: unknown,
  project: (output: AgentMessageBoardOutput) => AgentMessageBoardOutput = (output) => output): AgentMessageBoardOutput {
  let args = { ...(input as Record<string, unknown>) };
  for (;;) {
    const result = project(queryBoard(state, operation, args));
    if (Buffer.byteLength(JSON.stringify(result), "utf8") <= limits.outputBytes) return result;
    args = smallerBoardRead(operation, args);
  }
}

export function smallerBoardRead(operation: AgentMessageBoardOperation, input: Record<string, unknown>): Record<string, unknown> {
  const args = { ...input };
  // JSON 转义/多字节文本可能超预算；local/remote 只重发缩页后的只读请求，保留同一 cursor/filter。
  if (operation === "read_post") args.limit_chars = Math.max(1, Math.floor(Math.min(Number(args.limit_chars ?? limits.contentChars), limits.contentChars) / 2));
  else {
    args.limit = Math.max(1, Math.floor(Math.min(Number(args.limit ?? limits.pageDefault), limits.pageMax) / 2));
    if (operation !== "get_channels") args.max_chars_per_post = Math.max(1, Math.floor(Math.min(Number(args.max_chars_per_post ?? limits.previewDefault), limits.contentChars) / 2));
  }
  if (JSON.stringify(args) === JSON.stringify(input)) boardFailure("message_board_output_budget", "Message-board metadata exceeds the output budget");
  return args;
}
