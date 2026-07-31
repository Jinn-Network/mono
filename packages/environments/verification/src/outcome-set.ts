// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, recordDigest, type Sha256Digest } from "@jinn-network/trust-core";
import { z } from "zod";

import { invalidInput } from "./errors.js";

export const OUTCOME_STATUSES = ["pass", "fail", "skip"] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** One run's observed outcomes: test id -> status. The comparison unit of the
 * whole protocol (design §5.2: set equality over (test-id -> pass|fail|skip)). */
export const OutcomeSetSchema = z.record(z.string().min(1), z.enum(OUTCOME_STATUSES));
export type OutcomeSet = z.infer<typeof OutcomeSetSchema>;

export interface OutcomeTally {
  readonly passing: number;
  readonly failing: number;
  readonly skipped: number;
}

function assertOutcomeSet(outcomes: OutcomeSet): void {
  const parsed = OutcomeSetSchema.safeParse(outcomes);
  if (!parsed.success) {
    invalidInput("An outcome set maps non-empty test ids to pass|fail|skip.");
  }
}

/**
 * RFC 8785 canonical bytes of the outcome set -- both the bytes stored through
 * the artifact port and the bytes `outcomeSetDigest` hashes, so a consumer that
 * retrieves the artifact can recompute the digest in the predicate.
 */
export function canonicalOutcomeSetBytes(outcomes: OutcomeSet): Uint8Array {
  assertOutcomeSet(outcomes);
  return canonicalJsonBytes(outcomes);
}

export function outcomeSetDigest(outcomes: OutcomeSet): Sha256Digest {
  return recordDigest(canonicalOutcomeSetBytes(outcomes));
}

/** Set equality over (test id -> status). Wall time is recorded as observed
 * bounds and never enters this comparison (design §5.2). */
export function outcomeSetsEqual(left: OutcomeSet, right: OutcomeSet): boolean {
  return outcomeSetDigest(left) === outcomeSetDigest(right);
}

/** Counts for the baseline block. A baseline carrying failures is a *known*
 * baseline, not a rejected environment (design §5.2). */
export function tallyOutcomeSet(outcomes: OutcomeSet): OutcomeTally {
  assertOutcomeSet(outcomes);
  let passing = 0;
  let failing = 0;
  let skipped = 0;
  for (const status of Object.values(outcomes)) {
    if (status === "pass") passing += 1;
    else if (status === "fail") failing += 1;
    else skipped += 1;
  }
  return { passing, failing, skipped };
}
