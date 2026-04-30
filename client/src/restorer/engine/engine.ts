/**
 * Restorer engine — main RestorationEngine class.
 *
 * §6.3, §6.5 of spec/2026-04-17-portfolio-v0-design.md
 *
 * Orchestrates the state machine lifecycle for each observed intent.
 * Transition method bodies are stubs; subsequent tasks fill them in.
 */

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IntentPersistence, type PersistedIntent, type PersistedIntentInput } from './persistence.js';
import { IntentState, MissingEvidenceHashError } from './state.js';
import type { Store } from '../../store/store.js';
import {
  executeTwoLayerClaim,
  releaseClaimedNotStarted,
  type MarketplaceClaimer,
} from './claim.js';
import type { ClaimRegistryClient } from '../../adapters/claim-registry/client.js';
import {
  provisionWorkingDir,
  provisionImplStateDir,
  walkArtifacts,
  uploadArtifacts,
  type PackagingDeps,
} from './packaging.js';
import {
  assembleAndSignEnvelope,
  type EnvelopeAssemblyDeps,
  type EnvelopeInputs,
} from './envelope-assembly.js';
import {
  deliverAndClaim,
  type DeliveryDeps,
} from './delivery.js';
import type { RestorerImpl, RestorationOutput } from '../types.js';
import { SkippableError } from '../types.js';
import type {
  ExecutionPayload,
  ExecutionTier,
  IdentityPublisher,
  ReputationRegistryClient,
  EvaluatorVerdict,
  FeedbackHookOutcome,
  ResolvedAgent,
} from '../../erc8004/index.js';
import { submitEvaluatorFeedback } from '../../erc8004/index.js';
import type { Role } from '../../types/envelope.js';
import { TrajectoryCollector, emitTrajectory } from '../../trajectory/index.js';
import { buildInfo } from '../../build-info.js';

// ── Sentinel error ────────────────────────────────────────────────────────────

export class NotImplementedError extends Error {
  readonly transitionName: string;

  constructor(transitionName: string) {
    super(`[NotImplemented] ${transitionName} — fill in via subsequent task`);
    this.name = 'NotImplementedError';
    this.transitionName = transitionName;
  }
}

// ── Registry types ────────────────────────────────────────────────────────────

/**
 * Resolves a `RestorerImpl` for a given spec kind (and optional type), or
 * returns `undefined` when nothing is registered/enabled.
 *
 * The engine only needs `findFor` — `resolveImplName` was a redundant alias
 * for `findFor(...)?.name` and was removed under jinn-mono-qip (supersedes
 * jinn-mono-cy4). Concrete implementation lives in
 * `restorer/engine/registry.ts` (`RestorerImplRegistry`).
 */
export interface ImplRegistry {
  findFor(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): RestorerImpl | undefined;
}

// ── Engine options ────────────────────────────────────────────────────────────

export interface RestorationEngineOptions {
  store: Store;
  paths: {
    workingDirRoot: string;
    implStateDirRoot: string;
  };
  /**
   * Injected claim dependencies. When provided, engine.claim() is functional.
   * When absent, claim() falls back to NotImplementedError (useful for tests
   * that don't exercise the claim path).
   */
  claimDeps?: {
    registryClient: ClaimRegistryClient;
    marketplaceClaimer: MarketplaceClaimer;
  };
  /**
   * Packaging dependencies. When provided, pack() is functional.
   * When absent, pack() falls back to NotImplementedError.
   */
  packagingDeps?: PackagingDeps;
  /**
   * Envelope assembly dependencies. When provided, pack() can assemble + sign.
   * When absent, pack() falls back to NotImplementedError.
   *
   * Replaces the old `manifestDeps` (ManifestAssemblyDeps). The safeAddress
   * field that was on ManifestAssemblyDeps is now sourced from deliveryDeps
   * or passed directly in EnvelopeInputs.participant.
   */
  envelopeDeps?: EnvelopeAssemblyDeps & { safeAddress?: `0x${string}` };
  /**
   * Delivery dependencies. When provided, deliver() is functional.
   * When absent, deliver() falls back to NotImplementedError.
   */
  deliveryDeps?: DeliveryDeps;
  /**
   * Impl registry for resolving which RestorerImpl to run.
   * When provided and findFor() returns an impl, runImpl() dispatches to it.
   */
  implRegistry?: ImplRegistry;
  /**
   * ERC-8004 Identity Registry per-execution publisher (jinn-mono-3zk).
   * When provided, the engine calls
   *   `IdentityRegistry.setMetadata(agentId, "envelope:<cid>", v1Payload)`
   * after `pack()` returns the manifest CID + evidenceHash, anchoring the
   * execution under the operator's agent NFT (DR §4.2).
   *
   * Failures are logged but NEVER fatal — JinnRouter.claimDelivery(evidenceHash)
   * remains the authoritative on-chain commitment; this publish is the
   * discovery anchor.
   *
   * Optional — when absent, the engine simply skips publishing.
   */
  identityPublisher?: IdentityPublisher;
  /**
   * ERC-8004 ReputationRegistry feedback hook (jinn-mono-yg4).
   *
   * When provided, the engine fires `submitEvaluatorFeedback` after a
   * successful evaluator-side `claimDelivery`, so the restorer's agent NFT
   * accrues a rating per DR §4.3. Requires:
   *
   *   - `client`: a `ReputationRegistryClient` (writes are routed through the
   *     evaluator's Safe so `msg.sender` matches the operator identity).
   *   - `resolveAgentId`: looks up the restorer's `agentId` from the parent
   *     manifest's `evidenceHash`. Returns `null` when no match is found
   *     (subgraph not yet indexed; envelope not published) — the engine
   *     skips feedback gracefully without failing delivery.
   *
   * Failures inside the hook are logged but NEVER fatal: JinnRouter's
   * `claimDelivery` is the authoritative settlement. Restoration-only
   * intents skip this branch entirely.
   *
   * Optional — when absent, the engine simply skips feedback.
   */
  reputationFeedback?: {
    client: ReputationRegistryClient;
    resolveAgentId: (manifestHash: `0x${string}`) => Promise<ResolvedAgent | null>;
  };
}

// ── Recovery report ───────────────────────────────────────────────────────────

/** Per-intent outcome from a recovery pass. */
export interface RecoveryReport {
  requestId: string;
  outcome: 'ok' | 'failed';
  error?: string;
}

// ── RestorationEngine ─────────────────────────────────────────────────────────

export class RestorationEngine {
  protected readonly persistence: IntentPersistence;
  protected readonly paths: RestorationEngineOptions['paths'];
  protected readonly claimDeps: RestorationEngineOptions['claimDeps'];
  protected readonly packagingDeps: RestorationEngineOptions['packagingDeps'];
  protected readonly envelopeDeps: RestorationEngineOptions['envelopeDeps'];
  protected readonly deliveryDeps: RestorationEngineOptions['deliveryDeps'];
  protected readonly implRegistry: RestorationEngineOptions['implRegistry'];
  protected readonly identityPublisher: RestorationEngineOptions['identityPublisher'];
  protected readonly reputationFeedback: RestorationEngineOptions['reputationFeedback'];
  /** Local SQLite-backed store; used to emit `restoration-result` /
   *  `evaluation-verdict` artifact rows when a cycle completes via a
   *  deterministic impl (the legacy claude/MCP path writes them itself). */
  protected readonly store: Store;

