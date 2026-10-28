import type { TraceContext, TurnSteerInput, TurnSteerResult } from "@zcode/contracts";
import type { RuntimeTaskMessageSink } from "../runtime-task/registry.js";

interface SteerableRuntime {
  steerTurn(input: string | TurnSteerInput): Promise<TurnSteerResult>;
}

export function createSubagentMessageSink(
  runtime: SteerableRuntime,
  request: { traceContext: TraceContext; retainsUntilConsumed?: boolean },
): RuntimeTaskMessageSink {
  return {
    retainsUntilConsumed: request.retainsUntilConsumed,
    async sendActive(message, expectedTurnId) {
      const result = await runtime.steerTurn({ delivery: "guide", inputPresentation: message.origin?.kind === "user" ? "user_steer" : "coordinator_steer",
        input: formatSubagentCoordinatorMessage(message), inputId: message.id, pendingInputId: message.id, expectedTurnId,
        traceContext: message.traceContext ?? request.traceContext });
      return result.kind !== "rejected";
    },
    async send(message) {
      const result = await steerSubagentMessage(runtime, request, message);
      if (result.kind === "rejected") {
        if (request.retainsUntilConsumed && result.reason === "no_active_turn") return "queued";
        throw new Error(`Subagent message rejected: ${result.reason}`);
      }
      return "steered";
    },
  };
}

async function steerSubagentMessage(
  runtime: SteerableRuntime,
  request: { traceContext: TraceContext; retainsUntilConsumed?: boolean },
  message: { id: string; message: string; summary?: string; traceContext?: TraceContext; senderPath?: string; targetPath?: string; messageType?: string; origin?: { kind: "coordinator" | "user" } },
): Promise<TurnSteerResult> {
  const input = formatSubagentCoordinatorMessage(message);
  // V2 已在 Registry 保留待消费事实；startup 边界会投递，无需跨 turn 的时间重试。
  if (request.retainsUntilConsumed) return runtime.steerTurn({
    delivery: "guide", inputPresentation: message.origin?.kind === "user" ? "user_steer" : "coordinator_steer", input,
    inputId: message.id, pendingInputId: message.id,
    traceContext: message.traceContext ?? request.traceContext,
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await runtime.steerTurn({
      delivery: "guide",
      inputPresentation: "coordinator_steer",
      input,
      inputId: message.id,
      pendingInputId: message.id,
      traceContext: message.traceContext ?? request.traceContext,
    });
    if (result.kind !== "rejected" || result.reason !== "no_active_turn") {
      return result;
    }
    await sleep(10);
  }
  return runtime.steerTurn({
    delivery: "guide",
    inputPresentation: "coordinator_steer",
    input,
    inputId: message.id,
    pendingInputId: message.id,
    traceContext: message.traceContext ?? request.traceContext,
  });
}

function formatSubagentCoordinatorMessage(message: { message: string; summary?: string; senderPath?: string; targetPath?: string; messageType?: string; senderName?: string; targetName?: string }): string {
  if (message.senderPath) return [`Message Type: ${message.messageType ?? "MESSAGE"}`, `Task name: ${message.targetPath ?? "current agent"}`, `Sender: ${message.senderPath}`,
    ...(message.senderName ? [`Sender name: ${message.senderName}`] : []),
    ...(message.targetName ? [`Recipient name: ${message.targetName}`] : []), "Payload:", message.message].join("\n");
  const summary = message.summary?.trim();
  if (!summary) return message.message;
  return [summary, "", message.message].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
