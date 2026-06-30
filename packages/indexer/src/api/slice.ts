/**
 * /explorer/slice — parameterized engine for the network explorer per
 * spec/2026-05-25-demonstrate-solver-learning.md §3.1 and §6.
 *
 * The engine operates within ONE SolverNet at a time (manifestDigest is
 * required). It returns a curve + leaderboard + KPIs for the slice defined
 * by the (group, filter, includeUnenriched, bucket) parameters.
 *
 * Cross-SolverNet comparison (multi-manifestDigest) is YAGNI per spec §9.
 *
 * This file is pure — no DB access. The route handler in explorer.ts fetches
 * the joined rows once and passes them to `computeSlice`.
 */

import { bucketResolvedRate, rollingResolvedRate, type BucketEntry } from './metrics.js';

export type SliceGroupBy =
  | 'none'
  | 'operator'
  | 'harness'
  | 'plugin'
  | 'mode'
  | 'model';

export type SliceBucketSize = 'auto' | 'per-block' | 'per-day' | 'per-week';

export interface SliceFilter {
  operator?: string[];
  harness?: string[];
  plugin?: string[];
  mode?: string[];
  model?: string[];
}

export interface SliceParams {
  /** Required — the SolverNet to slice within (manifest IPFS CID). */
  manifestDigest: string;
  /** Dimension to split into series. `none` returns a single aggregate series. */
  group: SliceGroupBy;
  /** Allow-list filters per dimension. Multiple filters AND together. */
  filter: SliceFilter;
  /**
   * When false (default), drops verdicts where enrichmentStatus !== 'ok'.
   * When true, keeps them (verdictCode-fallback semantics) — for inspection.
   */
  includeUnenriched: boolean;
  /** Curve bucketing. */
  bucket: SliceBucketSize;
  /**
   * Trailing-window size for the rolling resolved-rate series. Clamped to
   * [1, 1000]. Undefined → engine uses DEFAULT_ROLLING_K (50). Spec §6.
   */
  window?: number;
}

export interface SliceSeriesKPIs {
  attempts: number;
  verdicts: number;
  verdictsPass: number;
  resolvedRate: number | null;
}

export interface SliceSeries {
  /** The dimension value for this series, or null when group=none. */
  groupValue: string | null;
  /** Time-bucketed pass rate. */
  buckets: BucketEntry[];
  /** Rolling pass-rate window. */
  rolling: number[];
  /** Per-series totals. */
  kpis: SliceSeriesKPIs;
}

export interface SliceResponseLeaderboardRow {
  operator: string;
  attempts: number;
  verdictsTotal: number;
  verdictsPass: number;
  resolvedRate: number | null;
  dominantMode?: string;
  dominantHarness?: string;
}

export interface SliceResponse {
  /** Echo of the resolved params (after defaults applied). */
  params: SliceParams;
  /** Fraction of raw verdicts that pass the envelope filter — trust metric. */
  enrichmentCoverage: number;
  /** Sum of per-series totals; consistent with the aggregated /solvernet/:cid kpis when params={group:none}. */
  kpis: SliceSeriesKPIs;
  /** One series when group=none; up to N when grouped. */
  series: SliceSeries[];
  /** Train + frozen leaderboards, filtered to the slice. */
  leaderboard: {
    train: SliceResponseLeaderboardRow[];
    frozen: SliceResponseLeaderboardRow[];
  };
}

const ALLOWED_GROUPS: SliceGroupBy[] = [
  'none', 'operator', 'harness', 'plugin', 'mode', 'model',
];
const ALLOWED_BUCKETS: SliceBucketSize[] = [
  'auto', 'per-block', 'per-day', 'per-week',
];
const FILTER_DIMS = ['operator', 'harness', 'plugin', 'mode', 'model'] as const;

function parseEnum<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * Parses URL search params into a validated SliceParams.
 *
 * @throws Error if manifestDigest is missing — the engine is scoped to one
 *         SolverNet (spec §3.1).
 */
