#!/usr/bin/env -S yarn tsx
/**
 * Check progress toward Milestone 2.
 *
 *   Milestone: https://github.com/Jinn-Network/mono/milestone/2
 *   Tracking issue: https://github.com/Jinn-Network/mono/issues/647
 *   Authority for the slice endpoint shape:
 *     spec/2026-05-25-demonstrate-solver-learning.md §6 (lines 134-161)
 *
 * Criterion (the numeric gate):
 *   On the SWE-rebench v2 SolverNet, restricted to harness=codex and
 *   model=gpt-5.4-mini, envelope-only (enrichmentStatus='ok', the endpoint
 *   default includeUnenriched=false): the trailing-30 verdict-success rate over
 *   the most recent 30 envelope-enriched verdicts must be ≥10 percentage points
 *   above its value over the 30 verdicts ending 99 verdicts earlier. Requires
 *   ≥130 envelope-enriched verdicts at this harness+model.
 *
 * Source: a single REST GET against the testnet indexer's /explorer/slice
 * endpoint. No chain RPC required — the indexer has already aggregated and
 * envelope-filtered the verdicts; this script reads the trailing-window
 * `rolling` series and computes the milestone gate.
 *
 * Run from the client/ workspace:
 *   yarn tsx scripts/check-milestone-2.ts
 *
 * Optional:
 *   JINN_INDEXER_URL=<url>   override default indexer
 *   --md=path/to.md          also write a markdown snapshot to disk
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INDEXER_URL = process.env.JINN_INDEXER_URL ?? 'https://jinn-indexer-production.up.railway.app';

const MANIFEST_DIGEST = 'bafkreichdzxtjav3rh5boyybgx6wolh7boqedxix4vvw44slfppwppshpi';
const HARNESS = 'codex';
const MODEL = 'gpt-5.4-mini';
const WINDOW = 30; // trailing window; endpoint default is 50, so pass it explicitly.
const FLOOR = 130; // minimum envelope-enriched verdicts required at this harness+model.
const LOOKBACK = 99; // baseline window ends 99 verdicts earlier (index N-100).
const GATE_PP = 10; // milestone gate: current must be ≥10pp above baseline.

/** Minimal local view of the /explorer/slice response — only the fields we read. */
export interface SliceResponse {
  params: {
    manifestDigest: string;
    window: number;
    filter: Record<string, string[]>;
    group: string;
    includeUnenriched: boolean;
  };
  enrichmentCoverage: number; // 0..1 fraction of raw verdicts passing the envelope filter
  kpis: {
    attempts: number;
    verdicts: number;
    verdictsPass: number;
    resolvedRate: number | null;
    jinnEarned: string;
  };
  series: Array<{
    groupValue: string | null;
    buckets: unknown[];
    // entry[i] = mean of trailing min(window, i+1) envelope-only verdicts;
    // length = envelope-filtered verdict count for this series.
    rolling: number[];
  }>;
  lastIndexedBlock?: string;
  lastIndexedAt?: string;
  behindHead?: number;
}

export interface Milestone2Result {
  /** Envelope-enriched verdict count at codex+gpt-5.4-mini (= rolling.length). */
  verdicts: number;
  /** Whether the ≥130 eligibility floor is met. */
  floorMet: boolean;
  /** Verdicts still needed to reach the floor (0 once met). */
  verdictsToFloor: number;
  /** Trailing-30 rate at the most recent verdict (R[N-1]); null if N < 1. */
  current: number | null;
  /** Trailing-30 rate 99 verdicts earlier (R[N-100]); null if N < 100. */
  baseline: number | null;
  /** (current - baseline) in percentage points; null when baseline is undefined. */
  deltaPp: number | null;
  /** Milestone gate in pp (10). */
  gatePp: number;
  /** gatePp - deltaPp; positive = still short by that many pp, ≤0 = cleared; null when undefined. */
  distanceToGatePp: number | null;
  /** floorMet && deltaPp >= 10. */
  achieved: boolean;
}

/**
 * Pure milestone-2 computation over a /explorer/slice response. No I/O.
 * The group=none series' `rolling` array is the authority for verdict count and
 * the two trailing-window rates we compare.
 */
export function computeMilestone2(slice: SliceResponse): Milestone2Result {
  const rolling = slice.series[0]?.rolling ?? [];
  const n = rolling.length;

  const floorMet = n >= FLOOR;
  const verdictsToFloor = Math.max(0, FLOOR - n);

  const current = n >= 1 ? rolling[n - 1] : null;
  const baseline = n >= LOOKBACK + 1 ? rolling[n - (LOOKBACK + 1)] : null;

  let deltaPp: number | null = null;
  let distanceToGatePp: number | null = null;
  // Computable as soon as both windows exist (N ≥ 100), even before the ≥130
  // floor — so an operator watching the run climb sees the delta trending.
  // `achieved` stays gated on `floorMet` below; this only surfaces the number.
  if (current != null && baseline != null) {
    deltaPp = (current - baseline) * 100;
    distanceToGatePp = GATE_PP - deltaPp;
  }

  const achieved = floorMet && deltaPp != null && deltaPp >= GATE_PP;

  return {
    verdicts: n,
    floorMet,
    verdictsToFloor,
    current,
    baseline,
    deltaPp,
    gatePp: GATE_PP,
    distanceToGatePp,
    achieved,
  };
}

