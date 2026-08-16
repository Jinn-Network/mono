import { describe, expect, test } from "vitest";
import {
  BUNDLE_QUALIFICATION_FORMAT,
  BUNDLE_V4_EVIDENCE_FORMAT,
  BUNDLE_V4_TRUST_FORMAT,
  BundleQualificationSchema,
  BundleV4EvidenceCatalogSchema,
  BundleV4TrustSchema,
} from "./schema.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function operatorQualification() {
  const admissionRecords = [
    { sha256: digest("1"), roles: ["admission-manifest"] },
    { sha256: digest("2"), roles: ["replacement-ledger"] },
    { sha256: digest("3"), roles: ["source-item"] },
    { sha256: digest("4"), roles: ["label-resolution"] },
    { sha256: digest("5"), roles: ["analysis-context"] },
    { sha256: digest("6"), roles: ["human-review-evaluation-spec"] },
    { sha256: digest("7"), roles: ["human-review-form"] },
    { sha256: digest("8"), roles: ["operator-assertion"] },
  ];
  return {
    format: BUNDLE_QUALIFICATION_FORMAT,
    claimSchema: "benchmark-product.claim-package/2",
    sourceManifestSha256: digest("f"),
    admissionManifestSha256: digest("1"),
    publicationGrade: false,
    truthAdmission: "operator-only",
    candidateClasses: ["factuality"],
    strata: ["core", "stress"],
    arms: ["arm-a", "arm-b", "arm-c", "arm-d"].map((armId, index) => ({
      armId,
      instrumentSha256: digest(["9", "a", "b", "c"][index]!),
    })),
    items: [{
      taskSha256: digest("d"),
      itemSha256: digest("3"),
      labelResolutionSha256: digest("4"),
      analysisContextSha256: digest("5"),
    }],
    exclusions: [],
    admissionRecords,
    reachableSha256s: admissionRecords.map((entry) => entry.sha256),
  };
}

function v4Trust() {
  return {
    format: BUNDLE_V4_TRUST_FORMAT,
    selfRun: {
      custody: "workspace-minted",
      evaluatorDistinctness: "agent-distinctness-only",
      partyIndependence: "not-established",
    },
    report: {
      author: "urn:jinn:operator",
      didKey: "did:key:zReport",
      keyId: "did:key:zReport",
      algorithm: "ed25519",
      spkiDerBase64: "MCowBQYDK2VwAyEAreport",
      validFrom: "2026-08-15T00:00:00Z",
    },
    evaluators: [{
      evaluator: "urn:jinn:evaluator:run",
      keyId: "did:key:zRun",
      algorithm: "ed25519",
      spkiDerBase64: "MCowBQYDK2VwAyEArun",
    }],
    admission: {
      reviewers: [],
      authorities: [{ role: "operator-truth-attestor", keyId: "did:key:zReport" }],
    },
  };
}

describe("public bundle v4 contracts", () => {
  test("accepts one exact semantic admission graph and refuses missing, extra, and role-swapped records", () => {
    const valid = operatorQualification();
    expect(BundleQualificationSchema.safeParse(valid).success).toBe(true);

    const missing = structuredClone(valid) as any;
    missing.admissionRecords.pop();
    expect(BundleQualificationSchema.safeParse(missing).success).toBe(false);

    const extra = structuredClone(valid) as any;
    extra.admissionRecords.push({ sha256: digest("d"), roles: ["source-item"] });
    expect(BundleQualificationSchema.safeParse(extra).success).toBe(false);

    const swapped = structuredClone(valid) as any;
    swapped.admissionRecords[2].roles = ["label-resolution"];
    swapped.admissionRecords[3].roles = ["source-item"];
    expect(BundleQualificationSchema.safeParse(swapped).success).toBe(false);
  });

  test("refuses duplicate, unsorted, and dangling v4 trust bindings", () => {
    const valid = v4Trust();
    expect(BundleV4TrustSchema.safeParse(valid).success).toBe(true);

    expect(BundleV4TrustSchema.safeParse({ ...valid, unregistered: true }).success).toBe(false);
    expect(BundleV4TrustSchema.safeParse({ ...valid, report: { ...valid.report, unregistered: true } }).success).toBe(false);

    const duplicate = structuredClone(valid) as any;
    duplicate.evaluators.push({ ...duplicate.evaluators[0] });
    expect(BundleV4TrustSchema.safeParse(duplicate).success).toBe(false);

    const danglingReviewer = structuredClone(valid) as any;
    danglingReviewer.admission.reviewers = [
      { evaluator: "urn:jinn:reviewer:a", keyId: "did:key:zMissingA" },
      { evaluator: "urn:jinn:reviewer:b", keyId: "did:key:zMissingB" },
    ];
    expect(BundleV4TrustSchema.safeParse(danglingReviewer).success).toBe(false);

    const wrongAuthority = structuredClone(valid) as any;
    wrongAuthority.admission.authorities[0].keyId = "did:key:zRun";
    expect(BundleV4TrustSchema.safeParse(wrongAuthority).success).toBe(false);
  });

  test("freezes evidence-record and role order", () => {
    const valid = {
      format: BUNDLE_V4_EVIDENCE_FORMAT,
      records: [
        { sha256: "1".repeat(64), roles: ["task", "source-item"] },
        { sha256: "2".repeat(64), roles: ["admission-manifest"] },
      ],
    };
    expect(BundleV4EvidenceCatalogSchema.safeParse(valid).success).toBe(true);

    expect(BundleV4EvidenceCatalogSchema.safeParse({ ...valid, records: [...valid.records].reverse() }).success).toBe(false);
    const roleOrder = structuredClone(valid) as any;
    roleOrder.records[0].roles.reverse();
    expect(BundleV4EvidenceCatalogSchema.safeParse(roleOrder).success).toBe(false);
    const duplicate = structuredClone(valid) as any;
    duplicate.records.push({ ...duplicate.records[1] });
    expect(BundleV4EvidenceCatalogSchema.safeParse(duplicate).success).toBe(false);
  });
});
