import { describe, expect, it } from "vitest";
import {
  ModelTransportKind,
  SessionEventType,
  createSessionId,
  createTraceId,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelSelection } from "./test-model-selection.js";
import {
  createTestModelFactory,
  type TestModelExecutionObservation,
} from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { isRetryableStreamRecoveryFailure } from "../src/runtime/methods/streaming-recovery.js";

type ReasoningFailureKind = "idle-timeout" | "network-reset";

function createReasoningFailure(kind: ReasoningFailureKind): Error {
  const error = new Error(
    kind === "idle-timeout"
      ? "Model stream stalled: no event received before the idle timeout."
      : "Provider stream failed with ECONNRESET.",
  ) as Error & { code?: string; context?: Record<string, unknown> };
  error.code = kind === "idle-timeout" ? "model_request_timeout" : "model_network_error";
  error.context = {
    reason: kind === "idle-timeout" ? "stream_idle_timeout" : "network_error",
    retryable: true,
  };
  return error;
}

async function publishModelNetworkStatus(
  observation: TestModelExecutionObservation,
  event: Record<string, unknown>,
): Promise<void> {
  await observation.invocationContext?.statusSink?.publish({
    attempt: 1,
    maxAttempts: 1,
    providerId: String(observation.model.providerId),
    modelId: String(observation.model.modelId),
    requestId: event.requestId,
    timestamp: new Date().toISOString(),
    traceId:
      observation.invocationContext?.traceContext?.traceId ??
      createTraceId("reasoning-recovery-test"),
    transport: ModelTransportKind.Sse,
    ...event,
  });
}