  // Transient storage for impl output between runImpl and pack transitions.
  // Keyed by requestId; cleared after successful pack.
  private readonly implOutputs = new Map<string, RestorationOutput>();

  // Transient storage for trajectory collectors produced in runImpl.
  // emitTrajectory is deferred to pack() so that artifact spans can be added
  // before the trajectory is finalised and uploaded (Task 16 bidirectional linkage).
  // Keyed by requestId; cleared after successful pack.
  // Protected (not private) to allow test subclasses to inject collectors.
  protected readonly trajectoryCollectors = new Map<string, TrajectoryCollector>();

  // Transient storage for trajectory CID+sha256 refs produced by runImpl.
  // Keyed by requestId; cleared after successful pack.
  private readonly trajectoryRefs = new Map<string, { cid: string; sha256: string } | null>();

  /** Set by stop(); causes runTickLoop to exit at the next iteration. */
  private stopped = false;

  constructor(opts: RestorationEngineOptions) {
    this.persistence = new IntentPersistence(opts.store.db);
    this.store = opts.store;
    this.paths = opts.paths;
    this.claimDeps = opts.claimDeps;
    this.packagingDeps = opts.packagingDeps;
    this.envelopeDeps = opts.envelopeDeps;
    this.deliveryDeps = opts.deliveryDeps;
    this.implRegistry = opts.implRegistry;
    this.identityPublisher = opts.identityPublisher;
    this.reputationFeedback = opts.reputationFeedback;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Called when an intent is observed from an on-chain event.
   * Persists a DISCOVERED row. Idempotent: if the row already exists, no-op.
   */
  async observe(input: PersistedIntentInput): Promise<void> {
    const existing = this.persistence.getByRequestId(input.requestId);
    if (!existing) {
      this.persistence.insertDiscovered(input);
      console.log(`[restorer-engine] observed intent ${input.requestId} kind=${input.specKind ?? 'null'}`);
    }
  }

  /**
   * Recover all in-flight intents from persisted state.
   * Called at daemon startup before beginning normal event processing.
   * Returns a per-intent report for each intent attempted.
   */
  async recoverInFlight(): Promise<RecoveryReport[]> {
    const inflight = this.persistence.getInFlight();
    const results = await Promise.allSettled(
      inflight.map((intent) => this._recoverOne(intent)),
    );

    const reports: RecoveryReport[] = results.map((result, i) => {
      const requestId = inflight[i]!.requestId;
      if (result.status === 'fulfilled') {
        return { requestId, outcome: 'ok' as const };
      } else {
        const error = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        return { requestId, outcome: 'failed' as const, error };
      }
    });

    const okCount = reports.filter((r) => r.outcome === 'ok').length;
    console.log(`[restorer-engine] recovery: ${okCount}/${reports.length} intents resumed`);

    return reports;
  }

  /**
   * Periodic tick: advance every in-flight intent by one transition.
   * Called by `runTickLoop` so that intents which entered a non-event-driven
   * state (e.g. CLAIMED waiting for windowStartTs) get re-driven without
   * waiting for a daemon restart or a fresh marketplace event.
   *
   * Errors from individual intents are logged but do not stop the loop.
   */
  async tick(): Promise<void> {
    const inflight = this.persistence.getInFlight();
    const results = await Promise.allSettled(
      inflight.map((intent) => this.process(intent.requestId)),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === 'rejected') {
        const requestId = inflight[i]!.requestId;
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.warn(`[restorer-engine] tick: process(${requestId}) failed: ${reason}`);
      }
    }
  }