export function parseSliceParams(qs: URLSearchParams): SliceParams {
  const manifestDigest = qs.get('manifestDigest');
  if (!manifestDigest) {
    throw new Error('parseSliceParams: manifestDigest is required');
  }

  const group = parseEnum(qs.get('group'), ALLOWED_GROUPS, 'none');
  const bucket = parseEnum(qs.get('bucket'), ALLOWED_BUCKETS, 'auto');

  const filter: SliceFilter = {};
  for (const dim of FILTER_DIMS) {
    const raw = qs.get(`filter[${dim}]`);
    if (raw) filter[dim] = raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const includeUnenriched = qs.get('include') === 'raw';

  let window: number | undefined;
  const rawWindow = qs.get('window');
  if (rawWindow !== null) {
    const n = Number.parseInt(rawWindow, 10);
    if (Number.isFinite(n)) {
      window = Math.min(1000, Math.max(1, n));
    }
  }

  return { manifestDigest, group, filter, includeUnenriched, bucket, window };
}

/**
 * The row shape `computeSlice` expects after the route handler has done its
 * Drizzle join. One row per verdict, enriched with the verdict envelope's
 * actualPassed + the attempt envelope's mode/harness/model/plugins.
 *
 * The route handler is responsible for applying enrichmentFilter (the
 * envelope-only default from Phase 1) before passing rows to computeSlice.
 */
export interface SliceInputRow {
  requestId: string;
  operator: string;
  createdAtBlock: bigint;
  verdictCode: number;
  actualPassed: boolean | null;
  enrichmentStatus: string | null;
  mode: string | null;
  harness: string | null;
  model: string | null;
  plugins: string[];
}

const DEFAULT_BUCKET_BLOCKS = 7200n; // ≈1 day on Base at ~12s/block
const DEFAULT_ROLLING_K = 50;

function bucketBlocksFor(bucket: SliceBucketSize): bigint {
  switch (bucket) {
    case 'per-block': return 1n;
    case 'per-day': return 7200n;
    case 'per-week': return 50400n;
    case 'auto':
    default: return DEFAULT_BUCKET_BLOCKS;
  }
}

function passFromRow(r: SliceInputRow): boolean | null {
  if (r.enrichmentStatus === 'ok' && r.actualPassed !== null) return r.actualPassed;
  return null;
}

function computeSeriesKPIs(rows: SliceInputRow[]): SliceSeriesKPIs {
  const distinctRequests = new Set(rows.map((r) => r.requestId)).size;
  const judgements = rows.map(passFromRow).filter((p): p is boolean => p !== null);
  const verdicts = judgements.length;
  const verdictsPass = judgements.filter(Boolean).length;
  return {
    attempts: distinctRequests,
    verdicts,
    verdictsPass,
    resolvedRate: verdicts === 0 ? null : verdictsPass / verdicts,
  };
}

function computeOneSeries(
  rows: SliceInputRow[],
  groupValue: string | null,
  bucket: SliceBucketSize,
  window: number,
): SliceSeries {
  const samples = rows
    .map((r) => ({ block: r.createdAtBlock, pass: passFromRow(r) }))
    .filter((s): s is { block: bigint; pass: boolean } => s.pass !== null);
  return {
    groupValue,
    buckets: bucketResolvedRate(samples, bucketBlocksFor(bucket)),
    rolling: rollingResolvedRate(samples.map((s) => s.pass), window),
    kpis: computeSeriesKPIs(rows),
  };
}

type SingleKeyGroup = Exclude<SliceGroupBy, 'none' | 'plugin'>;

function groupKeyFor(row: SliceInputRow, group: SingleKeyGroup): string {
  switch (group) {
    case 'operator': return row.operator;
    case 'mode': return row.mode || '(unknown)';
    case 'harness': return row.harness || '(unknown)';
    case 'model': return row.model || '(unknown)';
  }
}

function computeGroupedSeries(
  rows: SliceInputRow[],
  group: SingleKeyGroup,
  bucket: SliceBucketSize,
  window: number,
): SliceSeries[] {
  const groups = new Map<string, SliceInputRow[]>();
  for (const r of rows) {
    const key = groupKeyFor(r, group);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, groupRows]) => computeOneSeries(groupRows, key, bucket, window));
}

