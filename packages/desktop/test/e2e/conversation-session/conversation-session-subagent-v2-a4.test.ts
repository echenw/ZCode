import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths, seedCliConfig } from "../helpers/desktop-app.js";
import { clickV4Stop, openV4RunningBackgroundWorks, prepareV4ConversationE2E,
  sendV4Prompt, setV4ElectronWindowSize, waitForV4AssistantMessageContaining, waitForV4Pane } from "../helpers/v4-conversation.js";
import { ensureToolCrossProductFullAccessMode } from "../helpers/conversation-session-tool-cross-product.js";
import { reloadElectronSessionPreservingBrowserProfile } from "../helpers/e2e-electron-reload.js";
import { resolveE2ERuntimePath } from "../helpers/e2e-runtime-paths.js";
import { getUpstreamRequestEvidence } from "../helpers/conversation-session-network.js";

// 本地回放模型，真实桌面/Host/CLI/SQLite 与 Bash；验证 A4 前台、后台及孙代理组合。
const PREFIX = "E2E_V2_A4_";
const paths = getE2EAppDataPaths();
const gates = resolveE2ERuntimePath("v2-a4");
const evidenceDir = join(process.env.ZCODE_E2E_ARTIFACT_DIR?.trim() || paths.storageRoot, "v2-a4");
const expected = ["root-launch", "a-spawn-c", "a-gate", "b-gate", "c-gate", "a-done", "b-done", "c-done",
  "root-list", "root-wait", "root-followup", "root-done", "b-followup"].map((id) => `v2-a4-${id}`);
interface Task {
  taskId: string; agentId: string; childSessionId: string; parentSessionId?: string;
  description: string; status: string; multiAgent: { agentPath: string; parentPath?: string; runGeneration: number };
}
interface Graph { rootSessionId: string; tasks: Task[] }
let rootId: string | null = null;
const observations: Array<Record<string, unknown>> = [];

