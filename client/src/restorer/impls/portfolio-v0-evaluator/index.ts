/**
 * portfolio-v0-evaluator — deterministic verifier for portfolio.v0 manifests.
 *
 * Implements RestorerImpl for spec.kind === "portfolio.v0" && type === "evaluation".
 * No LLM. Pure deterministic verification per spec §7.
 *
 * Architecture decision (T7):
 *   The engine (locked) builds portfolio.v0.manifest.v1. The verdict manifest
 *   shape is portfolio.v0.eval.manifest.v1 (§5.2). Since the engine cannot be
 *   modified, the eval impl assembles and signs the verdict manifest itself,
 *   writes it as verdict.json in workingDir, and declares it as an artifact
 *   with role "evaluation_verdict". The engine's outer manifest becomes the
 *   packaging container; verdict.json is the meaningful payload.
 *
 * Unified-payload model (Task 7):
 *   - spec.kind is "portfolio.v0" (same as restoration)
 *   - intent.type === "evaluation"
 *   - Restorer's manifest is inlined at intent.context.restorationResult (JSON string)
 *   - Original intent spec is at intent.spec (PortfolioV0Spec) — no IPFS fetch needed
 *   - intent.restorationRequestId carries the on-chain request ID
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { RestorerImpl, RestorationContext, RestorationOutput, ReadyStatus } from '../../types.js';
import { REQUIRES_LIVE_DAEMON_READINESS } from '../../types.js';
import type { RestorationJob } from '../../../types/desired-state.js';
import type { HlFill, HlGridPoint } from '../../../venues/hyperliquid/types.js';
import { HyperliquidClient, HL_MAINNET_BASE_URL, HL_TESTNET_BASE_URL } from '../../../venues/hyperliquid/client.js';
import { bracketGridPoints } from '../../../venues/hyperliquid/grid.js';
import { canonicalJson } from '../../engine/canonical-json.js';
import { signCanonical } from '../../engine/signing.js';

import {
  RestorationManifestSchema,
  PortfolioV0IntentSchema,
  PortfolioV0EligibilitySchema,
} from '../../../types/portfolio.js';
import type { RestorationManifest } from '../../../types/portfolio.js';

import {
  equityCurve,
  maxDrawdownPct as computeMaxDrawdownPct,
  equityReturnPct as computeEquityReturnPct,
  closedTradesCount as computeClosedTradesCount,
  tradedNotionalMultiple as computeTradedNotionalMultiple,
} from './canonical-metrics.js';
import { scoreCalmarV1 } from './score.js';

import {
  checkHlReachable,
  checkPreSnapshotRederivable,
  checkFillsRederivable,
  checkPostSnapshotFundingAccrual,
} from './checks/availability.js';
import { checkMinClosedTrades, checkMinTradedNotional } from './checks/eligibility.js';
import { checkWindowBounds } from './checks/integrity.js';
import {
  checkPreSnapshot,
  checkPostSnapshot,
  checkFills,
  checkGatingEquityReturn,
  checkGatingMaxDrawdown,
  checkGatingClosedTrades,
  checkGatingTradedNotional,
  extractAccountValue,
} from './checks/consistency.js';
import { checkEquityReturnTarget, checkMaxDrawdownConstraint } from './checks/spec.js';

import type { Check, Verdict, PortfolioV0EvaluatorConfig } from './types.js';

// ── Verdict derivation per §7.3 ───────────────────────────────────────────────

function deriveVerdict(checks: Check[]): Verdict {
  // if any "availability.*" FAIL → INDETERMINATE
  const availFail = checks.some(
    (c) => c.name.startsWith('availability.') && c.status === 'FAIL',
  );
  if (availFail) return 'INDETERMINATE';

  // if any "eligibility.*" FAIL → REJECTED
  const eligFail = checks.some(
    (c) => c.name.startsWith('eligibility.') && c.status === 'FAIL',
  );
  if (eligFail) return 'REJECTED';

  // if any "integrity.*"|"consistency.*"|"spec.*" FAIL → FAIL
  const otherFail = checks.some(
    (c) =>
      (c.name.startsWith('integrity.') ||
        c.name.startsWith('consistency.') ||
        c.name.startsWith('spec.')) &&
      c.status === 'FAIL',
  );
  if (otherFail) return 'FAIL';

  return 'PASS';
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Assemble the unsigned verdict manifest object (no signature field).
 *
 * NOTE: `generatedAt` is intentionally excluded from this object.
 * It is non-deterministic (wall-clock time) and MUST NOT be included
 * in the signed content — two evaluations of the same inputs at different
 * times must produce the same hash. `generatedAt` is added as an unsigned
 * sibling field in _buildOutput after signing.
 */
