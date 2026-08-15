/**
 * SWE-rebench v2 aggregation function. Returns a structured network-level
 * result over a rolling window of resolved Verdicts.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §3.5
 * DR: log/decisions/2026-05-06-aggregation-multi-winrate.md
 */

export interface AggregateInput {
  score: 0 | 1;
  language: string;
  complexity: number;  // R2 complexity proxy (loc * files for example)
}

export interface NetworkResult {
  schemaVersion: 'swe-rebench-v2.network.v1';
  windowStart: string;
  windowEnd: string;
  verdictCount: number;

  meanResolved: number;
  complexityWeighted: number;
  byLanguage: Record<string, { resolved: number; n: number }>;
  frontierResolved: number;
  parityTripRate: number;
}

export function computeNetworkResult(args: {
  verdicts: AggregateInput[];
  windowStart: string;
  windowEnd: string;
}): NetworkResult {
  const v = args.verdicts;
  const n = v.length;
  if (n === 0) {
    return {
      schemaVersion: 'swe-rebench-v2.network.v1',
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      verdictCount: 0,
      meanResolved: 0, complexityWeighted: 0,
      byLanguage: {}, frontierResolved: 0, parityTripRate: 0,
    };
  }

  const meanResolved = v.reduce((s, x) => s + x.score, 0) / n;

  const complexitySum = v.reduce((s, x) => s + x.complexity, 0);
  const complexityWeighted = complexitySum > 0
    ? v.reduce((s, x) => s + x.score * x.complexity, 0) / complexitySum
    : 0;

  const byLanguage: Record<string, { resolved: number; n: number }> = {};
  for (const x of v) {
    if (!byLanguage[x.language]) byLanguage[x.language] = { resolved: 0, n: 0 };
    byLanguage[x.language].resolved += x.score;
    byLanguage[x.language].n += 1;
  }
  for (const lang of Object.keys(byLanguage)) {
    byLanguage[lang].resolved /= byLanguage[lang].n;
  }

  // Frontier: assume v already includes only top-K Solutions per task; for
  // simplicity at v1 frontier = max of each (instance_id, score)
  const frontierResolved = v.reduce((m, x) => Math.max(m, x.score), 0);

  // Parity trip rate: % verdicts with score = 1
  const parityTripRate = v.filter((x) => x.score === 1).length / n;

  return {
    schemaVersion: 'swe-rebench-v2.network.v1',
    windowStart: args.windowStart, windowEnd: args.windowEnd,
    verdictCount: n,
    meanResolved, complexityWeighted, byLanguage,
    frontierResolved, parityTripRate,
  };
}