async function fetchSlice(): Promise<SliceResponse> {
  const qs = new URLSearchParams();
  qs.set('manifestDigest', MANIFEST_DIGEST);
  // The bracket keys are literal query-param names the endpoint parses as filters.
  qs.set('filter[harness]', HARNESS);
  qs.set('filter[model]', MODEL);
  qs.set('group', 'none');
  qs.set('window', String(WINDOW));
  const url = `${INDEXER_URL}/explorer/slice?${qs.toString()}`;
  process.stderr.write(`GET ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Indexer ${INDEXER_URL} returned HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as SliceResponse;
}

function pct(x: number | null | undefined): string {
  if (x == null) return 'n/a';
  return `${(x * 100).toFixed(1)}%`;
}

function pp(x: number | null | undefined): string {
  if (x == null) return 'n/a';
  const sign = x > 0 ? '+' : '';
  return `${sign}${x.toFixed(2)}pp`;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const mdArg = process.argv.find((a) => a.startsWith('--md='));
  const mdPath = mdArg ? mdArg.slice('--md='.length) : null;

  const lines: string[] = [];
  const out = (s: string) => {
    console.log(s);
    lines.push(s);
  };

  out(`# Milestone 2 progress — ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`);
  out('');
  out(`SolverNet (manifestDigest): \`${MANIFEST_DIGEST}\` (SWE-rebench v2)`);
  out(`Filter: harness=\`${HARNESS}\`, model=\`${MODEL}\`, envelope-only (includeUnenriched=false)`);
  out(`Indexer: ${INDEXER_URL}`);
  out(
    `Criterion: trailing-${WINDOW} verdict-success rate at the latest verdict must be ≥${GATE_PP}pp above its value ${LOOKBACK} verdicts earlier; requires ≥${FLOOR} envelope-enriched verdicts.`,
  );
  out('');

  const slice = await fetchSlice();
  const r = computeMilestone2(slice);

  out('## Result');
  out('');
  out('| Metric | Value |');
  out('|---|---:|');
  out(`| Milestone 2 achieved | **${r.achieved ? 'YES' : 'NO'}** |`);
  out(`| Current trailing-${WINDOW} rate (latest verdict) | ${pct(r.current)} |`);
  out(`| Baseline trailing-${WINDOW} rate (${LOOKBACK} verdicts ago) | ${pct(r.baseline)} |`);
  out(`| Delta | ${pp(r.deltaPp)} |`);
  out(`| Distance to ${GATE_PP}pp gate | ${pp(r.distanceToGatePp)} |`);
  if (r.floorMet) {
    out(`| Envelope-enriched verdicts | ${r.verdicts} (floor ≥${FLOOR} met) |`);
  } else {
    out(`| Envelope-enriched verdicts | ${r.verdicts} — below floor — ${r.verdictsToFloor} verdicts to go |`);
  }
  out('');

  out('## Indexer freshness & coverage');
  out('');
  out(`- Enrichment coverage: ${pct(slice.enrichmentCoverage)} of raw verdicts pass the envelope filter`);
  out(`- KPI verdicts (group=none): ${slice.kpis?.verdicts ?? 'n/a'}`);
  out(`- Last indexed at: ${slice.lastIndexedAt ?? 'n/a'}`);
  out(`- Last indexed block: ${slice.lastIndexedBlock ?? 'n/a'}`);
  out(`- Behind head: ${slice.behindHead ?? 'n/a'}`);
  out('');

  out('## Verdict');
  out('');
  if (!r.floorMet) {
    out(`- **NOT HIT.** Below the ${FLOOR}-verdict eligibility floor — ${r.verdictsToFloor} envelope-enriched verdicts to go.`);
  } else if (r.achieved) {
    out(`- **MILESTONE HIT.** Delta ${pp(r.deltaPp)} clears the ${GATE_PP}pp gate at ${r.verdicts} verdicts.`);
  } else {
    out(`- **NOT HIT.** Delta ${pp(r.deltaPp)} is ${pp(r.distanceToGatePp)} short of the ${GATE_PP}pp gate.`);
  }

  process.stderr.write(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.\n`);

  if (mdPath) {
    writeFileSync(mdPath, lines.join('\n'));
    process.stderr.write(`Wrote markdown summary to ${mdPath}\n`);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
