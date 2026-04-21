/**
 * prediction-v0-baseline — reference RestorerImpl for prediction.v0.
 *
 * §5 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { baseSepolia, base } from 'viem/chains';

import type {
  RestorerImpl,
  RestorationContext,
  RestorationOutput,
  ReadyStatus,
  EnableResult,
  IntentEnableMetadata,
} from '../../types.js';
import type { PublicClient } from 'viem';
import { PredictionV0IntentSchema } from '../../../types/prediction.js';
import {
  readChainlinkLatest,
  scaleToDecimal,
  type RoundReading,
} from '../../../venues/chainlink/client.js';
import { spotCarryPredict } from './strategy.js';

export interface PredictionV0BaselineConfig {
  rpcUrl?: string;
  _testDeps?: {
    readChainlink?: (feed: `0x${string}`) => Promise<RoundReading>;
  };
}

export class PredictionV0BaselineImpl implements RestorerImpl {
  readonly name = 'prediction-v0-baseline';
  readonly version = '1.0.0';

  constructor(private readonly config: PredictionV0BaselineConfig = {}) {}

  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return ctx.kind === 'prediction.v0' && ctx.type !== 'evaluation';
  }

  async isReady(): Promise<ReadyStatus> {
    // Zero external deps — prediction.v0 runs against on-chain oracles only.
    return { ready: true };
  }

  enableMetadata(): IntentEnableMetadata {
    return {
      description:
        'prediction.v0 — submit probability predictions against on-chain price feeds. No external credentials required.',
    };
  }

  async onEnable(_args: Record<string, string | undefined>): Promise<EnableResult> {
    return { status: 'ready' };
  }

  async canAttempt(intent: import('../../../types/desired-state.js').DesiredState):
    Promise<{ ok: true } | { ok: false; reason: string }>
  {
    const parsed = PredictionV0IntentSchema.safeParse(intent);
    if (!parsed.success) return { ok: false, reason: `Invalid prediction.v0 intent: ${parsed.error.message}` };
    if (Date.now() > parsed.data.window.endTs) {
      return { ok: false, reason: 'window already closed' };
    }
    return { ok: true };
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    const { intent, workingDir, log } = ctx;
    const parsed = PredictionV0IntentSchema.parse(intent);
    const { feed, venue } = parsed.spec.oracle;

    log({ level: 'info', msg: 'prediction-v0-baseline: starting', data: { feed, venue } });

    // Read the feed (injection seam for tests)
    const read = this.config._testDeps?.readChainlink;
    let snapshot: RoundReading;
    if (read) {
      snapshot = await read(feed as `0x${string}`);
    } else {
      const expectedChainId = venue === 'chainlink-base' ? 8453 : 84532;
      const chain = venue === 'chainlink-base' ? base : baseSepolia;
      const pc = createPublicClient({ chain, transport: http(this.config.rpcUrl) }) as unknown as PublicClient;
      const actualChainId = await pc.getChainId();
      if (actualChainId !== expectedChainId) {
        throw new Error(
          `oracle venue mismatch: spec says ${venue} (chainId ${expectedChainId}) but RPC chainId is ${actualChainId}`,
        );
      }
      snapshot = await readChainlinkLatest(feed as `0x${string}`, pc);
    }

    const currentPrice = scaleToDecimal(snapshot.answer, snapshot.decimals);
    const { probability, modelId } = spotCarryPredict(parsed, currentPrice);
    const submittedAt = Date.now();

    const prediction = { probability, submittedAt, modelId };
    writeFileSync(join(workingDir, 'prediction.json'), JSON.stringify(prediction, null, 2));

    log({ level: 'info', msg: 'prediction-v0-baseline: submitted', data: { currentPrice, probability, modelId } });

    return {
      venueRef: { name: 'chainlink' },
      gating: {
        probability,
        submittedAt: String(submittedAt),
        modelId,
      },
      informational: {
        oracleSnapshot: {
          feed,
          roundId: String(snapshot.roundId),
          answer: String(snapshot.answer),
          updatedAt: snapshot.updatedAt,
        },
        currentPrice,
      },
      artifacts: [
        { path: 'prediction.json', role: 'prediction_submission' },
      ],
    };
  }
}

export default PredictionV0BaselineImpl;
