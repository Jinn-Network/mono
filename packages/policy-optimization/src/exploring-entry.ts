// SPDX-License-Identifier: MIT

/**
 * The `DRAFT → EXPLORING` legality gate (product design §5.2, §6.3).
 *
 * > The transition into `EXPLORING` is legal only if `promotionBenchmark` references a sealed
 * > *committed* Benchmark — sealed before the campaign enters `EXPLORING`, **unrevealed at
 * > `EXPLORING`-entry** (a previously revealed committed Benchmark is contaminated and
 * > inadmissible as a promotion gate).
 *
 * Every leg of that sentence is checked through `@jinn-network/benchmarking-records`' own
 * committed-benchmark machinery — `parseBenchmark`, `documentDigest`, `checkItemDistinctness`,
 * `checkRevealConsistency`, and the `JudgeabilityRevealContext` vocabulary — rather than a private
 * re-reading of the `reveal` block. The Benchmark record is the single go-forward representation
 * of a held-out boundary (§6.3); this product is its first tier-4 consumer, so where it needed a
 * predicate that did not exist it composes the ones that do.
 *
 * **What this proves, stated so nobody assumes more (product §11's honesty residuals).** The
 * unrevealedness leg can only refute; it cannot confirm. `checkRevealConsistency` verifies the
 * bytes the *caller* supplies, so a campaign owner who simply supplies no revealed bytes always
 * passes it. On the local venue this gate protects an honest owner from self-deception and proves
 * nothing to a stranger. The check that binds strangers is the post-reveal one §6.3 names —
 * third parties re-run the held-out exclusion and lexical scan against the revealed items — plus,
 * on an anchored venue, the promotion Benchmark's anchor preceding the earliest dev-wave cell
 * anchor (§11). Neither is v0's, and neither is this function's.
 */

import {
  checkItemDistinctness,
  checkRevealConsistency,
  compareCalendarStrictRfc3339Instants,
  documentDigest,
  parseBenchmark,
  type BenchmarkRecord,
  type JudgeabilityRevealContext,
  type RevealCoverage,
} from "@jinn-network/benchmarking-records";
import type { CampaignDocument } from "./types.js";

export type ExploringEntryRefusal =
  /** The bytes are not a well-formed, non-empty, item-distinct Benchmark record. */
  | "invalid-benchmark"
  /** The bytes do not digest to the campaign's `target.promotionBenchmark`. */
  | "digest-mismatch"
  /** `reveal.policy` is `immediate`, or `scheduled` with no instant to be committed until. */
  | "not-committed"
  /** The supplied reveal context does not match the record's declared reveal policy. */
  | "reveal-context-mismatch"
  /** A `scheduled` benchmark whose `notBefore` has already arrived: the items are publishable. */
  | "reveal-window-open"
  /** The caller can already show at least one committed item as revealed, or as tampered with. */
  | "already-revealed";

/**
 * The typed proof that the transition was checked. It is not forgeable by accident: the journal's
 * `DRAFT → EXPLORING` append demands one, so the check cannot be skipped by an implementer who
 * forgot it existed.
 */
export interface ExploringEntryAdmission {
  readonly promotionBenchmark: string;
  readonly revealPolicy: BenchmarkRecord["reveal"]["policy"];
  readonly coverage: RevealCoverage;
}

export interface ExploringEntryInput {
  /** The exact sealed bytes of the Benchmark record the campaign names as its promotion gate. */
  readonly benchmarkBytes: Uint8Array;
  /**
   * The trusted fact that distinguishes genuinely pre-reveal material, in
   * `@jinn-network/benchmarking-records`' own vocabulary. Required: "committed" is a claim about a
   * moment, and a checker with no moment cannot make it.
   */
  readonly revealContext: JudgeabilityRevealContext;
  /**
   * Any committed item digest the caller can produce bytes for. Empty means "the caller knows of no
   * reveal" — which is an absence of evidence, not evidence of absence; see the module note.
   */
  readonly revealed?: ReadonlyMap<string, Uint8Array>;
}

export type ExploringEntryResult =
  | { readonly ok: true; readonly admission: ExploringEntryAdmission }
  | { readonly ok: false; readonly reason: ExploringEntryRefusal; readonly detail: string };

function refuse(reason: ExploringEntryRefusal, detail: string): ExploringEntryResult {
  return { ok: false, reason, detail };
}

export function checkExploringEntry(
  campaign: CampaignDocument,
  input: ExploringEntryInput,
): ExploringEntryResult {
  let record: BenchmarkRecord;
  try {
    record = parseBenchmark(input.benchmarkBytes);
  } catch (cause) {
    return refuse("invalid-benchmark",
      `promotion Benchmark bytes do not parse: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const digest = documentDigest(input.benchmarkBytes);
  if (digest !== campaign.target.promotionBenchmark) {
    return refuse("digest-mismatch",
      `supplied bytes digest to ${digest}, campaign names ${campaign.target.promotionBenchmark}`);
  }

  if (record.items.length === 0) {
    return refuse("invalid-benchmark", "a promotion gate with no items gates nothing");
  }
  const distinctness = checkItemDistinctness(record);
  if (!distinctness.ok) {
    return refuse("invalid-benchmark", `duplicate item ${distinctness.duplicate}`);
  }

  const { reveal } = record;
  if (reveal.policy === "immediate") {
    return refuse("not-committed",
      "an immediate-reveal Benchmark is a published slate; a promotion gate must be reveal-later (§6.3)");
  }
  if (reveal.policy !== input.revealContext.kind) {
    return refuse("reveal-context-mismatch",
      `record declares ${reveal.policy}, caller supplied a ${input.revealContext.kind} context`);
  }
  if (reveal.policy === "scheduled") {
    if (reveal.notBefore === undefined) {
      return refuse("not-committed", "a scheduled reveal with no notBefore instant commits to nothing");
    }
    if (input.revealContext.kind !== "scheduled") {
      return refuse("reveal-context-mismatch", "scheduled reveal needs a scheduled context");
    }
    // The comparison is a tri-state plus `undefined` for an uninterpretable instant. `undefined`
    // is refused rather than treated as "not yet open": a context whose instant nobody can read
    // establishes nothing about whether the window is closed.
    const comparison = compareCalendarStrictRfc3339Instants(
      input.revealContext.trustedAtTime,
      reveal.notBefore,
    );
    if (comparison === undefined) {
      return refuse("reveal-context-mismatch",
        "the reveal schedule or the trusted instant is not a calendar-valid RFC 3339 instant");
    }
    if (comparison >= 0) {
      return refuse("reveal-window-open",
        `the reveal window opened at ${reveal.notBefore}; the items are no longer held out`);
    }
  } else if (input.revealContext.kind !== "after-run" || input.revealContext.trustedRunNotClosed !== true) {
    return refuse("reveal-context-mismatch", "an after-run reveal needs a not-yet-closed Run as context");
  }

  const consistency = checkRevealConsistency(record, input.revealed ?? new Map());
  if (!consistency.ok) {
    return refuse("already-revealed",
      `reveal-consistency failed on ${consistency.mismatched.join(", ")}: the gate's bytes are in play and do not match their commitments`);
  }
  if (consistency.coverage.revealed > 0) {
    return refuse("already-revealed",
      `${consistency.coverage.revealed} of ${consistency.coverage.committed} items are already revealed; a revealed gate is contaminated (§6.3)`);
  }

  return {
    ok: true,
    admission: {
      promotionBenchmark: digest,
      revealPolicy: reveal.policy,
      coverage: consistency.coverage,
    },
  };
}
