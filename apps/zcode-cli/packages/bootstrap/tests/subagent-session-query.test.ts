import { loadPersistedConversationMaterialization } from "../src/zcode-protocol-v4/agent-communication/materialize.js";
import { mergeColdConversationEvents } from "../src/zcode-protocol-v4/cold-event-merge.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  STREAM_RECOVERY_DISCARDED_FINISH,
  type MessageWithParts,
  type SessionEvent,
  type SessionInfo,
  type SessionProjection,
  type ToolPart,
} from "@zcode/contracts";
import {
  paginateEndedSubagents,
  projectSessionSubagents,
  readSubagentTree,
} from "../src/zcode-protocol/subagent-session-query.js";

function session(id: string, taskType: SessionInfo["taskType"] = "subagent_child"): SessionInfo {
  return {
    id: id as SessionInfo["id"],
    projectID: "project" as SessionInfo["projectID"],
    taskType,
    slug: id,
    directory: "/workspace",
    title: id,
    version: "test",
    time: { created: 1, updated: 100 },
  };
}

function toolMessage(input: {
  childSessionId?: string;
  id: string;
  output?: Record<string, unknown> | string;
  runInBackground?: boolean;
  state?: "completed" | "error" | "running";
  tool?: string;
}): MessageWithParts {
  const state = input.state ?? "completed";
  const common = {
    input: {
      description: `Description ${input.id}`,
      subagent_type: "Explore",
      ...(input.runInBackground ? { run_in_background: true } : {}),
    },
    metadata: input.childSessionId ? { childSessionId: input.childSessionId } : {},
    time: state === "running" ? { start: 10 } : { start: 10, end: 20 },
  };
  const part: ToolPart = {
    id: `part-${input.id}` as ToolPart["id"],
    sessionID: "parent" as ToolPart["sessionID"],
    messageID: input.id as ToolPart["messageID"],
    type: "tool",
    callID: `call-${input.id}`,
    tool: input.tool ?? "Agent",
    state:
      state === "running"
        ? { ...common, status: "running" }
        : state === "error"
          ? { ...common, status: "error", error: "Provider failed" }
          : {
              ...common,
              status: "completed",
              output:
                typeof input.output === "string"
                  ? input.output
                  : JSON.stringify(input.output ?? { result: `Summary ${input.id}` }),
              title: `Description ${input.id}`,
            },
  };
  return {
    info: {
      id: input.id as never,
      sessionID: "parent" as never,
      role: "assistant",
      time: { created: 10, completed: 20 },
      parentID: "user" as never,
      modelID: "model" as never,
      providerID: "provider" as never,
      mode: "build",
      agent: "zcode",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [part],
  };
}

function projection(status: SessionProjection["status"]): SessionProjection {
  return {
    id: "child" as never,
    createdAt: new Date(1),
    updatedAt: new Date(2),
    mode: "build",
    status,
    turnCount: 1,
    totalTokenCount: 0,
    contextUsed: 0,
    contextWindow: 1,
    pendingPermissions: [],
    pendingSteerInputs: [],
    activeToolCalls: [],
    streamingToolLedger: [],
    backgroundTasks: [],
    targetCompletionVerifications: [],
    targetCompletionVerificationTimeline: [],
  };
}

function subagentEvent(
  type: typeof SessionEventType.SubagentSpawned | typeof SessionEventType.SubagentStopped,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    id: "event" as never,
    sessionId: "parent" as never,
    type,
    timestamp: new Date(15),
    traceId: "trace" as never,
    sequenceNumber: 1,
    payload,
  };
}

