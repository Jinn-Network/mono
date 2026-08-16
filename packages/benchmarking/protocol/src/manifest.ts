// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  AbsoluteIriSchema,
  DecimalStringSchema,
  DigestBearingResourceDescriptorSchema,
  NonEmptyStringSchema,
  TimestampSchema,
  TypedRecordReferenceSchema,
  descriptorDigest,
  isSortedUniqueBy,
  topLevelRecordSchema,
  typedReferenceKey,
} from "./common.js";
import { BENCHMARKING_PROTOCOL_V2 } from "./identifiers.js";
import { isJsonValue } from "./json.js";
import {
  parseExactWithSchema,
  sealWithSchema,
  type SealedRecord,
} from "./sealing.js";

const JsonValueSchema = z.unknown().refine(isJsonValue, {
  message: "must be losslessly representable I-JSON",
});

const SourceBoundarySchema = z.strictObject({
  source: TypedRecordReferenceSchema,
  cursor: DigestBearingResourceDescriptorSchema.optional(),
  cutoff: TimestampSchema.optional(),
});

const ComparisonGroupSchema = z.strictObject({
  groupId: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u),
  selection: DigestBearingResourceDescriptorSchema,
  description: z.string().optional(),
});

const MultiplicityPolicySchema = z.strictObject({
  correlationUnit: z.enum([
    "execution",
    "native-retry-family",
    "task-executor",
    "declared-cluster",
  ]),
  duplicatePolicy: z.enum(["reject", "retain-distinct", "collapse-exact"]),
  retryPolicy: z.enum(["independent", "correlated", "exclude-retries"]),
  assignmentPolicy: DigestBearingResourceDescriptorSchema,
});

const EvaluatorAdmissionSchema = z.strictObject({
  evaluatorAllowlist: z.array(AbsoluteIriSchema),
  methodAllowlist: z.array(DigestBearingResourceDescriptorSchema),
  minimumClaims: z.number().int().positive(),
  distinctEvaluators: z.boolean(),
  humanLabelPolicy: z.enum([
    "not-required",
    "two-human-unanimous",
    "registered-adjudication",
  ]),
  conflictPolicy: z.enum([
    "preserve-unresolved",
    "quorum",
    "registered-resolution",
  ]),
  supersessionPolicy: z.enum([
    "preserve-all",
    "same-evaluator-explicit-only",
  ]),
  trustPolicy: DigestBearingResourceDescriptorSchema,
});

const VerificationAdmissionSchema = z.strictObject({
  requiredChecks: z.array(NonEmptyStringSchema),
  trustPolicy: DigestBearingResourceDescriptorSchema,
  failurePolicy: z.enum(["exclude", "disclose", "fail-analysis"]),
});

const CompletenessPolicySchema = z.strictObject({
  required: z.enum(["complete", "partial-allowed", "accounting-only"]),
  unavailableSource: z.enum(["fail", "indeterminate"]),
  discoveredOmission: z.literal("fail"),
  excludedMember: z.enum(["count-attrition", "fail"]),
  minimumFraction: DecimalStringSchema.optional(),
});

const AnalysisMethodSchema = z.strictObject({
  id: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
  parameters: JsonValueSchema,
});

export const BenchmarkAnalysisManifestSchema = topLevelRecordSchema({
  protocol: z.literal(BENCHMARKING_PROTOCOL_V2),
  benchmark: DigestBearingResourceDescriptorSchema,
  owner: AbsoluteIriSchema,
  sources: z.array(SourceBoundarySchema).min(1),
  groups: z.array(ComparisonGroupSchema).min(1),
  taskRelation: z.strictObject({
    exactDigestRequired: z.boolean(),
    semanticEquivalence: DigestBearingResourceDescriptorSchema.optional(),
  }),
  multiplicity: MultiplicityPolicySchema,
  evaluationAdmission: EvaluatorAdmissionSchema,
  verificationAdmission: VerificationAdmissionSchema,
  completeness: CompletenessPolicySchema,
  analysisPlan: z.array(AnalysisMethodSchema),
  closeAt: TimestampSchema,
  preregistration: z.enum([
    "prospectively-registered",
    "local-sealed-before-selection",
    "post-hoc-exploratory",
    "unverifiable",
  ]),
}).superRefine((manifest, ctx) => {
  if (!isSortedUniqueBy(manifest.sources, (source) => typedReferenceKey(source.source))) {
    ctx.addIssue({
      code: "custom",
      path: ["sources"],
      message: "sources must be sorted and unique",
    });
  }
  if (!isSortedUniqueBy(manifest.groups, (group) => group.groupId)) {
    ctx.addIssue({
      code: "custom",
      path: ["groups"],
      message: "groups must be sorted and unique by groupId",
    });
  }
  if (
    !manifest.taskRelation.exactDigestRequired &&
    manifest.taskRelation.semanticEquivalence === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["taskRelation", "semanticEquivalence"],
      message: "non-exact task relation requires a sealed semantic-equivalence method",
    });
  }
  const admission = manifest.evaluationAdmission;
  if (!isSortedUniqueBy(admission.evaluatorAllowlist, (value) => value)) {
    ctx.addIssue({
      code: "custom",
      path: ["evaluationAdmission", "evaluatorAllowlist"],
      message: "evaluator allowlist must be sorted and unique",
    });
  }
  if (!isSortedUniqueBy(admission.methodAllowlist, descriptorDigest)) {
    ctx.addIssue({
      code: "custom",
      path: ["evaluationAdmission", "methodAllowlist"],
      message: "method allowlist must be sorted and unique by digest",
    });
  }
  if (
    !isSortedUniqueBy(
      manifest.verificationAdmission.requiredChecks,
      (value) => value,
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["verificationAdmission", "requiredChecks"],
      message: "required checks must be sorted and unique",
    });
  }
  if (
    !isSortedUniqueBy(
      manifest.analysisPlan,
      (method) => `${method.id}\u0000${method.version}`,
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["analysisPlan"],
      message: "analysis methods must be sorted and unique by id and version",
    });
  }
});

export type BenchmarkAnalysisManifest = z.infer<
  typeof BenchmarkAnalysisManifestSchema
>;

export function sealBenchmarkAnalysisManifest(document: unknown): SealedRecord {
  return sealWithSchema(BenchmarkAnalysisManifestSchema, document);
}

export function parseBenchmarkAnalysisManifest(
  bytes: Uint8Array,
): BenchmarkAnalysisManifest {
  return parseExactWithSchema(BenchmarkAnalysisManifestSchema, bytes);
}
