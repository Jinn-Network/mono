/**
 * DiscoveryAPI interface and shared types.
 *
 * The interface abstracts the daemon's read-side discovery queries (claimable
 * tasks, SolverNet manifests, corpus envelopes) from the backing store. Three
 * implementations exist: HttpDiscoveryAPI, EmbeddedPonderDiscoveryAPI, and
 * OnchainDiscoveryAPI. Callers always hold a DiscoveryAPI — they never depend
 * on a specific backing.
 *
 * Spec: spec/2026-05-11-discovery-api-and-shared-indexer.md §5.
 */

// ── Re-exports from sibling modules ─────────────────────────────────────────

// SolverNetManifestSummary is the canonical catalog-row shape used by both the
// registry client and the DiscoveryAPI; re-exported here so consumers of
// discovery only need one import path.
export type { SolverNetManifestSummary, SolverNetLifecycleStatus } from '../solvernets/registry-client.js';

// EnvelopeRef and CorpusQuery are the corpus library's public types; discovery
// returns them directly so the corpus library can wrap DiscoveryAPI without
// an impedance mismatch.
export type { EnvelopeRef, CorpusQuery } from '../corpus/types.js';

// ── Local imports used in the interface ─────────────────────────────────────

import type { SolverNetManifestSummary, SolverNetLifecycleStatus } from '../solvernets/registry-client.js';
import type { EnvelopeRef, CorpusQuery } from '../corpus/types.js';

// ── New types ────────────────────────────────────────────────────────────────

/**
 * A single task candidate that can be claimed by the operator.
 *
 * This is the same shape as `SubgraphTaskCandidate` in
 * `client/src/adapters/mech/task-subgraph.ts`, renamed and re-homed here as
 * the canonical type. The subgraph module retains its own definition until
 * callsite migration (jinn-mono-280n.3) lands and the old file is retired.
 */
export interface ClaimableTaskCandidate {
  taskId: string;
  taskCidDigest: `0x${string}`;
  manifestDigest: `0x${string}`;
  createdAtBlock?: number;
  createdAtTx?: `0x${string}`;
  claimWindowEnd?: number;
  maxClaims?: number;
  attemptCount: number;
  operatorAttemptCount: number;
}

/**
 * On-chain finalization status for a posted Task, as rendered in the Launcher
 * "Recent posted Tasks" table. This is a DISPLAY/advisory signal — distinct
 * from the generator-side local `LauncherTaskState` — sourced from the indexer
 * `task` table. `'unknown'` is the safe degraded default whenever the status
 * cannot be resolved (floor outage, not-yet-indexed task); callers MUST map
 * absence to `'unknown'` and never guess `'open'`.
 */
export type TaskOnchainStatus = 'open' | 'finalized' | 'expired' | 'unknown';

/**
 * Per-task on-chain finalization snapshot, returned by `getTaskStatuses` keyed
 * by on-chain taskId (decimal string). `claimWindowEnd` is unix seconds and MAY
 * be null/undefined in the live indexer today (its call-trace decode is
 * pending), so a missing/invalid window degrades to 'unknown' rather than
 * guessing 'open'.
 */
export interface TaskStatusSnapshot {
  taskId: string;
  finalized: boolean;
  refunded: boolean;
  claimWindowEnd?: number;
}

/**
 * Resolved verdict tally for one task, returned by `getVerdictTallies` keyed by
 * decimal taskId. This is a DISPLAY/advisory signal (like `getTaskStatuses`) —
 * it backs the operator Activity table's task-relative Outcome column, NOT a
 * correctness gate.
 *
 * `pass` / `fail` count `verdictEnvelopeMeta` rows whose `evaluatorVerdict` is
 * `PASS` / `FAIL` respectively; the indexer folds REJECTED→FAIL, and INVALID /
 * INDETERMINATE / UNKNOWN verdicts are excluded from both poles. The quorum rule
 * over `pass` / `fail` lives in `client/src/api/run-outcome.ts`
 * (spec/2026-05-22-run-outcome.md §2).
 *
 * Callers map an absent taskId (or a floor-empty Map) to `'awaiting'` — never a
 * wrong `'fail'`.
 */
export interface VerdictTallyResult {
  pass: number;
  fail: number;
}

/** Top-level evidence for one posted task (#2044). */
export interface TaskLifecycleEvidence {
  taskId: string;
  /** Chain-derived facts only. Never populated from *EnvelopeMeta. */
  authoritative: AuthoritativeTaskLifecycle;
}

