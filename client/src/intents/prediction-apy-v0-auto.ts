import type { DesiredState } from '../types/desired-state.js';
import { resolvePredictionApyV0Template } from './prediction-apy-v0-template.js';
import { AAVE_V3_USDC } from '../venues/aave-v3/addresses.js';

export interface PredictionApyV0AutoConfig {
  venue?: 'aave-v3-base-sepolia' | 'aave-v3-base' | 'aave-v3-mainnet';
  windowDurationMs?: number;
  resolveGapMs?: number;
  twaWindowSeconds?: number;
  sampleCount?: number;
  toleranceBps?: number;
}

export type PredictionApyV0Generator = () => Promise<DesiredState | null>;

export function makePredictionApyV0Generator(config: PredictionApyV0AutoConfig = {}): PredictionApyV0Generator {
  const venue = config.venue ?? 'aave-v3-base-sepolia';
  const addrs = AAVE_V3_USDC[venue];
  const windowDurationMs = config.windowDurationMs ?? 600_000;
  const resolveGapMs = config.resolveGapMs ?? 300_000;
  const twaWindowSeconds = config.twaWindowSeconds ?? 3_600;
  const sampleCount = config.sampleCount ?? 12;
  const toleranceBps = config.toleranceBps ?? 50;

  return async (): Promise<DesiredState | null> => {
    const now = Date.now();
    const startTs = Math.floor(now / windowDurationMs) * windowDurationMs;
    const endTs = startTs + windowDurationMs;
    const resolveTs = endTs + resolveGapMs;
    try {
      const intent = await resolvePredictionApyV0Template({
        id: `pred-apy-v0-auto-${startTs}`,
        description: `Auto-generated prediction.apy.v0 intent for ${addrs.symbol} on ${venue}`,
        window: { startTs, endTs },
        spec: {
          kind: 'prediction.apy.v0',
          oracle: {
            venue,
            pool: addrs.pool,
            reserve: addrs.reserve,
            reserveSymbol: addrs.symbol,
          },
          metric: {
            type: 'supply-apy-twa-bps',
            twaWindowSeconds,
            sampleCount,
            toleranceBps,
          },
          question: { resolveTs },
        },
        eligibility: { maxSubmissionDelayMs: windowDurationMs },
      });
      return intent as unknown as DesiredState;
    } catch {
      return null;
    }
  };
}
