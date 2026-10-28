// @vitest-environment jsdom
import { createElement, type FormEvent } from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  SubagentSessionControls,
  SubagentSessionSidePane,
} from "@/app-shell/SubagentSessionSidePane.js";
import type { SubagentSessionSidePaneTab } from "@/lib/workspaceSidePane.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { SessionUsageState, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ChatPromptSubmitButton } from "@/prompt-editor/ChatPromptEditor.js";
import { SendMessageToolCallBlock } from "@/ToolCallBlocks/renderers/send-message.js";
import { ResolveWorkflowQuestionToolCallBlock } from "@/ToolCallBlocks/renderers/resolve-workflow-question.js";
import { WorkflowNotificationToolRow } from "@/v4/WorkflowNotificationToolRow.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { SidePaneTabDragOverlay } from "@/app-shell/SidePaneTabTrigger.js";

const fixture = vi.hoisted(() => {
  const usage = (usedTokens: number): Pick<SessionUsageState, "contextWindow"> => ({
    contextWindow: { usedTokens, maxTokens: 960000, autoCompactThresholdTokens: null },
  });
  return {
    send: vi.fn(),
    release: vi.fn(),
    projection: {
      status: "live",
      snapshot: { usage: usage(80000), subagents: { running: [{ childSessionId: "grandchild" }] } },
    },
    childProjection: {
      status: "live",
      snapshot: { usage: usage(17000), config: { provider: "zcode" } },
    },
  };
});
const layer = { acquire: vi.fn((sessionId: string) => ({ sessionId, release: fixture.release })) };
vi.mock("@/v4/SessionPane.js", () => ({ SessionPane: () => null }));
vi.mock("@/app-shell/SubagentDirectorySidePane.js", async () => {
  const React = await import("react");
  return {
    SubagentDirectorySidePane: ({
      tab: directoryTab,
      onOpenSubagentSession,
    }: {
      tab: { parentSessionId: string; rootSessionId: string; workspacePath: string };
      onOpenSubagentSession: (request: Record<string, string>) => void;
    }) =>
      React.createElement(
        "button",
        {
          "data-testid": "nested-directory-child",
          "data-parent-session-id": directoryTab.parentSessionId,
          onClick: () =>
            onOpenSubagentSession({
              ...directoryTab,
              childSessionId: `${directoryTab.parentSessionId}-child`,
              title: "Turing",
              subagentType: "general-purpose",
            }),
        },
        "Turing",
      ),
  };
});
vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: unknown }) => children,
  useV4Conversation: () => ({ layer, sendCommand: fixture.send }),
}));
vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: (lease: { sessionId: string } | null) =>
    !lease
      ? { status: "closed", snapshot: null }
      : lease.sessionId === "grandchild"
        ? fixture.childProjection
        : fixture.projection,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        id === "chat.contextUsage" ? `Context ${values?.used} / ${values?.total}` : id,
    },
  }),
}));
const tab: SubagentSessionSidePaneTab = {
  id: "child-pane",
  type: "subagent-session",
  workspaceKey: "workspace",
  workspacePath: "/workspace",
  rootSessionId: "root",
  parentSessionId: "actual-parent",
  childSessionId: "grandchild",
  subagentType: "general-purpose",
  title: "worker",
};
beforeEach(() => {
  fixture.send.mockReset().mockResolvedValue({ status: "accepted" });
  fixture.release.mockClear();
  layer.acquire.mockClear();
  fixture.projection.status = "live";
  fixture.projection.snapshot.subagents.running = [{ childSessionId: "grandchild" }];
  fixture.childProjection.snapshot.usage.contextWindow = {
    usedTokens: 17000,
    maxTokens: 960000,
    autoCompactThresholdTokens: null,
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderControls() {
  return render(createElement(SubagentSessionControls, { tab }), { wrapper: TooltipProvider });
}

it.each(["send", "stop"] as const)(
  "the shared %s button preserves its action role, accessible name and disabled state while pending",
  (action) => {
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    const onClick = vi.fn();
    const control = (pending: boolean) =>
      createElement(
        "form",
        { onSubmit },
        createElement(ChatPromptSubmitButton, {
          action,
          label: "Exact agent action",
          onClick,
          pending,
          disabled: pending,
        }),
      );
    const view = render(control(false));
    const button = view.getByRole("button", { name: "Exact agent action" }) as HTMLButtonElement;
    expect(button.type).toBe(action === "send" ? "submit" : "button");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledTimes(action === "send" ? 1 : 0);
    view.rerender(control(true));
    expect(button.disabled).toBe(true);
    expect(view.getByRole("status")).toBeTruthy();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  },
);

it("opens descendants inside their parent, preserves both drafts on back, and controls the original root", async () => {
  const openExternal = vi.fn();
  const view = render(
    createElement(SubagentSessionSidePane, {
      tab,
      focused: true,
      onOpenSubagentSession: openExternal,
    }),
    { wrapper: TooltipProvider },
  );
  const parentControls = view.getByTestId("subagent-user-controls");
  fireEvent.change(within(parentControls).getByTestId("subagent-user-input"), {
    target: { value: "parent draft" },
  });
  fireEvent.click(view.getByTestId("subagent-header-children"));
  expect(view.getByTestId("nested-directory-child").getAttribute("data-parent-session-id")).toBe(
    "grandchild",
  );
  fireEvent.click(view.getByTestId("nested-directory-child"));
  expect(openExternal).not.toHaveBeenCalled();
  const descendant = view.container.querySelector<HTMLElement>(
    '[data-testid="subagent-user-controls"][data-child-session-id="grandchild-child"]',
  );
  if (!descendant) throw new Error("Expected nested descendant controls");
  fireEvent.change(within(descendant).getByTestId("subagent-user-input"), {
    target: { value: "descendant draft" },
  });
  fireEvent.click(view.getByTestId("subagent-nested-back"));
  expect(
    (within(parentControls).getByTestId("subagent-user-input") as HTMLTextAreaElement).value,
  ).toBe("parent draft");
  fireEvent.click(view.getAllByTestId("subagent-header-children")[0]!);
  fireEvent.click(view.getAllByTestId("nested-directory-child")[0]!);
  expect((within(descendant).getByTestId("subagent-user-input") as HTMLTextAreaElement).value).toBe(
    "descendant draft",
  );
  fireEvent.click(within(descendant).getByTestId("subagent-user-send"));
  await waitFor(() => expect(fixture.send).toHaveBeenCalledOnce());
  expect(fixture.send.mock.calls[0]![0]).toMatchObject({
    sessionId: "root",
    payload: { childSessionId: "grandchild-child", text: "descendant draft" },
  });
});

function receivedRow(
  messageType: "MESSAGE" | "FINAL_ANSWER",
  sessionId: string,
  entityId: string,
  body: string,
  senderName = "Ada",
) {
  return createElement(ConversationRowView, {
    context: {
      sessionId,
      workspacePath: "/workspace",
      theme: "system",
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    },
    row: {
      kind: "userInput",
      rowId: 1,
      entityId,
      turnId: "turn",
      createdAt: 1,
      createdAtSeq: 1,
      text: "raw carrier",
      origin: "mailbox",
      agentMessage: {
        messageType,
        senderPath: "/root/a",
        targetPath: "/root",
        senderName,
        targetName: "Main",
        body,
      },
    },
  });
}

it("keeps each agent name's color across messages, restored panes and task-title changes", () => {
  const colors = new Set<string>();
  for (const name of ["Ada", "Turing", "Curie"]) {
    const message = render(
      receivedRow("MESSAGE", "name-colors", `mail-${name}`, "Question", name),
      {
        wrapper: TooltipProvider,
      },
    );
    const nameNode = message.getByText(name);
    const nameClass = nameNode.className
      .split(" ")
      .filter((token) => /^(dark:)?text-/.test(token))
      .join(" ");
    expect(nameClass).toMatch(/text-\w+-700 dark:text-\w+-300/);
    const avatar = nameNode.querySelector<SVGSVGElement>("[data-subagent-avatar]");
    expect(avatar).not.toBeNull();
    expect(avatar?.dataset.expression).toBe("pill");
    expect(avatar?.style.getPropertyValue("--wf-face-body")).toBe("currentColor");
    for (const token of nameClass.split(" ")) expect(avatar?.classList.contains(token)).toBe(true);
    colors.add(nameClass);
    message.unmount();

    // 实际用户入口显示「昵称 · 任务」；更换任务、恢复面板都不应把任务描述算进身份色。
    const pane = render(
      createElement(SubagentSessionSidePane, {
        tab: { ...tab, title: `${name} · First assignment` },
        focused: true,
        onOpenSubagentSession: vi.fn(),
      }),
      { wrapper: TooltipProvider },
    );
    const heading = pane.getByTitle(`${name} · First assignment`);
    for (const token of nameClass.split(" ")) expect(heading.classList.contains(token)).toBe(true);
    expect(heading.querySelector("[data-subagent-avatar]")).not.toBeNull();
    expect(heading.querySelector("[data-subagent-avatar]")?.getAttribute("data-expression")).toBe(
      "pill",
    );
    pane.unmount();

    const restored = render(
      createElement(SidePaneTabDragOverlay, {
        tab: { ...tab, title: `${name} · Second assignment` },
        title: `${name} · Second assignment`,
        diffBadgeLabel: "Diff",
      }),
    );
    const tabName = restored.getByText(`${name} · Second assignment`);
    for (const token of nameClass.split(" ")) expect(tabName.classList.contains(token)).toBe(true);
    const tabAvatar = restored.container.querySelector("[data-subagent-avatar]");
    for (const token of nameClass.split(" "))
      expect(tabAvatar?.classList.contains(token)).toBe(true);
    restored.unmount();
  }
  expect(colors.size).toBe(3);

  const outgoing = render(createElement(SendMessageToolCallBlock, sendMessageContext()), {
    wrapper: TooltipProvider,
  });
  expect(outgoing.getByText("Turing").className).toContain("text-rose-700 dark:text-rose-300");
  expect(outgoing.getByText("Turing").querySelector("[data-subagent-avatar]")).not.toBeNull();
});

function sendMessageContext(
  overrides: Partial<ToolCallBlockRenderContext> = {},
): ToolCallBlockRenderContext {
  return {
    toolCallNode: {
      toolCall: {
        toolId: "actual-send-message-interaction",
        toolName: "SendMessage",
        kind: "SendMessage",
        title: "SendMessage",
        input: {
          to: "Turing",
          summary: "Send summary",
          message: "Complete original message\nSecond line",
        },
        status: "completed",
        raw: {},
      },
      childToolCalls: [],
    },
    workspacePath: "/workspace",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: true,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "completed",
    childToolList: null,
    ...overrides,
  };
}

it.each(["MESSAGE", "FINAL_ANSWER"] as const)(
  "renders %s through the original notification prose and collapse interaction without a user bubble",
  async (messageType) => {
    const body = `${"Long agent question or result ".repeat(40)}\nComplete second line`;
    const view = render(
      receivedRow(messageType, "root-message-view", `mail-${messageType}`, body),
      { wrapper: TooltipProvider },
    );
    const notification = view.container.querySelector('[data-notification-source="agent"]');
    expect(notification?.getAttribute("data-testid")).toMatch(/^chat-workflow-notification-row-/);
    expect(view.queryByTestId("agent-received-message")).toBeNull();
    expect(view.queryByText("raw carrier")).toBeNull();
    for (const key of [
      "agentCommunication.received",
      "agentCommunication.completed",
      "agentCommunication.from",
    ]) {
      expect(view.queryByText(key)).toBeNull();
    }
    expect(
      view.getByText(
        messageType === "MESSAGE" ? "chat.toolCall.kind.message" : "chat.toolCall.kind.taskOutput",
      ),
    ).toBeTruthy();
    expect(view.container.querySelector('[data-v4-user-input-bubble="true"]')).toBeNull();
    expect(view.container.querySelector(".lucide-send")).toBeNull();
    expect(view.container.querySelector(".lucide-inbox")).toBeNull();
    expect(
      view.container.querySelector(
        messageType === "MESSAGE" ? ".lucide-message-circle-reply" : ".lucide-workflow",
      ),
    ).not.toBeNull();
    expect(view.queryByText("chat.backgroundResult.workflow.answered")).toBeNull();
    expect(view.queryByText("chat.backgroundResult.workflow.waiting")).toBeNull();
    // 原问答通知只保留单行概要；折叠时不把完整正文塞进 DOM。
    expect(view.container.textContent).not.toContain(body);
    expect(view.queryByTestId("notification-message-body")).toBeNull();
    fireEvent.click(view.getByRole("button", { expanded: false }));
    const detail = view.getByTestId("notification-message-body");
    expect(detail.tagName).toBe("P");
    expect(detail.closest("dl")).toBeNull();
    expect(detail.textContent).toBe(body);
    expect(view.getByTestId("notification-context").textContent).toContain("Ada · /root/a");
    expect(view.getByTestId("notification-context").textContent).toContain("Main · /root");
    fireEvent.click(view.getByRole("button", { expanded: true }));
    expect(view.getByRole("button", { expanded: false })).toBeTruthy();
    const sender = view.getByTestId("tool-summary-source");
    expect(sender.classList.contains("shrink-0")).toBe(true);
    expect(sender.classList.contains("whitespace-nowrap")).toBe(true);
    await waitFor(() => expect(view.queryByTestId("notification-message-body")).toBeNull());
  },
);

it("keeps received-message expansion within its session while preserving it on remount", () => {
  const content = (sessionId: string) =>
    receivedRow("MESSAGE", sessionId, "same-entity", "Scoped message body");
  const first = render(content("message-scope-a"), { wrapper: TooltipProvider });
  fireEvent.click(first.getByRole("button", { expanded: false }));
  expect(first.getByTestId("notification-message-body")).toBeTruthy();
  first.unmount();
  const second = render(content("message-scope-b"), { wrapper: TooltipProvider });
  expect(second.getByRole("button", { expanded: false })).toBeTruthy();
  expect(second.queryByTestId("notification-message-body")).toBeNull();
  second.unmount();
  const restored = render(content("message-scope-a"), { wrapper: TooltipProvider });
  expect(restored.getByRole("button", { expanded: true })).toBeTruthy();
  expect(restored.getByTestId("notification-message-body").textContent).toBe("Scoped message body");
});

it("shows an older unnamed recipient path once and keeps the original Main sender fallback", () => {
  const row: UserInputRow = {
    kind: "userInput",
    rowId: 19,
    entityId: "older-message",
    turnId: "turn",
    createdAt: 1,
    createdAtSeq: 1,
    text: "raw carrier",
    origin: "mailbox",
    agentMessage: {
      messageType: "MESSAGE",
      senderPath: "/root",
      targetPath: "/root/unnamed",
      body: "Old message",
    },
  };
  const view = render(
    createElement(ConversationRowView, {
      row,
      context: {
        sessionId: "older-message-session",
        workspacePath: "/workspace",
        theme: "system",
        codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      },
    }),
    { wrapper: TooltipProvider },
  );
  fireEvent.click(view.getByRole("button", { expanded: false }));
  const participants = view.getByTestId("notification-context").textContent ?? "";
  expect(participants).toContain("Main · /root");
  expect(participants.match(/\/root\/unnamed/g)).toHaveLength(1);
});

it("keeps real user text in its original bubble even when it looks like a message carrier", () => {
  const row: UserInputRow = {
    kind: "userInput",
    rowId: 18,
    entityId: "real-user",
    turnId: "turn",
    createdAt: 1,
    createdAtSeq: 1,
    text: "MESSAGE from Ada: a real user is quoting this",
    origin: "realUser",
  };
  const view = render(
    createElement(ConversationRowView, {
      row,
      context: {
        sessionId: "real-user-session",
        workspacePath: "/workspace",
        theme: "system",
        codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      },
    }),
    { wrapper: TooltipProvider },
  );
  expect(view.container.querySelector('[data-v4-user-input-bubble="true"]')?.textContent).toContain(
    row.text,
  );
  expect(view.container.querySelector('[data-notification-source="agent"]')).toBeNull();
});

it("keeps original SendMessage detail fields and loading independent of received notifications", async () => {
  const original = render(createElement(SendMessageToolCallBlock, sendMessageContext()), {
    wrapper: TooltipProvider,
  });
  fireEvent.click(original.getByRole("button", { expanded: false }));
  const body = original.getByTestId("agent-message-body");
  expect(body.textContent).toBe("Complete original message\nSecond line");
  expect(
    Array.from(original.container.querySelectorAll("dt")).map((field) => field.textContent),
  ).toEqual([
    "chat.toolCall.sendMessage.target",
    "chat.toolCall.sendMessage.summary",
    "chat.toolCall.sendMessage.message",
  ]);
  fireEvent.click(original.getByRole("button", { expanded: true }));
  await waitFor(() => expect(original.queryByTestId("agent-message-body")).toBeNull());
});

it("shares actual original workflow question and answer prose with received notifications", () => {
  const text = `${"Original notification body ".repeat(20)}\nComplete second line`;
  const original = render(
    createElement(WorkflowNotificationToolRow, {
      notification: {
        kind: "escalation",
        qid: "real-question-id",
        actor: "planner",
        question: text,
        askedAt: 1,
      },
      runName: "Original workflow",
      testIdKey: "shared-original-workflow-prose",
      theme: "system",
      forceOpen: true,
    }),
    { wrapper: TooltipProvider },
  );
  const originalBody = original.getByText(text, { normalizer: (value) => value });
  const originalStyle = originalBody.className;
  expect(originalBody.tagName).toBe("P");
  original.unmount();
  const answerContext = sendMessageContext({ forceOpen: true });
  answerContext.toolCallNode.toolCall.input = { question_id: "real-question-id", answer: text };
  const answer = render(createElement(ResolveWorkflowQuestionToolCallBlock, answerContext), {
    wrapper: TooltipProvider,
  });
  expect(answer.getByText(text, { normalizer: (value) => value }).className).toBe(originalStyle);
  answer.unmount();
  const received = render(
    receivedRow("MESSAGE", "shared-notification-style", "shared-prose-style", text),
    { wrapper: TooltipProvider },
  );
  fireEvent.click(received.getByRole("button", { expanded: false }));
  expect(received.getByTestId("notification-message-body").className).toBe(originalStyle);
  expect(received.getByTestId("notification-message-body").textContent).toBe(text);
});

it("preserves original force-open, hidden-icon and full-field loading behavior in the tool adapter", async () => {
  const load = vi.fn().mockResolvedValue(true);
  const context = sendMessageContext({
    showIcon: false,
    canToggle: false,
    forceOpen: true,
    onLoadFullToolCallFields: load,
  });
  context.toolCallNode.toolCall.snapshotRefs = [
    { field: "input", refId: "input-ref", hash: "hash", previewBytes: 32, fullBytes: 4096 },
  ];
  const view = render(createElement(SendMessageToolCallBlock, context), {
    wrapper: TooltipProvider,
  });
  expect(view.getByTestId("agent-message-body").textContent).toBe(
    "Complete original message\nSecond line",
  );
  expect(view.queryByRole("button", { expanded: true })).toBeNull();
  expect(view.container.querySelector(".lucide-send")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "chat.toolCall.snapshot.loadFull" }));
  await waitFor(() => expect(load).toHaveBeenCalledWith("actual-send-message-interaction"));
});

it("mobile remote Enter keeps the draft and button send submits it through the same root", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const view = render(
    createElement(SubagentSessionSidePane, {
      tab,
      focused: true,
      compactForRemoteControl: true,
      onOpenSubagentSession: vi.fn(),
    }),
    { wrapper: TooltipProvider },
  );
  const input = view.getByTestId("subagent-user-input") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "unfinished mobile prompt" } });
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  fireEvent(input, enter);
  expect(enter.defaultPrevented).toBe(false);
  expect(fixture.send).not.toHaveBeenCalled();
  expect(input.value).toBe("unfinished mobile prompt");
  expect(input.className).toContain("text-mobile-input-safe");
  fireEvent.change(input, { target: { value: "first line\nsecond line" } });
  fireEvent.click(view.getByTestId("subagent-user-send"));
  await waitFor(() => expect(input.value).toBe(""));
  expect(fixture.send).toHaveBeenCalledOnce();
  expect(fixture.send.mock.calls[0]![0]).toMatchObject({
    sessionId: "root",
    payload: { text: "first line\nsecond line", childSessionId: "grandchild" },
  });
});

