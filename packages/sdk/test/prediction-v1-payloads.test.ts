import { describe, expect, it } from 'vitest';
import { PredictionV1VerdictPayloadSchema } from '../src/payloads/prediction-v1.js';

const solutionEnvelope = { cid: 'bafy-solution', sha256: 'a'.repeat(64) };

function validVerdictPayload() {
  return {
    verdict: 'SCORED',
    outcome: 'YES',
    resolvedAt: '2026-05-04T00:00:00.000Z',
    resolutionSource: {
      venue: 'polymarket',
      url: 'https://polymarket.com/event/test-market',
      marketId: 'mkt-1',
      conditionId: '0xabc',
    },
    task: { cid: 'bafy-task', id: 'prediction-v1-polymarket-abc' },
    solutionEnvelope,
    claimed: {
      probabilityYes: '0.5700',
      submittedAt: '2026-05-02T01:00:00.000Z',
      modelId: 'prediction-v1-baseline/consensus',
    },
    benchmark: {
      probabilityYes: '0.6200',
      sampledAt: '2026-05-02T00:00:00.000Z',
      method: 'best-bid-ask-midpoint',
    },
    scores: {
      scoreBasis: 'brier-loss.v1',
      solverBrier: '0.184900',
      consensusBrier: '0.144400',
      brierSpread: '0.040500',
    },
    checks: [{ name: 'solution.schema', status: 'PASS' }],
  };
}

describe('PredictionV1VerdictPayloadSchema', () => {
  it('accepts canonical solutionEnvelope verdict payloads', () => {
    expect(() => PredictionV1VerdictPayloadSchema.parse(validVerdictPayload())).not.toThrow();
  });

  it('accepts legacy restorationEnvelope verdict payloads as a read alias', () => {
    const { solutionEnvelope: _solutionEnvelope, ...rest } = validVerdictPayload();
    const parsed = PredictionV1VerdictPayloadSchema.parse({
      ...rest,
      restorationEnvelope: solutionEnvelope,
    });

    expect(parsed.solutionEnvelope).toEqual(solutionEnvelope);
  });
});
