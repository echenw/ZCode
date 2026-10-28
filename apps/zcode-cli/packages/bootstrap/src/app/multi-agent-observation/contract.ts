import type { createSubagentObservation } from "./index.js";
/** Read-only projection; transcript reads validate persisted ancestry and project membership. */
export type CliMultiAgentObservationContract = ReturnType<typeof createSubagentObservation>;
export type { SubagentTranscriptSnapshot } from "./index.js";
