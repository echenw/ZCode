import type { AgentMessageBoardConfig, AgentMessageBoardOperation } from "../multi-agent-board/index.js";
import { z } from "zod";
import { toToolJsonSchema } from "../tools/json-schema.js";

export const MULTI_AGENT_OPERATIONS = ["spawn_agent", "send_message", "followup_task", "list_agents", "wait_agent", "interrupt_agent"] as const;
export type MultiAgentOperation = (typeof MULTI_AGENT_OPERATIONS)[number];
export const MULTI_AGENT_DEFAULT_NAMESPACE = "collaboration";
export const MULTI_AGENT_DEFAULT_CAPACITY = 4;
export const MULTI_AGENT_WAIT_MIN_MS = 10_000;
export const MULTI_AGENT_WAIT_DEFAULT_MS = 30_000;
export const MULTI_AGENT_WAIT_MAX_MS = 3_600_000;

export type { MultiAgentIdentity } from "./identity.js";
export { allocateMultiAgentNicknames } from "./identity.js";
export interface MultiAgentV2Config extends AgentMessageBoardConfig {
  enabled?: boolean;
  toolNamespace?: string;
  maxConcurrentThreadsPerSession?: number;
  maxResidentAgents?: number;
  disableNativeTools?: boolean;
  disableDirectMessage?: boolean;
  waitAgentEnabled?: boolean;
  minWaitTimeoutMs?: number;
  maxWaitTimeoutMs?: number;
  defaultWaitTimeoutMs?: number;
  exposeSpawnAgentModelOverrides?: boolean;
  hideSpawnAgentMetadata?: boolean;
  preserveForkPrefix?: boolean;
  delegationMode?: "explicit" | "proactive";
  tokenBudget?: number;
  /** Deprecated compatibility field; its value is ignored. */
  usageHintEnabled?: boolean;
  usageHintText?: string;
  rootAgentUsageHintText?: string;
  subagentUsageHintText?: string;
  subagentDeveloperInstructions?: string;
  multiAgentModeHintText?: string;
}

export function resolveMultiAgentWaitTimeouts(config: MultiAgentV2Config): { minMs: number; maxMs: number; defaultMs: number } {
  const timeouts = { minMs: config.minWaitTimeoutMs ?? MULTI_AGENT_WAIT_MIN_MS,
    maxMs: config.maxWaitTimeoutMs ?? MULTI_AGENT_WAIT_MAX_MS, defaultMs: config.defaultWaitTimeoutMs ?? MULTI_AGENT_WAIT_DEFAULT_MS };
  for (const [field, value] of Object.entries(timeouts)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MULTI_AGENT_WAIT_MAX_MS) throw new Error(`${field} must be an integer from 0 to ${MULTI_AGENT_WAIT_MAX_MS}`);
  }
  if (timeouts.minMs > timeouts.maxMs) throw new Error("minWaitTimeoutMs must not exceed maxWaitTimeoutMs");
  if (timeouts.defaultMs < timeouts.minMs || timeouts.defaultMs > timeouts.maxMs) throw new Error("defaultWaitTimeoutMs must be between minWaitTimeoutMs and maxWaitTimeoutMs");
  return timeouts;
}

