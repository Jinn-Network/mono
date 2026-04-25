/**
 * Restorer engine — main RestorationEngine class.
 *
 * §6.3, §6.5 of spec/2026-04-17-portfolio-v0-design.md
 *
 * Orchestrates the state machine lifecycle for each observed intent.
 * Transition method bodies are stubs; subsequent tasks fill them in.
 */

import { join } from 'node:path';
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
  registerArtifacts,
  type PackagingDeps,
} from './packaging.js';
import {
  assembleAndSignManifest,
  type ManifestAssemblyDeps,
  type ManifestAssemblyOptions,
} from './manifest-assembly.js';
import {
  deliverAndClaim,
  type DeliveryDeps,
} from './delivery.js';
import type { RestorerImpl, RestorationOutput } from '../types.js';
import { SkippableError } from '../types.js';
import type { Registry8004 } from '../../discovery/registry.js';

// ── Sentinel error ────────────────────────────────────────────────────────────

export class NotImplementedError extends Error {
  readonly transitionName: string;

  constructor(transitionName: string) {
    super(`[NotImplemented] ${transitionName} — fill in via subsequent task`);
    this.name = 'NotImplementedError';
    this.transitionName = transitionName;
  }
}

// ── Registry stub (to be fleshed out in impl task) ───────────────────────────

export interface RestorerImplRegistry {
  /** Returns the impl name for a given spec kind (and optional type), or null if none registered. */
  resolveImplName(ctx: { kind: string | null; type?: 'restoration' | 'evaluation' }): string | null;
}

// ── Engine options ────────────────────────────────────────────────────────────

export interface RestorationEngineOptions {
  store: Store;
  registry: RestorerImplRegistry;
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
   * Manifest assembly dependencies. When provided, pack() can assemble + sign.
   * When absent, pack() falls back to NotImplementedError.
   */
  manifestDeps?: ManifestAssemblyDeps;
  /**
   * Delivery dependencies. When provided, deliver() is functional.
   * When absent, deliver() falls back to NotImplementedError.
   */
  deliveryDeps?: DeliveryDeps;
  /**
   * Impl registry for resolving which RestorerImpl to run.
   * When provided and findFor() returns an impl, runImpl() dispatches to it.
   */
  implRegistry?: {
    findFor(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): RestorerImpl | undefined;
  };
  /**
   * ERC-8004 Identity Registry client. When provided, the engine registers
   * the envelope (adw:ExecutionEnvelope) and each artifact (adw:Artifact with
   * parentEnvelopeCid) after successful pack().
   *
   * Optional — tests and development modes may skip registration.
   */
  erc8004Registry?: Registry8004;
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
  protected readonly registry: RestorerImplRegistry;
  protected readonly paths: RestorationEngineOptions['paths'];
  protected readonly claimDeps: RestorationEngineOptions['claimDeps'];
  protected readonly packagingDeps: RestorationEngineOptions['packagingDeps'];
  protected readonly manifestDeps: RestorationEngineOptions['manifestDeps'];
  protected readonly deliveryDeps: RestorationEngineOptions['deliveryDeps'];
  protected readonly implRegistry: RestorationEngineOptions['implRegistry'];
  protected readonly erc8004Registry: RestorationEngineOptions['erc8004Registry'];

  // Transient storage for impl output between runImpl and pack transitions.
  // Keyed by requestId; cleared after successful pack.
  private readonly implOutputs = new Map<string, RestorationOutput>();

  /** Set by stop(); causes runTickLoop to exit at the next iteration. */
  private stopped = false;

