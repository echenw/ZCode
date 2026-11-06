import { describe, expect, it, vi } from "vitest";
import { createModelUsageSummary, createSessionId, createTraceId, createTurnId } from "@zcode/contracts";
import {
  acknowledgeMultiAgentMessage, assertMultiAgentTokenBudget, createMultiAgentPersistence,
  deliverMultiAgentMessage, getMultiAgentUsage, multiAgentRootId, recordMultiAgentUsage,
  restoreMultiAgentGraph, serializeMultiAgentGraph, stageMultiAgentMailbox,
} from "../src/multi-agent/index.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { createBuiltInGeneralPurposeAgentProfile } from "../src/subagent/profile.js";
import { createSubagentMessageSink } from "../src/subagent/message-steering.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

function tree() {
  const registry = new InMemoryRuntimeTaskRegistry();
  const rootSessionId = createSessionId("durable-tree");
  const identity = { agentPath: "/root", rootSessionId };
  const rootId = multiAgentRootId(rootSessionId);
  registry.register({ taskId: rootId, agentId: rootId, agentType: "root", description: "Main",
    type: "local_agent", status: "completed", childSessionId: rootSessionId, startedAt: new Date(), pendingMessages: [],
    multiAgent: { ...identity, resident: true, runGeneration: 0 } });
  const childIdentity = { agentId: "child", agentPath: "/root/child", parentPath: "/root", rootSessionId, forkTurns: "all" as const,
    initiatingAgentPath: "/root", initiatingTurnId: createTurnId("origin") };
  registry.register({ taskId: "child", agentId: "child", agentType: "general-purpose", description: "work",
    type: "local_agent", status: "running", childSessionId: createSessionId("subagent_child"), parentSessionId: rootSessionId,
    startedAt: new Date(), pendingMessages: [], multiAgent: { ...childIdentity, resident: true, runGeneration: 1 },
    resumeState: { profile: createBuiltInGeneralPurposeAgentProfile(), request: { sessionId: rootSessionId,
      parentToolCallId: "call", agentType: "general-purpose", description: "work", prompt: "task", workingDirectory: "/workspace", workspaceRoot: "/workspace",
      trace: { traceId: createTraceId(), sessionId: rootSessionId }, multiAgent: childIdentity,
      inheritedToolAllowlist: ["Read"], inheritedPermissionMode: "plan" } } });
  return { registry, identity, childIdentity, rootId };
}

