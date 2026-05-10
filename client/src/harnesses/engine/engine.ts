/**
 * Harness engine — main TaskEngine class.
 *
 * §6.3, §6.5 of spec/2026-04-17-portfolio-v0-design.md
 *
 * Orchestrates the state machine lifecycle for each observed task.
 * Transition method bodies are stubs; subsequent tasks fill them in.
 */

import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { keccak256, toBytes } from 'viem';
import type { ZodIssue } from 'zod';
import { TaskRunPersistence, type PersistedTaskRun, type PersistedTaskRunInput } from './persistence.js';
import { TaskRunState, MissingEvidenceHashError } from './state.js';
import type { Store } from '../../store/store.js';
import {
  provisionWorkingDir,
  provisionImplStateDir,
  walkArtifacts,
  uploadArtifacts,
  type PackagingDeps,
} from './packaging.js';
import { DONATION_ARTIFACT_ENCODING } from './artifact-scrub.js';
import {
  assembleAndSignEnvelope,
  type EnvelopeAssemblyDeps,
  type EnvelopeInputs,
} from './envelope-assembly.js';
import {
  deliverAndClaim,
  type DeliveryDeps,
} from './delivery.js';
import type { Harness, HarnessContext, RuntimePlugin, Solution } from '../types.js';
import { SkippableError } from '../types.js';
import type {
  ExecutionPayload,
  ExecutionPayloadV2,
  ExecutionTier,
  IdentityPublisher,
  ReputationRegistryClient,
  EvaluatorVerdict,
  FeedbackHookOutcome,
  ResolvedAgent,
} from '../../erc8004/index.js';
import {
  submitEvaluatorFeedback,
  codeDigestSha256ToBytes32,
  modeStringToFlag,
} from '../../erc8004/index.js';
import type { ArtifactSource, Role } from '../../types/envelope.js';
import type { Task } from '../../types/task.js';
import { TrajectoryCollector, emitTrajectory } from '../../trajectory/index.js';
import { uploadToIpfs } from '../../adapters/mech/ipfs.js';
import { buildInfo } from '../../build-info.js';
import { getSolverNetContract } from '@jinn-network/sdk/solvernets';
import type { SolverNetManifestV1 } from '@jinn-network/sdk/solvernets';
import {
  runHarnessWithFreezeFence,
  type FreezeViolation,
} from '../../daemon/freeze-fence.js';
import { harnessStateDirName } from '../names.js';

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
 * Resolves a `Harness` for a given solverType (and optional role), or
 * returns `undefined` when nothing is registered/enabled.
 *
 * The engine only needs `findFor` — `resolveImplName` was a redundant alias
 * for `findFor(...)?.name` and was removed under jinn-mono-qip (supersedes
 * jinn-mono-cy4). Concrete implementation lives in
 * `harnesses/engine/registry.ts` (`HarnessRegistry`).
 */
export interface ImplRegistry {
  findFor(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): Harness | undefined;
}

export interface SolverNetRegistryLike {
  forSolverType(solverType: string, taskRole?: 'restoration' | 'evaluation'): {
    name: string;
    solverType: string;
    harness: string;
    model?: string;
    runtimePlugins: RuntimePlugin[];
  } | undefined;
}

/**
 * Read-only view of the operator config's `joinedSolverNets` map.
 *
 * Per spec §14 of `spec/2026-05-05-solvernet-creation-and-launch.md`,
 * operator claim eligibility is per-launch via `manifestDigest`
 * (= keccak256(manifestCid)) — an operator who joined Launcher A's
 * Prediction net is not automatically eligible for Launcher B's
 * Prediction tasks even though both share the same SolverNet contract.
 *
 * Keys are the manifest CID (CIDv0 / CIDv1) the operator joined under.
 * Values declare which roles ('solver' / 'evaluator') the operator
 * agreed to fulfil for that net.
 *
 * Wired by `main.ts` from `config.joinedSolverNets` (Task 21). Tests and
 * legacy paths that don't exercise per-launch attribution can omit it; the
 * engine then falls back to its prior solverType-driven eligibility check.
 */
export interface JoinedSolverNetsView {
  /** Returns the joined-net entry for the given manifest CID, or undefined. */
  get(manifestCid: string): { roles: Array<'solver' | 'evaluator'> } | undefined;
  /** Enumerate all joined manifest CIDs (used for digest-based filtering). */
  manifestCids(): string[];
}

/** Map task role to the operator role it requires in `joinedSolverNets`. */
function joinedRoleForTaskRole(taskRole: 'restoration' | 'evaluation'): 'solver' | 'evaluator' {
  return taskRole === 'evaluation' ? 'evaluator' : 'solver';
}

/**
 * Build a `JoinedSolverNetsView` from the raw operator-config block.
 *
 * The config carries the full `JoinedSolverNetEntry` shape (manifestCid,
 * name, roles, harness, model, plugins, ...). The engine only needs
 * `roles` and the CID-keyed lookup, so this helper narrows it.
 */
export function joinedSolverNetsViewFromConfig(
  joined: Record<string, { manifestCid: string; roles: Array<'solver' | 'evaluator'> }> | undefined,
): JoinedSolverNetsView | undefined {
  if (!joined) return undefined;
  const map = new Map<string, { roles: Array<'solver' | 'evaluator'> }>();
  for (const [key, entry] of Object.entries(joined)) {
    // The config keys joined nets by `manifestCid`. We accept either the key
    // or the entry's `manifestCid` field; in practice they're identical.
    const cid = entry.manifestCid ?? key;
    map.set(cid, { roles: entry.roles });
  }
  return {
    get: (cid: string) => map.get(cid),
    manifestCids: () => [...map.keys()],
  };
}

/**
 * Resolves a launched SolverNet manifest by IPFS CID.
 *
 * Engine-internal contract; the production wiring passes
 * `IdentityRegistryBackedSolverNetRegistryClient` (Task 4 of
 * `spec/2026-05-05-solvernet-creation-and-launch.md`), which fetches the
 * manifest from IPFS and verifies the canonical hash before returning.
 *
 * Per spec §14, task validation goes manifest → contract → schemas:
 * the engine resolves the task's `solverNetManifestCid`, reads
 * `manifest.contract.{id, version}`, and validates the task body against
 * that contract's schema. The legacy `solverType`-keyed schema lookup
 * is retired here.
 *
 * Optional — when absent, engines without a registry wired (e.g. unit
 * tests for non-validation paths) skip task-body schema validation.
 */
export interface ManifestResolver {
  getManifest(args: { manifestCid: string }): Promise<SolverNetManifestV1>;
}

// ── Engine options ────────────────────────────────────────────────────────────

export interface TaskEngineOptions {
  store: Store;
  paths: {
    workingDirRoot: string;
    implStateDirRoot: string;
  };
  /**
   * Packaging dependencies. When provided, pack() is functional.
   * When absent, pack() falls back to NotImplementedError.
   *
   * `requestId` is filled per-call by the engine from the in-flight task;
   * `collector` is wired per-call from `trajectoryCollectors`.
   */
  packagingDeps?: Omit<PackagingDeps, 'requestId' | 'collector'>;
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
   * Impl registry for resolving which Harness to run.
   * When provided and findFor() returns an impl, runImpl() dispatches to it.
   */
  implRegistry?: ImplRegistry;
  solverNetRegistry?: SolverNetRegistryLike;
  /**
   * Per-launch operator eligibility filter (Task 28 of
   * `spec/2026-05-05-solvernet-creation-and-launch.md`).
   *
   * When wired, `canAcceptTask` filters incoming tasks by
   * `manifestDigest = keccak256(task.solverNetManifestCid)` against the set
   * of CIDs the operator has joined, plus a role gate
   * (restoration → 'solver', evaluation → 'evaluator'). Tasks whose
   * `manifestDigest` doesn't match any joined CID are rejected before any
   * harness is consulted — this disambiguates "Launcher A's Prediction" from
   * "Launcher B's Prediction" even when they share the same SolverNet
   * contract.
   *
   * Optional — engines without it (legacy unit tests, in-memory adapter)
   * fall back to the prior solverType-keyed eligibility path on the
   * SolverNet registry.
   */
  joinedSolverNets?: JoinedSolverNetsView;
  /**
   * Resolves a launched SolverNet manifest by `solverNetManifestCid`.
   * Required for production wiring; tests that don't exercise schema
   * validation can omit it.
   *
   * See `ManifestResolver` and `spec/2026-05-05-solvernet-creation-and-launch.md` §14.
   */
  manifestResolver?: ManifestResolver;
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
   * successful evaluator-side `claimDelivery`, so the harness's agent NFT
   * accrues a rating per DR §4.3. Requires:
   *
   *   - `client`: a `ReputationRegistryClient` (writes are routed through the
   *     evaluator's Safe so `msg.sender` matches the operator identity).
   *   - `resolveAgentId`: looks up the harness's `agentId` from the parent
   *     manifest's `evidenceHash`. Returns `null` when no match is found
   *     (subgraph not yet indexed; envelope not published) — the engine
   *     skips feedback gracefully without failing delivery.
   *
   * Failures inside the hook are logged but NEVER fatal: JinnRouter's
   * `claimDelivery` is the authoritative settlement. Restoration-only
   * tasks skip this branch entirely.
   *
   * Optional — when absent, the engine simply skips feedback.
   */
  reputationFeedback?: {
    client: ReputationRegistryClient;
    resolveAgentId: (manifestHash: `0x${string}`) => Promise<ResolvedAgent | null>;
  };
  /**
   * Operator-local artifact serving config (Phase A.1, jinn-mono-vy37.1.3).
   *
   * `publicEndpoint` is the externally-reachable base URL stamped onto every
   * artifact + trajectory `access.endpoint`. `defaultPriceUsdc` and
   * `perArtifactTypePrice` are pinned here so the engine doesn't have to thread
   * them through `packagingDeps` separately for trajectory refs.
   *
   * Required for production wiring; tests may construct a synthetic value.
   */
  operatorConfig?: {
    publicEndpoint: string;
    defaultPriceUsdc: string;
    perArtifactTypePrice: Record<string, string>;
    donation?: { enabled: boolean };
  };
  /**
   * Harness execution mode from operator config (JinnConfig.harness.mode).
   * Controls whether implStateDir writes are permitted during each Task run.
   *
   * 'train' (default): harness may mutate implStateDir — normal learning mode.
   * 'frozen': freeze-fence enforces read-only implStateDir; violations cause
   *   the envelope to be rejected and the task to fail.
   *
   * Defaults to 'train' when absent so existing callers are unaffected.
   *
   * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.3
   */
  harnessMode?: 'train' | 'frozen';
}

// ── Recovery report ───────────────────────────────────────────────────────────

/** Per-task outcome from a recovery pass. */
export interface RecoveryReport {
  requestId: string;
  outcome: 'ok' | 'failed';
  error?: string;
}

// ── TaskEngine ─────────────────────────────────────────────────────────

export class TaskEngine {
  protected readonly persistence: TaskRunPersistence;
  protected readonly paths: TaskEngineOptions['paths'];
  protected readonly packagingDeps: TaskEngineOptions['packagingDeps'];
  protected readonly envelopeDeps: TaskEngineOptions['envelopeDeps'];
  protected readonly deliveryDeps: TaskEngineOptions['deliveryDeps'];
  protected readonly implRegistry: TaskEngineOptions['implRegistry'];
  protected readonly solverNetRegistry: TaskEngineOptions['solverNetRegistry'];
  protected readonly joinedSolverNets: TaskEngineOptions['joinedSolverNets'];
  protected readonly manifestResolver: TaskEngineOptions['manifestResolver'];
  protected readonly identityPublisher: TaskEngineOptions['identityPublisher'];
  protected readonly reputationFeedback: TaskEngineOptions['reputationFeedback'];
  protected readonly operatorConfig: TaskEngineOptions['operatorConfig'];
  /**
   * Operator-configured harness mode. Defaults to 'train' when absent.
   * Propagated to HarnessContext.mode for each runImpl dispatch.
   */
  protected readonly harnessMode: 'train' | 'frozen';
  /** Local SQLite-backed store; used to emit `restoration-result` /
   *  `evaluation-verdict` artifact rows when a cycle completes via a
   *  deterministic impl (the legacy claude/MCP path writes them itself). */
  protected readonly store: Store;

