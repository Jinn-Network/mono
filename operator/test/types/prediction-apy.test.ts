import { describe, expect, it } from 'vitest';
import { PredictionApyV0TaskSchema } from '../../src/types/prediction-apy.js';

describe('PredictionApyV0TaskSchema', () => {
  it('accepts fast-profile values', () => {
    const parsed = PredictionApyV0TaskSchema.parse({
      id: 'apy-1',
      description: 'Aave APY prediction',
      window: { startTs: 1_700_000_000_000, endTs: 1_700_000_600_000 },
      spec: {
        kind: 'prediction.apy.v0',
        oracle: {
          venue: 'aave-v3-base-sepolia',
          pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
          reserve: '0x31d3A7711a10C45D72649D51E1c8D74282702572',
          reserveSymbol: 'USDC',
        },
        metric: {
          type: 'supply-apy-twa-bps',
          twaWindowSeconds: 3600,
          sampleCount: 12,
          toleranceBps: 50,
        },
        question: {
          resolveTs: 1_700_000_900_000,
        },
      },
      eligibility: {},
    });
    expect(parsed.spec.metric.sampleCount).toBe(12);
    expect(parsed.eligibility.maxSubmissionDelayMs).toBe(72 * 3_600_000);
  });

  it('rejects TWA sample spacing under 1 second', () => {
    expect(() =>
      PredictionApyV0TaskSchema.parse({
        id: 'x',
        description: 'd',
        window: { startTs: 0, endTs: 3_600_000 },
        spec: {
          kind: 'prediction.apy.v0',
          oracle: {
            venue: 'aave-v3-base-sepolia',
            pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
            reserve: '0x31d3A7711a10C45D72649D51E1c8D74282702572',
            reserveSymbol: 'USDC',
          },
          metric: {
            type: 'supply-apy-twa-bps',
            twaWindowSeconds: 100,
            sampleCount: 102,
            toleranceBps: 50,
          },
          question: { resolveTs: 3_600_000 },
        },
        eligibility: {},
      }),
    ).toThrow();
  });
});
