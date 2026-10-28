import {
  AGENT_MESSAGE_BOARD_LIMITS as limits, AgentMessageBoardInputSchemas, AgentMessageBoardNotificationSchema, AgentMessageBoardOutputSchemas,
  CoreErrorType, createCoreError,
  type AgentMessageBoardAccess, type AgentMessageBoardCallContext, type AgentMessageBoardConfig, type AgentMessageBoardOwner,
  type AgentMessageBoardOperation, type AgentMessageBoardOutput, type AgentMessageBoardPort, type AgentMessageBoardPostPreview,
  type AgentMessageBoardRemotePort, type AgentMessageBoardStoredState, type MultiAgentIdentity, type MultiAgentV2Config, type SessionStorePort,
} from "@zcode/contracts";
import type { RuntimeTaskRegistry, RuntimeTaskSnapshot } from "../runtime-task/index.js";
import { resolveMultiAgentTarget } from "../multi-agent/index.js";
import { boardFailure, boundedBoardQuery, latestPost, postPreview, requirePost, smallerBoardRead } from "./queries.js";
import { createBoardPersistence, emptyBoard, type BoardPersistence } from "./storage.js";
import { remoteBoardRequest } from "./remote.js";
import { createRemoteBoardLifecycle } from "./remote-lifecycle.js";

export interface CreateAgentMessageBoardOptions {
  config: AgentMessageBoardConfig & Pick<MultiAgentV2Config, "enabled" | "disableNativeTools" | "toolNamespace">;
  rootSessionId: string;
  /** Pass the root owner's registry, not a session-filtered child view. */
  registry: RuntimeTaskRegistry;
  sessionStore?: SessionStorePort;
  /** Existing root graph hydration barrier; board membership never outruns its owner. */
  ready?: Promise<void>;
  now?(identity: MultiAgentIdentity): Date | Promise<Date>;
  remote?: AgentMessageBoardRemotePort;
}

const owners = new WeakMap<RuntimeTaskRegistry, Map<string, AgentMessageBoardOwner>>();
const WRITES = new Set<AgentMessageBoardOperation>(["create_channel", "post", "subscribe", "unsubscribe"]);
type Subscription = AgentMessageBoardStoredState["subscriptions"][number];
interface Notice { task: RuntimeTaskSnapshot; post: AgentMessageBoardPostPreview }
interface Mutation { output: AgentMessageBoardOutput; timestamp: number; notices: Notice[]; changed: boolean }

export function createAgentMessageBoard(options: CreateAgentMessageBoardOptions): AgentMessageBoardOwner | undefined {
  if (!options.config.enabled || !options.config.messageBoardEnabled || options.config.disableNativeTools) return undefined;
  const mode = options.config.messageBoardRemote ? "remote" : options.config.messageBoardInMemory ? "memory" : "local";
  let roots = owners.get(options.registry);
  const previous = roots?.get(options.rootSessionId);
  if (previous) {
    if (previous.mode !== mode) boardFailure("message_board_mode_conflict", "A root cannot use two message-board backends at once");
    return previous;
  }
  if (mode === "remote" && (!options.remote || options.remote.rootSessionId !== options.rootSessionId)) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Remote message-board transport is unavailable for this root", {
      recoverable: false, context: { code: "message_board_remote_unavailable" },
    });
  }
  const board = new RootMessageBoard(options, mode);
  if (!roots) { roots = new Map(); owners.set(options.registry, roots); }
  roots.set(options.rootSessionId, board);
  return board;
}

class RootMessageBoard implements AgentMessageBoardOwner {
  readonly rootSessionId: string;
  private state: AgentMessageBoardStoredState;
  private persistence?: BoardPersistence;
  private ready?: Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private remoteLifecycle?: ReturnType<typeof createRemoteBoardLifecycle>;

  constructor(private readonly options: CreateAgentMessageBoardOptions, readonly mode: "local" | "memory" | "remote") {
    this.rootSessionId = options.rootSessionId;
    this.state = emptyBoard(this.rootSessionId);
    if (mode === "local") this.persistence = createBoardPersistence(this.rootSessionId, options.sessionStore);
    if (mode === "remote") this.remoteLifecycle = createRemoteBoardLifecycle({
      rootSessionId: this.rootSessionId, registry: options.registry, remote: options.remote!, ready: options.ready,
      receive: (notification, context) => this.receiveNotification(notification, context),
    });
  }

  async prepareForTurn(identity: MultiAgentIdentity, context: AgentMessageBoardCallContext): Promise<void> {
    await this.remoteLifecycle?.prepareForTurn(identity, context);
  }

  finishTurn(identity: MultiAgentIdentity, turnId: string): void {
    this.remoteLifecycle?.finishTurn(identity, turnId);
  }