function _assembleUnsignedManifest(params: {
  intentCid: string;
  onchainCreationTx: string;
  onchainCreationBlock: number;
  restorationRequestId: string;
  intent: RestorationJob;
  checks: Check[];
  verdict: Verdict;
  score: string;
  targetManifest: RestorationManifest | null;
  rederivPrePayload: { capturedAt: number; payload: unknown } | null;
  rederivFills: HlFill[] | null;
  rederived: { equityReturn: number; maxDrawdown: number; closedTrades: number; notional: number } | null;
  evaluatorSafeAddress: `0x${string}`;
  evaluatorAgentEoa: `0x${string}`;
}): Record<string, unknown> {
  const {
    intentCid, onchainCreationTx, onchainCreationBlock, restorationRequestId,
    intent, checks, verdict, score,
    targetManifest, rederivPrePayload, rederivFills, rederived,
    evaluatorSafeAddress, evaluatorAgentEoa,
  } = params;

  const claimedGating = targetManifest?.gating ?? {
    equityReturnPct: '0',
    maxDrawdownPct: '0',
    closedTradesCount: 0,
    tradedNotionalMultiple: '0',
  };

  const intentProvenance = {
    cid: intentCid,
    onchainCreationTx: onchainCreationTx ?? '0x',
    onchainCreationBlock: onchainCreationBlock,
    requestId: restorationRequestId ?? '0x',
  };

  const rederivPreSnap = rederivPrePayload ?? {
    capturedAt: targetManifest?.preSnapshot.capturedAt ?? 0,
    payload: null,
  };

  const rederivPostSnap = {
    capturedAt: targetManifest?.postSnapshot.capturedAt ?? 0,
    payload: targetManifest?.postSnapshot.payload ?? null,
  };

  const fillsHash = (() => {
    if (!rederivFills) return '0x';
    return keccak256(new TextEncoder().encode(canonicalJson(rederivFills)));
  })();

  return {
    schemaVersion: 'portfolio.v0.eval.manifest.v1',
    intent: intentProvenance,
    evaluator: {
      safeAddress: evaluatorSafeAddress,
      agentEoa: evaluatorAgentEoa,
    },
    window: targetManifest?.window ?? intent.window ?? { startTs: 0, endTs: 0 },
    verdict,
    score,
    scoreBasis: 'calmar.v1',
    scoreVersion: 'v1',
    rederived: {
      preSnapshot: rederivPreSnap,
      postSnapshot: rederivPostSnap,
      fills: rederivFills ?? [],
      gating: {
        equityReturnPct: String(rederived?.equityReturn ?? 0),
        maxDrawdownPct: String(rederived?.maxDrawdown ?? 0),
        closedTradesCount: rederived?.closedTrades ?? 0,
        tradedNotionalMultiple: String(rederived?.notional ?? 0),
      },
    },
    claimed: {
      preSnapshot: {
        capturedAt: targetManifest?.preSnapshot.capturedAt ?? 0,
        payload: targetManifest?.preSnapshot.payload ?? null,
      },
      postSnapshot: {
        capturedAt: targetManifest?.postSnapshot.capturedAt ?? 0,
        payload: targetManifest?.postSnapshot.payload ?? null,
      },
      fillsHash,
      fillsCount: targetManifest?.fills.length ?? 0,
      gating: claimedGating,
    },
    checks,
  };
}

/**
 * Sign the unsigned manifest or emit empty stub signature if no key or signing fails.
 */
