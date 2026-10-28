import type { hydrateAgentCommunicationEvents, hydrateRegisteredAgentEvents, withAgentRecipientNames } from "./index.js";
import type { loadPersistedConversationMaterialization } from "./materialize.js";

/** 只读转换；不写会话、不 ACK 邮箱、不创建或唤醒 runtime。 */
export interface CliAgentCommunicationDisplayContract {
  hydrateRegisteredAgentEvents: typeof hydrateRegisteredAgentEvents;
  withAgentRecipientNames: typeof withAgentRecipientNames;
  hydrateAgentCommunicationEvents: typeof hydrateAgentCommunicationEvents;
  loadPersistedConversationMaterialization: typeof loadPersistedConversationMaterialization;
}
export type { ConversationMaterializationSource } from "./materialize.js";