  dispose(): void {
    this.remoteLifecycle?.dispose();
    const roots = owners.get(this.options.registry);
    if (roots?.get(this.rootSessionId) === this) roots.delete(this.rootSessionId);
  }

  forAgent(identity: MultiAgentIdentity, access?: AgentMessageBoardAccess): AgentMessageBoardPort {
    const bound = Object.freeze({ ...identity });
    const connectionAccess = access ? Object.freeze({ ...access }) : undefined;
    if (bound.rootSessionId !== this.rootSessionId) boardFailure("message_board_wrong_root", "Agent belongs to another message-board root");
    return { identity: bound, execute: (operation, input, context) => this.execute(bound, connectionAccess, operation, input, context) };
  }

  private caller(identity: MultiAgentIdentity): RuntimeTaskSnapshot {
    if (identity.rootSessionId !== this.rootSessionId) boardFailure("message_board_wrong_root", "Agent belongs to another message-board root");
    const task = Object.values(this.options.registry.all()).find((item) => item.multiAgent?.rootSessionId === this.rootSessionId && item.multiAgent.agentPath === identity.agentPath);
    if (!task) boardFailure("message_board_unknown_caller", "Caller is not a registered member of this root");
    return task;
  }

  private async clock(identity: MultiAgentIdentity): Promise<Date> {
    const now = await (this.options.now?.(identity) ?? new Date());
    if (!Number.isFinite(now.getTime())) boardFailure("message_board_invalid_clock", "Message-board clock returned an invalid timestamp");
    return now;
  }

