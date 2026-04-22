import type { Verdict } from './types.js';

export const SCORE_BASIS = 'absolute-error-linear.v1' as const;
export const SCORE_VERSION = '1' as const;
const SCALE = 1_000_000_000_000_000_000n;

export function computeScore(
  verdict: Verdict,
  predictedBps: string,
  groundTruthBps: string,
  toleranceBps: number,
): { score: string; scoreBasis: typeof SCORE_BASIS; scoreVersion: typeof SCORE_VERSION; errorBps: string } {
  const p = BigInt(predictedBps);
  const g = BigInt(groundTruthBps);
  const err = p > g ? p - g : g - p;
  if (verdict !== 'PASS') {
    return { score: '0', scoreBasis: SCORE_BASIS, scoreVersion: SCORE_VERSION, errorBps: err.toString() };
  }
  const tol = BigInt(toleranceBps);
  if (tol <= 0n) throw new Error('toleranceBps must be positive');
  if (err >= tol) {
    return { score: '0', scoreBasis: SCORE_BASIS, scoreVersion: SCORE_VERSION, errorBps: err.toString() };
  }
  const score = ((tol - err) * SCALE) / tol;
  return { score: score.toString(), scoreBasis: SCORE_BASIS, scoreVersion: SCORE_VERSION, errorBps: err.toString() };
}
