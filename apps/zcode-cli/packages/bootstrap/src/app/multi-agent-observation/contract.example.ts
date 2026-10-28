import type { CliMultiAgentObservationContract } from "./contract.js";
export function exampleCliMultiAgentObservation(observation: CliMultiAgentObservationContract) {
  return observation.readSubagents({ endedLimit: 20 });
}
