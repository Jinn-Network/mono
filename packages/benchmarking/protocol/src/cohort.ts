// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  CaptureAssuranceSchema,
  DigestBearingResourceDescriptorSchema,
  EvidenceRecordReferenceSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  TimestampSchema,
  TypedRecordReferenceSchema,
  evidenceReferenceKey,
  isSortedUniqueBy,
  topLevelRecordSchema,
  typedReferenceKey,
} from "./common.js";
import { BENCHMARKING_PROTOCOL_V2 } from "./identifiers.js";
import {
  parseExactWithSchema,
  sealWithSchema,
  type SealedRecord,
} from "./sealing.js";

const BoundarySourceSchema = z.strictObject({
  source: TypedRecordReferenceSchema,
  cursor: DigestBearingResourceDescriptorSchema.optional(),
  cutoff: TimestampSchema.optional(),
});

const ExcludedEvidenceReferenceSchema = z.strictObject({
  reference: EvidenceRecordReferenceSchema,
  reason: NonEmptyStringSchema,
});

const ClaimSelectionSchema = z.strictObject({
  considered: z.array(EvidenceRecordReferenceSchema),
  admitted: z.array(EvidenceRecordReferenceSchema),
  excluded: z.array(ExcludedEvidenceReferenceSchema),
}).superRefine((selection, ctx) => {
  if (!isSortedUniqueBy(selection.considered, evidenceReferenceKey)) {
    ctx.addIssue({
      code: "custom",
      path: ["considered"],
      message: "considered references must be sorted and unique",
    });
  }
  if (!isSortedUniqueBy(selection.admitted, evidenceReferenceKey)) {
    ctx.addIssue({
      code: "custom",
      path: ["admitted"],
      message: "admitted references must be sorted and unique",
    });
  }
  if (!isSortedUniqueBy(selection.excluded, (entry) => evidenceReferenceKey(entry.reference))) {
    ctx.addIssue({
      code: "custom",
      path: ["excluded"],
      message: "excluded references must be sorted and unique",
    });
  }
  const considered = new Set(selection.considered.map(evidenceReferenceKey));
  const admitted = new Set(selection.admitted.map(evidenceReferenceKey));
  selection.admitted.forEach((reference, index) => {
    if (!considered.has(evidenceReferenceKey(reference))) {
      ctx.addIssue({
        code: "custom",
        path: ["admitted", index],
        message: "admitted reference must be present in considered",
      });
    }
  });
  selection.excluded.forEach((entry, index) => {
    const key = evidenceReferenceKey(entry.reference);
    if (!considered.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["excluded", index, "reference"],
        message: "excluded reference must be present in considered",
      });
    }
    if (admitted.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["excluded", index, "reference"],
        message: "reference cannot be both admitted and excluded",
      });
    }
  });
});

const CohortMemberSchema = z.strictObject({
  memberKey: NonEmptyStringSchema,
  execution: EvidenceRecordReferenceSchema,
  capture: TypedRecordReferenceSchema.optional(),
  taskDigest: Sha256DigestSchema,
  resultDigests: z.array(Sha256DigestSchema).min(1),
  groupId: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u),
  slotId: NonEmptyStringSchema,
  replicate: z.number().int().nonnegative(),
  correlationKey: NonEmptyStringSchema,
  evaluations: ClaimSelectionSchema,
  verifications: ClaimSelectionSchema,
  labelResolutions: ClaimSelectionSchema,
  assurance: CaptureAssuranceSchema,
}).superRefine((member, ctx) => {
  if (member.execution.family !== "execution-evidence") {
    ctx.addIssue({
      code: "custom",
      path: ["execution", "family"],
      message: "member execution must reference execution-evidence",
    });
  }
  if (!isSortedUniqueBy(member.resultDigests, (value) => value)) {
    ctx.addIssue({
      code: "custom",
      path: ["resultDigests"],
      message: "result digests must be sorted and unique",
    });
  }
  for (const [field, family] of [
    ["evaluations", "result-evaluation"],
    ["verifications", "execution-verification"],
    ["labelResolutions", "human-label-resolution"],
  ] as const) {
    const selection = member[field];
    [
      ...selection.considered,
      ...selection.admitted,
      ...selection.excluded.map((entry) => entry.reference),
    ].forEach((reference, index) => {
      if (reference.family !== family) {
        ctx.addIssue({
          code: "custom",
          path: [field, "considered", index, "family"],
          message: `${field} may contain only ${family} references`,
        });
      }
    });
  }
});

