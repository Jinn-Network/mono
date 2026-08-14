/**
 * Forward-only checkpointed launch state machine for SolverNet creation.
 *
 * Spec: `spec/2026-05-05-solvernet-creation-and-launch.md` §10 (the launch
 * action) and §6.2 (the `LaunchedSolverNetRecord.launchProgress` shape).
 *
 * The five phases — each persisted to disk *before* the side effect runs —
 * give the daemon a recovery checkpoint at every boundary:
 *
 *   pinning      → upload canonical manifest JSON to IPFS
 *   recording    → atomic-write the launched record to disk with the cid
 *   broadcasting → submit IdentityRegistry.setMetadata tx
 *   confirming   → wait for tx receipt (or detect anchored event in subgraph)
 *   spawning     → finalize (Wave-4 D3 retired the generator spawn this phase
 *                  used to drive; the phase name stays because it is part of
 *                  the persisted `launchProgress` vocabulary that older
 *                  records may still carry)
 *   → status: 'launched', launchProgress: undefined
 *
 * Idempotency invariants (per spec §10):
 *
 *   - IPFS pin: same canonical body → same cid (content-addressed). Re-pinning
 *     is free and produces no protocol-level duplicate.
 *   - setMetadata: event-only, harmless to re-fire — most-recent-wins
 *     resolver picks the latest. We still avoid unnecessary re-broadcasts by
 *     scanning the subgraph for an existing event under the cid before
 *     re-firing.
 *   - Disk write: atomic-rename via the SolverNetStore.
 *
 * Architectural choice: the state machine takes ipfs / publisher / subgraph
 * directly (not the wrapped `SolverNetRegistryClient`). The registry client's
 * `publishManifest` collapses pin+broadcast into one call, which is
 * incompatible with the spec's per-phase checkpointing. By holding the
 * lower-level deps here we can place a disk checkpoint between every phase.
 *
 * The state machine never throws on caller-recoverable errors (broadcast
 * revert, mempool drop, RPC timeout). Instead, it persists `txError` to the
 * record and rethrows the error so the caller (launch UI / daemon scan) can
 * decide whether to retry. After `maxAttempts` failed attempts the record
 * flips to `status: 'failed'`; a manual reset to 'launching' + clear of
 * `txError` makes the record retryable again.
 */

import type { SolverNetManifestV1 } from '@jinn-network/sdk/solvernets';

import { manifestHash } from './manifest.js';
import {
  type IpfsClient,
  type MetadataPublisher,
  type SubgraphClient,
  encodeLifecyclePayload,
  LIFECYCLE_PAYLOAD_SCHEMA_VERSION,
  SOLVERNET_MANIFEST_KEY_PREFIX,
} from './registry-client-erc8004.js';
import type { SignerWithAgentEoa } from './registry-client.js';
import {
  type LaunchedSolverNetRecord,
  type SolverNetStore,
} from './store.js';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Default ceiling on retries before a record is marked `status: 'failed'`.
 * Tunable via `LaunchActionDeps.maxAttempts`.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

type LaunchPhase = NonNullable<LaunchedSolverNetRecord['launchProgress']>['phase'];

// ── Public interface ────────────────────────────────────────────────────────

export interface LaunchActionDeps {
  store: SolverNetStore;
  ipfs: IpfsClient;
  publisher: MetadataPublisher;
  subgraph: SubgraphClient;
  /**
   * Resolve a tx hash to a confirmed receipt. Implementations may poll an
   * RPC, watch logs, or wrap viem's `waitForTransactionReceipt`. Throwing is
   * the signal that the tx is missing from the mempool / chain — the state
   * machine then consults the subgraph before deciding to re-broadcast.
   */
  awaitTxConfirmation: (txHash: `0x${string}`) => Promise<{ blockNumber: number }>;
  now?: () => Date;
  maxAttempts?: number;
}

