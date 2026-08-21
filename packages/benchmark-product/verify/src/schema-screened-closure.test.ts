// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the screened-operator-sampled admission-closure schema rules that P6's declarative
 * foundation (packet S1) deliberately left unenforceable (judge-path program packet P6, spec
 * `docs/superpowers/specs/2026-08-19-judge-path-delta-contracts.md` §6.8a Group A third bullet and
 * Group C):
 *
 * - `BundleQualificationSchema`'s `publicationGrade`/`truthAdmission` `superRefine` (§6.8) gains an
 *   explicit third branch: `screened-operator-sampled` MUST be publication-grade.
 * - `BundleQualificationSchema`'s evidence-set `superRefine` (§6.8a Group C) gains a third branch:
 *   exactly the two screening roles, no human-review evidence, no operator assertion.
 * - `BundleV4TrustSchema`'s authority-roles `superRefine` (§6.8a Group C) gains a third legal
 *   authority set: `["truth-reveal-attestor"]` alone.
 *
 * Before this packet, none of the three above had a screened-shaped branch, so a full, validating
 * screened `BundleQualificationSchema` document could not be constructed at all (per
 * `schema-truth-admission-widening.test.ts`'s own note). This file constructs one for the first
 * time and proves it round-trips.
 *
 * All digests here are synthetic: `"sha256:" + hex(seed)`, never a real dataset row.
 */

import { describe, expect, test } from "vitest";
import { BUNDLE_QUALIFICATION_FORMAT, BundleQualificationSchema, BundleV4TrustSchema } from "./schema.js";

function shaDigest(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, "0")}`;
}

/** Minimal valid screened-operator-sampled document: five screening records, the two frozen
 * human-review records G-5 requires unconditionally for every mode, and no human-review evidence
 * or operator assertion (spec §6.8a Group C). */
function screenedBundleQualification(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
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
    { sha256: shaDigest(7), roles: ["screening-table"] as const },
    { sha256: shaDigest(8), roles: ["screening-reveal-receipt"] as const },
    { sha256: shaDigest(9), roles: ["screening-instrument"] as const },
    { sha256: shaDigest(10), roles: ["screening-sampling-script"] as const },
    { sha256: shaDigest(11), roles: ["screening-raw-outputs"] as const },
  ];
  return {
    format: BUNDLE_QUALIFICATION_FORMAT,
    claimSchema: "benchmark-product.claim-package/2" as const,
    sourceManifestSha256: shaDigest(6),
    admissionManifestSha256,
    publicationGrade: true,
    truthAdmission: "screened-operator-sampled" as const,
    candidateClasses: ["alpha"],
    strata: ["core", "stress"] as const,
    arms,
    items: [],
    exclusions: [],
    admissionRecords,
    reachableSha256s: admissionRecords.map((entry) => entry.sha256),
    ...overrides,
  };
}

describe("BundleQualificationSchema screened-operator-sampled closure (§6.8, §6.8a Group A/C)", () => {
  test("a minimal, fully-formed screened document validates end to end", () => {
    const result = BundleQualificationSchema.safeParse(screenedBundleQualification());
    expect(result.success, result.success ? "" : JSON.stringify(result.error.issues)).toBe(true);
  });

  test("§6.8: screened-operator-sampled with publicationGrade false refuses", () => {
    expect(BundleQualificationSchema.safeParse(
      screenedBundleQualification({ publicationGrade: false }),
    ).success).toBe(false);
  });

  test("§6.8a Group C: a screened document carrying any human-review evidence role refuses", () => {
    const document = screenedBundleQualification();
    (document["admissionRecords"] as unknown[]).push({ sha256: shaDigest(9), roles: ["human-review-packet"] });
    (document["reachableSha256s"] as unknown[]).push(shaDigest(9));
    expect(BundleQualificationSchema.safeParse(document).success).toBe(false);
  });

  test("§6.8a Group C: a screened document carrying an operator assertion refuses", () => {
    const document = screenedBundleQualification();
    (document["admissionRecords"] as unknown[]).push({ sha256: shaDigest(9), roles: ["operator-assertion"] });
    (document["reachableSha256s"] as unknown[]).push(shaDigest(9));
    expect(BundleQualificationSchema.safeParse(document).success).toBe(false);
  });

  test("§6.8a Group C: a screened document missing the screening-table role refuses", () => {
    const document = screenedBundleQualification();
    document["admissionRecords"] = (document["admissionRecords"] as { sha256: string; roles: string[] }[])
      .filter((entry) => !entry.roles.includes("screening-table"));
    document["reachableSha256s"] = (document["admissionRecords"] as { sha256: string }[]).map((entry) => entry.sha256);
    expect(BundleQualificationSchema.safeParse(document).success).toBe(false);
  });

  test("§6.8a Group C: a screened document missing the screening-reveal-receipt role refuses", () => {
    const document = screenedBundleQualification();
    document["admissionRecords"] = (document["admissionRecords"] as { sha256: string; roles: string[] }[])
      .filter((entry) => !entry.roles.includes("screening-reveal-receipt"));
    document["reachableSha256s"] = (document["admissionRecords"] as { sha256: string }[]).map((entry) => entry.sha256);
    expect(BundleQualificationSchema.safeParse(document).success).toBe(false);
  });

  test.each(["screening-instrument", "screening-sampling-script", "screening-raw-outputs"])(
    "§6.8a Group C: a screened document missing the %s role refuses",
    (role) => {
      const document = screenedBundleQualification();
      document["admissionRecords"] = (document["admissionRecords"] as { sha256: string; roles: string[] }[])
        .filter((entry) => !entry.roles.includes(role));
      document["reachableSha256s"] = (document["admissionRecords"] as { sha256: string }[]).map((entry) => entry.sha256);
      expect(BundleQualificationSchema.safeParse(document).success).toBe(false);
    },
  );

  test("byte-compat: the existing two-human and operator-only publicationGrade rules are unmoved", () => {
    // Mirrors `binary-qualification.test.ts`'s bundleQualification() shape at armCount 2.
    const twoHuman = {
      format: BUNDLE_QUALIFICATION_FORMAT,
      claimSchema: "benchmark-product.claim-package/2" as const,
      sourceManifestSha256: shaDigest(6),
      admissionManifestSha256: shaDigest(1),
      publicationGrade: false,
      truthAdmission: "two-human-unanimous" as const,
      candidateClasses: ["alpha"],
      strata: ["core", "stress"] as const,
      arms: [
        { armId: "arm-01", instrumentSha256: shaDigest(200000) },
        { armId: "arm-02", instrumentSha256: shaDigest(200001) },
      ],
      items: [],
      exclusions: [],
      admissionRecords: [],
      reachableSha256s: [],
    };
    expect(BundleQualificationSchema.safeParse(twoHuman).success).toBe(false); // publicationGrade must be true
    expect(BundleQualificationSchema.safeParse({ ...twoHuman, truthAdmission: "operator-only", publicationGrade: true }).success)
      .toBe(false); // publicationGrade must be false
  });
});

describe("BundleV4TrustSchema authority roles (§6.8a Group C)", () => {
  const reportKeyId = "key-report-1";
  function trust(authorities: readonly { readonly role: string; readonly keyId: string }[]): Record<string, unknown> {
    return {
      format: "benchmark-product-public-trust/4",
      selfRun: {
        custody: "workspace-minted",
        evaluatorDistinctness: "agent-distinctness-only",
        partyIndependence: "not-established",
      },
      report: {
        keyId: reportKeyId,
        algorithm: "ed25519",
        spkiDerBase64: "AAAA",
        author: "report-author",
        didKey: "did:key:zReport",
        validFrom: "2026-08-20T09:00:00.000Z",
      },
      evaluators: [],
      admission: {
        reviewers: [],
        authorities,
      },
    };
  }

  test("the third legal set, [truth-reveal-attestor] alone, now validates", () => {
    expect(BundleV4TrustSchema.safeParse(
      trust([{ role: "truth-reveal-attestor", keyId: reportKeyId }]),
    ).success).toBe(true);
  });

  test("byte-compat: the existing human pair and operator-only set still validate", () => {
    expect(BundleV4TrustSchema.safeParse(trust([
      { role: "roster-attestor", keyId: reportKeyId },
      { role: "truth-reveal-attestor", keyId: reportKeyId },
    ])).success).toBe(true);
    expect(BundleV4TrustSchema.safeParse(trust([
      { role: "operator-truth-attestor", keyId: reportKeyId },
    ])).success).toBe(true);
  });

  test("a roster-attestor alone (not the screened set) still refuses", () => {
    expect(BundleV4TrustSchema.safeParse(
      trust([{ role: "roster-attestor", keyId: reportKeyId }]),
    ).success).toBe(false);
  });
});