export interface AuthoritativeTaskLifecycle {
  task: AuthoritativeTaskRow;
  /** Sorted by attemptIndex ascending. */
  attempts: AuthoritativeAttemptRow[];
}

export interface AuthoritativeTaskRow {
  taskId: string;
  chainId: number;
  manifestDigest: `0x${string}`;
  taskCidDigest: `0x${string}`;
  creator: `0x${string}`;
  maxClaims: number;
  requiredVerdicts: number;
  createdAtBlock: number;
  createdAtTx?: `0x${string}`;
  finalized: boolean;
  refunded: boolean;
}

export interface AuthoritativeAttemptRow {
  taskId: string;
  chainId: number;
  attemptIndex: number;
  /** MechMarketplace SOLVE requestId. */
  requestId: `0x${string}`;
  operator: `0x${string}`;
  priorityMech: `0x${string}`;
  deliveryRate: string;
  createdAtBlock: number;
  /** Sorted by verdictIndex ascending. */
  verdicts: AuthoritativeVerdictRow[];
  attemptEnvelopeCandidates: AttemptEnvelopeCandidate[];
}

export interface AuthoritativeVerdictRow {
  taskId: string;
  chainId: number;
  attemptIndex: number;
  verdictIndex: number;
  /** MechMarketplace EVAL requestId (≠ attempt.requestId). */
  requestId: `0x${string}`;
  evaluator: `0x${string}`;
  /** On-chain VerdictCode 0..4 only — not envelope actualPassed. */
  verdictCode: number;
  createdAtBlock: number;
  verdictEnvelopeCandidates: VerdictEnvelopeCandidate[];
}

export interface AttemptEnvelopeCandidate {
  requestId: `0x${string}`;
  chainId: number;
  manifestCid: string;
  publisherAgentId: string;
  manifestHash: `0x${string}`;
  enrichedAtBlock: number;
  solverType?: string;
  implName?: string;
  implVersion?: string;
  codeDigest?: string;
  mode?: string;
  pluginsJson?: string;
  model?: string;
  evidenceTier?: string;
  sourcePublished?: boolean;
  enrichmentStatus?: string;
}

export interface VerdictEnvelopeCandidate {
  requestId: `0x${string}`;
  chainId: number;
  manifestCid: string;
  publisherAgentId: string;
  manifestHash: `0x${string}`;
  enrichedAtBlock: number;
  solverType?: string;
  evidenceTier?: string;
  actualPassed?: boolean;
  actualScore?: string;
  evaluatorVerdict?: string;
  solutionRequestId?: string;
  instanceId?: string;
  solverNetManifestCid?: string;
  enrichmentStatus?: string;
  projectedTaskId?: string;
  projectedAttemptIndex?: number;
  projectedVerdictIndex?: number;
  projectedEvaluator?: `0x${string}`;
}

/**
 * Per-on-chain-task claim-budget snapshot for a launched SolverNet. Returned by
 * `getInstanceClaimCounts`, keyed by **on-chain taskId** (decimal string) — NOT
 * by instance_id, because the on-chain `task`/`attempt` tables carry no
 * instance_id (only IPFS enrichment does). The generator owns the
 * taskId → instance_id join via its local `generator-state.json` ledger
 * (`last_task_id`), so it looks up its known posted taskIds in this map.
 */
export interface InstanceClaimCount {
  /** On-chain taskId (decimal string), matching `task.id` in the indexer. */
  taskId: string;
  /** Number of attempt rows recorded for this task = consumed claim slots. */
  consumed: number;
  /** maxClaims from the task's TaskCreated event = the one-way claim budget. */
  maxClaims: number;
}

/**
 * Exact indexer candidates used to recover an Autopilot marketplace delivery.
 *
 * This read is intentionally narrower than the ordinary discovery surfaces:
 * one chain, one marketplace task id, one role.  A successful result preserves
 * every on-chain/indexed join key needed by the delivery observer; absence is
 * pending and ambiguity is a contradiction.
 */
export type AutopilotDeliveryRole = 'solution' | 'verdict';

export interface AutopilotDeliveryTaskCandidate {
  taskId: string;
  taskCidDigest: `0x${string}`;
  createdAtBlock: number;
  createdAtTx: `0x${string}`;
}

