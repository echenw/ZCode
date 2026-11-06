import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionId, createTraceId, multiAgentToolName, RESPOND_TO_COORDINATOR_TOOL_NAME, SessionEventType, type ExecutionPort, type ModelRequest, type SessionEvent, type SubagentSendMessageRequest } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { agentToolEntry } from "../src/tool/handlers/agent.js";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const text = (value: string) => ({ finishReason: "stop" as const, text: value, usage });
const spawn = (name: string) => ({ id: `spawn_${name}`, name: multiAgentToolName("spawn_agent"), input: { task_name: name, message: `task ${name}`, fork_turns: "none" } });
const resources: Array<{ path: string; runtime: ReturnType<typeof createTestAgentRuntime> }> = [];
afterEach(async () => {
  for (const { runtime } of resources) runtime.beginShutdown();
  await Promise.all(resources.map(({ runtime }) => runtime.closeBrowserSession()));
  await Promise.all(resources.splice(0).map(({ path }) => rm(path, { recursive: true, force: true })));
});
function agentPath(request: ModelRequest) {
  return [...JSON.stringify(request.messages.filter((m) => m.role === "system")).matchAll(/Task path: (\/root(?:\/[a-z0-9_]+)*)/g)].at(-1)?.[1] ?? "/root";
}
async function setup(generateText: NonNullable<Parameters<typeof createTestModelFactory>[0]["generateText"]>, executionPort?: ExecutionPort, streaming = false) {
  const path = await mkdtemp(join(tmpdir(), "zcode-user-agent-"));
  const store = createRecordingSubagentSessionStore();
  const runtime = createTestAgentRuntime(createSessionId(), {
    workingDirectory: path, mode: "yolo", modelStreaming: streaming ? "on" : "off", compact: { enabled: false }, titleGeneration: { enabled: false },
    multiAgentV2: { enabled: true, maxConcurrentThreadsPerSession: 8, maxResidentAgents: 8 }, subagents: { outputRootDir: path },
  }, { sessionStore: store, eventStore: createTestSessionEventStore(), modelFactory: createTestModelFactory({ generateText,
    ...(streaming ? { async *streamText(request: ModelRequest, observation: Parameters<typeof generateText>[1]) {
      const result = await generateText(request, observation);
      for (const toolCall of result.toolCalls ?? []) yield { type: "tool_call" as const, toolCall };
      if (result.text) yield { type: "text_delta" as const, text: result.text };
      yield { type: "finish" as const, finishReason: result.finishReason, usage: result.usage };
    } } : {}),
  }), executionPort });
  resources.push({ path, runtime });
  const core = runtime as unknown as AgentRuntimeInternal;
  const context: SubagentSendMessageRequest = { sessionId: core.sessionId, parentToolCallId: "test-control", to: "", message: "", summary: "",
    workingDirectory: path, workspaceRoot: path, trace: { traceId: createTraceId(), sessionId: core.sessionId } };
  const task = (name: string) => Object.values(core.multiAgentRegistry!.all()).find((t) => t.multiAgent?.agentPath === name)!;
  return { runtime, core, store, context, task };
}