  // Transient storage for impl output between runImpl and pack transitions.
  // Keyed by requestId; cleared after successful pack.
  private readonly solutionOutputs = new Map<string, Solution>();

  // Transient storage for the harness mode used during runImpl.
  // Keyed by requestId; cleared after successful pack.
  private readonly modesByRequest = new Map<string, 'train' | 'frozen'>();

  // Transient storage for the codeDigest returned by the freeze-fence.
  // In train mode this is the post-run hash; in frozen mode it's the stable pre-hash.
  // Keyed by requestId; cleared after successful pack.
  private readonly codeDigestsByRequest = new Map<string, string>();

  // Transient storage for trajectory collectors produced in runImpl.
  // emitTrajectory is deferred to pack() so that artifact spans can be added
  // before the trajectory is finalised and uploaded (Task 16 bidirectional linkage).
  // Keyed by requestId; cleared after successful pack.
  // Protected (not private) to allow test subclasses to inject collectors.
  protected readonly trajectoryCollectors = new Map<string, TrajectoryCollector>();

  // Transient storage for trajectory CID+sha256 refs produced by runImpl.
  // Keyed by requestId; cleared after successful pack.
  private readonly trajectoryRefs = new Map<string, { cid: string; sha256: string; sources?: ArtifactSource[] } | null>();
  private readonly runtimePluginsByRequest = new Map<string, RuntimePlugin[]>();

  /** Set by stop(); causes runTickLoop to exit at the next iteration. */
  private stopped = false;

