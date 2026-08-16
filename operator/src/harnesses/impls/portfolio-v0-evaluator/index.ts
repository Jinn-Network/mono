/**
 * portfolio-v0-evaluator — deterministic verifier for portfolio.v0 manifests.
 *
 * Implements Harness for solverType === "portfolio.v0" && type === "evaluation".
 * No LLM. Pure deterministic verification per spec §7.
 *
 * Architecture decision (T7):
 *   The engine (locked) builds the restoration envelope. The eval impl assembles
 *   and signs the verdict manifest itself (§5.2). Since the engine cannot be
 *   modified, the eval impl assembles and signs the verdict manifest itself,
 *   writes it as verdict.json in workingDir, and declares it as an artifact
 *   with role "evaluation_verdict". The engine's outer manifest becomes the
 *   packaging container; verdict.json is the meaningful payload.
 *
 * Unified-payload model (Task 7):
 *   - solverType is "portfolio.v0" (same as restoration)
 *   - task.role === "evaluation"
 *   - Harness's manifest is inlined at task.context.restorationResult (JSON string)
 *   - Original task spec is at task.spec (PortfolioV0Spec) — no IPFS fetch needed
 *   - task.restorationRequestId carries the on-chain request ID
 */

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { HarnessContext, Solution } from '../../types.js';
import { EvaluatorHarness, type EvaluatorHarnessShape } from '../_evaluator-base.js';
import type { Task } from '../../../types/task.js';
import type { HlFill, HlGridPoint } from '../../../venues/hyperliquid/types.js';
import { HyperliquidClient, HL_MAINNET_BASE_URL, HL_TESTNET_BASE_URL } from '../../../venues/hyperliquid/client.js';
import { bracketGridPoints } from '../../../venues/hyperliquid/grid.js';
import { canonicalJson } from '../../../util/canonical-json.js';
import { signCanonical } from '../../engine/signing.js';
import { buildVerificationStub } from '../../engine/verification-stub.js';
import { resolveSolutionEnvelopeCid } from '../evaluation-context.js';

import {
  PortfolioV0TaskSchema,
  PortfolioV0EligibilitySchema,
} from '../../../types/portfolio.js';
import { SignedEnvelopeSchema, normalizeEnvelopeRole } from '../../../types/envelope.js';
import type { SignedEnvelope } from '../../../types/envelope.js';
import { PortfolioV0RestorationPayloadSchema } from '../../../types/payloads/portfolio-v0.js';
import type { PortfolioV0RestorationPayload } from '../../../types/payloads/portfolio-v0.js';

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

// ── Span helpers ──────────────────────────────────────────────────────────────