it("queues a child result arriving during the final root response without forcing another model request", async () => {
  const releaseRoot = Promise.withResolvers<void>();
  const rootStarted = Promise.withResolvers<void>();
  const rootRequests: ModelRequest[] = [];
  let childRequests = 0;
  const { runtime, core, context, task } = await setup(async (request) => {
    if (agentPath(request) !== "/root") {
      if (++childRequests === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [{
        id: "child-progress", name: RESPOND_TO_COORDINATOR_TOOL_NAME, input: { summary: "progress", message: "CHILD_PROGRESS_MAIL" },
      }] };
      return text("CHILD_FINAL_MAIL");
    }
    rootRequests.push(request);
    rootStarted.resolve();
    if (rootRequests.length === 1) await releaseRoot.promise;
    return text("ROOT_FINAL");
  });
  const enqueued = vi.spyOn(core.runtimeCommandQueue, "enqueue");
  const turn = runtime.executeTurn("finish this root task");
  try {
    await rootStarted.promise;
    await core.subagentPort!.multiAgent!.execute("spawn_agent", spawn("worker").input, context);
    await vi.waitFor(() => expect(task("/root/worker").status).toBe("completed"));
    expect(task("/root").pendingMessages?.map((message) => message.messageType)).toEqual(["MESSAGE", "FINAL_ANSWER"]);
    expect(new Set(task("/root").pendingMessages?.map((message) => message.id)).size).toBe(2);
    expect(enqueued.mock.calls.filter(([command]) => command.mode === "subagent-message" || command.mode === "task-notification")).toHaveLength(0);
    releaseRoot.resolve();
    await turn;
    expect(rootRequests).toHaveLength(1);
    expect(task("/root").pendingMessages).toHaveLength(2);
    await runtime.executeTurn("now read the child result");
    expect(rootRequests).toHaveLength(2);
    const consumed = JSON.stringify(rootRequests[1]!.messages);
    expect(consumed.split("CHILD_FINAL_MAIL")).toHaveLength(2);
    expect(consumed.split("CHILD_PROGRESS_MAIL")).toHaveLength(2);
    expect(enqueued.mock.calls.filter(([command]) => command.mode === "subagent-message" || command.mode === "task-notification")).toHaveLength(0);
    expect(task("/root").pendingMessages).toHaveLength(0);
  } finally { releaseRoot.resolve(); await turn.catch(() => undefined); }
}, 20_000);

it.each([false, true])("keeps an accepted legacy child alive and exposes the wait cancellation in resumed history (streaming %s)", async (streaming) => {
  const childStarted = Promise.withResolvers<AbortSignal | undefined>();
  const releaseChild = Promise.withResolvers<void>();
  const main = new AbortController();
  const rootRequests: ModelRequest[] = [];
  const { runtime, core, store } = await setup(async (request) => {
    const isChild = request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("LEGACY_CHILD_ONLY_MARKER"));
    if (isChild) {
      childStarted.resolve(request.abortSignal);
      await releaseChild.promise;
      return text("child finished independently");
    }
    rootRequests.push(request);
    if (rootRequests.length > 1) return text("checked");
    return { finishReason: "tool-calls", text: "", usage, toolCalls: [{ id: "legacy_call", name: "Agent",
      input: { description: "independent child", prompt: "LEGACY_CHILD_ONLY_MARKER", subagent_type: "general-purpose" } }] };
  }, undefined, streaming);
  const turn = runtime.executeTurn("delegate one foreground agent", undefined, { abortSignal: main.signal }).then(() => false, () => true);
  try {
    const childSignal = await childStarted.promise;
    main.abort(new Error("Main Stop"));
    expect(await turn).toBe(true);
    expect(childSignal?.aborted).toBe(false);
    const children = Object.values(core.multiAgentRegistry!.all()).filter((task) => task.multiAgent?.agentPath !== "/root");
    expect(children).toHaveLength(1);
    expect(children[0]!.status).toBe("running");
    // 回执本身是模型可见契约；执行状态仍由上面的真实 Registry/signal 断言建立。
    expect(agentToolEntry.cancellation.userVisibleMessage).toContain("foreground Agent wait was cancelled");
    expect(agentToolEntry.cancellation.userVisibleMessage).toContain("does not establish whether the child agent stopped");
    expect(agentToolEntry.cancellation.userVisibleMessage).toContain("Query the live agent/task state");
    await runtime.executeTurn("check the child state");
    const resumedHistory = JSON.stringify(rootRequests[1]!.messages);
    expect(resumedHistory).toContain("foreground Agent wait was cancelled");
    expect(resumedHistory).toContain("does not establish whether the child agent stopped");
    expect(JSON.stringify(await store.messages({ sessionID: core.sessionId }))).toContain("does not establish whether the child agent stopped");
  } finally {
    main.abort(); releaseChild.resolve(); await turn;
    await vi.waitFor(() => expect(Object.values(core.multiAgentRegistry!.all()).filter((task) => task.multiAgent?.agentPath !== "/root").every((task) => task.status === "completed")).toBe(true));
  }
}, 20_000);

