import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionId, createTraceId, createTurnId, multiAgentToolName, SessionEventType, type SessionEvent,
  MultiAgentSpawnInputSchema, type SubagentSendMessageRequest, type MultiAgentV2Config,
} from "@zcode/contracts";
import {
  createMultiAgentControl, createMultiAgentToolEntries, multiAgentRootId,
  snapshotMultiAgentForkHistory, resolveMultiAgentTarget, assertMultiAgentCapacity,
  recordMultiAgentUsage, assertMultiAgentTokenBudget, multiAgentStatus,
} from "../src/multi-agent/index.js";
import { createExploreSubagentPort, type ExploreSubagentRuntimeRequest, type ExploreSubagentRuntimeResult } from "../src/subagent/runner.js";
import { InMemoryRuntimeTaskRegistry, createSessionScopedRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const cleanup: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
async function fixture(config: MultiAgentV2Config = {}, createRunner = createExploreSubagentPort) {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-v2-")); cleanup.push(outputRootDir);
  const registry = new InMemoryRuntimeTaskRegistry();
  const sessionId = createSessionId("root-v2");
  const identity = { agentPath: "/root", rootSessionId: sessionId };
  const settings = { enabled: true, ...config };
  const trace = { traceId: createTraceId(), spanId: "v2-test", sessionId };
  registry.register({ taskId: multiAgentRootId(sessionId), agentId: multiAgentRootId(sessionId), agentType: "root", description: "root",
    status: "running", startedAt: new Date(), type: "local_agent", childSessionId: sessionId,
    multiAgent: { ...identity, resident: true, runGeneration: 0 }, pendingMessages: [] });
  const executions: Array<{ request: ExploreSubagentRuntimeRequest; result: ReturnType<typeof deferred<ExploreSubagentRuntimeResult>>; signal?: AbortSignal }> = [];
  const received: string[] = [];
  const events: SessionEvent[] = [];
  const runner = createRunner({ runtimeTaskRegistry: registry, multiAgentRegistry: registry, multiAgentV2: settings, outputRootDir,
    detachAcceptedChildren: true, emitParentEvent: async (event) => { events.push(event); },
    runExploreAgent: async (request, options) => {
      const result = deferred<ExploreSubagentRuntimeResult>();
      executions.push({ request, result, signal: options?.signal });
      request.registerMessageSink?.({ async send(message) { received.push(message.message); return "steered"; } });
      await request.onSessionReady?.();
      return result.promise;
    },
  });
  const control = createMultiAgentControl({ registry, runner, identity, config: settings,
    getForkHistory: () => [{ role: "user", content: "PARENT_HISTORY_SENTINEL" }] });
  const context: SubagentSendMessageRequest = { sessionId, turnId: createTurnId(), parentToolCallId: "spawn-call", to: "", summary: "", message: "",
    workingDirectory: outputRootDir, workspaceRoot: outputRootDir, trace };
  const spawn = (name: string) => control.execute("spawn_agent", { task_name: name, message: "complete the task" }, context);
  const finish = async (index: number, response = "done") => {
    const execution = executions[index]!;
    execution.result.resolve({ response, events: [], traceId: trace.traceId });
    await runner.waitForTask!(execution.request.agentId);
  };
  return { registry, identity, control, context, runner, executions, received, events, spawn, finish, settings };
}

describe("V2 control using the real registry and original subagent runner", () => {
  it.each([false, true])("explicit tree stop reports the actual Main cancellation (accepted children: %s)", async (withChild) => {
    const f = await fixture();
    const started = deferred<void>();
    const release = deferred<void>();
    let mainSignal: AbortSignal | undefined;
    const runtime = createTestAgentRuntime(f.context.sessionId, {
      multiAgentV2: f.settings, modelStreaming: "off", compact: { enabled: false }, titleGeneration: { enabled: false },
    }, { runtimeTaskRegistry: f.registry, subagentPort: f.runner, eventStore: createTestSessionEventStore(),
      modelFactory: createTestModelFactory({ async generateText(request) {
        mainSignal = request.abortSignal;
        started.resolve();
        await release.promise;
        return { text: "late result", finishReason: "stop", usage: {} };
      } }) });
    const turn = runtime.executeTurn("Main keeps working");
    void turn.catch(() => undefined);
    try {
      await started.promise;
      if (withChild) await f.spawn("worker");
      const anchorId = withChild ? f.executions[0]!.request.agentId : multiAgentRootId(f.context.sessionId);
      const result = await runtime.cancelBackgroundTask(anchorId, { scope: "tree" });
      expect(mainSignal?.aborted).toBe(true);
      if (withChild) expect(f.executions[0]!.signal?.aborted).toBe(true);
      expect(result.cancelled).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskId: multiAgentRootId(f.context.sessionId), cancelled: true }),
      ]));
      release.resolve();
      await turn.catch(() => undefined);
      if (withChild) await f.finish(0);
    } finally {
      release.resolve();
      await turn.catch(() => undefined);
      runtime.beginShutdown();
    }
  });
  it.each(["task", "subtree", "tree"] as const)("cancels explicit %s scope without losing identities or stopping unrelated agents", async (scope) => {
    const f = await fixture();
    const runtime = createTestAgentRuntime(f.context.sessionId,
      { multiAgentV2: f.settings, subagents: { enabled: true } },
      { runtimeTaskRegistry: f.registry, subagentPort: f.runner, eventStore: createTestSessionEventStore() });
    const stopRoot = vi.spyOn(runtime, "stopActiveForegroundExecution");
    await f.spawn("a");
    const a = resolveMultiAgentTarget(f.registry, f.identity, "a");
    const child = createMultiAgentControl({ registry: f.registry, runner: f.runner,
      identity: { ...f.identity, agentPath: "/root/a", parentPath: "/root" }, config: f.settings,
      getForkHistory: () => [] });
    await child.execute("spawn_agent", { task_name: "b", message: "nested task" },
      { ...f.context, sessionId: a.childSessionId! });
    await f.spawn("sibling");
    const identities = f.executions.map((execution) => ({ id: execution.request.agentId, session: execution.request.sessionId }));
    const result = await runtime.cancelBackgroundTask(a.taskId, { scope });
    const expectedCancelled = scope === "task" ? [0] : scope === "subtree" ? [0, 1] : [0, 1, 2];
    expect(result.cancelled).toBe(true);
    expect(result.reason).toBeUndefined();
    if (scope !== "task") {
      expect(result.scope).toBe(scope);
      expect(result.tasks).toHaveLength(expectedCancelled.length);
      expect(result.tasks?.every((task) => task.cancelled && task.status === "cancelled")).toBe(true);
    }
    for (const [index, execution] of f.executions.entries()) {
      expect(execution.signal?.aborted).toBe(expectedCancelled.includes(index));
      expect(f.registry.get(execution.request.agentId)?.childSessionId).toBe(identities[index]!.session);
    }
    expect(stopRoot).toHaveBeenCalledTimes(scope === "tree" ? 1 : 0);
    // 给旧执行一次迟到结算机会；Stop 的旧 generation 不能覆盖原身份的中断状态。
    await Promise.all(f.executions.map((_execution, index) => f.finish(index)));
    for (const index of expectedCancelled) expect(multiAgentStatus(f.registry.get(identities[index]!.id)!)).toBe("interrupted");
    await f.control.execute("followup_task", { target: "a", message: "resume after explicit stop" }, f.context);
    expect(f.executions[3]!.request.agentId).toBe(a.agentId);
    expect(f.executions[3]!.request.sessionId).toBe(a.childSessionId);
    await f.finish(3);
    runtime.beginShutdown();
  });

  it("rejects cross-root scoped cancellation before stopping any member", async () => {
    const f = await fixture();
    const runtime = createTestAgentRuntime(f.context.sessionId, { multiAgentV2: f.settings },
      { runtimeTaskRegistry: f.registry, subagentPort: f.runner });
    await f.spawn("one");
    const stopRoot = vi.spyOn(runtime, "stopActiveForegroundExecution");
    const foreign = { ...f.registry.get(f.executions[0]!.request.agentId)!, taskId: "foreign", agentId: "foreign",
      multiAgent: { ...f.registry.get(f.executions[0]!.request.agentId)!.multiAgent!, rootSessionId: createSessionId("other-root") } };
    f.registry.register(foreign);
    await expect(runtime.cancelBackgroundTask("foreign", { scope: "tree" })).resolves.toMatchObject({ cancelled: false, reason: "background_task_not_found" });
    expect(stopRoot).not.toHaveBeenCalled();
    expect(f.executions[0]!.signal?.aborted).toBe(false);
    const ownTask = f.registry.get(f.executions[0]!.request.agentId)!;
    const childRuntime = createTestAgentRuntime(ownTask.childSessionId!, {
      multiAgentV2: f.settings, multiAgentIdentity: { ...f.identity, agentPath: "/root/one", parentPath: "/root" },
    }, { runtimeTaskRegistry: f.registry, multiAgentRegistry: f.registry, subagentPort: f.runner });
    await expect(childRuntime.cancelBackgroundTask(ownTask.taskId, { scope: "tree" })).resolves.toMatchObject({
      cancelled: false, reason: "background_task_cancel_not_supported",
    });
    expect(f.executions[0]!.signal?.aborted).toBe(false);
    childRuntime.beginShutdown();
    await f.finish(0);
    runtime.beginShutdown();
  });

  it("does not report partial failure when a selected agent finishes before its stop is dispatched", async () => {
    const f = await fixture();
    const runtime = createTestAgentRuntime(f.context.sessionId, { multiAgentV2: f.settings },
      { runtimeTaskRegistry: f.registry, subagentPort: f.runner });
    await f.spawn("one"); await f.spawn("two");
    const second = f.executions[1]!.request.agentId;
    const originalStop = f.runner.stopTask!.bind(f.runner);
    vi.spyOn(f.runner, "stopTask").mockImplementation(async (id, options) => {
      if (id === second) await f.finish(1);
      return originalStop(id, options);
    });
    const result = await runtime.cancelBackgroundTask(f.executions[0]!.request.agentId, { scope: "tree" });
    expect(result).toMatchObject({ cancelled: true });
    expect(result.reason).toBeUndefined();
    expect(result.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: second, status: "completed", cancelled: false }),
    ]));
    await f.finish(0);
    runtime.beginShutdown();
  });

  it("returns partial cancellation failures without claiming every task stopped", async () => {
    const f = await fixture();
    const runtime = createTestAgentRuntime(f.context.sessionId, { multiAgentV2: f.settings },
      { runtimeTaskRegistry: f.registry, subagentPort: f.runner });
    await f.spawn("one"); await f.spawn("two");
    const first = f.executions[0]!.request.agentId;
    f.registry.update(first, (task) => ({ ...task, control: { ...task.control!, stop: async () => { throw new Error("test stop failure"); } } }));
    const result = await runtime.cancelBackgroundTask(first, { scope: "tree" });
    expect(result).toMatchObject({ cancelled: true, reason: "background_task_cancel_partial" });
    expect(result.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: first, cancelled: false, reason: "background_task_cancel_failed" }),
      expect.objectContaining({ taskId: f.executions[1]!.request.agentId, cancelled: true }),
    ]));
    await Promise.all(f.executions.map((_execution, index) => f.finish(index)));
    runtime.beginShutdown();
  });

  it("accepts asynchronously, reserves the canonical task name and rejects duplicate siblings", async () => {
    const f = await fixture();
    expect(await f.spawn("worker")).toEqual({ task_name: "/root/worker" });
    expect(f.executions).toHaveLength(1);
    expect(f.registry.get(f.executions[0]!.request.agentId)?.status).toBe("running");
    await expect(f.spawn("worker")).rejects.toThrow("already exists");
    await f.finish(0);
  });
  it("stops a generation during metadata setup without recursive owner dispatch or a late start", async () => {
    const f = await fixture();
    let interrupted: Promise<unknown> | undefined;
    const unsubscribe = f.registry.subscribe(() => {
      const task = Object.values(f.registry.all()).find((candidate) => candidate.multiAgent?.agentPath === "/root/setup" && candidate.control);
      if (!task || interrupted) return;
      // Assign a sentinel before reentrant registry notifications from Stop.
      interrupted = Promise.resolve();
      interrupted = f.control.execute("interrupt_agent", { target: "/root/setup" }, f.context);
    });
    try {
      await f.spawn("setup");
      await interrupted;
      expect(f.executions).toHaveLength(0);
      const stopped = resolveMultiAgentTarget(f.registry, f.identity, "setup");
      // The existing runner stores explicit Stop as killed and emits stopped; V2 maps it to interrupted.
      expect(stopped).toMatchObject({ status: "killed", multiAgent: { resident: false } });
      expect(multiAgentStatus(stopped)).toBe("interrupted");
    } finally { unsubscribe(); }
  });

  it("resolves child-relative paths, explicit root and agent ids only in the same root", async () => {
    const f = await fixture(); await f.spawn("one");
    const task = resolveMultiAgentTarget(f.registry, f.identity, "one");
    expect(resolveMultiAgentTarget(f.registry, f.identity, "/root/one")).toBe(task);
    expect(resolveMultiAgentTarget(f.registry, f.identity, task.agentId)).toBe(task);
    expect(() => resolveMultiAgentTarget(f.registry, f.identity, "../other")).toThrow();
    expect(() => resolveMultiAgentTarget(f.registry, { ...f.identity, rootSessionId: "other" }, task.agentId)).toThrow();
    await f.finish(0);
  });
  it("QueueOnly retains an idle mailbox without starting another turn; followup resumes the original identity", async () => {
    const f = await fixture(); await f.spawn("one"); await f.finish(0);
    const first = f.executions[0]!.request;
    await f.control.execute("send_message", { target: "one", message: "queued 中文\nline" }, f.context);
    expect(f.executions).toHaveLength(1);
    expect(f.registry.get(first.agentId)?.pendingMessages).toHaveLength(1);
    await f.control.execute("followup_task", { target: "one", message: "second task" }, f.context);
    expect(f.executions).toHaveLength(2);
    expect(f.executions[1]!.request).toMatchObject({ agentId: first.agentId, sessionId: first.sessionId, resumeFromStore: true });
    expect(f.received).toContain("queued 中文\nline");
    await f.finish(1);
    await f.control.execute("followup_task", { target: "one", message: "third task" }, f.context);
    expect(f.executions[2]!.request.agentId).toBe(first.agentId);
    await f.finish(2);
  });
  it("serializes concurrent followups without duplicating a restored child turn", async () => {
    const f = await fixture(); await f.spawn("one"); await f.finish(0);
    await Promise.all([
      f.control.execute("followup_task", { target: "one", message: "second" }, f.context),
      f.control.execute("followup_task", { target: "one", message: "third queued" }, f.context),
    ]);
    expect(f.executions).toHaveLength(2);
    expect(f.received).toContain("third queued");
    await f.finish(1);
  });
  it("caller cancellation after admission leaves the child signal live", async () => {
    const f = await fixture(); const abort = new AbortController();
    await f.control.execute("spawn_agent", { task_name: "one", message: "work" }, f.context, { signal: abort.signal });
    abort.abort(new Error("Main Stop"));
    expect(f.executions[0]!.signal?.aborted).toBe(false);
    await f.finish(0);
  });
  it("interrupts a turn, keeps identity and fences a late completion from a prior generation", async () => {
    const f = await fixture(); await f.spawn("one"); const first = f.executions[0]!;
    expect(await f.control.execute("interrupt_agent", { target: "one" }, f.context)).toEqual({ previous_status: "running" });
    expect(first.signal?.aborted).toBe(true);
    await f.control.execute("followup_task", { target: "one", message: "next" }, f.context);
    first.result.resolve({ response: "STALE", events: [], traceId: f.context.trace.traceId });
    await Promise.resolve(); await Promise.resolve();
    expect(f.registry.get(first.request.agentId)?.status).toBe("running");
    await f.finish(1, "CURRENT");
    expect(f.registry.get(first.request.agentId)?.output).toMatchObject({ content: [{ text: "CURRENT" }] });
    await expect(f.control.execute("interrupt_agent", { target: "/root" }, f.context)).rejects.toThrow();
  });
  it.each([
    { outcome: "failure", resume: false }, { outcome: "failure", resume: true },
    { outcome: "completion", resume: false }, { outcome: "completion", resume: true },
  ].flatMap((scenario) => [false, true].map((foreground) => ({ ...scenario, foreground }))))("fences $outcome artifact completion after accepted Stop (resume=$resume, foreground=$foreground)", async ({ outcome, resume, foreground }) => {
    const releaseWrite = deferred<void>(); const finalizationAttempt = deferred<void>();
    const stale = `STALE_${outcome.toUpperCase()}`;
    let blocked = false; let terminalArtifactsFinished = false; let oldMetadataPath = "";
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actualFs,
      writeFile: vi.fn(async (...args: Parameters<typeof actualFs.writeFile>) => {
        const [path, data] = args;
        if (!blocked && String(path).endsWith("/output.txt") && String(data) === stale) {
          blocked = true; oldMetadataPath = String(path).replace(/\/output\.txt$/, "/metadata.json");
          await releaseWrite.promise;
        }
        await actualFs.writeFile(...args);
        if (String(path) === oldMetadataPath && typeof data === "string"
          && JSON.parse(data).status === (outcome === "failure" ? "failed" : "completed")) terminalArtifactsFinished = true;
      }),
    }));
    try {
      const { createExploreSubagentPort: isolatedRunner } = await import("../src/subagent/runner.js");
      const f = await fixture({}, isolatedRunner);
      let foregroundResult: Promise<{ error?: unknown }> | undefined;
      if (foreground) {
        foregroundResult = f.runner.run({ ...f.context, agentType: "general-purpose", description: "one", prompt: "foreground task",
          multiAgent: { agentId: "foreground_agent", agentPath: "/root/one", parentPath: "/root", rootSessionId: f.identity.rootSessionId, forkTurns: "none" },
        }).then(() => ({}), (error: unknown) => ({ error }));
        await vi.waitFor(() => expect(f.executions).toHaveLength(1));
      } else await f.spawn("one");
      const first = f.executions[0]!; const update = f.registry.update.bind(f.registry);
      const updateSpy = vi.spyOn(f.registry, "update").mockImplementation((id, patcher) => {
        const result = update(id, patcher);
        if (terminalArtifactsFinished && id === first.request.agentId) finalizationAttempt.resolve();
        return result;
      });
      if (outcome === "failure") first.result.reject(new Error(stale));
      else first.result.resolve({ response: stale, events: [], traceId: f.context.trace.traceId });
      await vi.waitFor(() => expect(blocked).toBe(true));
      await f.control.execute("interrupt_agent", { target: "one" }, f.context);
      if (resume) await f.control.execute("followup_task", { target: "one", message: "new generation" }, f.context);
      const accepted = f.registry.get(first.request.agentId)!;
      releaseWrite.resolve(); await finalizationAttempt.promise;
      const current = f.registry.get(first.request.agentId)!;
      expect(current.status).toBe(resume ? "running" : "killed");
      expect(current.multiAgent).toMatchObject({ runGeneration: resume ? 2 : 1, resident: resume });
      expect(current.messageSink).toBe(accepted.messageSink);
      const root = f.registry.get(multiAgentRootId(f.identity.rootSessionId))!;
      expect(root.pendingMessages?.some((message) => message.message.includes(stale))).toBe(false);
      if (foregroundResult) expect((await foregroundResult).error).toBeDefined();
      updateSpy.mockRestore();
      if (resume) {
        expect(f.executions[1]!.signal?.aborted).toBe(false);
        await f.finish(1, "CURRENT");
        expect(f.registry.get(first.request.agentId)?.output).toMatchObject({ content: [{ text: "CURRENT" }] });
      }
    } finally { releaseWrite.resolve(); vi.doUnmock("node:fs/promises"); vi.resetModules(); }
  });
  it("retains QueueOnly mail accepted while an already committed Stop writes artifacts", async () => {
    const releaseWrite = deferred<void>(); let blocked = false;
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actualFs,
      writeFile: vi.fn(async (...args: Parameters<typeof actualFs.writeFile>) => {
        if (!blocked && String(args[0]).endsWith("/output.txt") && String(args[1]).includes("Background agent task stopped.")) {
          blocked = true; await releaseWrite.promise;
        }
        return actualFs.writeFile(...args);
      }),
    }));
    try {
      const { createExploreSubagentPort: isolatedRunner } = await import("../src/subagent/runner.js");
      const f = await fixture({}, isolatedRunner); await f.spawn("one");
      const stopping = f.control.execute("interrupt_agent", { target: "one" }, f.context);
      await vi.waitFor(() => expect(blocked).toBe(true));
      const text = "accepted while Stop writes 中文\nmailbox";
      await f.control.execute("send_message", { target: "one", message: text }, f.context);
      const accepted = resolveMultiAgentTarget(f.registry, f.identity, "one");
      expect(accepted.pendingMessages).toHaveLength(1);
      releaseWrite.resolve(); await stopping;
      const stopped = resolveMultiAgentTarget(f.registry, f.identity, "one");
      expect(stopped.pendingMessages).toEqual(accepted.pendingMessages);
      expect(stopped.multiAgent?.activitySequence).toBe(accepted.multiAgent?.activitySequence);
      f.executions[0]!.result.resolve({ response: "old ignored", events: [], traceId: f.context.trace.traceId });
      await f.control.execute("followup_task", { target: "one", message: "resume" }, f.context);
      expect(f.received.filter((message) => message === text)).toHaveLength(1);
      await f.finish(1);
    } finally { releaseWrite.resolve(); vi.doUnmock("node:fs/promises"); vi.resetModules(); }
  });
  it("enforces default four execution slots including root, and reclaims completed residency", async () => {
    const f = await fixture(); await f.spawn("one"); await f.spawn("two"); await f.spawn("three");
    await expect(f.spawn("four")).rejects.toThrow("execution capacity 4");
    await f.finish(0); await f.spawn("four");
    expect(f.registry.get(f.executions[0]!.request.agentId)?.multiAgent?.resident).toBe(false);
    await Promise.all([f.finish(1), f.finish(2), f.finish(3)]);
  });
  it.each([8, 16])("admits the configured %i slots atomically under concurrent spawn pressure", async (capacity) => {
    const f = await fixture({ maxConcurrentThreadsPerSession: capacity, maxResidentAgents: capacity });
    const outcomes = await Promise.allSettled(Array.from({ length: capacity + 1 }, (_, index) => f.spawn(`worker_${index}`)));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(capacity - 1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(2);
    expect(Object.values(f.registry.all()).filter((task) => task.status === "running")).toHaveLength(capacity);
    expect(Object.values(f.registry.all()).filter((task) => task.multiAgent?.resident)).toHaveLength(capacity);
    await Promise.all(f.executions.map((_execution, index) => f.finish(index)));
    expect(Object.values(f.registry.all()).filter((task) => task.multiAgent?.resident)).toHaveLength(1);
  });

  it("residency has an independent limit and token budgets use reported usage", async () => {
    const f = await fixture({ maxConcurrentThreadsPerSession: 16, maxResidentAgents: 2, tokenBudget: 5 });
    await f.spawn("one"); await expect(f.spawn("two")).rejects.toThrow("residency capacity 2");
    await f.finish(0); recordMultiAgentUsage(f.registry, f.identity, 5);
    expect(() => assertMultiAgentTokenBudget(f.registry, f.identity, f.settings)).toThrow("token budget");
    expect(() => assertMultiAgentCapacity(f.registry, f.identity, f.settings)).toThrow("token budget");
  });
  it("sends final results to the direct parent's retained mailbox and lists unloaded identities", async () => {
    const f = await fixture(); await f.spawn("one"); await f.finish(0, "RESULT_SENTINEL");
    const root = f.registry.get(multiAgentRootId(f.identity.rootSessionId))!;
    expect(root.pendingMessages?.some((message) => message.messageType === "FINAL_ANSWER" && message.message.includes("RESULT_SENTINEL"))).toBe(true);
    expect(await f.control.execute("list_agents", { path_prefix: "/root/one" }, f.context)).toEqual({ agents: [{ agent_name: "/root/one", nickname: "Ada", agent_status: { completed: "RESULT_SENTINEL" } }] });
  });
  it("attributes a sibling's resumed completion activity without moving its parent or delivering a result body to the initiator", async () => {
    const f = await fixture(); await f.spawn("sender"); await f.spawn("worker"); await f.finish(1);
    const sender = resolveMultiAgentTarget(f.registry, f.identity, "sender");
    const senderTurn = createTurnId("sibling-followup");
    const caller = createMultiAgentControl({ registry: f.registry, runner: f.runner, config: f.settings,
      identity: { agentPath: "/root/sender", parentPath: "/root", rootSessionId: f.identity.rootSessionId }, getForkHistory: () => [] });
    const callerContext = { ...f.context, sessionId: sender.childSessionId!, turnId: senderTurn };
    await caller.execute("followup_task", { target: "/root/worker", message: "SECOND_TASK_BODY" }, callerContext);
    await f.control.execute("send_message", { target: "worker", message: "QueueOnly does not replace attribution" }, f.context);
    await f.finish(2, "SECOND_RESULT_BODY");
    const activityForSender = () => f.events.filter((event) => event.sessionId === sender.childSessionId
      && event.type === SessionEventType.SubagentMessage && (event.payload as { multiAgentActivity?: { kind?: string } }).multiAgentActivity?.kind === "completed");
    await vi.waitFor(() => expect(activityForSender()).toHaveLength(1));
    const event = activityForSender()[0]!;
    expect(event.turnId).toBe(senderTurn);
    expect(event.payload).toMatchObject({ agentPath: "/root/worker", parentAgentPath: "/root",
      multiAgentActivity: { kind: "completed", initiatingAgentPath: "/root/sender", initiatingTurnId: senderTurn, runGeneration: 2 } });
    expect(JSON.stringify(event.payload)).not.toMatch(/SECOND_TASK_BODY|SECOND_RESULT_BODY/);
    expect(f.registry.get(sender.taskId)?.pendingMessages).toEqual(sender.pendingMessages);
    expect(resolveMultiAgentTarget(f.registry, f.identity, "worker")).toMatchObject({ parentSessionId: f.context.sessionId,
      multiAgent: { parentPath: "/root", initiatingAgentPath: "/root/sender" } });
    const root = f.registry.get(multiAgentRootId(f.identity.rootSessionId))!;
    expect(root.pendingMessages?.some((message) => message.messageType === "FINAL_ANSWER" && message.message.includes("SECOND_RESULT_BODY"))).toBe(true);
    await expect(caller.execute("followup_task", { target: "/root", message: "must not steer root" }, callerContext)).rejects.toThrow("root is resumed by user input");
    await f.finish(0);
  });
  it("wait subscribes before examining early mailbox activity, returns no bodies, and user steer wakes it", async () => {
    const f = await fixture();
    f.registry.queueMessage(multiAgentRootId(f.identity.rootSessionId), { id: "early", message: "PRIVATE_BODY", queuedAt: new Date() });
    const early = await f.control.execute("wait_agent", {}, f.context);
    expect(early.timed_out).toBe(false); expect(JSON.stringify(early)).not.toContain("PRIVATE_BODY");
    const waiting = f.control.execute("wait_agent", {}, f.context);
    f.control.notifyUserSteer!();
    expect(await waiting).toEqual({ timed_out: false, message: "Wait interrupted by new input." });
  });
  it("clamps short waits to ten seconds and respects caller cancellation", async () => {
    const f = await fixture(); vi.useFakeTimers();
    const waiting = f.control.execute("wait_agent", { timeout_ms: 1 }, f.context);
    await vi.advanceTimersByTimeAsync(9999);
    let completed = false; void waiting.then(() => { completed = true; });
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await waiting).toEqual({ timed_out: true,
      message: "Wait timed out.\n\nRequested timeout of 1ms was clamped to the minimum of 10000ms." });
    await expect(f.control.execute("wait_agent", { timeout_ms: 3_600_001 }, f.context)).rejects.toThrow("at most 3600000");
    f.registry.queueMessage(multiAgentRootId(f.identity.rootSessionId), { id: "negative-timeout", message: "queued", queuedAt: new Date() });
    expect(await f.control.execute("wait_agent", { timeout_ms: -1 }, f.context)).toEqual({ timed_out: false,
      message: "Wait completed.\n\nRequested timeout of -1ms was clamped to the minimum of 10000ms." });
    const abort = new AbortController();
    const cancelled = f.control.execute("wait_agent", {}, f.context, { signal: abort.signal });
    const rejected = expect(cancelled).rejects.toThrow("cancelled wait");
    abort.abort(new Error("cancelled wait")); await rejected;
  });
  it("fork all supplies history while none and override validation have separate behavior", async () => {
    const f = await fixture(); await f.spawn("all");
    expect(f.executions[0]!.request.forkHistory).toEqual([{ role: "user", content: "PARENT_HISTORY_SENTINEL" }]);
    await f.control.execute("spawn_agent", { task_name: "none", message: "work", fork_turns: "none" }, f.context);
    expect(f.executions[1]!.request.forkHistory).toBeUndefined();
    await expect(f.control.execute("spawn_agent", { task_name: "bad", message: "work", model: "other" }, f.context)).rejects.toThrow("inherit the parent model");
    await Promise.all([f.finish(0), f.finish(1)]);
  });
  it("uses configured default, minimum and maximum wait times, including an explicit zero", async () => {
    const f = await fixture({ minWaitTimeoutMs: 2, maxWaitTimeoutMs: 20, defaultWaitTimeoutMs: 10 });
    const zero = await fixture({ minWaitTimeoutMs: 0, maxWaitTimeoutMs: 0, defaultWaitTimeoutMs: 0 });
    vi.useFakeTimers();
    const waiting = f.control.execute("wait_agent", {}, f.context);
    let completed = false; void waiting.then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(9); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await waiting).toEqual({ timed_out: true, message: "Wait timed out." });
    const clamped = f.control.execute("wait_agent", { timeout_ms: 1 }, f.context);
    await vi.advanceTimersByTimeAsync(2);
    expect(await clamped).toEqual({ timed_out: true, message: "Wait timed out.\n\nRequested timeout of 1ms was clamped to the minimum of 2ms." });
    await expect(f.control.execute("wait_agent", { timeout_ms: 21 }, f.context)).rejects.toThrow("at most 20");
    const immediate = zero.control.execute("wait_agent", {}, zero.context);
    await vi.advanceTimersByTimeAsync(0); expect((await immediate).timed_out).toBe(true);
  });
});

