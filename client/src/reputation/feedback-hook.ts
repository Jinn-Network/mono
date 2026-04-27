/**
 * Evaluator-delivery → ReputationRegistry feedback hook.
 *
 * Per DR §4.3: after the evaluator's `claimDelivery` succeeds, the evaluator
 * SHOULD call `ReputationRegistry.giveFeedback(restorerAgentId, ...)` with a
 * body referencing the specific manifest CID + evidenceHash.
 *
 * Failure to call `giveFeedback` is **logged but not fatal** — the on-chain
 * `claimDelivery` is the authoritative settlement. This module deliberately
 * swallows expected reverts (self-feedback, missing agent NFT) and surfaces
 * anything else as a warning so a flaky reputation surface never blocks
 * delivery.
 *
 * ── Restorer-agentId resolution ─────────────────────────────────────────────
 *
 * Resolving the restorer's `agentId` from the evaluator's perspective is the
 * trickiest sub-problem (DR §4.3). Per the bead RFC, this is **deferred** to
 * a follow-up bd task; the hook here takes `restorerAgentId` as a direct
 * input. Two natural resolution paths once we wire the engine:
 *
 *   (b) subgraph query: `Operator { agentId } where executions_some: { manifestHash: <evidenceHash> }`
 *   (c) on-chain scan of `IdentityRegistry.Registered` events for the
 *       restorer's Safe (`getAgentByWallet` is not exposed on-chain).
 *
 * Subgraph (b) is the cheapest and aligns with the rest of the discovery
 * surface; (c) is the fallback when the subgraph is unavailable. The hook
 * itself is independent of the resolver, and that separation keeps this
 * module testable today.
 *
 * ── Score-mapping policy ─────────────────────────────────────────────────────
 *
 * The portfolio.v0 evaluator emits a `verdict ∈ {PASS, FAIL, INDETERMINATE,
 * REJECTED}` plus a numeric Calmar score (string). The reputation registry
 * takes a signed fixed-point. The mapping policy below is intentionally
 * conservative:
 *
 *   - PASS         → score = 100, scoreDecimals = 2 (= 1.00)  → submit feedback.
 *   - FAIL         → score =   0, scoreDecimals = 2 (= 0.00)  → submit feedback.
 *   - REJECTED     → no feedback. The restorer was not eligible to attempt
 *                    this intent (e.g. minClosedTrades unmet); a 0-score
 *                    feedback would unfairly tarnish their reputation for a
 *                    structural mismatch, not a quality failure.
 *   - INDETERMINATE → no feedback. The evaluator could not rederive
 *                    (HL unreachable, post-snapshot funding accrual not
 *                    settled). Not a verdict on the restorer.
 *
 * If the impl emits a numeric score in `[0, 1]` separate from verdict, the
 * caller should pre-multiply it by 100 and pass `scoreDecimals=2`.
 */

import type { Hex } from 'viem';
import type { ReputationRegistryClient, GiveFeedbackArgs } from './registry.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** Restorer-side outputs the hook needs to anchor the feedback on chain. */
export interface RestorerExecutionRef {
  /** ERC-8004 agentId of the restorer being reviewed. */
  restorerAgentId: bigint;
  /** IPFS CID of the restorer's manifest (NOT the evaluator's verdict). */
  restorerManifestCid: string;
  /** keccak256 of the restorer's signed manifest = evidenceHash on JinnRouter. */
  restorerEvidenceHash: Hex;
}

/** Verdict-side output of the evaluator. */
export interface EvaluatorVerdict {
  verdict: 'PASS' | 'FAIL' | 'INDETERMINATE' | 'REJECTED';
  /**
   * Optional spec-kind label (e.g. `"portfolio.v0"`). Emitted as `tag1` so
   * downstream subgraphs can filter feedback by execution kind cheaply
   * (`tag1` is indexed on the `NewFeedback` event).
   */
  kind?: string;
  /**
   * Optional opaque tag2 — reserved for future use (e.g. evaluator software
   * version). Default empty.
   */
  tag2?: string;
}

/** Mapped score input to `giveFeedback`. `null` means "do not submit". */
export interface ScoreMapping {
  score: number;
  scoreDecimals: number;
}

/**
 * Outcome of `submitEvaluatorFeedback`. The hook is fire-and-forget from the
 * caller's perspective; this return type is for tests and observability.
 */
export type FeedbackHookOutcome =
  | { kind: 'submitted'; txHash: Hex }
  | { kind: 'skipped'; reason: 'verdict-not-eligible' | 'self-feedback' | 'agent-not-found' }
  | { kind: 'failed'; error: string };

// ── Score mapping ───────────────────────────────────────────────────────────

/**
 * Pure function: map a verdict to (score, scoreDecimals). Returns `null` for
 * verdicts that should not produce on-chain feedback (REJECTED, INDETERMINATE)
 * — see policy comment at the top of the module.
 *
 * Exported so tests pin the policy directly.
 */
