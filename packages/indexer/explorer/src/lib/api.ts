/**
 * Typed fetch helpers + React Query hooks for the Jinn network explorer.
 *
 * All shapes mirror the exact JSON responses from `packages/indexer/src/api/explorer.ts`.
 * bigint fields serialised as decimal strings (mostRecentSettlementBlock, etc.).
 */

import { useQuery } from '@tanstack/react-query';

// ── Freshness ────────────────────────────────────────────────────────────────

export interface FreshnessMeta {
  lastIndexedBlock: string;
  lastIndexedAt: string;
  /** null if the head RPC call is not available */
  behindHead: number | null;
}

// ── Shared ───────────────────────────────────────────────────────────────────

export interface CompositionEntry {
  value: string;
  count: number;
  share: number;
}

export interface LeaderboardRow {
  operator: string;
  attempts: number;
  settledContribution: number;
  verdictsTotal: number;
  verdictsPass: number;
  /** null when verdictsTotal === 0 */
  resolvedRate: number | null;
  /** Decimal wei string; labeled as OLAS in the UI. */
  jinnEarned: string;
  /** Oldest-first 8 x 6h reward qualification flags. */
  recentBlocks?: boolean[];
  /** true when the newest completed OLAS reward bucket qualifies. */
  active: boolean;
}

export interface RankedLeaderboardRow extends LeaderboardRow {
  rank: number;
  dominantMode?: string;
  dominantHarness?: string;
}

// ── GET /explorer/network ────────────────────────────────────────────────────

export interface NetworkResponse extends FreshnessMeta {
  tasksPosted: number;
  tasksSettled: number;
  tasksRefunded: number;
  attempts: number;
  /**
   * Count of operator multisigs that have ever submitted an attempt on
   * `EXPLORER_CHAIN_ID`. Renamed from `distinctOperators` (2026-05-30) to
   * disambiguate from the headline "active operators" surface.
   */
  everAttemptedOperators: number;
  solverNetsRunning: number;
  verdicts: number;
  /** Envelope-truth-preferring pass count. */
  verdictsPass: number;
  /** Envelope-truth-preferring resolved-rate (the headline number). */
  resolvedRate: number | null;
  /** Raw on-chain verdictCode==Pass count (daemon defaults to Pass; often wrong). */
  onChainVerdictsPass: number;
  /** Raw on-chain resolved-rate (verdictCode==Pass / total). */
  onChainResolvedRate: number | null;
  /** Agreement between on-chain code and off-chain envelope (ebu7.13). */
  verdictConsistency: {
    matched: number;
    disagreed: number;
    total: number;
    agreementShare: number | null;
  };
  /** Coverage of evaluation-envelope enrichment over the verdict set. */
  enrichmentCoverageVerdicts: {
    enriched: number;
    total: number;
    share: number;
  };
  mostRecentSettlementBlock: string | null;
  composition: {
    byMode: CompositionEntry[];
    byHarness: CompositionEntry[];
    byModel: CompositionEntry[];
    byPlugin: CompositionEntry[];
  };
  enrichmentCoverage: {
    enrichedAttempts: number;
    totalAttempts: number;
    share: number;
  };
}

// ── GET /explorer/solvernets ─────────────────────────────────────────────────

export interface SolverNetRow {
  cid: string;
  /** Human-readable name (e.g. 'SWE-rebench v2') from the IPFS manifest body.
   * Empty string until the manifest enrichment pass populates it. */
  name: string;
  description: string;
  solverNetId: string;
  /** 'pending' | 'ok' | 'failed' — the IPFS-manifest enrichment status. */
  manifestEnrichmentStatus: string;
  status: string;
  launcherAgentId: string | null;
  statusUpdatedAt: string | null;
  tasksPosted: number;
  tasksSettled: number;
  attempts: number;
  verdicts: number;
  verdictsPass: number;
  resolvedRate: number | null;
  /**
   * Short trailing resolved-rate series for sparkline rendering (ebu7.7).
   * Values are in [0, 1]; oldest bucket first. Empty array when no verdicts.
   * Up to SPARKLINE_TRAILING_BUCKETS (12) buckets of ~7 days each.
   */
  recentResolvedRateSeries: number[];
}

