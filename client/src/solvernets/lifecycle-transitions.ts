/**
 * Forward-only checkpointed lifecycle-transition state machine for SolverNets.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` §10 (post-launch
 * dashboard), §11 (generator ownership), and Decision 11 in §17 (lifecycle
 * action surface = Pause + Resume + Retire).
 *
 * Two phases — simpler than the launch state machine because the manifest
 * itself is already pinned and immutable. Every transition is a single
 * `IdentityRegistry.setMetadata` write under the existing
 * `solvernet-manifest:<cid>` key:
 *
 *   broadcasting → submit setMetadata(target) tx
 *   confirming   → wait for tx receipt (or detect anchored event in subgraph)
 *   → status: <target>, lifecycleProgress: undefined, generator side-effect
 *
 * Side effects fire AFTER the on-chain anchor lands, so a daemon that crashes
 * mid-transition recovers a consistent (status, generator-state) pair on
 * resume.
 *
 *   target = 'paused' | 'retired'  → stopGenerator
 *   target = 'launched' (resume)   → startGenerator
 *
 * State transitions allowed (precondition: record.status):
 *
 *   launched → paused
 *   launched → retired
 *   paused   → launched
 *   paused   → retired
 *   retired  → ANY  → reject (terminal — relaunch with a new SolverNet)
 *
 * Idempotency invariants:
 *
 *   - record.status === target → no-op, returns the record unchanged.
 *   - lifecycleProgress.target === call target → resume from checkpoint.
 *   - lifecycleProgress.target !== call target → reject; one transition in
 *     flight at a time per record.
 *   - setMetadata is event-only on chain; re-firing is harmless because the
 *     most-recent-wins resolver picks the latest matching event.
 *
 * Mempool-drop edge case mirrors the launch state machine: if `txHash` is set
 * and the receipt is missing, consult the subgraph for a setMetadata event
 * matching this `(cid, target)` tuple. An event whose payload status equals
 * the target is treated as anchored; otherwise re-broadcast.
 */

import type { SubgraphClient } from './registry-client-erc8004.js';
import type {
  SignerWithAgentEoa,
  SolverNetRegistryClient,
} from './registry-client.js';
import type { SetMetadataEvent } from './most-recent-wins.js';
import type {
  LaunchedSolverNetRecord,
  SolverNetStore,
} from './store.js';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Default ceiling on retries before a record's status flips to `'failed'`.
 * Tunable via `LifecycleTransitionDeps.maxAttempts`.
 */
export const DEFAULT_LIFECYCLE_MAX_ATTEMPTS = 5;

type LifecyclePhase = NonNullable<LaunchedSolverNetRecord['lifecycleProgress']>['phase'];
type LifecycleTarget = NonNullable<LaunchedSolverNetRecord['lifecycleProgress']>['target'];

// ── Public interface ────────────────────────────────────────────────────────

export interface LifecycleTransitionDeps {
  store: SolverNetStore;
  registry: SolverNetRegistryClient;
  /**
   * Signer for the launcher's agent EOA. The state machine is single-launcher
   * by construction (one daemon owns one record); cross-launcher recovery is
   * not in scope.
   */
  signer: SignerWithAgentEoa;
  /**
   * Subgraph used for the "already-anchored" recovery path: when `txHash` is
   * set but the receipt is missing, scan for a matching setMetadata event
   * before deciding to re-broadcast.
   */
  subgraph: SubgraphClient;
  /**
   * Resolve a tx hash to a confirmed receipt. Implementations may poll an
   * RPC, watch logs, or wrap viem's `waitForTransactionReceipt`. Throwing is
   * the signal that the tx is missing from the mempool / chain.
   */
  awaitTxConfirmation: (txHash: `0x${string}`) => Promise<{ blockNumber: number }>;
  startGenerator?: (record: LaunchedSolverNetRecord) => Promise<void>;
  stopGenerator?: (record: LaunchedSolverNetRecord) => Promise<void>;
  now?: () => Date;
  maxAttempts?: number;
}

// ── LifecycleTransition ─────────────────────────────────────────────────────

export class LifecycleTransition {
  private readonly deps: LifecycleTransitionDeps;
  private readonly now: () => Date;
  private readonly maxAttempts: number;

  constructor(deps: LifecycleTransitionDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_LIFECYCLE_MAX_ATTEMPTS;
  }