  private async loaded(): Promise<void> {
    if (!this.ready) {
      this.ready = this.persistence ? this.persistence.load().then((state) => { this.state = state; }) : Promise.resolve();
      this.ready = this.ready.catch((error: unknown) => { this.ready = undefined; throw error; });
    }
    await this.ready;
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private normalize(identity: MultiAgentIdentity, operation: AgentMessageBoardOperation, rawInput: unknown): Record<string, unknown> {
    const input = AgentMessageBoardInputSchemas[operation].parse(rawInput) as Record<string, unknown>;
    const resolve = (target: string) => resolveMultiAgentTarget(this.options.registry, identity, target).multiAgent!.agentPath;
    if (typeof input.author === "string") input.author = resolve(input.author);
    if (typeof input.target_agent === "string") input.target_agent = resolve(input.target_agent);
    if (Array.isArray(input.agents_to_notify)) input.agents_to_notify = input.agents_to_notify.map((path) => resolve(path as string));
    return input;
  }

  private checkAccess(identity: MultiAgentIdentity, access: AgentMessageBoardAccess | undefined, operation: AgentMessageBoardOperation, input: Record<string, unknown>) {
    const changesOther = (operation === "subscribe" || operation === "unsubscribe") && input.target_agent !== undefined && input.target_agent !== identity.agentPath;
    if (access?.readOnly && (operation === "create_channel" || operation === "post" || changesOther)) {
      throw createCoreError(CoreErrorType.PermissionDenied, "Message-board connection does not permit this action", {
        recoverable: false, context: { code: "permission_denied", action: operation },
      });
    }
  }

  private async executeRemote(identity: MultiAgentIdentity, caller: RuntimeTaskSnapshot, operation: AgentMessageBoardOperation,
    input: Record<string, unknown>, context: AgentMessageBoardCallContext): Promise<{ output: AgentMessageBoardOutput; notices: Notice[] }> {
    this.remoteLifecycle?.syncMembers();
    // The service can replay an already committed post without a fresh clock. It rejects
    // a new post lacking a timestamp; create_channel still requires a valid clock up front.
    const timestamp = operation === "post" ? await this.clock(identity).then((now) => now.toISOString(), () => undefined)
      : operation === "create_channel" ? (await this.clock(identity)).toISOString() : undefined;
    let readInput = input;
    for (;;) {
      if (context.signal?.aborted) throw context.signal.reason ?? new Error("Message-board call cancelled");
      const request = remoteBoardRequest(operation, readInput, caller.agentId, context.requestId, timestamp);
      const output = AgentMessageBoardOutputSchemas[operation].parse(await this.options.remote!.call(request, context));
      if (Buffer.byteLength(JSON.stringify(output)) <= limits.outputBytes) return { output, notices: [] };
      if (WRITES.has(operation)) boardFailure("message_board_output_budget", "Remote board result exceeds the output budget");
      readInput = smallerBoardRead(operation, readInput);
    }
  }

  private async execute(identity: MultiAgentIdentity, access: AgentMessageBoardAccess | undefined, operation: AgentMessageBoardOperation,
    rawInput: unknown, context: AgentMessageBoardCallContext): Promise<AgentMessageBoardOutput> {
    if (this.options.config.disableNativeTools) boardFailure("message_board_disabled", "Native multi-agent tools are disabled");
    const parsedInput = AgentMessageBoardInputSchemas[operation].parse(rawInput);
    const result = await this.serial(async () => {
      if (context.signal?.aborted) throw context.signal.reason ?? new Error("Message-board call cancelled");
      // 身份图冷恢复由现有 graph owner 完成；目标解析不能跑到其 ready barrier 前面。
      await this.options.ready;
      if (context.signal?.aborted) throw context.signal.reason ?? new Error("Message-board call cancelled");
      const caller = this.caller(identity);
      const input = this.normalize(identity, operation, parsedInput);
      this.checkAccess(identity, access, operation, input);
      if (this.mode === "remote") return this.executeRemote(identity, caller, operation, input, context);
      await this.loaded();
      if (!WRITES.has(operation)) {
        const output = boundedBoardQuery(this.state, operation, input, (raw) => {
          if (operation !== "get_channels" || access?.readOnly === undefined) return raw;
          const channels = AgentMessageBoardOutputSchemas.get_channels.parse(raw);
          // 权限元数据也是输出预算的一部分，必须在缩页/生成 cursor 之前计算。
          return { ...channels, board_permissions: { create_channel: !access.readOnly, edit_metadata: !access.readOnly, manage_permissions: false },
            results: channels.results.map((channel) => ({ ...channel, permissions: {
              read: true, post: !access.readOnly, reply: !access.readOnly, edit_metadata: !access.readOnly,
            } })) };
        });
        return { output, notices: [] };
      }
      const next = structuredClone(this.state);
      const mutation = await this.mutate(next, caller, identity, operation, input, context);
      if (mutation.changed) {
        // 保存成功才发布 owner 状态；失败不得出现“帖子可见但持久化失败”的半提交。
        await this.persistence?.save(next, mutation.timestamp);
        this.state = next;
      }
      return mutation;
    });
    await this.deliver(result.notices, context);
    return AgentMessageBoardOutputSchemas[operation].parse(result.output);
  }

  private async mutate(state: AgentMessageBoardStoredState, caller: RuntimeTaskSnapshot, identity: MultiAgentIdentity,
    operation: AgentMessageBoardOperation, input: Record<string, unknown>, context: AgentMessageBoardCallContext): Promise<Mutation> {
    const author = identity.agentPath;
    if (Buffer.byteLength(author) + Buffer.byteLength(String(input.target_agent ?? "")) + 2_048 > limits.outputBytes) {
      boardFailure("message_board_output_budget", "Output budget is too small to acknowledge this mutation");
    }
    if (operation === "create_channel") {
      const args = AgentMessageBoardInputSchemas.create_channel.parse(input);
      const now = await this.clock(identity);
      const channel = this.insertChannel(state, args.channel_name, author, now.toISOString(), args.description);
      if (args.subscribe !== false) this.setSubscription(state, "channel", args.channel_name, author, true, false);
      return { output: channel, timestamp: now.getTime(), notices: [], changed: true };
    }
    if (operation === "subscribe" || operation === "unsubscribe") {
      const args = AgentMessageBoardInputSchemas[operation].parse(input);
      const targetAgent = args.target_agent ?? author;
      const root = args.thread_id ? requirePost(state, args.thread_id, true) : undefined;
      const channelName = root?.metadata.channel_name ?? args.channel_name!;
      const channel = state.channels.find((item) => item.channel_name === channelName);
      if (!channel) boardFailure("message_board_unknown_channel", "Channel not found in this board");
      const last = root ? latestPost(state, state.posts.filter((post) => post.metadata.thread_id === root.metadata.message_id))?.metadata.message_id : channel.last_message_id;
      this.setSubscription(state, root ? "thread" : "channel", args.thread_id ?? channelName, targetAgent, operation === "subscribe", true);
      return { output: { channel_name: channelName, thread_id: args.thread_id ?? null, target_agent: targetAgent,
        enabled: operation === "subscribe", last_message_id: last ?? null }, timestamp: Date.now(), notices: [], changed: true };
    }
    const args = AgentMessageBoardInputSchemas.post.parse(input);
    if (!context.requestId || Buffer.byteLength(context.requestId) > limits.requestIdBytes) boardFailure("message_board_invalid_request_id", "Post request ID must contain 1–512 UTF-8 bytes");
    const fingerprint = JSON.stringify({ ...args, agents_to_notify: args.agents_to_notify ?? [] });
    const existing = state.posts.find((post) => post.callerId === caller.agentId && post.requestId === context.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) boardFailure("message_board_request_conflict", "Request ID was already used for a different post");
      return { output: existing.metadata, timestamp: Date.parse(existing.metadata.created_at), notices: [], changed: false };
    }
    const now = await this.clock(identity);
    const id = crypto.randomUUID();
    const root = args.thread_id ? requirePost(state, args.thread_id, true) : undefined;
    const channelName = root?.metadata.channel_name ?? args.channel_name ?? args.new_channel_name!;
    if (args.new_channel_name !== undefined) {
      this.insertChannel(state, channelName, author, now.toISOString());
      this.setSubscription(state, "channel", channelName, author, true, false);
    }
    const channel = state.channels.find((item) => item.channel_name === channelName);
    if (!channel) boardFailure("message_board_unknown_channel", "Channel not found in this board");
    const targetKind = root ? "thread" : "channel";
    const target = root?.metadata.message_id ?? channelName;
    const paths = new Set(args.agents_to_notify ?? []);
    for (const sub of state.subscriptions) if (sub.kind === targetKind && sub.target === target && sub.enabled) paths.add(sub.agentPath);
    paths.delete(author);
    const metadata = { message_id: id, channel_name: channelName, author, thread_id: root?.metadata.message_id ?? id, created_at: now.toISOString() };
    const post = { metadata, text: args.text, callerId: caller.agentId, requestId: context.requestId, fingerprint };
    state.posts.push(post);
    channel.message_count += 1;
    channel.last_message_id = latestPost(state, state.posts.filter((item) => item.metadata.channel_name === channelName))!.metadata.message_id;
    // 显式退订记录不能被再次发言覆盖；仅第一次发言建立默认 thread 订阅。
    this.setSubscription(state, "thread", metadata.thread_id, author, true, false);
    const preview = postPreview(post, limits.notificationChars);
    const notices = Object.values(this.options.registry.all()).filter((task) => task.multiAgent?.rootSessionId === this.rootSessionId && paths.has(task.multiAgent.agentPath))
      .map((task) => ({ task: { ...task }, post: preview }));
    return { output: metadata, timestamp: now.getTime(), notices, changed: true };
  }