export interface SolverNetsResponse extends FreshnessMeta {
  solvernets: SolverNetRow[];
}

// ── GET /explorer/solvernet/:cid ─────────────────────────────────────────────

export interface LearningCurveBucket {
  bucketStartBlock: string;
  total: number;
  pass: number;
  rate: number | null;
}

export interface CheckpointTimelineEntry {
  cid: string;
  agentId: string;
  publishedAtBlock: string;
  /** Display name from the checkpoint manifest (harnessPackage.implName). Empty before IPFS enrichment. */
  name: string;
  /** Version string from the checkpoint manifest. Empty before enrichment. */
  version: string;
  /** sha256:<hex> code digest. Empty before enrichment. */
  codeDigest: string;
  /** CID of the parent checkpoint, or null for root checkpoints. */
  parentCheckpointCid: string | null;
  /** harnessPackage.implName. Empty before enrichment. */
  implName: string;
  /** harnessPackage.implVersion. Empty before enrichment. */
  implVersion: string;
  /** harnessPackage.sourceBundleCid. Empty before enrichment or if not published. */
  sourceBundleCid: string;
  /** 'pending' | 'ok' | 'failed' */
  enrichmentStatus: string;
  /**
   * Pass rate of mode='frozen' attempts in this SolverNet whose codeDigest matches,
   * scoped to the named held-out slate (see SolverNetResponse.heldOutSlateVersion).
   * null when enrichment is not 'ok', codeDigest is empty, or no slate-scoped frozen attempts.
   */
  frozenResolvedRate: number | null;
  /**
   * Held-out resolved-rate delta vs the parent checkpoint (self − parent,
   * slate-scoped both sides). null when there is no parent or either rate is
   * unmeasured. #820 AC#2.
   */
  heldOutDelta: number | null;
  /** True when sourceBundleCid is non-empty (checkpoint published its source bundle). */
  verifiedFrozen: boolean;
}

export interface FreezeViolation {
  operator: string;
  modalCodeDigest: string;
  total: number;
  violatingCount: number;
}

export interface SolverNetResponse extends FreshnessMeta {
  cid: string;
  /** IPFS-enriched manifest fields (empty strings until enrichment lands). */
  name: string;
  description: string;
  solverNetId: string;
  manifestEnrichmentStatus: string;
  status: string;
  launcherAgentId: string | null;
  tasksPosted: number;
  tasksSettled: number;
  attempts: number;
  verdicts: number;
  verdictsPass: number;
  resolvedRate: number | null;
  learningCurveBuckets: LearningCurveBucket[];
  learningCurveRolling: number[];
  trainBoard: {
    ranked: (RankedLeaderboardRow & { dominantMode?: string; dominantHarness?: string })[];
    lowVolume: (LeaderboardRow & { dominantMode?: string; dominantHarness?: string })[];
  };
  frozenBoard: {
    ranked: (RankedLeaderboardRow & { dominantMode?: string; dominantHarness?: string })[];
    lowVolume: (LeaderboardRow & { dominantMode?: string; dominantHarness?: string })[];
  };
  checkpointTimeline: {
    checkpoints: CheckpointTimelineEntry[];
    note: string;
  };
  /** Named held-out slate version that frozenResolvedRate is scored against. #820 AC#1. */
  heldOutSlateVersion: string;
  freezeIntegrity: {
    violations: FreezeViolation[];
    verifiedFrozenShare: number;
    frozenAttempts: number;
  };
}

// ── GET /explorer/operators ──────────────────────────────────────────────────

export interface ActiveWindow {
  startTs: number;
  endTs: number;
  blockSeconds: number;
  blockCount: number;
  requiredOlasPerBlock: string;
}

