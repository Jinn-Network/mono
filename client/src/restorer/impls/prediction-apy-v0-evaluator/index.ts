import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createPublicClient, http, keccak256, stringToHex } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import type { PublicClient } from 'viem';
import type { RestorerImpl, RestorationContext, RestorationOutput, ReadyStatus } from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS } from '../../types.js';
import type { RestorationJob } from '../../../types/desired-state.js';
import { PredictionApyV0IntentSchema } from '../../../types/prediction-apy.js';
import { twApyBpsOverWindow } from '../../../venues/aave-v3/client.js';
import {
  checkIntentRef,
  checkIntentRefMissingExpected,
  checkManifestSignature,
  recomputeTopLevelSignatureHash,
} from '../prediction-v0-evaluator/checks/integrity.js';
import { resolveExpectedRestorationIntentCid } from '../evaluation-context.js';
import { deriveGroundTruthBps } from './canonical-metrics.js';
import { parsePredictionApySubmissionEnvelope } from './parse-submission.js';
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

function nowNanos(): string {
  return `${BigInt(Date.now()) * 1_000_000n}`;
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
    const { envelope: submissionEnvelope, payload: submission } = parsePredictionApySubmissionEnvelope(manifestJson);
    const checks: Check[] = [];
    const { venue, pool, reserve } = intent.spec.oracle;
    const { chain, chainId } = chainForVenue(venue);

    let twApyBps: number;
    let sampleCount: number;
    const aaveFetchStart = nowNanos();
    const aavePeerName = `aave-v3.${venue}`;
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
      ctx.trajectory.addSpan({
        name: `aave-v3.twApyBpsOverWindow ${aavePeerName}`,
        kind: 'CLIENT',
        startTimeUnixNano: aaveFetchStart,
        endTimeUnixNano: nowNanos(),
        attributes: {
          'jinn.span.kind': 'jinn.venue_io',
          'net.peer.name': aavePeerName,
          'http.request.method': 'POST',
          'http.response.status_code': 200,
          'url.full': this.config.archiveRpcUrl ?? this.config.rpcUrl ?? 'rpc',
          'venue.id': 'aave-v3',
          'aave.pool': pool,
          'aave.reserve': reserve,
        },
        events: [],
        status: { code: 'OK' },
      });
      checks.push({ name: 'availability.aave_readable', status: 'PASS' });
    } catch (error) {
      const msg = String(error);
      ctx.trajectory.addSpan({
        name: `aave-v3.twApyBpsOverWindow ${aavePeerName}`,
        kind: 'CLIENT',
        startTimeUnixNano: aaveFetchStart,
        endTimeUnixNano: nowNanos(),
        attributes: {
          'jinn.span.kind': 'jinn.venue_io',
          'net.peer.name': aavePeerName,
          'http.request.method': 'POST',
          'http.response.status_code': 0,
          'url.full': this.config.archiveRpcUrl ?? this.config.rpcUrl ?? 'rpc',
          'venue.id': 'aave-v3',
          'aave.pool': pool,
          'aave.reserve': reserve,
        },
        events: [
          {
            timeUnixNano: nowNanos(),
            name: 'exception',
            attributes: { 'exception.message': msg },
          },
        ],
        status: { code: 'ERROR', message: msg },
      });
      checks.push({ name: 'availability.aave_readable', status: 'FAIL', detail: msg });
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
      checks.push(await checkManifestSignature(recomputed, submissionEnvelope.signature));
    }
    if (expectedRef.kind === 'missing') {
      checks.push(checkIntentRefMissingExpected());
    } else {
      checks.push(checkIntentRef(submissionEnvelope.intent.cid, expectedRef.cid));
    }

    if (intent.spec.metric.toleranceBps > 0) {
      checks.push({ name: 'spec.tolerance_positive', status: 'PASS' });
    } else {
      checks.push({ name: 'spec.tolerance_positive', status: 'FAIL' });
    }

    const scoreStart = nowNanos();
    const verdict = deriveVerdict(checks);
    const groundTruthBps = deriveGroundTruthBps(intent, twApyBps);
    const scored = computeScore(verdict, submission.prediction.predictedBps, groundTruthBps, intent.spec.metric.toleranceBps);
    const scoreEnd = nowNanos();
    ctx.trajectory.addSpan({
      name: 'score.absolute-error-linear.v1',
      kind: 'INTERNAL',
      startTimeUnixNano: scoreStart,
      endTimeUnixNano: scoreEnd,
      attributes: {
        'jinn.span.kind': 'jinn.state_transition',
        'jinn.state.from': 'FETCHED',
        'jinn.state.to': 'SCORED',
        'verdict': verdict,
        'score.basis': scored.scoreBasis,
      },
      events: [],
      status: { code: 'OK' },
    });

    const evaluatorAccount = privateKeyToAccount(this.config.evaluatorPk!);
    const baseManifest: Record<string, unknown> = {
      generatedAt: Date.now(),
      intent: submissionEnvelope.intent,
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
    const verdictManifest: Record<string, unknown> = {
      ...baseManifest,
      signature: { algo: 'secp256k1', signer: evaluatorAccount.address, hash, sig },
    };
    const verdictJson = JSON.stringify(verdictManifest, null, 2);
    const verdictSha256 = createHash('sha256').update(verdictJson).digest('hex');
    writeFileSync(join(ctx.workingDir, 'verdict.json'), verdictJson);
    const artifactEmitNs = nowNanos();
    ctx.trajectory.addSpan({
      name: 'artifact.emit verdict.json',
      kind: 'INTERNAL',
      startTimeUnixNano: artifactEmitNs,
      endTimeUnixNano: artifactEmitNs,
      attributes: {
        'jinn.span.kind': 'jinn.artifact.emit',
        'jinn.artifact.cid': 'pending',
        'jinn.artifact.artifactType': 'evaluation_verdict',
        'jinn.artifact.sha256': verdictSha256,
        'artifact.path': 'verdict.json',
      },
      events: [],
      status: { code: 'OK' },
    });

    // ── Verdict payload for engine.pack() (role='verdict' envelope) ───────────
    // Assembles the PredictionApyV0VerdictPayload from the already-computed fields.
    //
    // restorationEnvelope: placeholder — the real CID/sha256 of the restoration
    // envelope being evaluated. TODO(plan-d): resolve from adapter using
    // intent.restorationRequestId once restoration envelope lookup is wired.
    //
    // verificationOfRestoration: stub — Plan D will connect the real SDK that
    // fetches + validates the restoration envelope against its claimed tier.
    // For V1 the stub always reports 'valid' (self-signed tier), which means
    // the REJECTED-if-invalid path in engine.pack() never fires in practice
    // until Plan D replaces this stub.
    const restorationEnvelope = {
      // TODO(plan-d): resolve real CID from adapter via intent.restorationRequestId
      cid: ctx.intent.restorationRequestId ?? 'bafy-unknown',
      sha256: '0'.repeat(64),  // TODO(plan-d): derive from fetched envelope bytes
    };

    const verificationOfRestoration = {
      claimedTier: 'self-signed' as const,   // TODO(plan-d): read from restoration envelope
      sdkVersion: '0.0.0-stub',              // TODO(plan-d): real SDK version
      timestamp: Date.now(),
      checks: [{ name: 'stub', passed: true }],
      overall: 'valid' as const,             // TODO(plan-d): real SDK outcome
    };

    const verdictPayload: Record<string, unknown> = {
      restorationEnvelope,
      verificationOfRestoration,
      verdict,
      score: scored.score,
      scoreBasis: scored.scoreBasis,
      scoreVersion: scored.scoreVersion,
      oracleReading: baseManifest['oracleReading'],
      claimed: {
        predictedBps: submission.prediction.predictedBps,
        submittedAt: submission.prediction.submittedAt,
        modelId: submission.prediction.modelId,
        // submissionManifestCid omitted — not available from inline manifest context
        // TODO(plan-d): populate once IPFS submission CID is resolved
      },
      groundTruth: {
        twApyBps: groundTruthBps,
        errorBps: scored.errorBps,
      },
      checks,
    };

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
      verdictPayload,
      artifacts: [
        {
          path: 'verdict.json',
          artifactType: 'evaluation_verdict',
          metadata: { verdict, score: scored.score },
          access: { kind: 'open' },
        },
      ],
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

export { parsePredictionApySubmissionEnvelope } from './parse-submission.js';
export default PredictionApyV0Evaluator;
