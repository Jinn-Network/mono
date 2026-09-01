import { describe, expect, test } from "vitest";
import { sealEvidenceNativeClaimPackageV3 } from "@jinn-network/benchmarking-protocol";
import { evidenceNativeBundleSigners, legacyBundleSigners } from "./signers.js";
import { BundleTrustSchema, BundleV4TrustSchema } from "./schema.js";

const REPORT = {
  keyId: "did:key:zReport",
  algorithm: "ed25519",
  spkiDerBase64: "AA==",
  author: "did:key:zReport",
  didKey: "did:key:zReport",
  validFrom: "2026-08-18T11:41:56.880Z",
} as const;

function evaluator(name: string, keyId: string) {
  return { evaluator: `urn:jinn:evaluator:${name}`, keyId, algorithm: "ed25519", spkiDerBase64: "AA==" } as const;
}

describe("legacy bundle signers", () => {
  test("the report author is the publisher and every evaluator is an automated grader", () => {
    const trust = BundleTrustSchema.parse({
      format: "benchmark-product-public-trust/2",
      selfRun: { custody: "workspace-minted", evaluatorDistinctness: "agent-distinctness-only", partyIndependence: "not-established" },
      report: REPORT,
      evaluators: [evaluator("one", "k1"), evaluator("two", "k2")],
    });
    expect(legacyBundleSigners(trust, new Set(["urn:jinn:evaluator:one", "urn:jinn:evaluator:two"]))).toEqual([
      { role: "publisher", identity: "did:key:zReport", keyId: "did:key:zReport", custody: "same-operator" },
      { role: "automated-grader", identity: "urn:jinn:evaluator:one", keyId: "k1", custody: "same-operator" },
      { role: "automated-grader", identity: "urn:jinn:evaluator:two", keyId: "k2", custody: "same-operator" },
    ]);
  });

  test("grading and reviewing are read from their own sets, and the authorities are not a second key", () => {
    const trust = BundleV4TrustSchema.parse({
      format: "benchmark-product-public-trust/4",
      selfRun: { custody: "workspace-minted", evaluatorDistinctness: "agent-distinctness-only", partyIndependence: "not-established" },
      report: REPORT,
      evaluators: [evaluator("one", "k1"), evaluator("two", "k2")],
      admission: {
        reviewers: [{ evaluator: "urn:jinn:evaluator:one", keyId: "k1" }, { evaluator: "urn:jinn:evaluator:two", keyId: "k2" }],
        authorities: [{ role: "roster-attestor", keyId: "did:key:zReport" }, { role: "truth-reveal-attestor", keyId: "did:key:zReport" }],
      },
    });
    // Only `two` graded a Matrix cell. `one` reviewed and nothing else, so printing it as a grader
    // would overstate the grading set; `two` did both, so it must appear under both roles. The
    // admission authorities are the publisher's own key and are deliberately not listed again.
    expect(legacyBundleSigners(trust, new Set(["urn:jinn:evaluator:two"]))).toEqual([
      { role: "publisher", identity: "did:key:zReport", keyId: "did:key:zReport", custody: "same-operator" },
      { role: "human-reviewer", identity: "urn:jinn:evaluator:one", keyId: "k1", custody: "same-operator" },
      { role: "automated-grader", identity: "urn:jinn:evaluator:two", keyId: "k2", custody: "same-operator" },
      { role: "human-reviewer", identity: "urn:jinn:evaluator:two", keyId: "k2", custody: "same-operator" },
    ]);
  });
});

describe("evidence-native bundle signers", () => {
  test("only keys that carried an accepted signature are reported, each under its reader-facing role", () => {
    const digest = { name: "record", digest: { sha256: "b".repeat(64) }, mediaType: "application/octet-stream" };
    const claim = sealEvidenceNativeClaimPackageV3({
      claimSchema: "benchmark-product.claim-package/3",
      profile: "https://spec.jinn.network/profiles/claim-package/3",
      records: {
        benchmark: digest, manifest: digest, cohort: digest, matrix: digest,
        reportPayload: digest, reportEnvelope: digest, evidence: [], artifacts: [],
      },
      method: { id: "m", version: "1", parameters: {} },
      results: {},
      closure: { status: "complete-relative-to-sealed-source", candidateCount: 0, admittedCount: 0, excludedCount: 0, unavailableCount: 0, limitations: [] },
      trust: {
        signers: [
          { keyId: "k1", identity: "urn:report:1", purpose: "report", publicKey: digest, algorithm: "ed25519" },
          { keyId: "k2", identity: "urn:evaluator:1", purpose: "automated-evaluator", publicKey: digest, algorithm: "ed25519" },
          { keyId: "k3", identity: "urn:evaluator:2", purpose: "human-reviewer", publicKey: digest, algorithm: "ed25519" },
          { keyId: "k4", identity: "urn:admission:1", purpose: "label-admission", publicKey: digest, algorithm: "ed25519" },
        ],
        signatureValidityIsNotAuthorization: true,
      },
      verification: {
        checks: ["manifest", "evidence-closure", "artifact-integrity", "signature-validity", "matrix-rederivation", "report-verification", "claim-consistency"],
        command: "colophon-verify",
      },
      issuedAt: "2026-08-18T11:41:56.880Z",
    });
    expect(evidenceNativeBundleSigners(claim.bytes, ["k1", "k2", "k3", "k4"])).toEqual([
      { role: "publisher", identity: "urn:report:1", keyId: "k1", custody: "undeclared" },
      { role: "automated-grader", identity: "urn:evaluator:1", keyId: "k2", custody: "undeclared" },
      { role: "human-reviewer", identity: "urn:evaluator:2", keyId: "k3", custody: "undeclared" },
      { role: "label-admission", identity: "urn:admission:1", keyId: "k4", custody: "undeclared" },
    ]);

    // `trust.signers` is publisher-written and the closure only ever reads it as a lookup table, so
    // a declared-but-never-used key must not reach the reader as a signer. A bundle that appended a
    // "human reviewer" nobody signed as would otherwise print one.
    expect(evidenceNativeBundleSigners(claim.bytes, ["k1", "k2"])).toEqual([
      { role: "publisher", identity: "urn:report:1", keyId: "k1", custody: "undeclared" },
      { role: "automated-grader", identity: "urn:evaluator:1", keyId: "k2", custody: "undeclared" },
    ]);
    expect(evidenceNativeBundleSigners(claim.bytes, [])).toEqual([]);
  });
});
