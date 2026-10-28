import type { AgentMessageBoardCallContext } from "@zcode/contracts";
import type { CliMultiAgentBoardContract } from "./contract.js";
export function exampleCliMultiAgentBoard(board: CliMultiAgentBoardContract, context: AgentMessageBoardCallContext) {
  return board.execute("get_channels", {}, context);
}