export function multiAgentToolName(operation: MultiAgentOperation | AgentMessageBoardOperation, namespace = MULTI_AGENT_DEFAULT_NAMESPACE): string {
  if (namespace !== "" && !/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) {
    throw new Error("Multi-agent tool namespace must use 1–64 ASCII letters, digits, underscores or hyphens");
  }
  const full = namespace ? `${namespace}_${operation}` : operation;
  if (full.length <= 64) return full;
  // Logical namespaces keep the upstream range; only the provider wire alias has a 64-character bound.
  let hash = 2166136261;
  for (const character of namespace) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  const suffix = `_${hash.toString(16).padStart(8, "0")}_${operation}`;
  return namespace.slice(0, 64 - suffix.length) + suffix;
}
export const MultiAgentSpawnInputSchema = z.object({
  task_name: z.string().regex(/^[a-z0-9_]+$/).refine((name) => name !== "root", "task_name root is reserved"),
  message: z.string().refine((message) => message.trim().length > 0, "Message must not be empty"),
  agent_type: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoning_effort: z.string().min(1).optional(),
  fork_turns: z.string().optional(),
}).strict();
export const MultiAgentMessageInputSchema = z.object({ target: z.string().min(1), message: z.string().refine((message) => message.trim().length > 0, "Message must not be empty") }).strict();
export const MultiAgentListInputSchema = z.object({ path_prefix: z.string().min(1).optional() }).strict();
export const MultiAgentWaitInputSchema = z.object({ timeout_ms: z.number().int().optional() }).strict();
export const MultiAgentInterruptInputSchema = z.object({ target: z.string().min(1) }).strict();
export type MultiAgentSpawnInput = z.infer<typeof MultiAgentSpawnInputSchema>;
export type MultiAgentMessageInput = z.infer<typeof MultiAgentMessageInputSchema>;
export const MultiAgentInputSchemas = {
  spawn_agent: MultiAgentSpawnInputSchema,
  send_message: MultiAgentMessageInputSchema,
  followup_task: MultiAgentMessageInputSchema,
  list_agents: MultiAgentListInputSchema,
  wait_agent: MultiAgentWaitInputSchema,
  interrupt_agent: MultiAgentInterruptInputSchema,
};
export const MultiAgentStatusSchema = z.union([
  z.enum(["pending_init", "running", "interrupted", "shutdown", "not_found"]),
  z.object({ completed: z.string().nullable() }).strict(),
  z.object({ errored: z.string() }).strict(),
]);
export const MultiAgentOutputSchema = z.object({
  task_name: z.string().optional(),
  nickname: z.string().nullable().optional(),
  previous_status: MultiAgentStatusSchema.optional(),
  message: z.string().optional(),
  timed_out: z.boolean().optional(),
  agents: z.array(z.object({ agent_name: z.string(), nickname: z.string().optional(), agent_status: MultiAgentStatusSchema }).strict()).optional(),
}).strict();
export type MultiAgentOutput = z.infer<typeof MultiAgentOutputSchema>;
export const MultiAgentOutputJsonSchema = toToolJsonSchema(MultiAgentOutputSchema);

// The root session entry is a projection of the live registry, not a second task database.
export const MultiAgentStoredGraphSchema = z.object({
  version: z.literal(1), rootSessionId: z.string(),
  tasks: z.array(z.object({
    taskId: z.string(), agentId: z.string(), agentType: z.string(), description: z.string(),
    status: z.enum(["running", "completed", "failed", "cancelled", "killed", "stopped", "lost"]),
    startedAt: z.string().datetime(), completedAt: z.string().datetime().optional(), childSessionId: z.string().optional(),
    parentSessionId: z.string().optional(), parentToolCallId: z.string().optional(),
    outputFile: z.string().optional(), prompt: z.string().optional(), error: z.string().optional(),
    isBackgrounded: z.boolean().optional(), branchGeneration: z.number().int().nonnegative().optional(),
    multiAgent: z.object({ agentPath: z.string(), parentPath: z.string().optional(), rootSessionId: z.string(), nickname: z.string().optional(),
      resident: z.boolean(), runGeneration: z.number().int().nonnegative(), totalTokens: z.number().finite().nonnegative().optional(),
      roleWasExplicit: z.boolean().optional(), model: z.string().optional(), reasoningEffort: z.string().optional(), forkTurns: z.enum(["all", "none"]).optional(),
      initiatingAgentPath: z.string().optional(), initiatingTurnId: z.string().optional(),
      activitySequence: z.number().int().nonnegative().optional(), observedSequence: z.number().int().nonnegative().optional(),
      lifetimeUsage: z.object({ source: z.literal("provider"), modelRequestCount: z.number().int().nonnegative(),
        inputTokens: z.number().finite().nonnegative(), outputTokens: z.number().finite().nonnegative(),
        totalTokens: z.number().finite().nonnegative(), cacheReadTokens: z.number().finite().nonnegative(),
        cacheWriteTokens: z.number().finite().nonnegative(), reasoningTokens: z.number().finite().nonnegative(),
        webSearchRequests: z.number().int().nonnegative(), webFetchRequests: z.number().int().nonnegative(),
      }).optional(),
      accountedUsageIds: z.array(z.string()).optional(),
      deliveredMessages: z.number().int().nonnegative().optional(),
    }),
    pendingMessages: z.array(z.object({ id: z.string(), message: z.string(), queuedAt: z.string().datetime(),
      origin: z.object({ kind: z.enum(["coordinator", "user"]), toolCallId: z.string().optional() }).optional(),
      senderPath: z.string().optional(), targetPath: z.string().optional(),
      senderName: z.string().optional(), targetName: z.string().optional(),
      messageType: z.enum(["MESSAGE", "NEW_TASK", "FINAL_ANSWER"]).optional(),
      summary: z.string().optional(), isMeta: z.boolean().optional(), traceContext: z.unknown().optional(),
    })),
    resumeState: z.unknown().optional(), output: z.unknown().optional(), usage: z.unknown().optional(), traceContext: z.unknown().optional(),
  }).strict()),
}).strict();
