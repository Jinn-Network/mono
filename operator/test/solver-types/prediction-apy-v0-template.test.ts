import { describe, expect, it, vi } from 'vitest';
import { resolvePredictionApyV0Template } from '../../src/solver-types/prediction-apy-v0-template.js';

describe('resolvePredictionApyV0Template', () => {
  it('fills start/end/resolve for startTs=0', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T00:00:00.000Z'));
    const parsed = await resolvePredictionApyV0Template({
      id: 'apy-fast',
      description: 'desc',
      window: { startTs: 0, endTs: 0 },
      spec: {
        kind: 'prediction.apy.v0',
        oracle: {
          venue: 'aave-v3-base-sepolia',
          pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
          reserve: '0x31d3A7711a10C45D72649D51E1c8D74282702572',
          reserveSymbol: 'USDC',
        },
        metric: { type: 'supply-apy-twa-bps', twaWindowSeconds: 3600, sampleCount: 12, toleranceBps: 50 },
        question: { resolveTs: 0 },
      },
    });
    expect(parsed.window.endTs - parsed.window.startTs).toBe(600_000);
    expect(parsed.spec.question.resolveTs - parsed.window.endTs).toBe(300_000);
    vi.useRealTimers();
  });
});