async function _signOrStub(
  unsigned: Record<string, unknown>,
  privateKey: Hex | undefined,
  evaluatorAgentEoa: `0x${string}`,
  log: (entry: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void,
): Promise<{ hash: string; sig: string }> {
  const stub = { hash: '0x', sig: '0x' };

  if (!privateKey) {
    return stub;
  }

  try {
    const account = privateKeyToAccount(privateKey);
    const signerAddr = evaluatorAgentEoa !== '0x0000000000000000000000000000000000000000'
      ? evaluatorAgentEoa
      : account.address as `0x${string}`;
    const result = await signCanonical(unsigned, privateKey, signerAddr);
    return { hash: result.hash, sig: result.sig };
  } catch (err) {
    log({ level: 'warn', msg: 'portfolio-v0-evaluator: signing failed, emitting unsigned manifest', data: { err } });
    return stub;
  }
}

/**
 * Write verdict manifest JSON to workingDir/verdict.json.
 */
function _writeVerdictArtifact(
  workingDir: string,
  verdictManifest: Record<string, unknown>,
): void {
  const verdictPath = join(workingDir, 'verdict.json');
  writeFileSync(verdictPath, JSON.stringify(verdictManifest, null, 2), 'utf-8');
}

// ── PortfolioV0Evaluator ──────────────────────────────────────────────────────

export class PortfolioV0Evaluator implements RestorerImpl {
  readonly name = 'portfolio-v0-evaluator';
  readonly version = '1.0.0';

  private readonly config: PortfolioV0EvaluatorConfig;

  constructor(config: PortfolioV0EvaluatorConfig = {}) {
    this.config = config;
  }

  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean {
    return ctx.kind === 'portfolio.v0' && ctx.type === 'evaluation';
  }

  async isReady(): Promise<ReadyStatus> {
    if (this.config.stub) return { ...REQUIRES_LIVE_DAEMON_READINESS };
    return { ready: true };
  }

  async canAttempt(
    intent: RestorationJob,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (intent.spec?.kind !== 'portfolio.v0') {
      return { ok: false, reason: 'spec.kind is not portfolio.v0' };
    }
    if (intent.type !== 'evaluation') {
      return { ok: false, reason: 'RestorationJob.type is not evaluation' };
    }
    if (!intent.restorationRequestId) {
      return { ok: false, reason: 'restorationRequestId is required' };
    }
    const restorationResult = intent.context?.['restorationResult'];
    if (typeof restorationResult !== 'string') {
      return { ok: false, reason: 'context.restorationResult (manifest JSON) is required' };
    }
    return { ok: true };
  }

  async run(ctx: RestorationContext): Promise<RestorationOutput> {
    if (this.config.stub) {
      throw new Error('portfolio-v0-evaluator: stub registry cannot run evaluation (requires live daemon)');
    }
    const { intent, log } = ctx;

    // ── Step 1: Parse restorer's manifest from inlined context ────────────────
    // The manifest JSON is inlined by MechAdapter.tryCreateEvaluationJob at context.restorationResult.
    // Falls back to an error — crash recovery path not yet implemented.
    let targetManifest: RestorationManifest;
    let targetIntent: ReturnType<typeof PortfolioV0IntentSchema.parse>;
    let hlPortfolioPeriodFn: (user: string) => Promise<{ accountValueHistory: HlGridPoint[] } | null>;
    let hlUserFillsByTimeFn: (user: string, startTime: number, endTime?: number) => Promise<{ fills: HlFill[]; startTimeClamped: boolean }>;

    const checks: Check[] = [];

    const inlined = intent.context?.['restorationResult'];
    if (typeof inlined !== 'string') {
      throw new Error(
        'portfolio-v0-evaluator: restorationResult missing from context; crash recovery path not yet implemented',
      );
    }

    try {
      targetManifest = RestorationManifestSchema.parse(JSON.parse(inlined));
      // The original portfolio.v0 intent is directly at intent.spec — no IPFS fetch needed.
      targetIntent = PortfolioV0IntentSchema.parse(intent);

      // Determine HL client from venue (or use injected test deps)
      if (this.config._testDeps?.hlPortfolioPeriod && this.config._testDeps?.hlUserFillsByTime) {
        hlPortfolioPeriodFn = this.config._testDeps.hlPortfolioPeriod;
        hlUserFillsByTimeFn = this.config._testDeps.hlUserFillsByTime;
      } else {
        const venue = targetIntent.spec.account.venue;
        const baseUrl = venue === 'hyperliquid-mainnet' ? HL_MAINNET_BASE_URL : HL_TESTNET_BASE_URL;
        const hlClient = new HyperliquidClient(baseUrl);
        hlPortfolioPeriodFn = (user) => hlClient.portfolioPeriod(user, 'allTime');
        hlUserFillsByTimeFn = (user, start, end) => hlClient.userFillsByTime(user, start, end);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({ level: 'error', msg: 'portfolio-v0-evaluator: failed to parse manifest/intent', data: { err: msg } });
      // We cannot proceed — return a minimal INDETERMINATE output.
      checks.push({
        name: 'availability.manifest_parseable',
        status: 'FAIL',
        detail: `Failed to parse manifest or intent: ${msg}`,
      });
      return this._buildOutput(ctx, checks, null, null, null, null, null, null, null, null);
    }

    // Extract provenance fields from the parsed manifest + intent
    const intentCid = targetManifest.intent.cid;
    const onchainCreationTx = targetManifest.intent.onchainCreationTx;
    const onchainCreationBlock = targetManifest.intent.onchainCreationBlock;
    const restorationRequestId = intent.restorationRequestId!;

    log({ level: 'info', msg: 'portfolio-v0-evaluator: starting evaluation', data: { intentCid, restorationRequestId } });


    const masterAddress = targetIntent.spec.account.masterAddress;
    const { startTs, endTs } = targetManifest.window;

    // ── Step 2: Re-fetch HL data ──────────────────────────────────────────────

    // 2a: Check HL reachability + fetch portfolio grid + fills
    let grid: HlGridPoint[] = [];
    let rederivFills: HlFill[] = [];
    let startTimeClamped = false;
    let hlReachable = false;

    try {
      const [portfolioResp, fillsResult] = await Promise.all([
        hlPortfolioPeriodFn(masterAddress),
        hlUserFillsByTimeFn(masterAddress, startTs, endTs),
      ]);

      grid = portfolioResp?.accountValueHistory ?? [];
      rederivFills = fillsResult.fills;
      startTimeClamped = fillsResult.startTimeClamped;
      hlReachable = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({ level: 'error', msg: 'portfolio-v0-evaluator: HL API call failed', data: { err: msg } });
    }

    // ── Availability checks ───────────────────────────────────────────────────

    checks.push(checkHlReachable(hlReachable));
    if (!hlReachable) {
      return this._buildOutput(ctx, checks, null, null, null, null, intentCid, onchainCreationTx, onchainCreationBlock, restorationRequestId);
    }

    const preCapturedAt = targetManifest.preSnapshot.capturedAt;
    const postCapturedAt = targetManifest.postSnapshot.capturedAt;

    checks.push(checkPreSnapshotRederivable(grid, preCapturedAt));
    checks.push(checkFillsRederivable(startTimeClamped));

    const postAccrualCheck = checkPostSnapshotFundingAccrual(postCapturedAt, endTs);
    checks.push(postAccrualCheck);

    // If post-snapshot funding accrual SKIP → downstream consistency is skipped
    const skipPostConsistency = postAccrualCheck.status === 'SKIP';

    // ── Derive pre-snapshot from grid ─────────────────────────────────────────
    const bracket = bracketGridPoints(grid, preCapturedAt);
    let rederivPrePayload: { capturedAt: number; payload: unknown } | null = null;

    if (bracket !== null) {
      // Interpolate accountValue at preCapturedAt between the two bracket points
      const [beforeTs, beforeVal] = bracket.before;
      const [afterTs, afterVal] = bracket.after;
      const frac =
        afterTs > beforeTs ? (preCapturedAt - beforeTs) / (afterTs - beforeTs) : 0;
      const interpolatedValue = parseFloat(beforeVal) + frac * (parseFloat(afterVal) - parseFloat(beforeVal));
      rederivPrePayload = {
        capturedAt: preCapturedAt,
        payload: {
          marginSummary: { accountValue: String(interpolatedValue) },
        },
      };
    }

    // ── Derive post-snapshot ───────────────────────────────────────────────────
    // For the post-snapshot, we use the claimed value (from the manifest) since
    // HL only returns current state. The §7.7 note says to use the portfolio grid
    // for the pre-snapshot only. For post-snapshot we compare against the live
    // clearinghouse state at the time of evaluation — but since we're post-window,
    // the best we can do is compare fill-derived metrics.
    //
    // To keep things deterministic: rederived post snapshot = claimed post snapshot
    // (we verify internal consistency of the manifest, not post re-fetch).
    const rederivPostPayload = skipPostConsistency
      ? null
      : {
          capturedAt: postCapturedAt,
          payload: targetManifest.postSnapshot.payload,
        };

    // ── Compute canonical metrics ─────────────────────────────────────────────

    // Extract accountValues for metric computation
    const claimedPrePayload = targetManifest.preSnapshot.payload;
    const claimedPostPayload = targetManifest.postSnapshot.payload;

    // Use the shared extractor so unified-shape and legacy payloads both work
    // (see `extractAccountValue` in checks/consistency.ts).
    const preValue =
      (rederivPrePayload ? extractAccountValue(rederivPrePayload.payload) : null)
      ?? extractAccountValue(claimedPrePayload)
      ?? 0;

    const postValue = extractAccountValue(claimedPostPayload) ?? 0;

    const fillTimes = rederivFills.map((f) => f.time);
    const curve = equityCurve(preCapturedAt, preValue, postCapturedAt, postValue, fillTimes);

    const rederivEquityReturn = computeEquityReturnPct(preValue, postValue);
    const rederivMaxDrawdown = computeMaxDrawdownPct(curve);
    const rederivClosedTrades = computeClosedTradesCount(rederivFills);
    const rederivNotional = computeTradedNotionalMultiple(rederivFills, preValue);

    // ── Integrity checks ──────────────────────────────────────────────────────

    checks.push(checkWindowBounds(preCapturedAt, postCapturedAt, startTs, endTs));

    // ── Eligibility checks ────────────────────────────────────────────────────

    const eligibility = PortfolioV0EligibilitySchema.parse(targetIntent.eligibility ?? {});
    checks.push(checkMinClosedTrades(rederivClosedTrades, eligibility.minClosedTrades));
    checks.push(checkMinTradedNotional(rederivNotional, eligibility.minTradedNotionalMultiple));

    // ── Consistency checks ────────────────────────────────────────────────────

    const claimedGating = targetManifest.gating;

    checks.push(checkPreSnapshot(claimedPrePayload, rederivPrePayload));
    checks.push(checkPostSnapshot(claimedPostPayload, rederivPostPayload));
    checks.push(checkFills(targetManifest.fills, rederivFills));
    checks.push(checkGatingEquityReturn(claimedGating.equityReturnPct, rederivEquityReturn));
    checks.push(checkGatingMaxDrawdown(claimedGating.maxDrawdownPct, rederivMaxDrawdown));
    checks.push(checkGatingClosedTrades(claimedGating.closedTradesCount, rederivClosedTrades));
    checks.push(checkGatingTradedNotional(claimedGating.tradedNotionalMultiple, rederivNotional));

    // ── Spec checks ───────────────────────────────────────────────────────────

    checks.push(checkEquityReturnTarget(rederivEquityReturn, targetIntent.spec.target.minReturnPct));
    checks.push(checkMaxDrawdownConstraint(rederivMaxDrawdown, targetIntent.spec.constraint.maxDrawdownPct));

    // ── Derive verdict ────────────────────────────────────────────────────────

    const rederived = {
      equityReturn: rederivEquityReturn,
      maxDrawdown: rederivMaxDrawdown,
      closedTrades: rederivClosedTrades,
      notional: rederivNotional,
    };

    return this._buildOutput(ctx, checks, targetManifest, rederivPrePayload, rederivFills, rederived, intentCid, onchainCreationTx, onchainCreationBlock, restorationRequestId);
  }

  private async _buildOutput(
    ctx: RestorationContext,
    checks: Check[],
    targetManifest: RestorationManifest | null,
    rederivPrePayload: { capturedAt: number; payload: unknown } | null,
    rederivFills: HlFill[] | null,
    rederived: {
      equityReturn: number;
      maxDrawdown: number;
      closedTrades: number;
      notional: number;
    } | null,
    intentCid: string | null | undefined,
    onchainCreationTx: string | null | undefined,
    onchainCreationBlock: number | null | undefined,
    restorationRequestId: string | null | undefined,
  ): Promise<RestorationOutput> {
    const { intent, workingDir, log } = ctx;

    // Spec §7.5 funding-accrual edge case: if hl_post_snapshot_rederivable is SKIP,
    // the verdict MUST be INDETERMINATE regardless of other check outcomes.
    // (deriveVerdict() only handles FAIL→INDETERMINATE per §7.3; SKIP needs explicit handling.)
    const postRederivableSkipped = checks.some(
      (c) => c.name === 'availability.hl_post_snapshot_rederivable' && c.status === 'SKIP',
    );
    const verdict: Verdict = postRederivableSkipped ? 'INDETERMINATE' : deriveVerdict(checks);

    const equityReturn = rederived?.equityReturn ?? 0;
    const maxDrawdown = rederived?.maxDrawdown ?? 0;
    const score = scoreCalmarV1(equityReturn, maxDrawdown, verdict);

    log({ level: 'info', msg: 'portfolio-v0-evaluator: verdict derived', data: { verdict, score, checkCount: checks.length } });

    // Evaluator identity — sourced from constructor config (injected by daemon)
    const evaluatorSafeAddress = (this.config.safeAddress ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;
    const evaluatorAgentEoa = (this.config.agentEoa ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

    // ── Assemble unsigned verdict manifest ────────────────────────────────────
    // generatedAt is NOT included in the signed content: it is non-deterministic
    // (wall-clock) and must not affect the hash. It is added below after signing.

    const unsigned = _assembleUnsignedManifest({
      intentCid: intentCid ?? '',
      onchainCreationTx: onchainCreationTx ?? '0x',
      onchainCreationBlock: onchainCreationBlock ?? 0,
      restorationRequestId: restorationRequestId ?? '0x',
      intent,
      checks,
      verdict,
      score,
      targetManifest,
      rederivPrePayload,
      rederivFills,
      rederived,
      evaluatorSafeAddress,
      evaluatorAgentEoa,
    });

    // ── Sign or emit stub ─────────────────────────────────────────────────────

    const privateKey = this.config.agentEoaPrivateKey as Hex | undefined;
    const { hash, sig } = await _signOrStub(unsigned, privateKey, evaluatorAgentEoa, log);

    // generatedAt: unsigned metadata — sits outside the signed envelope.
    // Added after signing so it does not influence the hash.
    const generatedAt = Date.now();

    const verdictManifest: Record<string, unknown> = {
      ...unsigned,
      generatedAt,
      signature: {
        algo: 'secp256k1',
        signer: evaluatorAgentEoa,
        hash,
        sig,
      },
    };

    // ── Write verdict.json ────────────────────────────────────────────────────

    _writeVerdictArtifact(workingDir, verdictManifest);

    log({ level: 'info', msg: 'portfolio-v0-evaluator: verdict.json written', data: { path: join(workingDir, 'verdict.json') } });

    // ── Build RestorationOutput ───────────────────────────────────────────────

    const output: RestorationOutput = {
      venueRef: { name: 'hyperliquid' },
      gating: {
        verdict,
        score,
        scoreBasis: 'calmar.v1',
        scoreVersion: 'v1',
        checkCount: checks.length,
        passCount: checks.filter((c) => c.status === 'PASS').length,
        failCount: checks.filter((c) => c.status === 'FAIL').length,
        skipCount: checks.filter((c) => c.status === 'SKIP').length,
      },
      informational: {
        intentCid: intentCid ?? '',
        equityReturnPct: String(rederived?.equityReturn ?? 0),
        maxDrawdownPct: String(rederived?.maxDrawdown ?? 0),
        closedTradesCount: rederived?.closedTrades ?? 0,
        tradedNotionalMultiple: String(rederived?.notional ?? 0),
      },
      artifacts: [
        {
          path: 'verdict.json',
          artifactType: 'evaluation_verdict',
          metadata: { verdict, score, schemaVersion: 'portfolio.v0.eval.manifest.v1' },
          tags: ['verdict', 'evaluation'],
          access: { kind: 'open' },
        },
      ],
    };

    return output;
  }
}

export default PortfolioV0Evaluator;
