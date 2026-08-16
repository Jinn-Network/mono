// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import {
  BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI,
} from "../identifiers.js";
import { assertValidDocument, parseJsonDocument } from "../zod-parse.js";
import { sealDocument } from "../bytes.js";
import {
  BinaryJudgmentItemIdSchema,
  BinaryJudgmentStratumSchema,
  BinaryJudgmentTruthLabelSchema,
} from "./contracts.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const CandidateClassSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u);
const TimestampSchema = z.string().datetime({ offset: true });

const CommonShape = {
  protocol: z.literal(BINARY_JUDGMENT_LABEL_RESOLUTION_FORMAT_URI),
  itemSha256: Sha256DigestSchema,
  itemId: BinaryJudgmentItemIdSchema,
  humanReviewEvaluationSpecSha256: Sha256DigestSchema,
  truthLabel: BinaryJudgmentTruthLabelSchema,
  candidateClass: CandidateClassSchema,
  stratum: BinaryJudgmentStratumSchema,
  resolvedAt: TimestampSchema,
};

function sortedUniquePair(values: readonly [string, string]): boolean {
  return values[0] < values[1];
}

const HumanLabelResolutionSchema = z.strictObject({
  ...CommonShape,
  truthAdmission: z.literal("two-human-unanimous"),
  reviewVerdictSha256s: z.tuple([Sha256DigestSchema, Sha256DigestSchema]),
  reviewerRosterSha256: Sha256DigestSchema,
  visibilityReceiptSha256s: z.tuple([Sha256DigestSchema, Sha256DigestSchema]),
  revealReceiptSha256: Sha256DigestSchema,
}).superRefine((resolution, ctx) => {
  if (!sortedUniquePair(resolution.reviewVerdictSha256s)) {
    ctx.addIssue({
      code: "custom",
      path: ["reviewVerdictSha256s"],
      message: "review verdict digests must be sorted and unique",
    });
  }
  if (!sortedUniquePair(resolution.visibilityReceiptSha256s)) {
    ctx.addIssue({
      code: "custom",
      path: ["visibilityReceiptSha256s"],
      message: "visibility receipt digests must be sorted and unique",
    });
  }
});

const OperatorLabelResolutionSchema = z.strictObject({
  ...CommonShape,
  truthAdmission: z.literal("operator-only"),
  operatorAssertionSha256: Sha256DigestSchema,
});

/**
 * Evaluator-only admitted truth. Every authority-bearing document is referenced by exact digest;
 * no verdict, roster, visibility, reveal, or operator-assertion body is copied into this
 * projection. Exclusion and reserve replacement accounting deliberately live outside an admitted
 * resolution, so changing a pool ledger cannot silently change an item's truth projection.
 */
export const BinaryJudgmentLabelResolutionSchema = z.discriminatedUnion("truthAdmission", [
  HumanLabelResolutionSchema,
  OperatorLabelResolutionSchema,
]);
export type BinaryJudgmentLabelResolution = z.infer<
  typeof BinaryJudgmentLabelResolutionSchema
>;

export function parseBinaryJudgmentLabelResolution(
  bytes: Uint8Array,
): BinaryJudgmentLabelResolution {
  return parseJsonDocument(
    BinaryJudgmentLabelResolutionSchema,
    bytes,
    "BinaryJudgmentLabelResolution",
  );
}

export function sealBinaryJudgmentLabelResolution(
  value: BinaryJudgmentLabelResolution,
): { bytes: Uint8Array; digest: `sha256:${string}` } {
  return sealDocument(assertValidDocument(
    BinaryJudgmentLabelResolutionSchema,
    value,
    "BinaryJudgmentLabelResolution",
  ));
}
