import type { PingTransport } from "./ports.js";

// Announcement pings (design §7 item 4): optional, unauthenticated
// "head moved" hints over any transport. Debounced on the emitting side
// too -- a source that re-signs its head frequently (§7.3 maintainHead)
// should not flood its ping transport (webhook, gossip) with one ping per
// re-sign. This is a separate, producer-side concern from the consumer-
// side pull-rate debounce (`client`'s ping-flood conformance, M6): pings
// carry no trust either way, so debouncing either side only affects
// latency, never correctness (§7 item 4).

export interface DebouncePolicy {
  /** Returns whether a ping for `headUrl` should actually go out at `at`. */
  shouldEmit(headUrl: string, at: Date): boolean;
}

/** A debounce policy that allows at most one emission per `windowMs`, per `headUrl`. */
export function createFixedWindowDebounce(windowMs: number): DebouncePolicy {
  const lastEmittedAtMs = new Map<string, number>();
  return {
    shouldEmit(headUrl: string, at: Date): boolean {
      const nowMs = at.getTime();
      const lastMs = lastEmittedAtMs.get(headUrl);
      if (lastMs !== undefined && nowMs - lastMs < windowMs) return false;
      lastEmittedAtMs.set(headUrl, nowMs);
      return true;
    },
  };
}

/** Emits a ping for `headUrl` through `transport`, subject to `debounce`. Returns whether it was actually sent. */
export async function emitPing(
  transport: PingTransport,
  headUrl: string,
  debounce: DebouncePolicy,
  at: Date,
): Promise<boolean> {
  if (!debounce.shouldEmit(headUrl, at)) return false;
  await transport.announce(headUrl);
  return true;
}