/**
 * Used by `recoverInFlightLaunches` to translate a record's
 * `launcherAgentId` into the in-process signer that owns it. In production
 * the daemon always runs a single launcher, so this is usually `() =>
 * theOnlySigner`. The interface keeps the door open for multi-launcher
 * daemons.
 */
export type ResolveSigner = (launcherAgentId: string) => Promise<SignerWithAgentEoa>;

// ── LaunchAction ────────────────────────────────────────────────────────────

export class LaunchAction {
  private readonly deps: LaunchActionDeps;
  private readonly now: () => Date;
  private readonly maxAttempts: number;

  constructor(deps: LaunchActionDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * Launch a new SolverNet from a signed manifest. Forward-only; advances
   * through pinning → recording → broadcasting → confirming → spawning.
   *
   * If a record with the same `solverNetId` already exists, the call is
   * delegated to `resume()` (idempotent): an already-`launched` record is
   * returned unchanged; an in-flight record continues from its checkpoint.
   *
   * Throws on side-effect failure (revert, RPC error, etc). The record on
   * disk reflects the failed phase + `txError`; the caller can either retry
   * via `resume(record)` or, after `maxAttempts`, mark the record as failed
   * and surface the error.
   */
  async launch(args: {
    manifest: SolverNetManifestV1;
    signer: SignerWithAgentEoa;
    /**
     * jinn-mono-jnr1: per-record runtime config from the wizard (cadence,
     * caps, allow/blocklists). Persisted onto the launched record so the
     * generator factory's `configRef` seeds with the operator's choice
     * instead of falling back to DEFAULTS. Optional — empty / undefined
     * means "use DEFAULTS for everything", which preserves the legacy
     * behaviour for callers that don't yet pass this through.
     */
    generatorConfig?: Record<string, unknown>;
  }): Promise<LaunchedSolverNetRecord> {
    if (args.signer.agentId !== args.manifest.launcher.agentId) {
      throw new Error(
        `signer.agentId (${args.signer.agentId}) does not match manifest.launcher.agentId (${args.manifest.launcher.agentId})`,
      );
    }

    // If a record already exists, fall through to resume — same idempotency
    // invariants apply.
    const existing = await this.deps.store.loadRecord(args.manifest.solverNetId);
    if (existing !== null) {
      return this.resume({ record: existing, signer: args.signer, manifest: args.manifest });
    }

    // Phase 1 — pinning. No record on disk yet; the cid is the only
    // information produced. We can re-pin freely (content-addressed).
    let manifestCid: string;
    try {
      manifestCid = await this.deps.ipfs.upload(args.manifest);
    } catch (err) {
      // No record yet, so nothing to checkpoint — surface the error and let
      // the caller retry the whole launch. (A repeat call is a fresh
      // launch() since no record was ever written.)
      throw err;
    }

    // Phase 2 — recording. Atomic-write the record before any on-chain side
    // effect. From here on, all retries flow through `resume()`.
    const manifestPath = await this.deps.store.writeManifestCache(
      manifestCid,
      args.manifest,
    );
    const initialRecord: LaunchedSolverNetRecord = {
      schemaVersion: 'solvernet.launched.v1',
      solverNetId: args.manifest.solverNetId,
      manifestCid,
      manifestPath,
      manifestHash: manifestHash(args.manifest),
      launcherAgentId: args.signer.agentId,
      launcherSafeAddress: args.manifest.launcher.safeAddress,
      launchedAt: this.now().toISOString(),
      status: 'launching',
      statusUpdatedAt: this.now().toISOString(),
      generatorEnabled: true,
      // jinn-mono-jnr1: persist the wizard's generatorConfig so the daemon's
      // generator factory's configRef seeds with the operator's choice on
      // the next restart, not the DEFAULTS.
      ...(args.generatorConfig !== undefined && {
        generatorConfig: args.generatorConfig,
      }),
      registry: {},
      launchProgress: { phase: 'broadcasting', attemptCount: 0 },
    };
    await this.deps.store.writeRecord(initialRecord);

    return this.resume({ record: initialRecord, signer: args.signer, manifest: args.manifest });
  }

  /**
   * Resume an in-flight launch from its current checkpoint. Safe to call
   * multiple times for the same record; idempotent under the invariants in
   * the module-level docblock.
   */
  async resume(args: {
    record: LaunchedSolverNetRecord;
    signer: SignerWithAgentEoa;
    /**
     * The manifest body. Required only for resume paths that may need to
     * re-pin (none currently — recording is the first checkpoint that
     * carries a cid). Carried through so future phases can re-canonicalize
     * if needed.
     */
    manifest?: SolverNetManifestV1;
  }): Promise<LaunchedSolverNetRecord> {
    let record = args.record;

    // Already-terminal status: nothing to do.
    if (record.status === 'launched') {
      return record;
    }
    if (record.status === 'paused' || record.status === 'retired') {
      // Lifecycle transitions are handled by a separate state machine; the
      // launch state machine is not authoritative here. Return the record
      // as-is; callers should not be asking us to launch a paused/retired
      // record.
      return record;
    }
    if (record.status === 'failed') {
      throw new Error(
        `launch is in 'failed' state (cid=${record.manifestCid}); caller must reset status to 'launching' and clear launchProgress.txError before retrying`,
      );
    }

    // Loop forward through phases. Most paths advance monotonically
    // (broadcasting → confirming → spawning → launched), but the
    // mempool-drop recovery in `runConfirmingPhase` may bounce back to
    // 'broadcasting'. The loop exits when status flips terminal or a
    // phase function throws.
    //
    // Bound the loop generously — the only way to re-enter a phase is via
    // mempool-drop re-broadcast, which is itself bounded by
    // `attemptCount >= maxAttempts`.
    const maxIterations = (this.maxAttempts + 1) * 5;
    for (let i = 0; i < maxIterations; i += 1) {
      const phase: LaunchPhase | undefined = record.launchProgress?.phase;
      if (phase === undefined) break; // launchProgress cleared = launched

      if (phase === 'pinning' || phase === 'recording') {
        // 'pinning' and 'recording' phases are conceptual checkpoints in
        // the spec, but the current `launch()` entry point never persists
        // a record at these phases — pinning runs before any disk write,
        // and the first persisted record already carries the cid (so the
        // record IS the recording-phase output). If a caller hands us a
        // record stuck in either phase, surface a clear error so they
        // re-call launch() with the original manifest.
        throw new Error(
          `cannot resume from phase '${phase}': the launch() entry point does not persist this phase. Re-call launch() with the original manifest instead.`,
        );
      }
      if (phase === 'broadcasting') {
        record = await this.runBroadcastingPhase(record, args.signer);
        continue;
      }
      if (phase === 'confirming') {
        record = await this.runConfirmingPhase(record, args.signer);
        continue;
      }
      if (phase === 'spawning') {
        record = await this.runSpawningPhase(record);
        continue;
      }

      // Exhaustive-check: if a new phase appears, fail loudly.
      const _exhaustive: never = phase;
      throw new Error(`unknown launch phase: ${String(_exhaustive)}`);
    }

    return record;
  }

  // ── Phase implementations ───────────────────────────────────────────────

  /**
   * Phase 3 — broadcasting. Submit setMetadata; capture txHash. Persist the
   * record at `confirming` *with* the txHash before returning.
   *
   * Pre-broadcast guard: scan the subgraph for an existing event under this
   * cid. If one exists, the broadcast already happened (possibly in a prior
   * crash that lost the txHash) — short-circuit straight to confirming.
   */
  private async runBroadcastingPhase(
    record: LaunchedSolverNetRecord,
    signer: SignerWithAgentEoa,
  ): Promise<LaunchedSolverNetRecord> {
    // Idempotency check: did a prior broadcast already land?
    const existingEvents = await this.deps.subgraph.fetchSetMetadataEventsForCid({
      manifestCid: record.manifestCid,
    });
    if (existingEvents.length > 0) {
      const latestForCid = pickLatest(existingEvents);
      const advanced: LaunchedSolverNetRecord = {
        ...record,
        registry: {
          ...record.registry,
          metadataBlockNumber: latestForCid.blockNumber,
        },
        statusUpdatedAt: this.now().toISOString(),
        launchProgress: { phase: 'spawning', attemptCount: 0 },
      };
      await this.deps.store.writeRecord(advanced);
      return advanced;
    }

    // Persist the attempt-bump *before* the side effect — if we crash
    // mid-broadcast the next resume sees the higher attemptCount.
    const attemptCount = (record.launchProgress?.attemptCount ?? 0) + 1;
    const checkpointing: LaunchedSolverNetRecord = {
      ...record,
      launchProgress: { phase: 'broadcasting', attemptCount },
    };
    await this.deps.store.writeRecord(checkpointing);

    const lifecycle = {
      schemaVersion: LIFECYCLE_PAYLOAD_SCHEMA_VERSION,
      status: 'launched' as const,
      at: this.now().toISOString(),
      hash: record.manifestHash,
    };

    let txHash: `0x${string}`;
    try {
      const result = await this.deps.publisher.setMetadata({
        signer,
        agentId: record.launcherAgentId,
        key: `${SOLVERNET_MANIFEST_KEY_PREFIX}${record.manifestCid}`,
        value: encodeLifecyclePayload(lifecycle),
      });
      txHash = result.txHash;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed: LaunchedSolverNetRecord = {
        ...checkpointing,
        launchProgress: {
          phase: 'broadcasting',
          attemptCount,
          txError: { message, at: this.now().toISOString() },
        },
        status: attemptCount >= this.maxAttempts ? 'failed' : 'launching',
        statusUpdatedAt: this.now().toISOString(),
      };
      await this.deps.store.writeRecord(failed);
      throw err;
    }

    const advanced: LaunchedSolverNetRecord = {
      ...checkpointing,
      registry: {
        ...checkpointing.registry,
        metadataTxHash: txHash,
      },
      statusUpdatedAt: this.now().toISOString(),
      launchProgress: { phase: 'confirming', txHash, attemptCount },
    };
    await this.deps.store.writeRecord(advanced);
    return advanced;
  }

  /**
   * Phase 4 — confirming. Wait for the receipt for the recorded txHash.
   *
   * If the tx is missing from the mempool / chain, fall back to the
   * subgraph: if the cid has a setMetadata event, treat as confirmed (block
   * number from the event); otherwise re-broadcast.
   */
  private async runConfirmingPhase(
    record: LaunchedSolverNetRecord,
    signer: SignerWithAgentEoa,
  ): Promise<LaunchedSolverNetRecord> {
    const txHash = record.launchProgress?.txHash;
    if (!txHash) {
      throw new Error(
        `internal: 'confirming' phase reached for cid ${record.manifestCid} without a txHash`,
      );
    }

    let blockNumber: number | undefined;
    try {
      const receipt = await this.deps.awaitTxConfirmation(txHash);
      blockNumber = receipt.blockNumber;
    } catch (rpcErr) {
      // Receipt missing — could be mempool-dropped, RPC stale, or tx pruned
      // before we polled. Consult the subgraph as the authoritative
      // "anchored on chain" source.
      const events = await this.deps.subgraph.fetchSetMetadataEventsForCid({
        manifestCid: record.manifestCid,
      });
      if (events.length > 0) {
        // Anchored: take the block number from the latest matching event.
        const latest = pickLatest(events);
        blockNumber = latest.blockNumber;
      } else {
        // Genuinely dropped — re-broadcast on the next loop iteration. We
        // reset to 'broadcasting' (not 'failed') and let the resume loop
        // pick it up. attemptCount carries over from the prior phase so
        // the broadcast retry budget is shared.
        const attemptCount = (record.launchProgress?.attemptCount ?? 0);
        const requeued: LaunchedSolverNetRecord = {
          ...record,
          registry: { ...record.registry, metadataTxHash: undefined },
          launchProgress: { phase: 'broadcasting', attemptCount },
          statusUpdatedAt: this.now().toISOString(),
        };
        await this.deps.store.writeRecord(requeued);
        // We deliberately do NOT throw here — the resume loop will pick up
        // the requeued record and re-enter `runBroadcastingPhase`.
        // Reference signer to satisfy noUnusedParameters strictness on
        // edited tooling configurations.
        void signer;
        return requeued;
      }
    }

    const advanced: LaunchedSolverNetRecord = {
      ...record,
      registry: {
        ...record.registry,
        metadataBlockNumber: blockNumber,
      },
      statusUpdatedAt: this.now().toISOString(),
      launchProgress: { phase: 'spawning', attemptCount: 0 },
    };
    await this.deps.store.writeRecord(advanced);
    return advanced;
  }

  /**
   * Phase 5 — spawning. Finalize the record: clear `launchProgress`, flip
   * `status` to 'launched', stamp `statusUpdatedAt`.
   *
   * Wave-4 D3 removed the generator spawn this phase used to perform: the
   * launched-record generators and the creator loop they fed are retired, so
   * there is nothing left to hand the record to and nothing left to fail. The
   * phase itself stays because `launchProgress.phase` is a persisted enum
   * (`client/src/solvernets/store.ts`) and a record written by an older daemon
   * generation can still be sitting at `spawning` on disk — that record must
   * resume to `launched`, not error.
   */
  private async runSpawningPhase(
    record: LaunchedSolverNetRecord,
  ): Promise<LaunchedSolverNetRecord> {
    const finalRecord: LaunchedSolverNetRecord = {
      ...record,
      status: 'launched',
      statusUpdatedAt: this.now().toISOString(),
    };
    delete (finalRecord as { launchProgress?: unknown }).launchProgress;
    await this.deps.store.writeRecord(finalRecord);
    return finalRecord;
  }
}

// ── Crash-resume on daemon startup ──────────────────────────────────────────

/**
 * Scan the launched-records directory and resume any record whose
 * `status === 'launching'`. Returns counts of successful resumes and any
 * per-record errors (so a single broken record cannot block daemon startup).
 *
 * Daemons should call this once at boot, before starting the generator
 * loops — Task 12 wires the call site.
 */
export async function recoverInFlightLaunches(deps: LaunchActionDeps & {
  resolveSigner: ResolveSigner;
}): Promise<{
  resumed: number;
  failed: Array<{ solverNetId: string; error: Error }>;
}> {
  const records = await deps.store.loadOwnedRecords();
  const inFlight = records.filter((r) => r.status === 'launching');

  const action = new LaunchAction(deps);
  let resumed = 0;
  const failed: Array<{ solverNetId: string; error: Error }> = [];

  for (const record of inFlight) {
    try {
      const signer = await deps.resolveSigner(record.launcherAgentId);
      const advanced = await action.resume({ record, signer });
      if (advanced.status === 'launched') {
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

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Pick the event with the highest `(blockNumber, transactionIndex)` from a
 * non-empty array. Used for breaking ties when multiple setMetadata events
 * exist for the same cid.
 */
function pickLatest<E extends { blockNumber: number; transactionIndex: number }>(
  events: E[],
): E {
  return events.reduce((acc, cur) => {
    if (cur.blockNumber !== acc.blockNumber) {
      return cur.blockNumber > acc.blockNumber ? cur : acc;
    }
    return cur.transactionIndex > acc.transactionIndex ? cur : acc;
  });
}
