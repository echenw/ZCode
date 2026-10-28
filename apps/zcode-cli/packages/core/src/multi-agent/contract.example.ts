import type { SubagentSendMessageRequest } from "@zcode/contracts";
import type { CliMultiAgentContract } from "./contract.js";

/** Query the same owner used by native and legacy collaboration tools. */
export function exampleCliMultiAgent(contract: CliMultiAgentContract, caller: SubagentSendMessageRequest) {
  return contract.execute("list_agents", {}, caller);
}

/** User controls route through the original root owner; they never prompt a detached child App. */
export function exampleUserAgentControl(contract: CliMultiAgentContract, caller: SubagentSendMessageRequest, childSessionId: string) {
  if (!contract.controlFromUser) throw new Error("User agent control is unavailable");
  return contract.controlFromUser({ action: "send", childSessionId, text: "Continue this same agent" }, caller);
}