describe("AgentRuntime reasoning-only stream recovery", () => {
  it.each<ReasoningFailureKind>(["idle-timeout", "network-reset"])(
    "recovers from a retryable %s after visible reasoning without text or tools",
    async (failureKind) => {
      const sessionId = createSessionId(`reasoning-only-recovery-${failureKind}`);
      const eventStore = createTestSessionEventStore();
      let modelCallCount = 0;
      let recoveryRequest: any;
      let recoveryObservation: TestModelExecutionObservation | undefined;

      const runtime = createTestAgentRuntime(
        sessionId,
        {
          mode: "yolo",
          modelSelection: createTestModelSelection("test/reasoning-recovery"),
          modelStreaming: "on",
        },
        {
          eventStore,
          modelFactory: createTestModelFactory({
            async generateText() {
              throw new Error("streaming path expected");
            },
            async *streamText(request: any, observation) {
              modelCallCount += 1;
              if (modelCallCount === 1) {
                await publishModelNetworkStatus(observation, {
                  requestId: `reasoning-${failureKind}-1`,
                  type: "model_request_started",
                });
                yield { type: "reasoning_start", id: "reasoning-failed" };
                yield {
                  type: "reasoning_delta",
                  id: "reasoning-failed",
                  text: "unfinished reasoning",
                };
                const error = createReasoningFailure(failureKind);
                await publishModelNetworkStatus(observation, {
                  message: error.message,
                  reason: error.context?.reason,
                  requestId: `reasoning-${failureKind}-1`,
                  retryable: true,
                  type: "model_request_failed",
                });
                throw error;
              }

              recoveryRequest = request;
              recoveryObservation = observation;
              await publishModelNetworkStatus(observation, {
                requestId: `reasoning-${failureKind}-2`,
                type: "model_request_started",
              });
              yield { type: "reasoning_start", id: "reasoning-recovered" };
              yield {
                type: "reasoning_delta",
                id: "reasoning-recovered",
                text: "fresh reasoning",
              };
              yield { type: "reasoning_end", id: "reasoning-recovered" };
              yield { type: "text_delta", text: "recovered answer" };
              yield {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          } as never),
        },
      );

      const result = await runtime.executeTurn("recover reasoning-only stream");
      const events = await eventStore.getEvents(sessionId);
      const discardedTail = events.find(
        (event) => event.type === SessionEventType.StreamRecoveryTailDiscarded,
      )?.payload as Record<string, unknown> | undefined;
      const reasoningAssistantIds = events
        .filter((event) => event.type === SessionEventType.ModelStreaming)
        .map((event) => event.payload as any)
        .filter((payload) => payload.kind === "reasoning_delta")
        .map((payload) => payload.assistantMessageId);

      expect(result.response).toBe("recovered answer");
      expect(modelCallCount).toBe(2);
      expect(recoveryObservation?.invocationContext?.streamIdleTimeoutRetryNumber).toBe(1);
      expect(
        recoveryRequest.messages.filter((message: any) => message.role === "assistant"),
      ).toEqual([]);
      expect(recoveryObservation?.invocationContext?.streamRecovery).toMatchObject({
        recoveredFromRequestId: `reasoning-${failureKind}-1`,
        retryNumber: 1,
        maxRetries: 10,
      });
      expect(discardedTail).toMatchObject({
        discardedReasoningBytes: new TextEncoder().encode("unfinished reasoning").byteLength,
        discardedTextBytes: 0,
        discardedToolCallIds: [],
      });
      expect(new Set(reasoningAssistantIds).size).toBe(2);
    },
  );
});

describe("stream recovery admission", () => {
  it.each([
    { reason: "rate_limited", code: "model_rate_limited" },
    { reason: "timeout", code: "model_request_timeout" },
    { reason: "auth_failed", code: "provider_not_configured" },
    { reason: "invalid_request", code: "invalid_model_request" },
  ])("preserves the normalized terminal decision for $reason", ({ reason, code }) => {
    const error = Object.assign(new Error("stream timed out"), {
      code,
      context: { reason, retryable: false },
      cause: Object.assign(new Error("old transient cause"), { retryable: true }),
    });
    expect(isRetryableStreamRecoveryFailure(error)).toBe(false);
  });

  it("uses the normalized decision rather than an old SDK cause", () => {
    expect(
      isRetryableStreamRecoveryFailure(
        Object.assign(new Error("normalized transient error"), {
          context: { reason: "network_error", retryable: true },
          cause: Object.assign(new Error("SDK error"), { retryable: false }),
        }),
      ),
    ).toBe(true);
  });

  it.each(["EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET"])(
    "accepts structured transport code %s without parsing prose",
    (code) => {
      expect(isRetryableStreamRecoveryFailure(Object.assign(new Error("closed"), { code }))).toBe(
        true,
      );
      expect(isRetryableStreamRecoveryFailure(new Error(code))).toBe(false);
    },
  );

  it("does not treat timeout prose as a retry contract", () => {
    expect(isRetryableStreamRecoveryFailure(new Error("invalid timeout configuration"))).toBe(
      false,
    );
  });

  it("does not retry an invalid protocol response because its cause was a transport failure", () => {
    expect(
      isRetryableStreamRecoveryFailure(
        Object.assign(new Error("invalid protocol response"), {
          code: "invalid_model_response",
          cause: Object.assign(new Error("connection closed"), { code: "EPIPE" }),
        }),
      ),
    ).toBe(false);
  });

  it.each(["text_delta", "reasoning_delta"] as const)(
    "ends the turn after terminal rate limiting following %s",
    async (type) => {
      const sessionId = createSessionId(`terminal-stream-${type}`);
      const eventStore = createTestSessionEventStore();
      let modelCallCount = 0;
      const runtime = createTestAgentRuntime(
        sessionId,
        { mode: "yolo", modelStreaming: "on", titleGeneration: { enabled: false } },
        {
          eventStore,
          modelFactory: createTestModelFactory({
            async *streamText() {
              modelCallCount += 1;
              yield { type, id: "partial", text: "partial output" };
              throw Object.assign(new Error("quota exhausted after stream timeout"), {
                code: "model_rate_limited",
                context: { reason: "rate_limited", retryable: false },
              });
            },
          }),
        },
      );
      await expect(runtime.executeTurn("terminal stream failure")).rejects.toBeDefined();
      expect(modelCallCount).toBe(1);
      const events = await eventStore.getEvents(sessionId);
      expect(events.filter((event) => event.type === SessionEventType.StreamRecoveryRetryStarted))
        .toHaveLength(0);
    },
  );
});
