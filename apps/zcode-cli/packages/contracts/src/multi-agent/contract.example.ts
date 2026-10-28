import { MultiAgentInputSchemas, multiAgentToolName } from "./contract.js";

export const exampleMultiAgentSpawn = {
  name: multiAgentToolName("spawn_agent", "collaboration"),
  arguments: MultiAgentInputSchemas.spawn_agent.parse({
    task_name: "review", message: "Review the assigned module.", fork_turns: "none",
  }),
};
