import { z } from "zod";

export const AGENT_MESSAGE_BOARD_OPERATIONS = [
  "create_channel", "get_channels", "list_threads", "search_posts", "read_thread",
  "read_post", "subscribe", "unsubscribe", "post",
] as const;
export type AgentMessageBoardOperation = (typeof AGENT_MESSAGE_BOARD_OPERATIONS)[number];
export const AGENT_MESSAGE_BOARD_LIMITS = {
  channelBytes: 128, descriptionBytes: 512, textBytes: 65_536, requestIdBytes: 512,
  recipients: 256, pageDefault: 20, pageMax: 50, previewDefault: 1_000,
  contentChars: 20_000, notificationChars: 150, notificationBytes: 1_024,
  outputBytes: 64_000, timeoutMs: 120_000,
} as const;
const limits = AGENT_MESSAGE_BOARD_LIMITS;
const byteLength = (text: string) => new TextEncoder().encode(text).length;
const positive = z.number().int().min(1).max(0xffff_ffff);
const channel = z.string().refine((value) => value.length > 0 && value.trim() === value &&
  byteLength(value) <= limits.channelBytes && !/[\p{Cc}]/u.test(value),
"Channel names must contain 1–128 UTF-8 bytes without edge whitespace or control characters");
const description = z.string().refine((value) => byteLength(value) <= limits.descriptionBytes,
  "Channel descriptions must contain at most 512 UTF-8 bytes");
const page = { limit: positive.optional(), cursor: z.string().optional() };
const previewPage = { ...page, max_chars_per_post: positive.optional() };
const subscription = z.object({ channel_name: channel.optional(), thread_id: z.string().uuid().optional(), target_agent: z.string().optional() }).strict()
  .refine((input) => Number(input.channel_name !== undefined) + Number(input.thread_id !== undefined) === 1,
    "Supply exactly one of channel_name or thread_id");

export const AgentMessageBoardInputSchemas = {
  create_channel: z.object({ channel_name: channel, description: description.optional(), subscribe: z.boolean().optional() }).strict(),
  get_channels: z.object({ query: z.string().optional(), recent_first: z.boolean().optional(), ...page }).strict(),
  list_threads: z.object({ channel_name: channel, sort: z.enum(["created", "activity"]).optional(), recent_first: z.boolean().optional(), ...previewPage }).strict(),
  search_posts: z.object({ channel_name: channel.optional(), query: z.string().optional(), after_message_id: z.string().uuid().optional(), author: z.string().optional(), ...previewPage }).strict(),
  read_thread: z.object({ thread_id: z.string().uuid(), ...previewPage }).strict(),
  read_post: z.object({ message_id: z.string().uuid(), offset_chars: z.number().int().min(0).max(0xffff_ffff).optional(), limit_chars: positive.optional() }).strict(),
  subscribe: subscription,
  unsubscribe: subscription,
  post: z.object({
    text: z.string().min(1).refine((value) => byteLength(value) <= limits.textBytes, "Post text exceeds 64 KiB"),
    channel_name: channel.optional(), new_channel_name: channel.optional(), thread_id: z.string().uuid().optional(),
    agents_to_notify: z.array(z.string()).max(limits.recipients).optional(),
  }).strict().refine((input) => [input.channel_name, input.new_channel_name, input.thread_id].filter((value) => value !== undefined).length === 1,
    "Supply exactly one of channel_name, new_channel_name or thread_id"),
};
export type AgentMessageBoardPostInput = z.infer<typeof AgentMessageBoardInputSchemas.post>;
export type AgentMessageBoardSubscriptionInput = z.infer<typeof subscription>;

