import { describe, it, expect } from 'vitest';
import { spotCarryPredict } from '../../../../src/harnesses/impls/prediction-v0-baseline/strategy.js';
import type { PredictionV0Task } from '../../../../src/types/prediction.js';

const intent = (overrides: Partial<PredictionV0Task['spec']['question']> = {}): PredictionV0Task => ({
  id: 'test',
  description: 'd',
  window: { startTs: 0, endTs: 3_600_000 },
  spec: {
    kind: 'prediction.v0',
    oracle: { venue: 'chainlink-base-sepolia', feed: '0xfeed', feedDescription: 'ETH / USD' },
    question: { kind: 'threshold', operator: 'GT', threshold: '3500', resolveTs: 4_500_000, ...overrides },
  },
  eligibility: { maxSubmissionDelayMs: 60_000 },
} as PredictionV0Task);

describe('spotCarryPredict', () => {
  it('returns 0.55 when current price above threshold (GT)', () => {
    expect(spotCarryPredict(intent(), '3501').probability).toBe('0.55');
  });
  it('returns 0.45 when current price at or below threshold (GT)', () => {
    expect(spotCarryPredict(intent(), '3500').probability).toBe('0.45');
    expect(spotCarryPredict(intent(), '3400').probability).toBe('0.45');
  });
  it('handles LT operator', () => {
    expect(spotCarryPredict(intent({ operator: 'LT' }), '3400').probability).toBe('0.55');
    expect(spotCarryPredict(intent({ operator: 'LT' }), '3500').probability).toBe('0.45');
  });
  it('handles range questions', () => {
    const rangeIntent = intent() as any;
    rangeIntent.spec.question = { kind: 'range', lowerBound: '3000', upperBound: '3500', resolveTs: 4_500_000 };
    expect(spotCarryPredict(rangeIntent, '3200').probability).toBe('0.55');
    expect(spotCarryPredict(rangeIntent, '3500').probability).toBe('0.45'); // upper exclusive
    expect(spotCarryPredict(rangeIntent, '2999').probability).toBe('0.45');
  });
  it('reports modelId', () => {
    expect(spotCarryPredict(intent(), '3600').modelId).toBe('spot-carry.v1');
  });
});
