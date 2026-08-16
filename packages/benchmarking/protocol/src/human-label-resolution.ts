// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  AbsoluteIriSchema,
  DigestBearingResourceDescriptorSchema,
  EvidenceRecordReferenceSchema,
  NonEmptyStringSchema,
  TimestampSchema,
  evidenceReferenceKey,
  isSortedUniqueBy,
  topLevelRecordSchema,
} from "./common.js";
import { BENCHMARKING_PROTOCOL_V2 } from "./identifiers.js";
import { parseExactWithSchema, sealWithSchema, type SealedRecord } from "./sealing.js";

const HumanEvaluationReferenceSchema = EvidenceRecordReferenceSchema.refine(
  (reference) => reference.family === "result-evaluation",
  "human review must reference result-evaluation",
);

const Common = {
  protocol: z.literal(BENCHMARKING_PROTOCOL_V2),
  task: DigestBearingResourceDescriptorSchema,
  results: z.array(DigestBearingResourceDescriptorSchema).min(1),
  policy: z.strictObject({
    id: AbsoluteIriSchema,
    version: NonEmptyStringSchema,
    requiredReviewers: z.number().int().min(1),
    agreement: z.literal("unanimous"),
  }),
  admittingOperator: AbsoluteIriSchema,
  publisher: AbsoluteIriSchema,
  issuer: AbsoluteIriSchema,
  resolvedAt: TimestampSchema,
};

export const HumanLabelResolutionSchema = topLevelRecordSchema({
  ...Common,
  basis: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("independent-human-evaluations"),
      evaluations: z.array(HumanEvaluationReferenceSchema).min(1),
      reviewers: z.array(AbsoluteIriSchema).min(1),
    }),
    z.strictObject({
      kind: z.literal("authoritative-label-import"),
      authority: AbsoluteIriSchema,
      source: DigestBearingResourceDescriptorSchema,
    }),
  ]),
  resolution: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("admitted"), label: z.enum(["ACCEPT", "REJECT"]) }),
    z.strictObject({
      status: z.literal("unresolved"),
      reason: z.enum(["disagreement", "inconclusive", "insufficient-reviews"]),
    }),
  ]),
}).superRefine((resolution, ctx) => {
  if (!isSortedUniqueBy(resolution.results, (result) => result.digest.sha256)) {
    ctx.addIssue({ code: "custom", path: ["results"], message: "results must be sorted and unique by digest" });
  }
  if (resolution.basis.kind === "independent-human-evaluations") {
    if (!isSortedUniqueBy(resolution.basis.evaluations, evidenceReferenceKey)) {
      ctx.addIssue({ code: "custom", path: ["basis", "evaluations"], message: "evaluations must be sorted and unique" });
    }
    if (!isSortedUniqueBy(resolution.basis.reviewers, (reviewer) => reviewer)) {
      ctx.addIssue({ code: "custom", path: ["basis", "reviewers"], message: "reviewers must be sorted and unique" });
    }
    if (
      resolution.basis.evaluations.length !== resolution.policy.requiredReviewers ||
      resolution.basis.reviewers.length !== resolution.policy.requiredReviewers
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["policy", "requiredReviewers"],
        message: "requiredReviewers must equal the exact evaluation and reviewer counts",
      });
    }
  }
});

export type HumanLabelResolution = z.infer<typeof HumanLabelResolutionSchema>;

export function sealHumanLabelResolutionPayload(document: unknown): SealedRecord {
  return sealWithSchema(HumanLabelResolutionSchema, document);
}

export function parseHumanLabelResolutionPayload(bytes: Uint8Array): HumanLabelResolution {
  return parseExactWithSchema(HumanLabelResolutionSchema, bytes);
}
