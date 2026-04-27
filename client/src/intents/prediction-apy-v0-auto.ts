import { randomUUID } from 'node:crypto';
import type { RestorationJob } from '../types/desired-state.js';
import type { IntentV1, SignedIntentV1 } from '../types/intent.js';
import { resolvePredictionApyV0Template } from './prediction-apy-v0-template.js';
import { signIntentV1 } from './signing.js';
import { AAVE_V3_USDC } from '../venues/aave-v3/addresses.js';

export interface PredictionApyV0AutoConfig {
  venue?: 'aave-v3-base-sepolia' | 'aave-v3-base' | 'aave-v3-mainnet';
  windowDurationMs?: number;
  resolveGapMs?: number;
  twaWindowSeconds?: number;
  sampleCount?: number;
  toleranceBps?: number;
  /**
   * Agent EOA address. When provided alongside `safeAddress` and
   * `agentPrivateKey`, the generator produces a `SignedIntentV1` embedded in
   * the returned RestorationJob's `intent` field.
   */
  agentEoa?: `0x${string}`;
  /** Safe address — embedded in `intent.creator.safeAddress`. */
  safeAddress?: `0x${string}`;
  /** Agent private key — used to sign the IntentV1. */
  agentPrivateKey?: `0x${string}`;
}

export type PredictionApyV0Generator = () => Promise<RestorationJob | null>;

export function makePredictionApyV0Generator(config: PredictionApyV0AutoConfig = {}): PredictionApyV0Generator {
  const venue = config.venue ?? 'aave-v3-base-sepolia';
  const addrs = AAVE_V3_USDC[venue];
  const windowDurationMs = config.windowDurationMs ?? 600_000;
  const resolveGapMs = config.resolveGapMs ?? 300_000;
  const twaWindowSeconds = config.twaWindowSeconds ?? 3_600;
  const sampleCount = config.sampleCount ?? 12;
  const toleranceBps = config.toleranceBps ?? 50;

  return async (): Promise<RestorationJob | null> => {
    const now = Date.now();
    const startTs = Math.floor(now / windowDurationMs) * windowDurationMs;
    const endTs = startTs + windowDurationMs;
    const resolveTs = endTs + resolveGapMs;
    try {
      const resolved = await resolvePredictionApyV0Template({
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

      // When signing credentials are available, produce a SignedIntentV1 and
      // embed it in the RestorationJob's `intent` field so MechAdapter's
      // `state.intent ?? buildRestorationJobPayload(...)` path picks it up.
      if (config.agentEoa && config.safeAddress && config.agentPrivateKey) {
        const intentDoc: IntentV1 = {
          schemaVersion: 'intent.v1',
          id: resolved.id ?? randomUUID(),
          kind: 'prediction.apy.v0',
          description: resolved.description,
          window: resolved.window,
          spec: resolved.spec as IntentV1['spec'],
          eligibility: resolved.eligibility ?? {},
          creator: {
            safeAddress: config.safeAddress,
            agentEoa: config.agentEoa,
          },
          createdAt: Date.now(),
        };
        const signed: SignedIntentV1 = await signIntentV1(intentDoc, config.agentPrivateKey);
        const job: RestorationJob = resolved as unknown as RestorationJob;
        return { ...job, intent: signed };
      }

      // No signing credentials — return the resolved shape without a signed intent.
      return resolved as unknown as RestorationJob;
    } catch {
      return null;
    }
  };
}