  /**
   * Drive a record toward the target lifecycle state. Forward-only;
   * advances through broadcasting → confirming → target.
   *
   * Pre-flight rejects are surfaced as throws (terminal/in-flight conflicts).
   * Idempotent no-ops (already-at-target) return the record unchanged.
   *
   * On side-effect failure (RPC revert, mempool drop, generator-spawn error),
   * persists the failed phase + `txError`, then rethrows. Caller may retry
   * via `resume()`.
   */
  async transition(
    record: LaunchedSolverNetRecord,
    target: LifecycleTarget,
  ): Promise<LaunchedSolverNetRecord> {
    // ── Pre-flight ────────────────────────────────────────────────────────
    if (record.status === 'retired') {
      // Allow re-call when target also = 'retired' so the outer caller can
      // be naive about idempotency.
      if (target === 'retired') return record;
      throw new Error(
        `cannot transition retired SolverNet ${record.solverNetId} to '${target}': retired is terminal; relaunch with a new SolverNet`,
      );
    }
    if (record.status === 'failed') {
      throw new Error(
        `cannot transition SolverNet ${record.solverNetId} from 'failed': caller must reset launch state first`,
      );
    }
    if (record.status === 'launching') {
      throw new Error(
        `cannot transition SolverNet ${record.solverNetId} from 'launching': complete the launch first`,
      );
    }

    // Already at target → no-op (true even when lifecycleProgress is set,
    // because the on-disk status flips synchronously with the final write
    // of the previous transition).
    if (record.status === target && record.lifecycleProgress === undefined) {
      return record;
    }

    // In-flight conflict: a previous transition is mid-broadcast for a
    // different target. One transition at a time per record (spec §10
    // post-launch dashboard).
    if (record.lifecycleProgress !== undefined && record.lifecycleProgress.target !== target) {
      throw new Error(
        `cannot start transition to '${target}' while a transition to '${record.lifecycleProgress.target}' is in flight for SolverNet ${record.solverNetId}`,
      );
    }

    // If we already have a checkpoint for this target, fall through to
    // resume(). If we don't, plant a fresh broadcasting checkpoint so the
    // first persisted state happens before any side effect.
    if (record.lifecycleProgress === undefined) {
      const checkpointed: LaunchedSolverNetRecord = {
        ...record,
        lifecycleProgress: { phase: 'broadcasting', target, attemptCount: 0 },
      };
      await this.deps.store.writeRecord(checkpointed);
      return this.runLoop(checkpointed);
    }

    return this.runLoop(record);
  }

  /**
   * Resume a record whose `lifecycleProgress` is set. Safe to call multiple
   * times; idempotent under the invariants above.
   *
   * If `lifecycleProgress` is undefined (no in-flight transition), returns
   * the record unchanged — the daemon's resume scan can call this on every
   * record without filtering.
   */
  async resume(record: LaunchedSolverNetRecord): Promise<LaunchedSolverNetRecord> {
    if (record.lifecycleProgress === undefined) {
      return record;
    }
    if (record.status === 'retired') {
      // Edge case: a retire-target transition completed (status flipped to
      // retired) but the lifecycleProgress write or generator side-effect
      // was lost. Fire the side-effect and clear progress so the record is
      // self-consistent.
      const cleared: LaunchedSolverNetRecord = { ...record };
      delete (cleared as { lifecycleProgress?: unknown }).lifecycleProgress;
      await this.deps.store.writeRecord(cleared);
      await this.fireGeneratorSideEffect(cleared, 'retired');
      return cleared;
    }
    return this.runLoop(record);
  }

  // ── Internal phase loop ─────────────────────────────────────────────────

  private async runLoop(record: LaunchedSolverNetRecord): Promise<LaunchedSolverNetRecord> {
    let current = record;

    // Bound the loop generously — confirming may bounce back to
    // broadcasting on mempool-drop, but only up to maxAttempts times.
    const maxIterations = (this.maxAttempts + 1) * 3;
    for (let i = 0; i < maxIterations; i += 1) {
      const phase: LifecyclePhase | undefined = current.lifecycleProgress?.phase;
      if (phase === undefined) break; // cleared progress → done

      if (phase === 'broadcasting') {
        current = await this.runBroadcastingPhase(current);
        continue;
      }
      if (phase === 'confirming') {
        current = await this.runConfirmingPhase(current);
        continue;
      }

      const _exhaustive: never = phase;
      throw new Error(`unknown lifecycle phase: ${String(_exhaustive)}`);
    }

    return current;
  }

  // ── Phase implementations ───────────────────────────────────────────────

