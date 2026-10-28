import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_MESSAGE_BOARD_OPERATIONS, AgentMessageBoardInputSchemas, AgentMessageBoardOutputSchemas,
  createSessionId, createTraceId, createTurnId,
  type AgentMessageBoardCallContext, type AgentMessageBoardPort, type AgentMessageBoardRemotePort,
  type AgentMessageBoardPostMetadata, type Logger, type SessionEntryInfo, type SessionStorePort,
} from "@zcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/index.js";
import { createAgentMessageBoard, createAgentMessageBoardToolEntries, type CreateAgentMessageBoardOptions } from "../src/multi-agent-board/index.js";
import type { ToolExecutionContext } from "../src/tool/index.js";
import type { AgentRuntimeConfig, AgentRuntimeDeps } from "../src/runtime/types.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

const ROOT = createSessionId("board-root-session");
const ID = "f59dc83e-bc21-4425-bab5-de69392a1bdb";
const trace = { traceId: createTraceId(), sessionId: ROOT };
let invocation = 0;
const context = (requestId = `turn:call-${++invocation}`): AgentMessageBoardCallContext => ({ requestId, trace });

function registry() {
  const owner = new InMemoryRuntimeTaskRegistry();
  for (const [id, path] of [["root", "/root"], ["child", "/root/child"], ["other", "/root/other"]]) {
    owner.register({ taskId: id!, agentId: id!, agentType: "general-purpose", description: path!, type: "local_agent",
      status: "running", startedAt: new Date(0), turnId: createTurnId(`turn-${id}`),
      multiAgent: { agentPath: path!, rootSessionId: ROOT, resident: true, runGeneration: 1 },
      messageSink: { sendActive: vi.fn(async () => true), send: vi.fn(async () => "queued" as const) } });
  }
  return owner;
}
function storage() {
  const entries = new Map<string, SessionEntryInfo>();
  const saveSessionEntry = vi.fn(async (entry: SessionEntryInfo) => { entries.set(entry.id, structuredClone(entry)); });
  const sessionEntries = vi.fn(async ({ sessionID }: { sessionID: string }) => [...entries.values()].filter((entry) => entry.sessionID === sessionID).map((entry) => structuredClone(entry)));
  return { entries, saveSessionEntry, sessionEntries, port: { saveSessionEntry, sessionEntries } as unknown as SessionStorePort };
}
function setup(overrides: Partial<CreateAgentMessageBoardOptions> = {}) {
  const tasks = overrides.registry ?? registry();
  const options: CreateAgentMessageBoardOptions = { config: { enabled: true, messageBoardEnabled: true, messageBoardInMemory: true },
    registry: tasks, rootSessionId: ROOT, now: () => new Date("2026-10-26T12:00:00.000Z"), ...overrides };
  const owner = createAgentMessageBoard(options)!;
  const root = owner.forAgent({ agentPath: "/root", rootSessionId: ROOT });
  const child = owner.forAgent({ agentPath: "/root/child", rootSessionId: ROOT });
  const other = owner.forAgent({ agentPath: "/root/other", rootSessionId: ROOT });
  return { options, owner, root, child, other, tasks };
}
const call = (port: AgentMessageBoardPort, operation: Parameters<AgentMessageBoardPort["execute"]>[0], input: unknown, ctx = context()) => port.execute(operation, input, ctx);
async function post(port: AgentMessageBoardPort, input: unknown, ctx = context()): Promise<AgentMessageBoardPostMetadata> {
  return AgentMessageBoardOutputSchemas.post.parse(await call(port, "post", input, ctx));
}

