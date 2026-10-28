import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  createTraceId, multiAgentToolName, SESSION_ENTRY_EXECUTION_STATE, type ModelRequest, type SessionId, type SubagentSendMessageRequest,
} from "@zcode/contracts";
import { openStartupSqliteSessionStore } from "../../src/storage/index.ts";
import { resolveMultiAgentTarget } from "../../../core/src/multi-agent/index.ts";
import type { AgentRuntimeInternal } from "../../../core/src/runtime/internal.ts";
import { createTestAgentRuntime } from "../../../core/tests/test-agent-runtime.ts";
import { createTestModelFactory } from "../../../core/tests/test-runtime-model.ts";
import { createTestSessionEventStore } from "../../../core/tests/test-event-store.ts";

interface ProcessInput { mode: "write" | "read"; rootSessionId: string; dbPath: string; directory: string }
const FIRST_TASK = "FIRST_SQLITE_CHILD_TASK";
const FIRST_RESULT = "FIRST_SQLITE_CHILD_RESULT";
const IDLE_MAIL = "SQLITE_MAIL_ACCEPTED_BEFORE_EXIT";
const ACTIVE_TASK = "SQLITE_TASK_ACTIVE_AT_PROCESS_EXIT";
const RESUME_TASK = "SQLITE_EXPLICIT_COLD_FOLLOWUP";

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(10);
  }
}

