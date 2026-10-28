import { describe, expect, it, vi } from "vitest";
import {
  resolveDetachedSessionModelContextWindow,
  resolveSessionModelContextWindow,
} from "../src/zcode-protocol/workspace-model-runtime.js";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";

describe("恢复容量身份边界", () => {
  const childSelection = { providerId: "child", modelId: "child-model" };
  const parentRecord = {
    app: {
      runtime: {
        getSessionModelSelection: () => ({ providerId: "parent", modelId: "parent-model" }),
      },
      getModelOption: (selection: typeof childSelection) => ({
        contextWindow: selection.providerId === "child" ? 960_000 : 200_000,
      }),
    },
  } as unknown as ZCodeProtocolSessionRecord;
  const modelEvent = (sessionId: string, contextWindow: number | null) =>
    ({
      sessionId,
      type: SessionEventType.ModelSelected,
      payload: { modelSelection: childSelection, contextWindow },
    }) as SessionEvent;

  it("detached child 只采纳自己的容量事件，显式未知不能复活旧分母", () => {
    const events = [modelEvent("child", 960_000), modelEvent("parent", 200_000)];
    expect(resolveDetachedSessionModelContextWindow(parentRecord, "child", events, undefined)).toBe(
      960_000,
    );
    events.push(modelEvent("child", null));
    expect(
      resolveDetachedSessionModelContextWindow(parentRecord, "child", events, childSelection),
    ).toBeUndefined();
  });

  it("detached child 无事件时按自己的持久选型查询目录，缺选型保持未知", () => {
    expect(
      resolveDetachedSessionModelContextWindow(parentRecord, "child", [], childSelection),
    ).toBe(960_000);
    expect(
      resolveDetachedSessionModelContextWindow(parentRecord, "child", [], undefined),
    ).toBeUndefined();
  });

  it("Runtime 当前选择优先，清除恢复候选后不能复活", () => {
    const old = { providerId: "old", modelId: "GLM-5.3" };
    const current = { providerId: "new", modelId: "GLM-5.3-Flash" };
    const getSessionModelSelection = vi.fn<() => typeof current | undefined>(() => current);
    const getModelOption = vi.fn(() => ({ contextWindow: 1_000_000 }));
    const record = {
      app: { runtime: { getSessionModelSelection }, getModelOption },
      restoredModelSelection: old,
    } as unknown as ZCodeProtocolSessionRecord;
    const context = {} as ZCodeProtocolAgentServerContext;
    expect(resolveSessionModelContextWindow(context, record)).toBe(1_000_000);
    expect(getModelOption).toHaveBeenLastCalledWith(current);
    getSessionModelSelection.mockReturnValue(undefined);
    expect(resolveSessionModelContextWindow(context, record)).toBe(1_000_000);
    expect(getModelOption).toHaveBeenLastCalledWith(old);
    delete record.restoredModelSelection;
    getModelOption.mockClear();
    expect(resolveSessionModelContextWindow(context, record)).toBeUndefined();
    expect(getModelOption).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, NaN, Infinity])("无效容量 %s 保持未知", (contextWindow) => {
    const record = {
      app: {
        runtime: { getSessionModelSelection: () => ({ providerId: "p", modelId: "m" }) },
        getModelOption: () => ({ contextWindow }),
      },
    } as unknown as ZCodeProtocolSessionRecord;
    expect(
      resolveSessionModelContextWindow({} as ZCodeProtocolAgentServerContext, record),
    ).toBeUndefined();
  });
});
