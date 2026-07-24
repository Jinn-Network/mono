/**
 * Paired (matched-design) comparison for the held-out exam.
 *
 * The exam scores the SAME slate against the before- and after-checkpoints, so
 * the two result sets are MATCHED, not independent. The marginal test in
 * `wilson.ts` (`compareRates`) compares two INDEPENDENT Wilson intervals and
 * calls a delta trustworthy only when they are disjoint. On a matched design
 * that is statistically wasteful: it carries the full between-instance
 * difficulty variance ("this bug is just hard") in BOTH intervals, which swamps
 * a real, consistent within-instance improvement. Example: a learner that flips
 * 3 hard instances fail→pass and regresses none moves 4/10→7/10 — two Wilson
 * intervals ([17,69]% vs [40,89]%) overlap → "within-noise", even though every
 * observed change was an improvement.
 *
 * McNemar's test is the textbook test for matched binary data: it looks ONLY at
 * the discordant pairs (instances that flipped) and asks whether the flips are
 * asymmetric beyond chance. This is NOT a weaker bar — it is the CORRECT test
 * for the design, and it still gates the claim on significance (exact two-sided
 * p < alpha) AND on the improvement direction (more fail→pass than pass→fail).
 * It is reported ALONGSIDE the conservative marginal verdict, never replacing it
 * — so the exam is strengthened, never weakened (DR-2026-06-02-b §2a).
 *
 * R=1 (one run per instance) ships here: McNemar exact on per-instance flips.
 * R>1 (per-instance pass RATES → Wilcoxon signed-rank / paired bootstrap) layers
 * on once `eval_results` supports appended runs (DR-2026-06-02-b §2b).
 */

/** Minimal per-instance result (subset of PerTaskResult / EvalResultRow). */
export interface PairedInput {
  instance_id: string;
  /** null when unscorable. */
  passed: boolean | null;
  unscorable: boolean;
}

export type PairedVerdict = 'trustworthy' | 'within-noise';

export interface PairedComparison {
  /** Instances scorable (passed !== null) in BOTH arms — the matched pairs. */
  pairs: number;
  /** b: before fail → after pass (improvements). */
  improved: number;
  /** c: before pass → after fail (regressions). */
  regressed: number;
  concordantPass: number;
  concordantFail: number;
  /** Instances unscorable/absent in either arm — excluded from the paired test. */
  excluded: number;
  /** Exact two-sided McNemar p-value over the discordant pairs. */
  pValue: number;
  /** 'trustworthy' iff pValue < alpha AND improved > regressed; else 'within-noise'. */
  verdict: PairedVerdict;
}

/**
 * Exact two-sided McNemar p-value for discordant counts `b` (improvements) and
 * `c` (regressions). Under H0 each discordant pair is an independent fair coin,
 * so the count of one direction is Binomial(n=b+c, 0.5); the two-sided p is
 * `2 * P(X <= min(b,c))`, capped at 1. No `b==c==0` division (returns 1: no
 * evidence). Computed iteratively (term ratio) so it is exact and overflow-free
 * for any slate size.
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  // sum_{i=0}^{k} C(n,i) * 0.5^n, via prob_0 = 0.5^n, prob_i = prob_{i-1}*(n-i+1)/i.
  let term = Math.pow(0.5, n); // i = 0
  let cdf = term;
  for (let i = 1; i <= k; i++) {
    term = (term * (n - i + 1)) / i;
    cdf += term;
  }
  return Math.min(1, 2 * cdf);
}

/**
 * Paired McNemar comparison of two matched per-instance result sets. An instance
 * contributes a pair ONLY when it is scorable (passed !== null, not unscorable)
 * in BOTH arms — an unscorable/missing side is excluded (honest: a disk-skip or
 * harness failure is never coerced into a flip). `alpha` defaults to 0.05.
 */
export function comparePaired(
  before: readonly PairedInput[],
  after: readonly PairedInput[],
  opts: { alpha?: number } = {},
): PairedComparison {
  const alpha = opts.alpha ?? 0.05;
  const scorable = (r: PairedInput): boolean => !r.unscorable && r.passed !== null;
  const beforeById = new Map(before.map((r) => [r.instance_id, r]));

  let improved = 0;
  let regressed = 0;
  let concordantPass = 0;
  let concordantFail = 0;
  let pairs = 0;
  let excluded = 0;

  const seen = new Set<string>();
  for (const a of after) {
    seen.add(a.instance_id);
    const b = beforeById.get(a.instance_id);
    if (!b || !scorable(b) || !scorable(a)) {
      excluded++;
      continue;
    }
    pairs++;
    const wasPass = b.passed === true;
    const nowPass = a.passed === true;
    if (!wasPass && nowPass) improved++;
    else if (wasPass && !nowPass) regressed++;
    else if (wasPass && nowPass) concordantPass++;
    else concordantFail++;
  }
  // before-only instances (absent from after) are excluded too.
  for (const b of before) if (!seen.has(b.instance_id)) excluded++;

  const pValue = mcnemarExact(improved, regressed);
  const verdict: PairedVerdict =
    pValue < alpha && improved > regressed ? 'trustworthy' : 'within-noise';

  return { pairs, improved, regressed, concordantPass, concordantFail, excluded, pValue, verdict };
}