export function mapVerdictToScore(verdict: EvaluatorVerdict['verdict']): ScoreMapping | null {
  switch (verdict) {
    case 'PASS':
      // 1.00 — full pass.
      return { score: 100, scoreDecimals: 2 };
    case 'FAIL':
      // 0.00 — quality failure; tarnishes the operator's reputation.
      return { score: 0, scoreDecimals: 2 };
    case 'REJECTED':
    case 'INDETERMINATE':
      // No feedback — see top-of-module policy comment.
      return null;
    default: {
      // Defensive: unrecognised verdict → no feedback. Future verdicts that
      // should emit feedback need an explicit case here; defaulting to "no
      // feedback" is the safe path so we never silently apply a wrong score.
      const exhaustive: never = verdict;
      void exhaustive;
      return null;
    }
  }
}

// ── Hook ────────────────────────────────────────────────────────────────────

/**
 * Submit feedback on the restorer's agent NFT. The body is the canonical
 * `manifest:<cid>` URI + `evidenceHash` — the subgraph parses these to
 * synthesize an `Execution` row joined to the operator.
 *
 * Errors are caught and returned as `{ kind: 'failed', ... }` — callers
 * (the engine's deliver path) should log the outcome but never let it
 * propagate. The on-chain `claimDelivery` already settled.
 *
 * Self-feedback (caller is owner/approved/operator of `restorerAgentId`)
 * reverts on chain with a known string; we surface that as a graceful
 * `{ kind: 'skipped', reason: 'self-feedback' }`.
 */
export async function submitEvaluatorFeedback(args: {
  registry: ReputationRegistryClient;
  ref: RestorerExecutionRef;
  verdict: EvaluatorVerdict;
  /** Optional logger; defaults to console.warn for failures. */
  log?: (entry: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void;
}): Promise<FeedbackHookOutcome> {
  const { registry, ref, verdict } = args;
  const log = args.log ?? defaultLog;

  const mapped = mapVerdictToScore(verdict.verdict);
  if (!mapped) {
    log({
      level: 'info',
      msg: `[reputation] skipping giveFeedback for verdict=${verdict.verdict} (policy: no on-chain feedback)`,
      data: { restorerAgentId: ref.restorerAgentId.toString(), verdict: verdict.verdict },
    });
    return { kind: 'skipped', reason: 'verdict-not-eligible' };
  }

  const giveArgs: GiveFeedbackArgs = {
    restorerAgentId: ref.restorerAgentId,
    score: mapped.score,
    scoreDecimals: mapped.scoreDecimals,
    manifestRef: `manifest:${ref.restorerManifestCid}`,
    manifestHash: ref.restorerEvidenceHash,
    ...(verdict.kind ? { tag1: verdict.kind } : {}),
    ...(verdict.tag2 ? { tag2: verdict.tag2 } : {}),
  };

  try {
    const txHash = await registry.giveFeedback(giveArgs);
    log({
      level: 'info',
      msg: '[reputation] giveFeedback submitted',
      data: {
        restorerAgentId: ref.restorerAgentId.toString(),
        verdict: verdict.verdict,
        score: mapped.score,
        scoreDecimals: mapped.scoreDecimals,
        manifestCid: ref.restorerManifestCid,
        txHash,
      },
    });
    return { kind: 'submitted', txHash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Self-feedback guard: contract reverts with "Self-feedback not allowed"
    // when the evaluator EOA/Safe is the owner/approved/operator of the
    // restorer's agentId. This is structurally possible in single-operator
    // dev setups; treat as a graceful skip.
    if (msg.includes('Self-feedback not allowed')) {
      log({
        level: 'warn',
        msg: '[reputation] giveFeedback skipped: evaluator is the restorer (self-feedback guard)',
        data: { restorerAgentId: ref.restorerAgentId.toString() },
      });
      return { kind: 'skipped', reason: 'self-feedback' };
    }

    // Agent doesn't exist on chain. The contract reverts with the canonical
    // ERC-721 error; surface as a graceful skip — the restorer hasn't yet
    // minted (or we're querying the wrong chain).
    if (msg.includes('ERC721NonexistentToken') || msg.includes('nonexistent')) {
      log({
        level: 'warn',
        msg: '[reputation] giveFeedback skipped: restorer agentId not minted',
        data: { restorerAgentId: ref.restorerAgentId.toString() },
      });
      return { kind: 'skipped', reason: 'agent-not-found' };
    }

    // Anything else: log warn (NOT error — the evaluator's claimDelivery
    // already landed), surface as `failed` for tests/observability.
    log({
      level: 'warn',
      msg: '[reputation] giveFeedback failed (non-fatal); claimDelivery already authoritative',
      data: {
        restorerAgentId: ref.restorerAgentId.toString(),
        error: msg,
      },
    });
    return { kind: 'failed', error: msg };
  }
}

// ── Local helpers ───────────────────────────────────────────────────────────

function defaultLog(entry: {
  level: 'info' | 'warn' | 'error';
  msg: string;
  data?: unknown;
}): void {
  if (entry.level === 'error') {
    console.error(entry.msg, entry.data ?? '');
  } else if (entry.level === 'warn') {
    console.warn(entry.msg, entry.data ?? '');
  } else {
    console.log(entry.msg, entry.data ?? '');
  }
}
