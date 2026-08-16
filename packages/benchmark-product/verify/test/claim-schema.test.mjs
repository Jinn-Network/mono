import assert from "node:assert/strict";
import test from "node:test";
import { ClaimPackageSchema } from "../dist/index.js";

function zeroRate() {
  return { numerator: 0, denominator: 0, estimate: null, wilsonInterval: null, withheldReason: "zero-denominator" };
}

function zeroProjection() {
  return {
    item: { expected: 0, complete: 0, excluded: 0, unstable: 0 },
    call: { expected: 0, evaluated: 0, parseInvalid: 0 },
    confusion: { correctAccepted: 0, correctRejected: 0, wrongAccepted: 0, wrongRejected: 0 },
    agreement: zeroRate(), falseAccept: zeroRate(), falseReject: zeroRate(),
    instability: zeroRate(), parserInvalid: zeroRate(),
  };
}

function validBinaryClaim() {
  const qualification = {
    configuration: {
      verdictRule: "sole", k: 1, reduction: "strict-majority", measurementProfile: "binary-instrument@1",
      candidateClasses: ["factuality"], strata: ["core", "stress"], parserInvalidPolicy: "reject",
      truthAdmission: "two-human-unanimous", intervalAlpha: "0.05",
    },
    arms: Object.fromEntries(["arm-a", "arm-b", "arm-c", "arm-d"].map((armId, index) => [armId, {
      instrumentSha256: `sha256:${String(index + 1).repeat(64)}`,
      ...zeroProjection(),
      byCandidateClass: { factuality: zeroProjection() },
      byStratum: { core: zeroProjection(), stress: zeroProjection() },
    }])),
    itemDecisions: [],
    excluded: { count: 0, items: [] },
    conflicted: { count: 0, cellKeys: [] },
  };
  const digest = "a".repeat(64);
  return {
    claimSchema: "benchmark-product.claim-package/2",
    scope: { draftId: "draft-1", benchmarkSha256: digest, taskCount: 0, arms: [], replicates: 1, venue: "self-run" },
    records: { benchmarkSha256: digest, runSha256: digest, matrixSha256: digest, reportSha256: digest, reportEnvelopeSha256: digest },
    method: { id: "jinn.benchmarking.method/binary-instrument", version: "1", parameters: {}, preregistered: true },
    results: { perSubject: [{ subjectSha256: digest, results: qualification }] },
    completeness: {}, attrition: {}, conflicted: qualification.conflicted,
    assurance: { preset: "single", resolved: { independence: "disclosed", minVerdicts: 1, distinctEvaluator: false, verdictRule: "sole" }, disclosure: "self-run" },
    disclosures: { perSubject: [], integrityTierCounts: { "re-derivable": 0, "attested-only": 0 }, pinningUnverifiableCounts: { harness: 0, model: 0, loadout: 0, isolation: 0 } },
    limitations: [], venueHonesty: {},
    verification: {
      command: "npx @colophon-claims/verify@2.0.0 <bundle-dir>",
      compatibleCommand: "npx @colophon-claims/verify@2 <bundle-dir>",
      checks: ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"],
      trustRoot: "self-run",
    },
    qualification,
  };
}

test("claim-package/2 rejects top-level and nested ranking conclusions", () => {
  const claim = validBinaryClaim();
  assert.equal(ClaimPackageSchema.safeParse(claim).success, true);
  assert.equal(ClaimPackageSchema.safeParse({ ...claim, ranking: ["arm-a"] }).success, false);
  const nested = structuredClone(claim);
  nested.scope.arms = [{ armId: "arm-a", pinning: {}, winner: true }];
  assert.equal(ClaimPackageSchema.safeParse(nested).success, false);
});

test("claim-package/1 preserves historical unknown-field stripping", () => {
  const digest = "b".repeat(64);
  const legacy = {
    claimSchema: "benchmark-product.claim-package/1",
    scope: { draftId: "d", benchmarkSha256: digest, taskCount: 0, arms: [], replicates: 1, venue: "self-run" },
    records: { benchmarkSha256: digest, runSha256: digest, matrixSha256: digest, reportSha256: digest, reportEnvelopeSha256: digest },
    method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {}, preregistered: true },
    results: {}, headline: {}, completeness: {}, attrition: {}, conflicted: { count: 0, cellKeys: [] },
    assurance: { preset: "single", resolved: { independence: "disclosed", minVerdicts: 1, distinctEvaluator: false, verdictRule: "sole" }, disclosure: "self-run" },
    disclosures: { perSubject: [], integrityTierCounts: { "re-derivable": 0, "attested-only": 0 }, pinningUnverifiableCounts: { harness: 0, model: 0, loadout: 0, isolation: 0 } },
    limitations: [], venueHonesty: {},
    verification: { command: "x", compatibleCommand: "x", checks: ["x"], trustRoot: "x" },
    qualification: { historicalUnknown: true },
  };
  const parsed = ClaimPackageSchema.parse(legacy);
  assert.equal("qualification" in parsed, false);
});
