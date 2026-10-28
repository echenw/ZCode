import type { TraceContext } from "../tracing/tracer.js";
import type { MultiAgentIdentity } from "../multi-agent/identity.js";
import type { AgentMessageBoardOperation, AgentMessageBoardOutput, AgentMessageBoardPostPreview } from "./schemas.js";

export * from "./schemas.js";

export interface AgentMessageBoardConfig {
  messageBoardEnabled?: boolean;
  messageBoardInMemory?: boolean;
  messageBoardRemote?: {
    url: string;
    bearerToken?: string;
    bearerTokenEnvVar?: string;
  };
}

export interface AgentMessageBoardCallContext {
  /** Host-generated turnId:toolCallId; never accepted in a model input. */
  requestId: string;
  trace: TraceContext;
  signal?: AbortSignal;
}

export interface AgentMessageBoardAccess {
  /** Explicit host connections can narrow a caller to reading and own subscriptions. */
  readOnly?: boolean;
}

export interface AgentMessageBoardPort {
  readonly identity: MultiAgentIdentity;
  execute(operation: AgentMessageBoardOperation, input: unknown, context: AgentMessageBoardCallContext): Promise<AgentMessageBoardOutput>;
}

/** Credentials, transport, membership registration and receiver lifetime stay in the Host adapter. */
export interface AgentMessageBoardRemotePort {
  readonly rootSessionId: string;
  call(request: AgentMessageBoardRemoteRequest, context: AgentMessageBoardCallContext): Promise<unknown>;
  /** A projection of the existing Registry; the Host maps branded IDs to stable wire UUIDs. */
  setMembers?(members: readonly AgentMessageBoardRemoteMember[]): void;
  notifications?(
    watch: { caller: string; turnId: string },
    context: AgentMessageBoardCallContext,
    receive: (notification: unknown) => Promise<boolean>,
  ): AgentMessageBoardRemoteReceiver;
  dispose?(): void;
}

export interface AgentMessageBoardRemoteMember {
  agentId: string;
  agentPath: string;
}

export interface AgentMessageBoardRemoteReceiver {
  /** First connection attempt settled; a healthy service acknowledged `ready`. */
  readonly ready: Promise<void>;
  close(): void;
}

export interface AgentMessageBoardRemoteRequest {
  caller: string;
  timestamp?: string;
  method: "create_channel" | "list_channels" | "list_threads" | "search_posts" | "read_thread" | "read_post" | "set_subscription" | "post";
  params: Record<string, unknown>;
}

export interface AgentMessageBoardNotification {
  recipient: string;
  turn_id: string;
  post: AgentMessageBoardPostPreview;
}

export interface AgentMessageBoardOwner {
  readonly rootSessionId: string;
  readonly mode: "local" | "memory" | "remote";
  forAgent(identity: MultiAgentIdentity, access?: AgentMessageBoardAccess): AgentMessageBoardPort;
  /** A remote receiver delivers once to this exact active turn; never starts a turn. */
  receiveNotification(notification: unknown, context: AgentMessageBoardCallContext): Promise<boolean>;
  prepareForTurn?(identity: MultiAgentIdentity, context: AgentMessageBoardCallContext): Promise<void>;
  finishTurn?(identity: MultiAgentIdentity, turnId: string): void;
  dispose?(): void;
}