describe("V2 durable graph projection", () => {
  it("reserves existing names before assigning missing names in an older graph", () => {
    const f = tree();
    const first = f.registry.get("child")!;
    f.registry.register({ ...first, taskId: "second", agentId: "second", childSessionId: createSessionId("second"), resumeState: undefined,
      multiAgent: { ...f.childIdentity, agentPath: "/root/second", resident: true, runGeneration: 1 } });
    const raw = serializeMultiAgentGraph(f.registry, f.identity.rootSessionId) as { tasks: Array<{ multiAgent: { nickname?: string } }> };
    delete raw.tasks[1]!.multiAgent.nickname;
    raw.tasks[2]!.multiAgent.nickname = "Ada";
    const restored = new InMemoryRuntimeTaskRegistry();
    restoreMultiAgentGraph(restored, f.identity.rootSessionId, raw);
    expect(restored.get("child")?.multiAgent?.nickname).toBe("Turing");
    expect(restored.get("second")?.multiAgent?.nickname).toBe("Ada");
  });

  it("assigns unique readable nicknames and preserves them across generations and cold graph restore", () => {
    const f = tree();
    const first = f.registry.get("child")!;
    expect(first.multiAgent?.nickname).toBe("Ada");
    f.registry.register({ ...first, taskId: "second", agentId: "second", childSessionId: createSessionId("subagent_second"), resumeState: undefined, multiAgent: { ...f.childIdentity, agentPath: "/root/second", resident: true, runGeneration: 1 } });
    expect(f.registry.get("second")?.multiAgent?.nickname).toBe("Turing");
    f.registry.update("child", (task) => ({ ...task, status: "completed", multiAgent: { ...task.multiAgent!, runGeneration: 2 } }));
    expect(f.registry.get("child")?.multiAgent?.nickname).toBe("Ada");
    const restored = new InMemoryRuntimeTaskRegistry();
    restoreMultiAgentGraph(restored, f.identity.rootSessionId, serializeMultiAgentGraph(f.registry, f.identity.rootSessionId));
    expect(restored.get("child")?.multiAgent?.nickname).toBe("Ada");
    expect(restored.get("second")?.multiAgent?.nickname).toBe("Turing");
    for (let index = 0; index < 14; index++) f.registry.register({ ...first, taskId: `extra_${index}`, agentId: `extra_${index}`,
      childSessionId: createSessionId(`extra_${index}`), resumeState: undefined,
      multiAgent: { ...f.childIdentity, agentPath: `/root/extra_${index}`, resident: true, runGeneration: 1 } });
    const names = Object.values(f.registry.all()).map((task) => task.multiAgent?.nickname);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("Ada 2");
  });
  it("restores identity, original permission ceiling and queued mail while marking exited execution lost", async () => {
    const f = tree();
    f.registry.queueMessage("child", { id: "m1", message: "中文\nrestore mailbox", queuedAt: new Date(), senderPath: "/root", targetPath: "/root/child", origin: { kind: "user" } });
    const store = createRecordingSubagentSessionStore();
    const persistence = createMultiAgentPersistence({ ...f, store, restoreTask: () => {} })!;
    await persistence.ready; await persistence.flush();
    expect(await store.sessionEntries!({ sessionID: f.identity.rootSessionId, type: "multi_agent/graph" })).toHaveLength(1);
    const restored = tree().registry; restored.remove("child");
    const bind = vi.fn();
    const recovery = createMultiAgentPersistence({ registry: restored, identity: f.identity, store, restoreTask: bind })!;
    await recovery.ready;
    expect(restored.get("child")).toMatchObject({ status: "lost", childSessionId: f.registry.get("child")!.childSessionId, parentSessionId: f.identity.rootSessionId, multiAgent: { resident: false, agentPath: "/root/child" },
      resumeState: { request: { workingDirectory: "/workspace", inheritedToolAllowlist: ["Read"], inheritedPermissionMode: "plan" } } });
    expect(restored.get("child")?.pendingMessages?.[0]?.message).toBe("中文\nrestore mailbox");
    expect(restored.get("child")?.pendingMessages?.[0]?.origin).toEqual({ kind: "user" });
    expect(restored.get("child")?.multiAgent).toMatchObject({ initiatingAgentPath: "/root", initiatingTurnId: f.childIdentity.initiatingTurnId });
    expect(bind).toHaveBeenCalledWith("child");
    expect(restored.get(f.rootId)?.multiAgent?.resident).toBe(true);
  });

  it("rejects cross-root, orphan and corrupt execution bindings before changing any live record", () => {
    const f = tree();
    const base = serializeMultiAgentGraph(f.registry, f.identity.rootSessionId) as any;
    for (const mutate of [
      (graph: any) => { graph.rootSessionId = "other"; },
      (graph: any) => { graph.tasks[1].multiAgent.parentPath = "/root/missing"; },
      (graph: any) => { graph.tasks[1].multiAgent.initiatingAgentPath = "/root/foreign"; },
      (graph: any) => { graph.tasks[1].resumeState.request.multiAgent.rootSessionId = "other"; },
      (graph: any) => { graph.tasks[1].output = { invalid: true }; },
      (graph: any) => { graph.tasks[1].startedAt = "not-a-date"; },
    ]) {
      const raw = structuredClone(base); mutate(raw);
      const target = new InMemoryRuntimeTaskRegistry();
      expect(() => restoreMultiAgentGraph(target, f.identity.rootSessionId, raw)).toThrow();
      expect(target.all()).toEqual({});
    }
  });

  it("keeps running mail until transcript consumption and discards a cold replay already anchored in transcript", async () => {
    const f = tree(); const send = vi.fn(async () => "steered" as const);
    const sendActive = vi.fn(async () => true);
    const turnId = createTurnId("admitted-child-turn");
    f.registry.update("child", (task) => ({ ...task, turnId, messageSink: { retainsUntilConsumed: true, send, sendActive } }));
    const message = { id: "durable-message", message: "retain until consumed", queuedAt: new Date(), targetPath: "/root/child" };
    await deliverMultiAgentMessage(f.registry, f.registry.get("child")!, message);
    expect(send).not.toHaveBeenCalled();
    expect(sendActive).not.toHaveBeenCalled();
    expect(await stageMultiAgentMailbox(f.registry, f.childIdentity, turnId)).toBe(1);
    expect(sendActive).toHaveBeenCalledWith({ ...message, senderName: undefined, targetName: "Ada" }, turnId);
    expect(f.registry.get("child")?.pendingMessages).toHaveLength(1);
    const store = createRecordingSubagentSessionStore();
    const persistence = createMultiAgentPersistence({ ...f, store, restoreTask: () => {} })!;
    await persistence.flush();
    await store.saveMessage({ id: "message" as never, sessionID: createSessionId("subagent_child"), role: "user",
      time: { created: Date.now() }, anchor: { sourceCommandId: message.id } } as never);
    const restored = new InMemoryRuntimeTaskRegistry();
    const recovery = createMultiAgentPersistence({ registry: restored, identity: f.identity, store, restoreTask: () => {} })!;
    await recovery.ready;
    expect(restored.get("child")?.pendingMessages).toEqual([]);
    expect(restored.get("child")?.multiAgent?.deliveredMessages).toBe(1);
    acknowledgeMultiAgentMessage(restored, f.childIdentity, message.id);
    expect(restored.get("child")?.multiAgent?.deliveredMessages).toBe(1);
  });

  it("awaits serialized writes and propagates a durability failure to the acknowledged operation", async () => {
    const f = tree(); const store = createRecordingSubagentSessionStore();
    const failed = new Error("disk full"); store.saveSessionEntry = vi.fn(async () => { throw failed; });
    const onError = vi.fn();
    const persistence = createMultiAgentPersistence({ ...f, store, restoreTask: () => {}, onError })!;
    await persistence.ready;
    await expect(persistence.flush()).rejects.toBe(failed);
  });
});

