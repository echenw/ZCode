import type { AgentMessageBoardPort } from "@zcode/contracts";
/** Caller scoped, persistence before publish; notifications never start turns. */
export type CliMultiAgentBoardContract = AgentMessageBoardPort;
export type { AgentMessageBoardOwner, AgentMessageBoardCallContext, AgentMessageBoardRemotePort } from "@zcode/contracts";
