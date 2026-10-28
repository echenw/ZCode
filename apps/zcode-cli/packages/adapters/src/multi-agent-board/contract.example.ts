import type { AgentMessageBoardCallContext, AgentMessageBoardRemoteMember } from "@zcode/contracts";
import type { CliMultiAgentBoardTransportContract } from "./contract.js";

/**
 * Core 根 Owner 读取频道的一次完整端口调用；transport 来自正式 Host 工厂的既有实例。
 * members 是 Registry 当前投影，caller 是其中的 branded agent ID；不自行分配 wire UUID。
 * 原 context 直接透传，取消、30 秒超时和凭据均由正式 Adapter 处理。
 * 这是借用端口的一次只读调用，不能在 finally 中 dispose 整个根的共享连接。
 */
export function exampleCliMultiAgentBoardTransport(
  transport: CliMultiAgentBoardTransportContract,
  members: readonly AgentMessageBoardRemoteMember[],
  caller: string,
  context: AgentMessageBoardCallContext,
): Promise<unknown> {
  transport.setMembers?.(members);
  return transport.call({
    caller,
    method: "list_channels",
    params: {
      query: null,
      direction: "NewestFirst",
      page: { cursor: null, limit: 20 },
    },
  }, context);
}
