import type { CollaborationMode } from "./session.port.js";
import type { ResolvedUserInstructions } from "./context-source.port.js";
// ============================================================
// Subagent Port - child agent execution boundary
// ============================================================

import type { MultiAgentIdentity, MultiAgentV2Config, MultiAgentOperation, MultiAgentOutput } from "../multi-agent/index.js";
import type { ModelInputMessage } from "../model/index.js";
import type { AgentBackgroundedOutput, AgentOutput } from "../tools/agent.js";
import type { Model, ModelSelection } from "../model/index.js";
import type { ModelRequestDependencies } from "../model/invocation-context.js";
import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

export interface SubagentRunRequest {
  userInitiated?: boolean;
  multiAgent?: MultiAgentIdentity & { agentId: string; forkTurns: "all" | "none"; roleWasExplicit?: boolean; model?: string; reasoningEffort?: string; initiatingAgentPath?: string; initiatingTurnId?: string };
  forkHistory?: readonly ModelInputMessage[];
  inheritedToolAllowlist?: readonly string[];
  inheritedPermissionMode?: CollaborationMode;
  inheritedPlanEnabled?: boolean;
  /** Frozen default-child developer guidance; an empty string suppresses inheritance. */
  inheritedDeveloperInstructions?: string;
  inheritedUserInstructions?: ResolvedUserInstructions;
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  agentType: string;
  description: string;
  prompt: string;
  callerCanReadOutputFile?: boolean;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
}

export interface SubagentRunOptions {
  signal?: AbortSignal;
  /** 未显式选模的 child 从父 Agent Loop 继承的不可变 Model。 */
  model?: Model;
  /** Core Server 对前台 child 的最高优先级 Selection；每个 child 仍自行创建 Model。 */
  modelOverride?: {
    selection: ModelSelection;
    requestDependencies?: ModelRequestDependencies;
    background: "deny" | "allow";
  };
}

export interface SubagentLaunchRequest extends SubagentRunRequest {
  runInBackground?: boolean;
}

export type SubagentLaunchOptions = SubagentRunOptions;

export type SubagentStartRequest = SubagentRunRequest;

export type SubagentStartOptions = SubagentRunOptions;

export interface SubagentWaitOptions {
  signal?: AbortSignal;
}

export interface SubagentStopOptions {
  signal?: AbortSignal;
}

export interface SubagentSendMessageRequest {
  userInitiated?: boolean;
  messageId?: string;
  senderPath?: string;
  deliveryMode?: "queue_only" | "trigger_turn";
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  to: string;
  summary: string;
  message: string;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
}

export type SubagentSendMessageOptions = SubagentRunOptions;

export type SubagentSendMessageDelivery = "queued" | "steered" | "resumed_background";

export interface SubagentSendMessageResult {
  status: "success" | "failed";
  messageId: string;
  delivery?: SubagentSendMessageDelivery;
  message?: string;
  error?: string;
  agentId?: string;
  recipientName?: string;
  taskId?: string;
  outputFile?: string;
}

export type SubagentTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "killed"
  | "stopped"
  | "lost";

export interface SubagentTaskSnapshot {
  taskId: string;
  agentId: string;
  agentType: string;
  description: string;
  status: SubagentTaskStatus;
  startedAt: Date;
  completedAt?: Date;
  childSessionId?: SessionId;
  parentToolCallId?: ToolCallId | string;
  pid?: number;
  error?: string;
  output?: AgentOutput;
  outputFile?: string;
  notified?: boolean;
}

export type SubagentUserControlInput =
  | { action: "stop"; childSessionId: string }
  | { action: "send"; childSessionId: string; text: string };

export interface SubagentUserControlResult {
  agentId: string;
  childSessionId: string;
  delivery: "stopped" | "unchanged" | SubagentSendMessageDelivery;
}

export interface MultiAgentControlPort {
  readonly config: MultiAgentV2Config;
  readonly identity: MultiAgentIdentity;
  execute(operation: MultiAgentOperation, input: unknown, context: SubagentSendMessageRequest, options?: SubagentRunOptions): Promise<MultiAgentOutput>;
  notifyUserSteer?(): void;
  controlFromUser?(input: SubagentUserControlInput, context: SubagentSendMessageRequest): Promise<SubagentUserControlResult>;
}

export interface SubagentPort {
  multiAgent?: MultiAgentControlPort;
  restoreTask?(taskId: string): void;
  launch(request: SubagentLaunchRequest, options?: SubagentLaunchOptions): Promise<AgentOutput>;
  run(request: SubagentRunRequest, options?: SubagentRunOptions): Promise<AgentOutput>;
  start?(
    request: SubagentStartRequest,
    options?: SubagentStartOptions,
  ): Promise<AgentBackgroundedOutput>;
  backgroundTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  getTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  waitForTask?(
    taskId: string,
    options?: SubagentWaitOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  stopTask?(
    taskId: string,
    options?: SubagentStopOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  sendMessage?(
    request: SubagentSendMessageRequest,
    options?: SubagentSendMessageOptions,
  ): Promise<SubagentSendMessageResult>;
}