describe("subagent session query", () => {
  it("projects Agent and legacy Task refs but omits non-persisted children", () => {
    const result = projectSessionSubagents({
      revision: 3,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({ childSessionId: "child-agent", id: "m1" }),
        toolMessage({ childSessionId: "child-task", id: "m2", tool: "Task" }),
        toolMessage({ childSessionId: "missing", id: "m3" }),
      ],
      childSessionsById: new Map([
        ["child-agent", session("child-agent")],
        ["child-task", session("child-task")],
      ]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    });

    expect(result.running).toEqual([]);
    expect(result.ended.map((item) => item.childSessionId)).toEqual(["child-task", "child-agent"]);
    expect(result.ended[0]).toMatchObject({
      status: "success",
      subagentType: "Explore",
      summary: "Summary m2",
    });
  });

  it("uses live child and background state without duplicating the persisted ref", () => {
    const parentProjection = projection("running");
    parentProjection.backgroundTasks = [
      {
        taskId: "agent-1",
        taskKind: "subagent",
        childSessionId: "child-1",
        blocked: true,
        status: "running",
        startedAt: new Date(10),
      },
    ];
    const result = projectSessionSubagents({
      revision: 4,
      parentSession: session("parent", "interactive"),
      messages: [toolMessage({ childSessionId: "child-1", id: "m1", state: "running" })],
      childSessionsById: new Map([["child-1", session("child-1")]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map([["child-1", projection("waiting")]]),
      parentProjection,
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId: "child-1", status: "blocked" }),
    ]);
  });

  it("uses live spawn events for foreground children before the Agent result is persisted", () => {
    const parentProjection = projection("running");
    parentProjection.backgroundTasks = [
      {
        taskId: "agent-live",
        taskKind: "subagent",
        childSessionId: "child-live",
        status: "running",
        startedAt: new Date(10),
      },
    ];
    const result = projectSessionSubagents({
      revision: 5,
      parentSession: session("parent", "interactive"),
      messages: [toolMessage({ id: "m1", state: "running" })],
      childSessionsById: new Map([["child-live", session("child-live")]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-live",
          agentType: "Explore",
          childSessionId: "child-live",
          parentToolCallId: "call-m1",
          description: "Live foreground Agent",
        }),
      ],
      parentProjection,
    });

    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId: "child-live", status: "running" }),
    ]);
  });

  it("keeps a launched background child running when a partial projection omits its task", () => {
    const childSessionId = "sess_subagent_agent-keepalive";
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-keepalive\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, []]]),
      childProjectionsById: new Map(),
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("keeps an accepted V2 child running while its first turn has not started", () => {
    const childSessionId = "child-before-first-turn";
    const initialProjection = projection("idle");
    initialProjection.turnCount = 0;
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [toolMessage({ childSessionId, id: "v2-launch",
        tool: "collaboration_spawn_agent", output: { task_name: "/root/reader" } })],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, []]]),
      childProjectionsById: new Map([[childSessionId, initialProjection]]),
      parentProjection: projection("completed"),
      parentEvents: [subagentEvent(SessionEventType.SubagentSpawned, {
        parentToolCallId: "call-v2-launch", agentId: "reader", childSessionId,
        agentPath: "/root/reader", status: "running",
      })],
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, agentPath: "/root/reader", status: "running" }),
    ]);
  });

  it.each([false, true])("respects an explicit terminal notification and clears it on a newer spawn (%s)", (resumed) => {
    const events = [subagentEvent(SessionEventType.SubagentStopped, {
      parentToolCallId: "call-stop", agentId: "reader", childSessionId: "child", status: "stopped",
    })];
    if (resumed) events.push(subagentEvent(SessionEventType.SubagentSpawned, {
      parentToolCallId: "call-stop", agentId: "reader", childSessionId: "child", status: "running",
    }));
    const result = projectSessionSubagents({
      revision: 9, parentSession: session("parent", "interactive"),
      messages: [toolMessage({ childSessionId: "child", id: "stop", tool: "collaboration_spawn_agent",
        output: { task_name: "/root/reader" } })],
      childSessionsById: new Map([["child", session("child")]]),
      childMessagesById: new Map([["child", []]]),
      childProjectionsById: new Map([["child", projection("running")]]),
      parentEvents: events,
    });
    if (resumed) {
      expect(result.ended).toEqual([]);
      expect(result.running[0]?.status).toBe("running");
    } else {
      expect(result.running).toEqual([]);
      expect(result.ended[0]?.status).toBe("cancelled");
    }
  });

  it.each([
    ["completed", "success"], ["failed", "failed"], ["cancelled", "cancelled"],
  ] as const)("keeps an idle startup projection terminal after a %s notification", (status, expected) => {
    const childSessionId = "child-stopped-before-first-turn";
    const result = projectSessionSubagents({
      revision: 7,
      parentSession: session("parent", "interactive"),
      messages: [toolMessage({ childSessionId, id: "v2-launch",
        tool: "collaboration_spawn_agent", output: { task_name: "/root/reader" } })],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, []]]),
      childProjectionsById: new Map([[childSessionId, projection("idle")]]),
      parentEvents: [subagentEvent(SessionEventType.SubagentStopped, {
        parentToolCallId: "call-v2-launch", agentId: "reader", childSessionId, status,
      })],
    });
    expect(result.running).toEqual([]);
    expect(result.ended).toEqual([expect.objectContaining({ childSessionId, status: expected })]);
  });

  it("does not revive an idle child after its completed first turn", () => {
    const childProjection = projection("idle");
    childProjection.turnCount = 1;
    const result = projectSessionSubagents({
      revision: 8, parentSession: session("parent", "interactive"),
      messages: [toolMessage({ childSessionId: "finished", id: "done", tool: "collaboration_spawn_agent",
        output: { task_name: "/root/finished" } })],
      childSessionsById: new Map([["finished", session("finished")]]),
      childMessagesById: new Map([["finished", []]]),
      childProjectionsById: new Map([["finished", childProjection]]),
    });
    expect(result.running).toEqual([]);
    expect(result.ended[0]?.status).toBe("success");
  });

  it("does not treat a completed child tool-call model step as a terminal child outcome", () => {
    const childSessionId = "sess_subagent_agent-child-tool";
    const childToolStep = toolMessage({
      id: "child-tool-step",
      state: "running",
      tool: "Bash",
    });
    childToolStep.info.time.completed = 30;
    childToolStep.info.finish = "tool-calls";

    const result = projectSessionSubagents({
      revision: 7,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-child-tool\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, [childToolStep]]]),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-child-tool",
          childSessionId,
          parentToolCallId: "call-m1",
          description: "Child tool Agent",
        }),
      ],
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("does not treat a stream recovery discarded child step as a failed child outcome", () => {
    const childSessionId = "sess_subagent_agent-child-discarded";
    const discardedStep = toolMessage({ id: "child-discarded", state: "running", tool: "Bash" });
    discardedStep.parts = [];
    discardedStep.info.time.completed = 30;
    discardedStep.info.finish = STREAM_RECOVERY_DISCARDED_FINISH;
    discardedStep.info.error = {
      name: STREAM_RECOVERY_DISCARDED_ERROR_NAME,
      data: { message: "Partial assistant output was discarded before a streaming retry." },
    };

    const result = projectSessionSubagents({
      revision: 8,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-child-discarded\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, [discardedStep]]]),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-child-discarded",
          childSessionId,
          parentToolCallId: "call-m1",
          description: "Child discarded Agent",
        }),
      ],
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("derives the persisted foreground child id from the completed Agent output agentId", () => {
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          id: "m1",
          output: { agentId: "agent-foreground", result: "Finished foreground work" },
        }),
      ],
      childSessionsById: new Map([
        ["sess_subagent_agent-foreground", session("sess_subagent_agent-foreground")],
      ]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    });

    expect(result.ended).toEqual([
      expect.objectContaining({
        childSessionId: "sess_subagent_agent-foreground",
        summary: "Finished foreground work",
        status: "success",
      }),
    ]);
  });

  it("paginates ended children newest-first with an opaque cursor", () => {
    const ended = Array.from({ length: 25 }, (_, index) => ({
      childSessionId: `child-${index}`,
      subagentType: "Explore",
      title: `Child ${index}`,
      status: "success" as const,
      endedAt: 100 - index,
    }));
    const first = paginateEndedSubagents(ended, { limit: 20 });
    const second = paginateEndedSubagents(ended, { cursor: first.nextCursor, limit: 20 });

    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    expect(second.items.map((item) => item.childSessionId)).toEqual([
      "child-20",
      "child-21",
      "child-22",
      "child-23",
      "child-24",
    ]);
    expect(second.nextCursor).toBeUndefined();
  });
});


