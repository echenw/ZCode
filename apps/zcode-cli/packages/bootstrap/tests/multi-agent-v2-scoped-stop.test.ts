import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { createRootTraceContext, multiAgentToolName, type ModelRequest } from "@zcode/contracts";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { expect, it, vi } from "vitest";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import type { V4SessionRecordView } from "../src/zcode-protocol-v4/commands/types.js";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
function taskPath(request: ModelRequest): string {
  const system = JSON.stringify(request.messages.filter((message) => message.role === "system"));
  return [...system.matchAll(/Task path: (\/root(?:\/[a-z0-9_]+)*)/g)].at(-1)?.[1] ?? "/root";
}
function spawn(task: string) {
  return { id: `spawn-${task}`, name: multiAgentToolName("spawn_agent"),
    input: { task_name: task, message: "Keep working until explicitly stopped", fork_turns: "none" } };
}

// T17：V4 命令、App facade、Runtime、原 Runner 与 SQLite 均真实；仅用本地模型控制时序。
it.each(["subtree", "tree", "user-target"] as const)("stops %s through the production App and V4 command without cancelling unrelated execution", async (scope) => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-v2-scoped-stop-"));
  const store = await createSqliteSessionStore({ dbPath: join(directory, "sessions.sqlite") });
  const controller = new AbortController();
  const release = Promise.withResolvers<void>();
  const steps = new Map<string, number>();
  const signals = new Map<string, AbortSignal>();
  let app: Awaited<ReturnType<typeof createRegistryBackedTestApp>> | undefined;
  let turn: ReturnType<NonNullable<typeof app>["submitPrompt"]> | undefined;
  try {
    app = await createRegistryBackedTestApp({
      env: { ZCODE_STORAGE_DIR: join(directory, "storage") }, skipUserConfig: true, sessionStore: store,
      runtimeConfig: {
        workingDirectory: directory, mode: "yolo", modelStreaming: "off",
        titleGeneration: { enabled: false }, compact: { enabled: false }, mcp: { enabled: false },
        subagents: { enabled: true },
        multiAgentV2: { enabled: true, maxConcurrentThreadsPerSession: 8, maxResidentAgents: 8 },
        modelSelection: { providerId: "zai", modelId: "glm-4.6", options: { reasoningLevel: "low" } },
      },
      modelExecutor: { async generateText(request) {
        const path = taskPath(request);
        const step = (steps.get(path) ?? 0) + 1;
        steps.set(path, step);
        if (path === "/root" && step === 1) return { text: "", finishReason: "tool-calls", usage: USAGE,
          toolCalls: [spawn("a"), spawn("sibling")] };
        if (path === "/root/a" && step === 1) return { text: "", finishReason: "tool-calls", usage: USAGE,
          toolCalls: [spawn("b")] };
        if (!request.abortSignal) throw new Error("Expected the real runtime cancellation signal");
        signals.set(path, request.abortSignal);
        await release.promise;
        return { text: "settled", finishReason: "stop", usage: USAGE };
      } },
    });
    turn = app.submitPrompt("Create a child, grandchild and independent sibling", { abortSignal: controller.signal });
    void turn.catch(() => undefined);
    await vi.waitFor(() => expect([...signals.keys()].sort()).toEqual(["/root", "/root/a", "/root/a/b", "/root/sibling"]), { timeout: 15_000 });
    const before = await app.readSubagents();
    const a = before.running.find((task) => task.agentPath === "/root/a");
    expect(a?.agentId).toBeDefined();
    const record: V4SessionRecordView = { app, activeAbortController: controller,
      traceContext: createRootTraceContext({ sessionId: app.sessionId }),
      workspace: { workspacePath: directory }, persistence: "immediate" };
    const executor = new V4CommandExecutor({ getRecord: (id) => id === app!.sessionId ? record : undefined });
    const command: CommandEnvelope = { commandId: `stop-${scope}`, clientId: "scope-fixture", issuedAt: Date.now(), sessionId: app.sessionId,
      ...(scope === "user-target"
        ? { type: "controlSubagent" as const, payload: { action: "stop" as const, childSessionId: a!.childSessionId } }
        : { type: "cancelBackgroundWork" as const, payload: { workId: a!.agentId!, scope } }), baseRevision: 0 };
    await executor.execute(command);
    expect(signals.get("/root/a")?.aborted).toBe(true);
    expect(signals.get("/root/a/b")?.aborted).toBe(scope !== "user-target");
    expect(signals.get("/root/sibling")?.aborted).toBe(scope === "tree");
    expect(signals.get("/root")?.aborted).toBe(scope === "tree");
    expect(controller.signal.aborted).toBe(scope === "tree");
    const stopped = await app.readSubagents();
    expect(stopped.childSessionIds.sort()).toEqual(before.childSessionIds.sort());
    expect(stopped.ended.items.filter((task) => task.status === "cancelled").map((task) => task.agentPath).sort())
      .toEqual(scope === "tree" ? ["/root/a", "/root/a/b", "/root/sibling"] : scope === "user-target" ? ["/root/a"] : ["/root/a", "/root/a/b"]);
  } finally {
    controller.abort();
    release.resolve();
    await turn?.catch(() => undefined);
    if (app) await vi.waitFor(async () => expect((await app!.readSubagents()).running).toEqual([]), { timeout: 15_000 });
    await app?.close?.();
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 30_000);
