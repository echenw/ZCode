import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
import { BotIcon } from "lucide-react";
import { useMemo } from "react";
import type { AgentColor } from "@zcode/shared";
import { SubagentAvatar } from "@/components/workflow-timeline/WorkflowAgentFace.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveSubagentColorFromName, SUBAGENT_TEXT_COLOR_CLASS } from "@/lib/subagentColors.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { getLatestExploreChildSummaryFromChildren } from "./explore.js";
import {
  formatAgentMessage,
  getAgentColor,
  getAgentKindLabel,
  getAgentPrimaryText,
} from "./agentHelpers.js";

const AGENT_TOOL_ICON = <BotIcon className="size-4 shrink-0 text-foreground-subtle" />;

function AgentNameText({ color, name }: { color: AgentColor; name: string }) {
  return (
    <span
      className={cn(
        // 子智能体名在 tool summary 行内不能依赖字体基线对齐。
        // inline-flex 负责垂直居中，1.5 倍行高保持和周围摘要文字一致的阅读节奏。
        "inline-flex max-w-36 items-center gap-1 truncate font-mono text-ui-base font-medium leading-[1.5]",
        SUBAGENT_TEXT_COLOR_CLASS[color],
      )}
      title={name}
    >
      <SubagentAvatar name={name} color={color} className="size-3.5" />
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

export function AgentToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const fallbackLabel = formatAgentMessage(intl, "chat.toolCall.agent.fallback", "SubAgent");
  const primaryText = getAgentPrimaryText(toolCall, fallbackLabel);
  const agentName = getAgentKindLabel(toolCall, "", context.authoritativeAgentType);
  const configuredAgentColor = useToolPresentationCapabilities().agentColor?.(agentName);
  const agentColor = agentName
    ? (configuredAgentColor ?? getAgentColor(toolCall) ?? resolveSubagentColorFromName(agentName))
    : null;
  const agentNameDetail =
    agentName && agentColor ? <AgentNameText color={agentColor} name={agentName} /> : null;
  // Agent 父块的完成/进行中边界只由父 Agent tool 决定。
  // 子 tool 是展开区明细，不能反向续住父块运行态，否则父 Agent completed 后
  // 仍会显示渐变和子工具摘要，和协议里的父工具生命周期不一致。
  const isAgentVisuallyRunning = context.isRunning;
  const collapsedChildSummary = isAgentVisuallyRunning
    ? getLatestExploreChildSummaryFromChildren(intl, childToolCalls, context, {
        includeChildActionKindLabel: true,
      })
    : null;
  // Agent 块和它内部的子工具都已经通过层级表达了来源，
  // 继续显示子智能体来源 badge 会制造重复噪音。
  const sourceLabel = undefined;
  const collapsedPrimaryText = useMemo(
    () => <span className="truncate">{primaryText}</span>,
    [primaryText],
  );
  const expandedPrimaryText = useMemo(
    () => <span className="truncate">{primaryText}</span>,
    [primaryText],
  );
  const summaryAction = useMemo(
    () =>
      context.agentSummaryAction
        ? {
            ...context.agentSummaryAction,
            ariaLabel: formatAgentMessage(
              intl,
              "chat.toolCall.agent.openInSidePane",
              "Open on the right",
            ),
          }
        : undefined,
    [context.agentSummaryAction, intl],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={AGENT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        forceOpen={false}
        summaryAction={summaryAction}
        // 产品边界：Agent/Task 在父对话中只保留单行摘要；完整 child timeline 统一从
        // 右侧 tab / 手机抽屉查看，因此这里既不自动展开，也不提供手动展开入口。
        kindLabel={fallbackLabel}
        expandedKindLabel={fallbackLabel}
        kindDetail={agentNameDetail}
        expandedKindDetail={agentNameDetail}
        sourceLabel={sourceLabel}
        autoCollapseOnComplete
        primaryText={
          collapsedChildSummary ? collapsedChildSummary.primaryText : collapsedPrimaryText
        }
        expandedPrimaryText={expandedPrimaryText}
        secondaryText={collapsedChildSummary?.secondaryText}
        expandedSecondaryText={null}
        summaryContentSeparator="·"
        animateSummaryContent
        disableSummaryContentAnimation={context.disableSummaryContentAnimation}
        summaryContentKey={
          collapsedChildSummary?.animationKey ?? `agent:${toolCall.toolId}:${primaryText}`
        }
        statusLabel={context.statusLabel}
        statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isAgentVisuallyRunning}
        title={collapsedChildSummary?.title ?? primaryText}
        expandedTitle={primaryText}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
