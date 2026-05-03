/**
 * prediction-v0-baseline — reference Harness for prediction.v1.
 *
 * §5 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { baseSepolia, base } from 'viem/chains';

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
import { PredictionV1TaskSchema } from '../../../types/prediction.js';
import {
  readChainlinkLatest,
  scaleToDecimal,
  type RoundReading,
} from '../../../venues/chainlink/client.js';
import { spotCarryPredict } from './strategy.js';

export interface PredictionV1BaselineConfig {
  rpcUrl?: string;
  /** CLI registries that cannot execute tasks without the daemon. */
  stub?: boolean;
  _testDeps?: {
    readChainlink?: (feed: `0x${string}`) => Promise<RoundReading>;
  };
}

export class PredictionV1BaselineImpl implements Harness {
  readonly name = 'prediction-v0-baseline';
  readonly version = '1.0.0';

  constructor(private readonly config: PredictionV1BaselineConfig = {}) {}

  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    return ctx.solverType === 'prediction.v1' && ctx.role !== 'evaluation';
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.config.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    // Zero external deps — prediction.v1 runs against on-chain oracles only.
    return { ready: true };
  }

  enableMetadata(): HarnessEnableMetadata {
    return {
      description:
        'prediction.v1 — submit probability predictions against on-chain price feeds. No external credentials required.',
    };
  }

  async onEnable(_ctx: { args: Record<string, string | undefined> }): Promise<EnableResult> {
    return { status: 'ready' };
  }

  async canAttempt(task: import('../../../types/task.js').Task):
    Promise<{ ok: true } | { ok: false; reason: string }>
  {
    const parsed = PredictionV1TaskSchema.safeParse(task);
    if (!parsed.success) return { ok: false, reason: `Invalid prediction.v1 task: ${parsed.error.message}` };
    if (Date.now() > parsed.data.window.endTs) {
      return { ok: false, reason: 'window already closed' };
    }
    return { ok: true };
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    if (this.config.stub) {
      throw new Error('prediction-v0-baseline: stub registry cannot run (requires live daemon)');
    }
    const { task: task, workingDir, log } = ctx;
    const parsed = PredictionV1TaskSchema.parse(task);
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

    const oracleSnapshot = {
      feed: feed as `0x${string}`,
      roundId: String(snapshot.roundId),
      answer: String(snapshot.answer),
      updatedAt: snapshot.updatedAt,
    };

    return {
      venueRef: { name: 'chainlink' },
      gating: {
        probability,
        submittedAt: String(submittedAt),
        modelId,
      },
      informational: {
        oracleSnapshot,
        currentPrice,
      },
      solutionPayload: {
        prediction: {
          probability,
          submittedAt,
          modelId,
        },
        oracleSnapshot,
      },
      artifacts: [
        { path: 'prediction.json', artifactType: 'prediction_submission' },
      ],
    };
  }
}

export default PredictionV1BaselineImpl;