export interface AutopilotDeliveryAttemptCandidate {
  taskId: string;
  attemptIndex: number;
  requestId: `0x${string}`;
  operator: `0x${string}`;
  /** Indexed attempt/delivery block when present; null for pre-adoption verdict metadata. */
  createdAtBlock: number | null;
}

export interface AutopilotDeliveryEnvelopeCandidate {
  requestId: `0x${string}`;
  manifestCid: string;
  publisherAgentId: string;
  manifestHash: `0x${string}`;
  enrichedAtBlock: number;
}

export type AutopilotDeliveryCandidateLookup =
  | {
      status: 'pending';
      reason:
        | 'task-not-indexed'
        | 'attempt-not-indexed'
        | 'envelope-not-indexed'
        | 'exact-indexer-required';
      taskId: string;
      role: AutopilotDeliveryRole;
    }
  | {
      status: 'contradiction';
      reason:
        | 'multiple-tasks'
        | 'multiple-attempts'
        | 'multiple-verdicts'
        | 'multiple-envelopes'
        | 'inconsistent-indexer-data';
      taskId: string;
      role: AutopilotDeliveryRole;
    }
  | {
      status: 'ready';
      role: AutopilotDeliveryRole;
      task: AutopilotDeliveryTaskCandidate;
      attempt: AutopilotDeliveryAttemptCandidate;
      /** Safe that authored the solution attempt; distinct from a verdict evaluator. */
      solutionOperator: `0x${string}`;
      envelope: AutopilotDeliveryEnvelopeCandidate;
    };

// ── PublishedArtifact base (attd) ────────────────────────────────────────────
//
// A common read-shape for builder-published artifacts. Today only plug-ins
// are published (kind `plugin:<cid>` on the IdentityRegistry); a future Path 2
// publishing epic adds `harness:<cid>` as a sibling kind with its own payload
// schema (the `client/schemas/jinn-manifest-v1.json` shape) and adds it to the
// `artifactType` union below. The unified shape is the read-layer integration
// point per spec §5.6 — the on-chain layer stays per-artifact-type with
// distinct payload tuples; this interface unifies the read API.

/**
 * Base shape for a builder-published artifact. Discriminated on `artifactType`
 * so future kinds (`harness`) add without breaking consumers.
 */
export interface PublishedArtifact {
  /** Builder agentId (decimal string of the uint256). */
  builderAgentId: string;
  /** IPFS CID of the published artifact tarball / manifest. */
  cid: string;
  /** Display name from the payload (e.g. npm package name, or harness name). */
  name: string;
  /** Display version (semver or harness version string). */
  version: string;
  /** SolverType ids the artifact supports. */
  supports: readonly string[];
  /** Publish time — unix seconds, from the payload's payload-stamped time. */
  publishedAt: number;
  /** Discriminator. Today only `'plugin'`; future: `| 'harness'`. */
  artifactType: 'plugin';
  /** True when the most-recent record is a revocation. */
  revoked: boolean;
  /** Reason from the revocation record, when revoked. */
  revokedReason?: string;
}

/**
 * The plug-in flavour of `PublishedArtifact`. Adds `pluginSha256` which is the
 * fork-attribution join key against envelope `executor.plugins[].sha256`.
 */
export interface PluginPublication extends PublishedArtifact {
  artifactType: 'plugin';
  /** digestDirectory output for the packed tarball. */
  pluginSha256: `0x${string}`;
}

/**
 * One row of score history for a published plug-in. The join key is the cid
 * — the indexer matches envelope `executor.plugins[].cid` against
 * `pluginPublication.pluginCid`. When the envelope's sha256 mismatches the
 * publication's sha256, `forkSuspected` is true and the row is excluded from
 * builder-credit aggregations per spec §5.3.
 */
export interface PluginScoreHistoryRow {
  pluginCid: string;
  taskId: string;
  /** Operator agentId of the daemon that ran the task. */
  operatorAgentId: string;
  /** 'Pass' | 'Fail' | 'Rejected' | 'Indeterminate' | 'Unknown'. */
  verdict: string;
  /** Numeric score when the verdict is graded (Pass=100, Fail=0); undefined when not. */
  score?: number;
  /** Unix seconds the verdict envelope was published. */
  ts: number;
  /** True when the envelope's plug-in sha256 did not match the publication's sha256. */
  forkSuspected: boolean;
}

