import type { FactsProfileDocument } from "@jinn-network/record-discovery-protocol";

// Injected ports (design §5.3/§8/§9): everything `client` needs from the
// outside world -- transport, streaming, persistence, and clock reads. No
// ambient network APIs in this package (plan Global Constraints,
// guard-enforced -- see the source-boundaries guard's banned-API list).
//
// `HighWaterMarkStore` is NOT redefined here: `client` re-uses the exact
// port `record-discovery-protocol` already freezes (`verify/ports.ts`),
// re-exported below for convenience. A persistent implementation (e.g.
// backed by a file or a database) satisfies that same shape; the in-memory
// variant this package builds for cold/warm sync (Task 19) is one such
// implementation.
export type { HighWaterMarkStore, ResolvedKey } from "@jinn-network/record-discovery-protocol";

export interface TransportResponse {
  status: number;
  contentType?: string;
  bytes: Uint8Array;
}

// The method name is quoted -- see the identical note in protocol's
// verify/ports.ts: the discovery tree's ambient-network guard is a textual
// regex scanner and cannot distinguish a same-named port-method declaration
// from a call to the banned global `fetch`.
export interface Transport {
  "fetch"(url: string): Promise<TransportResponse>;
}

/** An open server-push subscription (long-poll/WS/SSE, one normative HTTP profile fixed at implementation, §9.4). */
export interface StreamSubscription {
  close(): void;
}

export interface StreamTransport {
  connect(url: string, onMessage: (raw: string) => void, onError: (error: unknown) => void): StreamSubscription;
}

export interface Clock {
  now(): Date;
}

/**
 * The declarative half of the facts-consistency seam (program §7.13,
 * design §12): the per-kind facts-profile *documents*. `client` reaches the
 * `facts/*` leaves that define these only through this types-only registry
 * port and the imperative `FactsRecompute` registry protocol already
 * exports (re-exported below) -- both are host-assembled and injected at
 * runtime (Task 18 note; `client` declares no `facts/*` package
 * dependency).
 */
export interface FactsProfileRegistry {
  get(kind: string): FactsProfileDocument | undefined;
}

export type { FactsRecompute, RecordFactRecompute, RecordFactValue, ReferencedBytes } from "@jinn-network/record-discovery-protocol";