describe("optional multi-agent message board", () => {
  it("requires both feature gates and keeps disabled storage unopened", () => {
    const store = storage();
    const base = { rootSessionId: ROOT, registry: registry(), sessionStore: store.port };
    expect(createAgentMessageBoard({ ...base, config: { enabled: true } })).toBeUndefined();
    expect(createAgentMessageBoard({ ...base, config: { messageBoardEnabled: true } })).toBeUndefined();
    expect(createAgentMessageBoard({ ...base, config: { enabled: true, messageBoardEnabled: true, disableNativeTools: true } })).toBeUndefined();
    expect(store.sessionEntries).not.toHaveBeenCalled();
    expect(store.saveSessionEntry).not.toHaveBeenCalled();
    expect(createAgentMessageBoardToolEntries({ enabled: true })).toEqual([]);
    expect(createAgentMessageBoardToolEntries({ enabled: true, messageBoardEnabled: true, disableNativeTools: true })).toEqual([]);
  });

  it("exposes the nine strict discussion schemas with bounded tool contracts", () => {
    const entries = createAgentMessageBoardToolEntries({ enabled: true, messageBoardEnabled: true });
    expect(entries.map((entry) => entry.metadata.name)).toEqual(AGENT_MESSAGE_BOARD_OPERATIONS.map((name) => `collaboration_${name}`));
    expect(entries.every((entry) => entry.inputSchema && entry.outputSchema && entry.permission && entry.timeout && entry.resultBudget)).toBe(true);
    expect(entries.filter((entry) => entry.metadata.readOnly)).toHaveLength(5);
    expect(entries.filter((entry) => entry.metadata.readOnly).every((entry) => entry.metadata.sideEffectScope === "none")).toBe(true);
    expect(createAgentMessageBoardToolEntries({ enabled: true, messageBoardEnabled: true, toolNamespace: "" })[0]?.metadata.name).toBe("create_channel");
    expect(AgentMessageBoardInputSchemas.post.safeParse({ text: "x", channel_name: "a", thread_id: ID }).success).toBe(false);
    expect(AgentMessageBoardInputSchemas.post.safeParse({ text: "x", channel_name: "a", caller: "/root" }).success).toBe(false);
    expect(AgentMessageBoardInputSchemas.subscribe.safeParse({}).success).toBe(false);
    expect(AgentMessageBoardInputSchemas.read_post.safeParse({ message_id: ID, offset_chars: -1 }).success).toBe(false);
  });

  it("binds the invocation id to the actual tool turn", async () => {
    const execute = vi.fn<AgentMessageBoardPort["execute"]>(async () => ({ message_id: ID, thread_id: ID, channel_name: "design", author: "/root", created_at: "2026-10-26T00:00:00Z" }));
    const entry = createAgentMessageBoardToolEntries({ enabled: true, messageBoardEnabled: true }).find((tool) => tool.metadata.name === "collaboration_post")!;
    const turnId = createTurnId("board-invocation");
    const toolContext = { sessionId: ROOT, turnId, toolCallId: "call-7", traceId: trace.traceId,
      abortSignal: new AbortController().signal, subagentPort: { messageBoard: { execute } } } as unknown as ToolExecutionContext;
    await entry.handler({ text: "decision", new_channel_name: "design" }, toolContext);
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ requestId: `${turnId}:call-7` });
  });

  it("shares one root owner across child views and rejects unrelated callers and targets", async () => {
    const fixture = setup();
    expect(createAgentMessageBoard(fixture.options)).toBe(fixture.owner);
    expect(() => fixture.owner.forAgent({ agentPath: "/root", rootSessionId: "different" })).toThrow("another");
    await expect(call(fixture.owner.forAgent({ agentPath: "/root/unknown", rootSessionId: ROOT }), "get_channels", {})).rejects.toThrow("registered");
    await expect(post(fixture.root, { text: "x", new_channel_name: "design", agents_to_notify: ["../outside"] })).rejects.toThrow();
    expect(await call(fixture.child, "get_channels", {})).toMatchObject({ n_returned: 0 });
  });

  it("waits for the existing graph hydration barrier before resolving restored recipients", async () => {
    const tasks = registry();
    const childRecord = tasks.get("child")!;
    tasks.remove("child");
    const hydrated = Promise.withResolvers<void>();
    const { root } = setup({ registry: tasks, ready: hydrated.promise });
    const outcome = post(root, { text: "after hydrate", new_channel_name: "design", agents_to_notify: ["child"] })
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    await Promise.resolve();
    expect(childRecord.messageSink?.sendActive).not.toHaveBeenCalled();
    tasks.register(childRecord);
    hydrated.resolve();
    expect(await outcome).toMatchObject({ value: { channel_name: "design" } });
    expect(tasks.get("child")?.messageSink?.sendActive).toHaveBeenCalledTimes(1);
  });

  it("validates byte limits and exact destinations before any write", async () => {
    const { root } = setup();
    for (const channel_name of ["", " edge", "line\nbreak", "鹈".repeat(43)]) {
      await expect(call(root, "create_channel", { channel_name })).rejects.toThrow();
    }
    await expect(call(root, "create_channel", { channel_name: "design", description: "鹈".repeat(171) })).rejects.toThrow();
    await expect(post(root, { new_channel_name: "design", text: "x".repeat(65_537) })).rejects.toThrow();
    await expect(post(root, { new_channel_name: "design", text: "x", agents_to_notify: Array(257).fill("/root") })).rejects.toThrow();
    expect(await call(root, "get_channels", {})).toMatchObject({ n_returned: 0 });
  });

  it("serializes concurrent writes without losing posts or channel counts", async () => {
    const { root, child } = setup();
    await call(root, "create_channel", { channel_name: "design", description: "Decisions" });
    const metadata = await Promise.all(Array.from({ length: 25 }, (_, index) => post(index % 2 ? child : root, { text: `message-${index}`, channel_name: "design" })));
    expect(new Set(metadata.map((item) => item.message_id)).size).toBe(25);
    expect(await call(root, "get_channels", {})).toMatchObject({ results: [{ message_count: 25 }] });
    expect(await call(child, "search_posts", { channel_name: "design", limit: 50 })).toMatchObject({ n_returned: 25 });
  });

  it("persists local boards and restores posts and subscription opt-outs with a fresh owner", async () => {
    const store = storage();
    const first = setup({ config: { enabled: true, messageBoardEnabled: true }, sessionStore: store.port });
    const rootPost = await post(first.root, { text: "persist me", new_channel_name: "design" });
    await call(first.root, "unsubscribe", { thread_id: rootPost.thread_id });
    const restored = setup({ config: first.options.config, sessionStore: store.port });
    expect(await call(restored.child, "read_post", { message_id: rootPost.message_id })).toMatchObject({ text: "persist me" });
    await post(restored.root, { text: "posting must keep opt-out", thread_id: rootPost.thread_id });
    await post(restored.child, { text: "reply", thread_id: rootPost.thread_id });
    expect(restored.tasks.get("root")?.messageSink?.sendActive).not.toHaveBeenCalled();
    expect(store.entries.size).toBe(1);
    expect([...store.entries.values()][0]?.sessionID).toBe(ROOT);
  });

  it("never loads or saves SessionStore in memory mode", async () => {
    const store = storage();
    const { root } = setup({ sessionStore: store.port });
    await post(root, { text: "volatile", new_channel_name: "design" });
    expect(await call(root, "get_channels", {})).toMatchObject({ n_returned: 1 });
    expect(store.sessionEntries).not.toHaveBeenCalled();
    expect(store.saveSessionEntry).not.toHaveBeenCalled();
    expect(await call(setup({ sessionStore: store.port }).root, "get_channels", {})).toMatchObject({ n_returned: 0 });
  });

  it("rejects missing local storage and malformed restored snapshots explicitly", async () => {
    expect(() => setup({ config: { enabled: true, messageBoardEnabled: true } })).toThrow("SessionStore");
    const store = storage();
    store.entries.set(`message_board:${ROOT}`, { id: `message_board:${ROOT}`, sessionID: ROOT, type: "multi_agent/message_board",
      time: { created: 0, updated: 0 }, data: { version: 1, rootSessionId: "another" } });
    const { root } = setup({ config: { enabled: true, messageBoardEnabled: true }, sessionStore: store.port });
    await expect(call(root, "get_channels", {})).rejects.toThrow("invalid");
    expect(store.saveSessionEntry).not.toHaveBeenCalled();
  });

  it("does not publish or notify a failed durable write and allows a safe retry", async () => {
    const store = storage();
    const { root, child, tasks } = setup({ config: { enabled: true, messageBoardEnabled: true }, sessionStore: store.port });
    await call(root, "create_channel", { channel_name: "design" });
    store.saveSessionEntry.mockRejectedValueOnce(new Error("disk full"));
    const ctx = context("same-request");
    await expect(post(child, { text: "once", channel_name: "design" }, ctx)).rejects.toThrow("disk full");
    expect(await call(root, "search_posts", {})).toMatchObject({ n_returned: 0 });
    expect(tasks.get("root")?.messageSink?.sendActive).not.toHaveBeenCalled();
    await post(child, { text: "once", channel_name: "design" }, ctx);
    expect(tasks.get("root")?.messageSink?.sendActive).toHaveBeenCalledTimes(1);
  });

  it("makes post retries idempotent and rejects a changed payload using the same invocation", async () => {
    const { root, child, tasks } = setup();
    await call(root, "create_channel", { channel_name: "design" });
    const ctx = context("turn:idempotent");
    const first = await post(child, { text: "decision", channel_name: "design" }, ctx);
    expect(await post(child, { text: "decision", channel_name: "design" }, ctx)).toEqual(first);
    await expect(post(child, { text: "different", channel_name: "design" }, ctx)).rejects.toThrow("different post");
    expect(await call(root, "search_posts", {})).toMatchObject({ n_returned: 1 });
    expect(tasks.get("root")?.messageSink?.sendActive).toHaveBeenCalledTimes(1);
    await post(child, { text: "decision", channel_name: "design" }, context("next-turn:idempotent"));
    expect(await call(root, "search_posts", {})).toMatchObject({ n_returned: 2 });
  });

  it("does not create a channel when the configured clock fails", async () => {
    const { root } = setup({ now: () => { throw new Error("clock offline"); } });
    await expect(post(root, { text: "x", new_channel_name: "design" })).rejects.toThrow("clock offline");
    await expect(call(root, "create_channel", { channel_name: "design" })).rejects.toThrow("clock offline");
    expect(await call(root, "get_channels", {})).toMatchObject({ n_returned: 0 });
  });

  it("separates channel root subscriptions from thread replies", async () => {
    const { root, child, other, tasks } = setup();
    await call(root, "create_channel", { channel_name: "design" });
    const initial = await post(child, { text: "root post", channel_name: "design" });
    expect(tasks.get("root")?.messageSink?.sendActive).toHaveBeenCalledTimes(1);
    await post(other, { text: "reply", thread_id: initial.thread_id });
    expect(tasks.get("root")?.messageSink?.sendActive).toHaveBeenCalledTimes(1);
    expect(tasks.get("child")?.messageSink?.sendActive).toHaveBeenCalledTimes(1);
    await call(root, "subscribe", { thread_id: initial.thread_id });
    await post(other, { text: "second reply", thread_id: initial.thread_id });
    expect(tasks.get("root")?.messageSink?.sendActive).toHaveBeenCalledTimes(2);
  });

  it("deduplicates explicit recipients without subscribing them or notifying the author", async () => {
    const { root, child, tasks } = setup();
    await call(root, "create_channel", { channel_name: "design", subscribe: false });
    await post(child, { text: "announcement", channel_name: "design", agents_to_notify: ["/root", "/root", "/root/child"] });
    expect(tasks.get("root")?.messageSink?.sendActive).toHaveBeenCalledTimes(1);
    expect(tasks.get("child")?.messageSink?.sendActive).not.toHaveBeenCalled();
    await post(child, { text: "next", channel_name: "design" });
    expect(tasks.get("root")?.messageSink?.sendActive).toHaveBeenCalledTimes(1);
  });

  it("drops idle notices and keeps Child board activity alive after Main stops", async () => {
    const { root, child, tasks } = setup();
    await call(root, "create_channel", { channel_name: "design" });
    tasks.update("root", (task) => ({ ...task, status: "cancelled" }));
    const metadata = await post(child, { text: "child continued", channel_name: "design" });
    expect(tasks.get("root")?.messageSink?.sendActive).not.toHaveBeenCalled();
    expect(tasks.get("root")?.messageSink?.send).not.toHaveBeenCalled();
    expect(tasks.get("root")?.pendingMessages ?? []).toEqual([]);
    tasks.update("root", (task) => ({ ...task, status: "running", turnId: createTurnId("next-main") }));
    expect(await call(root, "read_post", { message_id: metadata.message_id })).toMatchObject({ text: "child continued" });
    expect(tasks.get("root")?.messageSink?.sendActive).not.toHaveBeenCalled();
  });

  it("does not deliver across a turn rotation while persistence is pending", async () => {
    const store = storage();
    const { root, child, tasks } = setup({ config: { enabled: true, messageBoardEnabled: true }, sessionStore: store.port });
    await call(root, "create_channel", { channel_name: "design" });
    const admitted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    store.saveSessionEntry.mockImplementationOnce(async () => { admitted.resolve(); await release.promise; });
    const pending = post(child, { text: "old turn only", channel_name: "design" });
    await admitted.promise;
    tasks.update("root", (task) => ({ ...task, turnId: createTurnId("new-turn") }));
    release.resolve();
    await pending;
    expect(tasks.get("root")?.messageSink?.sendActive).not.toHaveBeenCalled();
    expect(tasks.get("root")?.messageSink?.send).not.toHaveBeenCalled();
  });

  it("retains committed posts when best-effort notification fails", async () => {
    const { root, child, tasks } = setup();
    await call(root, "create_channel", { channel_name: "design" });
    vi.mocked(tasks.get("root")!.messageSink!.sendActive!).mockRejectedValueOnce(new Error("turn ended"));
    const result = await post(child, { text: "still stored", channel_name: "design" });
    expect(await call(root, "read_post", { message_id: result.message_id })).toMatchObject({ text: "still stored" });
    expect(tasks.get("root")?.messageSink?.send).not.toHaveBeenCalled();
  });

  it("supports Unicode scalar offsets, pagination and thread validation", async () => {
    const { root } = setup();
    const initial = await post(root, { text: "A鹈🚲éZ", new_channel_name: "design" });
    expect(await call(root, "read_post", { message_id: initial.message_id, offset_chars: 1, limit_chars: 2 })).toMatchObject({ text: "鹈🚲", n_chars: 6, next_offset_chars: 3 });
    expect(await call(root, "read_post", { message_id: initial.message_id, offset_chars: 100 })).toMatchObject({ text: "", next_offset_chars: 6 });
    const reply = await post(root, { text: "Straße ﬃ Ꮳ ı", thread_id: initial.thread_id });
    await expect(call(root, "read_thread", { thread_id: reply.message_id })).rejects.toThrow("top-level");
    expect(await call(root, "search_posts", { query: "STRASSE" })).toMatchObject({ n_returned: 1 });
    expect(await call(root, "search_posts", { query: "FFI ꮳ" })).toMatchObject({ n_returned: 1 });
    expect(await call(root, "search_posts", { query: "Ꮳ I" })).toMatchObject({ n_returned: 0 });
    const first = AgentMessageBoardOutputSchemas.search_posts.parse(await call(root, "search_posts", { limit: 1 }));
    expect(first).toMatchObject({ n_returned: 1, has_more: true });
    const second = AgentMessageBoardOutputSchemas.search_posts.parse(await call(root, "search_posts", { limit: 1, cursor: first.next_cursor }));
    expect(second.results[0]?.message_id).toBe(initial.message_id);
    await expect(call(root, "get_channels", { cursor: first.next_cursor })).rejects.toThrow("cursor");
  });

  it("keeps large escaped and multibyte read results within the declared output budget", async () => {
    const { root } = setup();
    await post(root, { text: "\u0000".repeat(20_000), new_channel_name: "design" });
    const found = AgentMessageBoardOutputSchemas.search_posts.parse(await call(root, "search_posts", { max_chars_per_post: 20_000 }));
    expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(64_000);
    expect(found.results[0]?.truncated).toBe(true);
  });

  it("enforces read-only connections while permitting their own subscriptions", async () => {
    const { root, owner } = setup();
    await call(root, "create_channel", { channel_name: "design" });
    const reader = owner.forAgent({ agentPath: "/root/child", rootSessionId: ROOT }, { readOnly: true });
    await expect(post(reader, { text: "forbidden", channel_name: "design" })).rejects.toMatchObject({ type: "permission_denied" });
    await expect(call(reader, "create_channel", { channel_name: "new" })).rejects.toThrow("permit");
    await expect(call(reader, "subscribe", { channel_name: "design", target_agent: "/root" })).rejects.toThrow("permit");
    expect(await call(reader, "subscribe", { channel_name: "design" })).toMatchObject({ enabled: true, target_agent: "/root/child" });
    expect(await call(reader, "get_channels", {})).toMatchObject({ board_permissions: { create_channel: false }, results: [{ permissions: { read: true, post: false } }] });
  });

  it("cancels before admission without writing", async () => {
    const { root } = setup();
    const abort = new AbortController(); abort.abort(new Error("cancelled"));
    await expect(post(root, { text: "no", new_channel_name: "design" }, { ...context(), signal: abort.signal })).rejects.toThrow("cancelled");
    expect(await call(root, "get_channels", {})).toMatchObject({ n_returned: 0 });
  });

  it("includes permission metadata when bounding channel discovery pages", async () => {
    const { root, owner } = setup();
    for (let index = 0; index < 20; index += 1) {
      await call(root, "create_channel", { channel_name: `channel-${index}`, description: "\u0000".repeat(500) });
    }
    const reader = owner.forAgent({ agentPath: "/root/child", rootSessionId: ROOT }, { readOnly: true });
    const output = await call(reader, "get_channels", { limit: 20 });
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(64_000);
    expect(output).toMatchObject({ has_more: true, board_permissions: { create_channel: false } });
  });
});