export interface OperatorsResponse extends FreshnessMeta {
  ranked: RankedLeaderboardRow[];
  lowVolume: (LeaderboardRow & { dominantMode?: string; dominantHarness?: string })[];
  minVerdicts: number;
  /**
   * Distinct operators that cleared the newest completed 6h OLAS reward bucket.
   */
  activeOperators: number;
  /** Distinct operators that cleared all 8 completed 6h OLAS reward buckets. */
  sustainedOperators: number;
  /** Distinct operators with at least 25 OLAS lifetime. */
  operatorsAtMilestone3: number;
  activeWindow: ActiveWindow;
  meta?: {
    jinnAttribution?: 'pending' | 'ok';
  };
  appliedFilters?: {
    mode?: string;
    harness?: string;
  };
}

// ── GET /explorer/operator/:addr ─────────────────────────────────────────────

export interface OperatorPerSolverNet {
  cid: string;
  status: string;
  attempts: number;
  settledContribution: number;
  verdictsTotal: number;
  verdictsPass: number;
  resolvedRate: number | null;
  modeBreakdown: CompositionEntry[];
}

export interface OperatorResponse extends FreshnessMeta {
  operator: string;
  dominantMode: string;
  dominantHarness: string;
  dominantSolverType: string;
  perSolverNet: OperatorPerSolverNet[];
  totals: {
    attempts: number;
    settledContribution: number;
    verdictsTotal: number;
    verdictsPass: number;
    resolvedRate: number | null;
  };
}

// ── Fetch helper ─────────────────────────────────────────────────────────────

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${path}`);
  }
  return res.json() as Promise<T>;
}

// ── Query-string builder ─────────────────────────────────────────────────────

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export interface NetworkParams {
  /**
   * When true, append `?include=raw` so the backend skips the envelope-only
   * filter (spec §4). The SPA defaults to strict (envelope-only); this
   * param exists for future ad-hoc URL state.
   */
  includeUnenriched?: boolean;
}

export function useNetwork(params?: NetworkParams) {
  return useQuery({
    queryKey: ['network', params],
    queryFn: () =>
      fetchJson<NetworkResponse>(
        `/explorer/network${qs({
          include: params?.includeUnenriched ? 'raw' : undefined,
        })}`,
      ),
  });
}

export function useSolverNets() {
  return useQuery({
    queryKey: ['solvernets'],
    queryFn: () => fetchJson<SolverNetsResponse>('/explorer/solvernets'),
  });
}

export interface SolverNetParams {
  bucket?: number;
  k?: number;
  minVerdicts?: number;
  /** Append `?include=raw` to opt out of the spec-§4 envelope-only filter. */
  includeUnenriched?: boolean;
}

export function useSolverNet(cid: string, params?: SolverNetParams) {
  return useQuery({
    queryKey: ['solvernet', cid, params],
    queryFn: () =>
      fetchJson<SolverNetResponse>(
        `/explorer/solvernet/${encodeURIComponent(cid)}${qs({
          bucket: params?.bucket,
          k: params?.k,
          minVerdicts: params?.minVerdicts,
          include: params?.includeUnenriched ? 'raw' : undefined,
        })}`,
      ),
    enabled: Boolean(cid),
  });
}

export interface OperatorsParams {
  minVerdicts?: number;
  mode?: string;
  harness?: string;
  /** Append `?include=raw` to opt out of the spec-§4 envelope-only filter. */
  includeUnenriched?: boolean;
}

export function useOperators(params?: OperatorsParams) {
  return useQuery({
    queryKey: ['operators', params],
    queryFn: () =>
      fetchJson<OperatorsResponse>(
        `/explorer/operators${qs({
          minVerdicts: params?.minVerdicts,
          mode: params?.mode,
          harness: params?.harness,
          include: params?.includeUnenriched ? 'raw' : undefined,
        })}`,
      ),
  });
}

export function useOperator(addr: string) {
  return useQuery({
    queryKey: ['operator', addr],
    queryFn: () =>
      fetchJson<OperatorResponse>(
        `/explorer/operator/${encodeURIComponent(addr)}`,
      ),
    enabled: Boolean(addr),
  });
}

// ── /explorer/slice (#611) ───────────────────────────────────────────────────

export { useSlice } from './useSlice';
export type {
  SliceParams,
  SliceResponse,
  SliceSeries,
  SliceSeriesKPIs,
  SliceGroupBy,
  SliceFilter,
  SliceBucketSize,
  SliceResponseLeaderboardRow,
} from './slice-types';