/**
 * One read-time row of a builder-attributed task run. Joins `pluginPublication`
 * against `attemptEnvelopeMeta` and `verdict` in the indexer. Fork-suspected
 * rows are flagged but still returned so the SPA can render them with a
 * "modified plug-in" badge per spec §5.3.
 */
export interface BuilderAttributedRun {
  builderAgentId: string;
  pluginCid: string;
  pluginName: string;
  pluginVersion: string;
  taskId: string;
  attemptRequestId: `0x${string}`;
  operatorAgentId: string;
  verdict: string;
  score?: number;
  forkSuspected: boolean;
  ts: number;
}

// ── Interface ────────────────────────────────────────────────────────────────

/**
 * Read-only discovery interface. Abstracts the daemon's read-side queries so
 * the backing (HTTP indexer, embedded Ponder, or direct on-chain RPC) can be
 * swapped without changing call-sites.
 *
 * Each method may throw `DiscoveryUnavailableError` when the backing is
 * temporarily unavailable. The `withFallback` wrapper catches these and routes
 * to the floor implementation for the duration of the outage.
 */

/**
 * Per-codeDigest network-truth reward aggregate (issue #764). One row per
 * distinct executor.codeDigest, joining attemptEnvelopeMeta (codeDigest, mode)
 * to verdictEnvelopeMeta (actualPassed, actualScore) on (requestId, chainId).
 * `actualPassed` is the source of truth (NOT the on-chain verdictCode, which
 * defaults to Pass — see verdictEnvelopeMeta JSDoc).
 */
/**
 * Windowed on-chain task-post counts for one scope (chain-wide or a single
 * SolverNet). Each window is a count of `TaskCreated` events whose block falls
 * within the last 1h / 6h / 24h, computed backend-side as a block-window
 * approximation (Base ~2s blocktime: 1h≈1800, 6h≈10800, 24h≈43200 blocks back
 * from head). The windows nest: `h1 ⊆ h6 ⊆ h24`. Counts are approximate —
 * blocktime drift and the per-call scan cap mean the 24h figure is a lower
 * bound on a very high-volume SolverNet. See `DiscoveryAPI.getTaskPostCounts`.
 */
export interface TaskPostCounts {
  /** TaskCreated events in the last ~1h. */
  h1: number;
  /** TaskCreated events in the last ~6h (includes h1). */
  h6: number;
  /** TaskCreated events in the last ~24h (includes h6). */
  h24: number;
  /** Block at the head of the window (Number(getBlockNumber()) on-chain; the latest indexed task block on HTTP). */
  windowEndBlock: number;
  /** Unix seconds the window was computed. */
  windowEndTs: number;
}

/**
 * Block-window thresholds for `getTaskPostCounts`, from Base's ~2s blocktime:
 * 1h≈1800, 6h≈10800, 24h≈43200 blocks back from the window head. Shared by the
 * HTTP and on-chain backings so they bucket identically. The windows nest
 * (h1 ⊆ h6 ⊆ h24); the 24h figure also bounds the on-chain scan range.
 */
export const TASK_POST_WINDOW_BLOCKS = { h1: 1_800, h6: 10_800, h24: 43_200 } as const;

/**
 * Bucket a stream of TaskCreated events into chain-wide + per-cid
 * `TaskPostCounts`, shared by both DiscoveryAPI backings. `events` carry a
 * `block` (number) and lowercased manifest `digest`; `cidByDigest` maps each
 * requested digest to its cid. Counts nest (h1 ⊆ h6 ⊆ h24); events older than
 * the 24h cut are ignored.
 */
export function bucketTaskPostCounts(
  windowEndBlock: number,
  windowEndTs: number,
  events: Array<{ block: number; digest: string }>,
  cidByDigest: Map<string, string>,
): { chain: TaskPostCounts; byCid: Record<string, TaskPostCounts> } {
  const h1Cut = windowEndBlock - TASK_POST_WINDOW_BLOCKS.h1;
  const h6Cut = windowEndBlock - TASK_POST_WINDOW_BLOCKS.h6;
  const h24Cut = windowEndBlock - TASK_POST_WINDOW_BLOCKS.h24;

  const blank = (): TaskPostCounts => ({ h1: 0, h6: 0, h24: 0, windowEndBlock, windowEndTs });
  const chain = blank();
  const byCid: Record<string, TaskPostCounts> = {};
  for (const cid of cidByDigest.values()) byCid[cid] = blank();

  const bucket = (target: TaskPostCounts, block: number): void => {
    if (block < h24Cut) return;
    target.h24 += 1;
    if (block >= h6Cut) target.h6 += 1;
    if (block >= h1Cut) target.h1 += 1;
  };

  for (const e of events) {
    bucket(chain, e.block);
    const cid = cidByDigest.get(e.digest);
    if (cid) bucket(byCid[cid], e.block);
  }

  return { chain, byCid };
}

