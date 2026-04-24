/**
 * prediction-v0-evaluator — deterministic verifier for prediction.v0.
 *
 * §6 of spec/2026-04-20-prediction-v0-pis-phase-1-design.md
 *
 * Pipeline: availability → eligibility → integrity → spec → verdict.
 * Score: brier.v1 scaled to 1e18 fixed-point.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http, keccak256, stringToHex } from 'viem';
import { baseSepolia, base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import type { PublicClient } from 'viem';
import type { RestorerImpl, RestorationContext, RestorationOutput, ReadyStatus } from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS } from '../../types.js';
import type { RestorationJob } from '../../../types/desired-state.js';
import {
  PredictionV0IntentSchema,
  PredictionSubmissionManifestSchema,
  type PredictionSubmissionManifest,
  type PredictionVerdictManifest,
} from '../../../types/prediction.js';
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
  checkIntentRef,
  checkIntentRefMissingExpected,
  recomputeTopLevelSignatureHash,
} from './checks/integrity.js';
import { resolveExpectedRestorationIntentCid } from '../evaluation-context.js';
import { checkQuestionKindSupported } from './checks/spec.js';

export interface PredictionV0EvaluatorConfig {
  /** Set by {@link buildRestorerImpls} for CLI registries (no real signer). */
  stub?: boolean;
  /** Evaluator's private key — used to sign the verdict manifest. */
  evaluatorPk?: `0x${string}`;
  /** Evaluator's Safe multisig address — written into verdict.evaluator.safeAddress. */
  evaluatorSafeAddress?: `0x${string}`;
  rpcUrl?: string;
  _testDeps?: {
    oraclePriceAtResolveTs?: (feed: `0x${string}`, resolveTs: number) => Promise<SpanningResult>;
    /** Override the intentCid we expect to match — bypasses on-chain derivation for tests. */
    expectedIntentCid?: string;
  };
}

function parseRestorationSubmissionManifest(manifestJson: string): PredictionSubmissionManifest {
  const raw = JSON.parse(manifestJson) as Record<string, unknown>;
  const direct = PredictionSubmissionManifestSchema.safeParse(raw);
  if (direct.success) return direct.data;

  if (raw['schemaVersion'] !== 'portfolio.v0.manifest.v1') {
    return PredictionSubmissionManifestSchema.parse(raw);
  }

  const gating = raw['gating'] as Record<string, unknown> | undefined;
  const informational = raw['informational'] as Record<string, unknown> | undefined;
  const oracleSnapshot = informational?.['oracleSnapshot'];
  const normalized = {
    schemaVersion: 'prediction.v0.submission.v1',
    generatedAt: raw['generatedAt'],
    intent: raw['intent'],
    restorer: raw['restorer'],
    window: raw['window'],
    prediction: {
      probability: String(gating?.['probability'] ?? ''),
      submittedAt: Number(gating?.['submittedAt']),
      modelId: String(gating?.['modelId'] ?? ''),
    },
    ...(oracleSnapshot && typeof oracleSnapshot === 'object'
      ? { oracleSnapshot }
      : {}),
    signature: raw['signature'],
  };

  return PredictionSubmissionManifestSchema.parse(normalized);
}

export class PredictionV0Evaluator implements RestorerImpl {
  readonly name = 'prediction-v0-evaluator';
  readonly version = '1.0.0';

