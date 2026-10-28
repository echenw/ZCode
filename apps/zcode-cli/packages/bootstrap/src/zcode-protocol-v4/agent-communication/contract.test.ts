import { describe, expect, it } from "vitest";
import {
  createMessageId,
  createSessionId,
  SessionEventType,
  type MessageWithParts,
  type SessionEvent,
} from "@zcode/contracts";
import { hydrateAgentCommunicationEvents } from "./index.js";

const carrier = "Message Type: MESSAGE\nTask name: /root\nSender: /root/a\nPayload:\nQuestion";

describe("agent communication display contract", () => {
  it.each(["coordinator_steer", "user_steer", undefined])(
    "restores only persisted provenance (%s)",
    (inputPresentation) => {
      const messageId = createMessageId("mail");
      const event = {
        type: SessionEventType.TurnSteerDrained,
        payload: {
          drainedInputs: [{ messageId, pendingInputId: "mail", text: carrier, delivery: "guide" }],
        },
      } as SessionEvent;
      const message: MessageWithParts = {
        info: {
          id: messageId,
          sessionID: createSessionId("root"),
          role: "user",
          time: { created: 0 },
          agent: "test",
          metadata: { inputPresentation },
        },
        parts: [],
      };
      const before = JSON.stringify({ event, message });
      const result = hydrateAgentCommunicationEvents({
        events: [event],
        messages: [message],
        sessionId: String(message.info.sessionID),
        agentNames: { "/root/a": "Ada" },
      });
      expect(result[0]?.payload).toMatchObject({
        drainedInputs: [
          expect.objectContaining({
            ...(inputPresentation ? { inputPresentation } : {}),
            ...(inputPresentation === "coordinator_steer" ? { senderName: "Ada" } : {}),
          }),
        ],
      });
      if (inputPresentation !== "coordinator_steer")
        expect(JSON.stringify(result)).not.toContain("Ada");
      expect(JSON.stringify({ event, message })).toBe(before);
    },
  );
});
