import { brierScore } from './canonical-metrics.js';

export const SCORE_BASIS = 'brier.v1' as const;
export const SCORE_VERSION = '1' as const;

export type Verdict = 'PASS' | 'FAIL' | 'REJECTED' | 'INDETERMINATE';

export function computeScore(
  verdict: Verdict,
  probability: string,
  groundTruth: 'YES' | 'NO',
): { score: string; scoreBasis: typeof SCORE_BASIS; scoreVersion: typeof SCORE_VERSION } {
  if (verdict !== 'PASS') {
    return { score: '0', scoreBasis: SCORE_BASIS, scoreVersion: SCORE_VERSION };
  }
  const outcome = groundTruth === 'YES' ? 1 : 0;
  return {
    score: brierScore(probability, outcome),
    scoreBasis: SCORE_BASIS,
    scoreVersion: SCORE_VERSION,
  };
}