it("guides the original running grandchild, stops only its parent, and resumes the same grandchild with its true parent", async () => {
  const signals = new Map<string, AbortSignal>();
  const calls = new Map<string, number>();
  const requests = new Map<string, ModelRequest[]>();
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  for (const name of ["/root/a", "/root/a/b", "/root/sibling", "resume-b"]) gates.set(name, Promise.withResolvers<void>());
  const { runtime, core, store, task } = await setup(async (request) => {
    const path = agentPath(request), n = (calls.get(path) ?? 0) + 1;
    calls.set(path, n); requests.set(path, [...(requests.get(path) ?? []), request]);
    if (path === "/root" && n === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [spawn("a"), spawn("sibling")] };
    if (path === "/root/a" && n === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [spawn("b")] };
    if (path === "/root") return text("root done");
    if (!request.abortSignal) throw new Error("Runtime signal missing");
    signals.set(path, request.abortSignal);
    if (path === "/root/a/b" && n === 3) await gates.get("resume-b")!.promise;
    else if (path !== "/root/a/b" || n === 1) await gates.get(path)!.promise;
    return text(`done ${path} ${n}`);
  });
  try {
    await runtime.executeTurn("delegate a tree");
    await vi.waitFor(() => expect([...signals.keys()].sort()).toEqual(["/root/a", "/root/a/b", "/root/sibling"]));
    const originalB = task("/root/a/b"), originalA = task("/root/a");
    await runtime.controlSubagent({ action: "send", childSessionId: originalB.childSessionId!, text: "USER_GUIDANCE_MARKER" });
    expect(signals.get("/root/a/b")!.aborted).toBe(false);
    gates.get("/root/a/b")!.resolve();
    await vi.waitFor(() => expect(task("/root/a/b").status).toBe("completed"));
    expect(requests.get("/root/a/b")).toHaveLength(2);
    expect(JSON.stringify(requests.get("/root/a/b")![1]!.messages)).toContain("USER_GUIDANCE_MARKER");
    const resumed = await runtime.controlSubagent({ action: "send", childSessionId: originalB.childSessionId!, text: "USER_RESUME_MARKER" });
    expect(resumed.delivery).toBe("resumed_background");
    await vi.waitFor(() => expect(calls.get("/root/a/b")).toBe(3));
    await runtime.controlSubagent({ action: "stop", childSessionId: originalA.childSessionId! });
    expect(signals.get("/root/a")!.aborted).toBe(true);
    expect(signals.get("/root/a/b")!.aborted).toBe(false);
    expect(signals.get("/root/sibling")!.aborted).toBe(false);
    expect(task("/root").pendingMessages?.some((m) => m.senderPath === "/root/a")).toBe(false);
    expect(task("/root/a/b").agentId).toBe(originalB.agentId);
    expect(task("/root/a/b").childSessionId).toBe(originalB.childSessionId);
    expect((await store.getSession(originalB.childSessionId!))?.parentID).toBe(originalA.childSessionId);
    expect(JSON.stringify(requests.get("/root/a/b")![2]!.messages)).toContain("USER_RESUME_MARKER");
    await expect(runtime.controlSubagent({ action: "send", childSessionId: "other-root-child", text: "rejected" })).rejects.toThrow("does not belong");
    expect(calls.get("/root")).toBe(2);
  } finally { for (const gate of gates.values()) gate.resolve(); }
  await vi.waitFor(() => expect(task("/root/a/b").status).toBe("completed"));
}, 25_000);