export interface CodeDigestRewardRow {
  /** The executor.codeDigest, e.g. "sha256:<hex>". */
  codeDigest: string;
  /** Count of distinct (requestId, chainId) attempts with a verdict, mode='train'. */
  attempts: number;
  /** Count where verdictEnvelopeMeta.actualPassed === true. */
  passes: number;
  /** passes / attempts; 0 when attempts === 0. */
  passRate: number;
  /** Mean of numeric actualScore over verdicts that carried one; 0 when none. */
  avgScore: number;
  /**
   * Per-attempt graded score (passedCount/totalCount) for in-window verdicts
   * that carried v2 counts (totalCount > 0). Empty / short when verdicts predate
   * verdict.v2. Consumed by the learner's Mann-Whitney sensitivity tier (#1019).
   */
  gradedScores: number[];
}

export interface DiscoveryAPI {
  /**
   * Resolve the exact indexed task/attempt/envelope rows for an Autopilot
   * marketplace delivery. Implementations must not substitute recent/global
   * scans: a missing exact row is pending and multiple/inconsistent rows are a
   * contradiction. Verdict discovery is additive and unsupported in v1.
   */
  getAutopilotDeliveryCandidates(args: {
    chainId: number;
    taskId: string;
    role: AutopilotDeliveryRole;
  }): Promise<AutopilotDeliveryCandidateLookup>;

  /**
   * Returns claimable task candidates for a set of SolverNet manifests,
   * filtered to tasks the given operator has not yet attempted.
   *
   * Replaces `queryClaimableTaskCandidates` in
   * `client/src/adapters/mech/task-subgraph.ts`.
   */
  findClaimableTasks(args: {
    solverNetManifestCids: string[];
    operatorAddress: `0x${string}`;
    nowSeconds?: number;
    pageSize?: number;
    maxPages?: number;
  }): Promise<ClaimableTaskCandidate[]>;

  /**
   * Returns launched SolverNet manifest summaries, optionally filtered by
   * launcher agent or lifecycle status.
   *
   * Replaces the subgraph fetcher in
   * `client/src/solvernets/registry-client-erc8004.ts`.
   */
  listLaunchedSolverNets(args?: {
    launcherAgentId?: string;
    status?: Array<'launched' | 'paused' | 'retired'>;
  }): Promise<SolverNetManifestSummary[]>;

  /**
   * Returns the current lifecycle status for a given manifest CID, or
   * `undefined` if no lifecycle events have been recorded for it yet.
   */
  getLifecycleStatus(manifestCid: string): Promise<SolverNetLifecycleStatus | undefined>;

  /**
   * Returns the number of distinct operators that have *ever* claimed a task
   * on the SolverNet identified by `manifestCid` — i.e. the count of unique
   * `attempt.operator` Safe addresses across every task whose
   * `manifestDigest === keccak256(manifestCid)`, **including tasks that are
   * now finalized or refunded**.
   *
   * This is an *ever-participated* signal, not a "currently active" one. The
   * count never filters on task lifecycle state: the on-chain backing reads
   * raw `TaskAttemptCreated` logs, which carry no finalized/refunded flag, so
   * the only count consistent across all three backings (HTTP / embedded /
   * on-chain) is the all-time distinct-operator total. Treat it as "operators
   * who have participated at least once", not "operators participating today".
   *
   * It is the protocol-observable participation signal: a "join" in the
   * operator app is purely a local config write (`joinedSolverNets[<cid>]`,
   * see `spec/2026-05-05-solvernet-creation-and-launch.md` §12) and leaves no
   * on-chain footprint. An operator only becomes visible to the network once
   * they claim a task — `TaskAttemptCreated` is the first on-chain event tied
   * to (operator, SolverNet). This method therefore counts *participating*
   * operators (operators who have claimed at least one task), which is the
   * only honest cross-operator count derivable from the indexer / chain.
   *
   * Task pagination is hard-capped (`MAX_OPERATOR_COUNT_TASK_PAGES` in each
   * backing) so a pathological task volume cannot turn this into an unbounded
   * scan; on a SolverNet beyond the cap the count is a lower bound.
   *
   * Returns `0` when no operator has attempted a task on the SolverNet yet.
   */
  getSolverNetOperatorCount(manifestCid: string): Promise<number>;

