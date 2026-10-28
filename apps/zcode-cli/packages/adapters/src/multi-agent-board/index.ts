import {
  AgentMessageBoardNotificationSchema,
  type AgentMessageBoardConfig, type AgentMessageBoardRemotePort, type AgentMessageBoardRemoteMember,
  type AgentMessageBoardCallContext, type Logger,
} from "@zcode/contracts";
import { withoutNetworkCapture } from "@zcode/shared/node";
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";
import { boardWireId, projectBoardMembers } from "./identity.js";
import {
  BOARD_TIMEOUT_MS, awaitBoardOperation, boardEndpoint, boardTransportError,
  createBoardHttpClient, throwIfBoardAborted, validBoardCredential,
} from "./http.js";
import { readBoardSse } from "./sse.js";

export interface NodeRemoteAgentMessageBoardOptions {
  rootSessionId: string;
  config: NonNullable<AgentMessageBoardConfig["messageBoardRemote"]>;
  env?: Record<string, string | undefined>;
  network?: { httpProxy?: string; noProxy?: string; caCertFile?: string };
  logger?: Pick<Logger, "warn">;
  /** Explicit transport injection for local integration fixtures and embedded Hosts. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  reconnectDelayMs?: number;
}

/** One root's transport, credentials and active receivers; membership is a Registry projection. */
export function createNodeRemoteAgentMessageBoard(options: NodeRemoteAgentMessageBoardOptions): AgentMessageBoardRemotePort {
  const environment = options.env ?? process.env;
  const credential = options.config.bearerToken ?? (options.config.bearerTokenEnvVar ? environment[options.config.bearerTokenEnvVar] : undefined);
  if (!validBoardCredential(credential)) {
    throw boardTransportError("message_board_invalid_credential", "Message-board Host credential must contain 32–4096 non-whitespace ASCII bytes");
  }
  const boardId = boardWireId(options.rootSessionId);
  const baseUrl = boardEndpoint(options.config.url, boardId);
  const timeoutMs = options.timeoutMs ?? BOARD_TIMEOUT_MS;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  const lifetime = new AbortController();
  const receivers = new Set<AbortController>();
  let members = projectBoardMembers(options.rootSessionId, []);
  let provisioned = false;
  let registered: string | undefined;
  let sessionCredential: string | undefined;
  let registration: Promise<void> = Promise.resolve();
  const networkFetch = createNetworkProxyFetch({ env: environment, ...options.network, fetch: options.fetch });
  const http = createBoardHttpClient({
    baseUrl, timeoutMs, lifetime: lifetime.signal,
    fetch: (input, init) => withoutNetworkCapture(() => networkFetch(input, init)),
    redact: (text) => [credential, sessionCredential].filter((value): value is string => value !== undefined)
      .reduce((redacted, value) => redacted.split(value).join("[REDACTED]"), text),
  });
  const callerId = (agentId: string): string => {
    const id = members.byAgent.get(agentId);
    if (!id) throw boardTransportError("message_board_unknown_caller", "Remote board caller is not a registered member");
    return id;
  };
  const ensureMembers = (context: AgentMessageBoardCallContext): Promise<void> => {
    const next = registration.then(async () => {
      throwIfBoardAborted(lifetime.signal);
      if (!provisioned) {
        const created = await http.json("PUT", "", undefined, credential, { trace: context.trace });
        if (created !== boardId) throw boardTransportError("message_board_identity_mismatch", "Remote service returned a different board identity");
        provisioned = true;
      }
      while (registered !== members.fingerprint) {
        const snapshot = members;
        const token = await http.json("POST", "/members", { members: snapshot.wire }, credential, { trace: context.trace });
        if (!validBoardCredential(token)) throw boardTransportError("message_board_invalid_credential", "Remote board returned an invalid session credential");
        sessionCredential = token;
        registered = snapshot.fingerprint;
      }
    });
    // Registration is idempotent and shared by the root. A caller abandoning its wait must not
    // cancel another agent's accepted membership registration; Host disposal still aborts it.
    registration = next.catch(() => undefined);
    return awaitBoardOperation(next, context.signal);
  };
  const warn = (code: string) => options.logger?.warn("Remote agent message-board notification connection failed", {
    event: "agent.message_board.notifications.failed", code,
  });

  return Object.freeze<AgentMessageBoardRemotePort>({
    rootSessionId: options.rootSessionId,
    setMembers(next: readonly AgentMessageBoardRemoteMember[]) {
      throwIfBoardAborted(lifetime.signal);
      members = projectBoardMembers(options.rootSessionId, next);
    },
    async call(request, context) {
      throwIfBoardAborted(context.signal);
      const caller = callerId(request.caller);
      await ensureMembers(context);
      throwIfBoardAborted(context.signal);
      return http.json("POST", "/call", { ...request, caller, timestamp: request.timestamp ?? null }, sessionCredential!, context);
    },
    notifications(watch, context, receive) {
      const controller = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(context.signal ? [context.signal] : [])]);
      const firstAttempt = Promise.withResolvers<void>();
      receivers.add(controller);
      const loop = async () => {
        let warned = false;
        while (!signal.aborted) {
          const deadline = new AbortController();
          const attemptSignal = AbortSignal.any([signal, deadline.signal]);
          const timer = setTimeout(() => deadline.abort(boardTransportError("message_board_timeout", "Notification setup timed out")), timeoutMs);
          timer.unref?.();
          let events: AsyncIterator<{ event: string; data: string }> | undefined;
          try {
            const caller = callerId(watch.caller);
            await ensureMembers({ ...context, signal: attemptSignal });
            const response = await http.notifications({ caller, turn_id: watch.turnId }, sessionCredential!, attemptSignal, context.trace);
            events = readBoardSse(response.body, attemptSignal)[Symbol.asyncIterator]();
            const ready = await events.next();
            if (ready.done || ready.value.event !== "ready") throw boardTransportError("message_board_missing_ready", "Notification stream did not acknowledge readiness");
            clearTimeout(timer);
            firstAttempt.resolve();
            warned = false;
            for (;;) {
              const item = await events.next();
              if (item.done) break;
              if (item.value.event !== "notification") continue;
              let raw: unknown;
              try { raw = JSON.parse(item.value.data); } catch { continue; }
              const notice = AgentMessageBoardNotificationSchema.safeParse(raw);
              if (!notice.success || notice.data.recipient !== caller || notice.data.turn_id !== watch.turnId) continue;
              try { await receive({ ...notice.data, recipient: watch.caller }); }
              catch { /* Best effort preview; no retry, mailbox or turn wake-up. */ }
            }
          } catch {
            if (!signal.aborted && !warned) { warn("message_board_notification_transport"); warned = true; }
          } finally {
            clearTimeout(timer);
            await events?.return?.().catch(() => undefined);
            firstAttempt.resolve();
          }
          if (!signal.aborted) await waitForReconnect(reconnectDelayMs, signal);
        }
      };
      void loop().catch(() => undefined).finally(() => { receivers.delete(controller); firstAttempt.resolve(); });
      return { ready: firstAttempt.promise, close() { controller.abort(); } };
    },
    dispose() {
      lifetime.abort();
      for (const receiver of receivers) receiver.abort();
      receivers.clear();
    },
  });
}

function waitForReconnect(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
