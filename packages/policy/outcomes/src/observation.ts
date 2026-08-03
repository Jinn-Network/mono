import { z } from "zod";
import type { AxisFidelityStatus, ExecutionPolicyTuple } from "@jinn-network/policy-identity";
import {
  AxisFidelityStatusSchema,
  FreeTextSchema,
  InstantSchema,
  PerAxisStatusSchema,
  PolicyOutcomeInputRefSchema,
  PolicyOutcomesInputError,
  Sha256DigestSchema,
  issueText,
  refDedupeKey,
} from "./schema.js";
import { assertValidTuple } from "./tuple-support.js";

export { PolicyOutcomesInputError } from "./schema.js";

/**
 * An RFC 3339 instant. In practice the announcement/block time (never adapter wall-clock time --
 * substrate §6.1). It is this package's ONLY time source; there is no clock here.
 */
export type Instant = string;

export type Sha256Digest = `sha256:${string}`;

export type ObservedVerdict = "pass" | "fail" | "inconclusive";

/**
 * Substrate §7 -- the per-axis treatment-fidelity status for the four core axes. Re-exported
 * type only (`AxisFidelityStatus` is `@jinn-network/policy-identity`'s frozen vocabulary; the
 * benchmarking design owns the derivation rule, this package only carries the disclosure).
 */
export interface PerAxisStatus {
  readonly harness: AxisFidelityStatus;
  readonly model: AxisFidelityStatus;
  readonly loadout: AxisFidelityStatus;
  readonly isolationPolicy: AxisFidelityStatus;
}

/**
 * Provenance of one announced verdict, plus the attempt it judged. Field-for-field identical to
 * `@jinn-network/task-curation`'s `CurationInputRef` (substrate §6.1: "dedupe tuple identical to
 * curation's") -- mirrored rather than imported, to keep this package's own dependency graph
 * exactly as declared (identity only).
 *
 * `record` is the digest of the announced record (`AnnouncedItem.record.digest`,
 * `packages/discovery/protocol/src/item.ts`) -- see README "Findings" F-C2-2 for the scope of
 * what this field can and cannot honestly be asserted to prove about re-announcement dedupe.
 */
export interface PolicyOutcomeInputRef {
  readonly source: { readonly agent: string; readonly name: string };
  readonly entry: Sha256Digest;
  readonly announcementId: string;
  readonly record: Sha256Digest;
  readonly attemptUri: string;
}

/**
 * One observed policy-keyed verdict, as the adapter (tier-4, substrate §6.3) hands it over.
 * Neutral input type: mirrors `CurationObservation` field-for-field plus the policy join.
 *
 * `tuple` is the REQUESTED execution-policy tuple (substrate §4.1) the adapter derived from the
 * (Task, Submission) pair via `@jinn-network/policy-identity`'s `deriveExecutionTuple` -- this
 * package never derives one. `perAxisStatus` is the adapter-resolved treatment-fidelity
 * disclosure (substrate §7); `taskDigest`, `attribution`, and `benchmarkRun` are adapter joins
 * exactly as in `CurationObservation`.
 */
export interface PolicyOutcomeObservation {
  readonly tuple: ExecutionPolicyTuple;
  readonly perAxisStatus: PerAxisStatus;
  readonly taskDigest: Sha256Digest;
  readonly verdict: ObservedVerdict;
  readonly observedAt: Instant;
  readonly attribution: string;
  readonly benchmarkRun?: string;
  readonly ref: PolicyOutcomeInputRef;
}

const TupleSchema = z.custom<ExecutionPolicyTuple>((value) => {
  try {
    assertValidTuple(value);
    return true;
  } catch {
    return false;
  }
}, "malformed execution-policy tuple");

const PolicyOutcomeObservationSchema = z.object({
  tuple: TupleSchema,
  perAxisStatus: PerAxisStatusSchema,
  taskDigest: Sha256DigestSchema,
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  observedAt: InstantSchema,
  attribution: FreeTextSchema,
  benchmarkRun: FreeTextSchema.optional(),
  ref: PolicyOutcomeInputRefSchema,
});

export function parsePolicyOutcomeObservation(value: unknown): PolicyOutcomeObservation {
  const result = PolicyOutcomeObservationSchema.safeParse(value);
  if (!result.success) {
    throw new PolicyOutcomesInputError(
      `malformed policy outcome observation: ${issueText(result.error)}`,
      { cause: result.error },
    );
  }
  return result.data as PolicyOutcomeObservation;
}

/**
 * The at-least-once dedupe key of the discovery subscribe plane -- identical in shape to
 * curation's `inputRefKey`. Folding on this key is what makes redelivery a no-op.
 */
export function inputRefKey(ref: PolicyOutcomeInputRef): string {
  return refDedupeKey(ref);
}

// AxisFidelityStatusSchema is re-exported so a caller can validate a bare status without pulling
// in the whole observation schema.
export { AxisFidelityStatusSchema };
