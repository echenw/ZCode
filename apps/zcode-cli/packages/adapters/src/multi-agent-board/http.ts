import { CoreErrorType, createCoreError, isCoreError, type TraceContext } from "@zcode/contracts";

export const BOARD_MAX_BODY = 512 * 1024;
export const BOARD_MAX_RESPONSE = 1024 * 1024;
export const BOARD_TIMEOUT_MS = 30_000;

export function boardTransportError(code: string, message: string) {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, { recoverable: false, context: { code } });
}

export function boardEndpoint(endpoint: string, boardId: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw boardTransportError("message_board_invalid_endpoint", "Invalid message-board endpoint"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.search || url.hash || url.username || url.password) {
    throw boardTransportError("message_board_invalid_endpoint", "Message-board endpoint must be HTTP(S) without query, fragment or URL credentials");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/boards/${boardId}`;
  return url.toString();
}

export function validBoardCredential(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}

export function throwIfBoardAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? boardTransportError("message_board_cancelled", "Message-board request cancelled");
}

export async function awaitBoardOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfBoardAborted(signal);
  if (!signal) return operation;
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? boardTransportError("message_board_cancelled", "Message-board request cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

export function createBoardHttpClient(options: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  lifetime: AbortSignal;
  timeoutMs: number;
  redact(text: string): string;
}) {
  const request = async (method: "PUT" | "POST", suffix: string, body: unknown, credential: string,
    signal: AbortSignal, trace?: TraceContext): Promise<Response> => {
    throwIfBoardAborted(signal);
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined && Buffer.byteLength(text) > BOARD_MAX_BODY) {
      throw boardTransportError("message_board_request_too_large", "Message-board request exceeds the service limit");
    }
    try {
      return await options.fetch(`${options.baseUrl}${suffix}`, {
        method, redirect: "manual", signal,
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json",
          accept: suffix === "/notifications" ? "text/event-stream" : "application/json",
          ...(trace ? { "x-zcode-trace-id": String(trace.traceId) } : {}) },
        ...(text === undefined ? {} : { body: text }),
      });
    } catch {
      throwIfBoardAborted(signal);
      throw boardTransportError("message_board_transport_error", "Remote message-board transport failed");
    }
  };
  const decode = async (response: Response): Promise<unknown> => {
    const body = await readBoardResponse(response);
    let data: unknown;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { throw boardTransportError("message_board_invalid_response", "Remote message-board returned an invalid JSON response"); }
    if (response.ok) return data;
    const error = data && typeof data === "object" ? data as Record<string, unknown> : {};
    if (response.status === 403 && error.code === "permission_denied") {
      const detail = (key: string) => typeof error[key] === "string" ? options.redact(String(error[key])).slice(0, 512) : undefined;
      throw createCoreError(CoreErrorType.PermissionDenied, "Remote message-board permission denied", {
        recoverable: false, context: { code: "permission_denied", action: detail("action"), resource: detail("resource") },
      });
    }
    throw boardTransportError("message_board_remote_error", `Remote message-board request failed (HTTP ${response.status})`);
  };
  return {
    async json(method: "PUT" | "POST", suffix: string, body: unknown, credential: string,
      context: { signal?: AbortSignal; trace?: TraceContext } = {}): Promise<unknown> {
      const deadline = new AbortController();
      const timeout = setTimeout(() => deadline.abort(boardTransportError("message_board_timeout", "Message-board request timed out")), options.timeoutMs);
      timeout.unref?.();
      const signal = AbortSignal.any([options.lifetime, deadline.signal, ...(context.signal ? [context.signal] : [])]);
      try { return await decode(await request(method, suffix, body, credential, signal, context.trace)); }
      catch (error) {
        throwIfBoardAborted(signal);
        if (isCoreError(error)) throw error;
        throw boardTransportError("message_board_transport_error", "Remote message-board transport failed");
      }
      finally { clearTimeout(timeout); }
    },
    async notifications(body: unknown, credential: string, signal: AbortSignal, trace?: TraceContext): Promise<Response> {
      const response = await request("POST", "/notifications", body, credential, signal, trace);
      if (!response.ok) { await decode(response); throw boardTransportError("message_board_invalid_response", "Unexpected notification response"); }
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
        await response.body?.cancel();
        throw boardTransportError("message_board_invalid_stream", "Remote message-board did not return an event stream");
      }
      return response;
    },
  };
}

async function readBoardResponse(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > BOARD_MAX_RESPONSE) throw boardTransportError("message_board_response_too_large", "Message-board response exceeds the service limit");
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}
