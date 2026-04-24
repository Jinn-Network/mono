import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, keccak256, stringToHex } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import type { PublicClient } from 'viem';
import type { RestorerImpl, RestorationContext, RestorationOutput, ReadyStatus } from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS } from '../../types.js';
import type { RestorationJob } from '../../../types/desired-state.js';
import { PredictionApyV0IntentSchema, type PredictionApyVerdictManifest } from '../../../types/prediction-apy.js';
import { twApyBpsOverWindow } from '../../../venues/aave-v3/client.js';
import {
  checkIntentRef,
  checkIntentRefMissingExpected,
  checkManifestSignature,
  recomputeTopLevelSignatureHash,
} from '../prediction-v0-evaluator/checks/integrity.js';
import { resolveExpectedRestorationIntentCid } from '../evaluation-context.js';
import { deriveGroundTruthBps } from './canonical-metrics.js';
import { parsePredictionApySubmissionManifest } from './parse-submission.js';
import { computeScore } from './score.js';
import type { Check, Verdict } from './types.js';

export interface PredictionApyV0EvaluatorConfig {
  stub?: boolean;
  evaluatorPk?: `0x${string}`;
  evaluatorSafeAddress?: `0x${string}`;
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
    expectedIntentCid?: string;
  };
}

function chainForVenue(venue: 'aave-v3-base-sepolia' | 'aave-v3-base' | 'aave-v3-mainnet') {
  if (venue === 'aave-v3-base-sepolia') return { chain: baseSepolia, chainId: 84532 };
  if (venue === 'aave-v3-mainnet') return { chain: mainnet, chainId: 1 };
  return { chain: base, chainId: 8453 };
}

export class PredictionApyV0Evaluator implements RestorerImpl {
  readonly name = 'prediction-apy-v0-evaluator';
  readonly version = '1.0.0';

