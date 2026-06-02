/**
 * Fresh-volume vetted-pool recovery for the swe-rebench-v2 generator (#957).
 *
 * A freshly-deployed operator has an empty disk: no `validated-pool.json`, so
 * the generator's admission gate hits `admission-required-no-data` and posts 0
 * tasks. The vetted pool was previously published to IPFS; we recover it via the
 * indexer (DR-2026-06-02 open-question #4, Option B — read the artifact ref via
 * the DiscoveryAPI, not on-chain directly):
 *
 *   1. `discoveryApi.getMostRecentTaskCidDigest(manifestCid)` → a recent task's
 *      on-chain `taskCidDigest` (pure indexer/chain read; no IPFS in discovery).
 *   2. Reconstruct the IPFS task CID (`f01551220 + digestHexWithout0x`, the same
 *      derivation as `adapters/mech/adapter.ts`) and fetch the task body.
 *   3. Read the vetted-pool ref from the task's `eligibility.vettedPoolRef`
 *      (`VETTED_POOL_REF_ELIGIBILITY_KEY`).
 *   4. Fetch + parse the artifact at `ref.artifactCid`.
 *   5. SECURITY: verify `hashVettedPoolArtifact(artifact) === ref.artifactHash`.
 *      A mismatch is REJECTED — no file is written.
 *   6. Write the scorable entries into `validated-pool.json` via
 *      `ValidatedPoolStore.record`. After a successful recovery the generator's
 *      existing `resolvePublishedVettedPool` / pool-load path picks up the now-
 *      present `validated-pool.json`.
 *
 * Never-overwrite: if a local validated pool already exists for the current
 * `EVAL_SEMANTICS_VERSION`, recovery is a no-op (`local-pool-present`) — the same
 * "don't clobber newer local data" stance as `resolvePublishedVettedPool`'s
 * `validatedNewer` guard.
 *
 * Fail-closed: every external call is wrapped so any failure returns a structured
 * `{ recovered: false, reason }`. Recovery NEVER throws — it must fall through to
 * the existing `admission-required-no-data` path so a recovery failure can never
 * crash the generator tick.
 */

import {
  ValidatedPoolStore,
  EVAL_SEMANTICS_VERSION,
  vettedPoolArtifactRefFromEligibility,
  parseVettedPoolArtifact,
  hashVettedPoolArtifact,
  type ValidatedPoolEntry,
} from './_swe-rebench-v2-validated-pool.js';
import type { DiscoveryAPI } from '../discovery/types.js';

export interface RecoverVettedPoolResult {
  recovered: boolean;
  /**
   * Why recovery did not complete (only set when `recovered === false`):
   *   - `local-pool-present` — a local validated pool already exists; not clobbered.
   *   - `no-task` — the indexer reports no task for the manifest yet.
   *   - `no-ref` — the recovered task carries no `vettedPoolRef` eligibility.
   *   - `hash-mismatch` — the fetched artifact's hash did not match the ref (SECURITY).
   *   - `error:<msg>` — any external call failed (discovery / IPFS / parse).
   */
  reason?: string;
  /** Count of scorable entries written, on a successful recovery. */
  entriesRecovered?: number;
}

export interface RecoverVettedPoolDeps {
  stateDir: string;
  manifestCid: string;
  discoveryApi: DiscoveryAPI;
  ipfsGatewayUrl: string;
  store: ValidatedPoolStore;
  /** Injected so tests can stub the IPFS round-trip; production passes `fetchFromIpfs`. */
  fetchFromIpfs: (gatewayUrl: string, cid: string) => Promise<unknown>;
}

export async function recoverVettedPoolFromNetwork(
  deps: RecoverVettedPoolDeps,
): Promise<RecoverVettedPoolResult> {
  const { stateDir: _stateDir, manifestCid, discoveryApi, ipfsGatewayUrl, store, fetchFromIpfs } = deps;
  void _stateDir; // reserved for symmetry with resolvePublishedVettedPool; store already binds stateDir

  try {
    // Never-overwrite guard: a local validated pool already present (operator
    // validated locally, or a prior recovery ran) → do not clobber it.
    const existing = await store.getScorableIds(EVAL_SEMANTICS_VERSION);
    if (existing !== null) {
      return { recovered: false, reason: 'local-pool-present' };
    }

    // 1) Most-recent task digest for the SolverNet (pure indexer/chain read).
    const recent = await discoveryApi.getMostRecentTaskCidDigest(manifestCid);
    if (!recent) return { recovered: false, reason: 'no-task' };

    // 2) Reconstruct the IPFS task CID and fetch the task body.
    const taskCid = `f01551220${recent.taskCidDigest.replace(/^0x/, '')}`;
    const taskDoc = await fetchFromIpfs(ipfsGatewayUrl, taskCid);

    // 3) Read the vetted-pool ref from the task's eligibility.
    const eligibility = (taskDoc as { eligibility?: Record<string, unknown> } | null)?.eligibility;
    const ref = vettedPoolArtifactRefFromEligibility(eligibility);
    if (ref === null) return { recovered: false, reason: 'no-ref' };

    // 4) Fetch + parse the artifact.
    const rawArtifact = await fetchFromIpfs(ipfsGatewayUrl, ref.artifactCid);
    const artifact = parseVettedPoolArtifact(rawArtifact);

    // 5) SECURITY: verify the artifact hash against the ref before writing.
    if (hashVettedPoolArtifact(artifact) !== ref.artifactHash) {
      return { recovered: false, reason: 'hash-mismatch' };
    }

    // 6) Write the scorable entries into validated-pool.json. Record under the
    // artifact's evalSemanticsVersion so the generator's read path picks them up
    // for the matching version. Each artifact entry is scorable by construction.
    for (const entry of artifact.entries) {
      const poolEntry: ValidatedPoolEntry = {
        scorable: true,
        reason: entry.reason,
        checkedAt: entry.checkedAt,
        ...(entry.rowHash ? { rowHash: entry.rowHash } : {}),
        ...(entry.imageName ? { imageName: entry.imageName } : {}),
        ...(entry.imageDigest ? { imageDigest: entry.imageDigest } : {}),
        ...(entry.upstreamEvalCommit ? { upstreamEvalCommit: entry.upstreamEvalCommit } : {}),
      };
      await store.record(entry.instance_id, poolEntry, artifact.evalSemanticsVersion);
    }

    return { recovered: true, entriesRecovered: artifact.entries.length };
  } catch (err) {
    // Fail-closed: any failure (discovery, IPFS, parse) must NOT throw — return a
    // structured result so the generator falls through to admission-required-no-data.
    const message = err instanceof Error ? err.message : String(err);
    return { recovered: false, reason: `error:${message}` };
  }
}