  /**
   * Returns envelope refs matching the query. Refs only — byte retrieval is
   * done by the corpus library on demand.
   *
   * Replaces the subgraph branch of `corpus/index.ts::query`.
   */
  queryEnvelopes(query: CorpusQuery): Promise<EnvelopeRef[]>;

  /**
   * Returns published plug-ins, optionally filtered by SolverType (`supports`)
   * or builder agentId. Used by the `/build` SPA route's "browse published
   * plug-ins" panel and the operator app's plug-in discovery surface.
   *
   * Backed by the `pluginPublication` indexer entity. Revoked rows are
   * included by default; pass `includeRevoked: false` to exclude them.
   */
  listPluginPublications(args?: {
    solverType?: string;
    builderAgentId?: string;
    includeRevoked?: boolean;
    limit?: number;
  }): Promise<PluginPublication[]>;

  /**
   * Returns score history for a published plug-in by cid. Each row is a
   * verdict-attached envelope where `executor.plugins[].cid === pluginCid`.
   * Rows where the envelope's sha256 did not match the publication's sha256
   * are flagged with `forkSuspected: true` and excluded from builder-credit
   * aggregations per spec §5.3.
   *
   * The HTTP implementation currently returns an empty array. The available
   * `attemptEnvelopeMeta` rows are permissionless shape projections, not
   * authenticated score evidence; this surface stays fail-closed until the
   * indexer materializes publisher-Safe/signature/hash-bound canonical rows.
   */
  getPluginScores(args: {
    pluginCid: string;
    limit?: number;
  }): Promise<PluginScoreHistoryRow[]>;

  /**
   * Returns all published artifacts for a builder agentId, typed by
   * `artifactType`. Today only plug-ins; the `harness` variant will appear
   * here when the Path 2 publishing epic ships, without changes to the
   * call-site.
   */
  listBuilderArtifacts(args: {
    builderAgentId: string;
    limit?: number;
  }): Promise<PublishedArtifact[]>;

  /**
   * Returns authenticated network pass counts per swe-rebench-v2 instance.
   * The HTTP and on-chain implementations currently return an empty Map:
   * permissionless verdict projections cannot safely raise launcher saturation.
   * A future non-empty implementation must bind the historical publisher Safe,
   * envelope signature/hash, authoritative verdict tuple, and original task
   * before applying SolverNet or instance filters.
   */
  getInstanceSuccessCounts(args: {
    manifestCid: string;
  }): Promise<Map<string, number>>;

  /**
   * Returns authenticated per-codeDigest reward aggregates. The HTTP and
   * on-chain implementations currently return an empty array, which callers
   * classify as insufficient evidence. A request/chain join is not enough:
   * future non-empty rows must have the same bridge-grade publisher Safe,
   * signature/hash, authoritative attempt/verdict, and original-task binding.
   */
  getCodeDigestRewards(args: {
    codeDigests: string[];
    operator?: `0x${string}`;
    solverNetManifestCid?: string;
    window?: number;
  }): Promise<CodeDigestRewardRow[]>;

  /**
   * Returns the per-task claim-budget snapshot for every task posted on the
   * SolverNet identified by `manifestCid`. Keyed by on-chain taskId; each value
   * carries `consumed` (count of `attempt` rows) and `maxClaims` (the one-way
   * claim budget from TaskCreated). A task is *exhausted* when
   * `consumed >= maxClaims`.
   *
   * Modelled one-for-one on `getInstanceSuccessCounts`: backed by the indexer's
   * `task` + `attempt` tables. Throws `DiscoveryUnavailableError` when the
   * backing is unreachable — on a genuine error the caller MUST abort the tick,
   * not treat the absence of data as truth. The `withFallback` wrapper enforces
   * this by never routing `getInstanceClaimCounts` to the floor: a *successful*
   * empty Map from the floor is indistinguishable from "every task has 0
   * consumed slots", so on a real outage it would silently mask exhaustion —
   * exhausted postings would classify `live`, their reposts would be suppressed,
   * and the SolverNet would under-serve N (#802, mirroring #669).
   *
   * Note the generator's own classifier treats a *missing entry for a known
   * taskId* as `live` (assume not-yet-indexed; the indexer never deletes task
   * rows, so a finalized/refunded/exhausted task is still present), which is why
   * the floor must propagate the error rather than return an empty success: a
   * whole-map empty-success would make every posting inert, not storm.
   *
   * The on-chain floor implementation returns an empty Map (the runtime path is
   * never the floor for this method — `withFallback` propagates the error
   * instead). The claim data IS reconstructible on-chain, but the floor stays a
   * no-op to keep the abort-on-outage guarantee symmetric with
   * `getInstanceSuccessCounts`.
   */
  getInstanceClaimCounts(args: {
    manifestCid: string;
  }): Promise<Map<string, InstanceClaimCount>>;

