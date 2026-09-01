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
import {
  BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE,
  BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE,
  CLAIM_PACKAGE_V3_PROFILE,
} from "./identifiers.js";
import { isJsonValue } from "./json.js";
import { parseExactWithSchema, sealWithSchema, type SealedRecord } from "./sealing.js";

const JsonValueSchema = z.unknown().refine(isJsonValue, "must be losslessly representable I-JSON");

const TrustSignerSchema = z.strictObject({
  keyId: NonEmptyStringSchema,
  identity: AbsoluteIriSchema,
  purpose: z.enum(["report", "automated-evaluator", "human-reviewer", "label-admission"]),
  publicKey: DigestBearingResourceDescriptorSchema,
  algorithm: z.literal("ed25519"),
});

export const EvidenceNativeClaimPackageV3Schema = topLevelRecordSchema({
  claimSchema: z.literal("benchmark-product.claim-package/3"),
  profile: z.literal(CLAIM_PACKAGE_V3_PROFILE),
  records: z.strictObject({
    benchmark: DigestBearingResourceDescriptorSchema,
    manifest: DigestBearingResourceDescriptorSchema,
    cohort: DigestBearingResourceDescriptorSchema,
    matrix: DigestBearingResourceDescriptorSchema,
    reportPayload: DigestBearingResourceDescriptorSchema,
    reportEnvelope: DigestBearingResourceDescriptorSchema,
    evidence: z.array(EvidenceRecordReferenceSchema),
    artifacts: z.array(DigestBearingResourceDescriptorSchema),
  }),
  method: z.strictObject({
    id: NonEmptyStringSchema,
    version: NonEmptyStringSchema,
    parameters: JsonValueSchema,
  }),
  results: JsonValueSchema,
  closure: z.strictObject({
    status: z.enum(["complete-relative-to-sealed-source", "partial", "indeterminate", "failed"]),
    candidateCount: z.number().int().nonnegative(),
    admittedCount: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative(),
    unavailableCount: z.number().int().nonnegative(),
    limitations: z.array(NonEmptyStringSchema),
  }),
  trust: z.strictObject({
    signers: z.array(TrustSignerSchema),
    policy: DigestBearingResourceDescriptorSchema.optional(),
    signatureValidityIsNotAuthorization: z.literal(true),
  }),
  verification: z.strictObject({
    checks: z.tuple([
      z.literal("manifest"),
      z.literal("evidence-closure"),
      z.literal("artifact-integrity"),
      z.literal("signature-validity"),
      z.literal("matrix-rederivation"),
      z.literal("report-verification"),
      z.literal("claim-consistency"),
    ]),
    command: NonEmptyStringSchema,
  }),
  issuedAt: TimestampSchema,
}).superRefine((claim, ctx) => {
  if (!isSortedUniqueBy(claim.records.evidence, evidenceReferenceKey)) {
    ctx.addIssue({ code: "custom", path: ["records", "evidence"], message: "evidence must be sorted and unique" });
  }
  if (!isSortedUniqueBy(claim.records.artifacts, (artifact) => artifact.digest.sha256)) {
    ctx.addIssue({ code: "custom", path: ["records", "artifacts"], message: "artifacts must be sorted and unique by digest" });
  }
  if (!isSortedUniqueBy(claim.trust.signers, (signer) => signer.keyId)) {
    ctx.addIssue({ code: "custom", path: ["trust", "signers"], message: "signers must be sorted and unique by keyId" });
  }
});

export type EvidenceNativeClaimPackageV3 = z.infer<typeof EvidenceNativeClaimPackageV3Schema>;

/**
 * The two declared profiles of `benchmark-product-public-bundle/5` (issue #2986). The profile is
 * carried in the bundle's own bytes, so which members a reader must find is a fact the bundle
 * states rather than one the reader infers from what happens to be present.
 */
export const EvidenceNativeBundleProfileSchema = z.union([
  z.literal(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE),
  z.literal(BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE),
]);

export type EvidenceNativeBundleProfile = z.infer<typeof EvidenceNativeBundleProfileSchema>;

/** True exactly for the metadata-first profile; a narrowing so no call site re-spells the IRI. */
export function isMetadataFirstBundleProfile(
  profile: EvidenceNativeBundleProfile,
): profile is typeof BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE {
  return profile === BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE;
}

export const EvidenceNativeBundleManifestV5Schema = z.strictObject({
  format: z.literal("benchmark-product-public-bundle/5"),
  profile: EvidenceNativeBundleProfileSchema,
  files: z.array(z.strictObject({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bytes: z.number().int().nonnegative(),
  })).min(1),
}).superRefine((manifest, ctx) => {
  if (!isSortedUniqueBy(manifest.files, (file) => file.path)) {
    ctx.addIssue({ code: "custom", path: ["files"], message: "files must be sorted and unique by path" });
  }
});

export type EvidenceNativeBundleManifestV5 = z.infer<typeof EvidenceNativeBundleManifestV5Schema>;

export function sealEvidenceNativeClaimPackageV3(document: unknown): SealedRecord {
  return sealWithSchema(EvidenceNativeClaimPackageV3Schema, document);
}

export function parseEvidenceNativeClaimPackageV3(bytes: Uint8Array): EvidenceNativeClaimPackageV3 {
  return parseExactWithSchema(EvidenceNativeClaimPackageV3Schema, bytes);
}

export function sealEvidenceNativeBundleManifestV5(document: unknown): SealedRecord {
  return sealWithSchema(EvidenceNativeBundleManifestV5Schema, document);
}

export function parseEvidenceNativeBundleManifestV5(bytes: Uint8Array): EvidenceNativeBundleManifestV5 {
  return parseExactWithSchema(EvidenceNativeBundleManifestV5Schema, bytes);
}
