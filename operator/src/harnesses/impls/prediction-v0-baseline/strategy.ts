/**
 * Spot-carry baseline — "current state tends to persist."
 *
 * §5.3 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 */
import type { PredictionV0Task } from '../../../types/prediction.js';
import type { StrategyPrediction } from './types.js';

/** Decimal comparison. Both inputs are non-negative decimal strings. */
function decCmp(a: string, b: string): number {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const aiN = ai.replace(/^0+/, '') || '0';
  const biN = bi.replace(/^0+/, '') || '0';
  if (aiN.length !== biN.length) return aiN.length - biN.length;
  if (aiN !== biN) return aiN < biN ? -1 : 1;
  const maxLen = Math.max(af.length, bf.length);
  const afP = af.padEnd(maxLen, '0');
  const bfP = bf.padEnd(maxLen, '0');
  if (afP === bfP) return 0;
  return afP < bfP ? -1 : 1;
}

function evaluateQuestion(question: PredictionV0Task['spec']['question'], price: string): boolean {
  if (question.kind === 'threshold') {
    const c = decCmp(price, question.threshold);
    switch (question.operator) {
      case 'GT':  return c > 0;
      case 'GTE': return c >= 0;
      case 'LT':  return c < 0;
      case 'LTE': return c <= 0;
    }
  } else {
    const lowerCmp = decCmp(price, question.lowerBound);
    const upperCmp = decCmp(price, question.upperBound);
    return lowerCmp >= 0 && upperCmp < 0;
  }
}

export function spotCarryPredict(task: PredictionV0Task, currentPrice: string): StrategyPrediction {
  const currentlyYes = evaluateQuestion(task.spec.question, currentPrice);
  return {
    probability: currentlyYes ? '0.55' : '0.45',
    modelId: 'spot-carry.v1',
  };
}