describe("原生 Desktop A4 前后台与孙代理 Main Stop（synthetic Provider）", () => {
  after(async () => {
    await mkdir(evidenceDir, { recursive: true });
    const requests = await scenarioRequests();
    await writeFile(join(evidenceDir, "evidence.json"), JSON.stringify({ externalLlmVerified: false, rootId, observations,
      requests: requests.map(({ fixtureId, statusCode, status, startedAt }) => ({ fixtureId, statusCode, status, startedAt })) }, null, 2));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("主代理停止后前台 A、后台 B 和 A 的子代理继续，主代理可查询等待并续接 B", async function () {
    this.timeout(240000);
    expect(process.env.E2E_PROVIDER_HTTP_MODE).toBe("replay");
    await prepareV4ConversationE2E();
    await reloadElectronSessionPreservingBrowserProfile(browser, { afterElectronProcessExit: async () => {
      await seedCliConfig({ features: { subagent: true }, multiAgentV2: {
        enabled: true, toolNamespace: "collaboration", maxConcurrentThreadsPerSession: 8, maxResidentAgents: 8,
      } });
    } });
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    await setV4ElectronWindowSize(1440, 900);
    await mkdir(gates, { recursive: true });
    expect(await readdir(gates)).toEqual([]);
    await sendV4Prompt(`${PREFIX}ROOT_START: start foreground A and background B; A starts child C.`);
    rootId = (await waitForV4Pane((state) => Boolean(state.sessionId && state.sessionId !== "draft") && state.canStop,
      "A4 Root 没有开始运行")).sessionId;
    if (!rootId || rootId === "draft") throw new Error("A4 root session ID missing");
    await waitForFiles(["a-started.txt", "b-started.txt", "c-started.txt"]);
    const initial = await waitGraph(rootId, (graph) => graph.tasks.filter((task) => task.multiAgent.agentPath !== "/root").length === 3 &&
      graph.tasks.filter((task) => task.multiAgent.agentPath !== "/root").every((task) => task.status === "running"));
    const a = initial.tasks.find((task) => task.description === "foreground A");
    const b = initial.tasks.find((task) => task.multiAgent.agentPath === "/root/b");
    const c = initial.tasks.find((task) => task.multiAgent.parentPath === a?.multiAgent.agentPath);
    if (!a || !b || !c) throw new Error("A4 tree lacks foreground A, background B or C");
    expect(c.parentSessionId).toBe(a.childSessionId);
    await openV4RunningBackgroundWorks();
    await browser.waitUntil(async () => browser.execute((ids) => ids.every((id) =>
      Boolean(document.querySelector(`[data-background-task-kind="agent"][data-child-session-id="${id}"]`))),
    [a.childSessionId, b.childSessionId, c.childSessionId]), { timeout: 30000, timeoutMsg: "A4 原生运行列表缺少子代理" });
    observations.push({ phase: "before-main-stop", tasks: identities(initial) });
    await clickV4Stop();
    await waitForV4Pane((state) => state.sessionId === rootId && !state.canStop, "A4 Main Stop 未结束主轮次");
    const afterStop = readGraph(rootId)!;
    for (const original of [a, b, c]) {
      const current = afterStop.tasks.find((task) => task.agentId === original.agentId);
      expect(current?.status).toBe("running");
      expect(current?.childSessionId).toBe(original.childSessionId);
      expect(current?.multiAgent.runGeneration).toBe(original.multiAgent.runGeneration);
    }
    for (const name of ["a", "b", "c"]) {
      expect(await counter(`${name}-started.txt`)).toEqual(["started"]);
      expect(await counter(`${name}-done.txt`)).toEqual([]);
    }
    observations.push({ phase: "main-stopped-descendants-running", tasks: identities(afterStop) });
    await writeFile(join(gates, "all.release"), "released\n");
    await waitForFiles(["a-done.txt", "b-done.txt", "c-done.txt"]);
    const completed = await waitGraph(rootId, (graph) => [a, b, c].every((original) =>
      graph.tasks.find((task) => task.agentId === original.agentId)?.status === "completed"));
    expect(identities(completed)).toEqual(identities(initial));
    for (const name of ["a", "b", "c"]) expect(await counter(`${name}-done.txt`)).toEqual(["done"]);
    await sendV4Prompt(`${PREFIX}ROOT_CHECK: list the agents, wait for activity, then continue existing /root/b.`);
    await waitForV4AssistantMessageContaining(`${PREFIX}ROOT_CHECK_DONE`);
    const resumed = await waitGraph(rootId, (graph) => graph.tasks.some((task) => task.agentId === b.agentId &&
      task.status === "completed" && task.multiAgent.runGeneration === b.multiAgent.runGeneration + 1));
    expect(identities(resumed)).toEqual(identities(initial));
    const requests = await scenarioRequests();
    expect(requests.map((request) => request.fixtureId).sort()).toEqual([...expected].sort());
    expect(requests.every((request) => request.statusCode === 200)).toBe(true);
    const resumedMainHistory = JSON.stringify(requests.find((request) => request.fixtureId === "v2-a4-root-list")?.requestJson);
    expect(resumedMainHistory).toContain("foreground Agent wait was cancelled");
    expect(resumedMainHistory).toContain("does not establish whether the child agent stopped");
    const afterList = requests.find((request) => request.fixtureId === "v2-a4-root-wait");
    for (const task of [a, b, c]) expect(JSON.stringify(afterList?.requestJson)).toContain(task.multiAgent.agentPath);
    expect(JSON.stringify(requests.find((request) => request.fixtureId === "v2-a4-root-followup")?.requestJson)).toContain("Wait completed.");
    observations.push({ phase: "completed-and-original-b-followup", tasks: identities(resumed) });
  });
});

function readGraph(session: string): Graph | null {
  const db = new DatabaseSync(join(paths.storageRoot, "cli", "db", "db.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT data FROM session_entry WHERE session_id = ? AND type = 'multi_agent/graph'").get(session) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Graph : null;
  } finally { db.close(); }
}
async function waitGraph(session: string, predicate: (graph: Graph) => boolean): Promise<Graph> {
  let graph: Graph | null = null;
  await browser.waitUntil(() => { graph = readGraph(session); return graph !== null && predicate(graph); },
    { timeout: 60000, timeoutMsg: "A4 任务图没有进入预期状态" });
  if (!graph) throw new Error("A4 graph missing");
  return graph;
}
function identities(graph: Graph) {
  return graph.tasks.map((task) => ({ path: task.multiAgent.agentPath, parent: task.multiAgent.parentPath,
    agentId: task.agentId, childSessionId: task.childSessionId, parentSessionId: task.parentSessionId })).sort((a, b) => a.path.localeCompare(b.path));
}
async function counter(file: string): Promise<string[]> {
  try { return (await readFile(join(gates, file), "utf8")).trim().split("\n").filter(Boolean); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []; throw error; }
}
async function waitForFiles(files: string[]) {
  await browser.waitUntil(async () => (await Promise.all(files.map(counter))).every((items) => items.length > 0),
    { timeout: 60000, timeoutMsg: `A4 工具未到达屏障：${files.join(", ")}` });
}
function scenarioRequests() {
  return getUpstreamRequestEvidence({ includes: [PREFIX], excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"] });
}