  private insertChannel(state: AgentMessageBoardStoredState, name: string, author: string, timestamp: string, description?: string) {
    if (state.channels.some((item) => item.channel_name === name)) boardFailure("message_board_duplicate_channel", "Channel already exists");
    const channel = { channel_name: name, ...(description === undefined ? {} : { description }), created_at: timestamp,
      created_by: author, message_count: 0, last_message_id: null };
    state.channels.push(channel);
    return channel;
  }

  private setSubscription(state: AgentMessageBoardStoredState, kind: Subscription["kind"], target: string, agentPath: string, enabled: boolean, overwrite: boolean) {
    const existing = state.subscriptions.find((item) => item.kind === kind && item.target === target && item.agentPath === agentPath);
    if (!existing) state.subscriptions.push({ kind, target, agentPath, enabled });
    else if (overwrite) existing.enabled = enabled;
  }

  private async deliver(notices: Notice[], context: AgentMessageBoardCallContext): Promise<void> {
    for (let offset = 0; offset < notices.length; offset += 16) {
      await Promise.all(notices.slice(offset, offset + 16).map(async ({ task, post }) => {
        const current = this.options.registry.get(task.taskId);
        if (!task.turnId || task.status !== "running" || !task.multiAgent?.resident || current?.turnId !== task.turnId || current.status !== "running") return;
        try {
          await current.messageSink?.sendActive?.({ id: `board:${post.message_id}:${task.agentId}:${task.turnId}`,
            message: renderBoardNotification(post), queuedAt: new Date(), traceContext: context.trace }, task.turnId);
        } catch { /* Notification is best effort; the committed post remains readable. No queue/retry fallback. */ }
      }));
    }
  }

  async receiveNotification(raw: unknown, context: AgentMessageBoardCallContext): Promise<boolean> {
    if (this.mode !== "remote") return false;
    const result = AgentMessageBoardNotificationSchema.safeParse(raw);
    if (!result.success) return false;
    const { recipient, turn_id: turnId, post } = result.data;
    const task = Object.values(this.options.registry.all()).find((item) => item.agentId === recipient && item.multiAgent?.rootSessionId === this.rootSessionId);
    if (!task || task.status !== "running" || !task.multiAgent?.resident || task.turnId !== turnId ||
      Buffer.byteLength(post.text_preview + post.author + task.multiAgent.agentPath) > limits.notificationBytes) return false;
    try {
      return await task.messageSink?.sendActive?.({ id: `board:${post.message_id}:${recipient}:${turnId}`, message: renderBoardNotification(post),
        queuedAt: new Date(), traceContext: context.trace }, task.turnId) ?? false;
    } catch { return false; }
  }
}

export function renderBoardNotification(post: AgentMessageBoardPostPreview): string {
  return `Message Type: CHANNEL_POST\nSender: ${post.author}\nChannel: ${post.channel_name}\nMessage ID: ${post.message_id}\nThread ID: ${post.thread_id}\nPayload:\n${post.text_preview}${post.truncated ? "\n[Use read_post for the rest.]" : ""}`;
}