it("pauses the exact child through its root owner and releases the shared projection lease", async () => {
  const view = renderControls();
  fireEvent.click(view.getByTestId("subagent-user-stop"));
  await waitFor(() => expect(fixture.send).toHaveBeenCalledOnce());
  expect(fixture.send.mock.calls[0]![0]).toMatchObject({
    type: "controlSubagent",
    sessionId: "root",
    payload: { action: "stop", childSessionId: "grandchild" },
  });
  expect(layer.acquire).toHaveBeenCalledWith("root");
  expect(layer.acquire).toHaveBeenCalledWith("grandchild");
  view.unmount();
  expect(fixture.release).toHaveBeenCalledTimes(2);
});

it("submits Enter to the original child, then clears only the accepted draft", async () => {
  const view = renderControls();
  const input = view.getByTestId("subagent-user-input") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "continue the same agent" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(input.value).toBe(""));
  expect(fixture.send).toHaveBeenCalledOnce();
  expect(fixture.send.mock.calls[0]![0]).toMatchObject({
    type: "controlSubagent",
    sessionId: "root",
    payload: { action: "send", childSessionId: "grandchild", text: "continue the same agent" },
  });
});

it.each(["ctrlKey", "metaKey"])(
  "keeps %s+Enter as a draft without inventing a child delivery mode",
  (modifier) => {
    const view = renderControls();
    const input = view.getByTestId("subagent-user-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "do not submit a modified Enter" } });
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      [modifier]: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(input, enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(input.value).toBe("do not submit a modified Enter");
  },
);

it("preserves a rejected draft and exposes the error for retry", async () => {
  fixture.send.mockResolvedValue({ status: "rejected", message: "Owner is unavailable" });
  const view = renderControls();
  const input = view.getByTestId("subagent-user-input") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "kept draft" } });
  fireEvent.click(view.getByTestId("subagent-user-send"));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain("Owner is unavailable"),
  );
  expect(input.value).toBe("kept draft");
});

