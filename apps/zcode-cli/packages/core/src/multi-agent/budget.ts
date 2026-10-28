import {
  CoreErrorType, createCoreError,
  type ModelUsageSummary, type MultiAgentIdentity, type MultiAgentV2Config,
} from "@zcode/contracts";
import type { RuntimeTaskRegistry, RuntimeTaskSnapshot } from "../runtime-task/registry.js";

const emptyUsage = (): ModelUsageSummary => ({ source: "provider", modelRequestCount: 0,
  inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  reasoningTokens: 0, webSearchRequests: 0, webFetchRequests: 0 });
const counters = ["modelRequestCount", "inputTokens", "outputTokens", "totalTokens", "cacheReadTokens",
  "cacheWriteTokens", "reasoningTokens", "webSearchRequests", "webFetchRequests"] as const;

/** Only provider-reported values enter this ledger. Cache/reasoning are breakdowns, not extra total tokens. */
export function recordMultiAgentUsage(
  registry: RuntimeTaskRegistry | undefined, identity: MultiAgentIdentity | undefined,
  usage: ModelUsageSummary | number | undefined, usageId?: string,
  executionModel?: { model: string; reasoningEffort?: string },
): RuntimeTaskSnapshot | undefined {
  if (!registry || !identity || usage === undefined) return;
  const reported = typeof usage === "number" ? { ...emptyUsage(), modelRequestCount: 1, totalTokens: usage } : usage;
  if (counters.some((key) => !Number.isFinite(reported[key]) || reported[key] < 0)) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Provider reported invalid multi-agent token usage", {
      context: { code: "multi_agent_invalid_usage" }, recoverable: false,
    });
  }
  const task = Object.values(registry.all()).find((candidate) => candidate.multiAgent?.rootSessionId === identity.rootSessionId && candidate.multiAgent.agentPath === identity.agentPath);
  if (!task || (usageId && task.multiAgent?.accountedUsageIds?.includes(usageId))) return;
  return registry.update(task.taskId, (current) => {
    const previous = current.multiAgent!.lifetimeUsage ?? { ...emptyUsage(), totalTokens: current.multiAgent!.totalTokens ?? 0 };
    const lifetimeUsage = { ...previous };
    for (const key of counters) lifetimeUsage[key] += reported[key];
    return { ...current, multiAgent: { ...current.multiAgent!, ...executionModel, totalTokens: lifetimeUsage.totalTokens, lifetimeUsage,
      ...(usageId ? { accountedUsageIds: [...(current.multiAgent!.accountedUsageIds ?? []), usageId] } : {}) } };
  });
}

export function getMultiAgentUsage(registry: RuntimeTaskRegistry, rootSessionId: string): ModelUsageSummary {
  const total = emptyUsage();
  for (const task of Object.values(registry.all())) {
    if (task.multiAgent?.rootSessionId !== rootSessionId) continue;
    const usage = task.multiAgent.lifetimeUsage ?? { ...emptyUsage(), totalTokens: task.multiAgent.totalTokens ?? 0 };
    for (const key of counters) total[key] += usage[key];
  }
  return total;
}

/** Like upstream rollout budget, exhaustion rejects later requests after actual usage is reported. */
export function assertMultiAgentTokenBudget(
  registry: RuntimeTaskRegistry | undefined, identity: MultiAgentIdentity | undefined,
  config: MultiAgentV2Config | undefined,
): void {
  if (!registry || !identity || config?.tokenBudget === undefined) return;
  if (!Number.isSafeInteger(config.tokenBudget) || config.tokenBudget <= 0) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Root tree token budget must be a positive integer", {
      context: { code: "multi_agent_invalid_token_budget" }, recoverable: false,
    });
  }
  const used = getMultiAgentUsage(registry, identity.rootSessionId).totalTokens;
  if (used >= config.tokenBudget) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, `Root tree token budget exhausted (${used}/${config.tokenBudget} reported tokens)`, {
      context: { code: "multi_agent_token_budget", usedTokens: used, tokenBudget: config.tokenBudget }, recoverable: false,
    });
  }
}
