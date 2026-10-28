import { memo, useEffect, useMemo, useState } from "react";
import type { ZCodeSessionEndedSubagent } from "@zcode/shared";
import type { RunningSubagentSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  BanIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { subagentNameTextColor } from "@/lib/subagentColors.js";
import { SubagentAvatar } from "@/components/workflow-timeline/WorkflowAgentFace.js";
import { useSessionSubagents } from "@/hooks/useSessionSubagents.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedSubagentSideTabRequest,
  SubagentDirectorySidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import {
  V4PaneConversationProvider,
  useV4Conversation,
} from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";

type DirectoryItem = RunningSubagentSummary | ZCodeSessionEndedSubagent;

const EMPTY_RUNNING: readonly RunningSubagentSummary[] = [];

function orderByAgentPath<T extends DirectoryItem>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.agentPath && right.agentPath) return left.agentPath.localeCompare(right.agentPath);
    return left.agentPath ? -1 : right.agentPath ? 1 : 0;
  });
}

export function buildSubagentDirectoryOpenRequest(
  tab: SubagentDirectorySidePaneTab,
  item: DirectoryItem,
): OpenScopedSubagentSideTabRequest {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    // 根目录现在包含全部后代；孙代理的直接父级不能继续使用目录所属的 Root。
    rootSessionId: item.rootSessionId ?? tab.rootSessionId,
    parentSessionId: item.parentSessionId ?? tab.parentSessionId,
    childSessionId: item.childSessionId,
    subagentType: item.subagentType,
    title: item.title,
  };
}

function StatusIcon({ status }: { status: DirectoryItem["status"] }) {
  const className = "size-4 shrink-0";
  switch (status) {
    case "running":
      return <LoaderCircleIcon aria-hidden className={`${className} animate-spin`} />;
    case "waiting":
    case "blocked":
      return <PauseCircleIcon aria-hidden className={className} />;
    case "success":
      return <CheckCircle2Icon aria-hidden className={className} />;
    case "failed":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "cancelled":
      return <BanIcon aria-hidden className={className} />;
    case "lost":
      return <CircleDashedIcon aria-hidden className={className} />;
  }
}

const DirectoryRow = memo(function DirectoryRow({
  item,
  onOpen,
}: {
  item: DirectoryItem;
  onOpen: (item: DirectoryItem) => void;
}) {
  const { intl } = useZCodeIntl();
  const timestamp = "endedAt" in item ? item.endedAt : item.startedAt;
  const depth = item.agentPath ? Math.max(0, item.agentPath.split("/").length - 2) : undefined;
  return (
    <button
      type="button"
      data-child-session-id={item.childSessionId}
      data-agent-path={item.agentPath}
      data-agent-depth={depth}
      data-parent-agent-path={item.parentAgentPath}
      data-parent-session-id={item.parentSessionId}
      data-work-status={item.status}
      className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      style={depth === undefined ? undefined : { paddingInlineStart: 12 + Math.min(4, Math.max(0, depth - 1)) * 12 }}
      onClick={() => onOpen(item)}
    >
      <span className="mt-0.5 text-foreground-subtle">
        <StatusIcon status={item.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("inline-flex min-w-0 items-center gap-1.5 font-medium", subagentNameTextColor(item.title))}>
            <SubagentAvatar name={item.title} status={item.status} />
            <span className="truncate">{item.title}</span>
          </span>
          <span className="shrink-0 text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: `subagentDirectory.status.${item.status}` })}
          </span>
        </span>
        {item.agentPath && !/\/legacy_[a-f\d]+/.test(item.agentPath) ? (
          <span className="mt-0.5 block break-all font-mono text-ui-sm text-foreground-subtle">
            {item.agentPath}
          </span>
        ) : null}
        {item.modelId || item.reasoningEffort || item.totalTokens !== undefined ? (
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-ui-sm text-foreground-subtlest">
            {item.modelId ? (
              <span className="min-w-0 break-all font-mono">
                {item.providerId ? `${item.providerId}/` : ""}{item.modelId}
              </span>
            ) : null}
            {item.reasoningEffort ? <span>{item.reasoningEffort}</span> : null}
            {item.totalTokens !== undefined ? (
              <span className="font-mono tabular-nums">{item.totalTokens.toLocaleString()} tokens</span>
            ) : null}
          </span>
        ) : null}
        {item.summary ? (
          <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
            {item.summary}
          </span>
        ) : null}
      </span>
      {timestamp ? (
        <span className="shrink-0 text-ui-sm text-foreground-subtlest">
          {formatTaskRelativeTime(timestamp, intl)}
        </span>
      ) : null}
    </button>
  );
});

export const SubagentDirectorySidePane = memo(function SubagentDirectorySidePane({
  tab,
  onOpenSubagentSession,
}: {
  tab: SubagentDirectorySidePaneTab;
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
      <SubagentDirectoryContents
        tab={tab}
        onOpenSubagentSession={onOpenSubagentSession}
      />
    </V4PaneConversationProvider>
  );
});

const SubagentDirectoryContents = memo(function SubagentDirectoryContents({
  tab,
  onOpenSubagentSession,
}: {
  tab: SubagentDirectorySidePaneTab;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);
  const subagents = projection.snapshot?.subagents;
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const directory = useSessionSubagents({
    enabled: projection.snapshot !== null,
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    remoteSessionId: tab.remoteSessionId,
    sessionId: tab.parentSessionId,
    refreshKey: subagents?.revision ?? 0,
  });
  const running = subagents?.running ?? EMPTY_RUNNING;
  const orderedRunning = useMemo(() => orderByAgentPath(running), [running]);
  const orderedEnded = useMemo(() => orderByAgentPath(directory.ended.items), [directory.ended.items]);
  const endedTotal = subagents?.endedTotal ?? 0;
  const handleOpen = (item: DirectoryItem) => {
    onOpenSubagentSession(buildSubagentDirectoryOpenRequest(tab, item));
  };

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "subagentDirectory.title" })}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <section>
          <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "subagentDirectory.running" })} · {running.length}
          </h3>
          {running.length > 0 ? (
            orderedRunning.map((item) => (
              <DirectoryRow key={item.childSessionId} item={item} onOpen={handleOpen} />
            ))
          ) : (
            <p className="px-3 py-3 text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "subagentDirectory.runningEmpty" })}
            </p>
          )}
        </section>

        <section className="mt-5">
          <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "subagentDirectory.ended" })} · {endedTotal}
          </h3>
          {orderedEnded.map((item) => (
            <DirectoryRow key={item.childSessionId} item={item} onOpen={handleOpen} />
          ))}
          {directory.ended.nextCursor ? (
            <div className="px-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={directory.loading}
                onClick={() => void directory.loadMore()}
              >
                {intl.formatMessage({ id: "subagentDirectory.showMore" })}
              </Button>
            </div>
          ) : null}
        </section>

        {directory.error ? (
          <p role="alert" className="mx-3 mt-4 text-ui-sm text-[var(--color-danger)]">
            {intl.formatMessage({ id: "subagentDirectory.loadFailed" })}
          </p>
        ) : null}
      </div>
    </div>
  );
});