it("reuses the original command id after a transport failure with an unknown outcome", async () => {
  fixture.send
    .mockRejectedValueOnce(new Error("connection lost"))
    .mockResolvedValue({ status: "accepted" });
  const view = renderControls();
  fireEvent.change(view.getByTestId("subagent-user-input"), { target: { value: "same task" } });
  fireEvent.click(view.getByTestId("subagent-user-send"));
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain("connection lost"));
  fireEvent.click(view.getByTestId("subagent-user-send"));
  await waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(2));
  expect(fixture.send.mock.calls[1]![0].commandId).toBe(fixture.send.mock.calls[0]![0].commandId);
});

it("does not submit IME or multiline Enter and blocks duplicate input while one command is pending", async () => {
  const response = Promise.withResolvers<{ status: string }>();
  fixture.send.mockReturnValue(response.promise);
  const view = renderControls();
  const input = view.getByTestId("subagent-user-input");
  fireEvent.change(input, { target: { value: "one request" } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(fixture.send).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(fixture.send).toHaveBeenCalledOnce();
  expect(
    (view.getByRole("button", { name: "subagentControl.send" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => response.resolve({ status: "accepted" }));
});

it("allows continuing an idle child but disables pause and all offline actions", () => {
  fixture.projection.snapshot.subagents.running = [];
  const view = renderControls();
  fireEvent.change(view.getByTestId("subagent-user-input"), { target: { value: "resume" } });
  expect(view.queryByTestId("subagent-user-stop")).toBeNull();
  expect((view.getByTestId("subagent-user-send") as HTMLButtonElement).disabled).toBe(false);
  fixture.projection.status = "error";
  view.rerender(createElement(SubagentSessionControls, { tab }));
  expect((view.getByTestId("subagent-user-input") as HTMLTextAreaElement).disabled).toBe(true);
  expect((view.getByTestId("subagent-user-send") as HTMLButtonElement).disabled).toBe(true);
});

it("uses one action slot for empty-running pause, draft send, and empty-idle disabled send", () => {
  const view = renderControls();
  const input = view.getByTestId("subagent-user-input");
  expect(view.queryByTestId("subagent-user-send")).toBeNull();
  expect((view.getByTestId("subagent-user-stop") as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(input, { target: { value: "guide this agent" } });
  expect(view.queryByTestId("subagent-user-stop")).toBeNull();
  expect((view.getByTestId("subagent-user-send") as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(input, { target: { value: "  " } });
  expect(view.queryByTestId("subagent-user-send")).toBeNull();
  expect(view.getByTestId("subagent-user-stop")).toBeTruthy();
  fixture.projection.snapshot.subagents.running = [];
  view.rerender(createElement(SubagentSessionControls, { tab }));
  expect(view.queryByTestId("subagent-user-stop")).toBeNull();
  expect((view.getByTestId("subagent-user-send") as HTMLButtonElement).disabled).toBe(true);
});

it("displays the child context projection and live updates without model or permission pickers", () => {
  const view = renderControls();
  expect(view.getByRole("button", { name: "Context 17,000 / 960,000" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Context 80,000 / 960,000" })).toBeNull();
  fixture.childProjection.snapshot.usage.contextWindow!.usedTokens = 19000;
  view.rerender(createElement(SubagentSessionControls, { tab }));
  expect(view.getByRole("button", { name: "Context 19,000 / 960,000" })).toBeTruthy();
  expect(view.queryByRole("combobox")).toBeNull();
  expect(view.container.querySelector('[aria-haspopup="menu"]')).toBeNull();
});

it("does not substitute parent context when the child has no context usage yet", () => {
  fixture.childProjection.snapshot.usage.contextWindow = null;
  const view = renderControls();
  expect(view.queryByRole("button", { name: /^Context / })).toBeNull();
});