  /**
   * Phase 1 — broadcasting. Submit publishLifecycleTransition; capture the
   * tx hash. Persist the record at `confirming` (with `txHash` set) before
   * returning so the next iteration can poll for the receipt.
   *
   * Pre-broadcast guard: if the subgraph already has a setMetadata event
   * for this `(cid, target)` tuple — i.e. an earlier broadcast landed but
   * we lost the txHash — short-circuit straight to confirmed.
   */
  private async runBroadcastingPhase(
    record: LaunchedSolverNetRecord,
  ): Promise<LaunchedSolverNetRecord> {
    const target = record.lifecycleProgress!.target;

    // Idempotency check: did a prior broadcast already anchor for this
    // target?
    const matchingEvent = await this.findMatchingEvent(record.manifestCid, target);
    if (matchingEvent !== null) {
      const finalized = await this.finalizeFromAnchoredEvent(record, matchingEvent);
      await this.fireGeneratorSideEffect(finalized, target);
      return finalized;
    }

    // Persist attemptCount bump *before* the side effect so a crash
    // mid-broadcast leaves the higher count visible to the next resume.
    const attemptCount = (record.lifecycleProgress?.attemptCount ?? 0) + 1;
    const checkpointing: LaunchedSolverNetRecord = {
      ...record,
      lifecycleProgress: { phase: 'broadcasting', target, attemptCount },
    };
    await this.deps.store.writeRecord(checkpointing);

    let txHash: `0x${string}`;
    try {
      const result = await this.deps.registry.publishLifecycleTransition({
        manifestCid: record.manifestCid,
        launcherAgentId: record.launcherAgentId,
        target,
        signer: this.deps.signer,
      });
      txHash = result.metadataTxHash;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed: LaunchedSolverNetRecord = {
        ...checkpointing,
        status: attemptCount >= this.maxAttempts ? 'failed' : record.status,
        statusUpdatedAt: this.now().toISOString(),
        lifecycleProgress: {
          phase: 'broadcasting',
          target,
          attemptCount,
          txError: { message, at: this.now().toISOString() },
        },
      };
      await this.deps.store.writeRecord(failed);
      throw err;
    }

    const advanced: LaunchedSolverNetRecord = {
      ...checkpointing,
      registry: { ...checkpointing.registry, metadataTxHash: txHash },
      lifecycleProgress: { phase: 'confirming', target, txHash, attemptCount },
    };
    await this.deps.store.writeRecord(advanced);
    return advanced;
  }

  /**
   * Phase 2 — confirming. Wait for the recorded txHash to confirm.
   *
   * Three resolution paths:
   *   1. Receipt found → finalize with that block number.
   *   2. Receipt missing AND subgraph has a matching event → finalize with
   *      the event's block number.
   *   3. Receipt missing AND subgraph has no matching event → re-broadcast.
   */
  private async runConfirmingPhase(
    record: LaunchedSolverNetRecord,
  ): Promise<LaunchedSolverNetRecord> {
    const progress = record.lifecycleProgress!;
    const target = progress.target;
    const txHash = progress.txHash;
    if (!txHash) {
      throw new Error(
        `internal: 'confirming' phase reached for cid ${record.manifestCid} without a txHash`,
      );
    }

    let blockNumber: number | undefined;
    try {
      const receipt = await this.deps.awaitTxConfirmation(txHash);
      blockNumber = receipt.blockNumber;
    } catch {
      // Receipt missing — fall back to subgraph for the same `(cid,
      // target)` tuple.
      const matchingEvent = await this.findMatchingEvent(record.manifestCid, target);
      if (matchingEvent !== null) {
        blockNumber = matchingEvent.blockNumber;
      } else {
        // Genuinely dropped — requeue at broadcasting. Carry attemptCount
        // forward so the broadcast retry budget is shared across the
        // (broadcasting, confirming) bounce.
        const attemptCount = progress.attemptCount;
        const requeued: LaunchedSolverNetRecord = {
          ...record,
          registry: { ...record.registry, metadataTxHash: undefined },
          lifecycleProgress: { phase: 'broadcasting', target, attemptCount },
          statusUpdatedAt: this.now().toISOString(),
        };
        await this.deps.store.writeRecord(requeued);
        return requeued;
      }
    }

    const finalized = await this.finalizeAtTarget(record, target, blockNumber);
    await this.fireGeneratorSideEffect(finalized, target);
    return finalized;
  }

  // ── Finalization helpers ────────────────────────────────────────────────