it("stops all live descendants before shared execution closes and keeps their queued mail", async () => {
  const releaseExecution = Promise.withResolvers<void>();
  const executions: AbortSignal[] = [];
  const calls = new Map<string, number>();
  const executionPort: ExecutionPort = {
    async run(_request, options) {
      if (!options?.signal) throw new Error("Execution signal missing");
      executions.push(options.signal);
      await releaseExecution.promise;
      const now = new Date();
      return { status: "cancelled", stdout: { text: "", bytes: 0, truncated: false },
        stderr: { text: "", bytes: 0, truncated: false }, durationMs: 1, timedOut: false,
        cancelled: true, startedAt: now, completedAt: now };
    },
  };
  const { runtime, core, context, task } = await setup(async (request) => {
    const path = agentPath(request), n = (calls.get(path) ?? 0) + 1;
    calls.set(path, n);
    if (path === "/root" && n === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [spawn("a"), spawn("sibling")] };
    if (path === "/root/a" && n === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [spawn("b")] };
    if (path === "/root" || path === "/root/a") return text(`done ${path}`);
    if (n === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [{ id: `bash_${path}`, name: "Bash", input: { command: "echo hold" } }] };
    return text(`unexpected extra request ${path}`);
  }, executionPort);
  try {
    await runtime.executeTurn("delegate a tree");
    await vi.waitFor(() => {
      expect(task("/root/a").status).toBe("completed");
      expect(executions).toHaveLength(2);
    });
    await core.subagentPort!.multiAgent!.execute("send_message", { target: "/root/a/b", message: "MAIL_SURVIVES_SHUTDOWN" }, context);
    runtime.beginShutdown();
    // Both independent controls must be aborted before the shared execution port can cancel tools.
    expect(executions.every((signal) => signal.aborted)).toBe(true);
    expect(task("/root/a/b").status).toBe("killed");
    expect(task("/root/sibling").status).toBe("killed");
    expect(task("/root/a/b").pendingMessages?.map((message) => message.message)).toContain("MAIL_SURVIVES_SHUTDOWN");
    releaseExecution.resolve();
    await runtime.closeBrowserSession();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls.get("/root/a/b")).toBe(1);
    expect(calls.get("/root/sibling")).toBe(1);
  } finally { releaseExecution.resolve(); }
}, 25_000);

it("keeps a foreground child, background sibling and grandchild alive after Main Stop", async () => {
  const main = new AbortController();
  const release = Promise.withResolvers<void>();
  const signals = new Map<string, AbortSignal>();
  const calls = new Map<string, number>();
  const rootRequests: ModelRequest[] = [];
  const { runtime, core, context } = await setup(async (request) => {
    const path = agentPath(request), n = (calls.get(path) ?? 0) + 1;
    calls.set(path, n);
    if (path === "/root") {
      rootRequests.push(request);
      if (n === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [
        { id: "foreground_a", name: "Agent", input: { description: "foreground A", prompt: "A_ONLY", subagent_type: "general-purpose" } },
        { id: "background_b", name: "Agent", input: { description: "background B", prompt: "B_ONLY", subagent_type: "general-purpose", run_in_background: true } },
      ] };
      if (n === 2) return { finishReason: "tool-calls", text: "", usage, toolCalls: [{ id: "list_after_stop", name: multiAgentToolName("list_agents"), input: {} }] };
      if (n === 3) return { finishReason: "tool-calls", text: "", usage, toolCalls: [{ id: "wait_after_stop", name: multiAgentToolName("wait_agent"), input: { timeout_ms: 10_000 } }] };
      return text("root checked live agents");
    }
    const isA = request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("A_ONLY"));
    if (isA && n === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [spawn("c")] };
    if (!request.abortSignal) throw new Error("Child signal missing");
    if (isA && n > 2) return text("A followup completed");
    signals.set(path, request.abortSignal);
    await release.promise;
    return text(`completed ${path}`);
  });
  const turn = runtime.executeTurn("start foreground A and background B", undefined, { abortSignal: main.signal }).then(() => false, () => true);
  try {
    await vi.waitFor(() => expect(signals.size).toBe(3));
    const children = Object.values(core.multiAgentRegistry!.all()).filter((task) => task.multiAgent?.agentPath !== "/root");
    const a = children.find((task) => task.description === "foreground A")!;
    const b = children.find((task) => task.description === "background B")!;
    const c = children.find((task) => task.multiAgent?.parentPath === a.multiAgent?.agentPath)!;
    expect([a, b, c].every(Boolean)).toBe(true);
    expect(c.parentSessionId).toBe(a.childSessionId);
    main.abort(new Error("Main Stop"));
    expect(await turn).toBe(true);
    expect([...signals.values()].every((signal) => !signal.aborted)).toBe(true);
    expect([a, b, c].every((task) => core.multiAgentRegistry!.get(task.taskId)?.status === "running")).toBe(true);
    const nextTurn = runtime.executeTurn("list and wait for the agents still working");
    await vi.waitFor(() => expect(rootRequests.length).toBeGreaterThanOrEqual(3));
    const listing = JSON.stringify(rootRequests[2]!.messages);
    for (const task of [a, b, c]) expect(listing).toContain(task.multiAgent!.agentPath);
    release.resolve();
    await nextTurn;
    expect(JSON.stringify(rootRequests.at(-1)!.messages)).toContain("Wait completed.");
    await vi.waitFor(() => expect([a, b, c].every((task) => core.multiAgentRegistry!.get(task.taskId)?.status === "completed")).toBe(true));
    for (const task of [a, b, c]) {
      const current = core.multiAgentRegistry!.get(task.taskId)!;
      expect(current.agentId).toBe(task.agentId);
      expect(current.childSessionId).toBe(task.childSessionId);
      expect(current.output?.status).toBe("completed");
    }
    await core.subagentPort!.multiAgent!.execute("followup_task", { target: a.multiAgent!.agentPath, message: "continue original A" }, context);
    await vi.waitFor(() => expect(core.multiAgentRegistry!.get(a.taskId)?.multiAgent?.runGeneration).toBe(a.multiAgent!.runGeneration + 1));
    await vi.waitFor(() => expect(core.multiAgentRegistry!.get(a.taskId)?.status).toBe("completed"));
    expect(core.multiAgentRegistry!.get(a.taskId)?.childSessionId).toBe(a.childSessionId);
  } finally { main.abort(); release.resolve(); await turn; }
}, 25_000);


