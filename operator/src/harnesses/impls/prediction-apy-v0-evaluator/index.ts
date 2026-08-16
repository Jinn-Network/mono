import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { base, baseSepolia, mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { signCanonical } from '../../engine/signing.js';
import { buildVerificationStub } from '../../engine/verification-stub.js';
import type { PublicClient } from 'viem';
import type { HarnessContext, Solution } from '../../types.js';
import { EvaluatorHarness, type EvaluatorHarnessShape } from '../_evaluator-base.js';
import { PredictionApyV0TaskSchema } from '../../../types/prediction-apy.js';
import { twApyBpsOverWindow } from '../../../venues/aave-v3/client.js';
import {
  checkTaskRef,
  checkTaskRefMissingExpected,
  checkManifestSignature,
  recomputeTopLevelSignatureHash,
} from '../prediction-v0-evaluator/checks/integrity.js';
import { resolveExpectedSolutionTaskCid, resolveSolutionEnvelopeCid } from '../evaluation-context.js';
import { canonicalJson } from '../../../util/canonical-json.js';
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
    expectedTaskCid?: string;
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

export class PredictionApyV0Evaluator extends EvaluatorHarness {
  readonly name = 'prediction-apy-v0-evaluator';

  protected readonly shape: EvaluatorHarnessShape = {
    solverType: 'prediction.apy.v0',
    requiresRestorationRequestId: false,
  };

  constructor(private readonly config: PredictionApyV0EvaluatorConfig) {
    super();
  }

  protected get stub(): boolean {
    return Boolean(this.config.stub);
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    this.assertLive();
    if (!this.config.evaluatorPk || !this.config.evaluatorSafeAddress) {
      throw new Error('prediction-apy-v0-evaluator: evaluatorPk and evaluatorSafeAddress are required');
    }
    const testDeps = (ctx as HarnessContext & { _testDeps?: PredictionApyV0EvaluatorConfig['_testDeps'] })._testDeps
      ?? this.config._testDeps;
    const expectedRef = resolveExpectedSolutionTaskCid(ctx.task, testDeps);

    const task = PredictionApyV0TaskSchema.parse(ctx.task);
    const manifestJson = ctx.task.context!['restorationResult'] as string;
    const rawPayload = JSON.parse(manifestJson) as Record<string, unknown>;
    const { envelope: submissionEnvelope, payload: submission } = parsePredictionApySubmissionEnvelope(manifestJson);
    const checks: Check[] = [];
    const { venue, pool, reserve } = task.spec.oracle;
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
          windowEndTs: task.spec.question.resolveTs,
          twaWindowSeconds: task.spec.metric.twaWindowSeconds,
          sampleCount: task.spec.metric.sampleCount,
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
          windowEndTs: task.spec.question.resolveTs,
          twaWindowSeconds: task.spec.metric.twaWindowSeconds,
          sampleCount: task.spec.metric.sampleCount,
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
      const w = task.window;
      const within = sa >= w.startTs && sa < w.endTs;
      checks.push({
        name: 'eligibility.submission_within_window',
        status: within ? 'PASS' : 'FAIL',
        detail: within ? undefined : { submittedAt: sa, startTs: w.startTs, endTs: w.endTs },
      });
    }
    {
      const sa = submission.prediction.submittedAt;
      const w = task.window;
      const maxDelay = task.eligibility.maxSubmissionDelayMs;
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
      checks.push(checkTaskRefMissingExpected());
    } else {
      checks.push(checkTaskRef(submissionEnvelope.task!.cid, expectedRef.cid));
    }

    if (task.spec.metric.toleranceBps > 0) {
      checks.push({ name: 'spec.tolerance_positive', status: 'PASS' });
    } else {
      checks.push({ name: 'spec.tolerance_positive', status: 'FAIL' });
    }

    const scoreStart = nowNanos();
    const verdict = deriveVerdict(checks);
    const groundTruthBps = deriveGroundTruthBps(task, twApyBps);
    const scored = computeScore(verdict, submission.prediction.predictedBps, groundTruthBps, task.spec.metric.toleranceBps);
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
      task: submissionEnvelope.task,
      evaluator: { safeAddress: this.config.evaluatorSafeAddress, agentEoa: evaluatorAccount.address },
      window: task.window,
      verdict,
      score: scored.score,
      scoreBasis: scored.scoreBasis,
      scoreVersion: scored.scoreVersion,
      oracleReading: {
        pool: pool as `0x${string}`,
        reserve: reserve as `0x${string}`,
        sampleCount,
        twaWindowSeconds: task.spec.metric.twaWindowSeconds,
        resolveTs: task.spec.question.resolveTs,
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
    // Sign with JCS canonical form (RFC 8785) via signCanonical — matching
    // envelope-assembly and portfolio-v0-evaluator.
    const signed = await signCanonical(baseManifest, this.config.evaluatorPk! as `0x${string}`, evaluatorAccount.address as `0x${string}`);
    const verdictManifest: Record<string, unknown> = {
      ...baseManifest,
      signature: { algo: 'secp256k1', signer: evaluatorAccount.address, hash: signed.hash, sig: signed.sig },
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
    // solutionEnvelope: CID threaded from the daemon via context, sha256
    // computed as sha256(JCS(solutionEnvelope)) — matching the upload pipeline
    // and the conformance harness (8l6 fix A).
    //
    // verificationOfRestoration: stub — Plan D will connect the real SDK that
    // fetches + validates the restoration envelope against its claimed tier.
    // For V1 the stub always reports 'valid' (self-signed tier), which means
    // the REJECTED-if-invalid path in engine.pack() never fires in practice
    // until Plan D replaces this stub.
    const envelopeCid = resolveSolutionEnvelopeCid(ctx.task)
      ?? ctx.task.restorationRequestId
      ?? 'bafy-unknown';
    // Use JCS canonical bytes so the sha256 matches the upload pipeline (8l6 fix A).
    const envelopeSha256 = createHash('sha256').update(canonicalJson(rawPayload)).digest('hex');
    const solutionEnvelope = {
      cid: envelopeCid,
      sha256: envelopeSha256,
    };

    const verificationOfRestoration = buildVerificationStub();

    const verdictPayload: Record<string, unknown> = {
      solutionEnvelope,
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
          access: { priceUsdc: '0' },
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
