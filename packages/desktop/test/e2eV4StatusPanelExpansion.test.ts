// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TID_CHAT_SUMMARY_PANEL,
  TID_V4_BACKGROUND_WORK_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import {
  openV4ComposerRunningBackgroundWorks,
  openV4RunningBackgroundWorks,
} from "#e2e/helpers/v4-conversation";

vi.mock("./e2e/helpers/desktop-app.js", () => ({
  DEFAULT_WORKSPACE: "/Users/dev/e2e/ZCodeProject",
  clickTestIdByDom: vi.fn(async () => {
    const panel = document.querySelector<HTMLElement>(`[data-testid="${TID_CHAT_SUMMARY_PANEL}"]`)!;
    panel.dataset.state = "expanded";
    panel.querySelector("[data-status-section-trigger]")?.setAttribute("aria-expanded", "true");
  }),
}));

beforeEach(() => {
  vi.stubGlobal("browser", {
    execute: async (callback: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      callback(...args),
    waitUntil: async (condition: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 4; attempt += 1) if (await condition()) return;
      throw new Error("status section did not open");
    },
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mountPanel(
  kind: "agent" | "terminal" | "workflow",
  hasControlId: boolean,
  includeRow = true,
) {
  const panel = document.createElement("aside");
  panel.dataset.testid = TID_CHAT_SUMMARY_PANEL;
  panel.dataset.state = "collapsed";
  panel.dataset.runningBackgroundCount = "1";
  panel.dataset.runningAgentCount = kind === "agent" ? "1" : "0";
  panel.dataset.runningTerminalCount = kind === "terminal" ? "1" : "0";
  const expand = document.createElement("button");
  expand.dataset.statusPanelExpandTrigger = "true";
  expand.onclick = () => {
    panel.dataset.state = "expanded";
    panel.dataset.displayMode = "panel";
  };
  panel.append(expand);
  const section = document.createElement("button");
  section.dataset.statusSectionTrigger = kind;
  section.setAttribute("aria-expanded", "false");
  section.onclick = () => section.setAttribute("aria-expanded", "true");
  panel.append(section);
  if (includeRow) {
    const row = document.createElement("li");
    row.dataset.backgroundTaskKind = kind;
    if (hasControlId) row.dataset.testid = testId(TID_V4_BACKGROUND_WORK_ITEM, "work-1");
    panel.append(row);
  }
  document.body.append(panel);
  return { panel, section };
}

describe.each([
  ["status panel", openV4RunningBackgroundWorks],
  ["composer", openV4ComposerRunningBackgroundWorks],
] as const)("V4 %s expansion", (_entry, open) => {
  it("opens a real V2 agent row without requiring a legacy cancellable work ID", async () => {
    const { panel, section } = mountPanel("agent", false);
    await open();
    expect(panel.dataset.state).toBe("expanded");
    expect(section.getAttribute("aria-expanded")).toBe("true");
  });

  it("does not accept a nonzero counter without an actual running row", async () => {
    mountPanel("agent", false, false);
    await expect(open()).rejects.toThrow("status section did not open");
  });

  it.each(["terminal", "workflow"] as const)(
    "keeps the existing controlled %s row path",
    async (kind) => {
      mountPanel(kind, true);
      await expect(open()).resolves.toBeUndefined();
    },
  );
});

it("expands an automatic narrow-layout capsule through its real expand control", async () => {
  const { panel, section } = mountPanel("agent", false);
  panel.dataset.state = "expanded";
  panel.dataset.displayMode = "auto";
  await openV4RunningBackgroundWorks();
  expect(panel.dataset.displayMode).toBe("panel");
  expect(section.getAttribute("aria-expanded")).toBe("true");
});
