import assert from "node:assert/strict";
import {
  AgentMessageBoardOutputSchemas, AgentMessageBoardStoredStateSchema, createTraceId,
  type AgentMessageBoardCallContext, type AgentMessageBoardOperation, type SessionId,
} from "@zcode/contracts";
import { openStartupSqliteSessionStore } from "../../src/storage/index.ts";
import { AGENT_MESSAGE_BOARD_ENTRY_TYPE } from "../../../core/src/multi-agent-board/index.ts";
import type { AgentRuntimeInternal } from "../../../core/src/runtime/internal.ts";
import { createTestAgentRuntime } from "../../../core/tests/test-agent-runtime.ts";
import { createTestModelFactory } from "../../../core/tests/test-runtime-model.ts";
import { createTestSessionEventStore } from "../../../core/tests/test-event-store.ts";

interface ProcessInput {
  mode: "write" | "read";
  backend: "local" | "memory";
  rootSessionId: string;
  dbPath: string;
  directory: string;
  postId?: string;
}
const ORIGINAL = { new_channel_name: "process-results", text: "跨进程保留 Unicode 🚲🦤 / durable board result" };
const ORIGINAL_REQUEST = "durable-turn:original-post";

async function run(input: ProcessInput) {
  const store = await openStartupSqliteSessionStore({ dbPath: input.dbPath });
  const rootSessionId = input.rootSessionId as SessionId;
  let modelCalls = 0;
  const runtime = createTestAgentRuntime(rootSessionId, {
    workingDirectory: input.directory, mode: "yolo", modelStreaming: "off",
    titleGeneration: { enabled: false }, compact: { enabled: false },
    multiAgentV2: { enabled: true, messageBoardEnabled: true, messageBoardInMemory: input.backend === "memory" },
  }, {
    sessionStore: store, eventStore: createTestSessionEventStore(),
    modelFactory: createTestModelFactory({ async generateText() { modelCalls += 1; throw new Error("Storage recovery must not invoke a model"); } }),
  });
  const core = runtime as unknown as AgentRuntimeInternal;
  const board = core.subagentPort?.messageBoard;
  const context = (requestId: string): AgentMessageBoardCallContext => ({ requestId, trace: { traceId: createTraceId(), sessionId: rootSessionId } });
  const call = (operation: AgentMessageBoardOperation, data: unknown, requestId: string) => {
    assert.ok(board, "the production Runtime must bind the configured local or memory Board");
    return board.execute(operation, data, context(requestId));
  };
  const channels = async () => AgentMessageBoardOutputSchemas.get_channels.parse(await call("get_channels", {}, "read-channels"));
  try {
    await core.multiAgentPersistence?.ready;
    await runtime.ensureSessionPersistedForExternalActivity("Board SQLite process recovery");
    let postId = input.postId;
    if (input.mode === "write") {
      const first = AgentMessageBoardOutputSchemas.post.parse(await call("post", ORIGINAL, ORIGINAL_REQUEST));
      postId = first.message_id;
      await call("unsubscribe", { thread_id: postId }, "explicit-thread-opt-out");
      await call("post", { channel_name: ORIGINAL.new_channel_name, text: "Second committed thread" }, "durable-turn:second-post");
      assert.equal((await channels()).results[0]?.message_count, 2);
    } else if (input.backend === "local") {
      assert.ok(postId);
      const before = await channels();
      assert.equal(before.n_returned, 1);
      assert.equal(before.results[0]?.channel_name, ORIGINAL.new_channel_name);
      assert.equal(before.results[0]?.message_count, 2);
      const restored = AgentMessageBoardOutputSchemas.read_post.parse(await call("read_post", { message_id: postId }, "read-restored-post"));
      assert.equal(restored.text, ORIGINAL.text);
      assert.equal(restored.n_chars, Array.from(ORIGINAL.text).length);
      const replay = AgentMessageBoardOutputSchemas.post.parse(await call("post", ORIGINAL, ORIGINAL_REQUEST));
      assert.equal(replay.message_id, postId, "the persisted caller/request ID must replay the original post, not create a new one");
      await assert.rejects(call("post", { ...ORIGINAL, text: "different content" }, ORIGINAL_REQUEST),
        (error: unknown) => (error as { context?: { code?: string } }).context?.code === "message_board_request_conflict");
      assert.equal((await channels()).results[0]?.message_count, 2, "replay and conflict must not create duplicate posts");
      await call("post", { thread_id: postId, text: "Reply after a real process restart" }, "reader-turn:reply");
      assert.equal((await channels()).results[0]?.message_count, 3);
    } else {
      assert.ok(postId);
      assert.equal((await channels()).n_returned, 0, "memory mode must start empty in a new process despite the same SQLite database");
      await assert.rejects(call("read_post", { message_id: postId }, "read-ephemeral-post"));
    }
    assert.ok(postId);
    const entries = await store.sessionEntries!({ sessionID: rootSessionId, type: AGENT_MESSAGE_BOARD_ENTRY_TYPE });
    let storedPosts = 0;
    if (input.backend === "local") {
      assert.equal(entries.length, 1);
      const snapshot = AgentMessageBoardStoredStateSchema.parse(entries[0]!.data);
      assert.equal(entries[0]!.sessionID, rootSessionId);
      assert.equal(snapshot.rootSessionId, rootSessionId);
      storedPosts = snapshot.posts.length;
      assert.equal(storedPosts, input.mode === "write" ? 2 : 3);
      assert.equal(snapshot.subscriptions.find((subscription) => subscription.kind === "thread" && subscription.target === postId && subscription.agentPath === "/root")?.enabled,
        false, "explicit thread unsubscribe must survive restoration and a later reply");
    } else assert.equal(entries.length, 0);
    assert.equal((await store.getSession(rootSessionId))?.id, rootSessionId);
    assert.equal(modelCalls, 0);
    await core.multiAgentPersistence?.flush();
    return { ok: true, pid: process.pid, rootSessionId, postId, storedPosts, entryCount: entries.length, modelCalls };
  } finally {
    runtime.beginShutdown();
    // The IPC result is sent only after this finally closes the real SQLite connection.
    store.close();
  }
}

process.send?.({ type: "ready" });
process.once("message", async (input: ProcessInput) => {
  let exitCode = 0;
  let result: unknown;
  try {
    assert.ok(input.mode === "write" || input.mode === "read");
    assert.ok(input.backend === "local" || input.backend === "memory");
    result = await run(input);
  } catch (error) {
    exitCode = 1;
    result = { ok: false, pid: process.pid, message: error instanceof Error ? error.stack : String(error) };
  }
  process.send?.({ type: "result", result }, () => { process.disconnect?.(); process.exit(exitCode); });
});
