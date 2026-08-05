/**
 * prediction-v0-evaluator — deterministic verifier for prediction.v1.
 *
 * §6 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 *
 * Pipeline: availability → eligibility → integrity → spec → verdict.
 * Score: brier.v1 scaled to 1e18 fixed-point.
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { baseSepolia, base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { signCanonical } from '../../engine/signing.js';
import { buildVerificationStub } from '../../engine/verification-stub.js';

import type { PublicClient } from 'viem';
import type { HarnessContext, Solution } from '../../types.js';
import { EvaluatorHarness, type EvaluatorHarnessShape } from '../_evaluator-base.js';
import {
  PredictionV1TaskSchema,
} from '../../../types/prediction.js';
import { SignedEnvelopeSchema, normalizeEnvelopeRole } from '../../../types/envelope.js';
import { PredictionV0RestorationPayloadSchema, type PredictionV0RestorationPayload } from '../../../types/payloads/prediction-v0.js';
import {
  oraclePriceAtResolveTs,
  scaleToDecimal,
  type SpanningResult,
} from '../../../venues/chainlink/client.js';
import { resolveGroundTruth } from './canonical-metrics.js';
import { computeScore, SCORE_BASIS, SCORE_VERSION } from './score.js';
import type { Check, Verdict } from './types.js';
import { checkOracleReachable, checkOracleRoundCoversResolveTs } from './checks/availability.js';
import { checkSubmissionWithinWindow } from './checks/eligibility.js';
import {
  checkWindowBounds,
  checkManifestFieldsPresent,
  checkManifestSignature,
  checkTaskRef,
  checkTaskRefMissingExpected,
  recomputeTopLevelSignatureHash,
} from './checks/integrity.js';
import { resolveExpectedSolutionTaskCid, resolveSolutionEnvelopeCid } from '../evaluation-context.js';
import { canonicalJson } from '../../../util/canonical-json.js';
import { checkQuestionKindSupported } from './checks/spec.js';

function nowNanos(): string {
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

export interface PredictionV1EvaluatorConfig {
  /** Set by {@link buildHarnesses} for CLI registries (no real signer). */
  stub?: boolean;
  /** Evaluator's private key — used to sign the verdict manifest. */
  evaluatorPk?: `0x${string}`;
  /** Evaluator's Safe multisig address — written into verdict.evaluator.safeAddress. */
  evaluatorSafeAddress?: `0x${string}`;
  rpcUrl?: string;
  _testDeps?: {
    oraclePriceAtResolveTs?: (feed: `0x${string}`, resolveTs: number) => Promise<SpanningResult>;
    /** Override the taskCid we expect to match — bypasses on-chain derivation for tests. */
    expectedTaskCid?: string;
  };
}


export class PredictionV1Evaluator extends EvaluatorHarness {
  readonly name = 'prediction-v0-evaluator';

  protected readonly shape: EvaluatorHarnessShape = {
    solverType: 'prediction.v1',
    requiresRestorationRequestId: true,
  };

  constructor(private readonly config: PredictionV1EvaluatorConfig) {
    super();
  }

