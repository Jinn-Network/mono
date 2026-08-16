import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import type {
  Harness,
  HarnessContext,
  Solution,
  ReadyStatus,
  EnableResult,
  HarnessEnableMetadata,
} from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS } from '../../types.js';
import type { PublicClient } from 'viem';
import { PredictionApyV0TaskSchema } from '../../../types/prediction-apy.js';
import { twApyBpsOverWindow } from '../../../venues/aave-v3/client.js';
import { persistencePredict } from './strategy.js';

export interface PredictionApyV0BaselineConfig {
  rpcUrl?: string;
  archiveRpcUrl?: string;
  stub?: boolean;
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

export class PredictionApyV0BaselineImpl implements Harness {
  readonly name = 'prediction-apy-v0-baseline';
  readonly version = '1.0.0';

  constructor(private readonly config: PredictionApyV0BaselineConfig = {}) {}

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === 'prediction.apy.v0' && ctx.role !== 'evaluation';
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.config.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    return { ready: true };
  }

  enableMetadata(): HarnessEnableMetadata {
    return {
      description: 'prediction.apy.v0 — submit APY prediction in bps from Aave v3 reserve data.',
    };
  }

  async onEnable(_ctx: { args: Record<string, string | undefined> }): Promise<EnableResult> {
    return { status: 'ready' };
  }

  async canAttempt(task: import('../../../types/task.js').Task) {
    const parsed = PredictionApyV0TaskSchema.safeParse(task);
    if (!parsed.success) return { ok: false as const, reason: `Invalid prediction.apy.v0 task: ${parsed.error.message}` };
    if (Date.now() > parsed.data.window.endTs) return { ok: false as const, reason: 'window already closed' };
    return { ok: true as const };
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    if (this.config.stub) {
      throw new Error('prediction-apy-v0-baseline: stub registry cannot run (requires live daemon)');
    }
    const parsed = PredictionApyV0TaskSchema.parse(ctx.task);
    const { venue, pool, reserve } = parsed.spec.oracle;
    const { chain, chainId } = chainForVenue(venue);
    const rpcUrl = this.config.archiveRpcUrl ?? this.config.rpcUrl;
    // At submission time, resolveTs is usually in the future — cap the TWA
    // window end at "now" so we only sample historical state (persistence baseline).
    const windowEndForTwa = Math.min(parsed.spec.question.resolveTs, Date.now());
    let twApyBps: number;
    let sampleCount: number;
    if (this.config._testDeps?.twApyBpsOverWindow) {
      const result = await this.config._testDeps.twApyBpsOverWindow({
        pool: pool as `0x${string}`,
        reserve: reserve as `0x${string}`,
        windowEndTs: windowEndForTwa,
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
        windowEndTs: windowEndForTwa,
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
      solutionPayload: {
        prediction: {
          predictedBps: prediction.predictedBps,
          submittedAt,
          modelId: prediction.modelId,
        },
      },
      artifacts: [{ path: 'prediction-apy.json', artifactType: 'prediction_submission' }],
    };
  }
}

export default PredictionApyV0BaselineImpl;