describe("V2 schema, policy and snapshot boundaries", () => {
  it("uses upstream task names and a provider-safe alias without shrinking logical namespaces", () => {
    expect(MultiAgentSpawnInputSchema.parse({ task_name: "1_worker", message: "task" }).task_name).toBe("1_worker");
    expect(() => MultiAgentSpawnInputSchema.parse({ task_name: "root", message: "task" })).toThrow();
    expect(() => MultiAgentSpawnInputSchema.parse({ task_name: "ok", message: "task", fork_context: true })).toThrow();
    expect(multiAgentToolName("spawn_agent", "x".repeat(64)).length).toBeLessThanOrEqual(64);
    expect(multiAgentToolName("spawn_agent", "9-team")).toBe("9-team_spawn_agent");
  });
  it("gates six real entries, exposes strict schemas and hides invocation overrides", () => {
    expect(createMultiAgentToolEntries({ enabled: false })).toHaveLength(0);
    const entries = createMultiAgentToolEntries({ enabled: true }); expect(entries).toHaveLength(6);
    expect(createMultiAgentToolEntries({ enabled: true, disableDirectMessage: true, waitAgentEnabled: false })).toHaveLength(3);
    const spawn = createMultiAgentToolEntries({ enabled: true, exposeSpawnAgentModelOverrides: false })[0]!;
    expect(() => spawn.runtimeInputSchema!.parse({ task_name: "one", message: "task", model: "hidden" })).toThrow();
  });
  it("keeps wait declarations and executor timeout aligned with validated runtime settings", () => {
    const entry = createMultiAgentToolEntries({ enabled: true, minWaitTimeoutMs: 2, maxWaitTimeoutMs: 20, defaultWaitTimeoutMs: 10 })
      .find((tool) => tool.metadata.name === multiAgentToolName("wait_agent"))!;
    expect(entry.metadata.description).toContain("Default 10 ms. Requests below 2 ms are clamped; requests above 20 ms are rejected.");
    expect(entry.timeout).toMatchObject({ defaultMs: 1020, maxMs: 1020 });
    for (const invalid of [
      { minWaitTimeoutMs: -1 }, { maxWaitTimeoutMs: 3_600_001 }, { defaultWaitTimeoutMs: 0.5 },
      { minWaitTimeoutMs: 30, maxWaitTimeoutMs: 20, defaultWaitTimeoutMs: 25 },
      { minWaitTimeoutMs: 10, maxWaitTimeoutMs: 20, defaultWaitTimeoutMs: 9 },
      { minWaitTimeoutMs: 10, maxWaitTimeoutMs: 20, defaultWaitTimeoutMs: 21 },
    ]) expect(() => createMultiAgentToolEntries({ enabled: true, ...invalid })).toThrow();
  });
  it("fork snapshots exclude hidden reasoning and incomplete or orphan tool events", () => {
    const messages = snapshotMultiAgentForkHistory([
      { role: "system", content: "PARENT_ROOT_IDENTITY" }, { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "reasoning", text: "SECRET" }, { type: "text", text: "visible" }], toolCalls: [{ id: "ok", name: "Read", input: {} }, { id: "pending", name: "Write", input: {} }] },
      { role: "tool", content: "read result", toolCallId: "ok" }, { role: "tool", content: "orphan", toolCallId: "missing" },
    ]);
    expect(JSON.stringify(messages)).not.toMatch(/SECRET|PARENT_ROOT_IDENTITY|pending|orphan/);
    expect(messages[1]!.toolCalls).toHaveLength(1);
  });
  it("session scoped registries isolate branch epochs and ordinary task enumeration", () => {
    const owner = new InMemoryRuntimeTaskRegistry();
    const a = createSessionScopedRuntimeTaskRegistry(owner, createSessionId("a"));
    const b = createSessionScopedRuntimeTaskRegistry(owner, createSessionId("b"));
    a.setActiveBranchGeneration!(7); b.setActiveBranchGeneration!(2);
    a.register({ taskId: "ta", agentId: "ta", agentType: "worker", description: "A", parentSessionId: createSessionId("a"), startedAt: new Date(), status: "running", type: "local_agent" });
    b.register({ taskId: "tb", agentId: "tb", agentType: "worker", description: "B", parentSessionId: createSessionId("b"), startedAt: new Date(), status: "running", type: "local_agent" });
    expect(Object.keys(a.all())).toEqual(["ta"]); expect(a.get("ta")?.branchGeneration).toBe(7);
    expect(Object.keys(b.all())).toEqual(["tb"]); expect(b.get("tb")?.branchGeneration).toBe(2);
  });
});


