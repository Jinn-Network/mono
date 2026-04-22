import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import type {
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
  ReadyStatus,
  EnableResult,
  IntentEnableMetadata,
} from '../../types.js';
import type { PublicClient } from 'viem';
import { PredictionApyV0IntentSchema } from '../../../types/prediction-apy.js';
import { twApyBpsOverWindow } from '../../../venues/aave-v3/client.js';
import { persistencePredict } from './strategy.js';

export interface PredictionApyV0BaselineConfig {
  rpcUrl?: string;
  archiveRpcUrl?: string;
  _testDeps?: {
    twApyBpsOverWindow?: (args: {
      windowEndTs: number;
      twaWindowSeconds: number;
      sampleCount: number;
      pool: `0x${string}`;
      reserve: `0x${string}`;
    }) => Promise<{ twApyBps: number; sampleCount: number }>;
  };
}

function chainForVenue(venue: 'aave-v3-base-sepolia' | 'aave-v3-base' | 'aave-v3-mainnet') {
  if (venue === 'aave-v3-base-sepolia') return { chain: baseSepolia, chainId: 84532 };
  if (venue === 'aave-v3-mainnet') return { chain: mainnet, chainId: 1 };
  return { chain: base, chainId: 8453 };
}

export class PredictionApyV0BaselineImpl implements RestorerImpl {
  readonly name = 'prediction-apy-v0-baseline';
  readonly version = '1.0.0';

  constructor(private readonly config: PredictionApyV0BaselineConfig = {}) {}

  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return ctx.kind === 'prediction.apy.v0' && ctx.type !== 'evaluation';
  }

  async isReady(): Promise<ReadyStatus> {
    return { ready: true };
  }

  enableMetadata(): IntentEnableMetadata {
    return {
      description: 'prediction.apy.v0 — submit APY prediction in bps from Aave v3 reserve data.',
    };
  }

  async onEnable(_args: Record<string, string | undefined>): Promise<EnableResult> {
    return { status: 'ready' };
  }

  async canAttempt(intent: import('../../../types/desired-state.js').DesiredState) {
    const parsed = PredictionApyV0IntentSchema.safeParse(intent);
    if (!parsed.success) return { ok: false as const, reason: `Invalid prediction.apy.v0 intent: ${parsed.error.message}` };
    if (Date.now() > parsed.data.window.endTs) return { ok: false as const, reason: 'window already closed' };
    return { ok: true as const };
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    const parsed = PredictionApyV0IntentSchema.parse(ctx.intent);
    const { venue, pool, reserve } = parsed.spec.oracle;
    const { chain, chainId } = chainForVenue(venue);
    const rpcUrl = this.config.rpcUrl ?? this.config.archiveRpcUrl;
    let twApyBps: number;
    let sampleCount: number;
    if (this.config._testDeps?.twApyBpsOverWindow) {
      const result = await this.config._testDeps.twApyBpsOverWindow({
        pool: pool as `0x${string}`,
        reserve: reserve as `0x${string}`,
        windowEndTs: parsed.spec.question.resolveTs,
        twaWindowSeconds: parsed.spec.metric.twaWindowSeconds,
        sampleCount: parsed.spec.metric.sampleCount,
      });
      twApyBps = result.twApyBps;
      sampleCount = result.sampleCount;
    } else {
      const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as unknown as PublicClient;
      const actual = await publicClient.getChainId();
      if (actual !== chainId) {
        throw new Error(`oracle venue mismatch: ${venue} expects chain ${chainId}, got ${actual}`);
      }
      const result = await twApyBpsOverWindow({
        publicClient,
        pool: pool as `0x${string}`,
        reserve: reserve as `0x${string}`,
        windowEndTs: parsed.spec.question.resolveTs,
        twaWindowSeconds: parsed.spec.metric.twaWindowSeconds,
        sampleCount: parsed.spec.metric.sampleCount,
      });
      twApyBps = result.twApyBps;
      sampleCount = result.sampleCount;
    }

    const prediction = persistencePredict(twApyBps);
    const submittedAt = Date.now();
    writeFileSync(
      join(ctx.workingDir, 'prediction-apy.json'),
      JSON.stringify({ ...prediction, submittedAt, twApyBps }, null, 2),
    );
    return {
      venueRef: { name: 'aave-v3' },
      gating: {
        predictedBps: prediction.predictedBps,
        submittedAt: String(submittedAt),
        modelId: prediction.modelId,
      },
      informational: {
        twApyBps,
        sampleCount,
      },
      artifacts: [{ path: 'prediction-apy.json', role: 'prediction_submission' }],
    };
  }
}

export default PredictionApyV0BaselineImpl;
