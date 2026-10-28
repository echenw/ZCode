import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Key } from "webdriverio";
import {
  TID_CHAT_CONTEXT_USAGE_TRIGGER,
  TID_CHAT_SUMMARY_PANEL,
  TID_TASK_ITEM,
  TID_TOOL_SUMMARY_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, getE2EAppDataPaths, seedCliConfig } from "../helpers/desktop-app.js";
import {
  clickV4Stop,
  getV4PaneSnapshot,
  openV4RunningBackgroundWorks,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ElectronWindowSize,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../helpers/v4-conversation.js";
import { ensureToolCrossProductFullAccessMode } from "../helpers/conversation-session-tool-cross-product.js";
import { reloadElectronSessionPreservingBrowserProfile } from "../helpers/e2e-electron-reload.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart.js";
import { resolveE2ERuntimePath } from "../helpers/e2e-runtime-paths.js";
import { listSystemProcesses } from "../helpers/e2e-process-cleanup.js";
import {
  expectNoUpstreamRequestForTextWithin,
  getUpstreamRequestEvidence,
  type UpstreamRequestEvidence,
} from "../helpers/conversation-session-network.js";

// 合同：计划 A4 / 审计 T02、T09、T16、T18、T19、MA21、MA32、MA33。
// 只有 Provider 回复是 synthetic；UI/Host/CLI/工具/SQLite 走生产链路。
// 状态由 Runtime 拥有。测试只读图与 DOM，用独立文件门闩控制真实 Bash 的完成顺序。
const PREFIX = "E2E_V2_NATIVE_";
// 当前 Mac 工作区高 998；1000 会被系统裁剪。选择可容纳的内容区，仍由共享 helper 严格核对。
const NATIVE_VIEWPORT = { width: 1440, height: 900 } as const;
const NARROW_MESSAGE_VIEWPORT = { width: 1100, height: NATIVE_VIEWPORT.height } as const;
const CHILD_PATHS = ["/root/a", "/root/a/b", "/root/a/b/c"] as const;
const paths = getE2EAppDataPaths();
const gateDirectory = resolveE2ERuntimePath("v2-native");
const evidenceDirectory = join(
  process.env.ZCODE_E2E_ARTIFACT_DIR?.trim() || paths.storageRoot,
  "v2-native",
);
const EXPECTED_FIXTURES = [
  "root-spawn-a",
  "root-gate",
  "a-spawn-b",
  "a-gate",
  "a-done-1",
  "b-spawn-c",
  "b-gate",
  "b-done-1",
  "c-gate",
  "c-ui-gate",
  "c-done-1",
  "root-warm-followup",
  "root-warm-accepted",
  "a-done-2",
  "root-cold-followup",
  "root-cold-accepted",
  "cold-gate",
  "root-queue-mail",
  "root-queue-accepted",
  "root-restored-followup",
  "root-restored-accepted",
  "restored-gate",
  "a-done-4",
].map((name) => `v2-native-${name}`);

interface GraphTask {
  taskId: string;
  agentId: string;
  childSessionId: string;
  parentSessionId?: string;
  status: string;
  multiAgent: {
    agentPath: string;
    parentPath?: string;
    rootSessionId: string;
    resident: boolean;
    runGeneration: number;
    nickname?: string;
  };
}

interface AgentGraph {
  version: number;
  rootSessionId: string;
  tasks: GraphTask[];
}

interface NativeAgentRow {
  path: string | null;
  depth: string | null;
  childSessionId: string | null;
  status: string | null;
  text: string;
}

let rootSessionId: string | null = null;
const observations: Array<Record<string, unknown>> = [];

describe("原生 Desktop V2 树、Main Stop 与冷续接（synthetic Provider）", () => {
  after(async () => {
    await mkdir(evidenceDirectory, { recursive: true });
    const requests = await scenarioRequests();
    await writeFile(
      join(evidenceDirectory, "evidence.json"),
      JSON.stringify(
        {
          source: "synthetic-provider-real-desktop-runtime",
          externalLlmVerified: false,
          rootSessionId,
          observations,
          requests: requests.map(({ fixtureId, path, startedAt, status, statusCode }) => ({
            fixtureId,
            path,
            startedAt,
            status,
            statusCode,
          })),
        },
        null,
        2,
      ),
    );
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("四层代理在 Main Stop 后继续，原身份多次续接并在真实进程冷重开后恢复", async function () {
    this.timeout(360000);
    // 不允许把确定性验收意外切换成真实外部 Provider 调用。
    expect(process.env.E2E_PROVIDER_HTTP_MODE).toBe("replay");
    expect(process.env.E2E_PROVIDER_CAPTURE_PATH?.trim()).toBeTruthy();
    try {
      await prepareV4ConversationE2E();
    } catch (error) {
      await mkdir(evidenceDirectory, { recursive: true });
      const shell = await browser.execute(() => ({
        url: location.href,
        readyState: document.readyState,
        labels: Array.from(document.querySelectorAll("button,h1,h2,[role=alert]")).map((element) =>
          element.textContent?.slice(0, 120),
        ),
      }));
      await writeFile(
        join(evidenceDirectory, "shell-diagnostic.json"),
        JSON.stringify(shell, null, 2),
      );
      await browser.saveScreenshot(join(evidenceDirectory, "shell-failed.png"));
      throw error;
    }
    // 旧 Host 完全退出后再写配置，避免活进程异步写回覆盖 fixture。
    await reloadElectronSessionPreservingBrowserProfile(browser, {
      afterElectronProcessExit: async () => {
        await seedCliConfig({
          features: { subagent: true },
          multiAgentV2: {
            enabled: true,
            toolNamespace: "collaboration",
            maxConcurrentThreadsPerSession: 8,
            maxResidentAgents: 8,
          },
        });
      },
    });
    await prepareV4ConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    await setV4ElectronWindowSize(NATIVE_VIEWPORT.width, NATIVE_VIEWPORT.height);
    await mkdir(gateDirectory, { recursive: true });
    expect(await readdir(gateDirectory)).toEqual([]);

    await sendV4Prompt(
      `${PREFIX}ROOT_START: delegate a four-level agent tree and keep each accepted agent working independently.`,
    );
    await waitForV4Pane(
      (state) => Boolean(state.sessionId && state.sessionId !== "draft") && state.canStop,
      "Root 没有进入可停止的真实 turn",
    );
    rootSessionId = (await getV4PaneSnapshot()).sessionId;
    if (!rootSessionId || rootSessionId === "draft") throw new Error("Root session ID missing");
    await waitForFiles([
      "root-pid.txt",
      "root-started.txt",
      "a-started.txt",
      "b-started.txt",
      "c-started.txt",
    ]);
    const rootShellPid = Number(await readFile(join(gateDirectory, "root-pid.txt"), "utf8"));
    expect(Number.isSafeInteger(rootShellPid) && rootShellPid > 0).toBe(true);
    const initial = await waitForGraph(
      rootSessionId,
      (graph) => CHILD_PATHS.every((path) => taskAt(graph, path)?.status === "running"),
      "三层后代没有同时进入真实 running 状态",
    );
    assertIdentityTree(initial);
    await assertNativeRunningTree(initial, CHILD_PATHS);
    await assertChildSessionsHidden(initial);

    // Renderer 断开并重新订阅时，Host 与正在执行的工具继续存活；不能凭旧 graph 推断运行。
    const electronPidBeforeRefresh = await browser.electron.execute(() => process.pid);
    await browser.refresh();
    await waitForV4Pane(
      (state) => state.sessionId === rootSessionId && state.canStop,
      "刷新后没有重新连接原 Root 的运行轮次",
      60000,
    );
    expect(await browser.electron.execute(() => process.pid)).toBe(electronPidBeforeRefresh);
    const reconnected = await waitForGraph(
      rootSessionId,
      (graph) => CHILD_PATHS.every((path) => taskAt(graph, path)?.status === "running"),
      "刷新后子代理状态未保持运行",
    );
    assertSameIdentities(initial, reconnected);
    for (const path of CHILD_PATHS) {
      expect(requiredTask(reconnected, path).multiAgent.runGeneration).toBe(
        requiredTask(initial, path).multiAgent.runGeneration,
      );
    }
    for (const name of ["root", "a", "b", "c"]) {
      expect(await readCounter(`${name}-started.txt`)).toEqual(["started"]);
      expect(await readCounter(`${name}-done.txt`)).toEqual([]);
    }
    await assertNativeRunningTree(reconnected, CHILD_PATHS);
    await recordPhase("renderer-reconnected-descendants-still-running", reconnected, {
      electronPid: electronPidBeforeRefresh,
    });
    await assertNestedChildUi(initial);
    await openNativeChild(requiredTask(initial, "/root/a/b/c").childSessionId);
    await assertChildTranscript(requiredTask(initial, "/root/a/b/c").childSessionId, []);
    const originalC = requiredTask(initial, "/root/a/b/c");
    const controls = $(
      `[data-testid="subagent-user-controls"][data-child-session-id="${originalC.childSessionId}"]`,
    );
    await controls.waitForDisplayed({ timeout: 30000 });
    await controls
      .$(`[data-testid="${TID_CHAT_CONTEXT_USAGE_TRIGGER}"]`)
      .waitForDisplayed({ timeout: 30000 });
    const stopChild = controls.$('[data-testid="subagent-user-stop"]');
    await stopChild.waitForEnabled({ timeout: 30000 });
    expect(await controls.$('[data-testid="subagent-user-send"]').isExisting()).toBe(false);
    await stopChild.click();
    const childStopped = await waitForGraph(
      rootSessionId,
      (graph) => taskAt(graph, "/root/a/b/c")?.status === "killed",
      "详情暂停没有停止原孙代理",
    );
    for (const path of ["/root", "/root/a", "/root/a/b"])
      expect(requiredTask(childStopped, path).status).toBe("running");
    const childInput = controls.$('[data-testid="subagent-user-input"]');
    const resumePrompt = `${PREFIX}C_UI_RESUME`;
    await childInput.setValue(resumePrompt);
    // 子详情复用 Main 的普通 Enter 判定，修饰键不能误发并恢复已暂停的目标。
    for (const modifier of [Key.Control, Key.Command]) {
      await childInput.click();
      await browser
        .action("key")
        .down(modifier)
        .down(Key.Enter)
        .up(Key.Enter)
        .up(modifier)
        .perform();
      expect((await childInput.getValue()).trim()).toBe(resumePrompt);
      await expectNoUpstreamRequestForTextWithin(resumePrompt, 1500);
      const stillStopped = requiredTask(readGraph(rootSessionId)!, "/root/a/b/c");
      expect(stillStopped.status).toBe("killed");
      expect(stillStopped.multiAgent.runGeneration).toBe(originalC.multiAgent.runGeneration);
    }
    expect(await controls.$('[data-testid="subagent-user-stop"]').isExisting()).toBe(false);
    await controls.$('[data-testid="subagent-user-send"]').click();
    await waitForFiles(["c-ui-started.txt"]);
    const userResumed = await waitForGraph(
      rootSessionId,
      (graph) => taskAt(graph, "/root/a/b/c")?.status === "running",
      "详情输入没有续接原孙代理",
    );
    assertSameIdentities(initial, userResumed);
    expect(requiredTask(userResumed, "/root/a/b/c").multiAgent.runGeneration).toBe(
      originalC.multiAgent.runGeneration + 1,
    );
    await recordPhase("user-paused-and-resumed-grandchild-from-details", userResumed);
    await recordPhase("four-level-tree-before-stop", initial);

    const rootShellBeforeStop = (await listSystemProcesses()).find(
      ({ pid }) => pid === rootShellPid,
    );
    expect(rootShellBeforeStop?.command.replaceAll("\\", "/")).toContain(
      gateDirectory.replaceAll("\\", "/"),
    );
    expect(rootShellBeforeStop?.command).toContain("root.release");
    await clickV4Stop();
    await waitForV4Pane(
      (state) => state.sessionId === rootSessionId && !state.canStop,
      "Main Stop 没有结束当前 Root turn",
    );
    // UI 取消完成早于异步进程树终止；确认原 shell 退出后再放行文件门闩，避免测试自己制造完成竞态。
    await browser.waitUntil(
      async () => !(await listSystemProcesses()).some(({ pid }) => pid === rootShellPid),
      { timeout: 15000, timeoutMsg: "Main Stop 后原 Root Bash 进程未退出" },
    );
    const afterStop = readGraph(rootSessionId);
    expect(afterStop).not.toBeNull();
    for (const path of CHILD_PATHS) {
      expect(taskAt(afterStop!, path)?.status).toBe("running");
    }
    await assertNativeRunningTree(afterStop!, CHILD_PATHS);
    for (const name of ["root", "a", "b", "c"]) {
      expect(await readCounter(`${name}-started.txt`)).toEqual(["started"]);
      expect(await readCounter(`${name}-done.txt`)).toEqual([]);
    }
    await recordPhase("main-stopped-descendants-running", afterStop!, {
      rootShellPid,
      rootShellExited: true,
    });
    // Root 门闩也释放：若 Stop 没取消 Root，下面的 root-done 反断言会失败。
    await releaseGate("root");
    await releaseGate("descendants");
    await waitForFiles(["a-done.txt", "b-done.txt", "c-done.txt"]);
    const completed = await waitForGraph(
      rootSessionId,
      (graph) => CHILD_PATHS.every((path) => taskAt(graph, path)?.status === "completed"),
      "Main Stop 后子孙未完成",
    );
    assertSameIdentities(initial, completed);
    for (const name of ["a", "b", "c"]) {
      expect(await readCounter(`${name}-done.txt`)).toEqual(["done"]);
    }
    expect(await readCounter("root-done.txt")).toEqual([]);
    expect((await getV4PaneSnapshot()).canStop).toBe(false);

    const originalA = requiredTask(initial, "/root/a");
    await sendV4Prompt(`${PREFIX}WARM_PARENT: continue the existing /root/a with a second task.`);
    await waitForV4AssistantMessageContaining(`${PREFIX}WARM_ACCEPTED`);
    await assertReceivedMessageStyle(
      initial.rootSessionId,
      NATIVE_VIEWPORT,
      "zai-dark",
      "zh-CN",
      "received-workflow-style-dark-zh",
    );
    await assertReceivedMessageStyle(
      initial.rootSessionId,
      NARROW_MESSAGE_VIEWPORT,
      "zai-light",
      "en-US",
      "received-workflow-style-light-en-narrow",
    );
    try {
      await assertReceivedMessageStyle(
        initial.rootSessionId,
        { width: 390, height: 844 },
        "zai-dark",
        "zh-CN",
        "received-workflow-style-dark-zh-390",
        true,
      );
      await assertReceivedMessageStyle(
        initial.rootSessionId,
        { width: 390, height: 844 },
        "zai-light",
        "en-US",
        "received-workflow-style-light-en-390",
        true,
      );
    } finally {
      await setNotificationViewport(null);
    }
    await setV4ElectronWindowSize(NATIVE_VIEWPORT.width, NATIVE_VIEWPORT.height);
    await setAgentPresentation("zai-dark", "zh-CN");
    const warm = await waitForGraph(
      rootSessionId,
      (graph) => {
        const child = taskAt(graph, "/root/a");
        return (
          child?.status === "completed" &&
          child.multiAgent.runGeneration === originalA.multiAgent.runGeneration + 1
        );
      },
      "Warm followup 没有在原 a 上完成新一轮任务",
    );
    assertSameIdentities(initial, warm);
    await assertFixtureRequest("a-done-2", [
      `${PREFIX}A_START`,
      `${PREFIX}A_DONE_1`,
      `${PREFIX}A_TASK_2`,
    ]);
    await recordPhase("warm-followup-same-identity", warm);

    await sendV4Prompt(
      `${PREFIX}COLD_PARENT: give the existing /root/a one task that remains active until the test releases it.`,
    );
    await waitForV4AssistantMessageContaining(`${PREFIX}COLD_ACCEPTED`);
    await waitForFiles(["cold-started.txt"]);
    const beforeCold = await waitForGraph(
      rootSessionId,
      (graph) => {
        const child = taskAt(graph, "/root/a");
        return (
          child?.status === "running" &&
          child.multiAgent.runGeneration === originalA.multiAgent.runGeneration + 2
        );
      },
      "冷重启前 a 没有执行真实工具",
    );
    assertSameIdentities(initial, beforeCold);
    await assertNativeRunningTree(beforeCold, ["/root/a"]);
    await openNativeChild(originalA.childSessionId);
    await assertChildTranscript(originalA.childSessionId, [`${PREFIX}A_DONE_2`]);
    await sendV4Prompt(
      `${PREFIX}QUEUE_PARENT: only send a message to /root/a; do not start another task.`,
    );
    await waitForV4AssistantMessageContaining(`${PREFIX}QUEUE_ACCEPTED`);
    await waitForV4Pane((state) => !state.canStop, "入队消息后 Root 未结束");
    expect(requiredTask(readGraph(rootSessionId)!, "/root/a").multiAgent.runGeneration).toBe(
      requiredTask(beforeCold, "/root/a").multiAgent.runGeneration,
    );
    const oldElectronPid = await browser.electron.execute(() => process.pid);
    await recordPhase("before-real-cold-restart", readGraph(rootSessionId)!, { oldElectronPid });

    // 复用既有真实旧进程树退出屏障，不能用 renderer reload 充当冷启动。
    await restartIntoWorkspacePreservingProfile();
    const newElectronPid = await browser.electron.execute(() => process.pid);
    expect(newElectronPid).not.toBe(oldElectronPid);
    expect(isProcessAlive(oldElectronPid)).toBe(false);
    const rootTask = $(`[data-testid="${testId(TID_TASK_ITEM, rootSessionId)}"]`);
    await rootTask.waitForDisplayed({ timeout: 30000 });
    await rootTask.click();
    await waitForV4Pane(
      (state) => state.sessionId === rootSessionId && !state.canStop,
      "冷重开没有恢复原 Root 会话",
    );
    // 持久 graph 是上次 owner 保存的快照；历史只读页不必为了读取而启动 Runtime。
    // 冷页面的 live 事实由新进程投影判断，不能把原始保存状态当仍有活进程。
    const cold = readGraph(rootSessionId);
    if (!cold) throw new Error("冷重开丢失持久 agent graph");
    assertSameIdentities(initial, cold);
    await assertChildSessionsHidden(cold);
    // 现行产品会收起仅有已结束 Agent 的胶囊（v4ConversationStatusPanel 回归已明确此规则）。
    // 不要求空面板挂载；仍严格检查原生运行行/现存面板计数，后面保留旧进程与工具门闩断言。
    await browser.waitUntil(
      async () =>
        browser.execute((panelId) => {
          const panels = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid="${panelId}"]`),
          );
          return (
            document.querySelectorAll('[data-background-task-kind="agent"]').length === 0 &&
            panels.every((panel) => panel.dataset.runningAgentCount === "0")
          );
        }, TID_CHAT_SUMMARY_PANEL),
      { timeout: 30000, timeoutMsg: "原生 UI 冷重开仍显示幽灵 running 代理" },
    );
    // 即使旧工具的门闩现在打开，它也不能在新进程中偷偷复跑。
    await releaseGate("cold");
    expect(await readCounter("cold-done.txt")).toEqual([]);
    await recordPhase("cold-history-no-ghost-running", cold, { oldElectronPid, newElectronPid });

    await sendV4Prompt(
      `${PREFIX}RESTORED_PARENT: continue the same /root/a after restart, retaining its earlier conversation and queued message.`,
    );
    await waitForV4AssistantMessageContaining(`${PREFIX}RESTORED_ACCEPTED`);
    await waitForFiles(["restored-started.txt"]);
    const restored = await waitForGraph(
      rootSessionId,
      (graph) => {
        const child = taskAt(graph, "/root/a");
        return (
          child?.status === "running" &&
          child.multiAgent.resident &&
          child.multiAgent.runGeneration >
            requiredTask(beforeCold, "/root/a").multiAgent.runGeneration
        );
      },
      "冷 followup 没有唤醒原 a",
    );
    assertSameIdentities(initial, restored);
    await assertFixtureRequest("restored-gate", [
      `${PREFIX}A_START`,
      `${PREFIX}A_DONE_1`,
      `${PREFIX}A_DONE_2`,
      `${PREFIX}A_TASK_4`,
      `${PREFIX}COLD_QUEUED_MAIL`,
    ]);
    await assertNativeRunningTree(restored, ["/root/a"]);
    await openNativeChild(originalA.childSessionId);
    await assertChildTranscript(originalA.childSessionId, [`${PREFIX}A_DONE_2`]);
    await releaseGate("restored");
    await waitForFiles(["restored-done.txt"]);
    const final = await waitForGraph(
      rootSessionId,
      (graph) => taskAt(graph, "/root/a")?.status === "completed",
      "冷 followup 没有完成",
    );
    assertSameIdentities(initial, final);
    await assertChildTranscript(originalA.childSessionId, [`${PREFIX}A_DONE_4`]);
    for (const name of ["root", "a", "b", "c", "cold", "restored"]) {
      expect(await readCounter(`${name}-started.txt`)).toEqual(["started"]);
    }
    expect(await readCounter("root-done.txt")).toEqual([]);
    expect(await readCounter("cold-done.txt")).toEqual([]);
    expect(await readCounter("restored-done.txt")).toEqual(["done"]);
    await assertChildSessionsHidden(final);
    await assertCaptureComplete();
    await recordPhase("cold-followup-completed-original-identity", final);
  });
});

function taskAt(graph: AgentGraph, path: string) {
  return graph.tasks.find((task) => task.multiAgent.agentPath === path);
}

function requiredTask(graph: AgentGraph, path: string): GraphTask {
  const task = taskAt(graph, path);
  if (!task) throw new Error(`Graph 缺少 ${path}`);
  return task;
}

function readGraph(rootId: string): AgentGraph | null {
  const db = new DatabaseSync(join(paths.storageRoot, "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare("SELECT data FROM session_entry WHERE session_id = ? AND type = 'multi_agent/graph'")
      .get(rootId) as { data: string } | undefined;
    if (!row) return null;
    const graph = JSON.parse(row.data) as AgentGraph;
    expect(graph.version).toBe(1);
    expect(graph.rootSessionId).toBe(rootId);
    return graph;
  } finally {
    db.close();
  }
}

async function waitForGraph(
  rootId: string,
  predicate: (graph: AgentGraph) => boolean,
  timeoutMsg: string,
) {
  let graph: AgentGraph | null = null;
  await browser.waitUntil(
    async () => {
      graph = readGraph(rootId);
      return graph !== null && predicate(graph);
    },
    { timeout: 60000, timeoutMsg },
  );
  if (!graph) throw new Error(timeoutMsg);
  return graph as AgentGraph;
}

function identities(graph: AgentGraph) {
  return graph.tasks
    .map((task) => ({
      path: task.multiAgent.agentPath,
      parentPath: task.multiAgent.parentPath,
      agentId: task.agentId,
      childSessionId: task.childSessionId,
      parentSessionId: task.parentSessionId,
      rootSessionId: task.multiAgent.rootSessionId,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function assertIdentityTree(graph: AgentGraph) {
  expect(graph.tasks.map((task) => task.multiAgent.agentPath).sort()).toEqual([
    "/root",
    ...CHILD_PATHS,
  ]);
  expect(new Set(graph.tasks.map((task) => task.agentId)).size).toBe(4);
  expect(new Set(graph.tasks.map((task) => task.childSessionId)).size).toBe(4);
  const db = new DatabaseSync(join(paths.storageRoot, "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    for (const path of CHILD_PATHS) {
      const child = requiredTask(graph, path);
      const parentPath = path.slice(0, path.lastIndexOf("/"));
      const parent = requiredTask(graph, parentPath);
      expect(child.multiAgent.parentPath).toBe(parentPath);
      expect(child.multiAgent.rootSessionId).toBe(graph.rootSessionId);
      expect(child.parentSessionId).toBe(parent.childSessionId);
      const row = db
        .prepare("SELECT parent_id, task_type FROM session WHERE id = ?")
        .get(child.childSessionId) as { parent_id: string; task_type: string } | undefined;
      expect(row).toEqual({ parent_id: parent.childSessionId, task_type: "subagent_child" });
    }
    const parents = graph.tasks.map((task) => task.childSessionId);
    const childRows = db
      .prepare(
        `SELECT id FROM session WHERE task_type = 'subagent_child' AND parent_id IN (${parents.map(() => "?").join(",")})`,
      )
      .all(...parents) as Array<{ id: string }>;
    expect(childRows.map((row) => row.id).sort()).toEqual(
      CHILD_PATHS.map((path) => requiredTask(graph, path).childSessionId).sort(),
    );
  } finally {
    db.close();
  }
}

function assertSameIdentities(first: AgentGraph, next: AgentGraph) {
  assertIdentityTree(next);
  expect(identities(next)).toEqual(identities(first));
}

async function nativeAgentRows(): Promise<NativeAgentRow[]> {
  return browser.execute(
    (panelId) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid="${panelId}"] [data-background-task-kind="agent"]`,
        ),
      ).map((element) => ({
        path: element.dataset.agentPath ?? null,
        depth: element.dataset.agentDepth ?? null,
        childSessionId: element.dataset.childSessionId ?? null,
        status: element.dataset.workStatus ?? null,
        text: element.innerText,
      })),
    TID_CHAT_SUMMARY_PANEL,
  );
}

async function assertNativeRunningTree(graph: AgentGraph, expectedPaths: readonly string[]) {
  try {
    await openV4RunningBackgroundWorks();
  } catch (error) {
    // 原生首跑未进入树断言时，保全实际面板数据，避免用 runner 超时猜测 Runtime 状态。
    const panels = await browser.execute(
      (panelId) =>
        Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${panelId}"]`)).map(
          (panel) => ({
            data: { ...panel.dataset },
            visible: panel.getClientRects().length > 0,
            sections: Array.from(
              panel.querySelectorAll<HTMLElement>("[data-status-section-trigger]"),
            ).map((section) => ({
              type: section.dataset.statusSectionTrigger,
              expanded: section.getAttribute("aria-expanded"),
            })),
            rowCount: panel.querySelectorAll('[data-background-task-kind="agent"]').length,
          }),
        ),
      TID_CHAT_SUMMARY_PANEL,
    );
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      join(evidenceDirectory, "status-panel-diagnostic.json"),
      JSON.stringify({ panels, rows: await nativeAgentRows() }, null, 2),
    );
    await browser.saveScreenshot(join(evidenceDirectory, "status-panel-failed.png"));
    throw error;
  }
  let rows: NativeAgentRow[] = [];
  await browser.waitUntil(
    async () => {
      rows = await nativeAgentRows();
      return expectedPaths.every((path) => rows.some((row) => row.path === path));
    },
    { timeout: 30000, timeoutMsg: `原生树缺少路径 ${expectedPaths.join(", ")}` },
  );
  expect(rows.map((row) => row.path).sort()).toEqual([...expectedPaths].sort());
  for (const path of expectedPaths) {
    const row = rows.find((candidate) => candidate.path === path)!;
    expect(row.childSessionId).toBe(requiredTask(graph, path).childSessionId);
    expect(row.depth).toBe(String(path.split("/").length - 2));
    expect(row.status).toBe("running");
    expect(row.text).toContain(path);
  }
}

async function openNativeChild(childSessionId: string) {
  const trigger = $(
    `[data-running-subagent-session-trigger="true"][data-child-session-id="${childSessionId}"]`,
  );
  await trigger.waitForExist({ timeout: 30000 });
  // 详情入口是透明同级覆盖按钮；点击真实可见行并由原生 hit test 命中按钮，避免把透明层误判为没有入口。
  const row = $(`[data-background-task-kind="agent"][data-child-session-id="${childSessionId}"]`);
  await row.scrollIntoView({ block: "center" });
  try {
    await row.waitForDisplayed({ timeout: 30000 });
  } catch (error) {
    const layout = await browser.execute(
      (id) =>
        Array.from(document.querySelectorAll<HTMLElement>(`[data-child-session-id="${id}"]`)).map(
          (element) => {
            const ancestors = [];
            for (
              let node: HTMLElement | null = element;
              node && ancestors.length < 10;
              node = node.parentElement
            ) {
              const rect = node.getBoundingClientRect(),
                style = getComputedStyle(node);
              ancestors.push({
                tag: node.tagName,
                className: node.className,
                testId: node.dataset.testid,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                overflow: style.overflow,
                contentVisibility: style.contentVisibility,
              });
            }
            return ancestors;
          },
        ),
      childSessionId,
    );
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      join(evidenceDirectory, "child-entry-layout.json"),
      JSON.stringify(layout, null, 2),
    );
    await browser.saveScreenshot(join(evidenceDirectory, "child-entry-failed.png"));
    throw error;
  }
  await row.click();
}

async function assertNestedChildUi(graph: AgentGraph) {
  // Linux 容器默认系统语言为英文；中文计数与深色截图须先显式设定语言，不能依赖宿主偏好。
  await setAgentPresentation("zai-dark", "zh-CN");
  const [a, b, c] = ["/root/a", "/root/a/b", "/root/a/b/c"].map((path) =>
    requiredTask(graph, path),
  );
  expect(
    new Set([a!.multiAgent.nickname, b!.multiAgent.nickname, c!.multiAgent.nickname]).size,
  ).toBe(3);
  for (const task of [a!, b!, c!]) expect(task.multiAgent.nickname).toMatch(/^[A-Za-z]+(?: \d+)?$/);
  await openNativeChild(a!.childSessionId);
  // 打开详情有退出/进入过渡；先等目标控件就绪，不能把前一帧工具栏的坐标当成新面板。
  await $(
    `[data-testid="subagent-user-controls"][data-child-session-id="${a!.childSessionId}"]`,
  ).waitForDisplayed({ timeout: 30000 });
  const addTab = $("[data-side-pane-add-tab-trigger]");
  await addTab.waitForClickable({ timeout: 30000 });
  await addTab.click();
  const entry = $('[data-side-pane-open-tab-item="agents"]');
  try {
    await entry.waitForDisplayed({ timeout: 30000 });
  } catch (error) {
    await mkdir(evidenceDirectory, { recursive: true });
    await browser.saveScreenshot(join(evidenceDirectory, "agent-launcher-failed.png"));
    throw error;
  }
  await entry.click();
  const parentRow = $(`button[data-child-session-id="${a!.childSessionId}"][data-agent-path]`);
  await parentRow.waitForDisplayed({ timeout: 30000 });
  expect(await parentRow.getText()).toContain(a!.multiAgent.nickname!);
  await parentRow.click();
  const aControls = $(
    `[data-testid="subagent-user-controls"][data-child-session-id="${a!.childSessionId}"]`,
  );
  const aInput = aControls.$('[data-testid="subagent-user-input"]');
  await aInput.waitForDisplayed({ timeout: 30000 });
  await aInput.setValue("UNSENT_PARENT_DRAFT");
  try {
    await browser.waitUntil(
      async () =>
        (await aControls.$('[data-testid="subagent-composer-children"]').getText()).includes(
          "下级代理 2 · 2",
        ),
      { timeout: 5000, timeoutMsg: "A 的下级统计没有包含 B/C" },
    );
  } catch (error) {
    await mkdir(evidenceDirectory, { recursive: true });
    await browser.saveScreenshot(join(evidenceDirectory, "child-descendant-count-failed.png"));
    const detail = await browser.execute(
      (sessionId) =>
        Array.from(document.querySelectorAll<HTMLElement>(`[data-session-id="${sessionId}"]`)).map(
          (element) => ({
            testId: element.dataset.testid,
            rows: Array.from(
              element.querySelectorAll<HTMLElement>('[data-row-kind="subagent"],[data-agent-path]'),
            ).map((row) => ({ text: row.innerText, path: row.dataset.agentPath })),
          }),
        ),
      a!.childSessionId,
    );
    await writeFile(
      join(evidenceDirectory, "child-descendant-count.json"),
      JSON.stringify(detail, null, 2),
    );
    throw error;
  }
  await recordPhase("child-owned-descendants-count", readGraph(graph.rootSessionId)!);
  await aControls.$('[data-testid="subagent-composer-children"]').click();
  const region = $('[data-testid="subagent-nested-region"]');
  const bRow = region.$(`button[data-child-session-id="${b!.childSessionId}"][data-agent-path]`);
  await bRow.waitForDisplayed({ timeout: 30000 });
  await bRow.click();
  const bControls = region.$(
    `[data-testid="subagent-user-controls"][data-child-session-id="${b!.childSessionId}"]`,
  );
  const bInput = bControls.$('[data-testid="subagent-user-input"]');
  await bInput.waitForDisplayed({ timeout: 30000 });
  await bInput.setValue("UNSENT_DESCENDANT_DRAFT");
  await region.$('[data-testid="subagent-nested-back"]').click();
  await aInput.waitForDisplayed({ timeout: 30000 });
  expect(await aInput.getValue()).toBe("UNSENT_PARENT_DRAFT");
  await aControls.$('[data-testid="subagent-composer-children"]').click();
  await bRow.waitForDisplayed({ timeout: 30000 });
  await bRow.click();
  await bInput.waitForDisplayed({ timeout: 30000 });
  expect(await bInput.getValue()).toBe("UNSENT_DESCENDANT_DRAFT");
  await bControls.$('[data-testid="subagent-composer-children"]').click();
  const inner = region.$('[data-testid="subagent-nested-region"]');
  const cRow = inner.$(`button[data-child-session-id="${c!.childSessionId}"][data-agent-path]`);
  await cRow.waitForDisplayed({ timeout: 30000 });
  await cRow.click();
  await inner
    .$(`[data-testid="subagent-user-controls"][data-child-session-id="${c!.childSessionId}"]`)
    .waitForDisplayed({ timeout: 30000 });
  await recordPhase("nested-child-ui-and-agent-directory", readGraph(graph.rootSessionId)!);
  await setAgentPresentation("zai-light", "en-US");
  await recordPhase("nested-child-ui-light-en", readGraph(graph.rootSessionId)!);
  await setAgentPresentation("zai-dark", "zh-CN");
  await $('[data-side-pane-tab-id][data-state="active"] button').click();
  for (const path of CHILD_PATHS)
    expect(requiredTask(readGraph(graph.rootSessionId)!, path).status).toBe("running");
}

async function setAgentPresentation(theme: string, locale: string) {
  const error = await browser.executeAsync(
    (next, done: (error?: string) => void) => {
      const actions = (window as typeof window & { __testActions?: Record<string, unknown> })
        .__testActions;
      if (typeof actions?.setTheme !== "function" || typeof actions?.setLocale !== "function") {
        done("Missing theme/locale test actions");
        return;
      }
      (actions.setTheme as (theme: string) => void)(next.theme);
      (actions.setLocale as (locale: string) => void)(next.locale);
      requestAnimationFrame(() => requestAnimationFrame(() => done()));
    },
    { theme, locale },
  );
  if (error) throw new Error(error);
}

async function assertChildTranscript(childSessionId: string, markers: string[]) {
  const child = $(`[data-session-id="${childSessionId}"]`);
  await child.waitForDisplayed({ timeout: 30000 });
  await browser.waitUntil(
    async () => {
      const text = await child.getText();
      // DONE markers exist only in assistant responses, never in the synthetic task prompts.
      return markers.every((marker) => text.includes(marker));
    },
    { timeout: 30000, timeoutMsg: `原 child 详情缺少转录 ${markers.join(", ")}` },
  );
  expect(await child.$('[contenteditable="true"]').isExisting()).toBe(false);
}

async function assertChildSessionsHidden(graph: AgentGraph) {
  for (const path of CHILD_PATHS) {
    expect(
      await $(
        `[data-testid="${testId(TID_TASK_ITEM, requiredTask(graph, path).childSessionId)}"]`,
      ).isExisting(),
    ).toBe(false);
  }
}

async function readCounter(file: string): Promise<string[]> {
  try {
    return (await readFile(join(gateDirectory, file), "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForFiles(files: string[]) {
  await browser.waitUntil(
    async () => (await Promise.all(files.map(readCounter))).every((lines) => lines.length > 0),
    { timeout: 60000, timeoutMsg: `真实工具没有产生文件屏障: ${files.join(", ")}` },
  );
}

async function releaseGate(name: string) {
  await writeFile(join(gateDirectory, `${name}.release`), "released\n");
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

function scenarioRequests(): Promise<UpstreamRequestEvidence[]> {
  return getUpstreamRequestEvidence({
    includes: [PREFIX],
    excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
  });
}

async function assertFixtureRequest(name: string, includedText: string[]) {
  let matches: UpstreamRequestEvidence[] = [];
  await browser.waitUntil(
    async () => {
      matches = (await scenarioRequests()).filter(
        (record) => record.fixtureId === `v2-native-${name}`,
      );
      return matches.length > 0;
    },
    { timeout: 30000, timeoutMsg: `没有捕获到实际请求 v2-native-${name}` },
  );
  expect(matches).toHaveLength(1);
  const body = JSON.stringify(matches[0]!.requestJson);
  for (const text of includedText) expect(body).toContain(text);
}

async function assertCaptureComplete() {
  let requests: UpstreamRequestEvidence[] = [];
  await browser.waitUntil(
    async () => {
      requests = await scenarioRequests();
      return EXPECTED_FIXTURES.every((id) => requests.some((record) => record.fixtureId === id));
    },
    { timeout: 30000, timeoutMsg: "Native V2 缺少完整 upstream 请求证据" },
  );
  expect(requests.map((record) => record.fixtureId).sort()).toEqual([...EXPECTED_FIXTURES].sort());
  for (const request of requests) expect(request.statusCode).toBe(200);
  for (const name of ["root-spawn-a", "a-spawn-b", "b-spawn-c", "c-gate"]) {
    const request = requests.find((record) => record.fixtureId === `v2-native-${name}`)!;
    const body = request.requestJson as { tools?: Array<{ name?: string }> };
    const names = (body.tools ?? []).map((tool) => tool.name);
    for (const operation of [
      "spawn_agent",
      "send_message",
      "followup_task",
      "list_agents",
      "wait_agent",
      "interrupt_agent",
    ]) {
      expect(names).toContain(`collaboration_${operation}`);
    }
  }
}

async function assertReceivedMessageStyle(
  sessionId: string,
  viewport: { width: number; height: number },
  theme: string,
  locale: string,
  phaseName: string,
  emulated = false,
) {
  if (emulated) await setNotificationViewport(viewport);
  else await setV4ElectronWindowSize(viewport.width, viewport.height);
  expect(await browser.execute(() => window.innerWidth)).toBe(viewport.width);
  await setAgentPresentation(theme, locale);
  const incoming = $('[data-notification-source="agent"]');
  await incoming.waitForExist({ timeout: 30000 });
  expect(await incoming.getAttribute("data-testid")).toMatch(/^chat-workflow-notification-row-/);
  expect(await $('[data-testid="agent-received-message"]').isExisting()).toBe(false);
  expect(await incoming.$(".tool-summary-kind-label").getText()).toBe(
    locale === "zh-CN" ? "任务输出" : "Task output",
  );
  expect(await incoming.getText()).not.toContain("Message Type:");
  await incoming.scrollIntoView({ block: "center" });
  const senderLayout = await browser.execute(() => {
    const row = document.querySelector<HTMLElement>('[data-notification-source="agent"]');
    const sender = row?.querySelector<HTMLElement>('[data-testid="tool-summary-source"]');
    if (!row || !sender) throw new Error("Received message sender missing");
    const name = sender.firstElementChild;
    if (!(name instanceof HTMLElement)) throw new Error("Agent identity color missing");
    const avatar = name.querySelector<SVGSVGElement>("[data-subagent-avatar]");
    if (!avatar) throw new Error("Original workflow avatar missing");
    const eyes = avatar.querySelector<SVGGElement>('[data-eye-expression="pill"]');
    const nameText = Array.from(name.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
    );
    if (!nameText) throw new Error("Agent name missing");
    const range = document.createRange();
    range.selectNode(nameText);
    const lines = new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top)));
    return {
      lines: lines.size,
      contained: sender.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1,
      name: name.textContent,
      color: getComputedStyle(name).color,
      neutralColor: getComputedStyle(sender).color,
      avatarColor: getComputedStyle(avatar).color,
      avatarSize: avatar.getBoundingClientRect().width,
      expression: avatar.dataset.expression,
      eyeCount: avatar.querySelector('[data-eye-expression="pill"]')?.children.length ?? 0,
      eyesVisible: Boolean(
        eyes &&
        getComputedStyle(eyes).display !== "none" &&
        eyes.getBoundingClientRect().height > 0,
      ),
    };
  });
  expect(senderLayout).toMatchObject({ lines: 1, contained: true, name: "Ada" });
  expect(senderLayout.color).not.toBe(senderLayout.neutralColor);
  expect(senderLayout.avatarColor).toBe(senderLayout.color);
  expect(senderLayout.avatarSize).toBe(12);
  expect(senderLayout.expression).toBe("pill");
  expect(senderLayout.eyeCount).toBe(2);
  expect(senderLayout.eyesVisible).toBe(true);
  // 来信复用原工作流问答通知的正文面板与折叠，不再渲染 SendMessage 字段详情。
  expect(await incoming.$("svg.lucide-send").isExisting()).toBe(false);
  expect(await incoming.$("svg.lucide-workflow").isExisting()).toBe(true);
  const toggle = incoming.$(`[data-testid^="${TID_TOOL_SUMMARY_TRIGGER}-"][aria-expanded]`);
  await toggle.waitForClickable({ timeout: 30000 });
  await toggle.click();
  const body = incoming.$('[data-testid="notification-message-body"]');
  await body.waitForDisplayed({ timeout: 30000 });
  await body.scrollIntoView({ block: "center" });
  expect(await body.getTagName()).toBe("p");
  expect(await incoming.$("dl").isExisting()).toBe(false);
  // 展开动画和滚动裁剪都会影响可读性；滚到正文后等待实际文本，而非仅判断元素存在。
  const initialDetailState = await browser.execute(() => {
    const body = document.querySelector<HTMLElement>(
      '[data-notification-source="agent"] [data-testid="notification-message-body"]',
    );
    if (!body) throw new Error("Received message body missing");
    const bounds = body.getBoundingClientRect();
    return {
      textLength: body.textContent?.length ?? 0,
      width: bounds.width,
      height: bounds.height,
    };
  });
  await browser.waitUntil(async () => (await body.getText()).includes(`${PREFIX}A_DONE_1`), {
    timeout: 30000,
    timeoutMsg: "原消息组件展开后未显示实际汇报正文",
  });
  expect(await body.getText()).toContain(`${PREFIX}A_DONE_1`);
  // 身份位于正文之后，也必须先滚到可读区域，不能在展开过渡中把空字符串当成内容丢失。
  const participants = incoming.$('[data-testid="notification-context"]');
  await participants.scrollIntoView({ block: "center" });
  await browser.waitUntil(async () => (await participants.getText()).includes("/root/a"), {
    timeout: 30000,
    timeoutMsg: "原通知展开后未显示可读的发件身份",
  });
  expect(await participants.getText()).toContain("/root/a");
  await recordPhase(phaseName, readGraph(sessionId)!, {
    viewport,
    theme,
    locale,
    senderLayout,
    initialDetailState,
  });
  await toggle.click();
  await body.waitForDisplayed({ reverse: true, timeout: 30000 });
  await incoming.$('[data-testid="tool-summary-source"]').waitForDisplayed({ timeout: 30000 });
}

// 原生窗口有最小宽度；仅在容器测试里沿既有 renderer emulation 检查共享通知组件的手机尺寸。
async function setNotificationViewport(viewport: { width: number; height: number } | null) {
  await browser.electron.execute(async (electron, dimensions) => {
    const target = electron.BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && window.isVisible(),
    );
    if (!target) throw new Error("Notification viewport window missing");
    if (!target.webContents.debugger.isAttached()) target.webContents.debugger.attach("1.3");
    await target.webContents.debugger.sendCommand(
      dimensions ? "Emulation.setDeviceMetricsOverride" : "Emulation.clearDeviceMetricsOverride",
      dimensions ? { ...dimensions, deviceScaleFactor: 1, mobile: false } : {},
    );
  }, viewport);
}

async function recordPhase(name: string, graph: AgentGraph, extra: Record<string, unknown> = {}) {
  await mkdir(evidenceDirectory, { recursive: true });
  observations.push({
    name,
    ...extra,
    identities: identities(graph),
    persistedGraphStates: graph.tasks.map((task) => ({
      path: task.multiAgent.agentPath,
      status: task.status,
      resident: task.multiAgent.resident,
      runGeneration: task.multiAgent.runGeneration,
    })),
    pane: await getV4PaneSnapshot(),
    nativeRows: await nativeAgentRows(),
  });
  await browser.saveScreenshot(join(evidenceDirectory, `${name}.png`));
}
