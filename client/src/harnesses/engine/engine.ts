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
import type { ZodIssue } from 'zod/v3';
import { TaskRunPersistence, type PersistedTaskRun, type PersistedTaskRunInput } from './persistence.js';
import { TaskRunState, MissingEvidenceHashError } from './state.js';
import type { Store } from '../../store/store.js';
import {
  syntheticClaimBlocked,
  type SyntheticTaskProvenance,
} from '../../solver-types/_swe-rebench-v2-synthetic-claim.js';
import {
  reapWorkDirs,
  DEFAULT_ORPHAN_MAX_AGE_MS,
  type ReapWorkDirsReport,
} from './work-dir-reaper.js';
import {
  provisionWorkingDir,
  provisionImplStateDir,
  walkArtifacts,
  uploadArtifacts,
  type PackagingDeps,
} from './packaging.js';
import { DONATION_ARTIFACT_ENCODING } from './artifact-scrub.js';
import { loadCorpusKnowledge, buildCorpusKnowledgePayload } from './corpus-knowledge.js';
import { harvestGeneratorModel } from './generator-model.js';
import type { CorpusKnowledgeRecordRef } from './corpus-knowledge.js';
import { projectEnvelope } from '../../corpus/envelope-projection.js';
import type { ReadOnlyCorpus } from '../../mcp/search-records.js';
import { redactRpcUrls } from '../../util/redact-rpc-urls.js';
import {
  assembleAndSignEnvelope,
  type EnvelopeAssemblyDeps,
  type EnvelopeInputs,
} from './envelope-assembly.js';
import {
  claimRouterDelivery,
  isRouterDeliveryClaimed,
  createMarketplaceDeliveryRecovery,
  deliverToMarketplace,
  deliverAndClaim,
  type DeliveryClaimOptions,
  type DeliveryDeps,
  type MarketplaceDeliveryExpectation,
  type MarketplaceDeliveryRecovery,
} from './delivery.js';
import {
  SafeInnerRevertError,
  isNonRecoverableInnerRevert,
  formatDecodedRevert,
} from '../../adapters/mech/safe-revert.js';
import { emitEvent } from '../../observability/emit-event.js';
import { isRecoverableTransactionError } from '../../tx-retry.js';
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
  encodeExecutionPayload,
  encodeExecutionPayloadV2,
  modeStringToFlag,
} from '../../erc8004/index.js';
import type { ArtifactSource, Role } from '../../types/envelope.js';
import type { Task } from '../../types/task.js';
import { TrajectoryCollector, emitTrajectory } from '../../trajectory/index.js';
import { addTranscriptSpans } from '../../trajectory/transcript-to-spans/index.js';
import {
  buildScrubPipeline,
  type ScrubPipeline,
} from '@jinn-network/core/scrub';
import { cidToDigestHex, uploadToIpfs } from '../../adapters/mech/ipfs.js';
import { VerdictCode } from '../../adapters/mech/verdict-code.js';
import { buildInfo } from '../../build-info.js';
import { getSolverNetContract } from '@jinn-network/sdk/solvernets';
import type { SolverNetManifestV1 } from '@jinn-network/sdk/solvernets';
import {
  runHarnessWithFreezeFence,
  type FreezeViolation,
} from '../../daemon/freeze-fence.js';
import { recordLoopTick } from '../../daemon/loop-heartbeat.js';
import { harnessStateDirName } from '../names.js';
import { recordTaskCost } from '../../spend/record.js';
import {
  AutopilotAdoptionReceiptSchema,
  JinnRepoAutopilotSolutionPayloadSchema,
  JinnRepoAutopilotVerdictPayloadSchema,
  JinnRepoTaskSchema,
  autopilotCorrelationMatches,
  type AutopilotAdoptionReceipt,
  type AutopilotCorrelation,
  type JinnRepoAutopilotSessionTask,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import type {
  AdoptionObservation,
  AdoptionReceiptObserver,
} from '../../types/task-run.js';
import { officialAutopilotProfileFailure } from '../../autopilot/official-profile-policy.js';

function officialAutopilotTaskProfileFailure(
  task: Task,
  resolvedContract?: { readonly id: string; readonly version: string },
): string | null {
  const contract = resolvedContract ?? (
    task.contractId !== undefined && task.contractVersion !== undefined
      ? { id: task.contractId, version: task.contractVersion }
      : task.solverType === 'jinn-repo.v1'
        ? { id: 'jinn-repo', version: 'v1' }
        : undefined
  );
  if (
    contract?.id !== 'jinn-repo'
    || contract.version !== 'v1'
    || task.spec?.['source'] !== 'autopilot-session'
  ) {
    return null;
  }
  const spec = task.spec as {
    repo?: unknown;
    verificationProfile?: unknown;
  };
  return officialAutopilotProfileFailure({
    repository: typeof spec.repo === 'string' ? spec.repo : '<missing>',
    verificationProfile:
      typeof spec.verificationProfile === 'string'
        ? spec.verificationProfile
        : undefined,
  });
}

// ── Sentinel error ────────────────────────────────────────────────────────────

export class NotImplementedError extends Error {
  readonly transitionName: string;

  constructor(transitionName: string) {
    super(`[NotImplemented] ${transitionName} — fill in via subsequent task`);
    this.name = 'NotImplementedError';
    this.transitionName = transitionName;
  }
}

/**
 * A task cannot leave DISCOVERED until its canonical TaskCreated block has a
 * valid timestamp. Exhausting the bounded lookup is recoverable: a later
 * engine pass can query a healthy/caught-up RPC and continue the same row.
 */
export class TaskCreationTimestampUnavailableError extends Error {
  readonly requestId: string;
  readonly blockNumber: number;
  readonly cause: unknown;

  constructor(requestId: string, blockNumber: number, cause: unknown) {
    super(
      `authoritative task creation timestamp unavailable for ${requestId} `
      + `(block ${blockNumber})`,
    );
    this.name = 'TaskCreationTimestampUnavailableError';
    this.requestId = requestId;
    this.blockNumber = blockNumber;
    this.cause = cause;
  }
}

/** A delivery cannot enter adoption polling until its exact metadata anchor is confirmed. */
export class DeliveryDiscoveryAnchorUnavailableError extends Error {
  readonly requestId: string;
  readonly cause: unknown;

  constructor(requestId: string, cause: unknown) {
    super(
      `delivery discovery anchor unavailable for ${requestId}: `
      + `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'DeliveryDiscoveryAnchorUnavailableError';
    this.requestId = requestId;
    this.cause = cause;
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
    provider?: import('../provider-ref.js').ProviderRef;
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
  /** Add/replace one joined entry live (used by the hot-apply join applier, #1037). */
  set(manifestCid: string, entry: { roles: Array<'solver' | 'evaluator'> }): void;
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
    set: (cid, entry) => { map.set(cid, entry); },
  };
}

/**
 * Mutable `JoinedSolverNetsView` for the running daemon. Unlike
 * `joinedSolverNetsViewFromConfig` (boot snapshot), the applier
 * (`daemon/join-applier.ts`, #1037) keeps a handle and calls `set()` when a
 * join is hot-applied, so the engine's per-task eligibility check sees the new
 * cid on its next call without a restart.
 */
export function createMutableJoinedSolverNetsView(
  initial: Record<string, { manifestCid: string; roles: Array<'solver' | 'evaluator'> }> | undefined,
): JoinedSolverNetsView {
  const map = new Map<string, { roles: Array<'solver' | 'evaluator'> }>();
  for (const [key, entry] of Object.entries(initial ?? {})) {
    map.set(entry.manifestCid ?? key, { roles: entry.roles });
  }
  return {
    get: (cid: string) => map.get(cid),
    manifestCids: () => [...map.keys()],
    set: (cid, entry) => { map.set(cid, entry); },
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
   * Exact read-only recovery for a Mech delivery that may have landed before
   * the local tx hash was persisted. Defaults to the production chain +
   * envelope-projection implementation.
   */
  marketplaceDeliveryRecovery?: MarketplaceDeliveryRecovery;
  /**
   * Read-only observer for durable Autopilot adoption receipts. The engine
   * never implements GitHub access itself; production wiring injects it.
   */
  adoptionReceiptObserver?: AdoptionReceiptObserver;
  /**
   * Impl registry for resolving which Harness to run.
   * When provided and findFor() returns an impl, runImpl() dispatches to it.
   */
  implRegistry?: ImplRegistry;
  solverNetRegistry?: SolverNetRegistryLike;
  /**
   * Seller-side scrub pipeline applied to trajectory spans at emit time. When
   * absent, the engine builds the default (openredaction + secretlint); supply
   * one to add the ML PII detector.
   */
  scrubPipeline?: ScrubPipeline;
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
   * Operator Safe address used for synthetic task claim filtering (§7).
   * When set, `canAcceptTask` / `claim` reject mint-and-solve self-claims.
   */
  operatorSafeAddress?: `0x${string}`;
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
    /**
     * Daemon-wide default LLM model identifier (from JinnConfig.claudeModel).
     * Used as the fallback when a SolverNet does not specify its own model.
     * Stamped into executor.model in the assembled envelope (jinn-mono-gbut).
     */
    claudeModel?: string;
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
  /**
   * Working-directory reaper tuning (issue #320). Each task run provisions a
   * heavy scratch directory under `paths.workingDirRoot`; without cleanup an
   * operator accumulates hundreds of dirs / tens of GB. The engine reaps a
   * task's directory once it reaches a terminal state (COMPLETE / FAILED),
   * and periodically sweeps the root for crash-orphaned dirs.
   *
   * Optional — sensible defaults apply when absent.
   */
  workDirReaper?: {
    /**
     * Age above which a directory with no DB row (orphaned by a crash or an
     * older daemon) is removed. Defaults to {@link DEFAULT_ORPHAN_MAX_AGE_MS}
     * (24h). Set to a large value to keep orphans for forensic inspection.
     */
    orphanMaxAgeMs?: number;
    /**
     * Disable the reaper entirely (escape hatch for debugging a stuck task).
     * Defaults to false — the reaper runs.
     */
    disabled?: boolean;
  };

  /**
   * Corpus knowledge autoload (#1393). Before each restoration harness
   * spawn, the engine queries the corpus for prior solution records of the
   * task's solverType and injects the top few into
   * task.context.corpusKnowledge. The injection exists only in the in-memory
   * ctx.task handed to the harness — unlike context.restorationResult (which
   * the adapter attaches at task construction and which persists in
   * task_payload), it is never persisted into the signed Task and never
   * re-hashed. The durable record of what was injected is the run's
   * consumed_refs_json column.
   *
   * - `corpus`: read-only corpus for network results; when absent/null the
   *   lookup is store-only (local envelope projections + served artifacts).
   * - `enabled`: opt-out; defaults to true (config: engine.knowledgeAutoload).
   *
   * Failures never block the solve path: the lookup is time-bounded and
   * error-swallowing (loadCorpusKnowledge never throws).
   */
  knowledge?: { corpus?: ReadOnlyCorpus | null; enabled?: boolean };

  /**
   * Resolves the on-chain block timestamp for a task's creation block
   * (#1827). Production wires this for every new task. It remains optional so
   * historical/test callers can parse and exercise pre-field rows without
   * fabricating a value.
   *
   * Returns `undefined` on a resolvable-but-unknown block. Undefined values
   * and thrown transport errors are retried; a new envelope is never signed
   * without the authoritative timestamp.
   */
  blockTimestamp?: {
    getBlockTimestamp(blockNumber: number): Promise<number | undefined>;
    /** Configured URLs let the redactor also strip detached API-key material. */
    configuredRpcUrls?: readonly string[];
  };
}

const TASK_CREATION_TIMESTAMP_LOOKUP_ATTEMPTS = 3;

/** Min interval between transient-RPC tick_error emits per requestId (#934). */
export const TRANSIENT_TICK_ERROR_HEARTBEAT_MS = 5 * 60_000;

// ── Recovery report ───────────────────────────────────────────────────────────

/** Per-task outcome from a recovery pass. */
export interface RecoveryReport {
  requestId: string;
  outcome: 'ok' | 'failed';
  error?: string;
}

interface TickOptions {
  /**
   * When true, wait for newly scheduled task processing to settle before
   * returning. Direct callers keep the historical behavior. The daemon's
   * periodic loop uses wait=false so one long harness run cannot starve
   * other in-flight tasks discovered later.
   */
  wait?: boolean;
}

interface ProcessReport {
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
  protected readonly marketplaceDeliveryRecovery: MarketplaceDeliveryRecovery | undefined;
  protected readonly adoptionReceiptObserver: TaskEngineOptions['adoptionReceiptObserver'];
  protected readonly implRegistry: TaskEngineOptions['implRegistry'];
  protected readonly solverNetRegistry: TaskEngineOptions['solverNetRegistry'];
  protected readonly scrubPipeline: ScrubPipeline;
  protected readonly joinedSolverNets: TaskEngineOptions['joinedSolverNets'];
  protected readonly operatorSafeAddress: TaskEngineOptions['operatorSafeAddress'];
  protected readonly manifestResolver: TaskEngineOptions['manifestResolver'];
  protected readonly blockTimestamp: TaskEngineOptions['blockTimestamp'];
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

  // Corpus knowledge already resolved for this requestId's current run
  // (#1393 review finding 3). A value (string) means knowledge was found and
  // injected; `null` means the lookup ran and genuinely found nothing.
  // Presence in the map (checked via .has) means "already resolved" either
  // way, so a RUNNING retry/recovery re-drive (transient harness/RPC error,
  // or crash-recovery via _recoverDispatch — neither transitions the task
  // out of RUNNING) reuses this instead of re-querying the corpus and
  // re-emitting the corpus_knowledge event. Cleared after successful pack.
  private readonly consumedRefsByRequest = new Map<string, string | null>();

  /** requestId → epoch ms of last transient tick_error emit (#934) */
  private readonly lastTransientTickErrorAt = new Map<string, number>();

  private readonly processingByRequestId = new Map<string, Promise<void>>();
  private static readonly ADOPTION_CLAIM_RETRY_BACKOFF_MS = 5 * 60_000;
  private static readonly ADOPTION_OBSERVATION_BASE_BACKOFF_MS = 10_000;
  private static readonly ADOPTION_OBSERVATION_MAX_BACKOFF_MS = 5 * 60_000;

  /** Set by stop(); causes runTickLoop to exit at the next iteration. */
  private stopped = false;
  private stopResolve?: () => void;
  private readonly stopPromise = new Promise<void>((resolve) => {
    this.stopResolve = resolve;
  });

  /** Working-dir reaper tuning (issue #320). */
  protected readonly workDirReaperOpts: { orphanMaxAgeMs: number; disabled: boolean };

  /** Corpus knowledge autoload options (#1393). */
  protected readonly knowledge: TaskEngineOptions['knowledge'];

  constructor(opts: TaskEngineOptions) {
    this.persistence = new TaskRunPersistence(opts.store.db);
    this.store = opts.store;
    this.paths = opts.paths;
    this.packagingDeps = opts.packagingDeps;
    this.envelopeDeps = opts.envelopeDeps;
    this.deliveryDeps = opts.deliveryDeps;
    this.marketplaceDeliveryRecovery = opts.marketplaceDeliveryRecovery
      ?? (opts.deliveryDeps
        ? createMarketplaceDeliveryRecovery({
            publicClient: opts.deliveryDeps.publicClient,
            mechContractAddress: opts.deliveryDeps.mechContractAddress,
            safeAddress: opts.deliveryDeps.safeAddress,
            store: opts.store,
          })
        : undefined);
    this.adoptionReceiptObserver = opts.adoptionReceiptObserver;
    this.implRegistry = opts.implRegistry;
    this.solverNetRegistry = opts.solverNetRegistry;
    this.scrubPipeline = opts.scrubPipeline ?? buildScrubPipeline();
    this.joinedSolverNets = opts.joinedSolverNets;
    this.operatorSafeAddress = opts.operatorSafeAddress;
    this.manifestResolver = opts.manifestResolver;
    this.blockTimestamp = opts.blockTimestamp;
    this.identityPublisher = opts.identityPublisher;
    this.reputationFeedback = opts.reputationFeedback;
    this.operatorConfig = opts.operatorConfig;
    this.harnessMode = opts.harnessMode ?? 'train';
    this.knowledge = opts.knowledge;
    this.workDirReaperOpts = {
      orphanMaxAgeMs: opts.workDirReaper?.orphanMaxAgeMs ?? DEFAULT_ORPHAN_MAX_AGE_MS,
      disabled: opts.workDirReaper?.disabled ?? false,
    };
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

  /**
   * Pre-claim acceptance check used by the daemon's engine-watcher loop.
   *
   * Performance contract (issue #398): this runs once per task announcement,
   * on the engine-watcher hot path, for every observed task. It MUST NOT
   * perform per-task blocking I/O. In particular it does not probe
   * `impl.isReady()` — historically the Hermes harness ran child processes
   * inside its readiness probe, so a backlog would pay per-task blocking
   * spawns and starve the daemon event loop. (#778 converted the matching
   * post-execution `git diff` wedge in harvest.ts to async + 60s timeout;
   * the #778 follow-up converted the readiness-probe spawns themselves —
   * Hermes `doctor` / `auth list` and the codex-doctor `--version` probe —
   * to async, so the registry's background refresh loop no longer blocks the
   * main thread either. The readiness path remains O(1) here via the cache
   * below.)
   *
   * Harness readiness for the claim gate is instead served O(1) from the
   * daemon's cached `HarnessReadinessRegistry` snapshot: the engine-watcher
   * loop calls `gateClaimByReadiness(...)` immediately after `canAcceptTask`
   * returns. A ~tickIntervalMs-stale snapshot is acceptable — harness
   * readiness changes on a minutes scale (auth/config) and the daemon
   * already trusts that cached registry for its post-`canAcceptTask` gate.
   *
   * `claim()` (the DISCOVERED → CLAIMED transition) still probes
   * `impl.isReady()` directly — it runs once per claimed task, not per
   * announcement, and is the authoritative pre-execution gate.
   */
  async canAcceptTask(input: {
    solverType?: string;
    taskRole?: 'restoration' | 'evaluation';
    task?: Task;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md
    // Task 16): the solution path moved to the work loop on the merged stack. The
    // evaluation path below is untouched and retires at stage 2.
    if (input.taskRole === 'restoration') {
      return { ok: false, reason: 'solution path retired at cutover stage 1' };
    }
    const reason = await this.runnableFailureReason(
      input.solverType,
      input.taskRole ?? 'restoration',
      input.task,
      undefined,
      { skipReadinessProbe: true },
    );
    return reason ? { ok: false, reason } : { ok: true };
  }

  /**
   * Recover all in-flight tasks from persisted state.
   * Started at daemon startup; runs concurrently with the daemon loops
   * (#1422 — startup must not block on a recovered impl re-execution).
   * Returns a per-task report for each task attempted.
   */
  async recoverInFlight(): Promise<RecoveryReport[]> {
    const inflight = this.persistence.getInFlight();
    const results = await Promise.allSettled(
      // #1422: recovery runs concurrently with the tick/watcher loops, so
      // each task must hold the same in-flight guard `scheduleProcess` uses —
      // otherwise a tick fired mid-recovery double-drives the task's impl.
      inflight.map((task) => this.runRequestSingleFlight(
        task.requestId,
        () => this._recoverOne(task),
      ).promise),
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
  async tick(options: TickOptions = {}): Promise<void> {
    const wait = options.wait ?? true;
    const inflight = this.persistence.getInFlight();
    const scheduled: Array<Promise<ProcessReport>> = [];
    for (const task of inflight) {
      const processPromise = this.scheduleProcess(task.requestId);
      if (!processPromise) continue;
      scheduled.push(processPromise);
      if (!wait) {
        void processPromise.then((report) => this.logProcessReport('tick', report));
      }
    }

    // Reap the working directories of tasks that have reached a terminal
    // state. Cheap (one readdir + a few rmSync) and idempotent, so it runs
    // every tick — there is no separate reaper loop to keep alive or crash.
    this.reapWorkDirsNow();

    if (!wait) return;

    const reports = await Promise.all(scheduled);
    for (const report of reports) {
      this.logProcessReport('tick', report);
    }
  }

  /**
   * Reap on-disk per-task working directories (issue #320).
   *
   * Removes the scratch directory of every task in a terminal state
   * (COMPLETE / FAILED) and any crash-orphaned directory older than the
   * configured max age. In-flight tasks are never touched. Safe to call at
   * any time; never throws (filesystem errors are collected into the report).
   *
   * Called automatically every `tick()`; also exposed for the one-shot
   * cleanup script and for tests.
   */
  reapWorkDirsNow(): ReapWorkDirsReport {
    const empty: ReapWorkDirsReport = { removed: [], protected: [], scanned: 0, errors: [] };
    if (this.workDirReaperOpts.disabled) return empty;

    // Read the in-flight / terminal partition as a single atomic snapshot.
    // Two separate queries would leave a TOCTOU window: a task transitioning
    // DELIVERING → COMPLETE between the reads could be classified terminal and
    // have its working directory deleted while deliver() still needs it.
    const { terminal: terminalRequestIds, inFlight: inFlightRequestIds } =
      this.persistence.getReaperPartition();

    const report = reapWorkDirs({
      workingDirRoot: this.paths.workingDirRoot,
      terminalRequestIds,
      inFlightRequestIds,
      orphanMaxAgeMs: this.workDirReaperOpts.orphanMaxAgeMs,
    });

    if (report.removed.length > 0) {
      console.log(
        `[harness-engine] work-dir reaper removed ${report.removed.length} ` +
        `terminal/orphaned task dir(s) under ${this.paths.workingDirRoot}`,
      );
    }
    for (const e of report.errors) {
      console.warn(`[harness-engine] work-dir reaper failed to remove ${e.requestId}: ${e.error}`);
    }
    return report;
  }

  /**
   * Drive `tick()` on a fixed interval until `stop()` is called.
   * Errors thrown by tick() itself are logged and do not stop the loop.
   */
  async runTickLoop(intervalMs: number): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick({ wait: false });
      } catch (err) {
        console.error('[harness-engine] tick loop error (continuing):', err instanceof Error ? err.message : err);
      }
      // Cutover stage 2: `engine-tick` retired from LOOP_REGISTRY — heartbeat removed.
      if (this.stopped) break;
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, intervalMs)),
        this.stopPromise,
      ]);
    }
  }

  /** Signal `runTickLoop` to exit at the next iteration. */
  stop(): void {
    this.stopped = true;
    this.stopResolve?.();
  }

  private scheduleProcess(requestId: string): Promise<ProcessReport> | null {
    const scheduled = this.runRequestSingleFlight(
      requestId,
      () => this._process(requestId),
    );
    if (!scheduled.started) return null;
    return scheduled.promise
      .then((): ProcessReport => ({ requestId, outcome: 'ok' }))
      .catch((err: unknown): ProcessReport => ({
        requestId,
        outcome: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }));
  }

  private runRequestSingleFlight(
    requestId: string,
    operation: () => Promise<void>,
  ): { promise: Promise<void>; started: boolean } {
    const existing = this.processingByRequestId.get(requestId);
    if (existing) return { promise: existing, started: false };

    let promise: Promise<void>;
    promise = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.processingByRequestId.get(requestId) === promise) {
          this.processingByRequestId.delete(requestId);
        }
      });
    this.processingByRequestId.set(requestId, promise);
    return { promise, started: true };
  }

  private logProcessReport(source: string, report: ProcessReport): void {
    if (report.outcome !== 'failed') return;
    console.warn(`[harness-engine] ${source}: process(${report.requestId}) failed: ${report.error ?? 'unknown error'}`);
  }

  /**
   * Process a single task: dispatch by current state to the appropriate
   * transition. Drives one state transition per call.
   *
   * Called both by recovery and by the ongoing event-processing loop.
   */
  async process(requestId: string): Promise<void> {
    return this.runRequestSingleFlight(
      requestId,
      () => this._process(requestId),
    ).promise;
  }

  private async _process(requestId: string): Promise<void> {
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
            await this._process(task.requestId);
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
            await this._process(task.requestId);
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

      case TaskRunState.AWAITING_ADOPTION:
        await this._runTransition(task, () => this.awaitAdoption(task));
        break;

      case TaskRunState.CLAIMING_DELIVERY:
        await this._runTransition(task, () => this.claimAdoptedDelivery(task));
        break;

      case TaskRunState.COMPLETE:
      case TaskRunState.FAILED:
      case TaskRunState.RACE_LOST:
        // Terminal — nothing to do.
        break;
    }

    // Successful progress: allow a future outage to emit a fresh first tick_error (#934).
    this.lastTransientTickErrorAt.delete(requestId);
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

    // A new envelope must carry the authoritative TaskCreated block timestamp.
    // Resolve it before leaving DISCOVERED; a transient RPC failure gets a
    // bounded in-call retry and then remains in-flight through the engine's
    // existing recoverable-error classifier. Never advance with a missing
    // value and later fabricate or omit task.createdAt.
    if (this.blockTimestamp && task.onchainCreationTimestamp == null) {
      await this.resolveTaskCreationTimestamp(task);
    }

    // The event path and tick loop can race on the same DISCOVERED row; if
    // another caller already advanced it, treat this as idempotent.
    const current = this.persistence.getByRequestId(task.requestId);
    if (!current) {
      throw new Error(`claim: task not found after claim: ${task.requestId}`);
    }
    if (current.state === TaskRunState.DISCOVERED) {
      this.persistence.transition(task.requestId, TaskRunState.CLAIMED);
      console.log(`[harness-engine] ${task.requestId} DISCOVERED → CLAIMED`);
    } else {
      console.log(
        `[harness-engine] ${task.requestId}: claim completed but state is already ${current.state}; skipping CLAIMED transition`,
      );
    }
  }

  private async resolveTaskCreationTimestamp(task: PersistedTaskRun): Promise<number> {
    if (!this.blockTimestamp) {
      throw new Error(
        `authoritative task creation timestamp resolver is unavailable for ${task.requestId}`,
      );
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= TASK_CREATION_TIMESTAMP_LOOKUP_ATTEMPTS; attempt++) {
      try {
        const timestampSec = await this.blockTimestamp.getBlockTimestamp(
          task.onchainCreationBlock,
        );
        if (
          timestampSec !== undefined
          && Number.isSafeInteger(timestampSec)
          && timestampSec >= 0
        ) {
          this.persistence.setOnchainCreationTimestamp(task.requestId, timestampSec);
          return timestampSec;
        }
        lastError = new Error(
          `RPC returned no valid timestamp for block ${task.onchainCreationBlock}`,
        );
      } catch (err) {
        lastError = err;
      }
    }

    const safeError = redactRpcUrls(
      lastError,
      this.blockTimestamp.configuredRpcUrls ?? [],
    );
    console.warn(
      `[harness-engine] ${task.requestId}: authoritative task creation timestamp unavailable `
      + `after ${TASK_CREATION_TIMESTAMP_LOOKUP_ATTEMPTS} attempts: ${safeError}`,
    );
    throw new TaskCreationTimestampUnavailableError(
      task.requestId,
      task.onchainCreationBlock,
      lastError,
    );
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
    const taskProfileFailure = officialAutopilotTaskProfileFailure(task);
    if (taskProfileFailure) return taskProfileFailure;

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
      if (!parsedSpec?.success) {
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
    }

    const resolvedProfileFailure =
      officialAutopilotTaskProfileFailure(task, ref);
    if (resolvedProfileFailure) return resolvedProfileFailure;
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

  /**
   * Shared eligibility evaluation behind both `canAcceptTask` and `claim`.
   *
   * `opts.skipReadinessProbe` (issue #398): when true, the per-task
   * `impl.isReady()` probe is skipped. The engine-watcher's `canAcceptTask`
   * sets this — it relies on the daemon's cached `HarnessReadinessRegistry`
   * (via `gateClaimByReadiness`) for the readiness gate instead of a
   * blocking per-announcement probe. `claim()` leaves it false so the
   * DISCOVERED → CLAIMED transition still runs the authoritative readiness
   * probe (once per claimed task, not per announcement).
   */
  private async runnableFailureReason(
    solverType: string | undefined,
    role: 'restoration' | 'evaluation',
    task?: Task,
    currentRequestId?: string,
    opts: { skipReadinessProbe?: boolean } = {},
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
    // Scope the single-flight gate to one SolverNet. Two distinct SolverNets
    // that share the same `contract.id.version` routing key (e.g. mainline
    // SWE-rebench-v2 and an isolated SWE-rebench-v2 at a separate manifest
    // CID) used to collide on one shared slot — fixed by adding
    // `manifestCid` to the gate. `null` means "tasks without a manifest CID"
    // (legacy / health-check), which form their own bucket; `undefined` (no
    // task at all) preserves the legacy routing-key-only behaviour.
    const manifestCidForGate: string | null | undefined = task
      ? (task.solverNetManifestCid ?? null)
      : undefined;
    if (routingKey && this.persistence.hasInFlightFor({
      solverType: routingKey,
      taskRole: role,
      excludeRequestId: currentRequestId,
      manifestCid: manifestCidForGate,
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
      if (this.operatorSafeAddress) {
        const synthetic = task.eligibility?.['syntheticProvenance'] as SyntheticTaskProvenance | undefined;
        const blocked = syntheticClaimBlocked(synthetic, this.operatorSafeAddress);
        if (blocked) return blocked;
      }
      if (impl.canAttempt) {
        const attempt = await impl.canAttempt(task);
        if (!attempt.ok) {
          return `impl '${impl.name}' cannot attempt task: ${attempt.reason}`;
        }
      }
    }
    // The per-task `impl.isReady()` probe is the only blocking I/O on this
    // path (the Hermes harness spawns child processes synchronously). The
    // engine-watcher's `canAcceptTask` skips it — readiness is gated O(1) by
    // the daemon's cached `HarnessReadinessRegistry` right after this call.
    // `claim()` keeps it as the authoritative pre-execution check.
    if (!opts.skipReadinessProbe && impl.isReady) {
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
    // #1035: merge harness self-attributed plugins (e.g. claude-code-learner)
    // into the envelope carrier so they appear in executor.plugins. This is a
    // SEPARATE array from `runtimePlugins`: the latter still feeds
    // ctx.runtimePlugins / ctx.solverPluginRoots (which the harness uses to
    // LOAD solver plugins), and the learner plugin is already loaded by the
    // harness itself via its own plugin root — adding it there would double-load.
    const attributedPlugins: RuntimePlugin[] = [
      ...runtimePlugins,
      ...(impl.attributionPlugins?.() ?? []),
    ];
    this.runtimePluginsByRequest.set(task.requestId, attributedPlugins);

    // #1393: corpus knowledge autoload. Restoration runs only — never bias
    // evaluators with prior solutions. The lookup is bounded (10 s) and
    // never throws; failure or an empty result simply injects nothing.
    // consumedRefsJson is ALSO persisted at the RUNNING → POST_SNAPSHOT
    // transition below (harmless re-write of the same value — see
    // resolveFreshKnowledge) so a crash-free run still gets a single,
    // consistent column write; it stays null when nothing was injected.
    let taskForCtx = task.task;
    let consumedRefsJson: string | null = null;

    // #1393 review finding 3 (fresh lookup + immediate persist) and finding
    // 1/2 of the follow-up review (cross-restart durability + malformed-JSON
    // guard). Runs the corpus query, injects the result, emits the
    // corpus_knowledge event, and — critically — persists consumedRefsJson
    // to the DB immediately (setConsumedRefsJson), BEFORE harness spawn.
    // Without the immediate persist, a crash between the lookup and the
    // RUNNING → POST_SNAPSHOT transition would leave consumed_refs_json
    // null; a restarted process (empty in-memory cache) would then re-query
    // the corpus and re-emit a duplicate corpus_knowledge event.
    const resolveFreshKnowledge = async (): Promise<void> => {
      if (!taskForCtx) return;
      const knowledgePayload = await loadCorpusKnowledge({
        corpus: this.knowledge?.corpus ?? null,
        store: this.store,
        solverType,
      });
      if (knowledgePayload) {
        // Shallow clone: the injected context lives only in the runtime Task
        // handed to the harness. Envelope integrity references taskCid, so
        // nothing signed or hashed changes.
        taskForCtx = {
          ...taskForCtx,
          context: { ...taskForCtx.context, corpusKnowledge: knowledgePayload },
        };
        consumedRefsJson = JSON.stringify(knowledgePayload.records);
        emitEvent(this.store, {
          kind: 'corpus_knowledge',
          requestId: task.requestId,
          solverType,
          outcome: 'ok',
          detail: JSON.stringify(knowledgePayload.records.map((record) => ({
            envelopeCid: record.envelopeCid,
            artifacts: record.artifacts.map((artifact) => artifact.sha256),
          }))),
        }, 'harness-engine');
      }
      this.consumedRefsByRequest.set(task.requestId, consumedRefsJson);
      this.persistence.setConsumedRefsJson(task.requestId, consumedRefsJson);
    };

    if (role === 'restoration' && solverType && this.knowledge?.enabled !== false && taskForCtx) {
      // A RUNNING retry/recovery re-drive (transient harness/RPC error left
      // the row at RUNNING, or crash-recovery via _recoverDispatch) must not
      // re-query the corpus or re-emit corpus_knowledge — reuse whatever
      // this run already resolved, found or not. Prefer the in-memory map
      // (same-process retries); fall back to the persisted column (the
      // cross-restart case — a fresh TaskEngine instance has no in-memory
      // record of a prior process's resolution).
      const alreadyResolved = this.consumedRefsByRequest.has(task.requestId)
        ? this.consumedRefsByRequest.get(task.requestId)!
        : task.consumedRefsJson;
      const seenBefore = this.consumedRefsByRequest.has(task.requestId) || task.consumedRefsJson !== null;

      if (seenBefore) {
        try {
          consumedRefsJson = alreadyResolved;
          if (consumedRefsJson) {
            const cachedRecords = JSON.parse(consumedRefsJson) as CorpusKnowledgeRecordRef[];
            taskForCtx = {
              ...taskForCtx,
              context: { ...taskForCtx.context, corpusKnowledge: buildCorpusKnowledgePayload(solverType, cachedRecords) },
            };
          }
        } catch (err) {
          // #1393 review finding 2 (follow-up): a malformed persisted value
          // must never wedge the run — corpus problems can never block the
          // solve path (AC3). Log and fall through to a fresh lookup, which
          // also overwrites the bad value so subsequent retries don't hit it
          // again.
          console.warn(
            `[harness-engine] ${task.requestId}: malformed persisted consumedRefsJson `
            + `(${err instanceof Error ? err.message : String(err)}) — treating as not-yet-resolved`,
          );
          taskForCtx = task.task;
          consumedRefsJson = null;
          await resolveFreshKnowledge();
        }
      } else {
        await resolveFreshKnowledge();
      }
    }

    const workingDir = task.workingDir ?? join(this.paths.workingDirRoot, task.requestId);
    const kindSeg = solverType.replace(/[.:]/g, '_');
    const implStateDir = task.implStateDir ?? (
      kindSeg
        ? join(this.paths.implStateDirRoot, harnessStateDirName(impl.name), kindSeg)
        : join(this.paths.implStateDirRoot, harnessStateDirName(impl.name))
    );
    const windowEndTs = effectiveHarnessDeadline(task, role);

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
        task: (taskForCtx ?? {
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
              // Provider route travels alongside model (issue #1243) so the
              // Hermes adapter can route first-class instead of inferring.
              ...(solverNet.provider !== undefined ? { provider: solverNet.provider } : {}),
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
            runtimePluginsJson: JSON.stringify(attributedPlugins),
            consumedRefsJson,
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
        runtimePluginsJson: JSON.stringify(attributedPlugins),
        consumedRefsJson,
      });
    } finally {
      clearTimeout(endTimer);
    }
    console.log(`[harness-engine] ${task.requestId} RUNNING → POST_SNAPSHOT via impl=${impl.name}`);
    // Record the run's cost once it has cleanly reached POST_SNAPSHOT — i.e. the
    // harness completed. Captures cost regardless of whether on-chain delivery
    // later succeeds. Pre-completion early-exits (SkippableError, freeze-fence
    // violation) intentionally do not record: the spend cap is an approximate
    // graceful-pause control (design spec §2), not a precise ledger.
    recordTaskCost(this.store, {
      requestId: task.requestId,
      harness: impl.name,
      model: solverNet?.model,
      workingDir,
      solverType: task.solverType ?? null,
    });
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

    // jinn-mono-4tfq: SkippableError caught in RUNNING leaves a skip-marker
    // Solution with no payload; short-circuit before envelope assembly.
    // Runs BEFORE the deps guard — skipping needs nothing wired.
    const earlyImplOutput = this.solutionOutputs.get(task.requestId);
    const gatingClaim = earlyImplOutput?.gating as Record<string, unknown> | undefined;
    if (gatingClaim?.['skipped'] === true) {
      const reason = String(gatingClaim['reason'] ?? 'unknown');
      const detail = String(
        (earlyImplOutput?.informational as Record<string, unknown> | undefined)?.['detail'] ?? '',
      );
      console.log(
        `[harness-engine] ${task.requestId}: PACKAGING short-circuited — impl was skipped (${reason})${detail ? `: ${detail}` : ''}`,
      );
      this.persistence.markFailed(
        task.requestId,
        `impl skipped: ${reason}${detail ? ` — ${detail}` : ''}`,
      );
      return;
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

    // Parse the solve transcript into jinn.agent_turn / jinn.tool_call spans
    // (DR-2026-07-14, #1473) BEFORE artifact-emit spans are added below, so the
    // trajectory reads chronologically: the run's conversation, then its
    // packaging. Degrade-never-fail: any resolution/parse error is caught and
    // logged — a missing or unparseable transcript must never fail the solve.
    // addTranscriptSpans is itself idempotent per collector (finding 3: pack()
    // retries in place and the collector isn't cleared until DELIVERING, so a
    // failure after this point would otherwise re-parse and duplicate spans
    // on the next attempt).
    if (collector) {
      try {
        await addTranscriptSpans(collector, task.implName, workingDir);
      } catch (err) {
        console.warn(
          `[harness-engine] ${task.requestId}: transcript-to-spans parse failed (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

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
          scrubPipeline: this.scrubPipeline,
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
    // all other tasks produce 'solution' envelopes.
    const isEvaluation = task.taskRole === 'evaluation';
    const role: Role = isEvaluation ? 'verdict' : 'solution';

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
      // solutionEnvelope.sha256: placeholder — Plan D wires real sha256 derivation.
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

    // Task-doc repo identity (#1827), read once for the envelope's task
    // provenance fields. Contribution refs are produced only from canonical
    // Episodes by the plugin boundary, never from this requestId-based engine.
    // Correctly absent for solver types without repo identity (e.g.
    // prediction.*) — not a fabricated default.
    const taskSpec = task.task?.spec as Record<string, unknown> | undefined;
    const specRepo = typeof taskSpec?.['repo'] === 'string' ? taskSpec['repo'] : undefined;
    const specBaseCommit = typeof taskSpec?.['base_commit'] === 'string' ? taskSpec['base_commit'] : undefined;
    const specInstanceId = typeof taskSpec?.['instance_id'] === 'string' ? taskSpec['instance_id'] : undefined;

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

    // #1827: generatorModel — harvested from the harness's own transcript
    // when possible (source: 'stream'), else falls back to the same
    // SolverNet/daemon-config model string used for executor.model below
    // (source: 'config'). Never throws.
    const generatorModelForEnvelope = harvestGeneratorModel(
      implNameForEnvelope,
      workingDir,
      solverNet?.model ?? this.operatorConfig?.claudeModel,
    );

    let taskCreationTimestamp = task.onchainCreationTimestamp ?? undefined;
    if (taskCreationTimestamp === undefined && this.blockTimestamp) {
      // Recovery can resume an older CLAIMED/PACKAGING row that never passed
      // through today's claim-time resolver. Re-resolve before signing so the
      // new writer still cannot emit a provenance tuple without createdAt.
      taskCreationTimestamp = await this.resolveTaskCreationTimestamp(task);
    }

    const envelopeInputs: EnvelopeInputs = {
      solverType,
      role,
      task: {
        cid: task.taskCid,
        onchainCreationTx: task.onchainCreationTx,
        onchainCreationBlock: task.onchainCreationBlock,
        requestId: task.requestId,
        // #1827: authoritative TaskCreated block timestamp. Production
        // resolves or parks/fails before this new envelope is signed; it is
        // absent only for historical/test callers without the resolver.
        ...(taskCreationTimestamp !== undefined ? { createdAt: taskCreationTimestamp } : {}),
        ...(specInstanceId ? { instanceId: specInstanceId } : {}),
        ...(specRepo ? { repo: specRepo } : {}),
        ...(specBaseCommit ? { baseCommit: specBaseCommit } : {}),
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
        // LLM model: prefer SolverNet-specific override, fall back to daemon-wide
        // default from operatorConfig.claudeModel (jinn-mono-gbut, gh#191).
        // Left undefined when neither is set — the field is optional in the schema.
        model: solverNet?.model ?? this.operatorConfig?.claudeModel,
        // #1827: structured, honesty-flagged model provenance alongside the
        // existing plain `model` string (which stays untouched for the
        // indexer's composition.byModel facet).
        generatorModel: generatorModelForEnvelope,
      },
      evidenceTier,
      trajectory: envelopeTrajectory,
      artifacts,
      payload: envelopePayload,
      generatedAt,
    };

    const { envelope, envelopeCid, envelopeHash } = await assembleAndSignEnvelope(
      envelopeInputs,
      this.envelopeDeps,
    );
    const manifestCid = envelopeCid;
    const signatureHash = envelopeHash;

    // #1393: project the just-published envelope into the local corpus index
    // so the operator's own work is discoverable as knowledge on the next
    // run (and by MCP search_records). Upsert keyed on envelope_id — a
    // pack() retry overwrites idempotently. Never fatal: a projection
    // failure must not fail packaging.
    // NOTE: taskCid is deliberately NOT passed — projectEnvelope resolves it
    // from options.task.context.solutionTaskCid (verdicts) or
    // envelope.task.cid (solutions), both already correct here.
    //
    // #1393 review finding 1: the envelope's own evidenceTier (above) is
    // aspirational for v2/v3 flows — 'committed' is stamped at sign time,
    // before deliver() has actually landed evidenceHash on chain. Saving
    // that optimistic tier straight into the corpus-ranking projection means
    // a race-lost or failed delivery would leave a 'committed' projection
    // outranking genuinely delivered 'self-signed' work. Save 'self-signed'
    // here unconditionally; deliver() upgrades it to the real tier only once
    // on-chain evidence is confirmed (mirrors the ERC-8004 setMetadata move
    // below — 'committed' must mean observable evidence exists, not intent).
    try {
      this.store.saveEnvelopeProjection({
        ...projectEnvelope(envelope, { envelopeCid, task: task.task }),
        evidenceTier: 'self-signed',
      });
    } catch (err) {
      console.warn(
        `[harness-engine] ${task.requestId}: envelope projection failed (non-fatal): `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }

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
    this.consumedRefsByRequest.delete(task.requestId);
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

    const requestId = task.requestId;
    const persistence = this.persistence;
    const autopilotTask = this.autopilotSessionTask(task);

    if (autopilotTask) {
      if (!evidenceHash) {
        throw new MissingEvidenceHashError(task.requestId);
      }
      let deliveryTxHash = task.deliveryTxHash as `0x${string}` | null;
      let deliveryDigest = task.deliveryDigest as `0x${string}` | null;
      const expectedDeliveryDigest = cidToDigestHex(manifestCid);
      if (!deliveryTxHash) {
        const expectedRole: 'solution' | 'verdict' =
          task.taskRole === 'evaluation' ? 'verdict' : 'solution';
        const expectedRecovery: MarketplaceDeliveryExpectation = {
          requestId: requestId as `0x${string}`,
          manifestCid,
          deliveryDigest: expectedDeliveryDigest,
          evidenceHash: evidenceHash as `0x${string}`,
          role: expectedRole,
          fromBlock: BigInt(task.onchainCreationBlock),
        };
        let recovered = await this.resolveExactMarketplaceDelivery(
          task,
          expectedRecovery,
        );
        if (recovered.state === 'terminal') return;
        if (recovered.state === 'matching') {
          deliveryTxHash = recovered.deliveryTxHash;
          deliveryDigest = expectedDeliveryDigest;
          persistence.setDeliveryTxHash(requestId, deliveryTxHash);
        } else {
          let delivery: Awaited<ReturnType<typeof deliverToMarketplace>> | null = null;
          try {
            delivery = await deliverToMarketplace(
              requestId as `0x${string}`,
              manifestCid,
              this.deliveryDeps,
              true,
            );
          } catch (deliveryError) {
            recovered = await this.resolveExactMarketplaceDelivery(
              task,
              expectedRecovery,
            );
            if (recovered.state === 'terminal') return;
            if (recovered.state === 'absent') throw deliveryError;
            deliveryTxHash = recovered.deliveryTxHash;
            deliveryDigest = expectedDeliveryDigest;
            persistence.setDeliveryTxHash(requestId, deliveryTxHash);
          }
          if (delivery) {
            deliveryTxHash = delivery.deliveryTxHash;
            deliveryDigest = delivery.deliveryDigest;
            persistence.setDeliveryTxHash(requestId, deliveryTxHash);
          }
        }
      }
      deliveryDigest ??= expectedDeliveryDigest;

      await this.ensureAutopilotDeliveryDiscoveryAnchor(
        task,
        manifestCid,
        evidenceHash,
      );

      persistence.transition(requestId, TaskRunState.AWAITING_ADOPTION, {
        deliveryTxHash,
        deliveryDigest,
        adoptionReceiptLocation: {
          repository: autopilotTask.session.repository,
          prNumber: autopilotTask.session.prNumber,
        },
        adoptionReceiptAuthors: autopilotTask.session.receiptAuthors,
        adoptionWaitStartedAt: task.adoptionWaitStartedAt ?? Date.now(),
        adoptionObservationAttempts: 0,
        adoptionNextObservationAt: Date.now(),
        adoptionLastObservation: null,
        adoptionLastError: null,
      });
      console.log(
        `[harness-engine] ${requestId} DELIVERING → AWAITING_ADOPTION deliveryTx=${deliveryTxHash}`,
      );
      return;
    }

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
      this.deliveryClaimOptions(task),
    );

    this.persistence.transition(requestId, TaskRunState.COMPLETE, {
      deliveryTxHash,
    });
    console.log(`[harness-engine] ${requestId} DELIVERING → COMPLETE deliveryTx=${deliveryTxHash} claimTx=${claimTxHash}`);
    await this.afterDeliveryClaimed(task, manifestCid, evidenceHash);
  }

  /**
   * Publish a self-signed ERC-8004 anchor before adoption polling begins.
   *
   * The broadcast hash is journaled synchronously, then reconciled on retry.
   * This closes the crash window without blindly sending duplicate metadata
   * transactions and gives exact discovery a durable pre-claim join anchor.
   */
  private async ensureAutopilotDeliveryDiscoveryAnchor(
    task: PersistedTaskRun,
    manifestCid: string,
    evidenceHash: `0x${string}`,
  ): Promise<void> {
    const publisher = this.identityPublisher;
    if (!publisher) {
      throw new DeliveryDiscoveryAnchorUnavailableError(
        task.requestId,
        new Error('identity publisher is not configured'),
      );
    }

    const kind: 'envelope' | 'evaluation' =
      task.taskRole === 'evaluation' ? 'evaluation' : 'envelope';
    const zeroMeasurement =
      '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
    const canEmitV2 =
      !!task.executorMode
      && !!task.executorCodeDigest
      && !!task.implName;

    const buildEncodedPayload = (): {
      payloadHex: `0x${string}`;
      publish: () => Promise<{
        txHash: `0x${string}`;
        blockNumber: number | null;
        gasUsed: bigint | null;
        feeWei: bigint | null;
      }>;
    } => {
      const onBroadcast = (txHash: `0x${string}`): void => {
        this.persistence.setDeliveryDiscoveryAnchor(task.requestId, txHash, null);
      };
      if (canEmitV2) {
        const payload: ExecutionPayloadV2 = {
          version: 2,
          tier: 0,
          manifestHash: evidenceHash,
          attestationQuoteCid: '0x',
          sourceMeasurement: zeroMeasurement,
          codeDigest: codeDigestSha256ToBytes32(task.executorCodeDigest!),
          implName: task.implName!,
          modeFlag: modeStringToFlag(task.executorMode!),
        };
        return {
          payloadHex: encodeExecutionPayloadV2(payload),
          publish: () => publisher.publishContentV2({
            kind,
            cid: manifestCid,
            payload,
            requireSuccessfulReceipt: true,
            onBroadcast,
          }),
        };
      }
      const payload: ExecutionPayload = {
        version: 1,
        tier: 0,
        manifestHash: evidenceHash,
        attestationQuoteCid: '0x',
        sourceMeasurement: zeroMeasurement,
      };
      return {
        payloadHex: encodeExecutionPayload(payload),
        publish: () => publisher.publishContent({
          kind,
          cid: manifestCid,
          payload,
          requireSuccessfulReceipt: true,
          onBroadcast,
        }),
      };
    };

    const { payloadHex, publish } = buildEncodedPayload();
    let result: {
      txHash: `0x${string}`;
      blockNumber: number | null;
      gasUsed: bigint | null;
      feeWei: bigint | null;
    };
    try {
      const journaledTx = task.deliveryDiscoveryAnchorTxHash as `0x${string}` | null;
      if (journaledTx && task.deliveryDiscoveryAnchorBlockNumber !== null) return;
      if (journaledTx) {
        const reconciliation = await publisher.reconcileTransaction(journaledTx);
        if (reconciliation.status === 'pending') {
          throw new Error(`metadata transaction ${journaledTx} is still pending`);
        }
        if (reconciliation.status === 'reverted') {
          this.persistence.setDeliveryDiscoveryAnchor(task.requestId, null, null);
          result = await publish();
        } else {
          result = reconciliation;
        }
      } else {
        result = await publish();
      }
      if (result.blockNumber === null) {
        this.persistence.setDeliveryDiscoveryAnchor(task.requestId, result.txHash, null);
        throw new Error(`metadata transaction ${result.txHash} has no confirmed block`);
      }

      this.store.saveErc8004Anchor({
        envelopeId: evidenceHash,
        envelopeCid: manifestCid,
        contentKind: kind,
        metadataKey: `${kind}:${manifestCid}`,
        agentId: publisher.agent.toString(),
        chainId: publisher.chainId,
        identityRegistryAddress: publisher.registry,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        payloadHex,
        anchoredAt: Math.floor(Date.now() / 1000),
        gasUsed: result.gasUsed?.toString() ?? null,
        feeWei: result.feeWei?.toString() ?? null,
      });
      this.persistence.setDeliveryDiscoveryAnchor(
        task.requestId,
        result.txHash,
        result.blockNumber,
      );
    } catch (error) {
      if (error instanceof DeliveryDiscoveryAnchorUnavailableError) throw error;
      throw new DeliveryDiscoveryAnchorUnavailableError(task.requestId, error);
    }
  }

  private async resolveExactMarketplaceDelivery(
    task: PersistedTaskRun,
    expected: MarketplaceDeliveryExpectation,
  ): Promise<
    | { state: 'absent' }
    | { state: 'terminal' }
    | { state: 'matching'; deliveryTxHash: `0x${string}` }
  > {
    if (!this.marketplaceDeliveryRecovery) {
      this.persistence.markFailed(
        task.requestId,
        'delivery-recovery-contradiction:exact delivery recovery is not configured',
      );
      return { state: 'terminal' };
    }
    const recovered = await this.marketplaceDeliveryRecovery
      .resolveExistingDelivery(expected);
    if (recovered.state === 'absent') return recovered;
    if (recovered.state === 'contradictory') {
      this.persistence.markFailed(
        task.requestId,
        `delivery-recovery-contradiction:${recovered.detail}`,
      );
      return { state: 'terminal' };
    }
    const matchesExpected = (
      recovered.requestId === expected.requestId
      && recovered.manifestCid === expected.manifestCid
      && recovered.deliveryDigest.toLowerCase()
        === expected.deliveryDigest.toLowerCase()
      && recovered.evidenceHash.toLowerCase()
        === expected.evidenceHash.toLowerCase()
      && recovered.role === expected.role
      && recovered.fromBlock === expected.fromBlock
      && /^0x[0-9a-f]{64}$/i.test(recovered.deliveryTxHash)
    );
    if (!matchesExpected) {
      this.persistence.markFailed(
        task.requestId,
        'delivery-recovery-contradiction:recovery metadata differs from persisted intent',
      );
      return { state: 'terminal' };
    }
    return {
      state: 'matching',
      deliveryTxHash: recovered.deliveryTxHash,
    };
  }

  /** Observe adoption without repeating delivery or claiming settlement. */
  protected async awaitAdoption(task: PersistedTaskRun): Promise<void> {
    if (
      task.adoptionNextObservationAt !== null
      && task.adoptionNextObservationAt > Date.now()
    ) {
      return;
    }
    const nextObservationAt = this.nextAdoptionObservationAt(task);
    if (!this.adoptionReceiptObserver) {
      this.persistence.setAdoptionError(
        task.requestId,
        Date.now() >= task.windowEndTs
          ? 'adoption-overdue:adoption receipt observer is not configured'
          : 'adoption receipt observer is not configured',
        nextObservationAt,
      );
      return;
    }

    let observation;
    try {
      observation = await this.adoptionReceiptObserver.observe(task);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.persistence.setAdoptionError(
        task.requestId,
        Date.now() >= task.windowEndTs
          ? `adoption-overdue:${detail}`
          : detail,
        nextObservationAt,
      );
      return;
    }

    switch (observation.state) {
      case 'pending':
        this.persistence.setAdoptionObservation(
          task.requestId,
          observation,
          nextObservationAt,
        );
        if (Date.now() >= task.windowEndTs) {
          this.persistence.setAdoptionError(
            task.requestId,
            `adoption-overdue:${observation.detail}`,
            nextObservationAt,
          );
        }
        return;
      case 'accepted': {
        const validation = this.validateAdoptionReceipt(task, observation.receipt);
        if (!validation.ok) {
          this.persistence.markFailed(task.requestId, validation.reason);
          return;
        }
        if (validation.receipt.disposition !== 'accepted') {
          this.persistence.markFailed(
            task.requestId,
            'adoption-contradiction:accepted observation carried a rejected receipt',
          );
          return;
        }
        const acceptedObservation = {
          state: 'accepted' as const,
          receipt: validation.receipt,
        };
        this.persistence.transition(task.requestId, TaskRunState.CLAIMING_DELIVERY, {
          adoptionLastObservation: acceptedObservation,
          adoptionAcceptedReceipt: validation.receipt,
          adoptionLastError: null,
          adoptionObservationAttempts: 0,
          adoptionNextObservationAt: Date.now(),
        });
        console.log(
          `[harness-engine] ${task.requestId} AWAITING_ADOPTION → CLAIMING_DELIVERY`,
        );
        return;
      }
      case 'rejected': {
        const validation = this.validateAdoptionReceipt(task, observation.receipt);
        if (!validation.ok) {
          this.persistence.markFailed(task.requestId, validation.reason);
          return;
        }
        if (validation.receipt.disposition !== 'rejected') {
          this.persistence.markFailed(
            task.requestId,
            'adoption-contradiction:rejected observation carried an accepted receipt',
          );
          return;
        }
        this.persistence.setAdoptionObservation(task.requestId, {
          state: 'rejected',
          receipt: validation.receipt,
        }, nextObservationAt);
        this.persistence.markFailed(
          task.requestId,
          `adoption-rejected:${validation.receipt.reason}`,
        );
        return;
      }
      case 'contradictory':
        this.persistence.setAdoptionObservation(
          task.requestId,
          observation,
          nextObservationAt,
        );
        this.persistence.markFailed(
          task.requestId,
          `adoption-contradiction:${observation.detail}`,
        );
    }
  }

  private nextAdoptionObservationAt(task: PersistedTaskRun): number {
    const exponent = Math.min(task.adoptionObservationAttempts, 8);
    const delay = Math.min(
      TaskEngine.ADOPTION_OBSERVATION_MAX_BACKOFF_MS,
      TaskEngine.ADOPTION_OBSERVATION_BASE_BACKOFF_MS * (2 ** exponent),
    );
    const digest = createHash('sha256')
      .update(`${task.requestId}:${task.adoptionObservationAttempts}`)
      .digest();
    const jitter = Math.floor(
      delay * 0.2 * (digest.readUInt16BE(0) / 0xffff),
    );
    return Date.now() + delay + jitter;
  }

  /** Re-observe the accepted receipt, then retry only the Router claim. */
  protected async claimAdoptedDelivery(task: PersistedTaskRun): Promise<void> {
    if (!this.deliveryDeps) {
      throw new NotImplementedError('claimAdoptedDelivery');
    }
    const persistedValidation = this.validateAdoptionReceipt(
      task,
      task.adoptionAcceptedReceipt,
    );
    if (
      !persistedValidation.ok
      || persistedValidation.receipt.disposition !== 'accepted'
    ) {
      this.persistence.markFailed(
        task.requestId,
        'adoption-contradiction:persisted accepted receipt mismatch',
      );
      return;
    }
    const manifestCid = task.manifestCid;
    if (!manifestCid) {
      throw new Error(
        `claimAdoptedDelivery: manifestCid missing for ${task.requestId}`,
      );
    }
    const evidenceHash =
      task.evidenceHash as `0x${string}` | null | undefined;
    if (
      !evidenceHash
      && (
        this.deliveryDeps.claimDeliveryVariant === 'v2'
        || this.deliveryDeps.claimDeliveryVariant === 'v3'
      )
    ) {
      throw new MissingEvidenceHashError(task.requestId);
    }
    try {
      if (await isRouterDeliveryClaimed(
        task.requestId as `0x${string}`,
        this.deliveryDeps,
      )) {
        this.persistence.transition(task.requestId, TaskRunState.COMPLETE);
        await this.afterDeliveryClaimed(task, manifestCid, evidenceHash);
        return;
      }
    } catch (error) {
      this.persistence.setClaimingAdoptionError(
        task.requestId,
        `router-claim-read:`
        + (error instanceof Error ? error.message : String(error)),
        this.nextAdoptionObservationAt(task),
      );
      return;
    }
    const retryMatch = task.adoptionLastError?.match(
      /^router-claim-retry-after:(\d+):/,
    );
    if (
      retryMatch !== null
      && Number(retryMatch?.[1]) > Date.now()
    ) {
      return;
    }
    if (
      task.adoptionNextObservationAt !== null
      && task.adoptionNextObservationAt > Date.now()
    ) {
      return;
    }
    const nextObservationAt = this.nextAdoptionObservationAt(task);

    if (!this.adoptionReceiptObserver) {
      this.persistence.setClaimingAdoptionError(
        task.requestId,
        'adoption receipt observer is not configured',
        nextObservationAt,
      );
      return;
    }

    let observation: AdoptionObservation;
    try {
      observation = await this.adoptionReceiptObserver.observe(task);
    } catch (err) {
      this.persistence.setClaimingAdoptionError(
        task.requestId,
        err instanceof Error ? err.message : String(err),
        nextObservationAt,
      );
      return;
    }

    if (observation.state === 'pending') {
      this.persistence.setClaimingAdoptionObservation(
        task.requestId,
        observation,
        nextObservationAt,
      );
      return;
    }
    if (observation.state === 'contradictory') {
      this.persistence.setClaimingAdoptionObservation(
        task.requestId,
        observation,
        null,
      );
      this.persistence.markFailed(
        task.requestId,
        `adoption-contradiction:${observation.detail}`,
      );
      return;
    }

    const observedValidation = this.validateAdoptionReceipt(
      task,
      observation.receipt,
    );
    if (!observedValidation.ok) {
      this.persistence.markFailed(task.requestId, observedValidation.reason);
      return;
    }
    if (observation.state === 'rejected') {
      if (observedValidation.receipt.disposition !== 'rejected') {
        this.persistence.markFailed(
          task.requestId,
          'adoption-contradiction:rejected observation carried an accepted receipt',
        );
        return;
      }
      this.persistence.setClaimingAdoptionObservation(task.requestId, {
        state: 'rejected',
        receipt: observedValidation.receipt,
      }, null);
      this.persistence.markFailed(
        task.requestId,
        `adoption-rejected:${observedValidation.receipt.reason}`,
      );
      return;
    }
    if (
      observedValidation.receipt.disposition !== 'accepted'
      || !autopilotCorrelationMatches(
        persistedValidation.receipt,
        observedValidation.receipt,
      )
      || JSON.stringify(persistedValidation.receipt)
        !== JSON.stringify(observedValidation.receipt)
    ) {
      this.persistence.markFailed(
        task.requestId,
        'adoption-contradiction:persisted accepted receipt mismatch',
      );
      return;
    }
    this.persistence.setClaimingAdoptionObservation(task.requestId, {
      state: 'accepted',
      receipt: observedValidation.receipt,
    }, null);

    let claimTxHash: `0x${string}`;
    try {
      claimTxHash = await claimRouterDelivery(
        task.requestId as `0x${string}`,
        evidenceHash as `0x${string}`,
        this.deliveryDeps,
        this.deliveryClaimOptions(task),
      );
    } catch (error) {
      if (isRecoverableTransactionError(error)) {
        const retryAt =
          Date.now() + TaskEngine.ADOPTION_CLAIM_RETRY_BACKOFF_MS;
        this.persistence.setClaimingAdoptionError(
          task.requestId,
          `router-claim-retry-after:${retryAt}:${
            error instanceof Error ? error.message : String(error)
          }`,
          retryAt,
        );
      }
      throw error;
    }
    this.persistence.transition(task.requestId, TaskRunState.COMPLETE);
    console.log(
      `[harness-engine] ${task.requestId} CLAIMING_DELIVERY → COMPLETE claimTx=${claimTxHash}`,
    );
    await this.afterDeliveryClaimed(task, manifestCid, evidenceHash);
  }

  private validateAdoptionReceipt(
    task: PersistedTaskRun,
    input: unknown,
  ): (
    { ok: true; receipt: AutopilotAdoptionReceipt }
    | { ok: false; reason: string }
  ) {
    const parsed = AutopilotAdoptionReceiptSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        reason: 'adoption-contradiction:invalid adoption receipt',
      };
    }

    const receipt = parsed.data;
    const expectedRole = task.taskRole === 'evaluation' ? 'verdict' : 'solution';
    if (receipt.role !== expectedRole) {
      return {
        ok: false,
        reason: `adoption-contradiction:receipt role ${receipt.role} does not match ${expectedRole}`,
      };
    }

    const autopilotTask = this.autopilotSessionTask(task);
    const expectedCorrelation = {
      taskId: task.taskId,
      attemptIndex: task.attemptIndex,
      requestId: task.requestId,
      deliveryEnvelopeCid: task.manifestCid,
      v2AttemptId: autopilotTask?.session.v2AttemptId ?? null,
      claimOid: autopilotTask?.session.claimOid ?? null,
      prNumber: autopilotTask?.session.prNumber ?? null,
      expectedHead: autopilotTask?.session.expectedHead ?? null,
    };
    for (const [field, expected] of Object.entries(expectedCorrelation)) {
      if (receipt[field as keyof typeof receipt] !== expected) {
        return {
          ok: false,
          reason: `adoption-contradiction:receipt correlation mismatch:${field}`,
        };
      }
    }

    if (receipt.disposition === 'accepted') {
      const deliveredCorrelation = this.persistedAutopilotCorrelation(
        task,
        expectedRole,
      );
      const correlationMatches = deliveredCorrelation
        && (
          expectedRole === 'solution'
            ? this.autopilotCorrelationIsReceiptPrefix(
              deliveredCorrelation,
              receipt,
            )
            : autopilotCorrelationMatches(deliveredCorrelation, receipt)
        );
      if (
        !deliveredCorrelation
        || !correlationMatches
      ) {
        return {
          ok: false,
          reason: 'adoption-contradiction:receipt correlation mismatch:delivered-output',
        };
      }
    }

    return { ok: true, receipt };
  }

  private autopilotCorrelationIsReceiptPrefix(
    delivered: AutopilotCorrelation,
    receipt: AutopilotCorrelation,
  ): boolean {
    return Object.entries(delivered).every(([field, expected]) => (
      expected === undefined
      || receipt[field as keyof AutopilotCorrelation] === expected
    ));
  }

  private persistedAutopilotCorrelation(
    task: PersistedTaskRun,
    role: 'solution' | 'verdict',
  ): AutopilotCorrelation | null {
    if (!task.solutionOutputsJson) return null;

    try {
      const output = JSON.parse(task.solutionOutputsJson) as {
        solutionPayload?: unknown;
        verdictPayload?: unknown;
      };
      const parsed = role === 'solution'
        ? JinnRepoAutopilotSolutionPayloadSchema.safeParse(output.solutionPayload)
        : JinnRepoAutopilotVerdictPayloadSchema.safeParse(output.verdictPayload);
      return parsed.success ? parsed.data.correlation : null;
    } catch {
      return null;
    }
  }

  private autopilotSessionTask(
    task: PersistedTaskRun,
  ): JinnRepoAutopilotSessionTask | null {
    const runtimeTask = task.task;
    const isJinnRepo = task.solverType === 'jinn-repo.v1'
      || (
        runtimeTask?.contractId === 'jinn-repo'
        && runtimeTask.contractVersion === 'v1'
      );
    if (!isJinnRepo) return null;
    const parsed = JinnRepoTaskSchema.safeParse(runtimeTask?.spec);
    if (!parsed.success || parsed.data.source !== 'autopilot-session') return null;
    return parsed.data;
  }

  private deliveryClaimOptions(task: PersistedTaskRun): DeliveryClaimOptions {
    return {
      kind: task.taskRole === 'evaluation' ? 'verdict' : 'solution',
      verdictCode: task.taskRole === 'evaluation' ? this.verdictCodeForTask(task) : undefined,
    };
  }

  private async afterDeliveryClaimed(
    task: PersistedTaskRun,
    manifestCid: string,
    evidenceHash: `0x${string}` | null | undefined,
  ): Promise<void> {
    if (!this.deliveryDeps) return;
    const requestId = task.requestId;
    // #1393 review finding 1: now that claimDelivery has actually succeeded
    // (on-chain evidenceHash confirmed), upgrade the local corpus projection
    // — saved as 'self-signed' by pack() regardless of intent — to the tier
    // the v2/v3 envelope was really entitled to. A race-lost or failed
    // delivery never reaches this line, so the projection simply stays
    // 'self-signed', which is the whole point of the downgrade in pack().
    // Non-fatal: a projection-tier upgrade failure must not fail an already-
    // successful delivery.
    if (this.deliveryDeps.claimDeliveryVariant === 'v2' || this.deliveryDeps.claimDeliveryVariant === 'v3') {
      try {
        this.store.upgradeEnvelopeProjectionEvidenceTier(manifestCid, 'committed');
      } catch (err) {
        console.warn(
          `[harness-engine] ${requestId}: envelope projection tier upgrade failed (non-fatal): `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Emit a SQLite artifact row so consumers (release acceptance gate, search
    // API) see this cycle alongside legacy-claude / MCP-emitted rows. The
    // legacy claude path writes via the MCP `submit_restoration_result` tool;
    // deterministic impls (prediction.v1 baseline/evaluator,
    // …) don't go through MCP, so the engine emits on their behalf here.
    // Idempotent: skips when a row for this requestId+tag already exists
    // (legacy path may have already inserted).
    this.emitCycleArtifact(task, manifestCid, evidenceHash);

    // ── ERC-8004 committed setMetadata republish ─────────────────────────────
    //
    // Autopilot runs already published a tier-0 discovery anchor after Mech
    // delivery. Only this post-Router-claim write may upgrade the same key to
    // tier 1 ('committed'). Non-Autopilot paths publish here for the first time.
    //
    // Both roles publish (jinn-mono-n93o): restoration runs emit
    // `envelope:<cid>`; evaluation runs emit `evaluation:<cid>`. The indexer's
    // verdictEnvelopeMeta enrichment branch (ebu7.13) listens for the
    // `evaluation:` prefix to surface verdicts in the explorer.
    if (this.identityPublisher) {
      const taskRoleRaw = task.taskRole ?? 'restoration';
      const metadataKind: 'envelope' | 'evaluation' =
        taskRoleRaw === 'evaluation' ? 'evaluation' : 'envelope';
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
        let pubBlockNumber: number | null;
        let payloadHex: `0x${string}`;
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
          payloadHex = encodeExecutionPayloadV2(v2Payload);
          const result = await this.identityPublisher.publishContentV2({
            kind: metadataKind,
            cid: manifestCid,
            payload: v2Payload,
          });
          pubTxHash = result.txHash;
          pubBlockNumber = result.blockNumber;
          console.log(
            `[harness-engine] ${requestId}: setMetadata ${metadataKind}:${manifestCid} tx=${pubTxHash} (payload v2 mode=${task.executorMode} impl=${harnessImplName})`,
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
          payloadHex = encodeExecutionPayload(v1Payload);
          const result = await this.identityPublisher.publishContent({
            kind: metadataKind,
            cid: manifestCid,
            payload: v1Payload,
          });
          pubTxHash = result.txHash;
          pubBlockNumber = result.blockNumber;
          console.log(
            `[harness-engine] ${requestId}: setMetadata ${metadataKind}:${manifestCid} tx=${pubTxHash} (payload v1)`,
          );
        }
        try {
          this.store.saveErc8004Anchor({
            envelopeId: manifestHashHex,
            envelopeCid: manifestCid,
            contentKind: metadataKind,
            metadataKey: `${metadataKind}:${manifestCid}`,
            agentId: this.identityPublisher.agent.toString(),
            chainId: this.identityPublisher.chainId,
            identityRegistryAddress: this.identityPublisher.registry,
            txHash: pubTxHash,
            blockNumber: pubBlockNumber,
            payloadHex,
            anchoredAt: Math.floor(Date.now() / 1000),
          });
        } catch (anchorErr) {
          console.warn(
            `[harness-engine] ${requestId}: failed to record erc8004 anchor (non-fatal): ${anchorErr instanceof Error ? anchorErr.message : anchorErr}`,
          );
        }
      } catch (err) {
        console.warn(
          `[harness-engine] ${requestId}: setMetadata ${metadataKind} publish failed (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
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

  private verdictCodeForTask(task: PersistedTaskRun): VerdictCode {
    const gating = task.gatingClaim as { verdict?: unknown } | null;
    const raw = gating?.verdict;
    switch (raw) {
      case 'PASS':
      case 'SCORED':
        return VerdictCode.Pass;
      case 'FAIL':
      case 'REJECTED':
        return VerdictCode.Fail;
      case 'INVALID':
        return VerdictCode.Invalid;
      case 'INDETERMINATE':
      case 'UNRESOLVED':
        return VerdictCode.Unresolved;
      default:
        throw new Error(
          `[harness-engine] verdictCodeForTask: missing or unrecognized gatingClaim.verdict (got=${String(raw)}); refusing to claim Invalid(3) on-chain without an explicit evaluator verdict`,
        );
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
   * Classify a transition error and mark the task terminal accordingly.
   *
   * - `SafeInnerRevertError` with a non-recoverable inner name (the same
   *   set the daemon's pre-claim catch in `emitTickErrorOrRaceLost` uses):
   *   the on-chain slot is already pruned (TCMaxVerdictsReached,
   *   TCAttemptAlreadyFinalized, …). We mark the row RACE_LOST and emit a
   *   `kind=race_lost` activity event so operators can audit prunes
   *   without inflating the FAILED counter (#896).
   * - A transport-transient error (e.g. `AllRpcsFailedError` — every provider
   *   in the L2 fallback chain failed at once) on a task whose delivery window
   *   is still open: leave the row in its current in-flight state so the next
   *   tick re-drives it once the RPCs recover, and emit a `tick_error` (warn)
   *   on first occurrence plus every `TRANSIENT_TICK_ERROR_HEARTBEAT_MS`
   *   thereafter for that requestId (#934) — not once per failing tick —
   *   instead of inflating the FAILED counter. Without the leave-in-flight
   *   path the daemon stamped the row FAILED, dropping it from
   *   `getInFlight()` permanently, so L2 work went silent until a manual
   *   restart (#912). Past-window transient errors still terminalize to avoid
   *   churning on work that can no longer settle.
   * - Everything else: existing markFailed behaviour. When invoked from
   *   recovery, `contextLabel === 'recovery'` so the failure_reason
   *   carries the `recovery:` prefix the original code path used.
   *
   * Returns the classification so callers can log appropriately.
   */
  private _classifyAndMarkTerminal(
    task: PersistedTaskRun,
    err: unknown,
    contextLabel: 'transition' | 'recovery',
  ): 'race_lost' | 'failed' | 'transient' {
    if (
      err instanceof SafeInnerRevertError &&
      isNonRecoverableInnerRevert(err.decodedName)
    ) {
      // decodedName is non-null by virtue of isNonRecoverableInnerRevert.
      const detail = formatDecodedRevert(err.decodedName!, err.decodedArgs);
      this.persistence.markRaceLost(task.requestId, detail);
      emitEvent(this.store, {
        kind: 'race_lost',
        requestId: task.requestId,
        solverType: task.solverType ?? undefined,
        outcome: 'ok',
        detail,
      }, 'harness-engine');
      this.lastTransientTickErrorAt.delete(task.requestId);
      return 'race_lost';
    }
    const reason = err instanceof Error ? err.message : String(err);
    // A transport-transient failure (all RPC providers in the fallback chain
    // blipped at once, 429s, timeouts, …) is not the task's fault and is not
    // permanent. Leave the row in its in-flight state — do NOT call
    // markFailed, which would drop it from getInFlight() forever (#912) — so
    // the engine-tick loop re-drives it once the RPCs recover. The tick loop
    // IS the retry; there is no per-task attempt counter. Skip this only once
    // the delivery window has closed, so we never churn on work that can no
    // longer settle on-chain.
    const recoverablePrerequisite =
      err instanceof TaskCreationTimestampUnavailableError
      || err instanceof DeliveryDiscoveryAnchorUnavailableError;
    const postDeliveryRecovery =
      task.state === TaskRunState.AWAITING_ADOPTION
      || task.state === TaskRunState.CLAIMING_DELIVERY;
    if (
      (postDeliveryRecovery || task.windowEndTs > Date.now())
      && (recoverablePrerequisite || isRecoverableTransactionError(err))
    ) {
      const now = Date.now();
      const last = this.lastTransientTickErrorAt.get(task.requestId);
      if (
        last === undefined
        || now - last >= TRANSIENT_TICK_ERROR_HEARTBEAT_MS
      ) {
        emitEvent(this.store, {
          kind: 'tick_error',
          requestId: task.requestId,
          solverType: task.solverType ?? undefined,
          outcome: 'warn',
          detail:
            `${recoverablePrerequisite ? 'recoverable prerequisite failure' : 'transient RPC failure'} `
            + `in ${contextLabel}; left ${task.state} for retry: ${reason}`,
        }, 'harness-engine');
        this.lastTransientTickErrorAt.set(task.requestId, now);
      }
      return 'transient';
    }
    const stamped = contextLabel === 'recovery' ? `recovery: ${reason}` : reason;
    this.persistence.markFailed(task.requestId, stamped);
    this.lastTransientTickErrorAt.delete(task.requestId);
    return 'failed';
  }

  /**
   * Wraps a transition method call with error handling: if the transition
   * throws, the task is marked terminal (FAILED or RACE_LOST per
   * `_classifyAndMarkTerminal`) and the error is rethrown so the caller can
   * surface it.
   */
  private async _runTransition(
    task: PersistedTaskRun,
    fn: () => Promise<void>,
  ): Promise<void> {
    // Each transition method (claim, takePreSnapshot, runImpl, pack, deliver)
    // logs its own domain-specific line on success (e.g. with manifestCid,
    // deliveryTx, impl name). We deliberately don't emit a generic
    // `oldState → newState` line here: doing so produced duplicate
    // transition lines in the operator log (jinn-mono-kzan). On failure,
    // the catch below routes through the race-loss classifier and rethrows.
    try {
      await fn();
    } catch (err) {
      this._classifyAndMarkTerminal(task, err, 'transition');
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
      // If recovery itself throws (e.g. NotImplementedError stub), classify
      // the error and mark the row terminal. NotImplementedError is expected
      // during development; don't swallow it in prod.
      // Only act if the task is still in the same non-terminal state
      // (another concurrent recovery pass might have already advanced it).
      const current = this.persistence.getByRequestId(task.requestId);
      if (current && current.state === task.state) {
        const classification = this._classifyAndMarkTerminal(task, err, 'recovery');
        const reason = err instanceof Error ? err.message : String(err);
        // 'transient' leaves the row in-flight (not terminal); the next tick
        // re-drives it once the RPCs recover (#912). Log it at warn so the
        // stall is visible without firing the error-level alerting that a
        // genuine failure does.
        const { log, verb } = {
          race_lost: { log: console.log, verb: 'pruned' },
          transient: { log: console.warn, verb: 'deferred (transient RPC)' },
          failed: { log: console.error, verb: 'failed' },
        }[classification];
        log(`[harness-engine] resume ${verb} for ${task.requestId}: ${reason}`);
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

      case TaskRunState.AWAITING_ADOPTION:
        // Receipt observation only. Never repeats Mech delivery.
        await this.awaitAdoption(task);
        break;

      case TaskRunState.CLAIMING_DELIVERY:
        // Recheck adoption freshness, then retry only the Router claim.
        // Never repeat Mech delivery.
        await this.claimAdoptedDelivery(task);
        break;

      case TaskRunState.COMPLETE:
      case TaskRunState.FAILED:
      case TaskRunState.RACE_LOST:
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
export function effectiveHarnessDeadline(
  task: PersistedTaskRun,
  role: 'restoration' | 'evaluation',
  nowMs = Date.now(),
): number {
  const runtimeTask = task.task;
  let deadline = task.windowEndTs;
  if (
    runtimeTask?.spec?.['source'] !== 'autopilot-session'
  ) {
    return deadline;
  }
  if (role === 'restoration') {
    const session = runtimeTask.spec['session'];
    const sessionDeadline = typeof session === 'object'
      && session !== null
      && typeof (session as { deadline?: unknown }).deadline === 'string'
      ? Date.parse((session as { deadline: string }).deadline)
      : Number.NaN;
    return Number.isFinite(sessionDeadline)
      ? Math.min(deadline, sessionDeadline)
      : deadline;
  }
  const EVALUATOR_SOFT_DEADLINE_MS = 60 * 60 * 1000;
  const VERDICT_ADOPTION_RESERVE_MS = 30 * 60 * 1000;
  return Math.min(
    nowMs + EVALUATOR_SOFT_DEADLINE_MS,
    deadline - VERDICT_ADOPTION_RESERVE_MS,
  );
}
