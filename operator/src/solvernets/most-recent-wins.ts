/**
 * Most-recent-wins resolver for SolverNet lifecycle events.
 *
 * Folds a stream of `IdentityRegistry.setMetadata` events with the
 * `solvernet-manifest:<cid>` key prefix into the current lifecycle status of
 * each unique (launcherAgentId, manifestCid) tuple.
 *
 * Per `spec/2026-05-05-solvernet-creation-and-launch.md` §6.3:
 *
 * > The most-recent-wins resolver picks the latest event per (agentId, cid)
 * > tuple. Lifecycle authenticity flows from `msg.sender == launcher's agent
 * > wallet` (enforced on-chain by IdentityRegistry's access control on
 * > `setMetadata`).
 *
 * Tiebreak rule: when two events share `blockNumber`, the one with the higher
 * `transactionIndex` wins (later in the block).
 *
 * Defensive: the resolver ignores any event whose `key` does not start with
 * `solvernet-manifest:`. The subgraph fetcher should already filter, but the
 * resolver does not trust upstream blindly.
 *
 * NOTE: this helper lives at `operator/src/solvernets/most-recent-wins.ts` for
 * now. Spec §6.3 references `operator/src/network-trust/most-recent-wins.ts`,
 * but `operator/src/network-trust/` does not exist on this branch (it ships on
 * `opus/network-trust-v0`). When that branch merges, consolidate.
 */

const KEY_PREFIX = 'solvernet-manifest:';

/**
 * Decoded payload of a single `IdentityRegistry.setMetadata` event whose key
 * is `solvernet-manifest:<cid>`. The shape mirrors §6.3 of the spec.
 */
export interface SetMetadataLifecyclePayload {
  schemaVersion: string;
  status: 'launched' | 'paused' | 'retired';
  at: string;
  hash: `0x${string}`;
}

/**
 * Single setMetadata event row as supplied by the subgraph client.
 *
 * `key` is the full `solvernet-manifest:<cid>` string; `agentId` is the
 * `launcherAgentId`; `payload` is the already-decoded lifecycle payload (the
 * subgraph or registry client is responsible for JCS-decoding the bytes
 * before handing them to the resolver).
 */
export interface SetMetadataEvent {
  agentId: string;
  key: string;
  payload: SetMetadataLifecyclePayload;
  blockNumber: number;
  transactionIndex: number;
}

/**
 * One row of resolved current-state-per-(agentId, cid).
 *
 * `anchorTransactionIndex` is the in-block transaction index of the winning
 * setMetadata event — required as a secondary sort key when callers compare
 * across multiple resolved rows (e.g. cross-launcher tiebreaks for the same
 * cid, where two launchers wrote in the same block). Without it, the
 * cross-row comparison would be non-deterministic (Map insertion order).
 */
export interface ResolvedLifecycle {
  manifestCid: string;
  launcherAgentId: string;
  status: 'launched' | 'paused' | 'retired';
  statusUpdatedAt: string;
  manifestHash: `0x${string}`;
  anchorBlock: number;
  anchorTransactionIndex: number;
}

/**
 * Extract the `<cid>` portion of a `solvernet-manifest:<cid>` key. Returns
 * null if the key does not start with the expected prefix.
 */
function parseCid(key: string): string | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const cid = key.slice(KEY_PREFIX.length);
  return cid.length > 0 ? cid : null;
}

/**
 * Compare two events by recency. Returns true if `a` is more recent than
 * `b`. Higher `blockNumber` wins; ties broken by higher `transactionIndex`.
 */
function isMoreRecent(a: SetMetadataEvent, b: SetMetadataEvent): boolean {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber;
  return a.transactionIndex > b.transactionIndex;
}

/**
 * Fold a stream of setMetadata events into the current lifecycle status per
 * (launcherAgentId, manifestCid) tuple. See file header for semantics.
 *
 * Order of returned rows is not specified — callers that need a stable order
 * should sort by `manifestCid` (or another field) explicitly.
 */
export function resolveMostRecentWins(events: SetMetadataEvent[]): ResolvedLifecycle[] {
  // Map key: `${agentId}|${cid}` (cid is opaque base32/58, neither field
  // contains `|`, so the join is unambiguous).
  const latest = new Map<string, { event: SetMetadataEvent; cid: string }>();

  for (const event of events) {
    const cid = parseCid(event.key);
    if (cid === null) continue;

    const tupleKey = `${event.agentId}|${cid}`;
    const existing = latest.get(tupleKey);
    if (existing === undefined || isMoreRecent(event, existing.event)) {
      latest.set(tupleKey, { event, cid });
    }
  }

  const out: ResolvedLifecycle[] = [];
  for (const { event, cid } of latest.values()) {
    out.push({
      manifestCid: cid,
      launcherAgentId: event.agentId,
      status: event.payload.status,
      statusUpdatedAt: event.payload.at,
      manifestHash: event.payload.hash,
      anchorBlock: event.blockNumber,
      anchorTransactionIndex: event.transactionIndex,
    });
  }
  return out;
}