describe("Multi-Agent V2 native directory projection", () => {
  it.each([false, true])("uses persisted execution model and effort when an assistant exists: %s", (hasAssistant) => {
    const child = { ...session("child"), parentID: "parent" as SessionInfo["parentID"] };
    const assistant = toolMessage({ id: "child-reply" });
    if (assistant.info.role === "assistant") {
      assistant.info.modelId = "actual-model" as typeof assistant.info.modelId;
      assistant.info.providerId = "actual-provider" as typeof assistant.info.providerId;
      assistant.info.reasoningLevel = "low";
    }
    const childProjection = projection(hasAssistant ? "completed" : "running");
    childProjection.totalTokenCount = 0;
    const result = projectSessionSubagents({
      revision: 9, parentSession: session("parent"),
      messages: [toolMessage({ id: "selection", tool: "collaboration_spawn_agent", output: {
        childSessionId: "child", agentPath: "/root/child", model: "launch-provider/launch-model", reasoningEffort: "high", status: "async_launched",
      } })],
      childSessionsById: new Map([["child", child]]),
      childMessagesById: new Map(hasAssistant ? [["child", [assistant]]] : []),
      childProjectionsById: new Map([["child", childProjection]]),
    });
    expect((hasAssistant ? result.ended : result.running)[0]).toMatchObject({
      modelId: hasAssistant ? "actual-model" : "launch-model",
      providerId: hasAssistant ? "actual-provider" : "launch-provider",
      reasoningEffort: hasAssistant ? "low" : "high", totalTokens: 0,
    });
  });

  it("projects a namespaced spawn with canonical path and actual parent identity", () => {
    const child = { ...session("grandchild"), parentID: "parent" as SessionInfo["parentID"] };
    const result = projectSessionSubagents({
      revision: 9,
      parentSession: session("parent"),
      messages: [toolMessage({
        id: "spawn-v2",
        tool: "team.spawn_agent",
        output: { agentId: "agent-grandchild", childSessionId: "grandchild", agentPath: "/root/research/verify", parentAgentPath: "/root/research", rootSessionId: "root-session", description: "Verify references", status: "async_launched" },
      })],
      childSessionsById: new Map([["grandchild", child]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map([["grandchild", projection("running")]]),
    });
    expect(result.running).toHaveLength(1);
    expect(result.running[0]).toMatchObject({
      agentPath: "/root/research/verify",
      parentAgentPath: "/root/research",
      parentSessionId: "parent",
      rootSessionId: "root-session",
      status: "running",
    });
  });

  it("does not expose a foreign persisted session referenced by a tool result", () => {
    const foreign = { ...session("foreign"), parentID: "other-parent" as SessionInfo["parentID"] };
    const result = projectSessionSubagents({
      revision: 1,
      parentSession: session("parent"),
      messages: [toolMessage({ id: "foreign-spawn", childSessionId: "foreign", tool: "collaboration.spawn_agent" })],
      childSessionsById: new Map([["foreign", foreign]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    });
    expect(result.running).toEqual([]);
    expect(result.ended).toEqual([]);
  });
});


describe("Multi-Agent V2 persisted tree query", () => {
  it("reads descendants once and rejects references outside the persisted parent chain", async () => {
    const sessions = new Map([
      ["root", session("root", "interactive")],
      ["child", { ...session("child"), parentID: "root" as SessionInfo["parentID"] }],
      ["grandchild", { ...session("grandchild"), parentID: "child" as SessionInfo["parentID"] }],
      ["foreign", { ...session("foreign"), parentID: "other" as SessionInfo["parentID"] }],
    ]);
    const histories = new Map<string, MessageWithParts[]>([
      ["root", [toolMessage({ id: "s1", tool: "collaboration.spawn_agent", output: { agentId: "a", childSessionId: "child", agentPath: "/root/a", status: "async_launched" } })]],
      ["child", [
        toolMessage({ id: "s2", tool: "collaboration.spawn_agent", output: { agentId: "b", childSessionId: "grandchild", agentPath: "/root/a/b", status: "async_launched" } }),
        toolMessage({ id: "s3", tool: "collaboration.spawn_agent", output: { agentId: "foreign", childSessionId: "foreign", agentPath: "/root/foreign" } }),
      ]],
    ]);
    const result = await readSubagentTree({
      rootSession: sessions.get("root")!,
      revision: 7,
      store: {
        getSession: async (id) => sessions.get(String(id)) ?? null,
        messages: async ({ sessionID }) => histories.get(String(sessionID)) ?? [],
      },
      readEvents: async () => [],
      readProjection: async () => projection("running"),
    });
    expect(result.childSessionIds).toEqual(["child", "grandchild"]);
    expect(result.projection.running.map((item) => item.agentPath).sort()).toEqual(["/root/a", "/root/a/b"]);
    expect(result.projection.running.find((item) => item.childSessionId === "grandchild")?.parentSessionId).toBe("child");
    expect(result.projection.ended).toEqual([]);
  });
});


function storedNativeTree(wireName = "collaboration_spawn_agent") {
  const root = session("parent", "interactive");
  const child = { ...session("native-child"), parentID: root.id };
  const message = toolMessage({ id: "native", tool: wireName, output: { task_name: "/root/native" } });
  const graph = { version: 1, rootSessionId: root.id, tasks: [
    { taskId: "multi_agent_root:parent", agentId: "multi_agent_root:parent", childSessionId: root.id,
      agentType: "root", description: "Root", status: "completed", startedAt: new Date(1).toISOString(),
      multiAgent: { rootSessionId: root.id, agentPath: "/root", resident: false, runGeneration: 1 }, pendingMessages: [] },
    { taskId: "native-agent", agentId: "native-agent", childSessionId: child.id, parentSessionId: root.id,
      parentToolCallId: "call-native", agentType: "general-purpose", description: "native task", status: "running",
      startedAt: new Date(10).toISOString(), multiAgent: { rootSessionId: root.id, agentPath: "/root/native",
        parentPath: "/root", nickname: "Ada", resident: true, runGeneration: 1 }, pendingMessages: [] },
  ] };
  const store = {
    getSession: async (id: SessionInfo["id"]) => id === root.id ? root : id === child.id ? child : null,
    messages: async ({ sessionID }: { sessionID: SessionInfo["id"] }) => sessionID === root.id ? [message] : [],
    sessionEntries: async ({ sessionID }: { sessionID: SessionInfo["id"] }) => sessionID === root.id ? [{
      id: "graph", sessionID, type: "multi_agent/graph", time: { created: 1, updated: 1 }, data: graph,
    }] : [],
    readTarget: async () => null,
  };
  return { root, child, message, graph, store };
}

it.each(["collaboration_spawn_agent", "custom_spawn_agent", "short_spawn_agent"])("discovers a cold native %s from the graph when public output contains only task_name", async (wireName) => {
  const f = storedNativeTree(wireName);
  const result = await readSubagentTree({ rootSession: f.root, revision: 1, store: f.store,
    readEvents: async () => [], readProjection: async () => undefined });
  expect(result.childSessionIds).toEqual(["native-child"]);
  expect(result.projection.running).toEqual([]);
  expect(result.projection.ended).toMatchObject([{ childSessionId: "native-child", agentId: "native-agent",
    agentPath: "/root/native", parentSessionId: "parent", status: "lost", title: "Ada · native task" }]);
  const source = await loadPersistedConversationMaterialization({ sessionId: f.root.id, store: f.store, memoryEvents: [] });
  const merged = mergeColdConversationEvents({ ...source, sessionId: f.root.id });
  expect(new Set(merged.events.map((event) => event.id)).size).toBe(merged.events.length);
  const projection = new ProductProjection(f.root.id, "cold-native");
  for (const event of merged.events) projection.applyEvent(event);
  projection.seedSubagents({ revision: 1, childSessionIds: result.childSessionIds, running: [] });
  projection.applyEvent({ ...subagentEvent(SessionEventType.SubagentStopped, {}),
    type: SessionEventType.SessionTitleUpdated, sequenceNumber: merged.events.length + 1, payload: { title: "unrelated" } });
  const snapshot = projection.getSnapshot();
  expect(snapshot.subagents.childSessionIds).toEqual(["native-child"]);
  expect(snapshot.rows.window.filter((row) => row.kind === "subagent")).toMatchObject([{
    entityId: "native-agent", childSessionId: "native-child", parentToolCallId: "call-native", status: "lost",
  }]);
  expect(snapshot.rows.window.filter((row) => row.kind === "toolCall")).toMatchObject([{ toolName: wireName, multiAgentOperation: "spawn_agent" }]);
});

it.each(["project", "parent", "branch"])("excludes persisted native children outside the active %s boundary", async (boundary) => {
  const f = storedNativeTree();
  if (boundary === "project") f.child.projectID = "other" as SessionInfo["projectID"];
  if (boundary === "parent") f.child.parentID = "other" as SessionInfo["id"];
  if (boundary === "branch") f.store.messages = async () => [];
  const result = await readSubagentTree({ rootSession: f.root, revision: 1, store: f.store,
    readEvents: async () => [], readProjection: async () => undefined });
  expect(result.childSessionIds).toEqual([]);
});


it("discovers a native grandchild through the same persisted graph and actual creation edges", async () => {
  const f = storedNativeTree();
  const grandchild = { ...session("native-grandchild"), parentID: f.child.id };
  const childMessage = toolMessage({ id: "grand", tool: "custom_spawn_agent", output: { task_name: "/root/native/grand" } });
  f.graph.tasks.push({ ...f.graph.tasks[1]!, taskId: "grand-agent", agentId: "grand-agent", childSessionId: grandchild.id,
    parentSessionId: f.child.id, parentToolCallId: "call-grand", status: "completed",
    multiAgent: { ...f.graph.tasks[1]!.multiAgent, agentPath: "/root/native/grand", parentPath: "/root/native", nickname: "Curie" } });
  const getSession = f.store.getSession;
  f.store.getSession = async (id) => id === grandchild.id ? grandchild : getSession(id);
  const messages = f.store.messages;
  f.store.messages = async (input) => input.sessionID === f.child.id ? [childMessage] : messages(input);
  const result = await readSubagentTree({ rootSession: f.root, revision: 2, store: f.store,
    readEvents: async () => [], readProjection: async () => undefined });
  expect(result.childSessionIds).toEqual([f.child.id, grandchild.id]);
  expect(result.projection.ended).toEqual(expect.arrayContaining([expect.objectContaining({
    agentId: "grand-agent", childSessionId: grandchild.id, parentSessionId: f.child.id,
    agentPath: "/root/native/grand", status: "success", title: "Curie · native task",
  })]));
  expect((await readSubagentTree({ rootSession: f.child, revision: 2, store: f.store,
    readEvents: async () => [], readProjection: async () => undefined })).childSessionIds).toEqual([grandchild.id]);
});

it("keeps current native lifecycle authority over the persisted crash projection", async () => {
  const f = storedNativeTree();
  const spawned = subagentEvent(SessionEventType.SubagentSpawned, { agentId: "native-agent", childSessionId: f.child.id,
    parentToolCallId: "call-native", agentPath: "/root/native", parentAgentPath: "/root", rootSessionId: f.root.id, status: "running" });
  const before = JSON.stringify(f.message);
  const result = await readSubagentTree({ rootSession: f.root, revision: 2, store: f.store,
    readEvents: async (id) => id === f.root.id ? [spawned] : [], readProjection: async () => undefined });
  expect(result.projection.running).toMatchObject([{ childSessionId: f.child.id, status: "running" }]);
  const source = await loadPersistedConversationMaterialization({ sessionId: f.root.id, store: f.store, memoryEvents: [spawned] });
  const merged = mergeColdConversationEvents({ ...source, sessionId: f.root.id });
  const projection = new ProductProjection(f.root.id, "live-native");
  for (const event of merged.events) projection.applyEvent(event);
  projection.seedSubagents({ revision: 2, childSessionIds: result.childSessionIds, running: result.projection.running });
  projection.applyEvent({ ...spawned, type: SessionEventType.SessionTitleUpdated, sequenceNumber: merged.events.length + 1, payload: { title: "unrelated" } });
  expect(projection.getSnapshot().subagents.running).toMatchObject([{ childSessionId: f.child.id }]);
  expect(JSON.stringify(f.message)).toBe(before);
});


it("waits for the native Runner stop even after the child's final model turn has completed", async () => {
  const f = storedNativeTree();
  const spawned = subagentEvent(SessionEventType.SubagentSpawned, { agentId: "native-agent", childSessionId: f.child.id,
    parentToolCallId: "call-native", agentPath: "/root/native", status: "running" });
  const result = await readSubagentTree({ rootSession: f.root, revision: 2, store: f.store,
    readEvents: async (id) => id === f.root.id ? [spawned] : [],
    readProjection: async (id) => id === f.child.id ? projection("completed") : undefined });
  expect(result.projection.running).toMatchObject([{ childSessionId: f.child.id, status: "running" }]);
  expect(result.projection.ended).toEqual([]);
});