  /**
   * Returns windowed on-chain task-post counts (last 1h / 6h / 24h) sourced
   * from `TaskCreated` events on the active chain's JinnRouter / TaskCoordinator.
   * Always returns the `chain`-wide totals; when `manifestCids` is supplied, also
   * returns per-SolverNet totals in `byCid` (keyed by manifest CID), joined via
   * `manifestDigestForCid(cid)` against each event's `manifestDigest`.
   *
   * Windowing is a block-window approximation computed backend-side (Base ~2s
   * blocktime — see `TaskPostCounts`); counts are approximate. Each backing caps
   * its scan, so on a very high-volume chain the figures are a lower bound.
   *
   * This is a *supply signal*, not a correctness gate, so it is NOT
   * abort-on-outage: like `getSolverNetOperatorCount`, the `withFallback` wrapper
   * routes it to the on-chain floor when the indexer is unavailable rather than
   * propagating `DiscoveryUnavailableError`. The on-chain floor reconstructs the
   * counts directly from `TaskCreated` logs.
   */
  getTaskPostCounts(args?: { manifestCids?: string[] }): Promise<{
    windowEndBlock: number;
    windowEndTs: number;
    /** Chain-wide totals (always present). */
    chain: TaskPostCounts;
    /** Per-SolverNet totals keyed by manifest CID; empty `{}` when no manifestCids given. */
    byCid: Record<string, TaskPostCounts>;
  }>;

  /**
   * Returns the most-recently-created task on the SolverNet identified by
   * `manifestCid` — its on-chain `taskCidDigest` and decimal `taskId` — or
   * `undefined` when no task has ever been posted for the SolverNet.
   *
   * The join key is the same `manifestDigest === keccak256(manifestCid)` used by
   * `findClaimableTasks` / `getInstanceClaimCounts` (computed via
   * `manifestDigestForCid`). "Most recent" is by creation order: the HTTP
   * backing orders the `task` table by `createdAtBlock` desc, limit 1; the
   * on-chain floor takes the highest-block `TaskCreated` log for the digest.
   *
   * This is a PURE indexer/chain read — it returns only the on-chain digest, NOT
   * any IPFS body. The caller reconstructs the IPFS task CID
   * (`f01551220 + digestHexWithout0x`, see `adapters/mech/adapter.ts`) and fetches
   * the body itself. It is the read primitive behind the swe-rebench-v2 fresh-
   * volume pool recovery (#957): an operator with an empty disk reads a recent
   * task's eligibility `vettedPoolRef` to re-fetch the published vetted pool.
   *
   * This is a *recovery signal*, not a correctness gate, so it is NOT
   * abort-on-outage: like `getSolverNetOperatorCount` / `getTaskPostCounts`, the
   * `withFallback` wrapper routes it to the on-chain floor when the indexer is
   * unavailable rather than propagating `DiscoveryUnavailableError`.
   */
  getMostRecentTaskCidDigest(manifestCid: string): Promise<{
    taskCidDigest: `0x${string}`;
    taskId: string;
  } | undefined>;

  /**
   * Returns the on-chain finalization snapshot for every task posted on the
   * SolverNet identified by `manifestCid`, keyed by on-chain taskId (decimal
   * string). Backed by the indexer `task` table (`finalized`, `refunded`,
   * `claimWindowEnd`), joined via `manifestDigest === keccak256(manifestCid)`.
   *
   * This is a DISPLAY/advisory signal (the Launcher "Recent posted Tasks"
   * status chip), NOT a correctness gate, so it is *tolerant*: like
   * `getTaskPostCounts`, the `withFallback` wrapper routes it to the on-chain
   * floor on an indexer outage rather than propagating
   * `DiscoveryUnavailableError`. The on-chain floor returns an empty Map (it
   * cannot cheaply reconstruct finalized state); callers map absence /
   * floor-empty to `'unknown'` and MUST NEVER guess `'open'`.
   *
   * `claimWindowEnd` (unix seconds) may be null/undefined in the live indexer
   * today (call-trace decode pending), so callers must treat a missing/invalid
   * window as `'unknown'` rather than guessing `'open'`.
   */
  getTaskStatuses(args: { manifestCid: string }): Promise<Map<string, TaskStatusSnapshot>>;