const timestamp = z.string().datetime({ offset: true });
export const AgentMessageBoardPostMetadataSchema = z.object({
  message_id: z.string().uuid(), channel_name: channel, author: z.string(), thread_id: z.string().uuid(), created_at: timestamp,
}).strict();
export const AgentMessageBoardPostPreviewSchema = AgentMessageBoardPostMetadataSchema.extend({
  text_preview: z.string(), n_chars: z.number().int().nonnegative(), truncated: z.boolean(),
});
const channelPermissions = z.object({ read: z.boolean(), post: z.boolean(), reply: z.boolean(), edit_metadata: z.boolean() }).strict();
const boardPermissions = z.object({ create_channel: z.boolean(), edit_metadata: z.boolean(), manage_permissions: z.boolean() }).strict();
export const AgentMessageBoardChannelSchema = z.object({
  channel_name: channel, description: description.optional(), created_at: timestamp, created_by: z.string(),
  message_count: z.number().int().nonnegative(), last_message_id: z.string().uuid().nullable(), permissions: channelPermissions.optional(),
}).strict();
export const AgentMessageBoardThreadSchema = z.object({
  thread_id: z.string().uuid(), root_post: AgentMessageBoardPostPreviewSchema, reply_count: z.number().int().nonnegative(),
  last_activity_at: timestamp, latest_reply: AgentMessageBoardPostPreviewSchema.nullable(),
}).strict();
const pageOf = <T extends z.ZodTypeAny>(item: T) => z.object({
  results: z.array(item), n_returned: z.number().int().nonnegative(), has_more: z.boolean(), next_cursor: z.string().nullable(),
}).strict();
export const AgentMessageBoardSubscriptionSchema = z.object({
  channel_name: z.string(), thread_id: z.string().uuid().nullable(), target_agent: z.string(), enabled: z.boolean(), last_message_id: z.string().uuid().nullable(),
}).strict();
export const AgentMessageBoardOutputSchemas = {
  create_channel: AgentMessageBoardChannelSchema,
  get_channels: pageOf(AgentMessageBoardChannelSchema).extend({ board_permissions: boardPermissions.optional() }),
  list_threads: pageOf(AgentMessageBoardThreadSchema),
  search_posts: pageOf(AgentMessageBoardPostPreviewSchema),
  read_thread: pageOf(AgentMessageBoardPostPreviewSchema).extend({ root_post: AgentMessageBoardPostPreviewSchema }),
  read_post: AgentMessageBoardPostMetadataSchema.extend({ text: z.string(), n_chars: z.number().int().nonnegative(), next_offset_chars: z.number().int().nonnegative() }),
  subscribe: AgentMessageBoardSubscriptionSchema,
  unsubscribe: AgentMessageBoardSubscriptionSchema,
  post: AgentMessageBoardPostMetadataSchema,
};
export type AgentMessageBoardOutput = z.infer<(typeof AgentMessageBoardOutputSchemas)[AgentMessageBoardOperation]>;
export type AgentMessageBoardPostMetadata = z.infer<typeof AgentMessageBoardPostMetadataSchema>;
export type AgentMessageBoardPostPreview = z.infer<typeof AgentMessageBoardPostPreviewSchema>;
export type AgentMessageBoardChannel = z.infer<typeof AgentMessageBoardChannelSchema>;
export const AgentMessageBoardNotificationSchema = z.object({
  recipient: z.string(), turn_id: z.string(), post: AgentMessageBoardPostPreviewSchema.extend({
    text_preview: z.string().refine((text) => Array.from(text).length <= limits.notificationChars, "Notification preview exceeds 150 Unicode characters"),
  }),
}).strict();

export const AgentMessageBoardStoredStateSchema = z.object({
  version: z.literal(1), rootSessionId: z.string(),
  channels: z.array(AgentMessageBoardChannelSchema),
  posts: z.array(z.object({
    metadata: AgentMessageBoardPostMetadataSchema, text: z.string(), callerId: z.string(), requestId: z.string(), fingerprint: z.string(),
  }).strict()),
  subscriptions: z.array(z.object({ kind: z.enum(["channel", "thread"]), target: z.string(), agentPath: z.string(), enabled: z.boolean() }).strict()),
}).strict();
export type AgentMessageBoardStoredState = z.infer<typeof AgentMessageBoardStoredStateSchema>;
