import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CoreErrorType, createCoreError, SessionEventType, createSessionId, createTraceId, multiAgentToolName,
  MULTI_AGENT_OPERATIONS, type Model, type ModelRequest, type SubagentSendMessageRequest,
} from "@zcode/contracts";
import { createMultiAgentToolEntries, getMultiAgentUsage, resolveMultiAgentTarget } from "../src/multi-agent/index.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory, type TestModelExecutionObservation } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { MemoryFileSystem } from "./memory-test-utils.js";

const paths: string[] = [];
const runtimes: ReturnType<typeof createTestAgentRuntime>[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.beginShutdown();
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function requestPath(request: ModelRequest): string {
  const prefix = request.messages.filter((message) => message.role === "system");
  return [...JSON.stringify(prefix).matchAll(/Task path: (\/root(?:\/[a-z0-9_]+)*)/g)].at(-1)?.[1] ?? "/root";
}
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const textResult = (text: string) => ({ finishReason: "stop" as const, text, usage });
const spawnCall = (name: string, extra: Record<string, unknown> = {}) => ({ id: `spawn_${name}`, name: multiAgentToolName("spawn_agent"), input: { task_name: name, message: `task ${name}`, ...extra } });
function internal(runtime: ReturnType<typeof createTestAgentRuntime>) { return runtime as unknown as AgentRuntimeInternal; }
async function workspace() { const path = await mkdtemp(join(tmpdir(), "zcode-v2-runtime-")); paths.push(path); return path; }
function context(runtime: ReturnType<typeof createTestAgentRuntime>, directory: string): SubagentSendMessageRequest {
  const sessionId = internal(runtime).sessionId;
  return { sessionId, parentToolCallId: "host-control", to: "", message: "", summary: "", workingDirectory: directory, workspaceRoot: directory,
    trace: { traceId: createTraceId(), sessionId } };
}
async function awaitTerminal(runtime: ReturnType<typeof createTestAgentRuntime>, path: string) {
  const core = internal(runtime);
  await vi.waitFor(() => {
    const task = Object.values(core.multiAgentRegistry!.all()).find((task) => task.multiAgent?.agentPath === path);
    expect(task?.status).toBe("completed");
  }, { timeout: 15_000, interval: 20 });
}

// These execute the production AgentRuntime/ToolScheduler/runner/SessionStore path with an
// explicitly injected local test Model. They do not claim an external provider or paid E2E.
describe("V2 production Runtime wiring with local model fixtures", () => {
  it("recursively exposes the six tools and inherits the parent's actual provider/model/effort for an implicit full fork", async () => {
    const directory = await workspace();
    const observations: Array<{ path: string; model: TestModelExecutionObservation["model"]; tools: string[] }> = [];
    const calls = new Map<string, number>();
    const runtime = createTestAgentRuntime(createSessionId(), {
      workingDirectory: directory, mode: "yolo", modelStreaming: "off", compact: { enabled: false }, titleGeneration: { enabled: false },
      multiAgentV2: { enabled: true, maxConcurrentThreadsPerSession: 8, maxResidentAgents: 8 },
      subagents: { outputRootDir: directory, profiles: [{ name: "worker", source: "user", description: "worker", systemPrompt: "WORKER_PROFILE", tools: ["*"],
        modelSelection: { providerId: "profile-provider", modelId: "profile-default", options: { reasoningLevel: "low" } } }] },
    }, { eventStore: createTestSessionEventStore(), sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: createTestModelFactory({ async generateText(request, observation) {
        const path = requestPath(request); const n = (calls.get(path) ?? 0) + 1; calls.set(path, n);
        observations.push({ path, model: observation.model, tools: request.tools?.map((tool) => tool.name) ?? [] });
        if (path === "/root" && n === 1) return { finishReason: "tool-calls", text: "", usage,
          toolCalls: [spawnCall("a", { fork_turns: "none", agent_type: "worker", model: "actual-provider/actual-model", reasoning_effort: "high" })] };
        if (path === "/root/a" && n === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [spawnCall("b")] };
        if (path === "/root/a/b" && n === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [spawnCall("c")] };
        if (path === "/root/a/b/c" && n === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [spawnCall("d")] };
        return textResult(`completed ${path}`);
      } }),
    }); runtimes.push(runtime);
    await runtime.executeTurn("delegate a recursive task");
    await awaitTerminal(runtime, "/root/a/b/c/d");
    for (const path of ["/root/a", "/root/a/b", "/root/a/b/c", "/root/a/b/c/d"]) {
      const request = observations.find((observation) => observation.path === path);
      expect(request?.model).toMatchObject({ providerId: "actual-provider", modelId: "actual-model", options: { reasoningLevel: "high" } });
      expect(request?.tools).toContain(multiAgentToolName("spawn_agent"));
    }
    for (const path of ["/root/a", "/root/a/b", "/root/a/b/c", "/root/a/b/c/d"]) await awaitTerminal(runtime, path);
    const deepest = resolveMultiAgentTarget(internal(runtime).multiAgentRegistry!, { agentPath: "/root", rootSessionId: internal(runtime).sessionId }, "/root/a/b/c/d");
    expect(deepest.control?.executionHostSessionId).toBe(internal(runtime).sessionId);
    expect(deepest.multiAgent?.resident).toBe(false);
    const events = await internal(runtime).eventStore.getEvents(internal(runtime).sessionId);
    const spawned = events.find((event) => event.type === SessionEventType.SubagentSpawned);
    expect(spawned?.payload).toMatchObject({ agentPath: "/root/a", model: "actual-provider/actual-model", reasoningEffort: "high" });
    const pathsAtRoot = events.filter((event) => event.type === SessionEventType.SubagentSpawned).map((event) => (event.payload as { agentPath?: string }).agentPath);
    expect(pathsAtRoot).toEqual(expect.arrayContaining(["/root/a", "/root/a/b", "/root/a/b/c", "/root/a/b/c/d"]));
    expect(pathsAtRoot.filter((path) => path === "/root/a/b/c/d")).toHaveLength(1);
    for (const path of ["/root/a", "/root/a/b"]) {
      const ancestor = resolveMultiAgentTarget(internal(runtime).multiAgentRegistry!, { agentPath: "/root", rootSessionId: internal(runtime).sessionId }, path);
      const eventsAtAncestor = await internal(runtime).eventStore.getEvents(ancestor.childSessionId!);
      const deepestSpawns = eventsAtAncestor.filter((event) => event.type === SessionEventType.SubagentSpawned && (event.payload as { agentPath?: string }).agentPath === "/root/a/b/c/d");
      expect(deepestSpawns).toHaveLength(1);
      expect(deepestSpawns[0]?.turnId).toBeUndefined();
      expect(deepestSpawns[0]?.payload).toMatchObject({ multiAgentTreeProjection: true });
    }
    const deepEvent = events.find((event) => event.type === SessionEventType.SubagentSpawned && (event.payload as { agentPath?: string }).agentPath === "/root/a/b/c/d");
    expect(deepEvent?.turnId).toBeUndefined();
    expect(deepEvent?.payload).toMatchObject({ parentAgentPath: "/root/a/b/c", multiAgentRootProjection: true });
    const usageEvent = events.find((event) => event.type === SessionEventType.SubagentMessage && (event.payload as { agentPath?: string }).agentPath === "/root/a/b/c/d");
    expect(usageEvent?.payload).toMatchObject({ totalTokens: 2, multiAgentUsage: { source: "provider", totalTokens: 2 }, model: "actual-provider/actual-model" });
    expect(usageEvent?.payload).not.toHaveProperty("message");
    expect(usageEvent?.payload).not.toHaveProperty("summaryText");
  }, 25_000);

  it.each((["local", "native"] as const).flatMap((searchMode) => [false, true].map((gated) => ({ searchMode, gated }))))(
    "keeps V2 schemas and child permissions consistent through $searchMode ToolSearch (gated=$gated)", async ({ searchMode, gated }) => {
      const directory = await workspace(); const namespace = "v2-surface";
      const names = MULTI_AGENT_OPERATIONS.map((operation) => multiAgentToolName(operation, namespace));
      const name = (operation: typeof MULTI_AGENT_OPERATIONS[number]) => multiAgentToolName(operation, namespace);
      const multiAgentV2 = { enabled: true, toolNamespace: namespace, disableDirectMessage: gated,
        waitAgentEnabled: !gated, exposeSpawnAgentModelOverrides: !gated };
      const entries = createMultiAgentToolEntries(multiAgentV2);
      const requests = new Map<string, ModelRequest[]>();
      const modelFactory = createTestModelFactory({ async generateText(request) {
        const path = requestPath(request); const observed = requests.get(path) ?? []; observed.push(structuredClone(request)); requests.set(path, observed);
        let toolCall;
        if (observed.length === 1) toolCall = { id: `catalog_${path.replaceAll("/", "_")}`, name: "ToolSearch", input: { query: `select:${names.join(",")}`, max_results: 10 } };
        else if (path === "/root" && observed.length === 2) toolCall = { id: "surface_spawn", name: name("spawn_agent"),
          input: { task_name: "reader", message: "Read the allowed catalog", fork_turns: "none", agent_type: "scoped" } };
        else if (path === "/root/reader" && observed.length === 2) toolCall = { id: "forbidden_spawn", name: name("spawn_agent"),
          input: { task_name: "forbidden", message: "Must be denied", fork_turns: "none" } };
        else if (path === "/root/reader" && observed.length === 3) toolCall = { id: "surface_list", name: name("list_agents"), input: {} };
        return toolCall ? { finishReason: "tool-calls", text: "", usage, toolCalls: [toolCall] } : textResult(`complete ${path}`);
      } });
      const wrap = (model: Model): Model => ({ ...model,
        requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
        bind: (options) => wrap(model.bind(options)),
      });
      const runtime = createTestAgentRuntime(createSessionId(), { workingDirectory: directory, mode: "yolo", modelStreaming: "off",
        compact: { enabled: false }, titleGeneration: { enabled: false }, toolSearch: { mode: searchMode }, multiAgentV2,
        subagents: { outputRootDir: directory, profiles: [{ name: "scoped", source: "user", description: "read-only V2 catalog",
          systemPrompt: "Scoped worker", tools: ["ToolSearch", "DeferredToolCall", "WebFetch", name("list_agents")] }] } }, {
        sessionStore: createRecordingSubagentSessionStore(), eventStore: createTestSessionEventStore(),
        modelFactory: (input) => wrap(modelFactory(input)),
      }); runtimes.push(runtime);
      await runtime.executeTurn("Find the collaboration tools and delegate a scoped catalog check");
      await awaitTerminal(runtime, "/root/reader");
      for (const path of ["/root", "/root/reader"]) {
        const observed = requests.get(path)!; const expected = path === "/root" ? entries : entries.filter((entry) => entry.metadata.name === name("list_agents"));
        for (const request of observed) {
          const exposed = request.tools?.filter((tool) => names.includes(tool.name)) ?? [];
          expect(exposed.map((tool) => tool.name).sort()).toEqual(expected.map((entry) => entry.metadata.name).sort());
          expect(new Set(exposed.map((tool) => tool.name)).size).toBe(exposed.length);
          for (const entry of expected) expect(exposed.find((tool) => tool.name === entry.metadata.name)?.inputSchema).toEqual(entry.inputSchema);
          expect(request.toolSearchEnabled).toBe(searchMode === "native");
        }
        const searchResult = observed[1]!.messages.find((message) => message.role === "tool" && message.toolCallId === `catalog_${path.replaceAll("/", "_")}`)!;
        expect(searchResult.isError).not.toBe(true);
        if (searchMode === "native") {
          expect(searchResult.content).toEqual(expected.map((entry) => ({ type: "tool_reference", toolName: entry.metadata.name })));
        } else {
          const text = Array.isArray(searchResult.content) ? searchResult.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : searchResult.content;
          const definitions = [...String(text).matchAll(/<function>(.*?)<\/function>/gs)].map((match) => JSON.parse(match[1]!));
          expect(definitions.map((definition) => ({ name: definition.name, parameters: definition.parameters }))).toEqual(
            expected.map((entry) => ({ name: entry.metadata.name, parameters: entry.inputSchema })));
          expect(text).not.toContain("Call them now with DeferredToolCall");
        }
      }
      const childRequests = requests.get("/root/reader")!;
      expect(childRequests[2]!.messages.find((message) => message.toolCallId === "forbidden_spawn")).toMatchObject({ isError: true });
      const listResult = childRequests[3]!.messages.find((message) => message.toolCallId === "surface_list");
      expect(listResult?.isError).not.toBe(true); expect(JSON.stringify(listResult?.content)).toContain("/root/reader");
      const agents = Object.values(internal(runtime).multiAgentRegistry!.all()).filter((task) => task.multiAgent);
      expect(agents.map((task) => task.multiAgent!.agentPath).sort()).toEqual(["/root", "/root/reader"]);
    }, 25_000,
  );

  it.each([true, false])("projects the explicit preserveForkPrefix=%s branch into a real child request", async (preserveForkPrefix) => {
    const directory = await workspace(); let rootCalls = 0; const childRequests: ModelRequest[] = [];
    const runtime = createTestAgentRuntime(createSessionId(), { workingDirectory: directory, mode: "yolo", modelStreaming: "off",
      compact: { enabled: false }, titleGeneration: { enabled: false }, multiAgentV2: { enabled: true, preserveForkPrefix }, subagents: { outputRootDir: directory } }, {
      eventStore: createTestSessionEventStore(), sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: createTestModelFactory({ async generateText(request, observation) {
        if (observation.invocationContext?.metadata?.querySource === "subagent") { childRequests.push(request); return textResult("child result"); }
        rootCalls++;
        return rootCalls === 2 ? { finishReason: "tool-calls", text: "", usage, toolCalls: [spawnCall("fork")] } : textResult("parent result");
      } }),
    }); runtimes.push(runtime);
    await runtime.executeTurn("PARENT_VISIBLE_HISTORY");
    await runtime.executeTurn("fork the task");
    await awaitTerminal(runtime, "/root/fork");
    const prefix = JSON.stringify(childRequests[0]?.messages.filter((message) => message.role === "system"));
    expect(prefix).toContain("Task path: /root/fork");
    expect(prefix.includes("Task path: /root\\n")).toBe(preserveForkPrefix);
    expect(JSON.stringify(childRequests[0]?.messages)).toContain("PARENT_VISIBLE_HISTORY");
  }, 25_000);

  it.each(["reactive", "auto"] as const)("retains the child's own context through %s compact and cold followup without replaying the original fork", async (trigger) => {
    const directory = await workspace(); const sessionId = createSessionId();
    const store = createRecordingSubagentSessionStore(); const eventStore = createTestSessionEventStore();
    let rootCalls = 0; let compactCalls = 0; const childRequests: ModelRequest[] = [];
    const config = { workingDirectory: directory, mode: "yolo" as const, modelStreaming: "off" as const,
      compact: { enabled: true, contextWindow: 1_000_000, bufferTokens: 10, summaryReserveTokens: 0, microcompact: { enabled: false } },
      titleGeneration: { enabled: false }, multiAgentV2: { enabled: true, preserveForkPrefix: true },
      subagents: { outputRootDir: directory, profiles: [{ name: "worker", source: "user" as const, description: "worker",
        systemPrompt: "CHILD_ROLE_SENTINEL", tools: ["*"] }] } };
    const modelFactory = createTestModelFactory({ async generateText(request, observation) {
      if (JSON.stringify(request.messages).includes("create a detailed summary")) {
        compactCalls++; return textResult("<summary>FORK_SUMMARY_SENTINEL</summary>");
      }
      if (observation.invocationContext?.metadata?.querySource === "subagent") {
        childRequests.push(request);
        if (childRequests.length === 1) {
          if (trigger === "reactive") throw createCoreError(CoreErrorType.ModelContextExceeded, "prompt is too long", { retryable: false, recoverable: true });
          return { finishReason: "length", text: "unfinished", usage: { inputTokens: 1_000_000, outputTokens: 1, totalTokens: 1_000_001 } };
        }
        return textResult("child complete");
      }
      rootCalls++;
      return rootCalls === 2 ? { finishReason: "tool-calls", text: "", usage, toolCalls: [spawnCall("fork", { agent_type: "worker" })] } : textResult("root complete");
    } });
    const first = createTestAgentRuntime(sessionId, config, { sessionStore: store, eventStore, modelFactory }); runtimes.push(first);
    await first.executeTurn("PARENT_HISTORY_BEFORE_COMPACT");
    await first.executeTurn("delegate the fork");
    await awaitTerminal(first, "/root/fork");
    expect(compactCalls).toBeGreaterThan(0);
    const continued = JSON.stringify(childRequests[1]?.messages);
    expect(continued).toContain("Task path: /root/fork");
    expect(continued).toContain("CHILD_ROLE_SENTINEL");
    expect(continued).toContain("NEW_TASK, MESSAGE, and FINAL_ANSWER");
    expect(continued).toContain("FORK_SUMMARY_SENTINEL");
    const child = resolveMultiAgentTarget(internal(first).multiAgentRegistry!, { agentPath: "/root", rootSessionId: sessionId }, "fork");
    const childEvents = await eventStore.getEvents(child.childSessionId!);
    expect(childEvents.some((event) => event.type === SessionEventType.CompactBoundary && (event.payload as { trigger?: string }).trigger === trigger)).toBe(true);
    await internal(first).multiAgentPersistence!.flush(); first.beginShutdown();
    const second = createTestAgentRuntime(sessionId, config, { sessionStore: store, eventStore, modelFactory }); runtimes.push(second);
    await internal(second).multiAgentPersistence!.ready;
    await internal(second).subagentPort!.multiAgent!.execute("followup_task", { target: "fork", message: "AFTER_COLD_COMPACT" }, context(second, directory));
    await awaitTerminal(second, "/root/fork");
    const cold = JSON.stringify(childRequests.at(-1)?.messages);
    expect(cold).toContain("Task path: /root/fork"); expect(cold).toContain("CHILD_ROLE_SENTINEL");
    expect(cold).toContain("FORK_SUMMARY_SENTINEL"); expect(cold).toContain("AFTER_COLD_COMPACT");
    expect(cold).not.toContain("PARENT_HISTORY_BEFORE_COMPACT");
  }, 25_000);

  it("keeps real child and grandchild model requests alive after the main turn is stopped", async () => {
    const directory = await workspace(); const mainAbort = new AbortController();
    const childrenMayFinish = Promise.withResolvers<void>();
    const observed = new Map<string, AbortSignal | undefined>(); const calls = new Map<string, number>();
    const runtime = createTestAgentRuntime(createSessionId(), { workingDirectory: directory, mode: "yolo", modelStreaming: "off",
      compact: { enabled: false }, titleGeneration: { enabled: false }, multiAgentV2: { enabled: true }, subagents: { outputRootDir: directory } }, {
      eventStore: createTestSessionEventStore(), sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: createTestModelFactory({ async generateText(request) {
        const path = requestPath(request); const n = (calls.get(path) ?? 0) + 1; calls.set(path, n);
        if (path === "/root" && n === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [spawnCall("child", { fork_turns: "none" })] };
        if (path === "/root/child" && n === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [spawnCall("grandchild", { fork_turns: "none" })] };
        observed.set(path, request.abortSignal);
        if (path === "/root") {
          await new Promise<never>((_resolve, reject) => {
            if (request.abortSignal?.aborted) reject(request.abortSignal.reason);
            else request.abortSignal?.addEventListener("abort", () => reject(request.abortSignal?.reason), { once: true });
          });
        } else await childrenMayFinish.promise;
        return textResult(`finished ${path}`);
      } }),
    }); runtimes.push(runtime);
    const result = runtime.executeTurn("delegate independent descendants", undefined, { abortSignal: mainAbort.signal }).then(
      () => ({ stopped: false }), () => ({ stopped: true }),
    );
    try {
      await vi.waitFor(() => expect([...observed.keys()]).toEqual(expect.arrayContaining(["/root", "/root/child", "/root/child/grandchild"])), { timeout: 15_000, interval: 20 });
      mainAbort.abort(new Error("Main Stop"));
      expect(await result).toEqual({ stopped: true });
      expect(observed.get("/root/child")?.aborted).toBe(false);
      expect(observed.get("/root/child/grandchild")?.aborted).toBe(false);
    } finally { mainAbort.abort(new Error("test cleanup")); childrenMayFinish.resolve(); await result; }
    await awaitTerminal(runtime, "/root/child"); await awaitTerminal(runtime, "/root/child/grandchild");
    const root = Object.values(internal(runtime).multiAgentRegistry!.all()).find((task) => task.multiAgent?.agentPath === "/root");
    expect(root?.pendingMessages?.some((message) => message.messageType === "FINAL_ANSWER")).toBe(true);
  }, 25_000);

  it("restores the same child session and original transcript in a new Runtime instance", async () => {
    const directory = await workspace(); const sessionId = createSessionId();
    const store = createRecordingSubagentSessionStore(); const eventStore = createTestSessionEventStore();
    const requests: ModelRequest[] = [];
    const modelFactory = createTestModelFactory({ async generateText(request) { requests.push(request); return textResult("FIRST_CHILD_RESULT"); } });
    const config = { workingDirectory: directory, mode: "yolo" as const, modelStreaming: "off" as const,
      compact: { enabled: false }, titleGeneration: { enabled: false }, multiAgentV2: { enabled: true }, subagents: { outputRootDir: directory } };
    const first = createTestAgentRuntime(sessionId, config, { sessionStore: store, eventStore, modelFactory }); runtimes.push(first);
    await internal(first).subagentPort!.multiAgent!.execute("spawn_agent", { task_name: "worker", message: "FIRST_CHILD_TASK", fork_turns: "none" }, context(first, directory));
    await awaitTerminal(first, "/root/worker");
    await internal(first).subagentPort!.multiAgent!.execute("send_message", { target: "worker", message: "MAIL_BEFORE_COLD_FOLLOWUP" }, context(first, directory));
    expect(requests).toHaveLength(1);
    await internal(first).multiAgentPersistence!.flush();
    const original = resolveMultiAgentTarget(internal(first).multiAgentRegistry!, { agentPath: "/root", rootSessionId: sessionId }, "worker");
    first.beginShutdown();
    const second = createTestAgentRuntime(sessionId, config, { sessionStore: store, eventStore, modelFactory }); runtimes.push(second);
    await internal(second).multiAgentPersistence!.ready;
    await internal(second).subagentPort!.multiAgent!.execute("followup_task", { target: "/root/worker", message: "SECOND_CHILD_TASK" }, context(second, directory));
    await awaitTerminal(second, "/root/worker");
    const resumed = resolveMultiAgentTarget(internal(second).multiAgentRegistry!, { agentPath: "/root", rootSessionId: sessionId }, "worker");
    expect(resumed.agentId).toBe(original.agentId); expect(resumed.childSessionId).toBe(original.childSessionId);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("FIRST_CHILD_TASK");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("FIRST_CHILD_RESULT");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("SECOND_CHILD_TASK");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages).split("MAIL_BEFORE_COLD_FOLLOWUP")).toHaveLength(2);
    expect(resumed.pendingMessages?.some((message) => message.message === "MAIL_BEFORE_COLD_FOLLOWUP")).toBe(false);
    expect(resumed.multiAgent?.runGeneration).toBe(2);
  }, 25_000);

  it("keeps legacy SendMessage and V2 followup on the same grandchild while V2 send_message only queues", async () => {
    const directory = await workspace(); const sessionId = createSessionId();
    const store = createRecordingSubagentSessionStore();
    const childRequests: Array<{ request: ModelRequest; model: TestModelExecutionObservation["model"] }> = [];
    let rootCalls = 0; let parentCalls = 0; let childId = "";
    const runtime = createTestAgentRuntime(sessionId, {
      workingDirectory: directory, mode: "yolo", modelStreaming: "off", compact: { enabled: false }, titleGeneration: { enabled: false },
      multiAgentV2: { enabled: true }, subagents: { outputRootDir: directory,
        profiles: [{ name: "specialist", source: "user", description: "specialist", systemPrompt: "RETAINED_SPECIALIST_PROFILE", tools: ["*"],
          modelSelection: { providerId: "profile-provider", modelId: "profile-model", options: { reasoningLevel: "high" } } }] },
    }, { sessionStore: store, eventStore: createTestSessionEventStore(), modelFactory: createTestModelFactory({ async generateText(request, observation) {
      const path = requestPath(request);
      if (path === "/root" && ++rootCalls === 1) return { finishReason: "tool-calls", text: "", usage, toolCalls: [{
        id: "legacy_resume_grandchild", name: "SendMessage", input: { to: childId, summary: "resume original worker", message: "LEGACY_RESUME_TASK" },
      }] };
      if (path === "/root/parent" && ++parentCalls === 1) return { finishReason: "tool-calls", text: "", usage,
        toolCalls: [spawnCall("worker", { fork_turns: "none", agent_type: "specialist" })] };
      if (path === "/root/parent/worker") childRequests.push({ request, model: observation.model });
      return textResult(`completed ${path}`);
    } }) }); runtimes.push(runtime);
    const core = internal(runtime); const control = core.subagentPort!.multiAgent!;
    const target = () => resolveMultiAgentTarget(core.multiAgentRegistry!, { agentPath: "/root", rootSessionId: sessionId }, "/root/parent/worker");
    await control.execute("spawn_agent", { task_name: "parent", message: "Delegate a specialist worker", fork_turns: "none", agent_type: "specialist" }, context(runtime, directory));
    await awaitTerminal(runtime, "/root/parent"); await awaitTerminal(runtime, "/root/parent/worker");
    const original = target(); childId = original.agentId;
    const parentSessionId = original.parentSessionId;
    expect(parentSessionId).not.toBe(sessionId);
    await control.execute("send_message", { target: "/root/parent/worker", message: "QUEUE_ONLY_BEFORE_RESUME" }, context(runtime, directory));
    expect(childRequests).toHaveLength(1);
    expect(target().status).toBe("completed");
    expect(target().pendingMessages?.map((message) => message.message)).toEqual(["QUEUE_ONLY_BEFORE_RESUME"]);
    await runtime.executeTurn("Use the legacy message tool to resume the original grandchild");
    await awaitTerminal(runtime, "/root/parent/worker");
    expect(childRequests).toHaveLength(2);
    const resumedHistory = JSON.stringify(childRequests[1]!.request.messages);
    expect(resumedHistory).toContain("LEGACY_RESUME_TASK");
    expect(resumedHistory.split("QUEUE_ONLY_BEFORE_RESUME")).toHaveLength(2);
    expect(target().pendingMessages).toHaveLength(0);
    await control.execute("followup_task", { target: "/root/parent/worker", message: "V2_FOLLOWUP_TASK" }, context(runtime, directory));
    await awaitTerminal(runtime, "/root/parent/worker");
    expect(childRequests).toHaveLength(3);
    expect(JSON.stringify(childRequests[2]!.request.messages)).toContain("V2_FOLLOWUP_TASK");
    for (const { request, model } of childRequests) {
      expect(JSON.stringify(request.messages.filter((message) => message.role === "system"))).toContain("RETAINED_SPECIALIST_PROFILE");
      expect(model).toMatchObject({ providerId: "profile-provider", modelId: "profile-model", options: { reasoningLevel: "high" } });
    }
    expect(target()).toMatchObject({ agentId: original.agentId, childSessionId: original.childSessionId, parentSessionId,
      multiAgent: { agentPath: "/root/parent/worker", parentPath: "/root/parent", runGeneration: 3 } });
    expect((await store.getSession(original.childSessionId!))?.parentID).toBe(parentSessionId);
    expect(Object.values(core.multiAgentRegistry!.all()).filter((task) => task.multiAgent?.agentPath === "/root/parent/worker")).toHaveLength(1);
  }, 25_000);

  it.each(["SPECIALIST_DEVELOPER_SENTINEL", ""])("freezes default-grandchild developer guidance %j across root rebinding and cold reuse", async (parentGuidance) => {
    const directory = await workspace(); const sessionId = createSessionId();
    const store = createRecordingSubagentSessionStore(); const eventStore = createTestSessionEventStore();
    const requests: ModelRequest[] = []; const calls = new Map<string, number>();
    const modelFactory = createTestModelFactory({ async generateText(request) {
      const path = requestPath(request); const count = (calls.get(path) ?? 0) + 1; calls.set(path, count);
      if (path === "/root/parent" && count === 1) return { finishReason: "tool-calls", text: "", usage,
        toolCalls: [spawnCall("worker", { fork_turns: "none" })] };
      if (path === "/root/parent/worker") requests.push(request);
      return textResult(`complete ${path}`);
    } });
    const config = { workingDirectory: directory, mode: "yolo" as const, modelStreaming: "off" as const,
      compact: { enabled: false }, titleGeneration: { enabled: false }, systemPrompt: "ROOT_DEVELOPER_MUST_NOT_LEAK",
      multiAgentV2: { enabled: true }, subagents: { outputRootDir: directory,
        profiles: [{ name: "specialist", source: "user" as const, description: "specialist", systemPrompt: parentGuidance, tools: ["*"] }] } };
    const first = createTestAgentRuntime(sessionId, config, { sessionStore: store, eventStore, modelFactory }); runtimes.push(first);
    await internal(first).subagentPort!.multiAgent!.execute("spawn_agent", { task_name: "parent", message: "Create a default fresh worker", fork_turns: "none", agent_type: "specialist" }, context(first, directory));
    await awaitTerminal(first, "/root/parent"); await awaitTerminal(first, "/root/parent/worker");
    const original = resolveMultiAgentTarget(internal(first).multiAgentRegistry!, { agentPath: "/root", rootSessionId: sessionId }, "/root/parent/worker");
    expect(original.control?.executionHostSessionId).toBe(sessionId);
    await internal(first).subagentPort!.multiAgent!.execute("followup_task", { target: "/root/parent/worker", message: "ROOT_REBOUND_FOLLOWUP" }, context(first, directory));
    await awaitTerminal(first, "/root/parent/worker");
    await internal(first).multiAgentPersistence!.flush(); first.beginShutdown();
    const second = createTestAgentRuntime(sessionId, { ...config, systemPrompt: "CHANGED_ROOT_DEVELOPER",
      multiAgentV2: { enabled: true, subagentDeveloperInstructions: "LATER_ROOT_OVERRIDE_MUST_NOT_LEAK" } }, { sessionStore: store, eventStore, modelFactory }); runtimes.push(second);
    await internal(second).multiAgentPersistence!.ready;
    await internal(second).subagentPort!.multiAgent!.execute("followup_task", { target: "/root/parent/worker", message: "COLD_ROOT_FOLLOWUP" }, context(second, directory));
    await awaitTerminal(second, "/root/parent/worker");
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const systems = JSON.stringify(request.messages.filter((message) => message.role === "system"));
      if (parentGuidance) expect(systems).toContain(parentGuidance);
      expect(systems).not.toContain("ROOT_DEVELOPER_MUST_NOT_LEAK");
      expect(systems).not.toContain("CHANGED_ROOT_DEVELOPER");
      expect(systems).not.toContain("LATER_ROOT_OVERRIDE_MUST_NOT_LEAK");
    }
    const restored = resolveMultiAgentTarget(internal(second).multiAgentRegistry!, { agentPath: "/root", rootSessionId: sessionId }, "/root/parent/worker");
    expect(restored.agentId).toBe(original.agentId); expect(restored.childSessionId).toBe(original.childSessionId);
    expect(restored.multiAgent?.runGeneration).toBe(3);
    expect(restored.resumeState?.request.inheritedDeveloperInstructions).toBe(parentGuidance);
  }, 25_000);

  it.each([
    { label: "reapplies a tightened parent Plan ceiling after restoring an older writable child", initialMode: "yolo", next: { planEnabled: true }, expectedMode: "yolo", expectedPlan: true },
    { label: "retains an original Build ceiling when the current parent uses Guarded", initialMode: "build", next: { mode: "guarded" }, expectedMode: "build", expectedPlan: false },
    { label: "retains reserved Auto denial when a Profile requests edit permission", initialMode: "auto", next: { mode: "auto" }, expectedMode: "auto", expectedPlan: false, profilePermissionMode: "acceptEdits" },
  ] as const)("$label", async (scenario) => {
    const directory = await workspace(); const filePath = join(directory, "must-not-write.txt");
    const fileSystemPort = new MemoryFileSystem({}); const store = createRecordingSubagentSessionStore();
    let calls = 0;
    const runtime = createTestAgentRuntime(createSessionId(), { workingDirectory: directory, mode: scenario.initialMode, modelStreaming: "off",
      compact: { enabled: false }, titleGeneration: { enabled: false }, multiAgentV2: { enabled: true },
      subagents: { outputRootDir: directory, profiles: [{ name: "writable", source: "user", description: "write-capable worker",
        systemPrompt: "Writable worker", tools: ["Write"], ...("profilePermissionMode" in scenario ? { permissionMode: scenario.profilePermissionMode } : {}) }] } }, {
      sessionStore: store, eventStore: createTestSessionEventStore(), fileSystemPort,
      permissionBroker: { async requestPermission() { return { decision: "deny" }; } },
      modelFactory: createTestModelFactory({ async generateText() {
        calls++;
        return calls === 2 ? { finishReason: "tool-calls", text: "", usage,
          toolCalls: [{ id: "write-after-parent-plan", name: "Write", input: { file_path: filePath, content: "must remain absent" } }] } : textResult("complete");
      } }),
    }); runtimes.push(runtime);
    const core = internal(runtime);
    const permission = vi.spyOn(core.permissionService, "checkPermission");
    await core.subagentPort!.multiAgent!.execute("spawn_agent", { task_name: "worker", message: "FIRST_TASK", fork_turns: "none", agent_type: "writable" }, context(runtime, directory));
    await awaitTerminal(runtime, "/root/worker");
    await runtime.setExecutionState(scenario.next);
    await core.subagentPort!.multiAgent!.execute("followup_task", { target: "worker", message: "TRY_WRITE_UNDER_CURRENT_PLAN" }, context(runtime, directory));
    await awaitTerminal(runtime, "/root/worker");
    const writeContext = permission.mock.calls.find(([input]) => input.toolName === "Write")?.[0];
    expect(writeContext).toMatchObject({ mode: scenario.expectedMode, planEnabled: scenario.expectedPlan });
    expect(fileSystemPort.files[filePath]).toBeUndefined();
    const child = resolveMultiAgentTarget(core.multiAgentRegistry!, { agentPath: "/root", rootSessionId: core.sessionId }, "worker");
    expect(child.multiAgent?.runGeneration).toBe(2);
    const entries = await store.sessionEntries!({ sessionID: child.childSessionId!, type: "runtime/execution_state" });
    expect(entries.at(-1)?.data).toMatchObject({ mode: scenario.expectedMode, planEnabled: scenario.expectedPlan });
  }, 25_000);

  it("continues a failed child through its retained identity after a non-retryable model failure", async () => {
    const directory = await workspace(); let calls = 0;
    const runtime = createTestAgentRuntime(createSessionId(), { workingDirectory: directory, mode: "yolo", modelStreaming: "off",
      compact: { enabled: false }, titleGeneration: { enabled: false }, multiAgentV2: { enabled: true }, subagents: { outputRootDir: directory } }, {
      eventStore: createTestSessionEventStore(), sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: createTestModelFactory({ async generateText() {
        if (++calls === 1) throw createCoreError(CoreErrorType.ModelError, "invalid request fixture", { retryable: false, recoverable: false, context: { statusCode: 400 } });
        return textResult("RECOVERED_CHILD_RESULT");
      } }),
    }); runtimes.push(runtime);
    const core = internal(runtime); const identity = { agentPath: "/root", rootSessionId: core.sessionId };
    await core.subagentPort!.multiAgent!.execute("spawn_agent", { task_name: "worker", message: "FIRST_TASK", fork_turns: "none" }, context(runtime, directory));
    await vi.waitFor(() => expect(resolveMultiAgentTarget(core.multiAgentRegistry!, identity, "worker").status).toBe("failed"), { timeout: 15_000, interval: 20 });
    expect(calls).toBe(1);
    const failed = resolveMultiAgentTarget(core.multiAgentRegistry!, identity, "worker");
    expect(failed.multiAgent?.resident).toBe(false);
    await core.subagentPort!.multiAgent!.execute("followup_task", { target: "worker", message: "SECOND_TASK" }, context(runtime, directory));
    await awaitTerminal(runtime, "/root/worker");
    const recovered = resolveMultiAgentTarget(core.multiAgentRegistry!, identity, "worker");
    expect(recovered.agentId).toBe(failed.agentId); expect(recovered.childSessionId).toBe(failed.childSessionId);
    expect(recovered.output).toMatchObject({ content: [{ text: "RECOVERED_CHILD_RESULT" }] });
    expect(calls).toBe(2);
  }, 25_000);

  it("enforces cumulative root/child usage at the actual next model request", async () => {
    const directory = await workspace(); let modelCalls = 0;
    const runtime = createTestAgentRuntime(createSessionId(), { workingDirectory: directory, mode: "yolo", modelStreaming: "off",
      compact: { enabled: false }, titleGeneration: { enabled: false }, multiAgentV2: { enabled: true, tokenBudget: 4 }, subagents: { outputRootDir: directory } }, {
      eventStore: createTestSessionEventStore(), sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: createTestModelFactory({ async generateText() { modelCalls++; return textResult("done"); } }),
    }); runtimes.push(runtime);
    const core = internal(runtime);
    // Consume root usage first. Ordinary child mail stays queued after final text;
    // only an already-required model request is subject to the next budget admission.
    await runtime.executeTurn("main initial step");
    await core.subagentPort!.multiAgent!.execute("spawn_agent", { task_name: "worker", message: "child", fork_turns: "none" }, context(runtime, directory));
    await awaitTerminal(runtime, "/root/worker");
    expect(getMultiAgentUsage(core.multiAgentRegistry!, core.sessionId).totalTokens).toBe(4);
    const before = modelCalls;
    await expect(runtime.executeTurn("must not request more tokens")).rejects.toMatchObject({
      cause: { context: { code: "multi_agent_token_budget", usedTokens: 4, tokenBudget: 4 } },
    });
    expect(modelCalls).toBe(before);
    await expect(core.subagentPort!.multiAgent!.execute("followup_task", { target: "worker", message: "also blocked" }, context(runtime, directory))).rejects.toThrow("token budget");
  }, 25_000);

  it("retains Explore read-only restrictions even when V2 recursion is enabled", async () => {
    const directory = await workspace(); const tools: string[][] = [];
    const runtime = createTestAgentRuntime(createSessionId(), { workingDirectory: directory, mode: "yolo", modelStreaming: "off",
      compact: { enabled: false }, titleGeneration: { enabled: false }, multiAgentV2: { enabled: true }, subagents: { outputRootDir: directory } }, {
      eventStore: createTestSessionEventStore(), sessionStore: createRecordingSubagentSessionStore(),
      modelFactory: createTestModelFactory({ async generateText(request) { tools.push(request.tools?.map((tool) => tool.name) ?? []); return textResult("read only"); } }),
    }); runtimes.push(runtime);
    await internal(runtime).subagentPort!.multiAgent!.execute("spawn_agent", { task_name: "reader", agent_type: "Explore", message: "read", fork_turns: "none" }, context(runtime, directory));
    await awaitTerminal(runtime, "/root/reader");
    expect(tools[0]).not.toContain("Write"); expect(tools[0]).not.toContain("Edit");
    expect(tools[0]).not.toContain(multiAgentToolName("spawn_agent"));
  }, 25_000);
});
