// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  AbsoluteIriSchema,
  CaptureAssuranceSchema,
  DigestBearingResourceDescriptorSchema,
  EvidenceRecordReferenceSchema,
  NativeIdentifierSchema,
  NonEmptyStringSchema,
  TimestampSchema,
  descriptorDigest,
  evidenceReferenceKey,
  isSortedUniqueBy,
  topLevelRecordSchema,
} from "./common.js";
import {
  BENCHMARKING_PROTOCOL_V2,
} from "./identifiers.js";
import {
  parseExactWithSchema,
  sealWithSchema,
  type SealedRecord,
} from "./sealing.js";

const AdapterSchema = z.strictObject({
  id: AbsoluteIriSchema,
  version: NonEmptyStringSchema,
  mappingVersion: NonEmptyStringSchema,
});

const LaunchExecutableSchema = z.strictObject({
  path: NonEmptyStringSchema,
  artifact: DigestBearingResourceDescriptorSchema,
});

const EnvironmentEntrySchema = z.strictObject({
  name: NonEmptyStringSchema,
  value: z.string(),
});

const InvocationSchema = z.strictObject({
  executable: LaunchExecutableSchema,
  argv: z.array(z.string().refine((value) => !value.includes("\u0000"))),
  environment: z.array(EnvironmentEntrySchema),
  workingDirectoryPolicy: z.enum([
    "sealed-source-root",
    "isolated-workspace",
    "adapter-controlled",
  ]),
  runtimeClosure: z.array(DigestBearingResourceDescriptorSchema),
}).superRefine((value, ctx) => {
  if (!isSortedUniqueBy(value.environment, (entry) => entry.name)) {
    ctx.addIssue({
      code: "custom",
      path: ["environment"],
      message: "environment must be sorted and unique by name",
    });
  }
  if (!isSortedUniqueBy(value.runtimeClosure, descriptorDigest)) {
    ctx.addIssue({
      code: "custom",
      path: ["runtimeClosure"],
      message: "runtime closure must be sorted and unique by digest",
    });
  }
});

const ExpectedScopeSchema = z.strictObject({
  unitKind: NonEmptyStringSchema,
  nativeGroupId: NativeIdentifierSchema.optional(),
  expectedUnitCount: z.number().int().nonnegative().optional(),
  scope: DigestBearingResourceDescriptorSchema,
});

const PrivacyPolicySchema = z.strictObject({
  policy: DigestBearingResourceDescriptorSchema,
  publication: z.enum(["local-only", "transport-neutral", "public"]),
  defaultAvailability: z.enum([
    "public-exact",
    "digest-only",
    "scrub-derived",
    "source-absent",
  ]),
  lowEntropyDigestPolicy: z.enum(["forbid", "explicit-review"]),
});

export const ExecutionBatchIntentSchema = topLevelRecordSchema({
  protocol: z.literal(BENCHMARKING_PROTOCOL_V2),
  owner: AbsoluteIriSchema,
  adapter: AdapterSchema,
  invocation: InvocationSchema,
  source: DigestBearingResourceDescriptorSchema,
  expectedScope: ExpectedScopeSchema,
  privacy: PrivacyPolicySchema,
  publicRegistration: DigestBearingResourceDescriptorSchema.optional(),
  sealedAt: TimestampSchema,
});

const NativeUnitSchema = z.strictObject({
  unitKey: NonEmptyStringSchema,
  identifiers: z.array(NativeIdentifierSchema),
  status: z.enum(["captured", "failed", "tombstone", "excluded"]),
  executionEvidence: EvidenceRecordReferenceSchema.optional(),
  projectedEvaluations: z.array(EvidenceRecordReferenceSchema),
  limitations: z.array(NonEmptyStringSchema),
}).superRefine((unit, ctx) => {
  if (!isSortedUniqueBy(unit.identifiers, (id) => `${id.scheme}\u0000${id.value}`)) {
    ctx.addIssue({
      code: "custom",
      path: ["identifiers"],
      message: "identifiers must be sorted and unique",
    });
  }
  if (!isSortedUniqueBy(unit.projectedEvaluations, evidenceReferenceKey)) {
    ctx.addIssue({
      code: "custom",
      path: ["projectedEvaluations"],
      message: "evaluation references must be sorted and unique",
    });
  }
  if (!isSortedUniqueBy(unit.limitations, (value) => value)) {
    ctx.addIssue({
      code: "custom",
      path: ["limitations"],
      message: "limitations must be sorted and unique",
    });
  }
  if (unit.status === "captured") {
    if (unit.executionEvidence?.family !== "execution-evidence") {
      ctx.addIssue({
        code: "custom",
        path: ["executionEvidence"],
        message: "captured unit requires an execution-evidence reference",
      });
    }
  } else if (unit.executionEvidence !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["executionEvidence"],
      message: "non-captured unit must not claim execution evidence",
    });
  }
  unit.projectedEvaluations.forEach((reference, index) => {
    if (reference.family !== "result-evaluation") {
      ctx.addIssue({
        code: "custom",
        path: ["projectedEvaluations", index, "family"],
        message: "projected evaluation must be a result-evaluation",
      });
    }
  });
});

