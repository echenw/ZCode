import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, UsersRoundIcon, XIcon } from "lucide-react";
import { SubagentDirectorySidePane } from "./SubagentDirectorySidePane.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { ChatPromptEditorShell, ChatPromptSubmitButton } from "@/prompt-editor/ChatPromptEditor.js";
import { shouldSubmitLexicalEnter } from "@/LexicalChatInput.js";
import { ChatContextUsage } from "@/chat-input-toolbar/contextUsage.js";
import {
  resolveChatEnterShortcut,
  resolveChatEnterSubmits,
  resolveMobileInputTextSizeClassName,
  shouldAvoidIosInputFocusZoom,
  useIsMobileTextInputViewport,
} from "@/lib/mobileTextInput.js";
import { cn } from "@/components/lib/utils.js";
import { subagentNameTextColor } from "@/lib/subagentColors.js";
import { SubagentAvatar } from "@/components/workflow-timeline/WorkflowAgentFace.js";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type {
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  SubagentSessionSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";

export const SubagentSessionSidePane = memo(function SubagentSessionSidePane({
  tab,
  focused,
  compactForRemoteControl = false,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenBackgroundBash,
}: {
  tab: SubagentSessionSidePaneTab;
  focused: boolean;
  compactForRemoteControl?: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <SubagentSessionBody
        tab={tab}
        focused={focused}
        compactForRemoteControl={compactForRemoteControl}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
        onOpenBackgroundBash={onOpenBackgroundBash}
        onOpenSubagentSession={onOpenSubagentSession}
      />
    </V4PaneConversationProvider>
  );
});

function SubagentSessionBody({
  tab,
  focused,
  compactForRemoteControl = false,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBackgroundBash,
  onOpenSubagentSession,
}: Parameters<typeof SubagentSessionSidePane>[0]) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const [nestedTabs, setNestedTabs] = useState<SubagentSessionSidePaneTab[]>([]);
  const [activeNested, setActiveNested] = useState<string | null>(null);
  const childrenButtonRef = useRef<HTMLButtonElement | null>(null);
  const hadNestedView = useRef(false);
  useEffect(() => {
    if (hadNestedView.current && !activeNested && focused) childrenButtonRef.current?.focus();
    hadNestedView.current = Boolean(activeNested);
  }, [activeNested, focused]);
  useEffect(() => {
    const next = layer.acquire(tab.childSessionId);
    setLease(next);
    return () => next.release();
  }, [layer, tab.childSessionId]);
  const state = useConversationProjection(lease);
  const displayTitle = tab.title;
  const running = state.snapshot?.subagents?.running.length ?? 0;
  const total = state.snapshot?.subagents?.childSessionIds?.length ?? running;
  const childrenLabel = intl.formatMessage(
    { id: "subagentControl.children" },
    { count: running, total },
  );
  useEffect(() => {
    if (!state.snapshot?.subagents?.revision) return;
    const valid = new Set(state.snapshot.subagents.childSessionIds);
    setNestedTabs((current) =>
      current.every((item) => valid.has(item.childSessionId))
        ? current
        : current.filter((item) => valid.has(item.childSessionId)),
    );
    setActiveNested((current) =>
      current &&
      current !== "directory" &&
      !nestedTabs.some((item) => item.id === current && valid.has(item.childSessionId))
        ? null
        : current,
    );
  }, [state.snapshot?.subagents?.revision, state.snapshot?.subagents?.childSessionIds, nestedTabs]);
  const openChildren = () => setActiveNested("directory");
  const openNested = (request: OpenScopedSubagentSideTabRequest) => {
    if (
      request.childSessionId === tab.childSessionId ||
      request.childSessionId === tab.rootSessionId ||
      (request.rootSessionId && request.rootSessionId !== tab.rootSessionId)
    )
      return;
    const id = `${tab.id}:nested:${request.childSessionId}`;
    setNestedTabs((current) =>
      current.some((item) => item.id === id)
        ? current.map((item) => (item.id === id ? { ...item, title: request.title } : item))
        : [
            ...current,
            { ...tab, ...request, id, type: "subagent-session", rootSessionId: tab.rootSessionId },
          ],
    );
    setActiveNested(id);
  };
  return (
    <div className="@container/agent h-full min-h-0" data-testid="subagent-session-nested-frame">
      <div
        className={cn(
          "grid h-full min-h-0 grid-cols-1",
          activeNested && "@min-[48rem]/agent:grid-cols-2",
        )}
      >
        <div
          className={cn(
            "flex h-full min-h-0 min-w-0 flex-col",
            activeNested && "hidden @min-[48rem]/agent:flex",
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span
              className={cn("inline-flex min-w-0 items-center gap-1.5 text-ui-base font-medium", subagentNameTextColor(displayTitle))}
              title={displayTitle}
            >
              <SubagentAvatar name={displayTitle} />
              <span className="truncate">{displayTitle}</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={openChildren}
              aria-label={childrenLabel}
              data-testid="subagent-header-children"
              ref={childrenButtonRef}
            >
              <UsersRoundIcon className="size-4" />
              {running}/{total}
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <SessionPane
              paneId={tab.id}
              sessionId={tab.childSessionId}
              openTrigger="subagent"
              rootSessionId={tab.rootSessionId}
              readOnly
              allowWorkspaceFileRewind
              compactForRemoteControl={compactForRemoteControl}
              focused={focused && !activeNested}
              telemetryVisible={focused && !activeNested}
              workspacePath={tab.workspacePath}
              workspaceIdentity={tab.workspaceIdentity}
              remoteSessionId={tab.remoteSessionId}
              onOpenBrowserUrl={onOpenBrowserUrl}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenSubagentSession={openNested}
              onOpenBackgroundBash={onOpenBackgroundBash}
            />
          </div>
          <SubagentSessionControls
            key={tab.childSessionId}
            tab={tab}
            isWebRemoteControl={compactForRemoteControl}
            onOpenChildren={openChildren}
          />
        </div>
        {activeNested || nestedTabs.length > 0 ? (
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-col border-l border-border",
              !activeNested && "hidden",
            )}
            data-testid="subagent-nested-region"
          >
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="subagent-nested-back"
                onClick={() => setActiveNested(null)}
              >
                <ArrowLeftIcon className="size-4" />
                {intl.formatMessage({ id: "subagentControl.back" }, { name: displayTitle })}
              </Button>
              <div
                role="group"
                aria-label={childrenLabel}
                className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
              >
                {nestedTabs.map((item) => (
                  <button
                    type="button"
                    aria-pressed={activeNested === item.id}
                    key={item.id}
                    className={cn(
                      "inline-flex max-w-40 items-center gap-1 rounded-lg px-2 py-1 text-ui-caption hover:bg-surface-hover",
                      subagentNameTextColor(item.title),
                    )}
                    onClick={() => setActiveNested(item.id)}
                  >
                    <SubagentAvatar name={item.title} className="size-3.5" />
                    <span className="truncate">{item.title}</span>
                  </button>
                ))}
              </div>
              {activeNested !== "directory" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({ id: "common.close" })}
                  onClick={() => {
                    setNestedTabs((current) => current.filter((item) => item.id !== activeNested));
                    setActiveNested(null);
                  }}
                >
                  <XIcon className="size-4" />
                </Button>
              ) : null}
            </div>
            <div className={cn("min-h-0 flex-1", activeNested !== "directory" && "hidden")}>
              <SubagentDirectorySidePane
                tab={{
                  ...tab,
                  id: `${tab.id}:directory`,
                  type: "subagent-directory",
                  parentSessionId: tab.childSessionId,
                }}
                onOpenSubagentSession={openNested}
              />
            </div>
            {nestedTabs.map((item) => (
              <div
                key={item.id}
                className={cn("min-h-0 flex-1", activeNested !== item.id && "hidden")}
              >
                <SubagentSessionSidePane
                  tab={item}
                  focused={focused && activeNested === item.id}
                  compactForRemoteControl={compactForRemoteControl}
                  onOpenBrowserUrl={onOpenBrowserUrl}
                  onOpenCodeViewer={onOpenCodeViewer}
                  onOpenFileLink={onOpenFileLink}
                  onOpenBackgroundBash={onOpenBackgroundBash}
                  onOpenSubagentSession={onOpenSubagentSession}
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SubagentSessionControls({
  tab,
  isWebRemoteControl = false,
  onOpenChildren,
}: {
  tab: SubagentSessionSidePaneTab;
  isWebRemoteControl?: boolean;
  onOpenChildren?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const { layer, sendCommand } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const [childLease, setChildLease] = useState<SessionLease | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  // 子详情旧版硬编码 Enter 发送，手机远控换行会误提交；沿用 Main 的平台/视口裁决。
  const enterSubmits = resolveChatEnterSubmits({
    isMobileTextInputViewport,
    preferEnterNewline: isWebRemoteControl,
  });
  const inputTextSizeClassName = resolveMobileInputTextSizeClassName({
    avoidIosInputFocusZoom: shouldAvoidIosInputFocusZoom({
      isMobileTextInputViewport,
      isWebRemoteControl,
    }),
  });
  const uncertainCommand = useRef<{
    action: "send" | "stop";
    text: string;
    envelope: CommandEnvelope;
  } | null>(null);
  useEffect(() => {
    const next = layer.acquire(tab.rootSessionId);
    setLease(next);
    return () => next.release();
  }, [layer, tab.rootSessionId]);
  useEffect(() => {
    // 用量只读目标子会话的共享投影；控制命令仍由原 Root 准入。
    const next = layer.acquire(tab.childSessionId);
    setChildLease(next);
    return () => next.release();
  }, [layer, tab.childSessionId]);
  const state = useConversationProjection(lease);
  const childState = useConversationProjection(childLease);
  const runningChildren = childState.snapshot?.subagents?.running.length ?? 0;
  const totalChildren = childState.snapshot?.subagents?.childSessionIds?.length ?? runningChildren;
  const contextWindow = childState.snapshot?.usage.contextWindow;
  const taskUsage = contextWindow
    ? {
        used: contextWindow.usedTokens,
        size: contextWindow.maxTokens,
        ...(contextWindow.cache ? { cache: contextWindow.cache } : {}),
        ...(contextWindow.breakdown ? { breakdown: contextWindow.breakdown } : {}),
      }
    : null;
  const ready = state.status === "live" && Boolean(state.snapshot);
  const running =
    state.snapshot?.subagents?.running.some(
      (agent) => agent.childSessionId === tab.childSessionId,
    ) === true;
  const message = (id: string) => intl.formatMessage({ id: `subagentControl.${id}` });
  // 与 Main 的状态机一致：运行中空草稿显示暂停，有草稿时同一位置切为发送。
  const hasDraftToSubmit = text.trim().length > 0;
  const showStopControl = running && !hasDraftToSubmit;
  const submit = async (action: "send" | "stop") => {
    if (inFlight.current || !ready || (action === "send" && !text.trim())) return;
    const submitted = text;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      // 详情仍只读。控制发给原 Root，由同根 task Owner 准入，不能 sendText 到 child 激活第二个 runtime。
      const previous = uncertainCommand.current;
      const envelope =
        previous?.action === action && previous.text === submitted
          ? previous.envelope
          : createCommandEnvelope({
              type: "controlSubagent",
              sessionId: tab.rootSessionId,
              payload:
                action === "stop"
                  ? { action, childSessionId: tab.childSessionId }
                  : { action, childSessionId: tab.childSessionId, text: submitted },
            });
      // 传输断开不代表命令未生效；同一草稿重试复用 commandId，由原 Host ledger 去重。
      uncertainCommand.current = { action, text: submitted, envelope };
      const ack = await sendCommand(envelope);
      uncertainCommand.current = null;
      if (ack.status !== "accepted") throw new Error(ack.message || message("error"));
      if (action === "send") setText((current) => (current === submitted ? "" : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : message("error"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <form
      data-testid="subagent-user-controls"
      data-child-session-id={tab.childSessionId}
      className="shrink-0 p-3"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void submit("send");
      }}
    >
      {onOpenChildren ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mb-2"
          onClick={onOpenChildren}
          data-testid="subagent-composer-children"
        >
          <UsersRoundIcon className="size-4" />
          {intl.formatMessage(
            { id: "subagentControl.children" },
            { count: runningChildren, total: totalChildren },
          )}
        </Button>
      ) : null}
      <ChatPromptEditorShell>
        <Textarea
          data-testid="subagent-user-input"
          aria-label={message("inputLabel")}
          placeholder={message("placeholder")}
          className={cn(
            "min-h-10 max-h-40 rounded-none border-0 bg-transparent p-0 shadow-none placeholder:text-foreground-subtlest focus-visible:ring-0",
            inputTextSizeClassName,
          )}
          rows={2}
          value={text}
          disabled={!ready}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              // 只复用 Main 的普通 Enter 规则，不把 Ctrl/Meta 误当成 child 的新提交模式。
              shouldSubmitLexicalEnter({
                enterSubmits,
                text,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                isComposing: event.nativeEvent.isComposing,
              })
            ) {
              event.preventDefault();
              void submit("send");
            }
          }}
        />
        <div className="flex items-center justify-end gap-1.5">
          <ChatContextUsage
            taskUsage={taskUsage}
            selectedProvider={ZCODE_AGENT_PROVIDER}
            intl={intl}
            locale={locale}
          />
          <ControlHintTooltip
            title={message(showStopControl ? "pause" : "send")}
            shortcut={showStopControl ? undefined : resolveChatEnterShortcut({ enterSubmits })}
          >
            <ChatPromptSubmitButton
              action={showStopControl ? "stop" : "send"}
              pending={busy}
              data-testid={showStopControl ? "subagent-user-stop" : "subagent-user-send"}
              label={message(showStopControl ? "pause" : "send")}
              disabled={!ready || busy || (!showStopControl && !hasDraftToSubmit)}
              onClick={
                showStopControl
                  ? () => {
                      void submit("stop");
                    }
                  : undefined
              }
            />
          </ControlHintTooltip>
        </div>
      </ChatPromptEditorShell>
      {error ? (
        <p role="alert" className="mt-2 text-ui-caption text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