  protected get stub(): boolean {
    return Boolean(this.config.stub);
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    this.assertLive();
    if (!this.config.evaluatorPk || !this.config.evaluatorSafeAddress) {
      throw new Error('prediction-v0-evaluator: evaluatorPk and evaluatorSafeAddress are required');
    }
    const { task: task, workingDir, log } = ctx;
    // Support _testDeps injection from ctx (test) or config (constructor).
    const testDeps = (ctx as any)._testDeps ?? this.config._testDeps;
    const expectedRef = resolveExpectedSolutionTaskCid(task, testDeps);

    // 1. Parse task — same spec the harness ran under
    const predictionTask = PredictionV1TaskSchema.parse(task);
    const { feed, venue } = predictionTask.spec.oracle;

    // 2. Parse harness's SignedEnvelope from inlined context
    const manifestJson = task.context!['restorationResult'] as string;
    const rawPayload = JSON.parse(manifestJson) as Record<string, unknown>;
    const envelope = SignedEnvelopeSchema.parse(rawPayload);
    if (
      envelope.solverType !== 'prediction.v1' ||
      normalizeEnvelopeRole(envelope.role) !== 'solution'
    ) {
      throw new Error(
        `Unexpected envelope kind/role: ${envelope.solverType}/${envelope.role}; expected prediction.v1/solution`,
      );
    }
    const payload: PredictionV0RestorationPayload = PredictionV0RestorationPayloadSchema.parse(envelope.payload);

    // 3. Fetch Chainlink spanning round
    let spanning: SpanningResult;
    const oracleFetchStart = nowNanos();
    const oraclePeerName = venue === 'chainlink-base' ? 'base-rpc' : 'base-sepolia-rpc';
    try {
      if (testDeps?.oraclePriceAtResolveTs) {
        spanning = await testDeps.oraclePriceAtResolveTs(feed as `0x${string}`, predictionTask.spec.question.resolveTs);
      } else {
        const expectedChainId = venue === 'chainlink-base' ? 8453 : 84532;
        const chain = venue === 'chainlink-base' ? base : baseSepolia;
        const publicClient = createPublicClient({
          chain,
          transport: http(this.config.rpcUrl),
        }) as unknown as PublicClient;
        const actualChainId = await publicClient.getChainId();
        if (actualChainId !== expectedChainId) {
          throw new Error(
            `oracle venue mismatch: spec says ${venue} (chainId ${expectedChainId}) but RPC chainId is ${actualChainId}`,
          );
        }
        spanning = await oraclePriceAtResolveTs(
          feed as `0x${string}`,
          predictionTask.spec.question.resolveTs,
          publicClient,
        );
      }
      ctx.trajectory.addSpan({
        name: `chainlink.oraclePriceAtResolveTs ${oraclePeerName}`,
        kind: 'CLIENT',
        startTimeUnixNano: oracleFetchStart,
        endTimeUnixNano: nowNanos(),
        attributes: {
          'jinn.span.kind': 'jinn.venue_io',
          'net.peer.name': oraclePeerName,
          'http.request.method': 'POST',
          'http.response.status_code': 200,
          'url.full': this.config.rpcUrl ?? 'rpc',
          'venue.id': 'chainlink',
          'chainlink.feed': feed,
          'chainlink.resolveTs': predictionTask.spec.question.resolveTs,
        },
        events: [],
        status: { code: 'OK' },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.trajectory.addSpan({
        name: `chainlink.oraclePriceAtResolveTs ${oraclePeerName}`,
        kind: 'CLIENT',
        startTimeUnixNano: oracleFetchStart,
        endTimeUnixNano: nowNanos(),
        attributes: {
          'jinn.span.kind': 'jinn.venue_io',
          'net.peer.name': oraclePeerName,
          'http.request.method': 'POST',
          'http.response.status_code': 0,
          'url.full': this.config.rpcUrl ?? 'rpc',
          'venue.id': 'chainlink',
          'chainlink.feed': feed,
          'chainlink.resolveTs': predictionTask.spec.question.resolveTs,
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
      throw err;
    }

    // 4. Run checks (order matters: availability → eligibility → integrity → spec)
    const checks: Check[] = [];

    // availability — oracle reachable (already fetched above; re-wrap to surface errors)
    checks.push(await checkOracleReachable(async () => spanning));
    checks.push(checkOracleRoundCoversResolveTs(spanning));

    // eligibility
    checks.push(checkSubmissionWithinWindow(payload.prediction.submittedAt, predictionTask.window));

    // integrity
    checks.push(checkWindowBounds(predictionTask));
    checks.push(checkManifestFieldsPresent(payload.prediction));
    {
      const recomputed = recomputeTopLevelSignatureHash(rawPayload);
      checks.push(await checkManifestSignature(recomputed, envelope.signature));
    }
    if (expectedRef.kind === 'missing') {
      checks.push(checkTaskRefMissingExpected());
    } else {
      checks.push(checkTaskRef(envelope.task!.cid, expectedRef.cid));
    }

    // spec
    checks.push(checkQuestionKindSupported(predictionTask.spec.question));

    // 5. Derive verdict
    const scoreStart = nowNanos();
    const verdict = deriveVerdict(checks);

    // 6. Derive ground truth + score
    const priceAtResolve = scaleToDecimal(spanning.round.answer, spanning.round.decimals);
    const groundTruth = resolveGroundTruth(predictionTask.spec.question, priceAtResolve);
    const { score, scoreBasis, scoreVersion } = computeScore(verdict, payload.prediction.probability, groundTruth);
    const scoreEnd = nowNanos();
    ctx.trajectory.addSpan({
      name: 'score.brier.v1',
      kind: 'INTERNAL',
      startTimeUnixNano: scoreStart,
      endTimeUnixNano: scoreEnd,
      attributes: {
        'jinn.span.kind': 'jinn.state_transition',
        'jinn.state.from': 'FETCHED',
        'jinn.state.to': 'SCORED',
        'verdict': verdict,
        'score.basis': scoreBasis,
      },
      events: [],
      status: { code: 'OK' },
    });

    // 7. Assemble + sign verdict manifest
    const evaluatorAccount = privateKeyToAccount(this.config.evaluatorPk!);
    const verdictManifestBase: Record<string, unknown> = {
      generatedAt: Date.now(),
      task: envelope.task,
      evaluator: { safeAddress: this.config.evaluatorSafeAddress, agentEoa: evaluatorAccount.address },
      window: predictionTask.window,
      verdict,
      score,
      scoreBasis,
      scoreVersion,
      oracleReading: {
        feed: feed as `0x${string}`,
        roundId: String(spanning.round.roundId),
        answer: String(spanning.round.answer),
        updatedAt: spanning.round.updatedAt,
        ...(spanning.nextRound ? { nextRoundUpdatedAt: spanning.nextRound.updatedAt } : {}),
      },
      claimed: {
        probability: payload.prediction.probability,
        submittedAt: payload.prediction.submittedAt,
        modelId: payload.prediction.modelId,
        // Omitted when no IPFS submission CID is available (inline / dev).
      },
      groundTruth,
      checks,
    };
    // Sign with JCS canonical form (RFC 8785) via signCanonical — matching
    // envelope-assembly and portfolio-v0-evaluator.
    const signed = await signCanonical(verdictManifestBase, this.config.evaluatorPk! as `0x${string}`, evaluatorAccount.address as `0x${string}`);
    const verdictManifest: Record<string, unknown> = {
      ...verdictManifestBase,
      signature: { algo: 'secp256k1', signer: evaluatorAccount.address, hash: signed.hash, sig: signed.sig },
    };
    const verdictJson = JSON.stringify(verdictManifest, null, 2);
    const verdictSha256 = createHash('sha256').update(verdictJson).digest('hex');
    writeFileSync(join(workingDir, 'verdict.json'), verdictJson);

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

    log({ level: 'info', msg: 'prediction-v0-evaluator: verdict', data: { verdict, score, groundTruth } });

    // ── Verdict payload for engine.pack() (role='verdict' envelope) ───────────
    // Assembles the PredictionV1VerdictPayload from the already-computed fields.
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
    const envelopeCid = resolveSolutionEnvelopeCid(task)
      ?? task.restorationRequestId
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
      score,
      scoreBasis,
      scoreVersion,
      oracleReading: verdictManifestBase['oracleReading'],
      claimed: {
        probability: payload.prediction.probability,
        submittedAt: payload.prediction.submittedAt,
        modelId: payload.prediction.modelId,
        // submissionManifestCid omitted — not available from inline manifest context
        // TODO(plan-d): populate once IPFS submission CID is resolved
      },
      groundTruth,
      checks,
    };

    return {
      venueRef: { name: 'chainlink' },
      gating: {
        verdict,
        score,
        scoreBasis,
        groundTruth,
        checkCount: checks.length,
        passCount: checks.filter(c => c.status === 'PASS').length,
        failCount: checks.filter(c => c.status === 'FAIL').length,
        skipCount: checks.filter(c => c.status === 'SKIP').length,
      },
      informational: {
        claimedProbability: payload.prediction.probability,
        oracleReading: verdictManifestBase['oracleReading'],
      },
      verdictPayload,
      artifacts: [
        {
          path: 'verdict.json',
          artifactType: 'evaluation_verdict',
          metadata: { verdict, score },
          access: { priceUsdc: '0' },
        },
      ],
    };
  }
}

/**
 * Derive verdict from check statuses.
 * Order matters: data-availability failures precede attempt-quality failures.
 */
function deriveVerdict(checks: Check[]): Verdict {
  // Any availability FAIL → INDETERMINATE (oracle unreachable, data gaps)
  if (checks.some(c => c.name.startsWith('availability.') && c.status === 'FAIL')) return 'INDETERMINATE';
  // Any availability SKIP → INDETERMINATE (oracle not yet spanning)
  if (checks.some(c => c.name.startsWith('availability.') && c.status === 'SKIP')) return 'INDETERMINATE';
  // Missing trust anchor for task CID (e.g. legacy eval payload) → INDETERMINATE
  if (checks.some(c => c.name.startsWith('integrity.') && c.status === 'INDETERMINATE')) return 'INDETERMINATE';
  // Any eligibility FAIL → REJECTED
  if (checks.some(c => c.name.startsWith('eligibility.') && c.status === 'FAIL')) return 'REJECTED';
  // Any integrity or spec FAIL → FAIL
  if (
    checks.some(c => c.name.startsWith('integrity.') && c.status === 'FAIL') ||
    checks.some(c => c.name.startsWith('spec.') && c.status === 'FAIL')
  ) {
    return 'FAIL';
  }
  return 'PASS';
}

export default PredictionV1Evaluator;
