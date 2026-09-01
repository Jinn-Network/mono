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
  const prompted = structuredClone(claim);
  prompted.method.parameters = { promptedScreeningProfile: "prompted-codex-screening/v1" };
  prompted.verification.command = "npx @colophon-claims/verify@0.2.0 <bundle-dir>";
  prompted.verification.compatibleCommand = "npx @colophon-claims/verify@0.2 <bundle-dir>";
  assert.equal(ClaimPackageSchema.safeParse(prompted).success, true);
  const promptedCurrent = structuredClone(prompted);
  promptedCurrent.verification.command = "npx @colophon-claims/verify@0.2.1 <bundle-dir>";
  assert.equal(ClaimPackageSchema.safeParse(promptedCurrent).success, true);
  const promptedWrong = structuredClone(prompted);
  promptedWrong.verification.command = "npx @colophon-claims/verify@0.1.0 <bundle-dir>";
  assert.equal(ClaimPackageSchema.safeParse(promptedWrong).success, false);
  const promptedMixed = structuredClone(prompted);
  promptedMixed.verification.compatibleCommand = "npx @colophon-claims/verify@0.1 <bundle-dir>";
  assert.equal(ClaimPackageSchema.safeParse(promptedMixed).success, false);
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

test("claim-package/4 refuses a qualification projection — that closure is claim-package/5", () => {
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

// --- issue #3205: the anchored binary-qualification allocation, claim-package/5 ---

const V7_COMMAND = "npx @colophon-claims/verify@0.2.1 <bundle-dir>";
const V7_COMPATIBLE = "npx @colophon-claims/verify@0.2 <bundle-dir>";

function validAnchoredBinaryClaim(overrides = {}) {
  const base = validBinaryClaim();
  return {
    ...base,
    claimSchema: "benchmark-product.claim-package/5",
    verification: { ...base.verification, command: V7_COMMAND, compatibleCommand: V7_COMPATIBLE, checks: V6_CHECKS },
    anchors: [anchorEntry()],
    ...overrides,
  };
}

test("claim-package/5 admits the qualification projection and the anchors section together", () => {
  const parsed = ClaimPackageSchema.parse(validAnchoredBinaryClaim());
  assert.equal(parsed.claimSchema, "benchmark-product.claim-package/5");
  assert.deepEqual(parsed.anchors, validAnchoredBinaryClaim().anchors);
  assert.deepEqual(parsed.qualification, validBinaryClaim().qualification);
});

test("claim-package/5 admits the empty section a declared-but-absent bundle carries", () => {
  assert.deepEqual(ClaimPackageSchema.parse(validAnchoredBinaryClaim({ anchors: [] })).anchors, []);
});

test("claim-package/5 refuses an omitted anchors section and a dropped qualification", () => {
  const { anchors: _omitted, ...withoutSection } = validAnchoredBinaryClaim();
  assert.equal(ClaimPackageSchema.safeParse(withoutSection).success, false);
  const { qualification: _dropped, ...withoutQualification } = validAnchoredBinaryClaim();
  assert.equal(ClaimPackageSchema.safeParse(withoutQualification).success, false);
});

test("claim-package/5 refuses a sibling method projection alongside the qualification", () => {
  assert.equal(ClaimPackageSchema.safeParse(validAnchoredBinaryClaim({ headline: {} })).success, false);
  assert.equal(ClaimPackageSchema.safeParse(validAnchoredBinaryClaim({ comparison: {} })).success, false);
});

test("claim-package/5 refuses top-level and nested ranking conclusions, exactly as /2 does", () => {
  const topLevel = validAnchoredBinaryClaim();
  topLevel.ranking = ["arm-a"];
  assert.equal(ClaimPackageSchema.safeParse(topLevel).success, false);

  const nested = validAnchoredBinaryClaim();
  nested.scope = { ...nested.scope, arms: [{ armId: "arm-a", pinning: {}, winner: true }] };
  assert.equal(ClaimPackageSchema.safeParse(nested).success, false);

  const ranked = structuredClone(validAnchoredBinaryClaim());
  ranked.qualification.ranking = ["arm-a"];
  ranked.results.perSubject[0].results.ranking = ["arm-a"];
  assert.equal(ClaimPackageSchema.safeParse(ranked).success, false);
});

test("claim-package/5 refuses a drifted qualification that no longer equals the Report result", () => {
  const drifted = structuredClone(validAnchoredBinaryClaim());
  drifted.qualification.configuration.intervalAlpha = "0.01";
  assert.equal(ClaimPackageSchema.safeParse(drifted).success, false);
});

test("claim-package/5 must pin verifier 0.2.1/@0.2 and the seven checks in order", () => {
  assert.equal(
    ClaimPackageSchema.safeParse(validAnchoredBinaryClaim({
      verification: { command: V6_COMMAND, compatibleCommand: V6_COMPATIBLE, checks: V6_CHECKS, trustRoot: "self-run" },
    })).success,
    false,
  );
  assert.equal(
    ClaimPackageSchema.safeParse(validAnchoredBinaryClaim({
      verification: { command: V7_COMMAND, compatibleCommand: V7_COMPATIBLE, checks: V6_CHECKS.slice(0, 6), trustRoot: "self-run" },
    })).success,
    false,
  );
  assert.equal(
    ClaimPackageSchema.safeParse(validAnchoredBinaryClaim({
      verification: {
        command: V7_COMMAND, compatibleCommand: V7_COMPATIBLE,
        checks: ["integrity-anchors", ...V6_CHECKS.slice(0, 6)], trustRoot: "self-run",
      },
    })).success,
    false,
  );
});

test("claim-package/4 still refuses a qualification projection — that closure is /5", () => {
  assert.equal(ClaimPackageSchema.safeParse(validAnchoredClaim({ qualification: {} })).success, false);
});

// --- issue #2839: the disclosed anchored binary-qualification allocation, claim-package/6 ---

const V8_CHECKS = [...V6_CHECKS, "disclosure-specification"];

/** Synthetic placeholder prose throughout (design R7): no third-party bytes appear here. */
function disclosureSection(overrides = {}) {
  return {
    recordSha256: "7".repeat(64),
    specification: "https://spec.jinn.network/disclosure/six-variable/v1",
    subjectSha256: "8".repeat(64),
    variables: {
      "ingestion-model": { status: "undisclosed", reason: "not-stated" },
      "retrieval-config": { status: "undisclosed", reason: "not-stated" },
      "answer-model": {
        status: "disclosed-by-publisher",
        statement: "Fixed and stated by the upstream collection; this venue executed none of it.",
      },
      "answer-prompt": {
        status: "disclosed-by-publisher",
        statement: "Described in the source collection and not re-executed here.",
      },
      "judge-model": {
        status: "measured-here",
        statement: "One dated model snapshot, fixed for every arm.",
        evidence: [{ role: "pinned-configuration", digest: { sha256: "6".repeat(64) } }],
      },
      "judge-prompt": {
        status: "measured-here",
        statement: "Sealed grading instruments, each with its own frozen template digest.",
        evidence: [{ role: "pinned-configuration", digest: { sha256: "5".repeat(64) } }],
      },
    },
    ...overrides,
  };
}

function validDisclosedClaim(overrides = {}) {
  const base = validBinaryClaim();
  return {
    ...base,
    claimSchema: "benchmark-product.claim-package/6",
    verification: { ...base.verification, command: V7_COMMAND, compatibleCommand: V7_COMPATIBLE, checks: V8_CHECKS },
    anchors: [anchorEntry()],
    disclosure: disclosureSection(),
    ...overrides,
  };
}

test("claim-package/6 admits the qualification, the anchors section, and the disclosure together", () => {
  const parsed = ClaimPackageSchema.parse(validDisclosedClaim());
  assert.equal(parsed.claimSchema, "benchmark-product.claim-package/6");
  assert.deepEqual(parsed.disclosure, disclosureSection());
  assert.deepEqual(parsed.qualification, validBinaryClaim().qualification);
  assert.deepEqual(parsed.anchors, [anchorEntry()]);
});

test("claim-package/6 refuses an omitted disclosure section — there is no legal empty form", () => {
  const { disclosure: _omitted, ...withoutSection } = validDisclosedClaim();
  assert.equal(ClaimPackageSchema.safeParse(withoutSection).success, false);
  assert.equal(ClaimPackageSchema.safeParse(validDisclosedClaim({ disclosure: {} })).success, false);
});

test("no earlier allocation carries a disclosure section", () => {
  for (const claimSchema of ["benchmark-product.claim-package/2", "benchmark-product.claim-package/5"]) {
    assert.equal(
      ClaimPackageSchema.safeParse(validDisclosedClaim({ claimSchema })).success,
      false,
      `${claimSchema} must refuse a disclosure section`,
    );
  }
  assert.equal(
    ClaimPackageSchema.safeParse(validAnchoredClaim({ disclosure: disclosureSection() })).success,
    false,
  );
});

test("claim-package/6 must state the eight checks with disclosure-specification last", () => {
  assert.equal(
    ClaimPackageSchema.safeParse(validDisclosedClaim({
      verification: { command: V7_COMMAND, compatibleCommand: V7_COMPATIBLE, checks: V6_CHECKS, trustRoot: "self-run" },
    })).success,
    false,
  );
  assert.equal(
    ClaimPackageSchema.safeParse(validDisclosedClaim({
      verification: {
        command: V7_COMMAND, compatibleCommand: V7_COMPATIBLE,
        checks: ["disclosure-specification", ...V6_CHECKS], trustRoot: "self-run",
      },
    })).success,
    false,
  );
  assert.equal(
    ClaimPackageSchema.safeParse(validDisclosedClaim({
      verification: { command: V6_COMMAND, compatibleCommand: V6_COMPATIBLE, checks: V8_CHECKS, trustRoot: "self-run" },
    })).success,
    false,
  );
});

test("claim-package/6 inherits /5's refusals: anchors, conclusions, and the qualification projection", () => {
  const { anchors: _dropped, ...withoutAnchors } = validDisclosedClaim();
  assert.equal(ClaimPackageSchema.safeParse(withoutAnchors).success, false);

  const { qualification: _noQualification, ...withoutQualification } = validDisclosedClaim();
  assert.equal(ClaimPackageSchema.safeParse(withoutQualification).success, false);

  assert.equal(ClaimPackageSchema.safeParse(validDisclosedClaim({ headline: {} })).success, false);

  const ranked = structuredClone(validDisclosedClaim());
  ranked.qualification.ranking = ["arm-a"];
  ranked.results.perSubject[0].results.ranking = ["arm-a"];
  assert.equal(ClaimPackageSchema.safeParse(ranked).success, false);

  const topLevel = structuredClone(validDisclosedClaim());
  topLevel.ranking = ["arm-a"];
  assert.equal(ClaimPackageSchema.safeParse(topLevel).success, false);
});

test("the disclosure section is strict: the six keys, the standard literal, and the record's own union", () => {
  assert.equal(
    ClaimPackageSchema.safeParse(validDisclosedClaim({
      disclosure: disclosureSection({ specification: "https://example.invalid/other" }),
    })).success,
    false,
  );

  const seventh = disclosureSection();
  seventh.variables["judge-input-shape"] = { status: "undisclosed", reason: "not-stated" };
  assert.equal(ClaimPackageSchema.safeParse(validDisclosedClaim({ disclosure: seventh })).success, false);

  const assertedWithEvidence = disclosureSection();
  assertedWithEvidence.variables["answer-model"] = {
    status: "disclosed-by-publisher",
    statement: "An assertion that tries to carry a digest.",
    evidence: [{ role: "pinned-configuration", digest: { sha256: "4".repeat(64) } }],
  };
  assert.equal(
    ClaimPackageSchema.safeParse(validDisclosedClaim({ disclosure: assertedWithEvidence })).success,
    false,
  );

  const extraKey = disclosureSection();
  extraKey.completenessScore = 2;
  assert.equal(ClaimPackageSchema.safeParse(validDisclosedClaim({ disclosure: extraKey })).success, false);
});
