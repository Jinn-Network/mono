import { describe, it, expect } from 'vitest';
import { buildSessionPrompt } from '../../../../src/harnesses/impls/claude-mcp-prediction-apy/prompt.js';
import type { PredictionApyV0Task } from '../../../../src/types/prediction-apy.js';

function sampleTask(): PredictionApyV0Task {
  const startTs = 1_700_000_000_000;
  const endTs = startTs + 600_000;
  const resolveTs = endTs + 300_000;
  return {
    id: 'snap-1',
    description: 'snapshot task',
    window: { startTs, endTs },
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
      question: { resolveTs },
    },
    eligibility: {},
  };
}

describe('buildSessionPrompt', () => {
  it('matches snapshot (static template + fixed timestamps)', () => {
    expect(buildSessionPrompt(sampleTask(), 'apy-snap-session')).toMatchSnapshot();
  });
});