  constructor(private readonly config: PredictionApyV0EvaluatorConfig) {}

  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return ctx.kind === 'prediction.apy.v0' && ctx.type === 'evaluation';
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.config.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    return { ready: true };
  }

  async canAttempt(intent: RestorationJob): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (intent.spec?.kind !== 'prediction.apy.v0') return { ok: false, reason: 'spec.kind is not prediction.apy.v0' };
    if (intent.type !== 'evaluation') return { ok: false, reason: 'type is not evaluation' };
    if (typeof intent.context?.['restorationResult'] !== 'string') {
      return { ok: false, reason: 'context.restorationResult required' };
    }
    return { ok: true };
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    if (this.config.stub) {
      throw new Error('prediction-apy-v0-evaluator: stub registry cannot run evaluation (requires live daemon)');
    }
    if (!this.config.evaluatorPk || !this.config.evaluatorSafeAddress) {
      throw new Error('prediction-apy-v0-evaluator: evaluatorPk and evaluatorSafeAddress are required');
    }
    const testDeps = (ctx as RestorationContext & { _testDeps?: PredictionApyV0EvaluatorConfig['_testDeps'] })._testDeps
      ?? this.config._testDeps;
    const expectedRef = resolveExpectedRestorationIntentCid(ctx.intent, testDeps);

    const intent = PredictionApyV0IntentSchema.parse(ctx.intent);
    const manifestJson = ctx.intent.context!['restorationResult'] as string;
    const rawPayload = JSON.parse(manifestJson) as Record<string, unknown>;
    const submission = parsePredictionApySubmissionManifest(manifestJson);
    const checks: Check[] = [];
    const { venue, pool, reserve } = intent.spec.oracle;
    const { chain, chainId } = chainForVenue(venue);

    let twApyBps: number;
    let sampleCount: number;
    try {
      if (testDeps?.twApyBpsOverWindow) {
        const result = await testDeps.twApyBpsOverWindow({
          pool: pool as `0x${string}`,
          reserve: reserve as `0x${string}`,
          windowEndTs: intent.spec.question.resolveTs,
          twaWindowSeconds: intent.spec.metric.twaWindowSeconds,
          sampleCount: intent.spec.metric.sampleCount,
        });
        twApyBps = result.twApyBps;
        sampleCount = result.sampleCount;
      } else {
        const rpcUrl = this.config.archiveRpcUrl ?? this.config.rpcUrl;
        const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as unknown as PublicClient;
        const actual = await publicClient.getChainId();
        if (actual !== chainId) {
          throw new Error(`oracle venue mismatch: ${venue} expects chain ${chainId}, got ${actual}`);
        }
        const result = await twApyBpsOverWindow({
          publicClient,
          pool: pool as `0x${string}`,
          reserve: reserve as `0x${string}`,
          windowEndTs: intent.spec.question.resolveTs,
          twaWindowSeconds: intent.spec.metric.twaWindowSeconds,
          sampleCount: intent.spec.metric.sampleCount,
        });
        twApyBps = result.twApyBps;
        sampleCount = result.sampleCount;
      }
      checks.push({ name: 'availability.aave_readable', status: 'PASS' });
    } catch (error) {
      checks.push({ name: 'availability.aave_readable', status: 'FAIL', detail: String(error) });
      twApyBps = 0;
      sampleCount = 0;
    }

    {
      const sa = submission.prediction.submittedAt;
      const w = intent.window;
      const within = sa >= w.startTs && sa < w.endTs;
      checks.push({
        name: 'eligibility.submission_within_window',
        status: within ? 'PASS' : 'FAIL',
        detail: within ? undefined : { submittedAt: sa, startTs: w.startTs, endTs: w.endTs },
      });
    }
    {
      const sa = submission.prediction.submittedAt;
      const w = intent.window;
      const maxDelay = intent.eligibility.maxSubmissionDelayMs;
      const within = sa <= w.startTs + maxDelay;
      checks.push({
        name: 'eligibility.submission_within_max_delay',
        status: within ? 'PASS' : 'FAIL',
        detail: within
          ? undefined
          : { submittedAt: sa, startTs: w.startTs, maxSubmissionDelayMs: maxDelay },
      });
    }

    {
      const recomputed = recomputeTopLevelSignatureHash(rawPayload);
      checks.push(await checkManifestSignature(recomputed, submission.signature));
    }
    if (expectedRef.kind === 'missing') {
      checks.push(checkIntentRefMissingExpected());
    } else {
      checks.push(checkIntentRef(submission.intent.cid, expectedRef.cid));
    }

    if (intent.spec.metric.toleranceBps > 0) {
      checks.push({ name: 'spec.tolerance_positive', status: 'PASS' });
    } else {
      checks.push({ name: 'spec.tolerance_positive', status: 'FAIL' });
    }

    const verdict = deriveVerdict(checks);
    const groundTruthBps = deriveGroundTruthBps(intent, twApyBps);
    const scored = computeScore(verdict, submission.prediction.predictedBps, groundTruthBps, intent.spec.metric.toleranceBps);

    const evaluatorAccount = privateKeyToAccount(this.config.evaluatorPk!);
    const baseManifest: Omit<PredictionApyVerdictManifest, 'signature'> = {
      schemaVersion: 'prediction.apy.v0.verdict.v1',
      generatedAt: Date.now(),
      intent: submission.intent,
      evaluator: { safeAddress: this.config.evaluatorSafeAddress, agentEoa: evaluatorAccount.address },
      window: intent.window,
      verdict,
      score: scored.score,
      scoreBasis: scored.scoreBasis,
      scoreVersion: scored.scoreVersion,
      oracleReading: {
        pool: pool as `0x${string}`,
        reserve: reserve as `0x${string}`,
        sampleCount,
        twaWindowSeconds: intent.spec.metric.twaWindowSeconds,
        resolveTs: intent.spec.question.resolveTs,
      },
      claimed: {
        predictedBps: submission.prediction.predictedBps,
        submittedAt: submission.prediction.submittedAt,
        modelId: submission.prediction.modelId,
      },
      groundTruth: {
        twApyBps: groundTruthBps,
        errorBps: scored.errorBps,
      },
      checks,
    };
    const hash = keccak256(stringToHex(JSON.stringify(baseManifest)));
    const sig = await evaluatorAccount.sign({ hash });
    const verdictManifest: PredictionApyVerdictManifest = {
      ...baseManifest,
      signature: { algo: 'secp256k1', signer: evaluatorAccount.address, hash, sig },
    };
    writeFileSync(join(ctx.workingDir, 'verdict.json'), JSON.stringify(verdictManifest, null, 2));

    return {
      venueRef: { name: 'aave-v3' },
      gating: {
        verdict,
        score: scored.score,
        groundTruthBps,
        errorBps: scored.errorBps,
      },
      informational: {
        predictedBps: submission.prediction.predictedBps,
      },
      artifacts: [{ path: 'verdict.json', role: 'evaluation_verdict' }],
    };
  }
}

function deriveVerdict(checks: Check[]): Verdict {
  if (checks.some((c) => c.name.startsWith('availability.') && c.status !== 'PASS')) return 'INDETERMINATE';
  if (checks.some((c) => c.name.startsWith('integrity.') && c.status === 'INDETERMINATE')) return 'INDETERMINATE';
  if (checks.some((c) => c.name.startsWith('eligibility.') && c.status === 'FAIL')) return 'REJECTED';
  if (checks.some((c) => (c.name.startsWith('integrity.') || c.name.startsWith('spec.')) && c.status === 'FAIL')) return 'FAIL';
  return 'PASS';
}

export { parsePredictionApySubmissionManifest } from './parse-submission.js';
export default PredictionApyV0Evaluator;
