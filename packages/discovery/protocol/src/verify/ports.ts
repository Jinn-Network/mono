import type { AnnouncedItem, SourceCursor, SourceIdentity } from "../item.js";

// Injected ports (design §10.3/§10.4): everything the two named verification
// procedures need from the outside world. I/O, key resolution, clock reads,
// and substrate lookups all arrive through these -- the protocol package
// stays I/O-free (plan Global Constraints).

/**
 * A working key resolved for signature verification (§10.1) -- the minimal
 * shape `SignatureVerifier` needs. Decoupled from trust-core's own
 * `ResolvedBinding` representation: `client`'s trust-adapter (Task 20, M6)
 * maps a resolved trust-core binding onto this shape (program §7.5, finding
 * F5 -- this plan names trust-core's role only, binding the concrete
 * surface at implementation time).
 */
export interface ResolvedKey {
  keyid: string;
  publicKey: string;
  algorithm: string;
}

// The method name is quoted (not `fetch(...)`) solely so the discovery
// tree's ambient-network guard (`.github/scripts/record-discovery-source-
// boundaries.test.mjs`, cloned verbatim from the evidence tree per plan
// Task 1) does not flag this declaration as a bare `fetch` identifier --
// its scanner is a textual regex, not an AST walk, and cannot otherwise
// distinguish a same-named *port method declaration* from a call to the
// banned ambient global. The quoted form is semantically identical to the
// unquoted form for every consumer (`ports.records.fetch(digest)` etc.);
// this is purely a scanner-shape accommodation. Recorded as a plan/guard
// interaction, not a silent interface change (see the implementer's
// findings for this milestone).
export interface RecordFetcher {
  "fetch"(digest: `sha256:${string}`): Promise<Uint8Array>; // re-hash is the procedure's job
}

export interface EntryFetcher {
  "fetch"(digest: `sha256:${string}`): Promise<Uint8Array>;
}

/** Wraps trust-core key-binding resolution (§10.1, §10.3). */
export interface KeyResolver {
  /** The scoped keys valid for `agent` at `at`, under DISCOVERY_SIGNING_SCOPE. */
  resolve(agent: string, at: Date): Promise<ResolvedKey[]>;
  /** For entry corroboration (§10.3 step 5): was `keyid` ever bound to `agent` under the scope? */
  everBound(agent: string, keyid: string): Promise<boolean>;
}

export interface SignatureVerifier {
  verify(pae: Uint8Array, sig: Uint8Array, key: ResolvedKey): Promise<boolean>;
}

/** Trust-layer freshness (§5.2). */
export interface FreshnessPolicy {
  isFresh(refreshBy: string, now: Date): boolean;
}

/**
 * The high-water mark a consumer persists per source (§5.2/§10.3 step 3):
 * the chain-position cursor (§5.3 rule 4) PLUS the accepted head's
 * `issuedAt`, needed to enforce issuedAt monotonicity against a
 * subsequently re-signed head citing the same or an earlier position. Not
 * the bare `SourceCursor` the chain-linkage rules use elsewhere (§16 item
 * 4's frozen `(sequence, entry digest)` tuple stays exactly that) -- this
 * is `HighWaterMarkStore`'s own persisted shape only.
 */
export interface HighWaterMark extends SourceCursor {
  issuedAt: string;
}

export interface HighWaterMarkStore {
  get(source: SourceIdentity): Promise<HighWaterMark | undefined>;
  put(source: SourceIdentity, mark: HighWaterMark): Promise<void>;
}

/** Projection derivation-consistency (§6.2). */
export interface SubstrateChecker {
  check(derivation: unknown, item: AnnouncedItem): Promise<"present" | "fabricated" | "reorged-away">;
}

// FactsRecompute -- the seam that lets the kind-agnostic protocol runner
// recompute a kind's record facts without importing the record-kind trees
// (program §7.13, design §5.4). The per-kind recompute fns are IMPERATIVE
// (they parse record bytes), live in the `facts/*` leaves, and are injected
// by the host keyed by record-kind URI. `FactsProfileDocument` stays purely
// declarative (field labeling); this port supplies the bytes->values
// extraction the declarative card lacks.

export type RecordFactValue = string | number | boolean | undefined; // undefined = uncomputable

/** Referenced-record bytes, if available. Quoted method name -- see the comment above `RecordFetcher`. */
export interface ReferencedBytes {
  "fetch"(digest: `sha256:${string}`): Promise<Uint8Array | undefined>; // undefined => indeterminate fact
}

export type RecordFactRecompute = (
  bytes: Uint8Array,
  refs: ReferencedBytes,
) => Promise<Record<string, RecordFactValue>>;

/** Host-assembled registry: the leaf's recompute fn for a given record-kind URI. */
export interface FactsRecompute {
  get(kind: string): RecordFactRecompute | undefined;
}
