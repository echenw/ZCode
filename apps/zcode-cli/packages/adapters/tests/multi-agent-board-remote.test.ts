import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRootTraceContext, type AgentMessageBoardRemotePort } from "@zcode/contracts";
import { createNodeRemoteAgentMessageBoard } from "../src/multi-agent-board/index.js";
import { boardWireId } from "../src/multi-agent-board/identity.js";
import { BOARD_MAX_BODY, BOARD_MAX_RESPONSE } from "../src/multi-agent-board/http.js";
import { readBoardSse } from "../src/multi-agent-board/sse.js";

const ROOT = "sess_remote-board-root";
const ADMIN = "fixture-administrator-credential-32-characters";
const SESSION = "fixture-runtime-session-credential-32-characters";
const POST_ID = "7b5e9c20-d558-4b10-bd7b-9938edbbf3b7";
const context = { requestId: "turn:call", trace: createRootTraceContext() };
const request = { caller: "root-agent", method: "list_channels" as const,
  params: { query: null, direction: "NewestFirst", page: { cursor: null, limit: 20 } } };
const metadata = { message_id: POST_ID, thread_id: POST_ID, channel_name: "results", author: "/root/child", created_at: "2026-10-26T12:00:00Z" };
const adapters: AgentMessageBoardRemotePort[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.dispose?.();
  for (const server of servers.splice(0)) {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
});
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
async function serve(handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void | Promise<void>) {
  const server = http.createServer((incoming, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      await handler(incoming, response, text ? JSON.parse(text) as Record<string, unknown> : {});
    })().catch(() => { if (!response.headersSent) json(response, 500, { code: "fixture_error" }); else response.destroy(); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/prefix`;
}
function provision(incoming: IncomingMessage, response: ServerResponse) {
  if (incoming.method === "PUT") { json(response, 200, boardWireId(ROOT)); return true; }
  if (incoming.url?.endsWith("/members")) { json(response, 200, SESSION); return true; }
  return false;
}
function client(url: string, extra: Partial<Parameters<typeof createNodeRemoteAgentMessageBoard>[0]> = {}) {
  const adapter = createNodeRemoteAgentMessageBoard({ rootSessionId: ROOT, config: { url, bearerToken: ADMIN }, env: {}, ...extra });
  adapter.setMembers!([{ agentId: "root-agent", agentPath: "/root" }, { agentId: "child-agent", agentPath: "/root/child" }]);
  adapters.push(adapter);
  return adapter;
}

// These use actual loopback HTTP/SSE sockets. They do not claim a deployed remote service.
describe("remote message-board Host transport", () => {
  it("validates endpoints and credentials before networking and resolves an explicit environment credential", () => {
    for (const url of ["not a url", "file:///tmp/board", "https://board.test/?q=x", "https://board.test/#fragment", "https://user:secret@board.test"]) {
      expect(() => client(url)).toThrow();
    }
    for (const bearerToken of ["short", "x".repeat(4097), `${"x".repeat(32)}\n`]) {
      expect(() => client("https://board.test", { config: { url: "https://board.test", bearerToken } })).toThrow();
    }
    const adapter = client("https://board.test", { config: { url: "https://board.test", bearerTokenEnvVar: "BOARD_TEST_TOKEN" }, env: { BOARD_TEST_TOKEN: ADMIN } });
    expect(JSON.stringify(adapter)).not.toContain(ADMIN);
    expect(boardWireId(ROOT)).toBe(boardWireId(ROOT));
    expect(boardWireId(ROOT, "root-agent")).not.toBe(boardWireId(ROOT, "child-agent"));
  });

  it("provisions once, registers UUID members, uses the session credential and preserves invocation IDs without write replay", async () => {
    const received: Array<{ method: string; path: string; authorization?: string; body: Record<string, unknown> }> = [];
    let postCalls = 0;
    const url = await serve((incoming, response, body) => {
      received.push({ method: incoming.method!, path: incoming.url!, authorization: incoming.headers.authorization, body });
      if (provision(incoming, response)) return;
      if (body.method === "post") { postCalls++; json(response, 503, { code: "unavailable", message: `do not expose ${ADMIN}` }); }
      else json(response, 200, { results: [], n_returned: 0, has_more: false, next_cursor: null });
    });
    const adapter = client(url);
    await adapter.call(request, context);
    await adapter.call(request, context);
    expect(received.map((item) => item.method)).toEqual(["PUT", "POST", "POST", "POST"]);
    expect(received[0]).toMatchObject({ path: `/prefix/v1/boards/${boardWireId(ROOT)}`, authorization: `Bearer ${ADMIN}` });
    expect(received[1]?.body).toEqual({ members: { [boardWireId(ROOT, "child-agent")]: "/root/child", [boardWireId(ROOT, "root-agent")]: "/root" } });
    expect(received[2]).toMatchObject({ authorization: `Bearer ${SESSION}`, body: { caller: boardWireId(ROOT, "root-agent"), timestamp: null, method: "list_channels" } });
    const post = { caller: "root-agent", method: "post" as const, timestamp: "2026-10-26T12:00:00Z",
      params: { request_id: context.requestId, destination: { NewChannel: "results" }, text: "write once", agents_to_notify: [] } };
    await expect(adapter.call(post, context)).rejects.toThrow("HTTP 503");
    expect(postCalls).toBe(1);
    expect(received.at(-1)?.body).toMatchObject({ timestamp: post.timestamp, params: { request_id: "turn:call", text: "write once" } });
    adapter.setMembers!([{ agentId: "root-agent", agentPath: "/root" }, { agentId: "new-agent", agentPath: "/root/new" }]);
    await adapter.call(request, context);
    expect(received.filter((item) => item.path.endsWith("/members"))).toHaveLength(2);
    expect(received.filter((item) => item.method === "PUT")).toHaveLength(1);
  });

  it("preserves structured remote permission denial while redacting both credentials", async () => {
    const url = await serve((incoming, response) => {
      if (provision(incoming, response)) return;
      json(response, 403, { code: "permission_denied", message: ADMIN, action: "post", resource: `channel:${ADMIN}:${SESSION}` });
    });
    const error = await client(url).call(request, context).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ context: { code: "permission_denied", action: "post", resource: "channel:[REDACTED]:[REDACTED]" } });
    expect(JSON.stringify(error)).not.toContain(ADMIN);
    expect(JSON.stringify(error)).not.toContain(SESSION);
  });

  it("bounds outgoing bodies and incoming JSON before exposing an oversized response", async () => {
    let calls = 0;
    const url = await serve((incoming, response) => {
      if (provision(incoming, response)) return;
      calls++; json(response, 200, "x".repeat(BOARD_MAX_RESPONSE));
    });
    const adapter = client(url);
    await expect(adapter.call({ ...request, params: { text: "x".repeat(BOARD_MAX_BODY) } }, context)).rejects.toMatchObject({ context: { code: "message_board_request_too_large" } });
    expect(calls).toBe(0);
    await expect(adapter.call(request, context)).rejects.toMatchObject({ context: { code: "message_board_response_too_large" } });
    expect(calls).toBe(1);
  });

  it("waits for ready, parses split CRLF/UTF-8, skips invalid notices and closes the exact active receiver", async () => {
    const disconnected = Promise.withResolvers<void>();
    const received = Promise.withResolvers<unknown>();
    const frames: Record<string, unknown>[] = [];
    const preview = { ...metadata, text_preview: "🚲".repeat(150), n_chars: 150, truncated: false };
    const url = await serve((incoming, response, body) => {
      if (provision(incoming, response)) return;
      frames.push({ ...body, lastEventId: incoming.headers["last-event-id"], authorization: incoming.headers.authorization });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.on("close", () => disconnected.resolve());
      response.write("event: ready\r"); response.write("\ndata: {}\r\n\r"); response.write("\n");
      const write = (notice: unknown) => response.write(`event: notification\ndata: ${JSON.stringify(notice)}\n\n`);
      response.write("event: notification\ndata: not-json\n\n");
      write({ recipient: "wrong", turn_id: "turn-live", post: preview });
      write({ recipient: body.caller, turn_id: "old-turn", post: preview });
      write({ recipient: body.caller, turn_id: "turn-live", post: { ...preview, text_preview: "🚲".repeat(151) } });
      const valid = Buffer.from(`event: notification\ndata: ${JSON.stringify({ recipient: body.caller, turn_id: "turn-live", post: preview })}\n\n`);
      const split = valid.indexOf(Buffer.from("🚲")) + 2;
      response.write(valid.subarray(0, split)); response.write(valid.subarray(split));
    });
    const adapter = client(url);
    const receive = vi.fn(async (notification: unknown) => { received.resolve(notification); return true; });
    const receiver = adapter.notifications!({ caller: "root-agent", turnId: "turn-live" }, context, receive);
    await receiver.ready;
    expect(await received.promise).toEqual({ recipient: "root-agent", turn_id: "turn-live", post: preview });
    expect(receive).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([{ caller: boardWireId(ROOT, "root-agent"), turn_id: "turn-live", lastEventId: undefined, authorization: `Bearer ${SESSION}` }]);
    receiver.close();
    await disconnected.promise;
  });

  it("reconnects only the live turn without replay headers and cancels reconnect on close", async () => {
    const receive = vi.fn(async () => true);
    const watches: Array<{ turn: unknown; lastEventId: unknown }> = [];
    const url = await serve((incoming, response, body) => {
      if (provision(incoming, response)) return;
      watches.push({ turn: body.turn_id, lastEventId: incoming.headers["last-event-id"] });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: ready\ndata: {}\n\n");
      if (watches.length === 1) response.end();
      else response.write(`event: notification\ndata: ${JSON.stringify({ recipient: body.caller, turn_id: body.turn_id,
        post: { ...metadata, text_preview: "new live preview", n_chars: 16, truncated: false } })}\n\n`);
    });
    const adapter = client(url, { reconnectDelayMs: 5 });
    const receiver = adapter.notifications!({ caller: "root-agent", turnId: "turn-reconnect" }, context, receive);
    await receiver.ready;
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    receiver.close();
    expect(watches).toEqual([{ turn: "turn-reconnect", lastEventId: undefined }, { turn: "turn-reconnect", lastEventId: undefined }]);
  });

  it("releases model startup after a failed readiness attempt without delivering a preview", async () => {
    const receive = vi.fn(async () => true);
    const logger = { warn: vi.fn() };
    const url = await serve((incoming, response) => {
      if (provision(incoming, response)) return;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": no ready yet\n\n");
    });
    const receiver = client(url, { timeoutMs: 150, logger }).notifications!({ caller: "root-agent", turnId: "turn-timeout" }, context, receive);
    await receiver.ready;
    receiver.close();
    expect(receive).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(ADMIN);
  });

  it.each([
    { chunks: [Buffer.from(`data: ${"x".repeat(BOARD_MAX_BODY)}`)], code: "message_board_frame_too_large" },
    { chunks: [Uint8Array.of(0xc3, 0x28)], code: "message_board_invalid_utf8" },
    { chunks: [Uint8Array.of(0xf0, 0x9f)], code: "message_board_invalid_utf8" },
  ])("rejects bounded framing or UTF-8 errors: $code", async ({ chunks, code }) => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
    const read = async () => { for await (const _event of readBoardSse(stream, new AbortController().signal)) { /* invalid input */ } };
    await expect(read()).rejects.toMatchObject({ context: { code } });
  });
});
