// SPDX-License-Identifier: MIT

// Requester on-ramp defaults (supply design §8 "Economics honesty"; binding finding F2). The
// escrow multiplier `postTask` uses is the sealed Submission's `attempts.maxTotal`, falling back
// to 1 when the field is absent -- these defaults name the number at the call site instead, and
// `assertMaxClaimsAgreement` makes the fallback unreachable from a posting application, so no
// poster learns the multiplier by reading a `??`.
import type { PostingTerms } from "./posting.js";

/** `PostingTerms` plus the claim count the escrow is multiplied by. */
export interface DefaultPostingTerms extends PostingTerms {
  readonly maxClaims: number;
}

/**
 * Reference terms for today-mode posting on the deployed Base Sepolia substrate. Rates are
 * per-delivery ceilings, not prices: the escrow is `(solution + verdict) x maxClaims` in native
 * wei, sent as `msg.value`. Operators override these; they exist so no caller has to invent an
 * escrow to get a first post out.
 *
 * `allowSolverSelfEvaluation: false` is not a default worth flipping casually -- it is the
 * self-evaluation prevention the recorder enforces.
 */
export const DEFAULT_POSTING_TERMS: DefaultPostingTerms = {
  solutionMaxDeliveryRateWei: 1_000_000_000_000_000n, // 0.001 ETH
  verdictMaxDeliveryRateWei: 200_000_000_000_000n, // 0.0002 ETH
  responseTimeoutSeconds: 86_400n,
  allowSolverSelfEvaluation: false,
  maxClaims: 1,
};

/**
 * The escrow formula, in one place: `(solutionMaxDeliveryRateWei + verdictMaxDeliveryRateWei) x
 * maxClaims`. This is the exact `msg.value` `postTask` sends; `posting-defaults.test.ts` pins the
 * equality against the real `postTask` so the two cannot drift.
 *
 * A colluding solver+evaluator pair can drain this escrow with a junk delivery and a friendly
 * verdict under today-mode `minVerdicts: 1`. That risk is marketplace-owned and named here so a
 * poster prices it in (supply design §8); it is not mitigated by this function.
 */
export function postingEscrowValueWei(terms: {
  readonly solutionMaxDeliveryRateWei: bigint;
  readonly verdictMaxDeliveryRateWei: bigint;
  readonly maxClaims: number;
}): bigint {
  if (!Number.isInteger(terms.maxClaims) || terms.maxClaims < 1) {
    throw new RangeError(`maxClaims must be a positive integer, got ${String(terms.maxClaims)}`);
  }
  return (terms.solutionMaxDeliveryRateWei + terms.verdictMaxDeliveryRateWei) * BigInt(terms.maxClaims);
}

/**
 * Fail-closed agreement between the sealed Submission's `attempts.maxTotal` and the terms the
 * escrow was computed from. Throws on `undefined` deliberately: an absent `maxTotal` is exactly
 * the case where `postTask` would silently escrow for one claim.
 */
export function assertMaxClaimsAgreement(
  submissionMaxTotal: number | undefined,
  termsMaxClaims: number,
): void {
  if (submissionMaxTotal === undefined) {
    throw new Error(
      "the sealed Submission omits attempts.maxTotal -- posting refuses to escrow against the "
        + "implicit single-claim fallback (supply design §8)",
    );
  }
  if (submissionMaxTotal !== termsMaxClaims) {
    throw new Error(
      `the sealed Submission's attempts.maxTotal (${submissionMaxTotal}) disagrees with the terms' `
        + `maxClaims (${termsMaxClaims}) -- the escrow would not cover the claims the task admits`,
    );
  }
}
