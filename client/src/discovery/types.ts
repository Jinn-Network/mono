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
export interface DiscoveryAPI {
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
   * Today this surface requires the `attemptEnvelopeMeta` indexer enrichment
   * shipped under `jinn-mono-ebu7`. When that enrichment is not present in the
   * deployed indexer, this method returns an empty array.
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
   * Returns network-truth pass counts per swe-rebench-v2 instance_id for a
   * given SolverNet manifest. Keyed by `instance_id`; the value is the count
   * of distinct (requestId, chainId) verdictEnvelopeMeta rows where
   * `manifestCid` matches one of the SolverNet's evaluation envelope CIDs,
   * `actualPassed = true`, and `instanceId` is non-empty.
   *
   * Note on the manifestCid filter shape: in `verdictEnvelopeMeta` the
   * `manifestCid` column stores the *evaluation envelope* CID (i.e. the IPFS
   * cid of the verdict envelope itself), not the SolverNet manifest CID. The
   * launcher passes its SolverNet manifest CID; the HTTP implementation
   * filters by `solverType` + `instanceId` non-empty and lets the operator's
   * own scoping (the SolverNet is its only swe-rebench-v2 net) carry. For
   * single-SolverNet daemons this is exact; multi-SolverNet operators get a
   * slight over-count which is acceptable — the launcher reads `max(local,
   * network)` so an over-count only triggers earlier saturation, which is the
   * safe direction. (TODO: refine to per-manifest scoping once the indexer
   * joins verdictEnvelopeMeta → attempt → task → solverNetManifest by hash.)
   *
   * Backed by `verdictEnvelopeMeta` in the indexer. Throws
   * `DiscoveryUnavailableError` when the backing is unreachable — callers
   * MUST NOT silently fall through to local-only counts (#669 acceptance
   * criterion: behave as if the on-chain count is the truth).
   *
   * The on-chain floor implementation (`OnchainDiscoveryAPI`) returns an
   * empty Map, since the underlying data comes from IPFS enrichment that the
   * floor cannot reconstruct. This is the documented behaviour for the
   * fallback: callers see the local counter as the floor.
   */
  getInstanceSuccessCounts(args: {
    manifestCid: string;
  }): Promise<Map<string, number>>;
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