async function run(input: ProcessInput) {
  const store = await openStartupSqliteSessionStore({ dbPath: input.dbPath });
  const requests: ModelRequest[] = [];
  let activeRequestStarted = false;
  const rootSessionId = input.rootSessionId as SessionId;
  const runtime = createTestAgentRuntime(rootSessionId, {
    workingDirectory: input.directory,
    mode: input.mode === "write" ? "plan" : "yolo",
    ...(input.mode === "write" ? { toolAllowlist: ["Read", multiAgentToolName("spawn_agent"), multiAgentToolName("send_message"), multiAgentToolName("followup_task")] } : {}),
    modelStreaming: "off", compact: { enabled: false }, titleGeneration: { enabled: false },
    multiAgentV2: { enabled: true },
    subagents: { outputRootDir: input.directory,
      ...(input.mode === "write" ? { profiles: [{ name: "sqlite_worker", source: "user" as const, description: "SQLite recovery worker",
        systemPrompt: "SQLITE_WORKER_ROLE", tools: ["Read"] }] } : {}),
    },
  }, {
    sessionStore: store, eventStore: createTestSessionEventStore(),
    modelFactory: createTestModelFactory({ async generateText(request) {
      requests.push(request);
      if (input.mode === "write" && JSON.stringify(request.messages).includes(ACTIVE_TASK)) {
        activeRequestStarted = true;
        // Exit the writer with a real admitted request still running. No fabricated registry state.
        await new Promise<void>(() => {});
      }
      return { text: input.mode === "write" ? FIRST_RESULT : "SQLITE_RESUMED_RESULT", finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    } }),
  });
  const core = runtime as unknown as AgentRuntimeInternal;
  const identity = { agentPath: "/root", rootSessionId };
  const target = (path: string) => resolveMultiAgentTarget(core.multiAgentRegistry!, identity, path);
  const context: SubagentSendMessageRequest = {
    sessionId: rootSessionId, parentToolCallId: "sqlite-process-control", to: "", message: "", summary: "",
    workingDirectory: input.directory, workspaceRoot: input.directory, trace: { traceId: createTraceId(), sessionId: rootSessionId },
  };
  const control = core.subagentPort!.multiAgent!;
  const complete = (path: string) => until(() => target(path).status === "completed", `${path} completed`);
  try {
    await core.multiAgentPersistence!.ready;
    if (input.mode === "write") {
      await runtime.ensureSessionPersistedForExternalActivity("SQLite process recovery acceptance");
      await control.execute("spawn_agent", { task_name: "worker", message: FIRST_TASK, fork_turns: "none", agent_type: "sqlite_worker" }, context);
      await complete("worker");
      await control.execute("send_message", { target: "worker", message: IDLE_MAIL }, context);
      assert.equal(requests.length, 1, "mail to an idle identity must not invoke its model");
      assert.equal(target("worker").pendingMessages?.filter((message) => message.message === IDLE_MAIL).length, 1);
      await control.execute("spawn_agent", { task_name: "lost", message: FIRST_TASK, fork_turns: "none", agent_type: "sqlite_worker" }, context);
      await complete("lost");
      await control.execute("followup_task", { target: "lost", message: ACTIVE_TASK }, context);
      await until(() => activeRequestStarted, "the actual in-flight child model request");
      assert.equal(target("lost").status, "running");
      assert.equal(target("lost").multiAgent?.resident, true);
      assert.equal(requests.length, 3);
    } else {
      const worker = target("worker"); const lost = target("lost");
      assert.equal(requests.length, 0, "cold hydration must not pretend an old request is live or wake an idle child");
      assert.equal(worker.status, "completed"); assert.equal(worker.multiAgent?.resident, false);
      assert.equal(lost.status, "lost"); assert.equal(lost.multiAgent?.resident, false);
      assert.equal(worker.multiAgent?.rootSessionId, rootSessionId);
      assert.equal(worker.parentSessionId, rootSessionId);
      assert.equal(worker.pendingMessages?.filter((message) => message.message === IDLE_MAIL).length, 1);
      assert.equal(worker.resumeState?.request.inheritedPermissionMode, "build");
      assert.equal(worker.resumeState?.request.inheritedPlanEnabled, true);
      assert.ok(worker.resumeState?.request.inheritedToolAllowlist?.includes("Read"));
      assert.ok(!worker.resumeState?.request.inheritedToolAllowlist?.includes("Bash"));
      assert.equal((await store.getSession(worker.childSessionId!))?.id, worker.childSessionId);
      await control.execute("followup_task", { target: "worker", message: RESUME_TASK }, context);
      await complete("worker");
      const workerRequest = requests[0]; assert.ok(workerRequest);
      const text = JSON.stringify(workerRequest.messages);
      for (const expected of [FIRST_TASK, FIRST_RESULT, IDLE_MAIL, RESUME_TASK, "SQLITE_WORKER_ROLE", "Task path: /root/worker"]) assert.ok(text.includes(expected), `worker request missing ${expected}`);
      assert.equal(text.split(IDLE_MAIL).length - 1, 1, "accepted idle mail is consumed exactly once");
      assert.ok(workerRequest.tools?.some((tool) => tool.name === "Read"));
      assert.ok(!workerRequest.tools?.some((tool) => tool.name === "Bash" || tool.name === "Write"));
      assert.equal(target("worker").pendingMessages?.filter((message) => message.message === IDLE_MAIL).length ?? 0, 0);
      assert.equal(target("worker").multiAgent?.runGeneration, 2);
      // Plan 是独立轴；旧 permission.mode 只保存基础权限，不能把 build 误判成退出 Plan。
      assert.equal((await store.getSession(worker.childSessionId!))?.permission?.mode, "build");
      const executionEntries = await store.sessionEntries({ sessionID: worker.childSessionId!, type: SESSION_ENTRY_EXECUTION_STATE });
      assert.deepEqual(executionEntries.at(-1)?.data, { mode: "build", planEnabled: true });
      await control.execute("followup_task", { target: "lost", message: RESUME_TASK }, context);
      await complete("lost");
      assert.equal(target("lost").multiAgent?.runGeneration, 3);
      const lostText = JSON.stringify(requests[1]?.messages);
      for (const expected of [FIRST_TASK, FIRST_RESULT, ACTIVE_TASK, RESUME_TASK, "Task path: /root/lost"]) assert.ok(lostText.includes(expected), `lost request missing ${expected}`);
      assert.equal(requests.length, 2);
    }
    await core.multiAgentPersistence!.flush();
    const result = {
      ok: true, pid: process.pid, rootSessionId,
      workerId: target("worker").agentId, workerSessionId: target("worker").childSessionId,
      lostId: target("lost").agentId, lostSessionId: target("lost").childSessionId,
      modelCalls: requests.length,
    };
    // Close the real connection before acknowledging success; the next process opens a new one.
    runtime.beginShutdown();
    store.close();
    return result;
  } catch (error) {
    runtime.beginShutdown();
    store.close();
    throw error;
  }
}

process.send?.({ type: "ready" });
process.once("message", async (input: ProcessInput) => {
  let exitCode = 0;
  let result: unknown;
  try {
    assert.ok(input.mode === "write" || input.mode === "read");
    assert.equal(typeof input.rootSessionId, "string"); assert.equal(typeof input.dbPath, "string"); assert.equal(typeof input.directory, "string");
    result = await run(input);
  } catch (error) {
    exitCode = 1;
    result = { ok: false, pid: process.pid, message: error instanceof Error ? error.stack : String(error) };
  }
  // This is a test process entry point. Terminating the admitted request simulates host exit.
  process.send?.({ type: "result", result }, () => { process.disconnect?.(); process.exit(exitCode); });
});
