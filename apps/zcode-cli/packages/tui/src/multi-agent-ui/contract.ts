import type { SubagentView, SubagentsSection } from "./index.js";
/** Native views consume the app-owned read model and own no agent state. */
export interface CliMultiAgentUiContract {
  sidebar: typeof SubagentsSection;
  detail: typeof SubagentView;
}