  constructor(opts: TaskEngineOptions) {
    this.persistence = new TaskRunPersistence(opts.store.db);
    this.store = opts.store;
    this.paths = opts.paths;
    this.packagingDeps = opts.packagingDeps;
    this.envelopeDeps = opts.envelopeDeps;
    this.deliveryDeps = opts.deliveryDeps;
    this.implRegistry = opts.implRegistry;
    this.solverNetRegistry = opts.solverNetRegistry;
    this.joinedSolverNets = opts.joinedSolverNets;
    this.manifestResolver = opts.manifestResolver;
    this.identityPublisher = opts.identityPublisher;
    this.reputationFeedback = opts.reputationFeedback;
    this.operatorConfig = opts.operatorConfig;
    this.harnessMode = opts.harnessMode ?? 'train';
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Called when an task is observed from an on-chain event.
   * Persists a DISCOVERED row. Idempotent: if the row already exists, no-op.
   */
  async observe(input: PersistedTaskRunInput): Promise<void> {
    const existing = this.persistence.getByRequestId(input.requestId);
    if (!existing) {
      this.persistence.insertDiscovered(input);
      console.log(`[harness-engine] observed task ${input.requestId} solverType=${input.solverType ?? 'null'}`);
    }
  }

  async canAcceptTask(input: {
    solverType?: string;
    taskRole?: 'restoration' | 'evaluation';
    task?: Task;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const reason = await this.runnableFailureReason(input.solverType, input.taskRole ?? 'restoration', input.task);
    return reason ? { ok: false, reason } : { ok: true };
  }

  /**
   * Recover all in-flight tasks from persisted state.
   * Called at daemon startup before beginning normal event processing.
   * Returns a per-task report for each task attempted.
   */
  async recoverInFlight(): Promise<RecoveryReport[]> {
    const inflight = this.persistence.getInFlight();
    const results = await Promise.allSettled(
      inflight.map((task) => this._recoverOne(task)),
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
    console.log(`[harness-engine] recovery: ${okCount}/${reports.length} tasks resumed`);

    return reports;
  }

  /**
   * Periodic tick: advance every in-flight task by one transition.
   * Called by `runTickLoop` so that tasks which entered a non-event-driven
   * state (e.g. CLAIMED waiting for windowStartTs) get re-driven without
   * waiting for a daemon restart or a fresh marketplace event.
   *
   * Errors from individual tasks are logged but do not stop the loop.
   */
  async tick(): Promise<void> {
    const inflight = this.persistence.getInFlight();
    const results = await Promise.allSettled(
      inflight.map((task) => this.process(task.requestId)),
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === 'rejected') {
        const requestId = inflight[i]!.requestId;
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.warn(`[harness-engine] tick: process(${requestId}) failed: ${reason}`);
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
        console.error('[harness-engine] tick loop error (continuing):', err instanceof Error ? err.message : err);
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
   * Process a single task: dispatch by current state to the appropriate
   * transition. Drives one state transition per call.
   *
   * Called both by recovery and by the ongoing event-processing loop.
   */
  async process(requestId: string): Promise<void> {
    const task = this.persistence.getByRequestId(requestId);
    if (!task) {
      throw new Error(`process: task not found: ${requestId}`);
    }

    switch (task.state) {
      case TaskRunState.DISCOVERED:
        await this._runTransition(task, () => this.claim(task));
        break;

      case TaskRunState.CLAIMED: {
        // Advance to WAITING — persist-before-invoke principle.
        const oldState = task.state;
        this.persistence.transition(task.requestId, TaskRunState.WAITING);
        console.log(`[harness-engine] ${requestId} ${oldState} → ${TaskRunState.WAITING}`);
        break;
      }

      case TaskRunState.WAITING: {
        const advance = this.dataDrivenAdvance(task);
        if (advance !== null) {
          this.persistence.transition(task.requestId, advance);
          console.log(`[harness-engine] ${requestId} ${task.state} → ${advance}`);
          await this._runTransition(
            this.persistence.getOrThrow(requestId),
            () => this.takePreSnapshot(this.persistence.getOrThrow(requestId)),
          );
          // takePreSnapshot transitions PRE_SNAPSHOT → RUNNING. Re-dispatch on
          // the post-transition state so RUNNING fires in the same pass (jinn-mono-sae).
          const after = this.persistence.getByRequestId(task.requestId);
          if (after && after.state === TaskRunState.RUNNING) {
            await this.process(task.requestId);
          }
        }
        // else: not yet time — caller is responsible for scheduling retry
        break;
      }

      case TaskRunState.PRE_SNAPSHOT: {
        const advance = this.dataDrivenAdvance(task);
        if (advance !== null) {
          // Snapshot already captured (e.g. recovered from crash mid-transition)
          this.persistence.transition(task.requestId, advance);
          console.log(`[harness-engine] ${requestId} ${task.state} → ${advance}`);
          await this._runTransition(
            this.persistence.getOrThrow(requestId),
            () => this.runImpl(this.persistence.getOrThrow(requestId)),
          );
        } else {
          await this._runTransition(task, () => this.takePreSnapshot(task));
          // takePreSnapshot transitions PRE_SNAPSHOT → RUNNING internally.
          // Re-dispatch on the post-transition state so the RUNNING case fires
          // in the same pass (jinn-mono-sae fix). Without this, tasks stall
          // at RUNNING until the next tick/restart and runImpl never executes.
          const after = this.persistence.getByRequestId(task.requestId);
          if (after && after.state === TaskRunState.RUNNING) {
            await this.process(task.requestId);
          }
        }
        break;
      }

      case TaskRunState.RUNNING:
        await this._runTransition(task, () => this.runImpl(task));
        break;

      case TaskRunState.POST_SNAPSHOT: {
        const advance = this.dataDrivenAdvance(task);
        if (advance !== null) {
          this.persistence.transition(task.requestId, advance);
          console.log(`[harness-engine] ${requestId} ${task.state} → ${advance}`);
          await this._runTransition(
            this.persistence.getOrThrow(requestId),
            () => this.pack(this.persistence.getOrThrow(requestId)),
          );
        } else {
          await this._runTransition(task, () => this.takePostSnapshot(task));
        }
        break;
      }

      case TaskRunState.PACKAGING:
        await this._runTransition(task, () => this.pack(task));
        break;

      case TaskRunState.DELIVERING:
        await this._runTransition(task, () => this.deliver(task));
        break;

      case TaskRunState.COMPLETE:
      case TaskRunState.FAILED:
        // Terminal — nothing to do.
        break;
    }
  }

  // ── Transition stubs ────────────────────────────────────────────────────────
  // Stubs throw NotImplementedError. claim() is implemented here; others are
  // filled in by subsequent tasks.

  /**
   * TaskCoordinator clean-break claim transition.
   *
   * The on-chain Task claim happens before observe(), producing the internal
   * Mech requestId stored in this row. The engine's CLAIM step now only verifies
   * the operator has an enabled, ready Harness and advances DISCOVERED → CLAIMED.
   */
  protected async claim(task: PersistedTaskRun): Promise<void> {
    const reason = await this.runnableFailureReason(
      task.solverType ?? undefined,
      task.taskRole ?? 'restoration',
      task.task as Task | undefined,
      task.requestId,
    );
    if (reason) {
      this.persistence.markFailed(task.requestId, reason);
      console.log(`[harness-engine] ${task.requestId}: skipping claimed task — ${reason}`);
      throw new Error(reason);
    }

    // The event path and tick loop can race on the same DISCOVERED row; if
    // another caller already advanced it, treat this as idempotent.
    const current = this.persistence.getByRequestId(task.requestId);
    if (!current) {
      throw new Error(`claim: task not found after claim: ${task.requestId}`);
    }
    if (current.state === TaskRunState.DISCOVERED) {
      this.persistence.transition(task.requestId, TaskRunState.CLAIMED);
    } else {
      console.log(
        `[harness-engine] ${task.requestId}: claim completed but state is already ${current.state}; skipping CLAIMED transition`,
      );
    }
  }

  async releaseClaimedNotStarted(): Promise<string[]> {
    // TaskCoordinator claims are made before observe(), so there is no
    // recoverable "claimed but not started" engine row to release here.
    return [];
  }

  /**
   * Internal routing key alias for the daemon-internal `solverType`-keyed
   * harness map. Per spec §15 (non-goal of
   * `spec/2026-05-05-solvernet-creation-and-launch.md`), the harness
   * dispatch alias is intentionally retained for one cycle past Task 30;
   * the user-facing surface (manifest, SPA, SDK shapes) is `solverType`-
   * free. Prefers the canonical `${contractId}.${contractVersion}` when
   * the task carries them, and falls back to the legacy `task.solverType`
   * field for pre-Task-24 shapes / health-check tasks. Mirrors the SDK's
   * internal `solverTypeAlias` helper but operates on a `Task`.
   */
  private routingKeyForTask(task: Task | undefined, fallback?: string): string | undefined {
    if (task?.contractId && task?.contractVersion) {
      return `${task.contractId}.${task.contractVersion}`;
    }
    return task?.solverType ?? fallback;
  }

  /**
   * Resolve the task's `solverNetManifestCid` via the registry, fetch the
   * manifest, and validate the task body against `manifest.contract.schemas.task`.
   *
   * Returns `null` when validation passes (or is skipped because no
   * `manifestResolver` is wired and the task carries no `solverNetManifestCid`),
   * or a human-readable failure reason otherwise.
   *
   * Day-1 compatibility note: this validates via the SDK template's Zod schema
   * looked up by `{contract.id, contract.version}`. The manifest's embedded
   * JSON Schema is the canonical wire format; once external launchers can
   * publish manifests with arbitrary task schemas, this will switch to a JSON
   * Schema validator (or `jsonSchemaToZod`) over the manifest's own schema.
   * See `spec/2026-05-05-solvernet-creation-and-launch.md` §14.
   */
  private async manifestBackedValidation(task: Task): Promise<string | null> {
    const cid = task.solverNetManifestCid;
    if (!cid) {
      // Without a manifest CID, schema validation can't run via the §14
      // pipeline. Production callers (mech adapter) require CIDs at task
      // post-time — this branch is hit only by tests / health-check tasks
      // that don't exercise schema validation. The legacy
      // `solverType`-keyed validation path was retired here.
      return null;
    }
    if (!this.manifestResolver) {
      // Engine wasn't constructed with a registry. Tests that don't exercise
      // manifest resolution leave this unwired; treat schema validation as
      // a no-op rather than failing — the daemon's production wiring always
      // supplies a resolver.
      return null;
    }

    let manifest: SolverNetManifestV1;
    try {
      manifest = await this.manifestResolver.getManifest({ manifestCid: cid });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `manifest resolution failed for cid '${cid}': ${message}`;
    }

    const ref = { id: manifest.contract.id, version: manifest.contract.version };

    // Defense against malformed task documents: if the task carries explicit
    // `contractId`/`contractVersion`, they MUST agree with the manifest.
    if (task.contractId !== undefined && task.contractId !== ref.id) {
      return `task.contractId '${task.contractId}' does not match manifest contract.id '${ref.id}'`;
    }
    if (task.contractVersion !== undefined && task.contractVersion !== ref.version) {
      return `task.contractVersion '${task.contractVersion}' does not match manifest contract.version '${ref.version}'`;
    }

    // Day-1 compatibility: validate via the SDK template's Zod for the
    // resolved contract. Day-N (external launchers) will validate against
    // `manifest.contract.schemas.task` directly via JSON Schema.
    const sdkContract = getSolverNetContract(ref);
    if (!sdkContract) {
      return `unsupported contract '${ref.id}.${ref.version}' from manifest '${cid}'`;
    }
    const parsed = sdkContract.schemas.task.zod.safeParse(task);
    if (!parsed.success) {
      const parsedSpec = task.spec !== undefined
        ? sdkContract.schemas.task.zod.safeParse(task.spec)
        : undefined;
      if (parsedSpec?.success) return null;

      const specIssuesLookLikeWholeTask =
        parsedSpec !== undefined &&
        parsedSpec.error.issues.some((issue: ZodIssue) => {
          const head = issue.path[0];
          return typeof head === 'string' && ['id', 'description', 'solverType', 'window', 'claimPolicy', 'spec'].includes(head);
        });
      const selected = parsedSpec !== undefined && !specIssuesLookLikeWholeTask ? parsedSpec : parsed;
      const issues = selected.error.issues
        .map((issue: ZodIssue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
        .join('; ');
      const scope = selected === parsedSpec ? 'task.spec' : 'task';
      return `${ref.id}.${ref.version} ${scope} failed validation: ${issues}`;
    }
    return null;
  }

  /**
   * Returns a human-readable failure reason when the task is NOT eligible
   * for this operator under the manifest-bound per-launch attribution
   * model (spec §14, Task 28), or `null` when the task passes the filter.
   *
   * Eligibility logic:
   *   - The operator must have an entry in `joinedSolverNets` whose
   *     `manifestCid` matches `task.solverNetManifestCid` (or whose
   *     `keccak256(manifestCid)` matches the task's on-chain
   *     `manifestDigest` when only the digest is available).
   *   - The entry's `roles` must include the role required by this task
   *     ('solver' for restoration, 'evaluator' for evaluation).
   *
   * Caller must have already guarded `this.joinedSolverNets` non-null and
   * `task` non-null.
   */
  private evaluateJoinedEligibility(
    task: Task,
    role: 'restoration' | 'evaluation',
  ): string | null {
    const view = this.joinedSolverNets!;
    const requiredRole = joinedRoleForTaskRole(role);

    // Preferred path: the task body carries the manifest CID directly.
    const cid = task.solverNetManifestCid;
    if (cid) {
      const entry = view.get(cid);
      if (!entry) {
        return (
          `task carries solverNetManifestCid '${cid}' but operator has not joined that SolverNet ` +
          `(joinedSolverNets keys: [${view.manifestCids().join(', ') || '<empty>'}])`
        );
      }
      if (!entry.roles.includes(requiredRole)) {
        return (
          `operator joined SolverNet '${cid}' but did not opt into role '${requiredRole}' ` +
          `(roles: [${entry.roles.join(', ')}])`
        );
      }
      return null;
    }

    // Fallback path: task carries an on-chain `manifestDigest` (bytes32
    // hex) without an off-chain CID. Compute keccak256 of every joined CID
    // and compare. Used when the daemon discovers a task via on-chain
    // event before fetching its IPFS body.
    const taskRecord = task as Task & { manifestDigest?: string };
    const taskDigest = taskRecord.manifestDigest;
    if (taskDigest) {
      const wantHex = taskDigest.toLowerCase();
      for (const joinedCid of view.manifestCids()) {
        const joinedDigest = keccak256(toBytes(joinedCid)).toLowerCase();
        if (joinedDigest === wantHex) {
          const entry = view.get(joinedCid)!;
          if (!entry.roles.includes(requiredRole)) {
            return (
              `operator joined SolverNet '${joinedCid}' but did not opt into role '${requiredRole}' ` +
              `(roles: [${entry.roles.join(', ')}])`
            );
          }
          return null;
        }
      }
      return (
        `task manifestDigest '${taskDigest}' does not match any joined SolverNet ` +
        `(joinedSolverNets keys: [${view.manifestCids().join(', ') || '<empty>'}])`
      );
    }

    // Task has neither solverNetManifestCid nor manifestDigest. Per spec §14,
    // post-Task-24 task documents always carry a CID; absence here means a
    // pre-migration / health-check / legacy task. We don't fail those — the
    // legacy solverType-keyed gate downstream still runs.
    return null;
  }

  private async runnableFailureReason(
    solverType: string | undefined,
    role: 'restoration' | 'evaluation',
    task?: Task,
    currentRequestId?: string,
  ): Promise<string | null> {
    // Per-launch operator-eligibility filter (Task 28 of
    // `spec/2026-05-05-solvernet-creation-and-launch.md` §14). When the
    // operator has explicitly joined a set of SolverNets — keyed by the
    // launched manifest's `manifestCid` — the engine refuses to accept any
    // task whose on-chain `manifestDigest = keccak256(manifestCid)` doesn't
    // match a joined entry, plus a role gate (restoration → 'solver',
    // evaluation → 'evaluator'). This replaces the old protocol-level
    // solverType filter and disambiguates Launcher A's Prediction from
    // Launcher B's Prediction. The check is skipped when the engine has no
    // `joinedSolverNets` view wired (legacy unit tests, in-memory adapter).
    if (this.joinedSolverNets && task) {
      const eligibility = this.evaluateJoinedEligibility(task, role);
      if (eligibility) return eligibility;
    }

    // Prefer the contract-derived routing alias when the task carries
    // `contractId`/`contractVersion` (Task 24); fall back to the explicit
    // `solverType` parameter for legacy pre-migration paths and PersistedTaskRun
    // rows that pre-date `contractId`. See `routingKeyForTask`.
    const routingKey = this.routingKeyForTask(task, solverType);
    if (routingKey && this.persistence.hasInFlightFor({
      solverType: routingKey,
      taskRole: role,
      excludeRequestId: currentRequestId,
    })) {
      return `another ${routingKey}/${role} task is already in flight`;
    }
    const solverNet = this.solverNetRegistry && routingKey
      ? this.solverNetRegistry.forSolverType(routingKey, role)
      : undefined;
    if (this.solverNetRegistry && routingKey && !solverNet) {
      return `no enabled SolverNet for solverType '${routingKey}' and role '${role}'; run \`jinn solver-nets enable <name>\``;
    }
    if (task) {
      // Per spec §14 of `spec/2026-05-05-solvernet-creation-and-launch.md`,
      // task validation resolves manifest → contract → schemas:
      //   manifest = registry.getManifest({ manifestCid: task.solverNetManifestCid })
      //   contract = manifest.contract
      //   validateAgainstSchema(task, contract.schemas.task)
      // The legacy `solverType`-keyed `validateTask(solverType, task)` path
      // is retired here; the routing alias is recovered from
      // `manifest.contract.{id, version}` for the harness map lookup
      // (which still keys on the `<id>.<version>` string until Task 30).
      const validationFailure = await this.manifestBackedValidation(task);
      if (validationFailure) return validationFailure;
    }
    if (!this.implRegistry || !routingKey) return null;

    const impl = this.implRegistry.findFor({ solverType: routingKey, role });
    if (!impl) {
      const setHarnessHint = solverNet
        ? `jinn solver-nets set-harness ${solverNet.name} <harness>`
        : 'jinn solver-nets set-harness <name> <harness>';
      return `no Harness registered or enabled for solverType '${routingKey}'; run \`${setHarnessHint}\``;
    }
    if (task) {
      if (impl.canAttempt) {
        const attempt = await impl.canAttempt(task);
        if (!attempt.ok) {
          return `impl '${impl.name}' cannot attempt task: ${attempt.reason}`;
        }
      }
    }
    if (impl.isReady) {
      const status = await impl.isReady({ solverType: routingKey, role });
      if (!status.ready) {
        return `impl '${impl.name}' not ready: ${status.reason ?? 'unknown'}${status.nextStep?.cli ? ` — run \`${status.nextStep.cli}\`` : ''}`;
      }
    }
    return null;
  }

  /**
   * PRE_SNAPSHOT transition: provision workingDir + implStateDir, write
   * task.json + env/ files, create sessions/ directory.
   *
   * Requires no external deps beyond filesystem access — always implemented.
   * Advances state PRE_SNAPSHOT with workingDir + implStateDir patch.
   */
  protected async takePreSnapshot(run: PersistedTaskRun): Promise<void> {
    const workingDir = join(this.paths.workingDirRoot, run.requestId);
    // Resolve the impl via registry so implStateDir matches the path runImpl uses
    // (join(implStateDirRoot, impl.name, solverType)). Falls back to solverType then 'default'
    // when no impl is registered — legacy path preserved for health-check tasks.
    const resolvedImpl = run.solverType
      ? this.implRegistry?.findFor({ solverType: run.solverType, role: run.taskRole ?? 'restoration' }) ?? null
      : null;
    const implStateName = harnessStateDirName(run.implName ?? resolvedImpl?.name ?? run.solverType ?? 'default');
    const kindSeg = (run.solverType ?? '').replace(/[.:]/g, '_');
    const implStateDir = kindSeg
      ? join(this.paths.implStateDirRoot, implStateName, kindSeg)
      : join(this.paths.implStateDirRoot, implStateName);

    // Prefer the persisted full Task; fall back to a stub for legacy
    // (pre-migration) rows so the engine still works for health-check tasks.
    const task = run.task ?? {
      id: run.requestId,
      description: '',
      ...(run.solverType ? { solverType: run.solverType, spec: {} } : {}),
      role: run.taskRole ?? 'restoration',
      window: { startTs: run.windowStartTs, endTs: run.windowEndTs },
    };

    provisionWorkingDir(workingDir, task as import('../../types/task.js').Task);
    provisionImplStateDir(implStateDir);

    // takePreSnapshot transitions directly to RUNNING with the snapshot payload
    // and workingDir/implStateDir paths set.  We cannot transition
    // PRE_SNAPSHOT → PRE_SNAPSHOT (invalid); the snapshot is immediately ready
    // (it's just the provisioned dir context), so we advance to RUNNING in one
    // step.  The impl is responsible for capturing real market data.
    this.persistence.transition(run.requestId, TaskRunState.RUNNING, {
      workingDir,
      implStateDir,
      preSnapshotCapturedAt: Date.now(),
      preSnapshotPayload: { provisioned: true, workingDir },
    });
    console.log(`[harness-engine] ${run.requestId} PRE_SNAPSHOT -> RUNNING: workingDir=${workingDir}`);
  }

  /**
   * RUNNING transition: dispatch to a Harness if implRegistry is provided.
   *
   * When no impl is found for the solverType, falls back to NotImplementedError
   * so the engine does not silently swallow the request. In tests that don't
   * exercise the impl path, override this method.
   *
   * Captures impl output in `solutionOutputs` map for pack() to consume. Also
   * records a minimal post-snapshot so data-driven advance can fire.
   */
  protected async runImpl(task: PersistedTaskRun): Promise<void> {
    // The persisted `solver_type` column is authoritative for harness
    // dispatch — it was derived at observation time from the canonical
    // `${contractId}.${contractVersion}` alias (see Task 24's TaskCreated
    // path). Internal routing key only — Task 30 retires the legacy
    // string-keyed harness map.
    const solverType = task.solverType ?? '';
    const role = task.taskRole ?? 'restoration';
    const solverNet = solverType ? this.solverNetRegistry?.forSolverType(solverType, role) : undefined;
    const impl = this.implRegistry?.findFor({ solverType, role });
    if (!impl) {
      throw new NotImplementedError('runImpl');
    }
    const runtimePlugins: RuntimePlugin[] = solverNet?.runtimePlugins ?? [];
    this.runtimePluginsByRequest.set(task.requestId, runtimePlugins);

    const workingDir = task.workingDir ?? join(this.paths.workingDirRoot, task.requestId);
    const kindSeg = solverType.replace(/[.:]/g, '_');
    const implStateDir = task.implStateDir ?? (
      kindSeg
        ? join(this.paths.implStateDirRoot, harnessStateDirName(impl.name), kindSeg)
        : join(this.paths.implStateDirRoot, harnessStateDirName(impl.name))
    );
    const windowEndTs = task.windowEndTs;

    const abort = new AbortController();
    const msUntilEndTs = () => Math.max(0, windowEndTs - Date.now());
    const endTimer = setTimeout(() => abort.abort(), msUntilEndTs());

    // Create a trajectory collector for this run.
    const trajectory = new TrajectoryCollector({
      taskCid: task.taskCid ?? '',
      runId: randomUUID(),
    });

    try {
      const ctx: HarnessContext = {
        task: (task.task ?? {
          id: task.requestId,
          description: '',
          ...(task.solverType ? { solverType: task.solverType, spec: {} } : {}),
          role,
          window: { startTs: task.windowStartTs, endTs: task.windowEndTs },
        }) as import('../../types/task.js').Task,
        requestId: task.requestId,
        taskCid: task.taskCid,
        solverNet: solverNet
          ? {
              name: solverNet.name,
              solverType: solverNet.solverType,
              ...(solverNet.model ? { model: solverNet.model } : {}),
            }
          : undefined,
        runtimePlugins,
        solverPluginRoots: runtimePlugins.map((plugin) => plugin.root),
        implStateDir,
        workingDir,
        log: (event: { level: string; msg: string; data?: unknown }) => {
          console.log(`[harness-impl:${impl.name}] [${event.level}] ${event.msg}`, event.data ?? '');
        },
        abort: abort.signal,
        msUntilEndTs,
        trajectory,
        mode: this.harnessMode,
      };

      // Run the harness through the freeze-fence so frozen-mode violations
      // are detected, rolled back, and surfaced as a structured event before
      // envelope assembly (spec §6.3). SkippableError thrown by the harness
      // will bubble out of the fence and be caught below.
      let fence: Awaited<ReturnType<typeof runHarnessWithFreezeFence>>;
      try {
        fence = await runHarnessWithFreezeFence(impl, ctx);
      } catch (err) {
        if (err instanceof SkippableError) {
          const skippedAt = Date.now();
          const detail = err.message;
          console.warn(
            `[harness-engine] ${task.requestId}: impl=${impl.name} skipped (${err.reason}): ${detail}`,
          );
          const skippedOutput: Solution = {
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
          this.solutionOutputs.set(task.requestId, skippedOutput);
          this.modesByRequest.set(task.requestId, ctx.mode);
          // Preserve trajectory for downstream pack() access (Task 6 regression fix).
          this.trajectoryCollectors.set(task.requestId, trajectory);
          // No codeDigest for skipped runs — leave map empty.
          // Fall through to persistence below via goto-equivalent pattern.
          this.persistence.transition(task.requestId, TaskRunState.POST_SNAPSHOT, {
            postSnapshotCapturedAt: Date.now(),
            postSnapshotPayload: { capturedAt: Date.now(), hlTime: 0, payload: null },
            fillsPayload: [],
            gatingClaim: skippedOutput.gating,
            informationalClaim: skippedOutput.informational ?? null,
            solutionOutputsJson: JSON.stringify(skippedOutput),
            implName: impl.name,
            runtimePluginsJson: JSON.stringify(runtimePlugins),
          });
          console.log(`[harness-engine] ${task.requestId} RUNNING → POST_SNAPSHOT via impl=${impl.name} (skipped)`);
          return;
        }
        throw err;
      }

      if (!fence.ok) {
        // Violation: the harness mutated implStateDir in frozen mode.
        // Snapshot already restored by the fence. Emit a structured log,
        // skip envelope assembly, and mark the task FAILED.
        ctx.log({
          level: 'error',
          msg: 'Harness violated frozen-mode contract — envelope rejected',
          data: fence.violation,
        });
        this.persistence.markFailed(
          task.requestId,
          `freeze-fence violation: implStateDir mutated in frozen mode (harness=${fence.violation.harnessName}@${fence.violation.harnessVersion})`,
        );
        return;
      }

      // Store the codeDigest from the fence (post-run hash in train mode;
      // stable pre-hash in frozen mode) for use in pack().
      this.codeDigestsByRequest.set(task.requestId, `sha256:${fence.codeDigest}`);
      this.modesByRequest.set(task.requestId, ctx.mode);

      const output = fence.output;
      this.solutionOutputs.set(task.requestId, output);

      // Store the trajectory collector so pack() can:
      //   1. pass it to uploadArtifacts (artifact.emit spans + producedBy metadata)
      //   2. call emitTrajectory AFTER artifact upload so spans are included
      //   3. backfill trajectoryCid on artifacts before envelope assembly
      // emitTrajectory is intentionally deferred to pack() (Task 16).
      this.trajectoryCollectors.set(task.requestId, trajectory);

      // Persist impl output BEFORE the state transition so that a crash after
      // the transition (RUNNING → POST_SNAPSHOT) but before pack() runs will
      // find the serialised output in the DB on restart. pack() will hydrate the
      // in-memory map from solutionOutputsJson if the map entry is absent (#6).
      // Capture post-snapshot from impl output so data-driven advance fires
      this.persistence.transition(task.requestId, TaskRunState.POST_SNAPSHOT, {
        postSnapshotCapturedAt: Date.now(),
        postSnapshotPayload: output.postSnapshot ?? { capturedAt: Date.now(), hlTime: 0, payload: null },
        fillsPayload: output.fills ?? [],
        gatingClaim: output.gating,
        informationalClaim: output.informational ?? null,
        solutionOutputsJson: JSON.stringify(output),
        implName: impl.name,
        runtimePluginsJson: JSON.stringify(runtimePlugins),
      });
    } finally {
      clearTimeout(endTimer);
    }
    console.log(`[harness-engine] ${task.requestId} RUNNING → POST_SNAPSHOT via impl=${impl.name}`);
  }

  protected async takePostSnapshot(_intent: PersistedTaskRun): Promise<void> {
    throw new NotImplementedError('takePostSnapshot');
  }

  /**
   * PACKAGING transition: walk workingDir, upload artifacts, assemble + sign
   * envelope, upload envelope, persist envelope CID + artifact CIDs.
   *
   * Requires packagingDeps + envelopeDeps. When absent, falls back to
   * NotImplementedError.
   */
  protected async pack(task: PersistedTaskRun): Promise<void> {
    // Hydrate implOutput from DB if the in-memory map was lost (e.g. process restart
    // after RUNNING → POST_SNAPSHOT but before pack() completed). This must run
    // BEFORE the packagingDeps guard so subclass overrides that call super.pack()
    // can still benefit from hydration even when packagingDeps is absent (#6).
    if (!this.solutionOutputs.has(task.requestId) && task.solutionOutputsJson != null) {
      try {
        const recovered = JSON.parse(task.solutionOutputsJson) as Solution;
        this.solutionOutputs.set(task.requestId, recovered);
        console.log(`[harness-engine] ${task.requestId}: hydrated solutionOutputs from DB (crash recovery)`);
      } catch (err) {
        console.warn(`[harness-engine] ${task.requestId}: failed to hydrate solutionOutputsJson: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (!this.packagingDeps || !this.envelopeDeps) {
      throw new NotImplementedError('pack');
    }

    const workingDir = task.workingDir ?? join(this.paths.workingDirRoot, task.requestId);

    const implOutput = this.solutionOutputs.get(task.requestId);
    const implArtifacts = implOutput?.artifacts ?? [];

    // 1. Walk + upload artifacts (NO registration yet — manifest CID not known).
    // Pass the trajectory collector (if present) so uploadArtifacts can emit
    // jinn.artifact.emit spans and attach producedBy back-refs (Task 16 forward
    // linkage). emitTrajectory is called AFTER upload so artifact spans are included.
    const collector = this.trajectoryCollectors.get(task.requestId);
    const packagingDepsWithReq: PackagingDeps = {
      ...this.packagingDeps,
      requestId: task.requestId,
      ...(collector ? { collector } : {}),
    };
    const rawArtifacts = await walkArtifacts(
      workingDir,
      implArtifacts,
      packagingDepsWithReq.donation?.enabled
        ? { scrub: packagingDepsWithReq.donation.scrub }
        : {},
    );
    const uploadedArtifacts = await uploadArtifacts(rawArtifacts, packagingDepsWithReq);

    // 1b. Emit trajectory to IPFS now that all artifact spans have been added.
    // Non-fatal — envelope assembly continues with envelope.trajectory = null if upload fails.
    let trajectoryRef: { cid: string; sha256: string; sources?: ArtifactSource[] } | null =
      this.trajectoryRefs.get(task.requestId) ?? null;
    if (!trajectoryRef && collector && this.envelopeDeps) {
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const account = privateKeyToAccount(this.envelopeDeps.agentEoaPrivateKey);
        const { cid, sha256, signed } = await emitTrajectory({
          collector,
          runId: collector.runId,
          signerPrivateKey: this.envelopeDeps.agentEoaPrivateKey,
          signerAddress: account.address as `0x${string}`,
          ipfsRegistryUrl: this.envelopeDeps.ipfsRegistryUrl,
          scrub: packagingDepsWithReq.donation?.scrub,
        });
        const sources: ArtifactSource[] = [];
        if (packagingDepsWithReq.donation?.enabled) {
          const sourceCid = await uploadToIpfs(packagingDepsWithReq.donation.ipfsRegistryUrl, {
            schemaVersion: DONATION_ARTIFACT_ENCODING,
            artifactType: 'jinn.trajectory.v1',
            sha256,
            encoding: DONATION_ARTIFACT_ENCODING,
            data: Buffer.from(JSON.stringify(signed), 'utf8').toString('base64'),
          });
          sources.push({
            kind: 'ipfs',
            cid: sourceCid,
            sha256,
            encoding: DONATION_ARTIFACT_ENCODING,
          });
        }
        trajectoryRef = { cid, sha256, ...(sources.length > 0 ? { sources } : {}) };
        console.log(`[harness-engine] ${task.requestId}: trajectory emitted cid=${cid}`);
      } catch (err) {
        console.warn(
          `[harness-engine] ${task.requestId}: trajectory emit failed (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    this.trajectoryRefs.set(task.requestId, trajectoryRef);

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
    const preSnapshotPayload = task.preSnapshotPayload as { capturedAt?: number; hlTime?: number; payload?: unknown } | null;
    const postSnapshotPayload = task.postSnapshotPayload as { capturedAt?: number; hlTime?: number; payload?: unknown } | null;

    // The solverType drives payload schema selection. Fall back to 'legacy.v0'
    // for tasks without a solverType (legacy health-check / daemon-loop-test
    // tasks that use the legacy-claude impl). The legacy.v0 kind accepts any
    // Record payload so validatePayload does not reject the output.
    const solverType = task.solverType ?? 'legacy.v0';

    // Derive role from Task.role. Evaluator tasks produce 'verdict' envelopes;
    // all other tasks produce 'restoration' envelopes.
    const isEvaluation = task.taskRole === 'evaluation';
    const role: Role = isEvaluation ? 'verdict' : 'restoration';

    let envelopePayload: Record<string, unknown>;

    if (isEvaluation) {
      // ── Verdict envelope payload ──────────────────────────────────────────────
      // The evaluator impl populates verdictPayload on Solution with a
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
          `pack: evaluator impl for ${task.requestId} did not produce verdictPayload on Solution; ` +
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
    } else if (implOutput?.solutionPayload) {
      // ── Non-portfolio restoration envelope payload ────────────────────────────
      // Impls for kinds with a non-portfolio payload schema (e.g. prediction.v1)
      // declare their own fully-formed payload. Engine passes it through directly
      // so validatePayload() can check it against the per-kind schema.
      envelopePayload = implOutput.solutionPayload;
    } else {
      // ── Portfolio restoration envelope payload (legacy / portfolio.v0) ─────────
      envelopePayload = {
        preSnapshot: {
          capturedAt: task.preSnapshotCapturedAt ?? Date.now(),
          hlTime: preSnapshotPayload?.hlTime ?? 0,
          // Double-fallback: first tries the structured .payload field (normal shape),
          // then falls back to the whole payload object (handles takePreSnapshot's
          // synthetic shape where the snapshot IS the top-level object, not nested).
          payload: preSnapshotPayload?.payload ?? preSnapshotPayload ?? {},
        },
        postSnapshot: {
          capturedAt: task.postSnapshotCapturedAt ?? Date.now(),
          hlTime: postSnapshotPayload?.hlTime ?? 0,
          // Same double-fallback as above.
          payload: postSnapshotPayload?.payload ?? postSnapshotPayload ?? {},
        },
        fills: (task.fillsPayload as unknown[]) ?? [],
        gating: (task.gatingClaim as Record<string, unknown>) ?? {},
        ...(task.informationalClaim != null
          ? { informational: task.informationalClaim as Record<string, unknown> }
          : {}),
        ...(implOutput?.rationale != null ? { rationale: implOutput.rationale } : {}),
      };
    }

    // 4. Persist generatedAt once (first pack); reuse on retry for CID determinism.
    const generatedAt: number = task.manifestGeneratedAt ?? Date.now();
    if (!task.manifestGeneratedAt) {
      // Persist before assembling so that a crash after assembly but before
      // transition still gets the same generatedAt on the next attempt.
      this.persistence.setManifestGeneratedAt(task.requestId, generatedAt);
    }

    // 5. Assemble + sign envelope → envelope CID now known.
    // trajectoryRef was computed in step 1b above (emitted after artifact upload).
    // Per the post-gating-fix schema, trajectory references carry sha256 + access
    // (the operator HTTP endpoint that serves the bytes). Phase 3 (jinn-mono-vy37.1.3)
    // sources this from the engine's operatorConfig; absent operatorConfig (e.g. test
    // fixtures) falls back to packagingDeps.operatorEndpoint, then to a localhost
    // sentinel so suites that don't exercise the publish path still pack cleanly.
    const operatorEndpointForTraj =
      this.operatorConfig?.publicEndpoint
      ?? this.packagingDeps?.operatorEndpoint
      ?? 'http://localhost:7331';
    const envelopeTrajectory = trajectoryRef
      ? {
          sha256: trajectoryRef.sha256,
          access: { endpoint: operatorEndpointForTraj, priceUsdc: '0' },
          ...(trajectoryRef.sources && trajectoryRef.sources.length > 0
            ? { sources: trajectoryRef.sources }
            : {}),
        }
      : null;

    // evidenceTier reflects the on-chain commitment state at the time of signing.
    // For the V2 claim flow, claimDelivery will write an evidenceHash on-chain,
    // so the envelope should be declared 'committed'. For V1 or unknown flows,
    // 'self-signed' is accurate (no on-chain hash commitment).
    const evidenceTier: import('../../types/envelope.js').EvidenceTier =
      this.deliveryDeps?.claimDeliveryVariant === 'v2' || this.deliveryDeps?.claimDeliveryVariant === 'v3'
        ? 'committed'
        : 'self-signed';
    const runtimePlugins: RuntimePlugin[] =
      this.runtimePluginsByRequest.get(task.requestId)
      ?? (task.runtimePluginsJson ? JSON.parse(task.runtimePluginsJson) as RuntimePlugin[] : []);
    const executorPlugins: Array<{ name: string; version: string; cid?: string; sha256: string }> =
      runtimePlugins
        .map((plugin) => ({
          name: plugin.name,
          version: plugin.version,
          ...(plugin.cid ? { cid: plugin.cid } : {}),
          sha256: plugin.sha256,
        }))
        .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
    const implNameForEnvelope = task.implName ?? solverType;
    const solverNet = solverType
      ? this.solverNetRegistry?.forSolverType(solverType, task.taskRole ?? 'restoration')
      : undefined;
    const runtimeBundleDigest = `sha256:${createHash('sha256')
      .update(JSON.stringify({
        harness: {
          name: implNameForEnvelope,
          version: buildInfo.implVersion,
          codeDigest: buildInfo.codeDigest,
        },
        solverNet: solverNet ? { name: solverNet.name, solverType: solverNet.solverType } : null,
        plugins: executorPlugins,
      }))
      .digest('hex')}`;

    // Resolve the mode and codeDigest from the in-memory maps populated by
    // runImpl. Defaults: mode = 'train' (backward compat), codeDigest from
    // buildInfo (fallback when runImpl did not run through the fence, e.g.
    // crash-recovery from solutionOutputsJson without a fresh runImpl).
    const executorMode = this.modesByRequest.get(task.requestId) ?? 'train';
    const fenceCodeDigest = this.codeDigestsByRequest.get(task.requestId) ?? buildInfo.codeDigest;

    const envelopeInputs: EnvelopeInputs = {
      solverType,
      role,
      task: {
        cid: task.taskCid,
        onchainCreationTx: task.onchainCreationTx,
        onchainCreationBlock: task.onchainCreationBlock,
        requestId: task.requestId,
      },
      participant: { safeAddress, agentEoa },
      window: { startTs: task.windowStartTs, endTs: task.windowEndTs },
      executor: {
        implName: implNameForEnvelope,
        // buildInfo resolves to real values in production builds; falls back to
        // clearly-labelled placeholders ('dev' / 'sha256:dev-build') when running
        // via tsx without a prior `yarn build` (dev mode).
        implVersion: buildInfo.implVersion,
        clientGitSha: buildInfo.clientGitSha,
        codeDigest: fenceCodeDigest,
        runtimeBundleDigest,
        plugins: executorPlugins,
        signingKey: { kind: 'agent-eoa', pubkey: agentEoa },
        // Propagate the harness execution mode (train | frozen) so the
        // envelope records whether implStateDir was locked during this run.
        mode: executorMode,
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

    // 7. Build artifact sha256 map for persistence.
    // Post-gating-fix (spec §1): artifacts no longer have IPFS CIDs — bytes
    // live in served_artifacts keyed by sha256. We reuse the legacy
    // `artifactCids` persistence column (key: localPath) but populate it with
    // sha256 hashes so downstream readers still get a stable identifier.
    const artifactCids: Record<string, string> = {};
    for (const art of uploadedArtifacts) {
      artifactCids[art.localPath] = art.sha256;
    }

    // Backfill envelope_cid (manifestCid) on every served_artifacts row so
    // the operator can answer manifest-rooted lookups later. Done after the
    // manifest CID is known.
    for (const art of uploadedArtifacts) {
      this.store.setServedArtifactEnvelopeCid(art.sha256, manifestCid);
    }

    // 8. Persist DELIVERING with manifest CID + artifact CIDs + evidence hash.
    //    evidenceHash gets its own dedicated column (not stashed in informationalClaim).
    //    executorMode + executorCodeDigest are also persisted so deliver() can
    //    emit a payload v2 setMetadata after the transient maps are cleared.
    //    See `client/src/erc8004/identity.ts` (publishContentV2) and the
    //    payload-v2 ABI tuple in `abis.ts`.
    this.persistence.transition(task.requestId, TaskRunState.DELIVERING, {
      manifestCid,
      artifactCids,
      evidenceHash: signatureHash,
      executorMode,
      executorCodeDigest: fenceCodeDigest,
    });
    console.log(`[harness-engine] ${task.requestId} PACKAGING → DELIVERING manifestCid=${manifestCid}`);

    // Clean up transient state (no longer needed after DELIVERING)
    this.solutionOutputs.delete(task.requestId);
    this.trajectoryCollectors.delete(task.requestId);
    this.trajectoryRefs.delete(task.requestId);
    this.modesByRequest.delete(task.requestId);
    this.codeDigestsByRequest.delete(task.requestId);
  }

  /**
   * DELIVERING transition: call mech.deliverToMarketplace + JinnRouter.claimDelivery.
   *
   * Requires deliveryDeps. When absent, falls back to NotImplementedError.
   *
   * Crash-recovery safe: if `task.deliveryTxHash` is already set (persisted
   * after a previous deliverToMarketplace call that completed before the process
   * crashed), we skip the deliver step and go straight to claimDelivery.
   */
  protected async deliver(task: PersistedTaskRun): Promise<void> {
    if (!this.deliveryDeps) {
      throw new NotImplementedError('deliver');
    }

    const manifestCid = task.manifestCid;
    if (!manifestCid) {
      throw new Error(`deliver: manifestCid missing for ${task.requestId}`);
    }

    // Guard: v2 claimDelivery requires an evidenceHash — a zero fallback would
    // silently brick staking rewards, so we fail loudly instead.
    const evidenceHash = task.evidenceHash as `0x${string}` | null | undefined;
    if (!evidenceHash && (this.deliveryDeps.claimDeliveryVariant === 'v2' || this.deliveryDeps.claimDeliveryVariant === 'v3')) {
      throw new MissingEvidenceHashError(task.requestId);
    }

    // Capture locals for use in the onDeliveryTxLanded closure.
    const requestId = task.requestId;
    const persistence = this.persistence;

    const { deliveryTxHash, claimTxHash } = await deliverAndClaim(
      requestId as `0x${string}`,
      manifestCid,
      evidenceHash as `0x${string}`,
      this.deliveryDeps,
      // Recovery: pass existing deliveryTxHash so deliverToMarketplace is skipped.
      (task.deliveryTxHash as `0x${string}`) ?? undefined,
      // Persist deliveryTxHash before claimDelivery so recovery can resume from here.
      async (txHash) => {
        persistence.setDeliveryTxHash(requestId, txHash);
      },
      {
        kind: task.taskRole === 'evaluation' ? 'verdict' : 'solution',
        verdictCode: task.taskRole === 'evaluation' ? this.verdictCodeForTask(task) : undefined,
      },
    );

    this.persistence.transition(requestId, TaskRunState.COMPLETE, {
      deliveryTxHash,
    });
    console.log(`[harness-engine] ${requestId} DELIVERING → COMPLETE deliveryTx=${deliveryTxHash} claimTx=${claimTxHash}`);

    // Emit a SQLite artifact row so consumers (release acceptance gate, search
    // API) see this cycle alongside legacy-claude / MCP-emitted rows. The
    // legacy claude path writes via the MCP `submit_restoration_result` tool;
    // deterministic impls (prediction.v1 baseline/evaluator,
    // …) don't go through MCP, so the engine emits on their behalf here.
    // Idempotent: skips when a row for this requestId+tag already exists
    // (legacy path may have already inserted).
    this.emitCycleArtifact(task, manifestCid, evidenceHash);

    // ── ERC-8004 setMetadata — fires AFTER claimDelivery succeeds ────────────
    //
    // Moved here from pack() per PR#37 review2 must-fix #2. 'committed' means
    // "observable on-chain evidenceHash exists" — publishing before claim would
    // lie during failures. evidenceHash comes from task (persisted in
    // DELIVERING state by pack()); idempotent on retry (setMetadata is a pure
    // key-value write; re-running with the same payload is safe).
    //
    // Restoration-only for now. Evaluator setMetadata lands with jinn-mono-2ff.
    if (this.identityPublisher) {
      const taskRoleRaw = task.taskRole ?? 'restoration';
      if (taskRoleRaw === 'restoration') {
        const signatureHash = evidenceHash as `0x${string}` | null | undefined;
        // v0 tier rule: with an evidenceHash on chain we declare `committed` (tier=1);
        // higher tiers (`attested`, `proved`) come later when TEE work lands.
        const tier: ExecutionTier = signatureHash ? 1 : 0;
        const manifestHashHex = signatureHash ?? ('0x' as `0x${string}`);

        // Prefer v2 when the harness identity is available — the engine
        // captures executorMode + executorCodeDigest in pack(). For legacy
        // rows that completed before payload v2 wiring (or for solver paths
        // that don't produce a fence digest), executorCodeDigest is null and
        // we fall back to the v1 encoder so the indexer still sees envelope
        // metadata, just without harness identity. v1 envelopes are decoded
        // by the subgraph as mode='train' with empty codeDigest/implName.
        const harnessImplName = task.implName;
        const canEmitV2 =
          !!task.executorMode &&
          !!task.executorCodeDigest &&
          !!harnessImplName;
        try {
          let pubTxHash: `0x${string}`;
          if (canEmitV2) {
            const v2Payload: ExecutionPayloadV2 = {
              version: 2,
              tier,
              manifestHash: manifestHashHex,
              attestationQuoteCid: '0x',
              sourceMeasurement:
                '0x0000000000000000000000000000000000000000000000000000000000000000',
              codeDigest: codeDigestSha256ToBytes32(task.executorCodeDigest),
              implName: harnessImplName as string,
              modeFlag: modeStringToFlag(task.executorMode as 'train' | 'frozen'),
            };
            pubTxHash = await this.identityPublisher.publishContentV2({
              kind: 'envelope',
              cid: manifestCid,
              payload: v2Payload,
            });
            console.log(
              `[harness-engine] ${requestId}: setMetadata envelope:${manifestCid} tx=${pubTxHash} (payload v2 mode=${task.executorMode} impl=${harnessImplName})`,
            );
          } else {
            const v1Payload: ExecutionPayload = {
              version: 1,
              tier,
              manifestHash: manifestHashHex,
              attestationQuoteCid: '0x',
              sourceMeasurement:
                '0x0000000000000000000000000000000000000000000000000000000000000000',
            };
            pubTxHash = await this.identityPublisher.publishContent({
              kind: 'envelope',
              cid: manifestCid,
              payload: v1Payload,
            });
            console.log(
              `[harness-engine] ${requestId}: setMetadata envelope:${manifestCid} tx=${pubTxHash} (payload v1)`,
            );
          }
        } catch (err) {
          console.warn(
            `[harness-engine] ${requestId}: setMetadata envelope publish failed (non-fatal): ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }

    // ── Reputation feedback hook (jinn-mono-yg4) ─────────────────────────────
    //
    // Evaluator-only path: after `claimDelivery` settles the verdict, fire
    // `ReputationRegistry.giveFeedback(harnessAgentId, ...)` so the
    // harness's agent NFT accrues a rating (DR §4.3).
    //
    // Best-effort: any failure inside the hook is logged but does not
    // change the COMPLETE state. claimDelivery is already authoritative.
    if (task.taskRole === 'evaluation' && this.reputationFeedback) {
      await this._maybePostEvaluatorFeedback(task).catch((err) => {
        console.warn(
          `[harness-engine] ${requestId}: reputation feedback hook errored unexpectedly (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      });
    }
  }

  /**
   * Post evaluator feedback on the harness's agent NFT.
   *
   * Pulls the verdict from the persisted gating claim (the evaluator impl
   * writes `{ verdict, score, scoreBasis, ... }` into `output.gating`),
   * resolves the harness's `agentId` via the configured subgraph
   * resolver, and submits a single `ReputationRegistry.giveFeedback` tx.
   *
   * Skipped silently when:
   *   - No `reputationFeedback` deps wired.
   *   - `gatingClaim` doesn't carry a verdict (impl shape mismatch — log and
   *     return).
   *   - The parent harness's manifest hash isn't reachable from the
   *     persisted state — log and return).
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
    task: PersistedTaskRun,
    manifestCid: string,
    evidenceHash: `0x${string}` | null | undefined,
  ): void {
    const taskId = task.task?.id;
    if (!taskId) {
      // Rows without task payload cannot be attributed to a Task id. Skip
      // rather than synthesise provenance.
      return;
    }
    const taskRole = task.taskRole ?? 'restoration';
    const tag = taskRole === 'evaluation' ? 'evaluation-verdict' : 'restoration-result';
    const existing = this.store.getArtifactByRequestId(task.requestId, tag);
    if (existing) return;

    this.store.insertArtifact({
      id: randomUUID(),
      taskId,
      requestId: task.requestId,
      title: `${tag}: ${task.solverType ?? 'cycle'} (${task.implName ?? 'engine'})`,
      content: JSON.stringify({
        manifestCid,
        evidenceHash: evidenceHash ?? null,
        implName: task.implName,
      }),
      tags: [tag, 'success'],
      outcome: 'SUCCESS',
    });
  }

  private verdictCodeForTask(task: PersistedTaskRun): number {
    const gating = task.gatingClaim as { verdict?: unknown } | null;
    const raw = gating?.verdict;
    switch (raw) {
      case 'PASS':
      case 'SCORED':
        return 1;
      case 'FAIL':
      case 'REJECTED':
        return 2;
      case 'INVALID':
        return 3;
      case 'INDETERMINATE':
      case 'UNRESOLVED':
        return 4;
      default:
        return 1;
    }
  }

  private async _maybePostEvaluatorFeedback(task: PersistedTaskRun): Promise<void> {
    if (!this.reputationFeedback) return;

    const gating = task.gatingClaim as
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
        `[harness-engine] ${task.requestId}: reputation feedback skipped — gatingClaim has no recognised verdict (got=${String(verdictRaw)})`,
      );
      return;
    }
    const verdict = verdictRaw as EvaluatorVerdict['verdict'];

    // Pull the parent harness's manifest evidence from the inlined eval
    // payload. The evaluator impl receives the harness's signed manifest
    // JSON via `task.context.restorationResult`. Its `signature.hash` is
    // exactly what the harness committed via `claimDelivery(evidenceHash)`.
    const parent = this._extractHarnessManifestRef(task);
    if (!parent) {
      console.warn(
        `[harness-engine] ${task.requestId}: reputation feedback skipped — could not extract harness manifest hash from inlined evaluation payload`,
      );
      return;
    }

    let resolved: ResolvedAgent | null;
    try {
      resolved = await this.reputationFeedback.resolveAgentId(parent.evidenceHash);
    } catch (err) {
      console.warn(
        `[harness-engine] ${task.requestId}: reputation feedback resolver threw (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
      return;
    }
    if (!resolved) {
      console.log(
        `[harness-engine] ${task.requestId}: reputation feedback skipped — no agentId resolved for harness manifestHash=${parent.evidenceHash} (subgraph not indexed yet, or no envelope published)`,
      );
      return;
    }

    // CID resolution priority: subgraph row's `manifestCid` (cheapest, the
    // operator already published an envelope under it), else the inlined
    // CID hint when present, else fall back to the bare hash. The subgraph
    // parses `manifest:<cid>` to a `manifestRef` regardless.
    const manifestCid = resolved.manifestCid ?? parent.manifestCid ?? '';

    // The SolverType is the same value used by the restoration —
    // `task.solverType` is "portfolio.v0" both for the restoration and its
    // evaluation. Tag1 is indexed on the on-chain event, so cheap to filter.
    const kind = task.solverType ?? undefined;

    const verdictArg: EvaluatorVerdict = kind ? { verdict, solverType: kind } : { verdict };

    let outcome: FeedbackHookOutcome;
    try {
      outcome = await submitEvaluatorFeedback({
        registry: this.reputationFeedback.client,
        ref: {
          harnessAgentId: resolved.agentId,
          harnessManifestCid: manifestCid,
          harnessEvidenceHash: parent.evidenceHash,
        },
        verdict: verdictArg,
      });
    } catch (err) {
      // submitEvaluatorFeedback already swallows known reverts, but a
      // truly unexpected throw still must not propagate past delivery.
      console.warn(
        `[harness-engine] ${task.requestId}: reputation feedback unexpected throw (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    console.log(
      `[harness-engine] ${task.requestId}: reputation feedback ${outcome.kind} verdict=${verdict} harnessAgentId=${resolved.agentId.toString()}`,
    );
  }

  /**
   * Extract the harness's `evidenceHash` (and best-effort `manifestCid`)
   * from the persisted evaluation task.
   *
   * The evaluator's `task.context.restorationResult` holds the harness's
   * full signed manifest JSON inlined as a string. We parse it and pull the
   * `signature.hash`, which is exactly the on-chain `evidenceHash`.
   *
   * The CID is not always inlined — the manifest carries its own
   * `task.cid` field (the *original task* CID), not its self-CID. We
   * therefore return `manifestCid: null` here and rely on the subgraph
   * resolver to surface the published manifest CID. Returns `null` when
   * the inlined payload is missing or malformed.
   */
  private _extractHarnessManifestRef(task: PersistedTaskRun): {
    evidenceHash: `0x${string}`;
    manifestCid: string | null;
  } | null {
    const ds = task.task;
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
  private dataDrivenAdvance(task: PersistedTaskRun): TaskRunState | null {
    switch (task.state) {
      case TaskRunState.WAITING:
        return Date.now() >= task.windowStartTs ? TaskRunState.PRE_SNAPSHOT : null;
      case TaskRunState.PRE_SNAPSHOT:
        return task.preSnapshotPayload != null ? TaskRunState.RUNNING : null;
      case TaskRunState.POST_SNAPSHOT:
        return task.postSnapshotPayload != null ? TaskRunState.PACKAGING : null;
      default:
        return null;
    }
  }

  /**
   * Wraps a transition method call with error handling: if the transition
   * throws, the task is marked FAILED with the error message.
   */
  private async _runTransition(
    task: PersistedTaskRun,
    fn: () => Promise<void>,
  ): Promise<void> {
    const oldState = task.state;
    try {
      await fn();
      const updated = this.persistence.getByRequestId(task.requestId);
      if (updated && updated.state !== oldState) {
        console.log(`[harness-engine] ${task.requestId} ${oldState} → ${updated.state}`);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.persistence.markFailed(task.requestId, reason);
      throw err;
    }
  }

  /**
   * Recovery handler for a single in-flight task.
   * Dispatches by state per §6.5.
   */
  private async _recoverOne(task: PersistedTaskRun): Promise<void> {
    try {
      await this._recoverDispatch(task);
    } catch (err) {
      // If recovery itself throws (e.g. NotImplementedError stub), mark failed.
      // NotImplementedError is expected during development; don't swallow it in prod.
      const reason = err instanceof Error ? err.message : String(err);
      // Only mark failed if the task is still in the same non-terminal state
      // (another concurrent recovery pass might have already advanced it).
      const current = this.persistence.getByRequestId(task.requestId);
      if (current && current.state === task.state) {
        this.persistence.markFailed(task.requestId, `recovery: ${reason}`);
        console.error(`[harness-engine] resume failed for ${task.requestId}: ${reason}`);
      }
      throw err;
    }
  }

  /**
   * Per-state recovery dispatch per §6.5.
   */
  private async _recoverDispatch(task: PersistedTaskRun): Promise<void> {
    switch (task.state) {
      case TaskRunState.DISCOVERED:
        // Ready to claim — delegate to claim flow (subsequent task).
        // Stub: leaves state unchanged; logs task is ready.
        await this.claim(task);
        break;

      case TaskRunState.CLAIMED:
        // Advance to WAITING — no side effect needed.
        this.persistence.transition(task.requestId, TaskRunState.WAITING);
        await this._recoverDispatch(this.persistence.getOrThrow(task.requestId));
        break;

      case TaskRunState.WAITING: {
        const advance = this.dataDrivenAdvance(task);
        if (advance !== null) {
          // Window has started — advance immediately.
          this.persistence.transition(task.requestId, advance);
          await this._recoverDispatch(this.persistence.getOrThrow(task.requestId));
        }
        // else: schedule a timer for startTs — caller handles scheduling.
        break;
      }

      case TaskRunState.PRE_SNAPSHOT: {
        const advance = this.dataDrivenAdvance(task);
        if (advance !== null) {
          // Snapshot already in DB — advance to RUNNING.
          this.persistence.transition(task.requestId, advance);
          await this._recoverDispatch(this.persistence.getOrThrow(task.requestId));
        } else {
          // Need to (re-)fetch snapshot.
          await this.takePreSnapshot(task);
          // takePreSnapshot transitions PRE_SNAPSHOT → RUNNING. Re-dispatch
          // against the post-transition state so runImpl actually fires for
          // tasks that were persisted at CLAIMED/WAITING/PRE_SNAPSHOT
          // before a restart (otherwise recovery stops at RUNNING-but-not-run).
          const after = this.persistence.getByRequestId(task.requestId);
          if (after && after.state !== task.state && after.state !== TaskRunState.FAILED) {
            await this._recoverDispatch(after);
          }
        }
        break;
      }

      case TaskRunState.RUNNING:
        // Re-spawn impl with workingDir + implStateDir intact.
        await this.runImpl(task);
        break;

      case TaskRunState.POST_SNAPSHOT: {
        const advance = this.dataDrivenAdvance(task);
        if (advance !== null) {
          // Snapshot already in DB — advance to PACKAGING.
          this.persistence.transition(task.requestId, advance);
          await this._recoverDispatch(this.persistence.getOrThrow(task.requestId));
        } else {
          await this.takePostSnapshot(task);
        }
        break;
      }

      case TaskRunState.PACKAGING:
        // Re-walk workingDir + Solution; re-upload missing CIDs.
        await this.pack(task);
        break;

      case TaskRunState.DELIVERING:
        // Chain query — if already delivered → COMPLETE; else retry.
        await this.deliver(task);
        break;

      case TaskRunState.COMPLETE:
      case TaskRunState.FAILED:
        // Terminal — nothing to recover.
        break;
    }
  }
}

// ── runHarnessOnce ────────────────────────────────────────────────────────────

/**
 * Thin, test-friendly entry point for the freeze-fence + mode propagation
 * path.  Runs a single `harness.run(ctx)` call through `runHarnessWithFreezeFence`
 * and returns either a minimal envelope stub (carrying `executor.mode`) or a
 * structured violation result — without requiring a full DB-backed TaskEngine
 * state machine.
 *
 * This function is *not* the production dispatch path; it exists so integration
 * tests can drive the mode-propagation and freeze-fence behaviour in isolation.
 *
 * @returns
 *   `{ envelope: { executor: { mode } } }` on success.
 *   `{ violation: FreezeViolation }` when the fence rejects the harness output.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.3
 */
export async function runHarnessOnce(params: {
  harness: Harness;
  implStateDir: string;
  mode: 'train' | 'frozen';
  /** Optional working directory (defaults to implStateDir). */
  workingDir?: string;
  /** Optional task stub (defaults to a minimal no-op task). */
  task?: HarnessContext['task'];
}): Promise<{ envelope?: { executor: { mode: 'train' | 'frozen'; codeDigest: string } }; violation?: FreezeViolation }> {
  const { harness, implStateDir, mode } = params;
  const workingDir = params.workingDir ?? implStateDir;

  const task: HarnessContext['task'] = params.task ?? {
    id: 'test-task',
    description: '',
    role: 'restoration',
    window: { startTs: 0, endTs: Date.now() + 3_600_000 },
  };

  const ctx: HarnessContext = {
    task,
    implStateDir,
    workingDir,
    log: () => { /* no-op for test-friendly invocations */ },
    abort: new AbortController().signal,
    msUntilEndTs: () => Math.max(0, (task.window?.endTs ?? Date.now() + 3_600_000) - Date.now()),
    trajectory: new TrajectoryCollector({ taskCid: '', runId: 'test-run' }),
    mode,
  };

  const fence = await runHarnessWithFreezeFence(harness, ctx);

  if (!fence.ok) {
    return { violation: fence.violation };
  }

  return {
    envelope: {
      executor: {
        mode,
        codeDigest: `sha256:${fence.codeDigest}`,
      },
    },
  };
}