  constructor(opts: RestorationEngineOptions) {
    this.persistence = new IntentPersistence(opts.store.db);
    this.registry = opts.registry;
    this.paths = opts.paths;
    this.claimDeps = opts.claimDeps;
    this.packagingDeps = opts.packagingDeps;
    this.manifestDeps = opts.manifestDeps;
    this.deliveryDeps = opts.deliveryDeps;
    this.implRegistry = opts.implRegistry;
    this.erc8004Registry = opts.erc8004Registry;
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
    // (join(implStateDirRoot, impl.name)). Falls back to specKind then 'default'
    // when no impl is registered — legacy path preserved for health-check intents.
    const resolvedImpl = intent.specKind
      ? this.implRegistry?.findFor({ kind: intent.specKind, type: intent.intentType ?? 'restoration' }) ?? null
      : null;
    const implStateName = intent.implName ?? resolvedImpl?.name ?? intent.specKind ?? 'default';
    const implStateDir = join(this.paths.implStateDirRoot, implStateName);

    // Prefer the persisted full DesiredState; fall back to a stub for legacy
    // (pre-migration) rows so the engine still works for health-check intents.
    const desiredState = intent.desiredState ?? {
      id: intent.requestId,
      description: '',
      ...(intent.specKind ? { spec: { kind: intent.specKind } } : {}),
      window: { startTs: intent.windowStartTs, endTs: intent.windowEndTs },
    };

    provisionWorkingDir(workingDir, desiredState as import('../../types/desired-state.js').DesiredState);
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
    const implStateDir = intent.implStateDir ?? join(this.paths.implStateDirRoot, impl.name);
    const windowEndTs = intent.windowEndTs;

    const abort = new AbortController();
    const msUntilEndTs = () => Math.max(0, windowEndTs - Date.now());
    const endTimer = setTimeout(() => abort.abort(), msUntilEndTs());

    try {
      const ctx = {
        intent: (intent.desiredState ?? {
          id: intent.requestId,
          description: '',
          ...(intent.specKind ? { spec: { kind: intent.specKind } } : {}),
          window: { startTs: intent.windowStartTs, endTs: intent.windowEndTs },
        }) as import('../../types/desired-state.js').DesiredState,
        intentCid: intent.intentCid,
        implStateDir,
        workingDir,
        log: (event: { level: string; msg: string; data?: unknown }) => {
          console.log(`[restorer-impl:${impl.name}] [${event.level}] ${event.msg}`, event.data ?? '');
        },
        abort: abort.signal,
        msUntilEndTs,
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
   * manifest, upload manifest, persist manifest CID + artifact CIDs.
   *
   * Requires packagingDeps + manifestDeps. When absent, falls back to
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

    if (!this.packagingDeps || !this.manifestDeps) {
      throw new NotImplementedError('pack');
    }

    const workingDir = intent.workingDir ?? join(this.paths.workingDirRoot, intent.requestId);

    const implOutput = this.implOutputs.get(intent.requestId);
    const implArtifacts = implOutput?.artifacts ?? [];

    // 1. Walk + upload artifacts (NO registration yet — manifest CID not known)
    const rawArtifacts = await walkArtifacts(workingDir, implArtifacts);
    const uploadedArtifacts = await uploadArtifacts(rawArtifacts, this.packagingDeps);

    // Map to Artifact shape (strip localPath)
    const artifacts = uploadedArtifacts.map(({ localPath: _localPath, ...art }) => art);

    // 2. Derive agentEoa from private key
    const { privateKeyToAccount } = await import('viem/accounts');
    const account = privateKeyToAccount(this.manifestDeps.agentEoaPrivateKey);
    const agentEoa = account.address;

    // Safe multisig address — sourced from manifestDeps (preferred) or deliveryDeps.
    // Hard throw if absent: falling back to agentEoa would produce a
    // protocol-invalid manifest (safeAddress MUST differ from agentEoa, §5.1).
    const safeAddress = this.manifestDeps.safeAddress ?? this.deliveryDeps?.safeAddress;
    if (!safeAddress) {
      throw new Error('pack: safeAddress not configured in manifestDeps or deliveryDeps');
    }

    // 3. Assemble + sign manifest
    const provenance = {
      intentCid: intent.intentCid,
      onchainCreationTx: intent.onchainCreationTx,
      onchainCreationBlock: intent.onchainCreationBlock,
      requestId: intent.requestId,
      safeAddress,
      agentEoa,
      windowStartTs: intent.windowStartTs,
      windowEndTs: intent.windowEndTs,
    };

    const preSnapshotPayload = intent.preSnapshotPayload as { capturedAt?: number; hlTime?: number; payload?: unknown } | null;
    const postSnapshotPayload = intent.postSnapshotPayload as { capturedAt?: number; hlTime?: number; payload?: unknown } | null;

    const manifestImplOutput = {
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
      informational: (intent.informationalClaim as Record<string, unknown>) ?? undefined,
      rationale: implOutput?.rationale ?? undefined,
    };

    // 4. Persist generatedAt once (first pack); reuse on retry for CID determinism.
    const generatedAt: number = intent.manifestGeneratedAt ?? Date.now();
    if (!intent.manifestGeneratedAt) {
      // Persist before assembling so that a crash after assembly but before
      // transition still gets the same generatedAt on the next attempt.
      this.persistence.setManifestGeneratedAt(intent.requestId, generatedAt);
    }

    const manifestOpts: ManifestAssemblyOptions = { generatedAt };

    // 5. Sign + upload manifest → manifest CID now known
    const { manifest: _manifest, manifestCid, signatureHash } = await assembleAndSignManifest(
      provenance,
      manifestImplOutput,
      artifacts,
      this.manifestDeps,
      manifestOpts,
    );

    // 6. Register artifacts with back-pointer to parent manifest CID (spec §6.1)
    registerArtifacts(uploadedArtifacts, manifestCid, this.packagingDeps);

    // 6b. ERC-8004 Identity Registry registration (Plan E Task 11). Best-effort:
    // failures emit a warning but do not fail the pack() transition — the envelope
    // + on-chain claimDelivery evidenceHash remain the canonical substrate.
    if (this.erc8004Registry) {
      const intentType = (intent.intentType ?? 'restoration') as 'restoration' | 'verdict';
      const envelopeRegistrationPromise = this.erc8004Registry
        .registerEnvelope({
          envelopeCid: manifestCid,
          kind: intent.specKind ?? 'unknown',
          role: intentType,
          evidenceTier: 'self-signed',
          intentCid: intent.intentCid ?? '',
          parentEnvelopeCid: intent.intentType === 'evaluation'
            ? ((intent as unknown as Record<string, unknown>)['parentEnvelopeCid'] as string | undefined)
            : undefined,
          participant: safeAddress,
          generatedAt,
        })
        .catch((err: unknown) => {
          console.warn(
            `[restorer-engine] registerEnvelope failed for ${intent.requestId}: ${err instanceof Error ? err.message : err}`,
          );
          return null;
        });

      const artifactRegistrationPromises = uploadedArtifacts.map((art) =>
        this.erc8004Registry!
          .registerArtifactWithParent({
            id: art.cid,
            title: art.role ?? 'unknown',
            tags: [intent.specKind ?? 'unknown'],
            outcome: 'restored',
            endpoint: `ipfs://${art.cid}`,
            parentEnvelopeCid: manifestCid,
          })
          .catch((err: unknown) => {
            console.warn(
              `[restorer-engine] registerArtifactWithParent failed for ${art.cid}: ${err instanceof Error ? err.message : err}`,
            );
            return null;
          }),
      );

      // Await all registrations so uncaught-promise warnings don't fire.
      // We do NOT block the state transition on these — they are fire-and-resolve.
      await Promise.all([envelopeRegistrationPromise, ...artifactRegistrationPromises]);
    }

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

    // Clean up impl output (no longer needed)
    this.implOutputs.delete(intent.requestId);
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
