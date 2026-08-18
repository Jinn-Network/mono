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
      command: "npx @colophon-claims/verify@0.1.0 <bundle-dir>",
      compatibleCommand: "npx @colophon-claims/verify@0.1 <bundle-dir>",
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

const RFC3161_PROFILE = "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1";
const RUN_KIND = "https://spec.jinn.network/records/benchmark-run/v1";
const V6_COMMAND = "npx @colophon-claims/verify@0.1.0 <bundle-dir>";
const V6_COMPATIBLE = "npx @colophon-claims/verify@0.1 <bundle-dir>";
const V6_CHECKS = [
  "manifest", "evidence-closure", "trust", "matrix-rederivation",
  "report-verification", "claim-consistency", "integrity-anchors",
];

function anchorEntry(overrides = {}) {
  return {
    subject: "lock",
    kind: RUN_KIND,
    provider: RFC3161_PROFILE,
    recordSha256: "1".repeat(64),
    facts: {
      genTime: "2026-01-01T12:00:00Z",
      policyOid: "2.999.1",
      serialNumber: "0a1b",
      signerCertificateSha256: "9".repeat(64),
    },
    ...overrides,
  };
}

function validAnchoredClaim(overrides = {}) {
  const digest = "c".repeat(64);
  return {
    claimSchema: "benchmark-product.claim-package/4",
    scope: { draftId: "d", benchmarkSha256: digest, taskCount: 0, arms: [], replicates: 1, venue: "self-run" },
    records: { benchmarkSha256: digest, runSha256: digest, matrixSha256: digest, reportSha256: digest, reportEnvelopeSha256: digest },
    method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {}, preregistered: true },
    results: {}, headline: {}, completeness: {}, attrition: {}, conflicted: { count: 0, cellKeys: [] },
    assurance: { preset: "single", resolved: { independence: "disclosed", minVerdicts: 1, distinctEvaluator: false, verdictRule: "sole" }, disclosure: "self-run" },
    disclosures: { perSubject: [], integrityTierCounts: { "re-derivable": 0, "attested-only": 0 }, pinningUnverifiableCounts: { harness: 0, model: 0, loadout: 0, isolation: 0 } },
    limitations: [], venueHonesty: {},
    verification: { command: V6_COMMAND, compatibleCommand: V6_COMPATIBLE, checks: V6_CHECKS, trustRoot: "self-run" },
    anchors: [anchorEntry()],
    ...overrides,
  };
}

test("claim-package/4 admits a carried anchors section and preserves it exactly", () => {
  const claim = validAnchoredClaim();
  const parsed = ClaimPackageSchema.parse(claim);
  assert.deepEqual(parsed.anchors, claim.anchors);
});

test("claim-package/4 admits the empty section a declared-but-absent bundle carries", () => {
  const parsed = ClaimPackageSchema.parse(validAnchoredClaim({ anchors: [] }));
  assert.deepEqual(parsed.anchors, []);
});

test("claim-package/4 refuses an omitted anchors section", () => {
  const { anchors: _omitted, ...withoutSection } = validAnchoredClaim();
  assert.equal(ClaimPackageSchema.safeParse(withoutSection).success, false);
});

test("claim-package/4 refuses a qualification projection — that closure is a later allocation", () => {
  assert.equal(ClaimPackageSchema.safeParse(validAnchoredClaim({ qualification: {} })).success, false);
});

test("claim-package/4 refuses a claim carrying neither headline nor comparison", () => {
  const { headline: _dropped, ...withoutMethodProjection } = validAnchoredClaim();
  assert.equal(ClaimPackageSchema.safeParse(withoutMethodProjection).success, false);
});

test("claim-package/4 must pin the verifier 0.1.0/@0.1 commands and the seven checks in order", () => {
  const wrongCommand = validAnchoredClaim();
  wrongCommand.verification = { ...wrongCommand.verification, command: "npx @colophon-claims/verify@1.0.0 <bundle-dir>" };
  assert.equal(ClaimPackageSchema.safeParse(wrongCommand).success, false);

  const sixChecks = validAnchoredClaim();
  sixChecks.verification = { ...sixChecks.verification, checks: V6_CHECKS.slice(0, 6) };
  assert.equal(ClaimPackageSchema.safeParse(sixChecks).success, false);

  const reordered = validAnchoredClaim();
  reordered.verification = { ...reordered.verification, checks: ["integrity-anchors", ...V6_CHECKS.slice(0, 6)] };
  assert.equal(ClaimPackageSchema.safeParse(reordered).success, false);
});

test("claim-package/1 and /2 refuse an anchors section outright", () => {
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
    anchors: [anchorEntry()],
  };
  assert.equal(ClaimPackageSchema.safeParse(legacy).success, false);
  assert.equal(ClaimPackageSchema.safeParse({ ...validBinaryClaim(), anchors: [anchorEntry()] }).success, false);
});

test("an anchor entry is strict: an extra key and a mixed fact shape are both refused", () => {
  assert.equal(
    ClaimPackageSchema.safeParse(validAnchoredClaim({ anchors: [anchorEntry({ issuerDn: "CN=Authority" })] })).success,
    false,
  );
  assert.equal(
    ClaimPackageSchema.safeParse(validAnchoredClaim({
      anchors: [anchorEntry({ facts: { genTime: "2026-01-01T12:00:00Z", blockHeight: 1 } })],
    })).success,
    false,
  );
  // The two profiles' fact grammars stay disjoint, and each is admitted on its own.
  assert.equal(
    ClaimPackageSchema.safeParse(validAnchoredClaim({ anchors: [anchorEntry({ facts: { blockHeight: 880017 } })] })).success,
    true,
  );
  assert.equal(
    ClaimPackageSchema.safeParse(validAnchoredClaim({ anchors: [anchorEntry({ facts: { pending: true } })] })).success,
    true,
  );
});