  /**
   * Flip the record to `status: <target>`, clear `lifecycleProgress`, write
   * the new metadata block number. The generator side effect is the
   * caller's responsibility (so we can fire it after the disk write lands).
   */
  private async finalizeAtTarget(
    record: LaunchedSolverNetRecord,
    target: LifecycleTarget,
    metadataBlockNumber: number,
  ): Promise<LaunchedSolverNetRecord> {
    const finalized: LaunchedSolverNetRecord = {
      ...record,
      status: target,
      statusUpdatedAt: this.now().toISOString(),
      registry: {
        ...record.registry,
        metadataBlockNumber,
      },
    };
    delete (finalized as { lifecycleProgress?: unknown }).lifecycleProgress;
    await this.deps.store.writeRecord(finalized);
    return finalized;
  }

  /**
   * Same as `finalizeAtTarget` but sourced from a subgraph event (used when
   * the broadcasting phase finds an existing anchored event).
   */
  private async finalizeFromAnchoredEvent(
    record: LaunchedSolverNetRecord,
    event: SetMetadataEvent,
  ): Promise<LaunchedSolverNetRecord> {
    return this.finalizeAtTarget(
      record,
      event.payload.status,
      event.blockNumber,
    );
  }

  // ── Side effects ────────────────────────────────────────────────────────

  /**
   * Fire the start/stop generator callback corresponding to the target. We
   * call the callbacks AFTER the on-chain anchor lands and the disk write
   * succeeds — so a generator-spawn failure does NOT roll back the
   * lifecycle state. The daemon can retry generator-spawn separately.
   *
   * Errors from the callback are rethrown so the caller can surface them;
   * the lifecycle record itself is already at the target status by the
   * time we call this.
   */
  private async fireGeneratorSideEffect(
    record: LaunchedSolverNetRecord,
    target: LifecycleTarget,
  ): Promise<void> {
    if (target === 'paused' || target === 'retired') {
      if (this.deps.stopGenerator) {
        await this.deps.stopGenerator(record);
      }
      return;
    }
    if (target === 'launched') {
      if (this.deps.startGenerator) {
        await this.deps.startGenerator(record);
      }
      return;
    }
    const _exhaustive: never = target;
    throw new Error(`unknown lifecycle target: ${String(_exhaustive)}`);
  }

  // ── Subgraph helpers ────────────────────────────────────────────────────

  /**
   * Find the latest setMetadata event for `(cid, target)` — i.e. an event
   * whose payload status equals the target. Returns null when no matching
   * event is indexed.
   *
   * Why filter by target? A pause-in-flight scenario could have an existing
   * `launched` event from the original launch — that event is NOT evidence
   * the pause anchored. We must only treat events whose payload status
   * matches the in-flight target as "anchored".
   *
   * Tiebreak: among matching events, pick the one with the highest
   * `(blockNumber, transactionIndex)` so a re-broadcast scenario picks up
   * the most recent anchor.
   */
  private async findMatchingEvent(
    manifestCid: string,
    target: LifecycleTarget,
  ): Promise<SetMetadataEvent | null> {
    const events = await this.deps.subgraph.fetchSetMetadataEventsForCid({ manifestCid });
    const matching = events.filter((e) => e.payload.status === target);
    if (matching.length === 0) return null;
    return matching.reduce((acc, cur) => {
      if (cur.blockNumber !== acc.blockNumber) {
        return cur.blockNumber > acc.blockNumber ? cur : acc;
      }
      return cur.transactionIndex > acc.transactionIndex ? cur : acc;
    });
  }
}

// ── Crash-resume on daemon startup ──────────────────────────────────────────

/**
 * Scan the launched-records directory and resume any record whose
 * `lifecycleProgress` is set. Returns counts of successful resumes and any
 * per-record errors (so a single broken record cannot block daemon startup).
 *
 * Daemons should call this once at boot, after `recoverInFlightLaunches`,
 * before starting the generator loops.
 */
export async function recoverInFlightLifecycleTransitions(
  deps: LifecycleTransitionDeps,
): Promise<{
  resumed: number;
  failed: Array<{ solverNetId: string; error: Error }>;
}> {
  const records = await deps.store.loadOwnedRecords();
  const inFlight = records.filter((r) => r.lifecycleProgress !== undefined);

  const action = new LifecycleTransition(deps);
  let resumed = 0;
  const failed: Array<{ solverNetId: string; error: Error }> = [];

  for (const record of inFlight) {
    try {
      const advanced = await action.resume(record);
      // "Resumed" means the transition completed (lifecycleProgress
      // cleared). A still-in-flight record (e.g. mempool-drop bounce
      // didn't recover) is not counted.
      if (advanced.lifecycleProgress === undefined) {
        resumed += 1;
      }
    } catch (err) {
      failed.push({
        solverNetId: record.solverNetId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return { resumed, failed };
}