  /**
   * Drive `tick()` on a fixed interval until `stop()` is called.
   * Errors thrown by tick() itself are logged and do not stop the loop.
   */
  async runTickLoop(intervalMs: number): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err) {
        console.error('[restorer-engine] tick loop error (continuing):', err instanceof Error ? err.message : err);
      }
      if (this.stopped) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /** Signal `runTickLoop` to exit at the next iteration. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Process a single intent: dispatch by current state to the appropriate
   * transition. Drives one state transition per call.
   *
   * Called both by recovery and by the ongoing event-processing loop.
   */
  async process(requestId: string): Promise<void> {
    const intent = this.persistence.getByRequestId(requestId);
    if (!intent) {
      throw new Error(`process: intent not found: ${requestId}`);
    }

    switch (intent.state) {
      case IntentState.DISCOVERED:
        await this._runTransition(intent, () => this.claim(intent));
        break;

      case IntentState.CLAIMED: {
        // Advance to WAITING — persist-before-invoke principle.
        const oldState = intent.state;
        this.persistence.transition(intent.requestId, IntentState.WAITING);
        console.log(`[restorer-engine] ${requestId} ${oldState} → ${IntentState.WAITING}`);
        break;
      }

      case IntentState.WAITING: {
        const advance = this.dataDrivenAdvance(intent);
        if (advance !== null) {
          this.persistence.transition(intent.requestId, advance);
          console.log(`[restorer-engine] ${requestId} ${intent.state} → ${advance}`);
          await this._runTransition(
            this.persistence.getOrThrow(requestId),
            () => this.takePreSnapshot(this.persistence.getOrThrow(requestId)),
          );
          // takePreSnapshot transitions PRE_SNAPSHOT → RUNNING. Re-dispatch on
          // the post-transition state so RUNNING fires in the same pass (jinn-mono-sae).
          const after = this.persistence.getByRequestId(intent.requestId);
          if (after && after.state === IntentState.RUNNING) {
            await this.process(intent.requestId);
          }
        }
        // else: not yet time — caller is responsible for scheduling retry
        break;
      }

      case IntentState.PRE_SNAPSHOT: {
        const advance = this.dataDrivenAdvance(intent);
        if (advance !== null) {
          // Snapshot already captured (e.g. recovered from crash mid-transition)
          this.persistence.transition(intent.requestId, advance);
          console.log(`[restorer-engine] ${requestId} ${intent.state} → ${advance}`);
          await this._runTransition(
            this.persistence.getOrThrow(requestId),
            () => this.runImpl(this.persistence.getOrThrow(requestId)),
          );
        } else {
          await this._runTransition(intent, () => this.takePreSnapshot(intent));
          // takePreSnapshot transitions PRE_SNAPSHOT → RUNNING internally.
          // Re-dispatch on the post-transition state so the RUNNING case fires
          // in the same pass (jinn-mono-sae fix). Without this, intents stall
          // at RUNNING until the next tick/restart and runImpl never executes.
          const after = this.persistence.getByRequestId(intent.requestId);
          if (after && after.state === IntentState.RUNNING) {
            await this.process(intent.requestId);
          }
        }
        break;
      }

      case IntentState.RUNNING:
        await this._runTransition(intent, () => this.runImpl(intent));
        break;

      case IntentState.POST_SNAPSHOT: {
        const advance = this.dataDrivenAdvance(intent);
        if (advance !== null) {
          this.persistence.transition(intent.requestId, advance);
          console.log(`[restorer-engine] ${requestId} ${intent.state} → ${advance}`);
          await this._runTransition(
            this.persistence.getOrThrow(requestId),
            () => this.pack(this.persistence.getOrThrow(requestId)),
          );
        } else {
          await this._runTransition(intent, () => this.takePostSnapshot(intent));
        }
        break;
      }

      case IntentState.PACKAGING:
        await this._runTransition(intent, () => this.pack(intent));
        break;

      case IntentState.DELIVERING:
        await this._runTransition(intent, () => this.deliver(intent));
        break;

      case IntentState.COMPLETE:
      case IntentState.FAILED:
        // Terminal — nothing to do.
        break;
    }
  }

  // ── Transition stubs ────────────────────────────────────────────────────────
  // Stubs throw NotImplementedError. claim() is implemented here; others are
  // filled in by subsequent tasks.

  /**
   * Two-layer claim: ClaimRegistry + Marketplace.
   *
   * Idempotent on resume: checks ClaimRegistry for a pre-existing claim before
   * sending any on-chain transaction.
   *
   * Advances state DISCOVERED → CLAIMED on success.
   * Marks FAILED if either layer cannot be claimed.
   *
   * Requires claimDeps to be injected via constructor options. Falls back to
   * NotImplementedError if claimDeps is absent (development / test mode).
   */
  protected async claim(intent: PersistedIntent): Promise<void> {
    if (!this.claimDeps) {
      throw new NotImplementedError('claim');
    }

    // ── Pre-claim impl gate ─────────────────────────────────────────────────
    // Refuse to claim intents whose impl is either unregistered (operator has
    // opted out via config.restorers.disabled[]) or not ready (external deps
    // missing — e.g. HL api-wallet not approved for portfolio.v0). Marking
    // FAILED is terminal so we don't re-attempt; another operator can still
    // claim from the marketplace.
    //
    // Only fires when an implRegistry is wired in (production); tests that
    // inject claimDeps without a registry intentionally exercise the raw
    // claim path and are not gated.
    if (this.implRegistry && intent.specKind) {
      const impl = this.implRegistry.findFor({
        kind: intent.specKind,
        type: intent.intentType ?? 'restoration',
      });
      if (!impl) {
        const reason = `no impl registered or enabled for kind '${intent.specKind}'; run \`jinn intents enable ${intent.specKind}\` to opt in`;
        this.persistence.markFailed(intent.requestId, reason);
        console.log(`[restorer-engine] ${intent.requestId}: skipping claim — ${reason}`);
        throw new Error(reason);
      }
      if (impl.isReady) {
        const status = await impl.isReady();
        if (!status.ready) {
          const reason = `impl '${impl.name}' not ready: ${status.reason ?? 'unknown'}${status.nextStep?.cli ? ` — run \`${status.nextStep.cli}\`` : ''}`;
          this.persistence.markFailed(intent.requestId, reason);
          console.log(`[restorer-engine] ${intent.requestId}: skipping claim — ${reason}`);
          throw new Error(reason);
        }
      }
    }

    const { registryClient, marketplaceClaimer } = this.claimDeps;

    await executeTwoLayerClaim(
      {
        requestId: intent.requestId,
        windowStartTs: intent.windowStartTs,
      },
      registryClient,
      marketplaceClaimer,
    );

    // Both layers succeeded. The event path and tick loop can race on the same
    // DISCOVERED row; if another caller already advanced it, treat this claim as
    // idempotent and do not rewind or fail the intent.
    const current = this.persistence.getByRequestId(intent.requestId);
    if (!current) {
      throw new Error(`claim: intent not found after claim: ${intent.requestId}`);
    }
    if (current.state === IntentState.DISCOVERED) {
      this.persistence.transition(intent.requestId, IntentState.CLAIMED);
    } else {
      console.log(
        `[restorer-engine] ${intent.requestId}: claim completed but state is already ${current.state}; skipping CLAIMED transition`,
      );
    }
  }

  /**
   * Release ClaimRegistry claims for all CLAIMED intents whose work window has
   * not yet started. Called on graceful engine shutdown.
   *
   * Returns the list of requestIds that were successfully released.
   */
  async releaseClaimedNotStarted(): Promise<string[]> {
    if (!this.claimDeps) {
      return []; // No registry client — nothing to release
    }

    const claimed = this.persistence.getByState(IntentState.CLAIMED);
    const released: string[] = [];

    for (const intent of claimed) {
      if (Date.now() < intent.windowStartTs) {
        try {
          const ok = await releaseClaimedNotStarted(
            {
              requestId: intent.requestId,
              windowStartTs: intent.windowStartTs,
            },
            this.claimDeps.registryClient,
          );
          if (ok) {
            released.push(intent.requestId);
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.error(
            `[restorer-engine] releaseClaimedNotStarted failed for ${intent.requestId}: ${reason}`,
          );
        }
      }
    }

    if (released.length > 0) {
      console.log(
        `[restorer-engine] released ${released.length} pre-window claim(s) on shutdown: ${released.join(', ')}`,
      );
    }

    return released;
  }

  /**
   * PRE_SNAPSHOT transition: provision workingDir + implStateDir, write
   * intent.json + env/ files, create sessions/ directory.
   *
   * Requires no external deps beyond filesystem access — always implemented.
   * Advances state PRE_SNAPSHOT with workingDir + implStateDir patch.
   */
  protected async takePreSnapshot(intent: PersistedIntent): Promise<void> {
    const workingDir = join(this.paths.workingDirRoot, intent.requestId);
    // Resolve the impl via registry so implStateDir matches the path runImpl uses
    // (join(implStateDirRoot, impl.name, kind)). Falls back to specKind then 'default'
    // when no impl is registered — legacy path preserved for health-check intents.
    const resolvedImpl = intent.specKind
      ? this.implRegistry?.findFor({ kind: intent.specKind, type: intent.intentType ?? 'restoration' }) ?? null
      : null;
    const implStateName = intent.implName ?? resolvedImpl?.name ?? intent.specKind ?? 'default';
    const kindSeg = (intent.specKind ?? '').replace(/[.:]/g, '_');
    const implStateDir = kindSeg
      ? join(this.paths.implStateDirRoot, implStateName, kindSeg)
      : join(this.paths.implStateDirRoot, implStateName);

    // Prefer the persisted full RestorationJob; fall back to a stub for legacy
    // (pre-migration) rows so the engine still works for health-check intents.
    const restorationJob = intent.restorationJob ?? {
      id: intent.requestId,
      description: '',
      ...(intent.specKind ? { spec: { kind: intent.specKind } } : {}),
      window: { startTs: intent.windowStartTs, endTs: intent.windowEndTs },
    };

    provisionWorkingDir(workingDir, restorationJob as import('../../types/desired-state.js').RestorationJob);
    provisionImplStateDir(implStateDir);

    // takePreSnapshot transitions directly to RUNNING with the snapshot payload
    // and workingDir/implStateDir paths set.  We cannot transition
    // PRE_SNAPSHOT → PRE_SNAPSHOT (invalid); the snapshot is immediately ready
    // (it's just the provisioned dir context), so we advance to RUNNING in one
    // step.  The impl is responsible for capturing real market data.
    this.persistence.transition(intent.requestId, IntentState.RUNNING, {
      workingDir,
      implStateDir,
      preSnapshotCapturedAt: Date.now(),
      preSnapshotPayload: { provisioned: true, workingDir },
    });
    console.log(`[restorer-engine] ${intent.requestId} PRE_SNAPSHOT → RUNNING: workingDir=${workingDir}`);
  }

  /**
   * RUNNING transition: dispatch to a RestorerImpl if implRegistry is provided.
   *
   * When no impl is found for the spec kind, falls back to NotImplementedError
   * so the engine does not silently swallow the request. In tests that don't
   * exercise the impl path, override this method.
   *
   * Captures impl output in `implOutputs` map for pack() to consume. Also
   * records a minimal post-snapshot so data-driven advance can fire.
   */
  protected async runImpl(intent: PersistedIntent): Promise<void> {
    const specKind = intent.specKind ?? '';
    const type = intent.intentType ?? 'restoration';
    const impl = this.implRegistry?.findFor({ kind: specKind, type });
    if (!impl) {
      throw new NotImplementedError('runImpl');
    }

    const workingDir = intent.workingDir ?? join(this.paths.workingDirRoot, intent.requestId);
    const kindSeg = specKind.replace(/[.:]/g, '_');
    const implStateDir = intent.implStateDir ?? (
      kindSeg
        ? join(this.paths.implStateDirRoot, impl.name, kindSeg)
        : join(this.paths.implStateDirRoot, impl.name)
    );
    const windowEndTs = intent.windowEndTs;

    const abort = new AbortController();
    const msUntilEndTs = () => Math.max(0, windowEndTs - Date.now());
    const endTimer = setTimeout(() => abort.abort(), msUntilEndTs());

    // Create a trajectory collector for this run.
    const trajectory = new TrajectoryCollector({
      intentCid: intent.intentCid ?? '',
      runId: randomUUID(),
    });

    try {
      const ctx = {
        intent: (intent.restorationJob ?? {
          id: intent.requestId,
          description: '',
          ...(intent.specKind ? { spec: { kind: intent.specKind } } : {}),
          window: { startTs: intent.windowStartTs, endTs: intent.windowEndTs },
        }) as import('../../types/desired-state.js').RestorationJob,
        intentCid: intent.intentCid,
        implStateDir,
        workingDir,
        log: (event: { level: string; msg: string; data?: unknown }) => {
          console.log(`[restorer-impl:${impl.name}] [${event.level}] ${event.msg}`, event.data ?? '');
        },
        abort: abort.signal,
        msUntilEndTs,
        trajectory,
      };

      let output: RestorationOutput;
      try {
        output = await impl.run(ctx);
      } catch (err) {
        if (err instanceof SkippableError) {
          const skippedAt = Date.now();
          const detail = err.message;
          console.warn(
            `[restorer-engine] ${intent.requestId}: impl=${impl.name} skipped (${err.reason}): ${detail}`,
          );
          output = {
            venueRef: { name: 'legacy' },
            gating: {
              skipped: true,
              reason: err.reason,
              skippedAt: String(skippedAt),
            },
            informational: {
              status: 'skipped',
              detail,
            },
            artifacts: [],
          };
        } else {
          throw err;
        }
      }
      this.implOutputs.set(intent.requestId, output);

      // Store the trajectory collector so pack() can:
      //   1. pass it to uploadArtifacts (artifact.emit spans + producedBy metadata)
      //   2. call emitTrajectory AFTER artifact upload so spans are included
      //   3. backfill trajectoryCid on artifacts before envelope assembly
      // emitTrajectory is intentionally deferred to pack() (Task 16).
      this.trajectoryCollectors.set(intent.requestId, trajectory);

      // Persist impl output BEFORE the state transition so that a crash after
      // the transition (RUNNING → POST_SNAPSHOT) but before pack() runs will
      // find the serialised output in the DB on restart. pack() will hydrate the
      // in-memory map from implOutputsJson if the map entry is absent (#6).
      // Capture post-snapshot from impl output so data-driven advance fires
      this.persistence.transition(intent.requestId, IntentState.POST_SNAPSHOT, {
        postSnapshotCapturedAt: Date.now(),
        postSnapshotPayload: output.postSnapshot ?? { capturedAt: Date.now(), hlTime: 0, payload: null },
        fillsPayload: output.fills ?? [],
        gatingClaim: output.gating,
        informationalClaim: output.informational ?? null,
        implOutputsJson: JSON.stringify(output),
      });
    } finally {
      clearTimeout(endTimer);
    }
    console.log(`[restorer-engine] ${intent.requestId} RUNNING → POST_SNAPSHOT via impl=${impl.name}`);
  }

  protected async takePostSnapshot(_intent: PersistedIntent): Promise<void> {
    throw new NotImplementedError('takePostSnapshot');
  }

  /**
   * PACKAGING transition: walk workingDir, upload artifacts, assemble + sign
   * envelope, upload envelope, persist envelope CID + artifact CIDs.
   *
   * Requires packagingDeps + envelopeDeps. When absent, falls back to
   * NotImplementedError.
   */
  protected async pack(intent: PersistedIntent): Promise<void> {
    // Hydrate implOutput from DB if the in-memory map was lost (e.g. process restart
    // after RUNNING → POST_SNAPSHOT but before pack() completed). This must run
    // BEFORE the packagingDeps guard so subclass overrides that call super.pack()
    // can still benefit from hydration even when packagingDeps is absent (#6).
    if (!this.implOutputs.has(intent.requestId) && intent.implOutputsJson != null) {
      try {
        const recovered = JSON.parse(intent.implOutputsJson) as RestorationOutput;
        this.implOutputs.set(intent.requestId, recovered);
        console.log(`[restorer-engine] ${intent.requestId}: hydrated implOutputs from DB (crash recovery)`);
      } catch (err) {
        console.warn(`[restorer-engine] ${intent.requestId}: failed to hydrate implOutputsJson: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (!this.packagingDeps || !this.envelopeDeps) {
      throw new NotImplementedError('pack');
    }

    const workingDir = intent.workingDir ?? join(this.paths.workingDirRoot, intent.requestId);

    const implOutput = this.implOutputs.get(intent.requestId);
    const implArtifacts = implOutput?.artifacts ?? [];

    // 1. Walk + upload artifacts (NO registration yet — manifest CID not known).
    // Pass the trajectory collector (if present) so uploadArtifacts can emit
    // jinn.artifact.emit spans and attach producedBy back-refs (Task 16 forward
    // linkage). emitTrajectory is called AFTER upload so artifact spans are included.
    const collector = this.trajectoryCollectors.get(intent.requestId);
    const packagingDepsWithCollector = collector
      ? { ...this.packagingDeps, collector }
      : this.packagingDeps;
    const rawArtifacts = await walkArtifacts(workingDir, implArtifacts);
    const uploadedArtifacts = await uploadArtifacts(rawArtifacts, packagingDepsWithCollector);

    // 1b. Emit trajectory to IPFS now that all artifact spans have been added.
    // Non-fatal — envelope assembly continues with envelope.trajectory = null if upload fails.
    let trajectoryRef: { cid: string; sha256: string } | null =
      this.trajectoryRefs.get(intent.requestId) ?? null;
    if (!trajectoryRef && collector && this.envelopeDeps) {
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const account = privateKeyToAccount(this.envelopeDeps.agentEoaPrivateKey);
        const { cid, sha256 } = await emitTrajectory({
          collector,
          runId: collector.runId,
          signerPrivateKey: this.envelopeDeps.agentEoaPrivateKey,
          signerAddress: account.address as `0x${string}`,
          ipfsRegistryUrl: this.envelopeDeps.ipfsRegistryUrl,
        });
        trajectoryRef = { cid, sha256 };
        console.log(`[restorer-engine] ${intent.requestId}: trajectory emitted cid=${cid}`);
      } catch (err) {
        console.warn(
          `[restorer-engine] ${intent.requestId}: trajectory emit failed (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    this.trajectoryRefs.set(intent.requestId, trajectoryRef);

    // 1c. Backward linkage: backfill trajectoryCid on all artifacts that have a
    // producedBy back-ref. This must happen BEFORE assembleAndSignEnvelope so the
    // signed envelope carries the complete reference (Task 16).
    if (trajectoryRef) {
      const trajectoryCid = trajectoryRef.cid;
      for (const art of uploadedArtifacts) {
        const pb = (art.metadata as Record<string, unknown> | undefined)?.['producedBy'];
        if (pb != null && typeof pb === 'object' && 'spanId' in pb) {
          (pb as Record<string, unknown>)['trajectoryCid'] = trajectoryCid;
        }
      }
    }

    // Map to Artifact shape (strip localPath)
    const artifacts = uploadedArtifacts.map(({ localPath: _localPath, ...art }) => art);

    // 2. Derive agentEoa from private key
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(this.envelopeDeps.agentEoaPrivateKey);
    const agentEoa = account.address;

    // Safe multisig address — sourced from envelopeDeps (preferred) or deliveryDeps.
    // Hard throw if absent: falling back to agentEoa would produce a
    // protocol-invalid envelope (safeAddress MUST differ from agentEoa, §5.1).
    const safeAddress = this.envelopeDeps.safeAddress ?? this.deliveryDeps?.safeAddress;
    if (!safeAddress) {
      throw new Error('pack: safeAddress not configured in envelopeDeps or deliveryDeps');
    }

    // 3. Build envelope payload from impl output (kind-typed, wrapped into payload field)
    const preSnapshotPayload = intent.preSnapshotPayload as { capturedAt?: number; hlTime?: number; payload?: unknown } | null;
    const postSnapshotPayload = intent.postSnapshotPayload as { capturedAt?: number; hlTime?: number; payload?: unknown } | null;

    // The specKind drives payload schema selection. Fall back to 'legacy.v0'
    // for intents without a spec.kind (legacy health-check / daemon-loop-test
    // intents that use the legacy-claude impl). The legacy.v0 kind accepts any
    // Record payload so validatePayload does not reject the output.
    const specKind = intent.specKind ?? 'legacy.v0';

    // Derive role from intent type. Evaluator intents produce 'verdict' envelopes;
    // all other intents produce 'restoration' envelopes.
    const isEvaluation = intent.intentType === 'evaluation';
    const role: Role = isEvaluation ? 'verdict' : 'restoration';

    let envelopePayload: Record<string, unknown>;

    if (isEvaluation) {
      // ── Verdict envelope payload ──────────────────────────────────────────────
      // The evaluator impl populates verdictPayload on RestorationOutput with a
      // PortfolioV0VerdictPayload-shaped object. Engine passes it through to the
      // envelope assembler, which runs validatePayload('portfolio.v0', 'verdict', ...).
      //
      // If verdictPayload is absent (impl bug / crash recovery), fall back to a
      // minimal INDETERMINATE stub so the envelope assembly does not silently succeed
      // with a wrong shape — validatePayload will catch schema mismatches.
      //
      // verificationOfRestoration: stubbed — Plan D will connect the real SDK.
      // restorationEnvelope.sha256: placeholder — Plan D wires real sha256 derivation.
      const verdictPayload = implOutput?.verdictPayload;
      if (!verdictPayload) {
        throw new Error(
          `pack: evaluator impl for ${intent.requestId} did not produce verdictPayload on RestorationOutput; ` +
          `ensure the impl populates output.verdictPayload`,
        );
      }

      // If the (stub) verificationOfRestoration reports 'invalid', downgrade verdict
      // to REJECTED per scope §3.3.  For V1 the stub always returns 'valid', so this
      // path does not fire in practice — Plan D makes it real.
      const verif = verdictPayload['verificationOfRestoration'] as
        | { overall?: string }
        | undefined;
      if (verif?.overall === 'invalid') {
        // Override verdict to REJECTED; preserve the rest of the payload.
        envelopePayload = {
          ...verdictPayload,
          verdict: 'REJECTED',
        };
      } else {
        envelopePayload = verdictPayload;
      }
    } else if (implOutput?.restorationPayload) {
      // ── Non-portfolio restoration envelope payload ────────────────────────────
      // Impls for kinds with a non-portfolio payload schema (e.g. prediction.v0)
      // declare their own fully-formed payload. Engine passes it through directly
      // so validatePayload() can check it against the per-kind schema.
      envelopePayload = implOutput.restorationPayload;
    } else {
      // ── Portfolio restoration envelope payload (legacy / portfolio.v0) ─────────
      envelopePayload = {
        preSnapshot: {
          capturedAt: intent.preSnapshotCapturedAt ?? Date.now(),
          hlTime: preSnapshotPayload?.hlTime ?? 0,
          // Double-fallback: first tries the structured .payload field (normal shape),
          // then falls back to the whole payload object (handles takePreSnapshot's
          // synthetic shape where the snapshot IS the top-level object, not nested).
          payload: preSnapshotPayload?.payload ?? preSnapshotPayload ?? {},
        },
        postSnapshot: {
          capturedAt: intent.postSnapshotCapturedAt ?? Date.now(),
          hlTime: postSnapshotPayload?.hlTime ?? 0,
          // Same double-fallback as above.
          payload: postSnapshotPayload?.payload ?? postSnapshotPayload ?? {},
        },
        fills: (intent.fillsPayload as unknown[]) ?? [],
        gating: (intent.gatingClaim as Record<string, unknown>) ?? {},
        ...(intent.informationalClaim != null
          ? { informational: intent.informationalClaim as Record<string, unknown> }
          : {}),
        ...(implOutput?.rationale != null ? { rationale: implOutput.rationale } : {}),
      };
    }

    // 4. Persist generatedAt once (first pack); reuse on retry for CID determinism.
    const generatedAt: number = intent.manifestGeneratedAt ?? Date.now();
    if (!intent.manifestGeneratedAt) {
      // Persist before assembling so that a crash after assembly but before
      // transition still gets the same generatedAt on the next attempt.
      this.persistence.setManifestGeneratedAt(intent.requestId, generatedAt);
    }

    // 5. Assemble + sign envelope → envelope CID now known.
    // trajectoryRef was computed in step 1b above (emitted after artifact upload).
    const envelopeTrajectory = trajectoryRef
      ? { cid: trajectoryRef.cid, sha256: trajectoryRef.sha256 }
      : null;

    // evidenceTier reflects the on-chain commitment state at the time of signing.
    // For the V2 claim flow, claimDelivery will write an evidenceHash on-chain,
    // so the envelope should be declared 'committed'. For V1 or unknown flows,
    // 'self-signed' is accurate (no on-chain hash commitment).
    const evidenceTier: import('../../types/envelope.js').EvidenceTier =
      this.deliveryDeps?.claimDeliveryVariant === 'v2' ? 'committed' : 'self-signed';

    const envelopeInputs: EnvelopeInputs = {
      kind: specKind,
      role,
      intent: {
        cid: intent.intentCid,
        onchainCreationTx: intent.onchainCreationTx,
        onchainCreationBlock: intent.onchainCreationBlock,
        requestId: intent.requestId,
      },
      participant: { safeAddress, agentEoa },
      window: { startTs: intent.windowStartTs, endTs: intent.windowEndTs },
      executor: {
        implName: intent.implName ?? specKind,
        // buildInfo resolves to real values in production builds; falls back to
        // clearly-labelled placeholders ('dev' / 'sha256:dev-build') when running
        // via tsx without a prior `yarn build` (dev mode).
        implVersion: buildInfo.implVersion,
        clientGitSha: buildInfo.clientGitSha,
        codeDigest: buildInfo.codeDigest,
        signingKey: { kind: 'agent-eoa', pubkey: agentEoa },
      },
      evidenceTier,
      trajectory: envelopeTrajectory,
      artifacts,
      payload: envelopePayload,
      generatedAt,
    };

    const { envelopeCid, envelopeHash } = await assembleAndSignEnvelope(
      envelopeInputs,
      this.envelopeDeps,
    );
    const manifestCid = envelopeCid;
    const signatureHash = envelopeHash;

    // 6. ERC-8004 IdentityRegistry per-execution `setMetadata` fires in
    //    deliver() AFTER claimDelivery succeeds. 'committed' must mean
    //    "observable on-chain evidenceHash exists" — publishing before claim
    //    would lie during failures. The evidenceHash (signatureHash) is
    //    persisted to DELIVERING state below and reused by deliver().
    //    Operator-rooted entity model: docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md.

    // 7. Build artifact CID map for persistence
    const artifactCids: Record<string, string> = {};
    for (const art of uploadedArtifacts) {
      artifactCids[art.localPath] = art.cid;
    }

    // 8. Persist DELIVERING with manifest CID + artifact CIDs + evidence hash.
    //    evidenceHash gets its own dedicated column (not stashed in informationalClaim).
    this.persistence.transition(intent.requestId, IntentState.DELIVERING, {
      manifestCid,
      artifactCids,
      evidenceHash: signatureHash,
    });
    console.log(`[restorer-engine] ${intent.requestId} PACKAGING → DELIVERING manifestCid=${manifestCid}`);

    // Clean up transient state (no longer needed after DELIVERING)
    this.implOutputs.delete(intent.requestId);
    this.trajectoryCollectors.delete(intent.requestId);
    this.trajectoryRefs.delete(intent.requestId);
  }

  /**
   * DELIVERING transition: call mech.deliverToMarketplace + JinnRouter.claimDelivery.
   *
   * Requires deliveryDeps. When absent, falls back to NotImplementedError.
   *
   * Crash-recovery safe: if `intent.deliveryTxHash` is already set (persisted
   * after a previous deliverToMarketplace call that completed before the process
   * crashed), we skip the deliver step and go straight to claimDelivery.
   */
  protected async deliver(intent: PersistedIntent): Promise<void> {
    if (!this.deliveryDeps) {
      throw new NotImplementedError('deliver');
    }

    const manifestCid = intent.manifestCid;
    if (!manifestCid) {
      throw new Error(`deliver: manifestCid missing for ${intent.requestId}`);
    }

    // Guard: v2 claimDelivery requires an evidenceHash — a zero fallback would
    // silently brick staking rewards, so we fail loudly instead.
    const evidenceHash = intent.evidenceHash as `0x${string}` | null | undefined;
    if (!evidenceHash && this.deliveryDeps.claimDeliveryVariant === 'v2') {
      throw new MissingEvidenceHashError(intent.requestId);
    }

    // Capture locals for use in the onDeliveryTxLanded closure.
    const requestId = intent.requestId;
    const persistence = this.persistence;

    const { deliveryTxHash, claimTxHash } = await deliverAndClaim(
      requestId as `0x${string}`,
      manifestCid,
      evidenceHash as `0x${string}`,
      this.deliveryDeps,
      // Recovery: pass existing deliveryTxHash so deliverToMarketplace is skipped.
      (intent.deliveryTxHash as `0x${string}`) ?? undefined,
      // Persist deliveryTxHash before claimDelivery so recovery can resume from here.
      async (txHash) => {
        persistence.setDeliveryTxHash(requestId, txHash);
      },
    );

    this.persistence.transition(requestId, IntentState.COMPLETE, {
      deliveryTxHash,
    });
    console.log(`[restorer-engine] ${requestId} DELIVERING → COMPLETE deliveryTx=${deliveryTxHash} claimTx=${claimTxHash}`);

    // Emit a SQLite artifact row so consumers (release acceptance gate, search
    // API) see this cycle alongside legacy-claude / MCP-emitted rows. The
    // legacy claude path writes via the MCP `submit_restoration_result` tool;
    // deterministic impls (prediction-v0-baseline, prediction-v0-evaluator,
    // …) don't go through MCP, so the engine emits on their behalf here.
    // Idempotent: skips when a row for this requestId+tag already exists
    // (legacy path may have already inserted).
    this.emitCycleArtifact(intent, manifestCid, evidenceHash);

    // ── ERC-8004 setMetadata — fires AFTER claimDelivery succeeds ────────────
    //
    // Moved here from pack() per PR#37 review2 must-fix #2. 'committed' means
    // "observable on-chain evidenceHash exists" — publishing before claim would
    // lie during failures. evidenceHash comes from intent (persisted in
    // DELIVERING state by pack()); idempotent on retry (setMetadata is a pure
    // key-value write; re-running with the same payload is safe).
    //
    // Restoration-only for now. Evaluator setMetadata lands with jinn-mono-2ff.
    if (this.identityPublisher) {
      const intentTypeRaw = intent.intentType ?? 'restoration';
      if (intentTypeRaw === 'restoration') {
        const signatureHash = evidenceHash as `0x${string}` | null | undefined;
        // v0 tier rule: with an evidenceHash on chain we declare `committed` (tier=1);
        // higher tiers (`attested`, `proved`) come later when TEE work lands.
        const tier: ExecutionTier = signatureHash ? 1 : 0;
        const setMetadataPayload: ExecutionPayload = {
          version: 1,
          tier,
          manifestHash: signatureHash ?? ('0x' as `0x${string}`),
          attestationQuoteCid: '0x',
          sourceMeasurement:
            '0x0000000000000000000000000000000000000000000000000000000000000000',
        };
        try {
          const pubTxHash = await this.identityPublisher.publishContent({
            kind: 'envelope',
            cid: manifestCid,
            payload: setMetadataPayload,
          });
          console.log(
            `[restorer-engine] ${requestId}: setMetadata envelope:${manifestCid} tx=${pubTxHash}`,
          );
        } catch (err) {
          console.warn(
            `[restorer-engine] ${requestId}: setMetadata envelope publish failed (non-fatal): ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }

    // ── Reputation feedback hook (jinn-mono-yg4) ─────────────────────────────
    //
    // Evaluator-only path: after `claimDelivery` settles the verdict, fire
    // `ReputationRegistry.giveFeedback(restorerAgentId, ...)` so the
    // restorer's agent NFT accrues a rating (DR §4.3).
    //
    // Best-effort: any failure inside the hook is logged but does not
    // change the COMPLETE state. claimDelivery is already authoritative.
    if (intent.intentType === 'evaluation' && this.reputationFeedback) {
      await this._maybePostEvaluatorFeedback(intent).catch((err) => {
        console.warn(
          `[restorer-engine] ${requestId}: reputation feedback hook errored unexpectedly (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      });
    }
  }

  /**
   * Post evaluator feedback on the restorer's agent NFT.
   *
   * Pulls the verdict from the persisted gating claim (the evaluator impl
   * writes `{ verdict, score, scoreBasis, ... }` into `output.gating`),
   * resolves the restorer's `agentId` via the configured subgraph
   * resolver, and submits a single `ReputationRegistry.giveFeedback` tx.
   *
   * Skipped silently when:
   *   - No `reputationFeedback` deps wired.
   *   - `gatingClaim` doesn't carry a verdict (impl shape mismatch — log and
   *     return).
   *   - The parent restorer's manifest hash isn't reachable from the
   *     persisted state (legacy intents that pre-date evidenceHash
   *     threading — log and return).
   *   - `resolveAgentId` returns null (subgraph not indexed yet, or no
   *     subgraph URL configured at all — log and return).
   *
   * The mapping policy (PASS / FAIL / REJECTED / INDETERMINATE → score) lives
   * inside `submitEvaluatorFeedback` / `mapVerdictToScore` in the
   * feedback-hook module; we just hand it the verdict.
   */
  /**
   * Insert a SQLite `artifacts` row for a successfully delivered cycle so the
   * release acceptance gate (and the search API) can observe completion via
   * the same surface as the legacy claude / MCP path.
   *
   * The legacy `legacy-claude` impl writes via the MCP `submit_restoration_result`
   * tool when Claude reports success; deterministic impls don't go through MCP.
   * This emitter closes that gap by writing the row from the engine when the
   * cycle hits COMPLETE.
   *
   * Idempotent: if a row already exists for (requestId, tag) — e.g. the legacy
   * MCP path got there first — we leave it alone.
   */
  private emitCycleArtifact(
    intent: PersistedIntent,
    manifestCid: string,
    evidenceHash: `0x${string}` | null | undefined,
  ): void {
    const desiredStateId = intent.restorationJob?.id;
    if (!desiredStateId) {
      // Pre-migration intent rows had no desired_state_payload; the legacy
      // path is the only thing that can emit artifacts for them, and it
      // does so via MCP. Skip rather than synthesise an id.
      return;
    }
    const intentType = intent.intentType ?? 'restoration';
    const tag = intentType === 'evaluation' ? 'evaluation-verdict' : 'restoration-result';
    const existing = this.store.getArtifactByRequestId(intent.requestId, tag);
    if (existing) return;

    this.store.insertArtifact({
      id: randomUUID(),
      desiredStateId,
      requestId: intent.requestId,
      title: `${tag}: ${intent.specKind ?? 'cycle'} (${intent.implName ?? 'engine'})`,
      content: JSON.stringify({
        manifestCid,
        evidenceHash: evidenceHash ?? null,
        implName: intent.implName,
      }),
      tags: [tag, 'success'],
      outcome: 'SUCCESS',
    });
  }

  private async _maybePostEvaluatorFeedback(intent: PersistedIntent): Promise<void> {
    if (!this.reputationFeedback) return;

    const gating = intent.gatingClaim as
      | { verdict?: unknown; scoreBasis?: unknown }
      | null;
    const verdictRaw = gating?.['verdict'];
    if (
      verdictRaw !== 'PASS' &&
      verdictRaw !== 'FAIL' &&
      verdictRaw !== 'REJECTED' &&
      verdictRaw !== 'INDETERMINATE'
    ) {
      console.warn(
        `[restorer-engine] ${intent.requestId}: reputation feedback skipped — gatingClaim has no recognised verdict (got=${String(verdictRaw)})`,
      );
      return;
    }
    const verdict = verdictRaw as EvaluatorVerdict['verdict'];

    // Pull the parent restorer's manifest evidence from the inlined eval
    // payload. The evaluator impl receives the restorer's signed manifest
    // JSON via `intent.context.restorationResult` (see
    // `MechAdapter.tryCreateEvaluationJob`). Its `signature.hash` is
    // exactly what the restorer committed via `claimDelivery(evidenceHash)`.
    const parent = this._extractRestorerManifestRef(intent);
    if (!parent) {
      console.warn(
        `[restorer-engine] ${intent.requestId}: reputation feedback skipped — could not extract restorer manifest hash from inlined evaluation payload`,
      );
      return;
    }

    let resolved: ResolvedAgent | null;
    try {
      resolved = await this.reputationFeedback.resolveAgentId(parent.evidenceHash);
    } catch (err) {
      console.warn(
        `[restorer-engine] ${intent.requestId}: reputation feedback resolver threw (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
      return;
    }
    if (!resolved) {
      console.log(
        `[restorer-engine] ${intent.requestId}: reputation feedback skipped — no agentId resolved for restorer manifestHash=${parent.evidenceHash} (subgraph not indexed yet, or no envelope published)`,
      );
      return;
    }

    // CID resolution priority: subgraph row's `manifestCid` (cheapest, the
    // operator already published an envelope under it), else the inlined
    // CID hint when present, else fall back to the bare hash. The subgraph
    // parses `manifest:<cid>` to a `manifestRef` regardless.
    const manifestCid = resolved.manifestCid ?? parent.manifestCid ?? '';

    // The intent kind is the same `spec.kind` used by the restoration —
    // `intent.specKind` is "portfolio.v0" both for the restoration and its
    // evaluation. Tag1 is indexed on the on-chain event, so cheap to filter.
    const kind = intent.specKind ?? undefined;

    const verdictArg: EvaluatorVerdict = kind ? { verdict, kind } : { verdict };

    let outcome: FeedbackHookOutcome;
    try {
      outcome = await submitEvaluatorFeedback({
        registry: this.reputationFeedback.client,
        ref: {
          restorerAgentId: resolved.agentId,
          restorerManifestCid: manifestCid,
          restorerEvidenceHash: parent.evidenceHash,
        },
        verdict: verdictArg,
      });
    } catch (err) {
      // submitEvaluatorFeedback already swallows known reverts, but a
      // truly unexpected throw still must not propagate past delivery.
      console.warn(
        `[restorer-engine] ${intent.requestId}: reputation feedback unexpected throw (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    console.log(
      `[restorer-engine] ${intent.requestId}: reputation feedback ${outcome.kind} verdict=${verdict} restorerAgentId=${resolved.agentId.toString()}`,
    );
  }

  /**
   * Extract the restorer's `evidenceHash` (and best-effort `manifestCid`)
   * from the persisted evaluation intent.
   *
   * The evaluator's `intent.context.restorationResult` holds the restorer's
   * full signed manifest JSON inlined as a string (per
   * `MechAdapter.tryCreateEvaluationJob`). We parse it and pull the
   * `signature.hash`, which is exactly the on-chain `evidenceHash`.
   *
   * The CID is not always inlined — the manifest carries its own
   * `intent.cid` field (the *original intent* CID), not its self-CID. We
   * therefore return `manifestCid: null` here and rely on the subgraph
   * resolver to surface the published manifest CID. Returns `null` when
   * the inlined payload is missing or malformed.
   */
  private _extractRestorerManifestRef(intent: PersistedIntent): {
    evidenceHash: `0x${string}`;
    manifestCid: string | null;
  } | null {
    const ds = intent.restorationJob;
    const inlined = ds?.context?.['restorationResult'];
    if (typeof inlined !== 'string' || inlined.length === 0) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(inlined);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const sig = (parsed as Record<string, unknown>)['signature'];
    if (typeof sig !== 'object' || sig === null) {
      return null;
    }
    const hashRaw = (sig as Record<string, unknown>)['hash'];
    if (typeof hashRaw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hashRaw)) {
      return null;
    }
    return {
      evidenceHash: hashRaw as `0x${string}`,
      manifestCid: null,
    };
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Returns the next state if the current state can be advanced purely from
   * persisted data (no external work needed), or null if external work is required.
   *
   * Used for crash recovery and for collapsing transitions in process()
   * when a previous run already produced the data.
   */
  private dataDrivenAdvance(intent: PersistedIntent): IntentState | null {
    switch (intent.state) {
      case IntentState.WAITING:
        return Date.now() >= intent.windowStartTs ? IntentState.PRE_SNAPSHOT : null;
      case IntentState.PRE_SNAPSHOT:
        return intent.preSnapshotPayload != null ? IntentState.RUNNING : null;
      case IntentState.POST_SNAPSHOT:
        return intent.postSnapshotPayload != null ? IntentState.PACKAGING : null;
      default:
        return null;
    }
  }

  /**
   * Wraps a transition method call with error handling: if the transition
   * throws, the intent is marked FAILED with the error message.
   */
  private async _runTransition(
    intent: PersistedIntent,
    fn: () => Promise<void>,
  ): Promise<void> {
    const oldState = intent.state;
    try {
      await fn();
      const updated = this.persistence.getByRequestId(intent.requestId);
      if (updated && updated.state !== oldState) {
        console.log(`[restorer-engine] ${intent.requestId} ${oldState} → ${updated.state}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.persistence.markFailed(intent.requestId, reason);
      throw err;
    }
  }

  /**
   * Recovery handler for a single in-flight intent.
   * Dispatches by state per §6.5.
   */
  private async _recoverOne(intent: PersistedIntent): Promise<void> {
    try {
      await this._recoverDispatch(intent);
    } catch (err) {
      // If recovery itself throws (e.g. NotImplementedError stub), mark failed.
      // NotImplementedError is expected during development; don't swallow it in prod.
      const reason = err instanceof Error ? err.message : String(err);
      // Only mark failed if the intent is still in the same non-terminal state
      // (another concurrent recovery pass might have already advanced it).
      const current = this.persistence.getByRequestId(intent.requestId);
      if (current && current.state === intent.state) {
        this.persistence.markFailed(intent.requestId, `recovery: ${reason}`);
        console.error(`[restorer-engine] resume failed for ${intent.requestId}: ${reason}`);
      }
      throw err;
    }
  }

  /**
   * Per-state recovery dispatch per §6.5.
   */
  private async _recoverDispatch(intent: PersistedIntent): Promise<void> {
    switch (intent.state) {
      case IntentState.DISCOVERED:
        // Ready to claim — delegate to claim flow (subsequent task).
        // Stub: leaves state unchanged; logs intent is ready.
        await this.claim(intent);
        break;

      case IntentState.CLAIMED:
        // Advance to WAITING — no side effect needed.
        this.persistence.transition(intent.requestId, IntentState.WAITING);
        await this._recoverDispatch(this.persistence.getOrThrow(intent.requestId));
        break;

      case IntentState.WAITING: {
        const advance = this.dataDrivenAdvance(intent);
        if (advance !== null) {
          // Window has started — advance immediately.
          this.persistence.transition(intent.requestId, advance);
          await this._recoverDispatch(this.persistence.getOrThrow(intent.requestId));
        }
        // else: schedule a timer for startTs — caller handles scheduling.
        break;
      }

      case IntentState.PRE_SNAPSHOT: {
        const advance = this.dataDrivenAdvance(intent);
        if (advance !== null) {
          // Snapshot already in DB — advance to RUNNING.
          this.persistence.transition(intent.requestId, advance);
          await this._recoverDispatch(this.persistence.getOrThrow(intent.requestId));
        } else {
          // Need to (re-)fetch snapshot.
          await this.takePreSnapshot(intent);
          // takePreSnapshot transitions PRE_SNAPSHOT → RUNNING. Re-dispatch
          // against the post-transition state so runImpl actually fires for
          // intents that were persisted at CLAIMED/WAITING/PRE_SNAPSHOT
          // before a restart (otherwise recovery stops at RUNNING-but-not-run).
          const after = this.persistence.getByRequestId(intent.requestId);
          if (after && after.state !== intent.state && after.state !== IntentState.FAILED) {
            await this._recoverDispatch(after);
          }
        }
        break;
      }

      case IntentState.RUNNING:
        // Re-spawn impl with workingDir + implStateDir intact.
        await this.runImpl(intent);
        break;

      case IntentState.POST_SNAPSHOT: {
        const advance = this.dataDrivenAdvance(intent);
        if (advance !== null) {
          // Snapshot already in DB — advance to PACKAGING.
          this.persistence.transition(intent.requestId, advance);
          await this._recoverDispatch(this.persistence.getOrThrow(intent.requestId));
        } else {
          await this.takePostSnapshot(intent);
        }
        break;
      }

      case IntentState.PACKAGING:
        // Re-walk workingDir + RestorationOutput; re-upload missing CIDs.
        await this.pack(intent);
        break;

      case IntentState.DELIVERING:
        // Chain query — if already delivered → COMPLETE; else retry.
        await this.deliver(intent);
        break;

      case IntentState.COMPLETE:
      case IntentState.FAILED:
        // Terminal — nothing to recover.
        break;
    }
  }
}