const ExcludedExecutionSchema = z.strictObject({
  execution: EvidenceRecordReferenceSchema,
  taskDigest: Sha256DigestSchema.optional(),
  resultDigests: z.array(Sha256DigestSchema),
  reason: NonEmptyStringSchema,
});

export const EvidenceCohortSchema = topLevelRecordSchema({
  protocol: z.literal(BENCHMARKING_PROTOCOL_V2),
  manifest: DigestBearingResourceDescriptorSchema,
  boundary: z.strictObject({
    sources: z.array(BoundarySourceSchema).min(1),
    resolvedAt: TimestampSchema,
  }),
  members: z.array(CohortMemberSchema),
  excludedExecutions: z.array(ExcludedExecutionSchema),
  closure: z.strictObject({
    status: z.enum([
      "complete-relative-to-sealed-source",
      "partial",
      "indeterminate",
      "failed",
    ]),
    candidateCount: z.number().int().nonnegative(),
    admittedCount: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative(),
    unavailableCount: z.number().int().nonnegative(),
    limitations: z.array(NonEmptyStringSchema),
  }),
  supersedes: DigestBearingResourceDescriptorSchema.optional(),
}).superRefine((cohort, ctx) => {
  if (!isSortedUniqueBy(cohort.boundary.sources, (entry) => typedReferenceKey(entry.source))) {
    ctx.addIssue({
      code: "custom",
      path: ["boundary", "sources"],
      message: "boundary sources must be sorted and unique",
    });
  }
  if (!isSortedUniqueBy(cohort.members, (member) => member.memberKey)) {
    ctx.addIssue({
      code: "custom",
      path: ["members"],
      message: "members must be sorted and unique by memberKey",
    });
  }
  if (
    !isSortedUniqueBy(
      cohort.excludedExecutions,
      (entry) => evidenceReferenceKey(entry.execution),
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["excludedExecutions"],
      message: "excluded executions must be sorted and unique",
    });
  }
  cohort.excludedExecutions.forEach((entry, index) => {
    if (entry.execution.family !== "execution-evidence") {
      ctx.addIssue({
        code: "custom",
        path: ["excludedExecutions", index, "execution", "family"],
        message: "excluded execution must reference execution-evidence",
      });
    }
    if (!isSortedUniqueBy(entry.resultDigests, (value) => value)) {
      ctx.addIssue({
        code: "custom",
        path: ["excludedExecutions", index, "resultDigests"],
        message: "result digests must be sorted and unique",
      });
    }
  });
  if (cohort.closure.admittedCount !== cohort.members.length) {
    ctx.addIssue({
      code: "custom",
      path: ["closure", "admittedCount"],
      message: "admittedCount must equal members.length",
    });
  }
  if (cohort.closure.excludedCount !== cohort.excludedExecutions.length) {
    ctx.addIssue({
      code: "custom",
      path: ["closure", "excludedCount"],
      message: "excludedCount must equal excludedExecutions.length",
    });
  }
  if (
    cohort.closure.candidateCount !==
    cohort.closure.admittedCount +
      cohort.closure.excludedCount +
      cohort.closure.unavailableCount
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["closure", "candidateCount"],
      message: "candidateCount must account for admitted, excluded, and unavailable",
    });
  }
  if (!isSortedUniqueBy(cohort.closure.limitations, (value) => value)) {
    ctx.addIssue({
      code: "custom",
      path: ["closure", "limitations"],
      message: "closure limitations must be sorted and unique",
    });
  }
});

export type EvidenceCohort = z.infer<typeof EvidenceCohortSchema>;
export type EvidenceCohortMember = EvidenceCohort["members"][number];

export function sealEvidenceCohort(document: unknown): SealedRecord {
  return sealWithSchema(EvidenceCohortSchema, document);
}

export function parseEvidenceCohort(bytes: Uint8Array): EvidenceCohort {
  return parseExactWithSchema(EvidenceCohortSchema, bytes);
}