it("routes a Root-rebound grandchild coordinator reply to its actual parent without waking idle Root", async () => {
  const counts = new Map<string, number>();
  const { runtime, core, context, task } = await setup(async (request) => {
    const path = agentPath(request), n = (counts.get(path) ?? 0) + 1;
    counts.set(path, n);
    if (path === "/root/a" && n === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [spawn("b")] };
    if (path === "/root/a/b" && n === 2) return { finishReason: "tool-calls", text: "", usage, toolCalls: [{
      id: "grandchild-response", name: RESPOND_TO_COORDINATOR_TOOL_NAME,
      input: { summary: "reply to real parent", message: "GRANDCHILD_REAL_PARENT_ONLY" },
    }] };
    return text(`complete ${path}`);
  });
  await runtime.executeTurn("remain idle after finishing");
  await core.subagentPort!.multiAgent!.execute("spawn_agent", spawn("a").input, context);
  await vi.waitFor(() => { expect(task("/root/a").status).toBe("completed"); expect(task("/root/a/b").status).toBe("completed"); });
  const rootCalls = counts.get("/root");
  const enqueued = vi.spyOn(core.runtimeCommandQueue, "enqueue");
  await runtime.controlSubagent({ action: "send", childSessionId: task("/root/a/b").childSessionId!, text: "ask the real parent" });
  await vi.waitFor(() => expect(counts.get("/root/a/b")).toBe(3));
  await vi.waitFor(() => expect(task("/root/a/b").status).toBe("completed"));
  expect(task("/root/a/b").control?.executionHostSessionId).toBe(core.sessionId);
  expect(task("/root/a").pendingMessages).toEqual(expect.arrayContaining([expect.objectContaining({
    message: "GRANDCHILD_REAL_PARENT_ONLY", messageType: "MESSAGE", targetPath: "/root/a", senderPath: "/root/a/b",
  })]));
  expect(task("/root").pendingMessages?.some((message) => message.message === "GRANDCHILD_REAL_PARENT_ONLY")).toBe(false);
  expect(enqueued.mock.calls.filter(([command]) => command.mode === "subagent-message")).toHaveLength(0);
  expect(counts.get("/root")).toBe(rootCalls);
}, 20_000);