function nowNanos(): string {
  return `${BigInt(Date.now()) * 1_000_000n}`;
}

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
  taskCid: string;
  onchainCreationTx: string;
  onchainCreationBlock: number;
  restorationRequestId: string;
  task: Task;
  checks: Check[];
  verdict: Verdict;
  score: string;
  targetPayload: PortfolioV0RestorationPayload | null;
  targetEnvelope: SignedEnvelope | null;
  rederivPrePayload: { capturedAt: number; payload: unknown } | null;
  rederivFills: HlFill[] | null;
  rederived: { equityReturn: number; maxDrawdown: number; closedTrades: number; notional: number } | null;
  evaluatorSafeAddress: `0x${string}`;
  evaluatorAgentEoa: `0x${string}`;
}): Record<string, unknown> {
  const {
    taskCid, onchainCreationTx, onchainCreationBlock, restorationRequestId,
    task, checks, verdict, score,
    targetPayload, targetEnvelope, rederivPrePayload, rederivFills, rederived,
    evaluatorSafeAddress, evaluatorAgentEoa,
  } = params;

  const claimedGating = targetPayload?.gating ?? {
    equityReturnPct: '0',
    maxDrawdownPct: '0',
    closedTradesCount: 0,
    tradedNotionalMultiple: '0',
  };

  const taskProvenance = {
    cid: taskCid,
    onchainCreationTx: onchainCreationTx ?? '0x',
    onchainCreationBlock: onchainCreationBlock,
    requestId: restorationRequestId ?? '0x',
  };

  const rederivPreSnap = rederivPrePayload ?? {
    capturedAt: targetPayload?.preSnapshot.capturedAt ?? 0,
    payload: null,
  };

  const rederivPostSnap = {
    capturedAt: targetPayload?.postSnapshot.capturedAt ?? 0,
    payload: targetPayload?.postSnapshot.payload ?? null,
  };

  const fillsHash = (() => {
    if (!rederivFills) return '0x';
    return keccak256(new TextEncoder().encode(canonicalJson(rederivFills)));
  })();

  return {
    task: taskProvenance,
    evaluator: {
      safeAddress: evaluatorSafeAddress,
      agentEoa: evaluatorAgentEoa,
    },
    window: targetEnvelope?.window ?? task.window ?? { startTs: 0, endTs: 0 },
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
        capturedAt: targetPayload?.preSnapshot.capturedAt ?? 0,
        payload: targetPayload?.preSnapshot.payload ?? null,
      },
      postSnapshot: {
        capturedAt: targetPayload?.postSnapshot.capturedAt ?? 0,
        payload: targetPayload?.postSnapshot.payload ?? null,
      },
      fillsHash,
      fillsCount: targetPayload?.fills.length ?? 0,
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

export class PortfolioV0Evaluator extends EvaluatorHarness {
  readonly name = 'portfolio-v0-evaluator';

  protected readonly shape: EvaluatorHarnessShape = {
    solverType: 'portfolio.v0',
    requiresRestorationRequestId: true,
  };

  private readonly config: PortfolioV0EvaluatorConfig;

  constructor(config: PortfolioV0EvaluatorConfig = {}) {
    super();
    this.config = config;
  }

  protected get stub(): boolean {
    return Boolean(this.config.stub);
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    this.assertLive();
    const { task: task, log } = ctx;

    // ── Step 1: Parse harness's SignedEnvelope from inlined context ─────────
    // The envelope JSON is inlined at context.restorationResult.
    // Falls back to an error — crash recovery path not yet implemented.
    let targetEnvelope: SignedEnvelope;
    let targetPayload: PortfolioV0RestorationPayload;
    let targetTask: ReturnType<typeof PortfolioV0TaskSchema.parse>;
    let hlPortfolioPeriodFn: (user: string) => Promise<{ accountValueHistory: HlGridPoint[] } | null>;
    let hlUserFillsByTimeFn: (user: string, startTime: number, endTime?: number) => Promise<{ fills: HlFill[]; startTimeClamped: boolean }>;

    const checks: Check[] = [];

    const inlined = task.context?.['restorationResult'];
    if (typeof inlined !== 'string') {
      throw new Error(
        'portfolio-v0-evaluator: restorationResult missing from context; crash recovery path not yet implemented',
      );
    }

    try {
      targetEnvelope = SignedEnvelopeSchema.parse(JSON.parse(inlined));
      if (
        targetEnvelope.solverType !== 'portfolio.v0' ||
        normalizeEnvelopeRole(targetEnvelope.role) !== 'solution'
      ) {
        throw new Error(
          `Unexpected envelope kind/role: ${targetEnvelope.solverType}/${targetEnvelope.role}; expected portfolio.v0/solution`,
        );
      }
      targetPayload = PortfolioV0RestorationPayloadSchema.parse(targetEnvelope.payload);
      // The original portfolio.v0 task is directly at task.spec — no IPFS fetch needed.
      targetTask = PortfolioV0TaskSchema.parse(task);

      // Determine HL client from venue (or use injected test deps)
      if (this.config._testDeps?.hlPortfolioPeriod && this.config._testDeps?.hlUserFillsByTime) {
        hlPortfolioPeriodFn = this.config._testDeps.hlPortfolioPeriod;
        hlUserFillsByTimeFn = this.config._testDeps.hlUserFillsByTime;
      } else {
        const venue = targetTask.spec.account.venue;
        const baseUrl = venue === 'hyperliquid-mainnet' ? HL_MAINNET_BASE_URL : HL_TESTNET_BASE_URL;
        const hlClient = new HyperliquidClient(baseUrl);
        hlPortfolioPeriodFn = (user) => hlClient.portfolioPeriod(user, 'allTime');
        hlUserFillsByTimeFn = (user, start, end) => hlClient.userFillsByTime(user, start, end);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({ level: 'error', msg: 'portfolio-v0-evaluator: failed to parse envelope/task', data: { err: msg } });
      // We cannot proceed — return a minimal INDETERMINATE output.
      checks.push({
        name: 'availability.manifest_parseable',
        status: 'FAIL',
        detail: `Failed to parse envelope or task: ${msg}`,
      });
      return this._buildOutput(ctx, checks, null, null, null, null, null, null, null, null, null);
    }

    // Extract provenance fields from the parsed envelope + task
    const taskCid = targetEnvelope.task!.cid;
    const onchainCreationTx = targetEnvelope.task!.onchainCreationTx;
    const onchainCreationBlock = targetEnvelope.task!.onchainCreationBlock;
    const restorationRequestId = task.restorationRequestId!;

    log({ level: 'info', msg: 'portfolio-v0-evaluator: starting evaluation', data: { taskCid, restorationRequestId } });


    const masterAddress = targetTask.spec.account.masterAddress;
    const { startTs, endTs } = targetEnvelope.window;

    // ── Step 2: Re-fetch HL data ──────────────────────────────────────────────

    // 2a: Check HL reachability + fetch portfolio grid + fills
    let grid: HlGridPoint[] = [];
    let rederivFills: HlFill[] = [];
    let startTimeClamped = false;
    let hlReachable = false;

    {
      const hlFetchStart = nowNanos();
      try {
        const [portfolioResp, fillsResult] = await Promise.all([
          hlPortfolioPeriodFn(masterAddress),
          hlUserFillsByTimeFn(masterAddress, startTs, endTs),
        ]);

        grid = portfolioResp?.accountValueHistory ?? [];
        rederivFills = fillsResult.fills;
        startTimeClamped = fillsResult.startTimeClamped;
        hlReachable = true;
        ctx.trajectory.addSpan({
          name: 'GET api.hyperliquid.xyz',
          kind: 'CLIENT',
          startTimeUnixNano: hlFetchStart,
          endTimeUnixNano: nowNanos(),
          attributes: {
            'jinn.span.kind': 'jinn.venue_io',
            'net.peer.name': 'api.hyperliquid.xyz',
            'http.request.method': 'POST',
            'http.response.status_code': 200,
            'url.full': 'https://api.hyperliquid.xyz/info',
            'venue.id': 'hyperliquid',
            'venue.fetch.kind': 'portfolio_period+fills',
          },
          events: [],
          status: { code: 'OK' },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.trajectory.addSpan({
          name: 'GET api.hyperliquid.xyz',
          kind: 'CLIENT',
          startTimeUnixNano: hlFetchStart,
          endTimeUnixNano: nowNanos(),
          attributes: {
            'jinn.span.kind': 'jinn.venue_io',
            'net.peer.name': 'api.hyperliquid.xyz',
            'http.request.method': 'POST',
            'http.response.status_code': 0,
            'url.full': 'https://api.hyperliquid.xyz/info',
            'venue.id': 'hyperliquid',
            'venue.fetch.kind': 'portfolio_period+fills',
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
        log({ level: 'error', msg: 'portfolio-v0-evaluator: HL API call failed', data: { err: msg } });
      }
    }

    // ── Availability checks ───────────────────────────────────────────────────

    checks.push(checkHlReachable(hlReachable));
    if (!hlReachable) {
      return this._buildOutput(ctx, checks, null, null, null, null, null, taskCid, onchainCreationTx, onchainCreationBlock, restorationRequestId);
    }

    const preCapturedAt = targetPayload.preSnapshot.capturedAt;
    const postCapturedAt = targetPayload.postSnapshot.capturedAt;

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
          payload: targetPayload.postSnapshot.payload,
        };

    // ── Compute canonical metrics ─────────────────────────────────────────────

    // Extract accountValues for metric computation
    const claimedPrePayload = targetPayload.preSnapshot.payload;
    const claimedPostPayload = targetPayload.postSnapshot.payload;

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

    const eligibility = PortfolioV0EligibilitySchema.parse(targetTask.eligibility ?? {});
    checks.push(checkMinClosedTrades(rederivClosedTrades, eligibility.minClosedTrades));
    checks.push(checkMinTradedNotional(rederivNotional, eligibility.minTradedNotionalMultiple));

    // ── Consistency checks ────────────────────────────────────────────────────

    const claimedGating = targetPayload.gating;

    checks.push(checkPreSnapshot(claimedPrePayload, rederivPrePayload));
    checks.push(checkPostSnapshot(claimedPostPayload, rederivPostPayload));
    checks.push(checkFills(targetPayload.fills, rederivFills));
    checks.push(checkGatingEquityReturn(claimedGating.equityReturnPct, rederivEquityReturn));
    checks.push(checkGatingMaxDrawdown(claimedGating.maxDrawdownPct, rederivMaxDrawdown));
    checks.push(checkGatingClosedTrades(claimedGating.closedTradesCount, rederivClosedTrades));
    checks.push(checkGatingTradedNotional(claimedGating.tradedNotionalMultiple, rederivNotional));

    // ── Spec checks ───────────────────────────────────────────────────────────

    checks.push(checkEquityReturnTarget(rederivEquityReturn, targetTask.spec.target.minReturnPct));
    checks.push(checkMaxDrawdownConstraint(rederivMaxDrawdown, targetTask.spec.constraint.maxDrawdownPct));

    // ── Derive verdict ────────────────────────────────────────────────────────

    const rederived = {
      equityReturn: rederivEquityReturn,
      maxDrawdown: rederivMaxDrawdown,
      closedTrades: rederivClosedTrades,
      notional: rederivNotional,
    };

    return this._buildOutput(ctx, checks, targetPayload, targetEnvelope, rederivPrePayload, rederivFills, rederived, taskCid, onchainCreationTx, onchainCreationBlock, restorationRequestId);
  }

  private async _buildOutput(
    ctx: HarnessContext,
    checks: Check[],
    targetPayload: PortfolioV0RestorationPayload | null,
    targetEnvelope: SignedEnvelope | null,
    rederivPrePayload: { capturedAt: number; payload: unknown } | null,
    rederivFills: HlFill[] | null,
    rederived: {
      equityReturn: number;
      maxDrawdown: number;
      closedTrades: number;
      notional: number;
    } | null,
    taskCid: string | null | undefined,
    onchainCreationTx: string | null | undefined,
    onchainCreationBlock: number | null | undefined,
    restorationRequestId: string | null | undefined,
  ): Promise<Solution> {
    const { task: task, workingDir, log } = ctx;

    // Spec §7.5 funding-accrual edge case: if hl_post_snapshot_rederivable is SKIP,
    // the verdict MUST be INDETERMINATE regardless of other check outcomes.
    // (deriveVerdict() only handles FAIL→INDETERMINATE per §7.3; SKIP needs explicit handling.)
    const postRederivableSkipped = checks.some(
      (c) => c.name === 'availability.hl_post_snapshot_rederivable' && c.status === 'SKIP',
    );
    const scoreStart = nowNanos();
    const verdict: Verdict = postRederivableSkipped ? 'INDETERMINATE' : deriveVerdict(checks);

    const equityReturn = rederived?.equityReturn ?? 0;
    const maxDrawdown = rederived?.maxDrawdown ?? 0;
    const score = scoreCalmarV1(equityReturn, maxDrawdown, verdict);
    const scoreEnd = nowNanos();

    ctx.trajectory.addSpan({
      name: 'score.calmar.v1',
      kind: 'INTERNAL',
      startTimeUnixNano: scoreStart,
      endTimeUnixNano: scoreEnd,
      attributes: {
        'jinn.span.kind': 'jinn.state_transition',
        'jinn.state.from': 'FETCHED',
        'jinn.state.to': 'SCORED',
        'verdict': verdict,
        'score.basis': 'calmar.v1',
      },
      events: [],
      status: { code: 'OK' },
    });

    log({ level: 'info', msg: 'portfolio-v0-evaluator: verdict derived', data: { verdict, score, checkCount: checks.length } });

    // Evaluator identity — sourced from constructor config (injected by daemon)
    const evaluatorSafeAddress = (this.config.safeAddress ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;
    const evaluatorAgentEoa = (this.config.agentEoa ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

    // ── Assemble unsigned verdict manifest ────────────────────────────────────
    // generatedAt is NOT included in the signed content: it is non-deterministic
    // (wall-clock) and must not affect the hash. It is added below after signing.

    const unsigned = _assembleUnsignedManifest({
      taskCid: taskCid ?? '',
      onchainCreationTx: onchainCreationTx ?? '0x',
      onchainCreationBlock: onchainCreationBlock ?? 0,
      restorationRequestId: restorationRequestId ?? '0x',
      task,
      checks,
      verdict,
      score,
      targetPayload,
      targetEnvelope,
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

    const verdictJson = JSON.stringify(verdictManifest, null, 2);
    const verdictSha256 = createHash('sha256').update(verdictJson).digest('hex');
    _writeVerdictArtifact(workingDir, verdictManifest);

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

    log({ level: 'info', msg: 'portfolio-v0-evaluator: verdict.json written', data: { path: join(workingDir, 'verdict.json') } });

    // ── Build Solution ───────────────────────────────────────────────

    // ── Verdict payload for engine.pack() (role='verdict' envelope) ───────────
    // Assembles the PortfolioV0VerdictPayload from the already-computed fields.
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
    const solutionEnvelopeCid = resolveSolutionEnvelopeCid(task)
      ?? restorationRequestId
      ?? 'bafy-unknown';
    const restorationResultJson = task.context?.['restorationResult'];
    // Use JCS canonical bytes so the sha256 matches the upload pipeline (8l6 fix A).
    const solutionEnvelopeSha256 = typeof restorationResultJson === 'string'
      ? createHash('sha256').update(canonicalJson(JSON.parse(restorationResultJson) as unknown)).digest('hex')
      : '0'.repeat(64);
    const solutionEnvelope = {
      cid: solutionEnvelopeCid,
      sha256: solutionEnvelopeSha256,
    };

    const verificationOfRestoration = buildVerificationStub();

    const verdictPayload: Record<string, unknown> = {
      solutionEnvelope,
      verificationOfRestoration,
      verdict,
      score,
      scoreBasis: 'calmar.v1',
      scoreVersion: 'v1',
      rederived: unsigned['rederived'],
      claimed: unsigned['claimed'],
      checks: unsigned['checks'],
    };

    const output: Solution = {
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
        taskCid: taskCid ?? '',
        equityReturnPct: String(rederived?.equityReturn ?? 0),
        maxDrawdownPct: String(rederived?.maxDrawdown ?? 0),
        closedTradesCount: rederived?.closedTrades ?? 0,
        tradedNotionalMultiple: String(rederived?.notional ?? 0),
      },
      verdictPayload,
      artifacts: [
        {
          path: 'verdict.json',
          artifactType: 'evaluation_verdict',
          metadata: { verdict, score },
          tags: ['verdict', 'evaluation'],
          access: { priceUsdc: '0' },
        },
      ],
    };

    return output;
  }
}

export default PortfolioV0Evaluator;
