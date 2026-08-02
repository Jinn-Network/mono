// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { refuseChain } from "./chain-refusals.js";
import { CHAIN_ADMISSION_POLICY_V1 } from "./identifiers.js";

/** Which script a side runs. A selector, never content: admission holds no script bytes. */
export type ChainScriptSelector =
  | { readonly kind: "do-nothing" }
  | { readonly kind: "reference"; readonly digest: `sha256:${string}` };

export interface ChainObservationRequest {
  /** The COMPOSITE crypto-environment record, by digest. Admission never parses a record
   *  of this kind — doing so would need a chain dependency it must not have (F-CE5-2). */
  readonly environmentCompositeDigest: `sha256:${string}`;
  readonly evaluationSpecDigest: `sha256:${string}`;
  readonly script: ChainScriptSelector;
  /** 1 or 2 — the repeat index within a side, so a host can launch a fresh instance. */
  readonly attempt: 1 | 2;
  readonly signal?: AbortSignal;
}

const PredicateOutcomeSchema = z.strictObject({
  id: z.string().min(1),
  satisfied: z.boolean(),
});
export type ChainPredicateOutcome = z.infer<typeof PredicateOutcomeSchema>;

function uniqueIds(list: readonly ChainPredicateOutcome[], ctx: z.RefinementCtx, field: string): void {
  const seen = new Set<string>();
  for (const outcome of list) {
    if (seen.has(outcome.id)) {
      ctx.addIssue({ code: "custom", message: `${field} repeats predicate id ${outcome.id}` });
    }
    seen.add(outcome.id);
  }
}

/**
 * One host reading of one run.
 *
 * The host composes the world's replayer with the evaluation family's PURE predicate
 * evaluator and hands the outcome here — the exact analog of the SWE port returning parsed
 * `passed`/`failed` rather than a test log. Admission parses nothing, evaluates nothing
 * against chain state, and depends on no chain package.
 *
 * `conjunction` is the host's own self-report and is re-derived below; a disagreement is a
 * refusal, because a port whose summary contradicts its own vector cannot be attributed.
 */
export const ChainObservationSchema = z
  .strictObject({
    successPredicates: z.array(PredicateOutcomeSchema).min(1),
    safetyConstraints: z.array(PredicateOutcomeSchema),
    conjunction: z.boolean(),
    /** Slice-sufficiency observation (design §4.2/§6.3): reads that left the sealed world. */
    outOfSliceReads: z.number().int().nonnegative(),
    envelopeExceeded: z.boolean(),
    /** The digest of the script the host actually executed; `null` for the empty side. */
    appliedScriptDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  })
  .superRefine((observation, ctx) => {
    uniqueIds(observation.successPredicates, ctx, "successPredicates");
    uniqueIds(observation.safetyConstraints, ctx, "safetyConstraints");
  });

export type ChainObservation = z.infer<typeof ChainObservationSchema>;

export type ChainObservationPort = (
  request: ChainObservationRequest,
) => Promise<ChainObservation>;

/**
 * The conjunction is over the SUCCESS predicates only. Safety constraints gate separately
 * (design §6.2's verdict rule): folding them in would make a safety violation on the
 * reference side read as "not solvable", which is a different and wrong diagnosis.
 */
export function deriveConjunction(observation: ChainObservation): boolean {
  return observation.successPredicates.every((outcome) => outcome.satisfied);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Collapse one side's repeats to the single observation they agree on. Disagreement is a
 * refusal, not an average: the receipt's whole claim is that the repeats were identical.
 */
export function stableChainObservation(
  observations: readonly unknown[],
  side: "do-nothing" | "reference",
): ChainObservation {
  const expected = CHAIN_ADMISSION_POLICY_V1.observationsPerSide;
  if (observations.length !== expected) {
    refuseChain("unstable-observations", `${side} must have exactly ${expected} runs`);
  }
  const parsed = observations.map((observation) => {
    const result = ChainObservationSchema.safeParse(observation);
    if (!result.success) refuseChain("invalid-candidate", `${side} observation: ${result.error.message}`);
    return result.data;
  });
  const first = parsed[0] as ChainObservation;
  const canonical = canonicalJsonBytes(first);
  if (parsed.some((observation) => !bytesEqual(canonicalJsonBytes(observation), canonical))) {
    refuseChain("unstable-observations", `${side} observations are not identical`);
  }
  if (deriveConjunction(first) !== first.conjunction) {
    refuseChain(
      "inconsistent-observation",
      `${side} reported conjunction ${first.conjunction} but its own outcome vector derives `
        + `${deriveConjunction(first)}`,
    );
  }
  return first;
}
