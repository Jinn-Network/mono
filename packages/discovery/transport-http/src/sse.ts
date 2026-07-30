import { archivePagePath, headPath } from "@jinn-network/record-discovery-protocol";

import type { ArchiveTailSource, TailEvent } from "./tail.js";
import { classifyTailCursor } from "./tail.js";

// The pull-tail, fixed by the operator-daemon composition design §7.3 as
// SSE with `Last-Event-ID` carrying the relay cursor -- the boring
// standard for a server-to-client append-only feed (auto-reconnect,
// plain HTTP, stateless horizontal scale). A bidirectional full-duplex
// socket is justified only by mid-stream client-to-server messages, and
// discovery's filters are set at subscribe time.
//
// The §9.3 five-case cursor contract maps onto SSE as typed TERMINAL
// events followed by stream close: `unknown-cursor` for the
// never-issued/future case, `cursor-too-old` for the evicted case, the
// latter naming the cold-sync path (head + newest archive page) so a
// consumer never has to guess where to resume. No silent gap-skipping,
// ever.

export const SSE_CONTENT_TYPE = "text/event-stream";
export const SSE_RETRY_MS = 3000;

export type SseTerminalEventType = "unknown-cursor" | "cursor-too-old";

export interface SseColdSyncHint {
  head: string;
  archiveRoot: string;
}

/** Serializes one SSE frame. Embedded newlines become successive `data:` lines, per the server-sent-events wire format. */
export function formatSseFrame(frame: { id?: string; event?: string; data: string }): string {
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`);
  for (const line of frame.data.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

function eventFrame(event: TailEvent): string {
  return formatSseFrame({ id: event.cursor, event: event.eventType, data: event.data });
}

function coldSyncHint(sourceName: string, staleCursor: string): SseColdSyncHint {
  // The cold-sync entry point is the source's head plus the archive page
  // matching the client's own (now-evicted) cursor -- the consumer walks
  // forward from a page it can name exactly, never a guess (design §5.3
  // rule 3).
  return { head: headPath(sourceName), archiveRoot: archivePagePath(sourceName, staleCursor) };
}

/**
 * Opens the SSE tail for one source. Resume position comes from the
 * `Last-Event-ID` request header when present (the standard resume
 * channel, honored on the very first request so an explicit resume never
 * needs a prior connection), falling back to the `?cursor=` query
 * parameter.
 */
export function openArchiveTailStream(
  request: Request,
  sourceName: string,
  tail: ArchiveTailSource,
): Response {
  const lastEventId = request.headers.get("last-event-id");
  const queryCursor = new URL(request.url).searchParams.get("cursor");
  const cursor = lastEventId ?? queryCursor ?? undefined;

  const window = tail.window();
  const cursorPosition = cursor === undefined || cursor === "oldest" ? undefined : tail.locate(cursor);
  const decision = classifyTailCursor(cursor, window, cursorPosition);

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`retry: ${SSE_RETRY_MS}\n\n`));

      if (decision.behavior === "typed-error-close") {
        controller.enqueue(encoder.encode(formatSseFrame({
          event: "unknown-cursor" satisfies SseTerminalEventType,
          data: JSON.stringify({ detailCode: decision.detailCode ?? "cursor-unknown" }),
        })));
        controller.close();
        return;
      }

      if (decision.behavior === "cursor-too-old") {
        // `cursor-too-old` is only reachable when `cursor` was resolved to
        // a defined, non-"oldest" string above (that is what fed
        // `tail.locate` to produce a negative position in the first
        // place), so this is a real invariant, not an assumption.
        controller.enqueue(encoder.encode(formatSseFrame({
          event: "cursor-too-old" satisfies SseTerminalEventType,
          data: JSON.stringify({
            detailCode: "cursor-too-old",
            coldSync: coldSyncHint(sourceName, cursor as string),
          }),
        })));
        controller.close();
        return;
      }

      if (decision.replayFromOffset !== undefined) {
        for (const event of tail.replayFrom(decision.replayFromOffset)) {
          controller.enqueue(encoder.encode(eventFrame(event)));
        }
      }

      unsubscribe = tail.subscribe((event) => {
        try {
          controller.enqueue(encoder.encode(eventFrame(event)));
        } catch {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      });
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": SSE_CONTENT_TYPE,
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