const ClosureCheckSchema = z.strictObject({
  name: NonEmptyStringSchema,
  status: z.enum(["pass", "fail", "indeterminate"]),
  explanation: NonEmptyStringSchema.optional(),
});

const CaptureClosureSchema = z.strictObject({
  inventoryCount: z.number().int().nonnegative(),
  capturedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  tombstoneCount: z.number().int().nonnegative(),
  excludedCount: z.number().int().nonnegative(),
  checks: z.array(ClosureCheckSchema),
});

export const ExecutionBatchCaptureSchema = topLevelRecordSchema({
  protocol: z.literal(BENCHMARKING_PROTOCOL_V2),
  intent: DigestBearingResourceDescriptorSchema.optional(),
  owner: AbsoluteIriSchema,
  adapter: AdapterSchema,
  source: DigestBearingResourceDescriptorSchema,
  nativeGroup: NativeIdentifierSchema.optional(),
  units: z.array(NativeUnitSchema),
  closure: CaptureClosureSchema,
  assurance: CaptureAssuranceSchema,
  capturedAt: TimestampSchema,
}).superRefine((capture, ctx) => {
  if (!isSortedUniqueBy(capture.units, (unit) => unit.unitKey)) {
    ctx.addIssue({
      code: "custom",
      path: ["units"],
      message: "units must be sorted and unique by unitKey",
    });
  }
  const counts = {
    captured: 0,
    failed: 0,
    tombstone: 0,
    excluded: 0,
  };
  for (const unit of capture.units) counts[unit.status] += 1;
  if (capture.closure.inventoryCount !== capture.units.length) {
    ctx.addIssue({
      code: "custom",
      path: ["closure", "inventoryCount"],
      message: "inventoryCount must equal units.length",
    });
  }
  for (const [status, field] of [
    ["captured", "capturedCount"],
    ["failed", "failedCount"],
    ["tombstone", "tombstoneCount"],
    ["excluded", "excludedCount"],
  ] as const) {
    if (capture.closure[field] !== counts[status]) {
      ctx.addIssue({
        code: "custom",
        path: ["closure", field],
        message: `${field} does not match unit inventory`,
      });
    }
  }
  if (!isSortedUniqueBy(capture.closure.checks, (check) => check.name)) {
    ctx.addIssue({
      code: "custom",
      path: ["closure", "checks"],
      message: "closure checks must be sorted and unique by name",
    });
  }
});

export type ExecutionBatchIntent = z.infer<
  typeof ExecutionBatchIntentSchema
>;
export type ExecutionBatchCapture = z.infer<
  typeof ExecutionBatchCaptureSchema
>;

export function sealExecutionBatchIntent(document: unknown): SealedRecord {
  return sealWithSchema(ExecutionBatchIntentSchema, document);
}

export function parseExecutionBatchIntent(
  bytes: Uint8Array,
): ExecutionBatchIntent {
  return parseExactWithSchema(ExecutionBatchIntentSchema, bytes);
}

export function sealExecutionBatchCapture(document: unknown): SealedRecord {
  return sealWithSchema(ExecutionBatchCaptureSchema, document);
}

export function parseExecutionBatchCapture(
  bytes: Uint8Array,
): ExecutionBatchCapture {
  return parseExactWithSchema(ExecutionBatchCaptureSchema, bytes);
}