describe("V2 root shared actual usage", () => {
  it("sums root and descendants once, keeps cache/reasoning separate, and survives cold hydration", () => {
    const f = tree();
    const usage = createModelUsageSummary([{ inputTokens: 6, outputTokens: 4, totalTokens: 10, cacheReadTokens: 3, reasoningTokens: 2 }])!;
    recordMultiAgentUsage(f.registry, f.identity, usage, "root-step");
    recordMultiAgentUsage(f.registry, f.childIdentity, usage, "child-step");
    recordMultiAgentUsage(f.registry, f.childIdentity, usage, "child-step");
    expect(getMultiAgentUsage(f.registry, f.identity.rootSessionId)).toMatchObject({ totalTokens: 20, modelRequestCount: 2, cacheReadTokens: 6, reasoningTokens: 4 });
    expect(() => assertMultiAgentTokenBudget(f.registry, f.identity, { tokenBudget: 20 })).toThrow("exhausted");
    const restored = new InMemoryRuntimeTaskRegistry();
    restoreMultiAgentGraph(restored, f.identity.rootSessionId, serializeMultiAgentGraph(f.registry, f.identity.rootSessionId));
    recordMultiAgentUsage(restored, f.childIdentity, usage, "child-step");
    expect(getMultiAgentUsage(restored, f.identity.rootSessionId).totalTokens).toBe(20);
    expect(() => assertMultiAgentTokenBudget(restored, f.childIdentity, { tokenBudget: 20 })).toThrow("exhausted");
  });

  it("rejects invalid configured budgets and non-finite reported usage without inventing estimates", () => {
    const f = tree();
    recordMultiAgentUsage(f.registry, f.identity, undefined);
    expect(getMultiAgentUsage(f.registry, f.identity.rootSessionId).modelRequestCount).toBe(0);
    expect(() => recordMultiAgentUsage(f.registry, f.identity, Number.NaN)).toThrow("invalid");
    expect(() => assertMultiAgentTokenBudget(f.registry, f.identity, { tokenBudget: -1 })).toThrow("positive integer");
  });
});

describe("active-only board sink fence", () => {
  it("performs one fenced steer attempt without idle retries or fallback", async () => {
    const steerTurn = vi.fn(async () => ({ kind: "rejected", reason: "no_active_turn" } as const));
    const sink = createSubagentMessageSink({ steerTurn }, { traceContext: { traceId: createTraceId() } });
    const accepted = await sink.sendActive!({ id: "board-post", message: "Message Type: CHANNEL_POST\nPayload:\npost", queuedAt: new Date() }, "expected-turn" as never);
    expect(accepted).toBe(false); expect(steerTurn).toHaveBeenCalledOnce();
    expect(steerTurn).toHaveBeenCalledWith(expect.objectContaining({ expectedTurnId: "expected-turn", inputId: "board-post" }));
  });
});

it.each([false, true, undefined])("preserves the trusted first-turn fact across JSON and cold restoration (%s)", (hasStartedTurn) => {
  const f = tree();
  f.registry.update("child", (task) => ({ ...task, hasStartedTurn }));
  const raw = JSON.parse(JSON.stringify(serializeMultiAgentGraph(f.registry, f.identity.rootSessionId)));
  const restored = new InMemoryRuntimeTaskRegistry();
  restoreMultiAgentGraph(restored, f.identity.rootSessionId, raw);
  expect(restored.get("child")?.hasStartedTurn).toBe(hasStartedTurn);
  if (hasStartedTurn === true) {
    restored.update("child", (task) => ({ ...task, hasStartedTurn: false }));
    expect(restored.get("child")?.hasStartedTurn).toBe(true);
    restored.register({ ...restored.get("child")!, hasStartedTurn: false });
    expect(restored.get("child")?.hasStartedTurn).toBe(true);
  }
});