/**
 * Sums KPIs across series for the top-level SliceResponse.kpis.
 *
 * NOTE: For group=plugin, a single attempt can carry multiple plugins and
 * therefore appears in multiple series. Top-level `attempts` will be overcounted
 * relative to true unique-attempt count. For group=operator/harness/mode/model,
 * attempts are mutually exclusive and the sum is exact.
 * (LIM-2 — documented, not a bug; matches composition.byPlugin semantics.)
 */
function sumSeriesKPIs(series: SliceSeries[]): SliceSeriesKPIs {
  let attempts = 0, verdicts = 0, verdictsPass = 0;
  for (const s of series) {
    verdicts += s.kpis.verdicts;
    verdictsPass += s.kpis.verdictsPass;
    attempts += s.kpis.attempts;
  }
  return {
    attempts,
    verdicts,
    verdictsPass,
    resolvedRate: verdicts === 0 ? null : verdictsPass / verdicts,
  };
}

function applyFilters(rows: SliceInputRow[], filter: SliceFilter): SliceInputRow[] {
  return rows.filter((r) => {
    if (filter.operator && filter.operator.length > 0 && !filter.operator.includes(r.operator)) {
      return false;
    }
    if (filter.mode && filter.mode.length > 0 && !filter.mode.includes(r.mode ?? '(unknown)')) {
      return false;
    }
    if (filter.harness && filter.harness.length > 0 && !filter.harness.includes(r.harness ?? '(unknown)')) {
      return false;
    }
    if (filter.model && filter.model.length > 0 && !filter.model.includes(r.model ?? '(unknown)')) {
      return false;
    }
    if (filter.plugin && filter.plugin.length > 0) {
      const matches = r.plugins?.some((p) => filter.plugin!.includes(p));
      if (!matches) return false;
    }
    return true;
  });
}

function computePluginSeries(
  rows: SliceInputRow[],
  bucket: SliceBucketSize,
  window: number,
): SliceSeries[] {
  const groups = new Map<string, SliceInputRow[]>();
  for (const r of rows) {
    if (!r.plugins || r.plugins.length === 0) continue;
    for (const p of r.plugins) {
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p)!.push(r);
    }
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, groupRows]) => computeOneSeries(groupRows, key, bucket, window));
}

export interface ComputeSliceContext {
  /** Total verdict count BEFORE enrichmentFilter — for the enrichmentCoverage metric. */
  rawVerdictCount: number;
}

export function computeSlice(
  rows: SliceInputRow[],   // already post-enrichmentFilter (from route handler)
  params: SliceParams,
  ctx: ComputeSliceContext,
): SliceResponse {
  // LIM-1: compute coverage BEFORE applyFilters so it reflects only the
  // envelope filter, not user-supplied dimension filters.
  const enrichmentCoverage =
    ctx.rawVerdictCount === 0 ? 0 : rows.length / ctx.rawVerdictCount;

  const filtered = applyFilters(rows, params.filter);
  const window = params.window ?? DEFAULT_ROLLING_K;

  let series: SliceSeries[];
  if (params.group === 'none') {
    series = [computeOneSeries(filtered, null, params.bucket, window)];
  } else if (params.group === 'plugin') {
    series = computePluginSeries(filtered, params.bucket, window);
  } else {
    series = computeGroupedSeries(filtered, params.group, params.bucket, window);
  }

  return {
    params,
    enrichmentCoverage,
    kpis: params.group === 'none' ? series[0].kpis : sumSeriesKPIs(series),
    series,
    leaderboard: { train: [], frozen: [] },
  };
}