it("keeps the current generation's mailbox working when an interrupted restore finishes late", async () => {
  const restoreEntered = Promise.withResolvers<void>();
  const releaseRestore = Promise.withResolvers<void>();
  const currentModelEntered = Promise.withResolvers<void>();
  const releaseCurrentModel = Promise.withResolvers<void>();
  const requests: ModelRequest[] = [];
  const { runtime, core, store, context, task } = await setup(async (request) => {
    requests.push(request);
    if (requests.length === 2) {
      currentModelEntered.resolve();
      await releaseCurrentModel.promise;
      return { finishReason: "tool-calls", text: "", usage, toolCalls: [{ id: "current-todo", name: "TodoWrite", input: { todos: [] } }] };
    }
    return text("completed");
  });
  const events: SessionEvent[] = [];
  runtime.subscribeEvents({ onSessionEvent: (event) => { events.push(event); } });
  const control = core.subagentPort!.multiAgent!;
  await control.execute("spawn_agent", spawn("worker").input, context);
  await vi.waitFor(() => expect(task("/root/worker").status).toBe("completed"));
  const original = task("/root/worker");
  const readMessages = store.messages.bind(store);
  let blockNextRestore = true;
  vi.spyOn(store, "messages").mockImplementation(async (input) => {
    if (blockNextRestore && input.sessionID === original.childSessionId) {
      blockNextRestore = false;
      restoreEntered.resolve();
      await releaseRestore.promise;
    }
    return readMessages(input);
  });
  const oldRestore = control.execute("followup_task", { target: "worker", message: "interrupted restore" }, context)
    .then(() => undefined, () => undefined);
  try {
    await restoreEntered.promise;
    await control.execute("interrupt_agent", { target: "worker" }, context);
    await control.execute("followup_task", { target: "worker", message: "current task" }, context);
    await currentModelEntered.promise;
    releaseRestore.resolve();
    await oldRestore;
    await control.execute("send_message", { target: "worker", message: "CURRENT_GENERATION_MAIL" }, context);
    releaseCurrentModel.resolve();
    await vi.waitFor(() => expect(task("/root/worker").status).toBe("completed"));
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2]!.messages)).toContain("CURRENT_GENERATION_MAIL");
    expect(task("/root/worker").pendingMessages).toHaveLength(0);
    expect(task("/root/worker")).toMatchObject({ agentId: original.agentId, childSessionId: original.childSessionId,
      multiAgent: { runGeneration: 3 } });
    expect(events.filter((event) => event.type === SessionEventType.SubagentSpawned)).toHaveLength(2);
  } finally { releaseRestore.resolve(); releaseCurrentModel.resolve(); await oldRestore; }
}, 20_000);

