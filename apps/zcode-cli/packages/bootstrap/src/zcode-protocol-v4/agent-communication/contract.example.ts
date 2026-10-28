import type { MessageWithParts } from "@zcode/contracts";
import type { CliAgentCommunicationDisplayContract } from "./contract.js";

export function exampleCliAgentCommunicationDisplay(
  contract: CliAgentCommunicationDisplayContract,
  messages: MessageWithParts[],
) {
  return contract.withAgentRecipientNames(messages, { "/root/a": "Ada" });
}
