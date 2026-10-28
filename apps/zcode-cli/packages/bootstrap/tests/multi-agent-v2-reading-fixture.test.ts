import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { multiAgentToolName, SessionEventType, type ModelRequest } from "@zcode/contracts";
import { expect, it, vi } from "vitest";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const MATERIAL = [
  "隔离测试材料，不包含真实作品。",
  "甲样本质量：12 克。",
  "甲试验温度：20 摄氏度。",
  "未请求区间：DO_NOT_READ_SENTINEL。",
  "乙样本质量：18 克。",
  "乙试验温度：20 摄氏度。",
];
const READERS = [
  { task: "alpha", offset: 2, card: "CARD_ALPHA", expected: MATERIAL.slice(1, 3) },
  { task: "beta", offset: 5, card: "CARD_BETA", expected: MATERIAL.slice(4, 6) },
] as const;

function taskPath(request: ModelRequest): string {
  const system = JSON.stringify(request.messages.filter((message) => message.role === "system"));
  return [...system.matchAll(/Task path: (\/root(?:\/[a-z0-9_]+)*)/g)].at(-1)?.[1] ?? "/root";
}

const textResult = (text: string) => ({ text, finishReason: "stop" as const, usage: USAGE });

// T30：只替换模型生成；Read、文件系统、子会话、自动回报和 SQLite 都走正式链路。
// 这验证工具读取与证据归属，不将脚本化回复当作真实 LLM 的阅读/推理能力。
it("reads disjoint material ranges in real child sessions and delivers independently inspectable evidence to Main", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-v2-reading-"));
  const materialPath = join(directory, "隔离资料.txt");
  await writeFile(materialPath, MATERIAL.join("\n"), "utf8");
  const store = await createSqliteSessionStore({ dbPath: join(directory, "sessions.sqlite") });
  const fileSystem = createNodeFileSystemAdapter();
  const reads = vi.spyOn(fileSystem, "readTextFileRange");
  const steps = new Map<string, number>();
  const requests: ModelRequest[] = [];
  let app: Awaited<ReturnType<typeof createRegistryBackedTestApp>> | undefined;
  try {
    app = await createRegistryBackedTestApp({
      env: { ZCODE_STORAGE_DIR: join(directory, "storage") },
      skipUserConfig: true,
      sessionStore: store,
      fileSystemPort: fileSystem,
      runtimeConfig: {
        workingDirectory: directory,
        mode: "yolo",
        modelStreaming: "off",
        compact: { enabled: false },
        mcp: { enabled: false },
        subagents: { enabled: true },
        multiAgentV2: { enabled: true },
        modelSelection: {
          providerId: "zai",
          modelId: "glm-4.6",
          options: { reasoningLevel: "low" },
        },
      },
      modelExecutor: {
        async generateText(request) {
          requests.push(request);
          const path = taskPath(request);
          const step = (steps.get(path) ?? 0) + 1;
          steps.set(path, step);
          if (path === "/root") {
            if (step === 1) {
              return {
                text: "",
                finishReason: "tool-calls",
                usage: USAGE,
                toolCalls: READERS.map((reader) => ({
                  id: `spawn-${reader.task}`,
                  name: multiAgentToolName("spawn_agent"),
                  input: {
                    task_name: reader.task,
                    fork_turns: "none",
                    message: `Read ${materialPath}, lines ${reader.offset}-${reader.offset + 1}; return an evidence card with its source range.`,
                  },
                })),
              };
            }
            if (step === 2) return textResult("delegation accepted");
            return textResult("隔离资料.txt:2-3、5-6：两份证据均已汇总。");
          }
          const reader = READERS.find((candidate) => path === `/root/${candidate.task}`);
          if (!reader) throw new Error(`Unexpected reader path: ${path}`);
          if (step === 1) {
            return {
              text: "",
              finishReason: "tool-calls",
              usage: USAGE,
              toolCalls: [
                {
                  id: `read-${reader.task}`,
                  name: "Read",
                  input: { file_path: materialPath, offset: reader.offset, limit: 2 },
                },
              ],
            };
          }
          expect(step).toBe(2);
          const result = request.messages.find(
            (message) => message.role === "tool" && message.toolCallId === `read-${reader.task}`,
          );
          expect(result).toBeDefined();
          expect(result?.isError).not.toBe(true);
          const content = JSON.stringify(result?.content);
          for (const line of reader.expected) expect(content).toContain(line);
          expect(content).not.toContain("DO_NOT_READ_SENTINEL");
          const other = READERS.find((candidate) => candidate.task !== reader.task)!;
          for (const line of other.expected) expect(content).not.toContain(line);
          return textResult(
            `${reader.card} | 隔离资料.txt:${reader.offset}-${reader.offset + 1}\n${content}`,
          );
        },
      },
    });
    expect(
      (await app.submitPrompt("Delegate two independent material-reading tasks.")).response,
    ).toBe("delegation accepted");
    await vi.waitFor(
      async () => {
        const snapshot = await app!.readSubagents();
        expect(reads.mock.calls.filter(([input]) => input.path === materialPath)).toHaveLength(2);
        expect(snapshot.running).toEqual([]);
        expect(snapshot.ended.items).toHaveLength(2);
        expect(snapshot.ended.items.every((child) => child.status === "success")).toBe(true);
      },
      { timeout: 15_000 },
    );
    const children = (await app.readSubagents()).ended.items;
    expect(children.map((child) => child.agentPath).sort()).toEqual(["/root/alpha", "/root/beta"]);
    const rangeReads = reads.mock.calls
      .map(([input]) => input)
      .filter((input) => input.path === materialPath);
    expect(rangeReads.map((input) => [input.offsetLine, input.limitLines]).sort()).toEqual([
      [1, 2],
      [4, 2],
    ]);
    const spawnEvents = (await app.runtime.getSessionEventStore().getEvents(app.sessionId)).filter(
      (event) => event.type === SessionEventType.SubagentSpawned,
    );
    expect(spawnEvents).toHaveLength(2);
    for (const input of rangeReads) {
      expect(children.some((child) => child.childSessionId === input.trace?.sessionId)).toBe(true);
      expect(input.trace?.traceId).toBe(spawnEvents[0]?.traceId);
    }
    for (const child of children) {
      const messages = await store.messages({ sessionID: child.childSessionId });
      const toolParts = messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool" && part.tool === "Read");
      expect(toolParts).toHaveLength(1);
      expect(toolParts[0]).toMatchObject({
        type: "tool",
        tool: "Read",
        state: { status: "completed", input: { file_path: materialPath, limit: 2 } },
      });
      const transcript = await app.readSubagentTranscript(child.childSessionId);
      expect(JSON.stringify(transcript.messages)).toContain("CARD_");
    }
    expect(
      (
        await app.submitPrompt(
          "Cross-check the two returned evidence cards and summarize their source ranges.",
        )
      ).response,
    ).toBe("隔离资料.txt:2-3、5-6：两份证据均已汇总。");
    const rootHistory = JSON.stringify(
      requests.filter((request) => taskPath(request) === "/root").at(-1)?.messages,
    );
    for (const reader of READERS) {
      expect(rootHistory).toContain(reader.card);
      for (const line of reader.expected) expect(rootHistory).toContain(line);
    }
  } finally {
    await app?.close?.();
    reads.mockRestore();
    store.close();
    // 失败收尾也可能赶上已取消子任务的产物结算；只对本测试临时目录做有界清理。
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 30_000);