  constructor(private readonly config: PredictionV0EvaluatorConfig) {}

  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return ctx.kind === 'prediction.v0' && ctx.type === 'evaluation';
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.config.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    return { ready: true };
  }

  async canAttempt(intent: RestorationJob): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (intent.spec?.kind !== 'prediction.v0') return { ok: false, reason: 'spec.kind is not prediction.v0' };
    if (intent.type !== 'evaluation') return { ok: false, reason: 'type is not evaluation' };
    if (!intent.restorationRequestId) return { ok: false, reason: 'restorationRequestId is required' };
    if (typeof intent.context?.['restorationResult'] !== 'string') {
      return { ok: false, reason: 'context.restorationResult required' };
    }
    return { ok: true };
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    if (this.config.stub) {
      throw new Error('prediction-v0-evaluator: stub registry cannot run evaluation (requires live daemon)');
    }
    if (!this.config.evaluatorPk || !this.config.evaluatorSafeAddress) {
      throw new Error('prediction-v0-evaluator: evaluatorPk and evaluatorSafeAddress are required');
    }
    const { intent, workingDir, log } = ctx;
    // Support _testDeps injection from ctx (test) or config (constructor).
    const testDeps = (ctx as any)._testDeps ?? this.config._testDeps;
    const expectedRef = resolveExpectedRestorationIntentCid(intent, testDeps);

    // 1. Parse intent — same spec the restorer ran under
    const predictionIntent = PredictionV0IntentSchema.parse(intent);
    const { feed, venue } = predictionIntent.spec.oracle;

    // 2. Parse restorer's manifest from inlined context
    const manifestJson = intent.context!['restorationResult'] as string;
    const rawPayload = JSON.parse(manifestJson) as Record<string, unknown>;
    const manifest = parseRestorationSubmissionManifest(manifestJson);

    // 3. Fetch Chainlink spanning round
    let spanning: SpanningResult;
    if (testDeps?.oraclePriceAtResolveTs) {
      spanning = await testDeps.oraclePriceAtResolveTs(feed as `0x${string}`, predictionIntent.spec.question.resolveTs);
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
        predictionIntent.spec.question.resolveTs,
        publicClient,
      );
    }

    // 4. Run checks (order matters: availability → eligibility → integrity → spec)
    const checks: Check[] = [];

    // availability — oracle reachable (already fetched above; re-wrap to surface errors)
    checks.push(await checkOracleReachable(async () => spanning));
    checks.push(checkOracleRoundCoversResolveTs(spanning));

    // eligibility
    checks.push(checkSubmissionWithinWindow(manifest.prediction.submittedAt, predictionIntent.window));

    // integrity
    checks.push(checkWindowBounds(predictionIntent));
    checks.push(checkManifestFieldsPresent(manifest.prediction));
    {
      const recomputed = recomputeTopLevelSignatureHash(rawPayload);
      checks.push(await checkManifestSignature(recomputed, manifest.signature));
    }
    if (expectedRef.kind === 'missing') {
      checks.push(checkIntentRefMissingExpected());
    } else {
      checks.push(checkIntentRef(manifest.intent.cid, expectedRef.cid));
    }

    // spec
    checks.push(checkQuestionKindSupported(predictionIntent.spec.question));

    // 5. Derive verdict
    const verdict = deriveVerdict(checks);

    // 6. Derive ground truth + score
    const priceAtResolve = scaleToDecimal(spanning.round.answer, spanning.round.decimals);
    const groundTruth = resolveGroundTruth(predictionIntent.spec.question, priceAtResolve);
    const { score, scoreBasis, scoreVersion } = computeScore(verdict, manifest.prediction.probability, groundTruth);

    // 7. Assemble + sign verdict manifest
    const evaluatorAccount = privateKeyToAccount(this.config.evaluatorPk!);
    const verdictManifestBase: Omit<PredictionVerdictManifest, 'signature'> = {
      schemaVersion: 'prediction.v0.verdict.v1',
      generatedAt: Date.now(),
      intent: manifest.intent,
      evaluator: { safeAddress: this.config.evaluatorSafeAddress, agentEoa: evaluatorAccount.address },
      window: predictionIntent.window,
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
        probability: manifest.prediction.probability,
        submittedAt: manifest.prediction.submittedAt,
        modelId: manifest.prediction.modelId,
        // Omitted when no IPFS submission CID is available (inline / dev).
      },
      groundTruth,
      checks,
    };
    const canonical = JSON.stringify(verdictManifestBase);
    const hash = keccak256(stringToHex(canonical));
    // Raw ECDSA — no EIP-191 prefix. recoverAddress (not recoverMessageAddress) on verify.
    const sig = await evaluatorAccount.sign({ hash });
    const verdictManifest: PredictionVerdictManifest = {
      ...verdictManifestBase,
      signature: { algo: 'secp256k1', signer: evaluatorAccount.address, hash, sig },
    };
    writeFileSync(join(workingDir, 'verdict.json'), JSON.stringify(verdictManifest, null, 2));

    log({ level: 'info', msg: 'prediction-v0-evaluator: verdict', data: { verdict, score, groundTruth } });

    // ── Verdict payload for engine.pack() (role='verdict' envelope) ───────────
    // Assembles the PredictionV0VerdictPayload from the already-computed fields.
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
      cid: intent.restorationRequestId ?? 'bafy-unknown',
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
      score,
      scoreBasis,
      scoreVersion,
      oracleReading: verdictManifestBase.oracleReading,
      claimed: {
        probability: manifest.prediction.probability,
        submittedAt: manifest.prediction.submittedAt,
        modelId: manifest.prediction.modelId,
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
        claimedProbability: manifest.prediction.probability,
        oracleReading: verdictManifestBase.oracleReading,
      },
      verdictPayload,
      artifacts: [
        {
          path: 'verdict.json',
          artifactType: 'evaluation_verdict',
          metadata: { verdict, score, schemaVersion: 'prediction.v0.verdict.v1' },
          access: { kind: 'open' },
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
  // Missing trust anchor for intent CID (e.g. legacy eval payload) → INDETERMINATE
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

export default PredictionV0Evaluator;
