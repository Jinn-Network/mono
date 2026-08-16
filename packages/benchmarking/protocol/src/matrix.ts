// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  DecimalStringSchema,
  DigestBearingResourceDescriptorSchema,
  EvidenceRecordReferenceSchema,
  JsonScalarSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  evidenceReferenceKey,
  isSortedUniqueBy,
  topLevelRecordSchema,
} from "./common.js";
import {
  BENCHMARKING_PROTOCOL_V2,
  MATRIX_V2_ASSEMBLY_PROCEDURE,
  MATRIX_V2_ASSEMBLY_VERSION,
} from "./identifiers.js";
import {
  parseExactWithSchema,
  sealWithSchema,
  type SealedRecord,
} from "./sealing.js";

const MeasurementSchema = z.strictObject({
  name: NonEmptyStringSchema,
  value: JsonScalarSchema,
  unit: NonEmptyStringSchema.optional(),
  source: EvidenceRecordReferenceSchema.optional(),
});

const TrustStateSchema = z.strictObject({
  signatureValid: z.enum(["pass", "fail", "unknown"]),
  identityBound: z.enum(["pass", "fail", "unknown"]),
  purposeAuthorized: z.enum(["pass", "fail", "unknown"]),
  policyTrusted: z.enum(["pass", "fail", "unknown"]),
  partyIndependenceEstablished: z.enum(["pass", "fail", "unknown"]),
});

const MatrixCellSchema = z.strictObject({
  memberKey: NonEmptyStringSchema,
  groupId: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u),
  slotId: NonEmptyStringSchema,
  replicate: z.number().int().nonnegative(),
  execution: EvidenceRecordReferenceSchema,
  taskDigest: Sha256DigestSchema,
  resultDigests: z.array(Sha256DigestSchema).min(1),
  consideredEvaluations: z.array(EvidenceRecordReferenceSchema),
  admittedEvaluations: z.array(EvidenceRecordReferenceSchema),
  consideredVerifications: z.array(EvidenceRecordReferenceSchema),
  admittedVerifications: z.array(EvidenceRecordReferenceSchema),
  admittedLabelResolutions: z.array(EvidenceRecordReferenceSchema),
  outcome: z.enum([
    "accepted",
    "rejected",
    "inconclusive",
    "unjudged",
    "unscorable",
    "failed",
    "cancelled",
    "excluded",
  ]),
  integrity: z.enum([
    "re-derivable",
    "attested-only",
    "partial",
    "indeterminate",
  ]),
  measurements: z.array(MeasurementSchema),
  cost: z.strictObject({
    value: DecimalStringSchema,
    unit: NonEmptyStringSchema,
  }).optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  trust: TrustStateSchema,
  disclosures: z.array(NonEmptyStringSchema),
}).superRefine((cell, ctx) => {
  if (cell.execution.family !== "execution-evidence") {
    ctx.addIssue({
      code: "custom",
      path: ["execution", "family"],
      message: "cell execution must reference execution-evidence",
    });
  }
  for (const [field, family] of [
    ["consideredEvaluations", "result-evaluation"],
    ["admittedEvaluations", "result-evaluation"],
    ["consideredVerifications", "execution-verification"],
    ["admittedVerifications", "execution-verification"],
    ["admittedLabelResolutions", "human-label-resolution"],
  ] as const) {
    const values = cell[field];
    if (!isSortedUniqueBy(values, evidenceReferenceKey)) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `${field} must be sorted and unique`,
      });
    }
    values.forEach((reference, index) => {
      if (reference.family !== family) {
        ctx.addIssue({
          code: "custom",
          path: [field, index, "family"],
          message: `${field} may contain only ${family}`,
        });
      }
    });
  }
  if (!isSortedUniqueBy(cell.resultDigests, (value) => value)) {
    ctx.addIssue({
      code: "custom",
      path: ["resultDigests"],
      message: "result digests must be sorted and unique",
    });
  }
  if (!isSortedUniqueBy(cell.measurements, (measurement) => `${measurement.name}\u0000${measurement.source === undefined ? "" : evidenceReferenceKey(measurement.source)}`)) {
    ctx.addIssue({
      code: "custom",
      path: ["measurements"],
      message: "measurements must be sorted and unique by name and source",
    });
  }
  if (!isSortedUniqueBy(cell.disclosures, (value) => value)) {
    ctx.addIssue({
      code: "custom",
      path: ["disclosures"],
      message: "disclosures must be sorted and unique",
    });
  }
  const consideredEvaluations = new Set(
    cell.consideredEvaluations.map(evidenceReferenceKey),
  );
  cell.admittedEvaluations.forEach((reference, index) => {
    if (!consideredEvaluations.has(evidenceReferenceKey(reference))) {
      ctx.addIssue({
        code: "custom",
        path: ["admittedEvaluations", index],
        message: "admitted evaluation must be considered",
      });
    }
  });
  const consideredVerifications = new Set(
    cell.consideredVerifications.map(evidenceReferenceKey),
  );
  cell.admittedVerifications.forEach((reference, index) => {
    if (!consideredVerifications.has(evidenceReferenceKey(reference))) {
      ctx.addIssue({
        code: "custom",
        path: ["admittedVerifications", index],
        message: "admitted verification must be considered",
      });
    }
  });
});

export const MatrixV2Schema = topLevelRecordSchema({
  protocol: z.literal(BENCHMARKING_PROTOCOL_V2),
  manifest: DigestBearingResourceDescriptorSchema,
  cohort: DigestBearingResourceDescriptorSchema,
  cells: z.array(MatrixCellSchema),
  completeness: z.strictObject({
    expected: z.number().int().nonnegative(),
    admitted: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    status: z.enum(["complete", "partial", "indeterminate", "failed"]),
  }),
  assembly: z.strictObject({
    procedure: z.literal(MATRIX_V2_ASSEMBLY_PROCEDURE),
    version: z.literal(MATRIX_V2_ASSEMBLY_VERSION),
    implementation: DigestBearingResourceDescriptorSchema,
  }),
}).superRefine((matrix, ctx) => {
  if (!isSortedUniqueBy(matrix.cells, (cell) => cell.memberKey)) {
    ctx.addIssue({
      code: "custom",
      path: ["cells"],
      message: "cells must be sorted and unique by memberKey",
    });
  }
  if (matrix.completeness.admitted !== matrix.cells.length) {
    ctx.addIssue({
      code: "custom",
      path: ["completeness", "admitted"],
      message: "admitted must equal cells.length",
    });
  }
  if (
    matrix.completeness.expected !==
    matrix.completeness.admitted +
      matrix.completeness.excluded +
      matrix.completeness.unavailable
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["completeness", "expected"],
      message: "expected must account for admitted, excluded, and unavailable",
    });
  }
});

export type MatrixV2 = z.infer<typeof MatrixV2Schema>;
export type MatrixV2Cell = MatrixV2["cells"][number];

export function sealMatrixV2(document: unknown): SealedRecord {
  return sealWithSchema(MatrixV2Schema, document);
}

export function parseMatrixV2(bytes: Uint8Array): MatrixV2 {
  return parseExactWithSchema(MatrixV2Schema, bytes);
}
