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
import type { RestorerImpl, RestorationContext, RestorationOutput } from '../../types.js';
import type { DesiredState } from '../../../types/desired-state.js';
import {
  PredictionV0IntentSchema,
  PredictionSubmissionManifestSchema,
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
} from './checks/integrity.js';
import { checkQuestionKindSupported } from './checks/spec.js';

export interface PredictionV0EvaluatorConfig {
  /** Evaluator's private key — used to sign the verdict manifest. */
  evaluatorPk: `0x${string}`;
  /** Evaluator's Safe multisig address — written into verdict.evaluator.safeAddress. */
  evaluatorSafeAddress: `0x${string}`;
  rpcUrl?: string;
  _testDeps?: {
    oraclePriceAtResolveTs?: (feed: `0x${string}`, resolveTs: number) => Promise<SpanningResult>;
    /** Override the intentCid we expect to match — bypasses on-chain derivation for tests. */
    expectedIntentCid?: string;
  };
}

export class PredictionV0Evaluator implements RestorerImpl {
  readonly name = 'prediction-v0-evaluator';
  readonly version = '1.0.0';

  constructor(private readonly config: PredictionV0EvaluatorConfig) {}

  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return ctx.kind === 'prediction.v0' && ctx.type === 'evaluation';
  }

  async canAttempt(intent: DesiredState): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (intent.spec?.kind !== 'prediction.v0') return { ok: false, reason: 'spec.kind is not prediction.v0' };
    if (intent.type !== 'evaluation') return { ok: false, reason: 'type is not evaluation' };
    if (!intent.restorationRequestId) return { ok: false, reason: 'restorationRequestId is required' };
    if (typeof intent.context?.['restorationResult'] !== 'string') {
      return { ok: false, reason: 'context.restorationResult required' };
    }
    return { ok: true };
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    const { intent, workingDir, log } = ctx;
    // Support _testDeps injection from ctx (test) or config (constructor).
    const testDeps = (ctx as any)._testDeps ?? this.config._testDeps;

    // 1. Parse intent — same spec the restorer ran under
    const predictionIntent = PredictionV0IntentSchema.parse(intent);
    const { feed, venue } = predictionIntent.spec.oracle;

    // 2. Parse restorer's manifest from inlined context
    const manifestJson = intent.context!['restorationResult'] as string;
    const manifest = PredictionSubmissionManifestSchema.parse(JSON.parse(manifestJson));

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
    checks.push(await checkManifestSignature(manifest.signature.hash as `0x${string}`, manifest.signature));
    checks.push(checkIntentRef(manifest.intent.cid, testDeps?.expectedIntentCid ?? manifest.intent.cid));

    // spec
    checks.push(checkQuestionKindSupported(predictionIntent.spec.question));

    // 5. Derive verdict
    const verdict = deriveVerdict(checks);

    // 6. Derive ground truth + score
    const priceAtResolve = scaleToDecimal(spanning.round.answer, spanning.round.decimals);
    const groundTruth = resolveGroundTruth(predictionIntent.spec.question, priceAtResolve);
    const { score, scoreBasis, scoreVersion } = computeScore(verdict, manifest.prediction.probability, groundTruth);

    // 7. Assemble + sign verdict manifest
    const evaluatorAccount = privateKeyToAccount(this.config.evaluatorPk);
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
        submissionManifestCid: 'inline',
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
      artifacts: [
        {
          path: 'verdict.json',
          role: 'evaluation_verdict',
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
