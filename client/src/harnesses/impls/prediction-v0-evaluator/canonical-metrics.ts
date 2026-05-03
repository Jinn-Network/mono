/**
 * Canonical metrics for prediction.v1 evaluator.
 *
 * §6 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 */
import type { PredictionV1Task } from '../../../types/prediction.js';

/** Compare two non-negative decimal strings. Returns negative/zero/positive. */
export function decCmp(a: string, b: string): number {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const aiN = (ai || '0').replace(/^0+/, '') || '0';
  const biN = (bi || '0').replace(/^0+/, '') || '0';
  if (aiN.length !== biN.length) return aiN.length - biN.length;
  if (aiN !== biN) return aiN < biN ? -1 : 1;
  const maxLen = Math.max(af.length, bf.length);
  const afP = af.padEnd(maxLen, '0');
  const bfP = bf.padEnd(maxLen, '0');
  if (afP === bfP) return 0;
  return afP < bfP ? -1 : 1;
}

export type GroundTruth = 'YES' | 'NO';

export function resolveGroundTruth(
  question: PredictionV1Task['spec']['question'],
  price: string,
): GroundTruth {
  if (question.kind === 'threshold') {
    const c = decCmp(price, question.threshold);
    switch (question.operator) {
      case 'GT':  return c > 0 ? 'YES' : 'NO';
      case 'GTE': return c >= 0 ? 'YES' : 'NO';
      case 'LT':  return c < 0 ? 'YES' : 'NO';
      case 'LTE': return c <= 0 ? 'YES' : 'NO';
    }
  }
  const lo = decCmp(price, question.lowerBound);
  const hi = decCmp(price, question.upperBound);
  return (lo >= 0 && hi < 0) ? 'YES' : 'NO';
}

/**
 * Brier score scaled to 1e18 fixed-point.
 *
 * score = 1 - (probability - outcome)^2 ∈ [0,1]
 *   * probability: decimal string ∈ [0,1]
 *   * outcome: 0 | 1
 *
 * Returns: string representation of BigInt (score × 1e18), rounded to nearest.
 */
export function brierScore(probability: string, outcome: 0 | 1): string {
  const p = Number(probability);
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`brierScore: probability must be in [0,1], got ${probability}`);
  }
  // Use integer arithmetic to avoid floating-point precision loss.
  // Represent probability as a rational n/d where d = 10^decimalPlaces.
  const dotIdx = probability.indexOf('.');
  const decimals = dotIdx === -1 ? 0 : probability.length - dotIdx - 1;
  const d = BigInt(10 ** decimals);
  const n = BigInt(probability.replace('.', '')); // numerator: p = n/d
  // outcome as BigInt
  const o = BigInt(outcome); // 0 or 1
  // score = 1 - (p - outcome)^2
  //       = 1 - ((n - o*d) / d)^2
  //       = (d^2 - (n - o*d)^2) / d^2
  const diff = n - o * d;           // (p - outcome) * d
  const scoreNum = d * d - diff * diff; // score * d^2
  const scoreDenom = d * d;
  // scale to 1e18: result = scoreNum * 1e18 / scoreDenom (rounded to nearest)
  const SCALE = BigInt('1000000000000000000'); // 1e18
  // Round: (scoreNum * SCALE + scoreDenom/2) / scoreDenom
  const scaled = (scoreNum * SCALE + scoreDenom / 2n) / scoreDenom;
  return scaled.toString();
}