describe("message-board remote port protocol (injected unit transport only)", () => {
  const remoteConfig = { enabled: true, messageBoardEnabled: true, messageBoardInMemory: true, messageBoardRemote: { url: "https://board.invalid" } };
  const metadata = { message_id: ID, thread_id: ID, author: "/root", channel_name: "design", created_at: "2026-10-26T12:00:00.000Z" };

  it("does not silently fall back to memory or disk when remote is unavailable", () => {
    const store = storage();
    expect(() => setup({ config: remoteConfig, sessionStore: store.port })).toThrow("transport is unavailable");
    expect(() => setup({ config: remoteConfig, remote: { rootSessionId: "other", call: vi.fn() } })).toThrow("transport is unavailable");
    expect(store.sessionEntries).not.toHaveBeenCalled();
  });

  it("translates canonical upstream post requests and validates remote responses", async () => {
    const remote: AgentMessageBoardRemotePort = { rootSessionId: ROOT, call: vi.fn(async () => metadata) };
    const store = storage();
    const { root } = setup({ config: remoteConfig, remote, sessionStore: store.port });
    expect(await post(root, { text: "shared", new_channel_name: "design", agents_to_notify: ["child"] }, context("turn:remote-call"))).toEqual(metadata);
    expect(remote.call).toHaveBeenCalledWith({ caller: "root", timestamp: metadata.created_at, method: "post",
      params: { request_id: "turn:remote-call", destination: { NewChannel: "design" }, text: "shared", agents_to_notify: ["/root/child"] } }, expect.objectContaining({ trace }));
    expect(store.sessionEntries).not.toHaveBeenCalled();
    vi.mocked(remote.call).mockResolvedValueOnce({ untrusted: "wrong response" });
    await expect(call(root, "read_post", { message_id: ID })).rejects.toThrow();
  });

  it("accepts only valid remote notifications for the matching active turn", async () => {
    const { owner, tasks } = setup({ config: remoteConfig, remote: { rootSessionId: ROOT, call: vi.fn() } });
    const activeTurnId = tasks.get("child")!.turnId!;
    const postPreview = { ...metadata, text_preview: "update", n_chars: 6, truncated: false };
    expect(await owner.receiveNotification({ recipient: "child", turn_id: "stale", post: postPreview }, context())).toBe(false);
    expect(await owner.receiveNotification({ recipient: "child", turn_id: activeTurnId, post: { ...postPreview, text_preview: "x".repeat(151) } }, context())).toBe(false);
    expect(await owner.receiveNotification({ recipient: "child", turn_id: activeTurnId, post: { ...postPreview, text_preview: "🚲".repeat(151) } }, context())).toBe(false);
    expect(await owner.receiveNotification({ recipient: "child", turn_id: activeTurnId, post: { ...postPreview, channel_name: "x".repeat(129) } }, context())).toBe(false);
    expect(await owner.receiveNotification({ recipient: "child", turn_id: activeTurnId, post: { ...postPreview, text_preview: "x".repeat(1_025) } }, context())).toBe(false);
    expect(await owner.receiveNotification({ recipient: "child", turn_id: activeTurnId, post: postPreview }, context())).toBe(true);
    expect(tasks.get("child")?.messageSink?.sendActive).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Message Type: CHANNEL_POST\nSender: /root") }), activeTurnId);
    expect(tasks.get("child")?.messageSink?.send).not.toHaveBeenCalled();
  });

  it("shrinks oversized remote text reads without changing offset or replaying writes", async () => {
    const remote: AgentMessageBoardRemotePort = { rootSessionId: ROOT, call: vi.fn(async (request) => {
      const count = Number(request.params.limit_chars);
      return { ...metadata, text: "\u0000".repeat(count), n_chars: 20_000, next_offset_chars: count };
    }) };
    const { root } = setup({ config: remoteConfig, remote });
    const output = await call(root, "read_post", { message_id: ID });
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(64_000);
    expect(remote.call).toHaveBeenCalledTimes(2);
    expect(vi.mocked(remote.call).mock.calls.map(([request]) => request.params)).toEqual([
      { message_id: ID, offset_chars: 0, limit_chars: 20_000 },
      { message_id: ID, offset_chars: 0, limit_chars: 10_000 },
    ]);
    vi.mocked(remote.call).mockClear().mockResolvedValueOnce({ ...metadata, author: "x".repeat(65_000) });
    await expect(post(root, { text: "once", new_channel_name: "design" })).rejects.toThrow("budget");
    expect(remote.call).toHaveBeenCalledTimes(1);
  });

  it("projects members, waits for readiness and keeps child receivers alive after Main Stop", async () => {
    const firstReady = Promise.withResolvers<void>();
    const connections = new Map<string, { close: ReturnType<typeof vi.fn>; receive: (notice: unknown) => Promise<boolean> }>();
    const remote: AgentMessageBoardRemotePort = { rootSessionId: ROOT, call: vi.fn(), setMembers: vi.fn(), dispose: vi.fn(),
      notifications: vi.fn((watch, _context, receive) => {
        const close = vi.fn(); connections.set(watch.caller, { close, receive });
        return { close, ready: watch.caller === "root" ? firstReady.promise : Promise.resolve() };
      }),
    };
    const { owner, tasks } = setup({ config: remoteConfig, remote });
    const turnContext = (id: string) => ({ ...context(), trace: { ...trace, turnId: tasks.get(id)!.turnId! } });
    let prepared = false;
    const preparing = owner.prepareForTurn!({ rootSessionId: ROOT, agentPath: "/root" }, turnContext("root")).then(() => { prepared = true; });
    await vi.waitFor(() => expect(remote.notifications).toHaveBeenCalledTimes(1));
    expect(prepared).toBe(false);
    firstReady.resolve(); await preparing;
    await owner.prepareForTurn!({ rootSessionId: ROOT, agentPath: "/root/child" }, turnContext("child"));
    expect(remote.setMembers).toHaveBeenCalledWith(expect.arrayContaining([
      { agentId: "root", agentPath: "/root" }, { agentId: "child", agentPath: "/root/child" },
    ]));
    tasks.update("root", (task) => ({ ...task, status: "completed" }));
    expect(connections.get("root")!.close).toHaveBeenCalledTimes(1);
    expect(connections.get("child")!.close).not.toHaveBeenCalled();
    const childTurnId = tasks.get("child")!.turnId!;
    const notice = { recipient: "child", turn_id: childTurnId, post: { ...metadata, text_preview: "live", n_chars: 4, truncated: false } };
    expect(await connections.get("child")!.receive(notice)).toBe(true);
    owner.finishTurn!({ rootSessionId: ROOT, agentPath: "/root/child" }, "stale");
    expect(connections.get("child")!.close).not.toHaveBeenCalled();
    owner.finishTurn!({ rootSessionId: ROOT, agentPath: "/root/child" }, childTurnId);
    expect(tasks.get("child")!.status).toBe("running"); // Runner remains the only terminal-state owner.
    expect(connections.get("child")!.close).toHaveBeenCalledTimes(1);
    expect(await connections.get("child")!.receive(notice)).toBe(false);
    owner.dispose!(); owner.dispose!();
    expect(remote.dispose).toHaveBeenCalledTimes(1);
  });

  it("allows the remote service to replay a committed post when the clock is unavailable", async () => {
    const remote: AgentMessageBoardRemotePort = { rootSessionId: ROOT, call: vi.fn(async () => metadata) };
    const { root } = setup({ config: remoteConfig, remote, now: () => { throw new Error("clock unavailable"); } });
    await expect(post(root, { text: "previously committed", channel_name: "design" }, context("same-turn:same-call"))).resolves.toEqual(metadata);
    expect(remote.call).toHaveBeenCalledWith(expect.objectContaining({ method: "post", params: expect.objectContaining({ request_id: "same-turn:same-call" }) }), expect.anything());
    expect(vi.mocked(remote.call).mock.calls[0]![0].timestamp).toBeUndefined();
    await expect(call(root, "create_channel", { channel_name: "new" })).rejects.toThrow("clock unavailable");
    expect(remote.call).toHaveBeenCalledTimes(1);
  });
});

