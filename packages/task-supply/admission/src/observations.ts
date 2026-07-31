// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, compareCodeUnitStrings } from "@jinn-network/trust-core";
import { z } from "zod";
import { DIFFERENTIAL_ADMISSION_POLICY_V3 } from "./identifiers.js";
import { refuse } from "./refusals.js";

const AssertionId = z.string().min(1);

/**
 * One parser reading of one run. `passedMatch` is the parser's own self-report, carried into the
 * receipt as an observed fact and interpreted by nothing here.
 */
export const ObservationSchema = z
  .strictObject({
    passed: z.array(AssertionId),
    failed: z.array(AssertionId),
    passedMatch: z.boolean(),
  })
  .superRefine((observation, ctx) => {
    const seen = new Set<string>();
    for (const identifier of [...observation.passed, ...observation.failed]) {
      if (seen.has(identifier)) {
        ctx.addIssue({
          code: "custom",
          message: `observation repeats raw assertion identifier ${identifier}`,
        });
      }
      seen.add(identifier);
    }
  });

export type Observation = z.infer<typeof ObservationSchema>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Collapse one side's repeats to the single observation they agree on. Disagreement is a refusal,
 * not an average: the receipt's whole claim is that the repeats were identical.
 */
export function stableObservation(
  observations: readonly unknown[],
  side: "broken" | "fixed",
  testPath: string,
): Observation {
  const expected = DIFFERENTIAL_ADMISSION_POLICY_V3.observationsPerSide;
  if (observations.length !== expected) {
    refuse(
      "unstable-observations",
      `${side} observations for ${testPath} must have exactly ${expected} runs`,
    );
  }
  const parsed = observations.map((observation) => {
    const result = ObservationSchema.safeParse(observation);
    if (!result.success) {
      refuse("invalid-candidate", `${side} observation for ${testPath}: ${result.error.message}`);
    }
    return result.data;
  });
  const first = parsed[0] as Observation;
  const canonical = canonicalJsonBytes(first);
  if (parsed.some((observation) => !bytesEqual(canonicalJsonBytes(observation), canonical))) {
    refuse("unstable-observations", `${side} observations for ${testPath} are not identical`);
  }
  return first;
}

/**
 * Fail-to-pass = **observed failing** before, passing after. Pass-to-pass = passing on both
 * sides. Both are sorted by code unit so the receipt's bytes do not depend on the runner's
 * emission order.
 *
 * Absence on the empty side is deliberately not failure (design §7.1: "no patch (empty) →
 * fail-to-pass tests fail (2 runs) — the suite *discriminates*"). An empty side that parsed
 * nothing at all — a collection error, an import error, a broken container, the
 * environment-flakiness failure mode this program exists to catch — otherwise reads as full
 * discrimination for every assertion the gold side happens to report.
 */
export function deriveTransitions(
  before: Observation,
  after: Observation,
): { readonly failToPass: string[]; readonly passToPass: string[] } {
  const beforePassed = new Set(before.passed);
  const beforeFailed = new Set(before.failed);
  const afterPassed = new Set(after.passed);
  const all = [
    ...new Set([...before.passed, ...before.failed, ...after.passed, ...after.failed]),
  ].sort(compareCodeUnitStrings);
  return {
    failToPass: all.filter((id) => beforeFailed.has(id) && afterPassed.has(id)),
    passToPass: all.filter((id) => beforePassed.has(id) && afterPassed.has(id)),
  };
}
