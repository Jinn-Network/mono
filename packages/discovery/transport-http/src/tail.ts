import { formatSequence } from "@jinn-network/record-discovery-protocol";

// The tail feed behind the SSE endpoint (Finding F5): `serve` writes a
// static layout and never writes a tail, so a live tail needs an
// in-process feed the host drives. `ArchiveTailSource` is that port;
// `createInMemoryTailSource` is the bounded, non-archival relay window
// design §9.3 requires ("relays are non-archival by design; the replay
// window is bounded and advertised").
//
// Cursors are RELAY-LOCAL and declared as such in the well-known
// advertisement (advertise.ts): they are a per-process monotone counter
// rendered in the protocol's fixed-width sequence grammar, never the
// source chain's own sequence. Data-level ordering always comes from the
// source chain (§9.3).

export type TailEventType = "announcement" | "observation";

export interface TailEvent {
  /** Relay-local cursor; becomes the SSE `id:` field and the client's `Last-Event-ID`. */
  cursor: string;
  eventType: TailEventType;
  /** The CloudEvents structured-JSON payload, already serialized (§9.1). */
  data: string;
}

export interface ReplayWindowState {
  capacity: number;
  size: number;
  oldestCursor?: string;
  newestCursor?: string;
}

export interface ArchiveTailSource {
  /** The bounded window this relay advertises (§9.3). */
  window(): ReplayWindowState;
  /**
   * The cursor's offset into the current window: `>= 0` when the cursor
   * is buffered, `-1` when it was issued but has since been evicted
   * (older than the window), and `undefined` when it was never issued or
   * lies in the future -- never guessed (§9.3).
   */
  locate(cursor: string): number | undefined;
  /** Buffered events from `offset` (inclusive) to the newest, oldest first. */
  replayFrom(offset: number): readonly TailEvent[];
  /** Subscribes to live events; the returned function unsubscribes. */
  subscribe(onEvent: (event: TailEvent) => void): () => void;
}

export interface TailPublisher {
  source: ArchiveTailSource;
  /** Appends one event, assigns the next relay-local cursor, and fans it out to live subscribers. */
  publish(eventType: TailEventType, data: string): TailEvent;
}

const CURSOR_GRAMMAR = /^[0-9]{16}$/;

export function createInMemoryTailSource(capacity: number): TailPublisher {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`createInMemoryTailSource: capacity must be a positive integer, got ${capacity}.`);
  }

  const buffer: TailEvent[] = [];
  const subscribers = new Set<(event: TailEvent) => void>();
  let issued = 0n;

  function cursorNumber(cursor: string): bigint | undefined {
    return CURSOR_GRAMMAR.test(cursor) ? BigInt(cursor) : undefined;
  }

  const source: ArchiveTailSource = {
    window(): ReplayWindowState {
      const oldest = buffer[0];
      const newest = buffer[buffer.length - 1];
      return {
        capacity,
        size: buffer.length,
        ...(oldest === undefined ? {} : { oldestCursor: oldest.cursor }),
        ...(newest === undefined ? {} : { newestCursor: newest.cursor }),
      };
    },

    locate(cursor: string): number | undefined {
      const n = cursorNumber(cursor);
      if (n === undefined) return undefined;
      if (n < 1n || n > issued) return undefined;
      const oldest = buffer[0];
      if (oldest === undefined) return -1;
      const oldestNumber = BigInt(oldest.cursor);
      if (n < oldestNumber) return -1;
      return Number(n - oldestNumber);
    },

    replayFrom(offset: number): readonly TailEvent[] {
      return buffer.slice(Math.max(0, offset));
    },

    subscribe(onEvent: (event: TailEvent) => void): () => void {
      subscribers.add(onEvent);
      return () => {
        subscribers.delete(onEvent);
      };
    },
  };

  return {
    source,
    publish(eventType: TailEventType, data: string): TailEvent {
      issued += 1n;
      const event: TailEvent = { cursor: formatSequence(issued), eventType, data };
      buffer.push(event);
      while (buffer.length > capacity) buffer.shift();
      for (const subscriber of subscribers) subscriber(event);
      return event;
    },
  };
}

export type TailCursorBehavior =
  | "live-tail-from-now"
  | "typed-error-close"
  | "replay-then-live"
  | "cursor-too-old"
  | "start-of-window";

export interface TailCursorDecision {
  behavior: TailCursorBehavior;
  detailCode?: string;
  /** Where the replay begins, when the decision replays at all. */
  replayFromOffset?: number;
}

/**
 * The server half of the §9.3 five-case cursor contract, deliberately
 * identical in outcome to `client`'s consumer-side `classifyCursor` (the
 * shared kit's `runSubscribeConformance` drives both). `cursorPosition`
 * is the cursor's offset in the window per `ArchiveTailSource.locate`.
 * A replaying decision resumes AFTER the supplied cursor, per SSE
 * `Last-Event-ID` semantics.
 */
export function classifyTailCursor(
  cursor: string | undefined,
  window: ReplayWindowState,
  cursorPosition: number | undefined,
): TailCursorDecision {
  if (cursor === undefined) return { behavior: "live-tail-from-now" };
  if (cursor === "oldest") return { behavior: "start-of-window", replayFromOffset: 0 };
  if (cursorPosition === undefined) return { behavior: "typed-error-close", detailCode: "cursor-unknown" };
  if (cursorPosition < 0) return { behavior: "cursor-too-old", detailCode: "cursor-too-old" };
  if (cursorPosition < window.capacity) {
    return { behavior: "replay-then-live", replayFromOffset: cursorPosition + 1 };
  }
  return { behavior: "typed-error-close", detailCode: "cursor-unknown" };
}