it("retains an interrupted foreground identity before its first turn and resumes it after session creation", async () => {
  const createEntered = Promise.withResolvers<void>();
  const releaseCreate = Promise.withResolvers<void>();
  const childTitleCommitted = Promise.withResolvers<void>();
  const requests: ModelRequest[] = [];
  const { runtime, core, store, context } = await setup(async (request) => { requests.push(request); return text("resumed first turn"); });
  const createSession = store.createSession.bind(store);
  let blockCreation = true;
  vi.spyOn(store, "createSession").mockImplementation(async (input) => {
    if (input.parentID && blockCreation) {
      blockCreation = false;
      createEntered.resolve();
      await releaseCreate.promise;
    }
    return createSession(input);
  });
  const events: SessionEvent[] = [];
  runtime.subscribeEvents({ onSessionEvent: (event) => {
    events.push(event);
    if (event.type === SessionEventType.SessionTitleUpdated && event.sessionId !== core.sessionId) childTitleCommitted.resolve();
  } });
  const control = core.subagentPort!.multiAgent!;
  const foreground = core.subagentPort!.run({ ...context, agentType: "general-purpose", description: "setup worker", prompt: "first task" })
    .then(() => undefined, (error: unknown) => error);
  try {
    await createEntered.promise;
    const original = Object.values(core.multiAgentRegistry!.all()).find((candidate) => candidate.multiAgent?.agentPath !== "/root")!;
    const path = original.multiAgent!.agentPath;
    await control.execute("interrupt_agent", { target: path }, context);
    expect(await foreground).toBeInstanceOf(Error);
    expect((await control.execute("list_agents", {}, context)).agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_name: path, agent_status: "interrupted" }),
    ]));
    expect(core.multiAgentRegistry!.get(original.taskId)).toMatchObject({ agentId: original.agentId,
      childSessionId: original.childSessionId, status: "killed", hasStartedTurn: false });
    releaseCreate.resolve();
    await childTitleCommitted.promise;
    await control.execute("followup_task", { target: path, message: "resume original setup worker" }, context);
    await vi.waitFor(() => expect(core.multiAgentRegistry!.get(original.taskId)?.status).toBe("completed"));
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]!.messages)).toContain("resume original setup worker");
    expect(core.multiAgentRegistry!.get(original.taskId)).toMatchObject({ agentId: original.agentId,
      childSessionId: original.childSessionId, hasStartedTurn: true, multiAgent: { runGeneration: 2 } });
    expect((await store.getSession(original.childSessionId!))?.parentID).toBe(core.sessionId);
    expect(events.filter((event) => event.type === SessionEventType.SubagentSpawned)).toHaveLength(1);
  } finally { releaseCreate.resolve(); await foreground; }
}, 20_000);

it("does not treat missing history of a previously started child as an unstarted first turn", async () => {
  const requests: ModelRequest[] = [];
  const { core, store, context, task } = await setup(async (request) => { requests.push(request); return text("original history"); });
  const control = core.subagentPort!.multiAgent!;
  await control.execute("spawn_agent", spawn("worker").input, context);
  await vi.waitFor(() => expect(task("/root/worker").status).toBe("completed"));
  const original = task("/root/worker");
  expect(original.hasStartedTurn).toBe(true);
  const readMessages = store.messages.bind(store);
  vi.spyOn(store, "messages").mockImplementation((input) => input.sessionID === original.childSessionId ? Promise.resolve([]) : readMessages(input));
  await expect(control.execute("followup_task", { target: "worker", message: "must not silently start over" }, context)).rejects.toThrow("No transcript found");
  expect(requests).toHaveLength(1);
  expect(task("/root/worker").childSessionId).toBe(original.childSessionId);
});

it("reuses the original allocated identity when interrupted before any child session was persisted", async () => {
  const requests: ModelRequest[] = [];
  const { core, store, context, task } = await setup(async (request) => { requests.push(request); return text("first execution after early pause"); });
  const admitted = Promise.withResolvers<void>();
  const unsubscribe = core.multiAgentRegistry!.subscribe!(() => {
    const current = task("/root/worker");
    if (current?.control && current.hasStartedTurn === false) admitted.resolve();
  });
  const control = core.subagentPort!.multiAgent!;
  const start = control.execute("spawn_agent", spawn("worker").input, context).then(() => undefined, () => undefined);
  try {
    await admitted.promise;
    const original = task("/root/worker");
    await control.execute("interrupt_agent", { target: "worker" }, context);
    await start;
    expect(await store.getSession(original.childSessionId!)).toBeNull();
    expect(requests).toHaveLength(0);
    await control.execute("followup_task", { target: "worker", message: "first real turn in original identity" }, context);
    await vi.waitFor(() => expect(task("/root/worker").status).toBe("completed"));
    expect(task("/root/worker")).toMatchObject({ agentId: original.agentId, childSessionId: original.childSessionId, hasStartedTurn: true });
    expect((await store.getSession(original.childSessionId!))?.parentID).toBe(core.sessionId);
    expect(requests).toHaveLength(1);
  } finally { unsubscribe(); await start; }
}, 20_000);
