import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionId } from "@zcode/contracts";
import { describe, expect, it } from "vitest";

interface ProcessInput {
  mode: "write" | "read";
  backend: "local" | "memory";
  rootSessionId: string;
  dbPath: string;
  directory: string;
  postId?: string;
}
interface ProcessResult {
  ok: boolean;
  pid: number;
  rootSessionId: string;
  postId: string;
  storedPosts: number;
  entryCount: number;
  modelCalls: number;
  message?: string;
}

function runProcess(input: ProcessInput): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL("./fixtures/message-board-sqlite-process.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let result: ProcessResult | undefined;
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${input.backend}/${input.mode} exceeded 30 seconds: ${stderr}`)); }, 30_000);
    child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-8_000); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("message", (message: { type?: string; result?: ProcessResult }) => {
      if (message.type === "ready") child.send(input);
      if (message.type === "result") result = message.result;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal || !result?.ok) reject(new Error(`${input.backend}/${input.mode} failed (exit ${code}, signal ${signal}): ${result?.message ?? stderr}`));
      else resolve(result);
    });
  });
}

describe("message-board SQLite persistence across fresh OS processes", () => {
  it.each(["local", "memory"] as const)("enforces %s persistence only after the previous database handle and process have closed", async (backend) => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-board-sqlite-process-"));
    try {
      const input = { backend, rootSessionId: createSessionId(), dbPath: join(directory, "session.sqlite"), directory };
      const writer = await runProcess({ ...input, mode: "write" });
      const reader = await runProcess({ ...input, mode: "read", postId: writer.postId });
      expect(writer.pid).not.toBe(reader.pid);
      expect(writer.rootSessionId).toBe(input.rootSessionId);
      expect(reader.rootSessionId).toBe(input.rootSessionId);
      expect(reader.postId).toBe(writer.postId);
      expect(writer.modelCalls).toBe(0);
      expect(reader.modelCalls).toBe(0);
      expect(writer.entryCount).toBe(backend === "local" ? 1 : 0);
      expect(reader.entryCount).toBe(backend === "local" ? 1 : 0);
      expect(writer.storedPosts).toBe(backend === "local" ? 2 : 0);
      expect(reader.storedPosts).toBe(backend === "local" ? 3 : 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 65_000);
});