// Production Runtime/ToolScheduler/Runner wiring with an injected local Model.
// This is not an external provider, SQLite process restart or remote HTTP/SSE acceptance test.
describe("message-board production Runtime binding", () => {
  const runtimes: ReturnType<typeof createTestAgentRuntime>[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) runtime.beginShutdown();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });
  function runtimeSetup(config: Partial<AgentRuntimeConfig> = {}, deps: Partial<AgentRuntimeDeps> = {}) {
    const runtime = createTestAgentRuntime(createSessionId(), { mode: "yolo", workingDirectory: ".", modelStreaming: "off",
      compact: { enabled: false }, titleGeneration: { enabled: false },
      multiAgentV2: { enabled: true, messageBoardEnabled: true, messageBoardInMemory: true }, ...config,
    }, { eventStore: createTestSessionEventStore(), ...deps });
    runtimes.push(runtime);
    return { runtime, core: runtime as unknown as AgentRuntimeInternal };
  }

  it("waits for remote receiver startup before inference and closes it at the real turn boundary", async () => {
    const ready = Promise.withResolvers<void>();
    const close = vi.fn();
    const dispose = vi.fn();
    const generateText = vi.fn(async () => ({ text: "done", finishReason: "stop", usage: { totalTokens: 1 } }));
    const sessionId = createSessionId("remote-board-runtime");
    const remote: AgentMessageBoardRemotePort = { rootSessionId: sessionId, call: vi.fn(), setMembers: vi.fn(), dispose,
      notifications: vi.fn(() => ({ ready: ready.promise, close })),
    };
    const runtime = createTestAgentRuntime(sessionId, {
      mode: "yolo", modelStreaming: "off", compact: { enabled: false }, titleGeneration: { enabled: false },
      multiAgentV2: { enabled: true, messageBoardEnabled: true, messageBoardRemote: { url: "https://fixture.invalid" } },
    }, { eventStore: createTestSessionEventStore(), modelFactory: createTestModelFactory({ generateText }), multiAgentMessageBoardRemote: remote });
    runtimes.push(runtime);
    const turn = runtime.executeTurn("test receiver readiness");
    await vi.waitFor(() => expect(remote.notifications).toHaveBeenCalledTimes(1));
    expect(generateText).not.toHaveBeenCalled();
    ready.resolve(); await turn;
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    runtime.beginShutdown();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("registers board tools only when a bound port and both feature gates exist", () => {
    const enabled = runtimeSetup();
    expect(enabled.core.subagentPort?.messageBoard?.identity.agentPath).toBe("/root");
    expect(enabled.runtime.getTools().map((tool) => tool.name)).toEqual(expect.arrayContaining(AGENT_MESSAGE_BOARD_OPERATIONS.map((name) => `collaboration_${name}`)));
    for (const multiAgentV2 of [
      { enabled: true, messageBoardEnabled: false },
      { enabled: false, messageBoardEnabled: true },
      { enabled: true, messageBoardEnabled: true, messageBoardInMemory: true, disableNativeTools: true },
    ]) {
      const { runtime } = runtimeSetup({ multiAgentV2 });
      expect(runtime.getTools().map((tool) => tool.name)).not.toContain("collaboration_post");
    }
  });

  it("keeps native V2 usable and emits a redacted warning when the optional backend is unavailable", async () => {
    const warn = vi.fn();
    const logger: Logger = { debug() {}, info() {}, warn, error() {}, child() { return this; } };
    const { runtime, core } = runtimeSetup({ multiAgentV2: { enabled: true, messageBoardEnabled: true,
      messageBoardRemote: { url: "https://board.invalid", bearerToken: "TEST_VALUE_NOT_FOR_LOGS" } } }, { logger });
    expect(core.subagentPort?.messageBoard).toBeUndefined();
    expect(runtime.getTools().map((tool) => tool.name)).toContain("collaboration_spawn_agent");
    expect(runtime.getTools().map((tool) => tool.name)).not.toContain("collaboration_post");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("initialization failed"), expect.objectContaining({ code: "message_board_initialization_failed" }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("TEST_VALUE_NOT_FOR_LOGS");
    const result = await core.subagentPort!.multiAgent!.execute("list_agents", {}, { sessionId: core.sessionId, parentToolCallId: "host-control",
      to: "", message: "", summary: "", workingDirectory: ".", workspaceRoot: ".", trace: { traceId: createTraceId(), sessionId: core.sessionId } });
    expect(result.agents).toEqual(expect.arrayContaining([expect.objectContaining({ agent_name: "/root" })]));
  });

  it("routes board tools through the existing allowlist and read-only profile restrictions", async () => {
    const restricted = runtimeSetup({ toolAllowlist: ["collaboration_get_channels"] });
    const names = restricted.runtime.getTools().map((tool) => tool.name);
    expect(names).toContain("collaboration_get_channels");
    expect(names).not.toContain("collaboration_post");
    const reader = runtimeSetup({ toolset: "explore" });
    await expect(post(reader.core.subagentPort!.messageBoard!, { text: "forbidden", new_channel_name: "design" })).rejects.toMatchObject({ type: "permission_denied" });
    expect(reader.runtime.getTools().map((tool) => tool.name)).not.toContain("collaboration_post");
  });

  it("runs Root and Child model tool calls against the same board through the real Runtime path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-board-runtime-")); directories.push(directory);
    let rootCalls = 0; let childCalls = 0;
    const childToolNames: string[][] = [];
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const { runtime, core } = runtimeSetup({ workingDirectory: directory, subagents: { outputRootDir: directory } }, {
      sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: createTestModelFactory({ async generateText(request, observation) {
        if (observation.invocationContext?.metadata?.querySource === "subagent") {
          childToolNames.push(request.tools?.map((tool) => tool.name) ?? []);
          if (++childCalls === 1) return { finishReason: "tool-calls", text: "", usage,
            toolCalls: [{ id: "child-post", name: "collaboration_post", input: { channel_name: "design", text: "child shared result" } }] };
          return { finishReason: "stop", text: "child done", usage };
        }
        rootCalls += 1;
        if (rootCalls === 1) return { finishReason: "tool-calls", text: "", usage,
          toolCalls: [{ id: "root-post", name: "collaboration_post", input: { new_channel_name: "design", text: "root shared task" } }] };
        if (rootCalls === 2) return { finishReason: "tool-calls", text: "", usage,
          toolCalls: [{ id: "spawn-writer", name: "collaboration_spawn_agent", input: { task_name: "writer", message: "post the result", fork_turns: "none" } }] };
        return { finishReason: "stop", text: "root done", usage };
      } }),
    });
    await runtime.executeTurn("Create a shared discussion and delegate a reply");
    await vi.waitFor(() => {
      const task = Object.values(core.multiAgentRegistry!.all()).find((item) => item.multiAgent?.agentPath === "/root/writer");
      expect(task?.status).toBe("completed");
    }, { timeout: 15_000, interval: 20 });
    expect(childToolNames[0]).toContain("collaboration_post");
    const found = AgentMessageBoardOutputSchemas.search_posts.parse(await call(core.subagentPort!.messageBoard!, "search_posts", { channel_name: "design" }));
    expect(found.n_returned).toBe(2);
    expect(found.results.map((item) => item.author)).toEqual(expect.arrayContaining(["/root", "/root/writer"]));
    expect(found.results.map((item) => item.text_preview)).toEqual(expect.arrayContaining(["root shared task", "child shared result"]));
  }, 25_000);
});
