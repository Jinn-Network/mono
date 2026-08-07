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
 *
 * `maxClaims: 1` admits a single solver per post: the reference configuration is deliberately not
 * competitive. One claim is the cheapest first post (the escrow is one solution + one verdict) and
 * the right shape for a requester proving the loop; a requester who wants competing attempts raises
 * it AND seals the same number into the Submission's `attempts.maxTotal` (see
 * `assertMaxClaimsAgreement`).
 */
export const DEFAULT_POSTING_TERMS: DefaultPostingTerms = {
  solutionMaxDeliveryRateWei: 1_000_000_000_000_000n, // 0.001 ETH
  verdictMaxDeliveryRateWei: 200_000_000_000_000n, // 0.0002 ETH
  // Read 2026-07-31 from the deployed Base Sepolia MechMarketplace
  // 0xD3233FdAaB51E9775f6bFCE8242B02C181D7c0e7 (chainId 84532 -- the address
  // JinnRouterV3.mechMarketplace() returns): minResponseTimeout() = 60, maxResponseTimeout() = 300.
  // `JinnRouterV3.createTask` does NOT validate this value; it stores it and forwards it to the
  // marketplace at CLAIM time, where an out-of-bounds value reverts. So a too-large default posts
  // fine, locks msg.value in escrow, and then makes every claim on that task revert -- dead on
  // arrival, refundable only via refundUnusedTaskBudget. 300s is the deployed ceiling: the longest
  // delivery window this substrate admits.
  responseTimeoutSeconds: 300n,
  allowSolverSelfEvaluation: false,
  maxClaims: 1,
};

/**
 * How far past the posting's authority instant a freshly sealed Submission's `deadline` is set.
 *
 * This exists as a NAMED posting default, beside the terms above, because the alternative is what
 * shipped: the native requester never set `deadline` at all, so every posting inherited the literal
 * `2026-08-02T12:00:00Z` from the digest-pinned admission fixture — test data that had silently
 * become production policy. The live DR-2026-08-05 gate posted task 1218 on 2026-08-07 carrying
 * that five-day-stale instant verbatim, and no solver could ever claim it (issue #2526).
 *
 * ## Why this is NOT `responseTimeoutSeconds`
 *
 * The obvious-looking move — reuse the posting terms' own timeout — is wrong, and wrong in a way
 * that would have reproduced the bug in a subtler form. They are different clocks measuring
 * different things:
 *
 *  - `responseTimeoutSeconds` is the marketplace's per-claim DELIVERY window. It starts when a
 *    solver claims, and it is capped by the deployed substrate: the Base Sepolia MechMarketplace's
 *    `maxResponseTimeout()` is 300s, which is exactly the value above.
 *  - `deadline` is the requester's absolute deadline for the work, in the record plane, read at
 *    DISCOVERY time by a prospective solver deciding whether the job is still worth claiming.
 *
 * The solver's claim gate (`native-claim-policy.ts`) refuses non-retryably when
 * `deadline - now < minDeadlineLeadMs`, and that minimum is 5 minutes — numerically identical to
 * the 300s ceiling above. So a deadline derived from `responseTimeoutSeconds` would clear the gate
 * by exactly zero margin at the instant of posting and fail one millisecond later, before the
 * announcement was ever polled. The lead has to comfortably exceed the claim minimum AND leave the
 * whole delivery window inside itself, so it cannot be a marketplace term at all.
 *
 * One hour: twelve times the claim gate's minimum lead, and it still contains the minimum lead plus
 * a full maximum-length delivery window (300s + 300s) many times over, while staying bounded enough
 * that a post nobody claims releases its escrow the same day rather than sitting open indefinitely.
 * Raising the claim gate's `minDeadlineLeadMs` above this value would strand postings again, so the
 * two numbers move together or not at all.
 */
export const DEFAULT_SUBMISSION_DEADLINE_LEAD_MS = 60 * 60 * 1000;

/**
 * The escrow formula, in one place: `(solutionMaxDeliveryRateWei + verdictMaxDeliveryRateWei) x
 * maxClaims`. This is the `msg.value` `postTask` sends **when the sealed Submission's
 * `attempts.maxTotal` equals `terms.maxClaims`** -- `postTask` takes its multiplier from the
 * Submission and never reads `maxClaims`, so the two agree only when the caller has made them
 * agree; `assertMaxClaimsAgreement` is how a caller establishes that. `posting-defaults.test.ts`
 * pins both sides: the equality under agreement, and the silent 1x escrow under divergence.
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
