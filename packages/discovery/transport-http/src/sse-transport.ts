import type { StreamSubscription, StreamTransport } from "@jinn-network/record-discovery-client";

import type { FetchLike } from "./ports.js";
import type { SseColdSyncHint, SseTerminalEventType } from "./sse.js";

// The client-side `StreamTransport` plug (spec §6.2). One of the three
// modules the discovery source-boundaries guard allows to name an
// ambient network API (Finding F1).
//
// The primitives are exactly two, both Node 22 built-ins: the global
// `fetch` (undici) and the web `ReadableStream<Uint8Array>` on
// `Response.body`, read through a `TextDecoder`. The global
// `EventSource` is deliberately NOT used: it cannot set the
// `Last-Event-ID` request header on the FIRST connection, and an
// explicit resume from a stored cursor -- the whole point of §7.3's
// profile -- is exactly a first-connection resume. Framing is the
// EventSource wire format regardless, so a browser consumer of the same
// endpoint is unaffected.
//
// Terminal events (`unknown-cursor`, `cursor-too-old`) surface as a
// typed `SseTerminalError` on the error channel and STOP the transport:
// reconnecting on them would loop forever against a cursor the relay has
// already refused, and §9.3 forbids silent gap-skipping. The consumer's
// recovery is the cold-sync path the terminal event names.

const DEFAULT_RECONNECT_DELAY_MS = 3000;
// A frame that never terminates would otherwise grow the pending buffer
// without limit, so a hostile relay could exhaust a daemon that is doing
// nothing but listening. One megabyte is far above any real entry frame
// and far below anything that hurts.
const DEFAULT_MAX_FRAME_BYTES = 1 << 20;
const TERMINAL_EVENTS: readonly SseTerminalEventType[] = ["unknown-cursor", "cursor-too-old"];

export class SseFrameOverflowError extends Error {
  readonly url: string;
  readonly maxFrameBytes: number;

  constructor(url: string, maxFrameBytes: number) {
    super(
      `The tail at ${url} sent more than ${maxFrameBytes} bytes without completing a frame. `
        + "Treating the stream as hostile and closing it.",
    );
    this.name = "SseFrameOverflowError";
    this.url = url;
    this.maxFrameBytes = maxFrameBytes;
  }
}

export class SseTerminalError extends Error {
  readonly terminal: SseTerminalEventType;
  readonly coldSync?: SseColdSyncHint;

  constructor(terminal: SseTerminalEventType, coldSync?: SseColdSyncHint) {
    super(
      `The relay closed the tail with "${terminal}". `
        + "Recover through the cold-sync path (head + archive pages), never by guessing a cursor.",
    );
    this.name = "SseTerminalError";
    this.terminal = terminal;
    if (coldSync !== undefined) this.coldSync = coldSync;
  }
}

export interface SseStreamTransportOptions {
  /** Delay before re-opening a stream that ended without a terminal event. Defaults to 3000 ms. */
  reconnectDelayMs?: number;
  /** Cap on consecutive reconnects; `undefined` (default) reconnects indefinitely. */
  maxReconnects?: number;
  /** Ceiling on one unterminated frame before the stream is treated as hostile. Defaults to 1 MiB. */
  maxFrameBytes?: number;
}

interface ParsedFrame {
  id?: string;
  event?: string;
  data: string;
}

/** Parses one complete SSE frame (the text between two blank lines). Comment-only frames yield `undefined`. */
function parseFrame(block: string): ParsedFrame | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (id === undefined && event === undefined && dataLines.length === 0) return undefined;
  return {
    ...(id === undefined ? {} : { id }),
    ...(event === undefined ? {} : { event }),
    data: dataLines.join("\n"),
  };
}

function resolveUrl(baseUrl: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, "")}${url.startsWith("/") ? url : `/${url}`}`;
}

function isTerminal(event: string | undefined): event is SseTerminalEventType {
  return event !== undefined && (TERMINAL_EVENTS as readonly string[]).includes(event);
}

export function createSseStreamTransport(
  baseUrl: string,
  fetchLike: FetchLike = globalThis.fetch.bind(globalThis) as FetchLike,
  options: SseStreamTransportOptions = {},
): StreamTransport {
  const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;

  return {
    connect(
      url: string,
      onMessage: (raw: string) => void,
      onError: (error: unknown) => void,
    ): StreamSubscription {
      const target = resolveUrl(baseUrl, url);
      const controller = new AbortController();
      let lastEventId: string | undefined;
      let stopped = false;
      let reconnects = 0;
      // Tracked so close() can cancel a read that is blocked waiting on the
      // next chunk. Aborting `controller.signal` is enough for a real fetch()
      // over the network (undici rejects the pending read), but nothing
      // guarantees an injected `FetchLike`'s stream reacts to the abort
      // signal on its own, so close() also cancels the reader directly.
      let currentReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

      async function readOnce(): Promise<"ended" | "terminal"> {
        const headers: Record<string, string> = {
          accept: "text/event-stream",
          ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
        };
        const response = await fetchLike(target, { method: "GET", headers, signal: controller.signal });
        if (response.body === null) return "ended";
        if (stopped) return "ended";

        const reader = response.body.getReader();
        currentReader = reader;
        const decoder = new TextDecoder();
        let buffered = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            // A close() that raced in while this read was pending has
            // already cancelled the reader (see close() below); stop
            // delivering rather than parse whatever the cancel settled with.
            if (stopped) return "ended";
            if (value !== undefined) buffered += decoder.decode(value, { stream: true });
            let boundary = buffered.indexOf("\n\n");
            while (boundary !== -1) {
              const frame = parseFrame(buffered.slice(0, boundary));
              buffered = buffered.slice(boundary + 2);
              boundary = buffered.indexOf("\n\n");
              if (frame === undefined) continue;
              if (frame.id !== undefined) lastEventId = frame.id;
              if (isTerminal(frame.event)) {
                let coldSync: SseColdSyncHint | undefined;
                try {
                  coldSync = (JSON.parse(frame.data) as { coldSync?: SseColdSyncHint }).coldSync;
                } catch {
                  coldSync = undefined;
                }
                onError(new SseTerminalError(frame.event, coldSync));
                return "terminal";
              }
              if (frame.data !== "") onMessage(frame.data);
            }
            // Whatever is left is one frame still waiting for its blank-line
            // terminator. Past the ceiling it is not a slow frame, it is a
            // relay feeding an unbounded allocation -- stop rather than
            // reconnect, the same way a typed terminal event stops.
            if (buffered.length > maxFrameBytes) {
              onError(new SseFrameOverflowError(target, maxFrameBytes));
              return "terminal";
            }
            if (done) return "ended";
          }
        } finally {
          currentReader = undefined;
          await reader.cancel().catch(() => undefined);
        }
      }

      void (async () => {
        while (!stopped) {
          let outcome: "ended" | "terminal";
          try {
            outcome = await readOnce();
          } catch (error) {
            if (stopped) return;
            onError(error);
            outcome = "ended";
          }
          if (outcome === "terminal" || stopped) return;
          reconnects += 1;
          if (options.maxReconnects !== undefined && reconnects > options.maxReconnects) return;
          await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs));
        }
      })();

      return {
        close(): void {
          stopped = true;
          controller.abort();
          void currentReader?.cancel().catch(() => undefined);
        },
      };
    },
  };
}
