import {
  MULTI_AGENT_OPERATIONS, MultiAgentInputSchemas, resolveMultiAgentWaitTimeouts,
  MultiAgentOutputSchema, MultiAgentOutputJsonSchema, multiAgentToolName, toToolJsonSchema,
  CoreErrorType, createCoreError, type MultiAgentV2Config, type MultiAgentOperation,
} from "@zcode/contracts";
import type { ToolEntry } from "../tool/index.js";

const DESCRIPTIONS: Record<MultiAgentOperation, string> = {
  spawn_agent: "Start an independent asynchronous agent task. task_name is a unique lowercase sibling name. Returns a canonical /root/... path; acceptance does not mean completion. fork_turns defaults to all; all inherits valid conversation history and the parent model. Choose none for a fresh task or explicit model overrides. Specialized profiles further restrict inherited permissions.",
  send_message: "Queue a plaintext message for an agent in this root tree. Running agents receive it at a safe boundary. An idle agent is not started. Use an absolute task path or a child name relative to the caller. A delivery receipt is not evidence of reading or completion.",
  followup_task: "Continue an existing non-root agent with a new task. If idle, restore the same agent and session and start a new turn; if running, deliver at a safe boundary. This preserves identity and transcript rather than spawning a replacement.",
  list_agents: "List all known agents in this root tree, including idle and unloaded identities. Optional path_prefix is canonical and has no trailing slash. Status, residency and executing are distinct facts.",
  wait_agent: "Wait for this agent's mailbox or completion activity, new user steering, or timeout. Returns activity metadata without message bodies; no target is required.",
  interrupt_agent: "Interrupt only the target's current turn and return previous_status. The identity and transcript remain available for followup_task. Root and self are invalid targets; this operation does not stop descendants.",
};
const RESULT_BYTES = 64_000;
export function createMultiAgentToolEntries(config: MultiAgentV2Config): ToolEntry[] {
  if (!config.enabled || config.disableNativeTools) return [];
  const wait = resolveMultiAgentWaitTimeouts(config);
  return MULTI_AGENT_OPERATIONS.filter((operation) =>
    !(operation === "wait_agent" && config.waitAgentEnabled === false) &&
    !((operation === "send_message" || operation === "followup_task") && config.disableDirectMessage),
  ).map((operation) => {
    const name = multiAgentToolName(operation, config.toolNamespace);
    const inputSchema = operation === "spawn_agent" && config.exposeSpawnAgentModelOverrides === false
      ? MultiAgentInputSchemas.spawn_agent.omit({ model: true, reasoning_effort: true })
      : MultiAgentInputSchemas[operation];
    const readOnly = operation === "list_agents" || operation === "wait_agent";
    const timeoutMs = operation === "wait_agent" ? wait.maxMs + 1000 : 120_000;
    const description = operation === "wait_agent"
      ? `${DESCRIPTIONS.wait_agent} Default ${wait.defaultMs} ms. Requests below ${wait.minMs} ms are clamped; requests above ${wait.maxMs} ms are rejected.`
      : operation === "spawn_agent" && config.usageHintText
        ? `${DESCRIPTIONS.spawn_agent}\n\n${config.usageHintText}`
        : DESCRIPTIONS[operation];
    return {
      capability: description,
      metadata: { name, description, readOnly, multiAgentOperation: operation, destructive: false,
        concurrentSafe: true, shouldDefer: false, alwaysLoad: true, allowedInPlanMode: readOnly,
        timeoutMs, maxOutputBytes: RESULT_BYTES, sideEffectScope: "session", riskLevel: "low", needsApproval: false },
      inputSchema: toToolJsonSchema(inputSchema), outputSchema: MultiAgentOutputJsonSchema,
      runtimeInputSchema: inputSchema, runtimeOutputSchema: MultiAgentOutputSchema,
      handler: async (input, context) => {
        const port = context.subagentPort?.multiAgent;
        if (!port) throw createCoreError(CoreErrorType.ConfigurationError, "Multi-agent controller is unavailable", { recoverable: false });
        return port.execute(operation, inputSchema.parse(input), {
          sessionId: context.sessionId, turnId: context.turnId, parentToolCallId: context.toolCallId,
          to: "", summary: "", message: "", workingDirectory: context.workingDirectory, workspaceRoot: context.workspaceRoot,
          trace: context.traceContext ?? { traceId: context.traceId, spanId: context.spanId, sessionId: context.sessionId, turnId: context.turnId },
        }, { signal: context.abortSignal, model: context.model, modelOverride: context.subagentModelOverride });
      },
      formatModelContent: (output) => operation === "send_message" || operation === "followup_task" ? "" : JSON.stringify(MultiAgentOutputSchema.parse(output)),
      permission: { permission: `agent.v2.${operation}`, reason: description, riskLevel: "low", sideEffectScope: "session", needsApproval: false,
        patternSources: ["toolName", "input"], alwaysAllowPatternSources: ["toolName"], denyPriority: "beforeAsk" },
      resultBudget: { maxInlineBytes: RESULT_BYTES, maxModelBytes: RESULT_BYTES, strategy: "truncate", preview: { maxBytes: RESULT_BYTES, direction: "head" } },
      timeout: { defaultMs: timeoutMs, maxMs: timeoutMs, allowCallOverride: false },
      cancellation: { supported: true, cleanup: "none", userVisibleMessage: "The caller stopped waiting; admitted agents retain their own lifecycle." },
      trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
    } satisfies ToolEntry;
  });
}
