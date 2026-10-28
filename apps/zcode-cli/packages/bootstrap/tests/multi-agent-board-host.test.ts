import { mkdtemp, rm } from "node:fs/promises";
import http, { type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { ModelRequest } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

const ADMIN = "fixture-board-admin-credential-32-characters";
const SESSION = "fixture-board-session-credential-32-characters";
const POST = "a8f2a5ad-eac4-45f0-83e1-14bc96dbcd88";
const PAYLOAD = "A live result from the real loopback board transport";
const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

// The App, Runtime, SQLite store and HTTP/SSE sockets are real. Only the Model executor
// is a local fixture; this neither calls an external provider nor proves a deployed service.
describe("message-board production Host assembly", () => {
  it("receives a current-turn notification through the configured Host and releases the SSE connection after consumption", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-board-host-"));
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    const watched = Promise.withResolvers<{ response: ServerResponse; caller: string; turnId: string }>();
    const disconnected = Promise.withResolvers<void>();
    const modelStarted = Promise.withResolvers<void>();
    const releaseModel = Promise.withResolvers<void>();
    const requests: ModelRequest[] = [];
    const received: Array<{ method: string; path: string; credential?: string; body: Record<string, unknown> }> = [];
    const server = http.createServer((incoming, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        received.push({ method: incoming.method!, path: incoming.url!, credential: incoming.headers.authorization, body });
        if (incoming.method === "PUT") json(response, incoming.url!.split("/").at(-1));
        else if (incoming.url?.endsWith("/members")) json(response, SESSION);
        else if (incoming.url?.endsWith("/notifications")) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(": connected, deliberately awaiting ready\n\n");
          response.on("close", () => disconnected.resolve());
          watched.resolve({ response, caller: String(body.caller), turnId: String(body.turn_id) });
        } else if (incoming.url?.endsWith("/call")) {
          json(response, { results: [], n_returned: 0, has_more: false, next_cursor: null });
        } else {
          response.writeHead(404); response.end();
        }
      })().catch(() => response.destroy());
    });
    const abort = new AbortController();
    let app: Awaited<ReturnType<typeof createRegistryBackedTestApp>> | undefined;
    let turn: ReturnType<NonNullable<typeof app>["submitPrompt"]> | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/host-prefix`;
      app = await createRegistryBackedTestApp({
        env: { ZCODE_STORAGE_DIR: join(root, "storage") },
        sessionStore: store,
        skipUserConfig: true,
        runtimeConfig: {
          workingDirectory: root, mode: "yolo", modelStreaming: "off",
          mcp: { enabled: false }, compact: { enabled: false },
          modelSelection: { providerId: "zai", modelId: "glm-4.6", options: { reasoningLevel: "low" } },
          multiAgentV2: { enabled: true, messageBoardEnabled: true, messageBoardRemote: { url, bearerToken: ADMIN } },
        },
        modelExecutor: {
          async generateText(request) {
            requests.push(request);
            if (requests.length === 1) {
              modelStarted.resolve();
              await releaseModel.promise;
              return { text: "", finishReason: "tool-calls", usage: USAGE,
                toolCalls: [{ id: "host-read-channels", name: "collaboration_get_channels", input: {} }] };
            }
            return { text: "The active board notification was consumed", finishReason: "stop", usage: USAGE };
          },
        },
      });
      const steer = vi.spyOn(app.runtime, "steerTurn"); // Observe the real method without replacing it.
      turn = app.submitPrompt("Read the shared board while accepting live collaboration", { abortSignal: abort.signal });
      void turn.catch(() => undefined);
      const watch = await watched.promise;
      expect(requests).toHaveLength(0);
      watch.response.write("event: ready\ndata: {}\n\n");
      await modelStarted.promise;
      expect(requests[0]?.tools?.map((tool) => tool.name)).toContain("collaboration_get_channels");
      watch.response.write(`event: notification\ndata: ${JSON.stringify({
        recipient: watch.caller, turn_id: watch.turnId,
        post: { message_id: POST, thread_id: POST, channel_name: "results", author: "/root/peer",
          created_at: "2026-10-26T12:00:00Z", text_preview: PAYLOAD, n_chars: Array.from(PAYLOAD).length, truncated: false },
      })}\n\n`);
      await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
      expect(steer).toHaveBeenCalledWith(expect.objectContaining({
        expectedTurnId: watch.turnId, inputPresentation: "coordinator_steer", delivery: "guide",
        input: expect.stringContaining(`Message Type: CHANNEL_POST`),
      }));
      await expect(steer.mock.results[0]!.value).resolves.toMatchObject({ kind: "queued", turnId: watch.turnId });
      releaseModel.resolve();
      expect((await turn).response).toBe("The active board notification was consumed");
      await disconnected.promise;
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1]?.messages)).toContain(PAYLOAD);
      expect(JSON.stringify(await store.messages({ sessionID: app.sessionId }))).toContain(PAYLOAD);
      expect(received.map((request) => request.method)).toEqual(["PUT", "POST", "POST", "POST"]);
      expect(received.map((request) => request.credential)).toEqual([
        `Bearer ${ADMIN}`, `Bearer ${ADMIN}`, `Bearer ${SESSION}`, `Bearer ${SESSION}`,
      ]);
      expect(received[0]?.path).toMatch(/^\/host-prefix\/v1\/boards\/[0-9a-f-]{36}$/);
      expect(received[1]?.body).toEqual({ members: { [watch.caller]: "/root" } });
      expect(received[2]?.body).toEqual({ caller: watch.caller, turn_id: watch.turnId });
      expect(received[3]?.body).toMatchObject({ caller: watch.caller, method: "list_channels" });
      expect(steer).toHaveBeenCalledTimes(1);
    } finally {
      releaseModel.resolve();
      abort.abort();
      await turn?.catch(() => undefined);
      await app?.close();
      store.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
