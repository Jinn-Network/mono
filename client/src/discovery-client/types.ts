/**
 * Neutral home for the HTTP-indexer read slice that outlives `discovery/`.
 *
 * One-swap R3b (issue #2494, DR-2026-08-05 addendum 2026-08-10 Decision 2).
 * R3a carved the plugin-publication read path onto `plugin-registry/`; this is
 * the sibling carve for the three HTTP-indexer consumers the ruling kept:
 * `cli/commands/evidence.ts`, `mcp/server.ts`, and `tasks/submit-preflight.ts`
 * (plus `cli/commands/tasks.ts`'s `watch` verb, which drives the same
 * `getAutopilotDeliveryCandidates` read).
 *
 * The module is deliberately NARROW: it owns only the four methods those
 * consumers actually drive, not the retired ~20-method `DiscoveryAPI`.
 * Wave-4 D4 deleted `client/src/discovery/`; catalog-row types for
 * `listLaunchedSolverNets` live here.
 *
 */

import type { CorpusQuery, EnvelopeRef } from '../corpus/types.js';

/**
 * Current lifecycle status of a SolverNet manifest. Owned here because
 * `DiscoveryClient.listLaunchedSolverNets` returns catalog rows; Wave-4 D4
 * deleted `solvernets/registry-client.ts`.
 */
export interface SolverNetLifecycleStatus {
  status: 'launched' | 'paused' | 'retired';
  statusUpdatedAt: string;
  sourceBlock: number;
  manifestHash: `0x${string}`;
}

/**
 * Catalog-row projection of a launched SolverNet — the return shape of
 * `DiscoveryClient.listLaunchedSolverNets`. Not a fifth method.
 */
export interface SolverNetManifestSummary {
  manifestCid: string;
  solverNetId: string;
  name: string;
  network: string;
  launcherAgentId: string;
  launcherSafeAddress: `0x${string}`;
  status: 'launched' | 'paused' | 'retired';
  statusUpdatedAt: string;
  contractId: string;
  contractVersion: string;
  solutionPriceWei: string;
  verdictPriceWei: string;
  openRoles: Array<'solver' | 'evaluator'>;
  anchorBlock: number;
  /**
   * Indexed chain id from the on-chain MetadataSet event (84532 = base-sepolia,
   * 8453 = base). Used by listLaunched for chain scoping without an IPFS fetch.
   */
  chainId: number;
}

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

/**
 * Per-codeDigest network-truth reward aggregate (issue #764). One row per
 * distinct executor.codeDigest, joining attemptEnvelopeMeta (codeDigest, mode)
 * to verdictEnvelopeMeta (actualPassed, actualScore) on (requestId, chainId).
 * `actualPassed` is the source of truth (NOT the on-chain verdictCode, which
 * defaults to Pass — see verdictEnvelopeMeta JSDoc).
 */
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

/**
 * The surviving HTTP-indexer read slice.
 *
 * Every method may throw `DiscoveryUnavailableError` when the indexer is
 * unreachable, unready, or serving an error — callers surface that as an
 * outage rather than as an empty result.
 */
export interface DiscoveryClient {
  /**
   * Resolve the exact indexed task/attempt/envelope rows for an Autopilot
   * marketplace delivery. Implementations must not substitute recent/global
   * scans: a missing exact row is pending and multiple/inconsistent rows are a
   * contradiction.
   */
  getAutopilotDeliveryCandidates(args: {
    chainId: number;
    taskId: string;
    role: AutopilotDeliveryRole;
  }): Promise<AutopilotDeliveryCandidateLookup>;

  /** Launched (or otherwise status-filtered) SolverNet manifest summaries. */
  listLaunchedSolverNets(args?: {
    launcherAgentId?: string;
    status?: Array<'launched' | 'paused' | 'retired'>;
  }): Promise<SolverNetManifestSummary[]>;

  /** Corpus envelope refs for one corpus query. */
  queryEnvelopes(query: CorpusQuery): Promise<EnvelopeRef[]>;

  /** Per-codeDigest network-truth reward aggregates (issue #764). */
  getCodeDigestRewards(args: {
    codeDigests: string[];
    operator?: `0x${string}`;
    solverNetManifestCid?: string;
    window?: number;
  }): Promise<CodeDigestRewardRow[]>;
}