it.each([
  { config: { maxConcurrentThreadsPerSession: 2, maxResidentAgents: 8 }, error: "execution capacity" },
  { config: { maxConcurrentThreadsPerSession: 8, maxResidentAgents: 2 }, error: "residency capacity" },
])("legacy SendMessage rejects V2 resume at $error without changing the terminal generation", async ({ config, error }) => {
  const f = await fixture(config);
  await f.spawn("idle"); await f.finish(0);
  const idle = resolveMultiAgentTarget(f.registry, f.identity, "idle");
  await f.spawn("busy");
  try {
    await expect(f.runner.sendMessage!({ ...f.context, to: idle.agentId, message: "must not run" })).rejects.toThrow(error);
    expect(f.registry.get(idle.agentId)).toMatchObject({ status: "completed", multiAgent: { runGeneration: 1, resident: false } });
    expect(f.executions).toHaveLength(2);
  } finally { await f.finish(1); }
});

it("legacy SendMessage respects the reported V2 budget and atomically reserves the last slot", async () => {
  const f = await fixture({ maxConcurrentThreadsPerSession: 2, maxResidentAgents: 2, tokenBudget: 100 });
  await f.spawn("a"); await f.finish(0); await f.spawn("b"); await f.finish(1);
  const a = resolveMultiAgentTarget(f.registry, f.identity, "a");
  const b = resolveMultiAgentTarget(f.registry, f.identity, "b");
  recordMultiAgentUsage(f.registry, f.identity, 100);
  await expect(f.runner.sendMessage!({ ...f.context, to: a.agentId, message: "over budget" })).rejects.toThrow("token budget exhausted");
  f.settings.tokenBudget = 200;
  const results = await Promise.allSettled([a, b].map((task) => f.runner.sendMessage!({ ...f.context, to: task.agentId, message: "last slot" })));
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(f.executions).toHaveLength(3);
  await f.finish(2);
});
