// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the second `truthAdmission` copy and the second replacement-ledger `reason` copy,
 * both on the published bundle-qualification document (`BundleQualificationSchema`), that the
 * screened-operator-sampled admission branch widens (judge-path program packet P6, spec
 * `docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md` §6.8, §10 rows 13/18/22).
 * `BUNDLE_QUALIFICATION_FORMAT` does not move (§0.4): existing documents still validate and seal
 * byte-identically, asserted below.
 *
 * The `publicationGrade` coupling (`schema.ts`'s `superRefine` requiring the third branch to be
 * publication-grade) and the evidence-role/authority-set coupling for a screened admission
 * (§6.8a Group A/C) are out of this packet's declarative-foundation scope — a full, validating
 * screened `BundleQualificationSchema` document therefore cannot be constructed yet, so the two
 * widened fields are tested in isolation via `.shape`, which zod exposes even through the
 * schema's `superRefine`.
 *
 * All digests here are synthetic: `"sha256:" + hex(seed)`, never a real dataset row.
 */

import { describe, expect, test } from "vitest";
import { canonicalJsonBytes } from "@jinn-network/task-execution-profiles";
import { BUNDLE_QUALIFICATION_FORMAT, BundleQualificationSchema } from "./schema.js";

function shaDigest(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, "0")}`;
}

/** Minimal valid operator-only document, mirroring `profile/binary-qualification.test.ts`'s
 * `bundleQualification` builder — the smallest legal admission-record closure. */
function bundleQualification(): Record<string, unknown> {
  const arms = [
    { armId: "arm-01", instrumentSha256: shaDigest(200000) },
    { armId: "arm-02", instrumentSha256: shaDigest(200001) },
  ];
  const admissionManifestSha256 = shaDigest(1);
  const admissionRecords = [
    { sha256: admissionManifestSha256, roles: ["admission-manifest"] as const },
    { sha256: shaDigest(2), roles: ["replacement-ledger"] as const },
    { sha256: shaDigest(3), roles: ["human-review-evaluation-spec"] as const },
    { sha256: shaDigest(4), roles: ["human-review-form"] as const },
    { sha256: shaDigest(5), roles: ["operator-assertion"] as const },
  ];
  return {
    format: BUNDLE_QUALIFICATION_FORMAT,
    claimSchema: "benchmark-product.claim-package/2" as const,
    sourceManifestSha256: shaDigest(6),
    admissionManifestSha256,
    publicationGrade: false,
    truthAdmission: "operator-only" as const,
    candidateClasses: ["alpha"],
    strata: ["core", "stress"] as const,
    arms,
    items: [],
    exclusions: [],
    admissionRecords,
    reachableSha256s: admissionRecords.map((entry) => entry.sha256),
  };
}

describe("BundleQualificationSchema truthAdmission and reason widening (§6.8, §10 rows 13/18/22)", () => {
  test("byte-compat proof: an existing operator-only qualification document seals identically", () => {
    const parsed = BundleQualificationSchema.parse(bundleQualification());
    expect(new TextDecoder().decode(canonicalJsonBytes(parsed))).toBe(
      '{"admissionManifestSha256":"sha256:' + (1).toString(16).padStart(64, "0")
      + '","admissionRecords":[{"roles":["admission-manifest"],"sha256":"sha256:' + (1).toString(16).padStart(64, "0")
      + '"},{"roles":["replacement-ledger"],"sha256":"sha256:' + (2).toString(16).padStart(64, "0")
      + '"},{"roles":["human-review-evaluation-spec"],"sha256":"sha256:' + (3).toString(16).padStart(64, "0")
      + '"},{"roles":["human-review-form"],"sha256":"sha256:' + (4).toString(16).padStart(64, "0")
      + '"},{"roles":["operator-assertion"],"sha256":"sha256:' + (5).toString(16).padStart(64, "0")
      + '"}],"arms":[{"armId":"arm-01","instrumentSha256":"sha256:' + (200000).toString(16).padStart(64, "0")
      + '"},{"armId":"arm-02","instrumentSha256":"sha256:' + (200001).toString(16).padStart(64, "0")
      + '"}],"candidateClasses":["alpha"],"claimSchema":"benchmark-product.claim-package/2","exclusions":[],'
      + '"format":"benchmark-product-binary-qualification/1","items":[],"publicationGrade":false,'
      + '"reachableSha256s":["sha256:' + (1).toString(16).padStart(64, "0") + '","sha256:' + (2).toString(16).padStart(64, "0")
      + '","sha256:' + (3).toString(16).padStart(64, "0") + '","sha256:' + (4).toString(16).padStart(64, "0")
      + '","sha256:' + (5).toString(16).padStart(64, "0")
      + '"],"sourceManifestSha256":"sha256:' + (6).toString(16).padStart(64, "0")
      + '","strata":["core","stress"],"truthAdmission":"operator-only"}',
    );
  });

  test("the truthAdmission field, in isolation, now accepts screened-operator-sampled", () => {
    expect(BundleQualificationSchema.shape.truthAdmission.safeParse("screened-operator-sampled").success)
      .toBe(true);
    expect(BundleQualificationSchema.shape.truthAdmission.safeParse("two-human-unanimous").success)
      .toBe(true);
    expect(BundleQualificationSchema.shape.truthAdmission.safeParse("operator-only").success)
      .toBe(true);
    expect(BundleQualificationSchema.shape.truthAdmission.safeParse("some-other-mode").success)
      .toBe(false);
  });

  test("the exclusions[].reason field, in isolation, now accepts the three new screening-* values", () => {
    const reasonField = BundleQualificationSchema.shape.exclusions.element.shape.reason;
    for (const reason of ["screening-disagreement", "screening-indeterminate", "screening-hand-excluded"]) {
      expect(reasonField.safeParse(reason).success).toBe(true);
    }
    for (const reason of ["review-disagreement", "review-indeterminate", "review-incomplete"]) {
      expect(reasonField.safeParse(reason).success).toBe(true);
    }
    expect(reasonField.safeParse("some-other-reason").success).toBe(false);
  });
});
