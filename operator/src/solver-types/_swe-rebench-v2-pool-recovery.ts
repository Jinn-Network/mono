/**
 * Fresh-volume vetted-pool recovery for the swe-rebench-v2 generator (#957).
 *
 * A freshly-deployed operator has an empty disk: no `validated-pool.json`, so
 * the generator's admission gate hits `admission-required-no-data` and posts 0
 * tasks. The vetted pool was previously published to IPFS; we recover it via the
 * indexer (DR-2026-06-02 open-question #4, Option B — read the artifact ref via
 * a recent-task digest callback, not on-chain directly):
 *
 *   1. `getMostRecentTaskCidDigest(manifestCid)` → a recent task's
 *      on-chain `taskCidDigest`. Wave-4 D4 retired DiscoveryAPI; production
 *      no longer supplies this callback (recovery then returns `no-task`).
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

/**
 * Whether a recovery outcome is TERMINAL — i.e. retrying cannot help, so the
 * caller should latch permanently and never attempt recovery again:
 *
 *   - `recovered === true`        — done; the pool was written.
 *   - `local-pool-present`        — a local pool already exists; nothing to recover.
 *
 * All other outcomes (`no-task`, `no-ref`, `error:*`, `hash-mismatch`) are
 * TRANSIENT/retryable, so the caller must NOT latch on them (it retries under a
 * bounded cap instead):
 *   - `no-task` — a fresh SolverNet may not have posted its first task yet.
 *   - `no-ref` — the task's eligibility may not yet carry a vettedPoolRef.
 *   - `error:*` — the indexer / IPFS gateway may be having a transient blip.
 *   - `hash-mismatch` — the fetched artifact's hash didn't match the ref. This is
 *     SECURITY-rejected at write time (the bad artifact is NEVER written), and it
 *     can be transient: a corrupted IPFS-gateway response may fetch cleanly on a
 *     later attempt, or the launcher may re-publish a corrected ref that a later
 *     task carries. Retrying re-resolves the most-recent task's ref AND re-fetches
 *     from IPFS, so a corrected pool is picked up without a restart; the bounded
 *     retry cap prevents looping on a genuinely-bad ref.
 */
export function isTerminalRecoveryOutcome(result: RecoverVettedPoolResult): boolean {
  if (result.recovered) return true;
  return result.reason === 'local-pool-present';
}

export interface RecoverVettedPoolTaskDigest {
  taskCidDigest: string;
  taskId: string;
}

export interface RecoverVettedPoolDeps {
  stateDir: string;
  manifestCid: string;
  /**
   * Optional recent-task lookup. Wave-4 D4 retired DiscoveryAPI; production
   * omits this and recovery returns `no-task`. Tests inject a stub.
   */
  getMostRecentTaskCidDigest?: (manifestCid: string) => Promise<RecoverVettedPoolTaskDigest | null>;
  ipfsGatewayUrl: string;
  store: ValidatedPoolStore;
  /** Injected so tests can stub the IPFS round-trip; production passes `fetchFromIpfs`. */
  fetchFromIpfs: (gatewayUrl: string, cid: string) => Promise<unknown>;
}

export async function recoverVettedPoolFromNetwork(
  deps: RecoverVettedPoolDeps,
): Promise<RecoverVettedPoolResult> {
  const { stateDir: _stateDir, manifestCid, getMostRecentTaskCidDigest, ipfsGatewayUrl, store, fetchFromIpfs } = deps;
  void _stateDir; // reserved for symmetry with resolvePublishedVettedPool; store already binds stateDir

  try {
    // Never-overwrite guard: a local validated pool already present (operator
    // validated locally, or a prior recovery ran) → do not clobber it.
    const existing = await store.getScorableIds(EVAL_SEMANTICS_VERSION);
    if (existing !== null) {
      return { recovered: false, reason: 'local-pool-present' };
    }

    if (!getMostRecentTaskCidDigest) {
      return { recovered: false, reason: 'no-task' };
    }

    // 1) Most-recent task digest for the SolverNet.
    const recent = await getMostRecentTaskCidDigest(manifestCid);
    if (!recent) return { recovered: false, reason: 'no-task' };

    // 2) Reconstruct the IPFS task CID and fetch the task body. Lowercase the
    // digest defensively (NIT #7): the on-chain bytes32 is lowercase, but a
    // future uppercase-emitting indexer must not produce a wrong CID.
    const taskCid = `f01551220${recent.taskCidDigest.replace(/^0x/, '').toLowerCase()}`;
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