  /**
   * Returns resolved verdict tallies for a set of tasks, keyed by decimal
   * taskId, backing the operator Activity table's task-relative Outcome column
   * (spec/2026-05-22-run-outcome.md).
   *
   * DISPLAY/advisory signal, not a correctness gate — so it is *tolerant*: like
   * `getTaskStatuses`, the `withFallback` wrapper routes it to the on-chain
   * floor on an indexer outage rather than propagating
   * `DiscoveryUnavailableError`. The on-chain floor returns an empty Map (it
   * cannot decode the IPFS-enrichment-backed verdict poles); callers map an
   * absent taskId / floor-empty to `'awaiting'` and MUST NEVER guess a wrong
   * `'fail'`.
   *
   * The HTTP implementation currently returns an empty Map without consulting
   * permissionless `verdictEnvelopeMeta` projections. The on-chain floor is
   * likewise empty; authenticated canonical verdict projections can restore
   * the richer poles later without permitting fabricated activity.
   */
  getVerdictTallies(args: { taskIds: string[] }): Promise<Map<string, VerdictTallyResult>>;

  /**
   * Returns authoritative task→attempt→verdict lifecycle evidence for the given
   * on-chain taskIds (decimal strings), plus untrusted envelope-candidate bags
   * nested under each attempt/verdict (#2044).
   *
   * Empty `taskIds` → empty Map, no I/O. Unknown taskIds are omitted.
   * Tolerant under withFallback: indexer outage falls through to the on-chain
   * floor (authoritative spine only; candidates empty). The on-chain floor
   * topic-filters by the known taskIds, scans TaskCreated newest-first
   * (early-exit), then bounds attempt/verdict/refund scans to the create-block
   * window — so production discovery floors that sit millions of blocks behind
   * head still return spines for recent known tasks. Both on-chain chunk
   * budgets and HTTP GraphQL legs are hard-capped (50 × ~1999-block chunks /
   * 50 pages × 1000 rows). If a cap would truncate a result set, the call
   * returns an empty Map (absence > partial lie) rather than a partial spine.
   *
   * Separation rule: every field under `authoritative` is sourced exclusively
   * from on-chain event projections. Every `*EnvelopeCandidates` entry is
   * sourced exclusively from attempt/verdict envelope meta (HTTP only).
   */
  getTaskLifecycleEvidence(args: {
    taskIds: string[];
  }): Promise<Map<string, TaskLifecycleEvidence>>;
}

// ── Error ────────────────────────────────────────────────────────────────────

/**
 * Thrown by a DiscoveryAPI implementation when it is temporarily unable to
 * serve a request — e.g. indexer unreachable, embedded Ponder still syncing,
 * hosted subgraph 5xx.
 *
 * The `withFallback` wrapper catches this class (plus network-shaped errors)
 * and routes to the floor implementation for the duration of the outage.
 */
/**
 * Machine-readable reason a discovery read failed. `rpc_rate_limited` is the
 * one branch callers act on distinctly: it means the configured RPC endpoint
 * returned a 429 (or otherwise rate-limited the daemon), which — on the shared
 * default RPC — is an operator-actionable condition ("add your own key"), not
 * an indexer outage. Any other transport failure is left untyped (`undefined`).
 */
export type DiscoveryUnavailableCode = 'rpc_rate_limited';

export class DiscoveryUnavailableError extends Error {
  override readonly cause?: unknown;
  /**
   * Typed reason, when one can be classified — currently only
   * `rpc_rate_limited`, surfaced end-to-end so the operator UI can render a
   * distinct "your RPC is throttled" message instead of a generic failure.
   */
  readonly code?: DiscoveryUnavailableCode;

  constructor(message: string, cause?: unknown, code?: DiscoveryUnavailableCode) {
    super(message);
    this.name = 'DiscoveryUnavailableError';
    this.cause = cause;
    this.code = code;
  }
}
