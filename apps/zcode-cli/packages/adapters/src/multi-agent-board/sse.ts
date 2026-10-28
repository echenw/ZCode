import { BOARD_MAX_BODY, boardTransportError, throwIfBoardAborted } from "./http.js";

export interface BoardSseEvent { event: string; data: string }

/** Bound wire frames before UTF-8 decoding or retaining parser text, including split CRLF. */
export async function* readBoardSse(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): AsyncIterable<BoardSseEvent> {
  if (!body) throw boardTransportError("message_board_invalid_stream", "Notification response has no stream");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let frameBytes = 0;
  let lineEmpty = true;
  let previousWireCR = false;
  let previousTextCR = false;
  let line = "";
  let event = "message";
  let data: string[] = [];
  const pending: BoardSseEvent[] = [];
  const flush = () => {
    if (line === "") {
      if (data.length) pending.push({ event, data: data.join("\n") });
      data = []; event = "message";
    } else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    }
    line = "";
  };
  const consume = (text: string) => {
    for (const char of text) {
      if (char === "\n" && previousTextCR) { previousTextCR = false; continue; }
      previousTextCR = char === "\r";
      if (char === "\r" || char === "\n") flush();
      else line += char;
    }
  };
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfBoardAborted(signal);
    for (;;) {
      const next = await reader.read();
      throwIfBoardAborted(signal);
      if (next.done) {
        try { consume(decoder.decode()); }
        catch { throw boardTransportError("message_board_invalid_utf8", "Board SSE contains invalid UTF-8"); }
        break;
      }
      for (const byte of next.value) {
        if (previousWireCR && byte !== 10) { if (lineEmpty) frameBytes = 0; lineEmpty = true; }
        frameBytes += 1;
        if (frameBytes > BOARD_MAX_BODY) throw boardTransportError("message_board_frame_too_large", "Board SSE frame exceeds the service limit");
        if (byte === 10) { if (lineEmpty) frameBytes = 0; lineEmpty = true; }
        else if (byte !== 13) lineEmpty = false;
        previousWireCR = byte === 13;
      }
      try { consume(decoder.decode(next.value, { stream: true })); }
      catch { throw boardTransportError("message_board_invalid_utf8", "Board SSE contains invalid UTF-8"); }
      while (pending.length) yield pending.shift()!;
    }
    // Incomplete events at EOF are not replayable notifications.
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
