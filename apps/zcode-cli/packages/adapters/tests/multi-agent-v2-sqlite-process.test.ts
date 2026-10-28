import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";

interface ProcessResult {
  ok: boolean;
  pid: number;
  rootSessionId: string;
  workerId: string;
  workerSessionId: string;
  lostId: string;
  lostSessionId: string;
  modelCalls: number;
  message?: string;
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function runProcess(input: { mode: "write" | "read"; rootSessionId: string; dbPath: string; directory: string }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL("./fixtures/multi-agent-v2-sqlite-process.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let result: ProcessResult | undefined;
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${input.mode} process exceeded 30 seconds${stderr ? `: ${stderr}` : ""}`));
    }, 30_000);
    child.stderr?.on("data", (data: Buffer) => { stderr = `${stderr}${data.toString()}`.slice(-8_000); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("message", (message: { type?: string; result?: ProcessResult }) => {
      if (message.type === "ready") child.send(input);
      if (message.type === "result") result = message.result;
    });
    // IPC success alone is insufficient: SQLite must close and the process must actually exit.
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal || !result?.ok) {
        reject(new Error(`${input.mode} process failed (exit ${code}, signal ${signal}): ${result?.message ?? stderr}`));
      } else resolve(result);
    });
  });
}

describe("Multi-Agent V2 SQLite recovery across fresh OS processes", () => {
  it("restores IDs, committed transcripts, mailbox and permission ceiling after a real database close and process exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-v2-sqlite-process-"));
    directories.push(directory);
    const input = { rootSessionId: createSessionId(), dbPath: join(directory, "session.sqlite"), directory };
    const writer = await runProcess({ ...input, mode: "write" });
    const reader = await runProcess({ ...input, mode: "read" });
    expect(writer.pid).not.toBe(reader.pid);
    expect(reader.rootSessionId).toBe(input.rootSessionId);
    expect(reader.workerId).toBe(writer.workerId);
    expect(reader.workerSessionId).toBe(writer.workerSessionId);
    expect(reader.lostId).toBe(writer.lostId);
    expect(reader.lostSessionId).toBe(writer.lostSessionId);
    expect(writer.modelCalls).toBe(3);
    expect(reader.modelCalls).toBe(2);
  }, 65_000);
});
