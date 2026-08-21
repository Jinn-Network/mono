// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the field name `assertClaimConsistency` refuses with.
 *
 * The refusal itself is a byte-compare, but the sentence it carries names the one field a reader
 * should look at — and that name used to be a constant. The recursive compare reported a
 * difference for equal leaves too, so the object branch returned on its first key whatever the
 * claim actually said, and every mismatch blamed `assurance.disclosure` (first in sorted order).
 * A tampered headline must name the tampered headline.
 */

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BINARY_INSTRUMENT_MEASUREMENT_PROFILE } from "@jinn-network/benchmarking-aggregate";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  type BenchmarkRecord,
  type MatrixRecord,
  type ReportRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { assertClaimConsistency, type ClaimRecordIdentities } from "./claim-consistency.js";
import { buildClaimPackage, type ClaimPackage } from "./claim.js";
import { BenchmarkProductError } from "./errors.js";
import { buildLocalVenueHonesty, localVenueLimitsForRun } from "./run-results.js";
import { binaryInstrumentReportLimitations, BINARY_INSTRUMENT_REPORT_LIMITATIONS } from "./binary-qualification.js";
import { PROMPTED_SCREENING_LIMITATIONS, PROMPTED_SCREENING_PROFILE } from "../admission/contracts.js";

const digest = (fill: string) => fill.repeat(64);
const DRAFT_ID = "draft-1";
const ASSURANCE_PRESET = "direct-check";
const RESOLVED_ASSURANCE = {
  independence: "disclosed",
  minVerdicts: 1,
  distinctEvaluator: false,
  verdictRule: "sole",
} as const;

/** One arm, one judged cell — the smallest sealed shape `buildClaimPackage` projects a wilson@1
 * headline from. The records are read field-by-field by a pure projection, never re-parsed here. */
const runRecord = {
  arms: [{ armId: "armA", pinning: {} }],
  replicates: 1,
  policy: {
    independence: RESOLVED_ASSURANCE.independence,
    evaluation: { minVerdicts: RESOLVED_ASSURANCE.minVerdicts, distinctEvaluator: RESOLVED_ASSURANCE.distinctEvaluator },
    submissionBaseline: {},
  },
  analysisPlan: [{
    method: BENCHMARKING_METHOD_IDS.wilson,
    version: BENCHMARKING_METHOD_VERSION,
    parameters: { verdictRule: RESOLVED_ASSURANCE.verdictRule },
  }],
} as unknown as RunRecord;

const matrixRecord = {
  cells: [{
    cellKey: `${digest("1")}/armA/1`,
    taskDigest: digest("1"),
    armId: "armA",
    replicate: 1,
    outcome: "judged",
    verification: { harness: "match", model: "match", loadout: "match", isolation: "match", checksFailed: [] },
    integrityTier: "re-derivable",
  }],
  completeness: { expected: 1, judged: 1, floor: "1", runOutcome: "complete" },
  attrition: {
    perArm: {
      armA: { expected: 1, judged: 1, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 0, replacements: 0 },
    },
    asymmetryFlags: [],
  },
} as unknown as MatrixRecord;

const reportRecord = {
  method: { id: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: {} },
  preregistered: false,
  results: {
    perSubject: [{
      results: {
        arms: { armA: { n: 1, passRate: "1", wilsonInterval: { low: "0.207", high: "1" } } },
        conflicted: { count: 0, cellKeys: [] },
      },
    }],
  },
  disclosures: { perSubject: [] },
  limitations: [],
} as unknown as ReportRecord;

const identities: ClaimRecordIdentities = {
  benchmarkSha256: digest("b"),
  runSha256: digest("c"),
  matrixSha256: digest("d"),
  reportSha256: digest("e"),
  reportEnvelopeSha256: digest("f"),
};

function projectedClaim(): ClaimPackage {
  return buildClaimPackage({
    draftId: DRAFT_ID,
    benchmarkSha256: identities.benchmarkSha256,
    runRecord,
    runSha256: identities.runSha256,
    matrixRecord,
    matrixSha256: identities.matrixSha256,
    reportRecord,
    reportSha256: identities.reportSha256!,
    reportEnvelopeSha256: identities.reportEnvelopeSha256,
    venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord),
    verificationCommandVerb: "bundle verify",
    assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
  });
}

function check(claim: ClaimPackage): void {
  assertClaimConsistency({
    claim,
    identities,
    // Never dereferenced by assertClaimConsistency — see claim-consistency.ts.
    benchmarkRecord: {} as unknown as BenchmarkRecord,
    runRecord,
    matrixRecord,
    reportRecord,
    draftId: DRAFT_ID,
    assurancePreset: ASSURANCE_PRESET,
  });
}

/** Returns the typed refusal, so the assertion is on the reported field rather than on a regex
 * that a still-constant field name would happen to satisfy. */
function refusalFor(tamper: (claim: Record<string, unknown>) => void): BenchmarkProductError {
  const claim = structuredClone(projectedClaim()) as ClaimPackage;
  tamper(claim as unknown as Record<string, unknown>);
  try {
    check(claim);
  } catch (cause) {
    if (cause instanceof BenchmarkProductError) return cause;
    throw cause;
  }
  throw new Error("expected assertClaimConsistency to refuse the tampered claim");
}

describe("assertClaimConsistency", () => {
  test("accepts the claim its own sealed records project", () => {
    expect(() => check(projectedClaim())).not.toThrow();
  });

  test("names the tampered headline field, not the first key in sorted order", () => {
    const refusal = refusalFor((claim) => {
      (claim["headline"] as Record<string, Record<string, unknown>>)["armA"]!["passRate"] = "0.5";
    });

    expect(refusal.code).toBe("record-integrity");
    expect(refusal.message).toBe(
      "claim package headline.armA.passRate is not the exact projection of verified facts",
    );
  });

  test("indexes into the array element that differs", () => {
    const refusal = refusalFor((claim) => {
      (claim["verification"] as { checks: string[] }).checks[0] = "not-a-check";
    });

    expect(refusal.message).toBe(
      "claim package verification.checks.0 is not the exact projection of verified facts",
    );
  });

  test("names a tampered field that sorts after the sections it matches", () => {
    const refusal = refusalFor((claim) => {
      (claim["scope"] as Record<string, unknown>)["replicates"] = 2;
    });

    expect(refusal.message).toBe(
      "claim package scope.replicates is not the exact projection of verified facts",
    );
  });
});

/**
 * Wiring coverage for spec §1.4: `assertClaimConsistency` recomputes the binary-instrument
 * Report's `limitations` disclosure from the sealed Run's analysis-plan parameters
 * (`binaryInstrumentReportLimitations`, `./binary-qualification.js`) and refuses when the
 * published array disagrees. A dated-snapshot run whose Report still carries the alias string —
 * today's behavior before this packet, and exactly the false disclosure §1.4 exists to close —
 * must be caught here, at the point the claim is actually published.
 */
describe("assertClaimConsistency: binary-instrument report limitations (spec §1.4)", () => {
  const binaryParameters = {
    verdictRule: "sole",
    k: 3,
    reduction: "strict-majority",
    measurementProfile: BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
    candidateClasses: ["alpha"],
    strata: ["core", "stress"],
    parserInvalidPolicy: "reject",
    truthAdmission: "operator-only",
    intervalAlpha: "0.05",
    judgeModelProfile: "dated-snapshot-sampling",
  } as const;

  const binaryRunRecord = {
    arms: [{ armId: "armA", pinning: {} }],
    replicates: 1,
    policy: {
      independence: RESOLVED_ASSURANCE.independence,
      evaluation: { minVerdicts: RESOLVED_ASSURANCE.minVerdicts, distinctEvaluator: RESOLVED_ASSURANCE.distinctEvaluator },
      submissionBaseline: {},
    },
    analysisPlan: [{
      method: BENCHMARKING_METHOD_IDS.binaryInstrument,
      version: BENCHMARKING_METHOD_VERSION,
      parameters: binaryParameters,
    }],
  } as unknown as RunRecord;

  function binaryReport(limitations: readonly string[]): ReportRecord {
    return {
      method: { id: BENCHMARKING_METHOD_IDS.binaryInstrument, version: BENCHMARKING_METHOD_VERSION, parameters: {} },
      preregistered: false,
      results: { perSubject: [{ results: { conflicted: { count: 0, cellKeys: [] } } }] },
      disclosures: { perSubject: [] },
      limitations,
    } as unknown as ReportRecord;
  }

  function binaryClaim(reportRecord: ReportRecord): ClaimPackage {
    return buildClaimPackage({
      draftId: DRAFT_ID,
      benchmarkSha256: identities.benchmarkSha256,
      runRecord: binaryRunRecord,
      runSha256: identities.runSha256,
      matrixRecord,
      matrixSha256: identities.matrixSha256,
      reportRecord,
      reportSha256: identities.reportSha256!,
      reportEnvelopeSha256: identities.reportEnvelopeSha256,
      venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, binaryRunRecord),
      verificationCommandVerb: "bundle verify",
      assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
    });
  }

  function checkBinary(reportRecord: ReportRecord): void {
    assertClaimConsistency({
      claim: binaryClaim(reportRecord),
      identities,
      benchmarkRecord: {} as unknown as BenchmarkRecord,
      runRecord: binaryRunRecord,
      matrixRecord,
      reportRecord,
      draftId: DRAFT_ID,
      assurancePreset: ASSURANCE_PRESET,
    });
  }

  test("accepts a dated-snapshot operator-only Report whose limitations already dropped the alias and reviewer-protocol strings", () => {
    const correctLimitations = [
      ...localVenueLimitsForRun(binaryRunRecord),
      ...binaryInstrumentReportLimitations(binaryParameters),
    ];
    expect(correctLimitations).not.toContain(BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias);
    expect(() => checkBinary(binaryReport(correctLimitations))).not.toThrow();
  });

  test("refuses a dated-snapshot Report that still publishes the mutable-alias limitation", () => {
    const staleLimitations = [
      ...localVenueLimitsForRun(binaryRunRecord),
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.operatorOnly,
    ];
    let caught: BenchmarkProductError | undefined;
    try {
      checkBinary(binaryReport(staleLimitations));
    } catch (cause) {
      if (cause instanceof BenchmarkProductError) caught = cause;
      else throw cause;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toBe(
      "Report limitations are not the exact disclosure derived from the sealed Run and rehearsal history",
    );
  });

  /**
   * Second-copy coverage for the screened-operator-sampled limitation (spec §6.8a Group A third
   * bullet; packet P6): `assertClaimConsistency` recomputes limitations from
   * `binaryInstrumentReportLimitations` (the SAME emitter item B fixes above) and refuses on
   * mismatch, so this is wiring coverage, not a second implementation of the derivation.
   */
  const screenedParameters = { ...binaryParameters, truthAdmission: "screened-operator-sampled" } as const;
  const screenedRunRecord = {
    ...binaryRunRecord,
    analysisPlan: [{
      method: BENCHMARKING_METHOD_IDS.binaryInstrument,
      version: BENCHMARKING_METHOD_VERSION,
      parameters: screenedParameters,
    }],
  } as unknown as RunRecord;

  function checkScreened(reportRecord: ReportRecord): void {
    assertClaimConsistency({
      claim: buildClaimPackage({
        draftId: DRAFT_ID,
        benchmarkSha256: identities.benchmarkSha256,
        runRecord: screenedRunRecord,
        runSha256: identities.runSha256,
        matrixRecord,
        matrixSha256: identities.matrixSha256,
        reportRecord,
        reportSha256: identities.reportSha256!,
        reportEnvelopeSha256: identities.reportEnvelopeSha256,
        venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, screenedRunRecord),
        verificationCommandVerb: "bundle verify",
        assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
      }),
      identities,
      benchmarkRecord: {} as unknown as BenchmarkRecord,
      runRecord: screenedRunRecord,
      matrixRecord,
      reportRecord,
      draftId: DRAFT_ID,
      assurancePreset: ASSURANCE_PRESET,
    });
  }

  test("accepts a screened Report whose limitations carry the screened-not-independently-labeled disclosure", () => {
    const correctLimitations = [
      ...localVenueLimitsForRun(screenedRunRecord),
      ...binaryInstrumentReportLimitations(screenedParameters),
    ];
    expect(correctLimitations).toContain(BINARY_INSTRUMENT_REPORT_LIMITATIONS.screenedNotIndependentlyLabeled);
    expect(() => checkScreened(binaryReport(correctLimitations))).not.toThrow();
  });

  test("refuses a screened Report that omits the screened-not-independently-labeled disclosure", () => {
    const missingLimitations = [
      ...localVenueLimitsForRun(screenedRunRecord),
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
    ];
    let caught: BenchmarkProductError | undefined;
    try {
      checkScreened(binaryReport(missingLimitations));
    } catch (cause) {
      if (cause instanceof BenchmarkProductError) caught = cause;
      else throw cause;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toBe(
      "Report limitations are not the exact disclosure derived from the sealed Run and rehearsal history",
    );
  });

  test("refuses a screened Report that instead publishes the operator-only disclosure (emitter/consumer must agree)", () => {
    const wrongLimitations = [
      ...localVenueLimitsForRun(screenedRunRecord),
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
      BINARY_INSTRUMENT_REPORT_LIMITATIONS.operatorOnly,
    ];
    let caught: BenchmarkProductError | undefined;
    try {
      checkScreened(binaryReport(wrongLimitations));
    } catch (cause) {
      if (cause instanceof BenchmarkProductError) caught = cause;
      else throw cause;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toBe(
      "Report limitations are not the exact disclosure derived from the sealed Run and rehearsal history",
    );
  });

  const promptedParameters = {
    ...screenedParameters,
    promptedScreeningProfile: PROMPTED_SCREENING_PROFILE,
  } as const;
  const promptedRunRecord = {
    ...binaryRunRecord,
    analysisPlan: [{
      method: BENCHMARKING_METHOD_IDS.binaryInstrument,
      version: BENCHMARKING_METHOD_VERSION,
      parameters: promptedParameters,
    }],
  } as unknown as RunRecord;

  function checkPrompted(reportRecord: ReportRecord): void {
    assertClaimConsistency({
      claim: buildClaimPackage({
        draftId: DRAFT_ID,
        benchmarkSha256: identities.benchmarkSha256,
        runRecord: promptedRunRecord,
        runSha256: identities.runSha256,
        matrixRecord,
        matrixSha256: identities.matrixSha256,
        reportRecord,
        reportSha256: identities.reportSha256!,
        reportEnvelopeSha256: identities.reportEnvelopeSha256,
        venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, promptedRunRecord),
        verificationCommandVerb: "bundle verify",
        assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
      }),
      identities,
      benchmarkRecord: {} as unknown as BenchmarkRecord,
      runRecord: promptedRunRecord,
      matrixRecord,
      reportRecord,
      draftId: DRAFT_ID,
      assurancePreset: ASSURANCE_PRESET,
    });
  }

  test("accepts a prompted-screening Report with all four exact capability limitations", () => {
    const limitations = [
      ...localVenueLimitsForRun(promptedRunRecord),
      ...binaryInstrumentReportLimitations(promptedParameters),
    ];
    expect(limitations).toEqual(expect.arrayContaining([...PROMPTED_SCREENING_LIMITATIONS]));
    expect(() => checkPrompted(binaryReport(limitations))).not.toThrow();
  });

  test.each([
    ["omitted", PROMPTED_SCREENING_LIMITATIONS.slice(1)],
    ["extra", [...PROMPTED_SCREENING_LIMITATIONS, "routing-compliance-machine-verified"]],
  ])("refuses prompted-screening limitations when one is %s", (_case, promptedLimitations) => {
    const limitations = [
      ...localVenueLimitsForRun(promptedRunRecord),
      ...binaryInstrumentReportLimitations(screenedParameters),
      ...promptedLimitations,
    ];
    expect(() => checkPrompted(binaryReport(limitations))).toThrow(
      "Report limitations are not the exact disclosure derived from the sealed Run and rehearsal history",
    );
  });
});

/**
 * Wiring coverage for packet #2837 / the portable half of C1: `assertClaimConsistency` folds
 * `PAIRED_ESTIMATE_LIMITATION` for paired-delta@1 AND paired-majority-delta@1 (the same
 * method-conditional core uses) while leaving the binary-instrument arm in place. The
 * exact-disclosure gate is NOT widened to `pairedEstimateLimitation.length > 0`; a non-empty
 * `additionalLimitations` opens it here, matching core's claim.test.ts forcing pattern.
 */
describe("assertClaimConsistency: paired-estimate limitation (packet #2837, portable copy)", () => {
  const FORCING_ADDITIONAL_LIMITATIONS = ["forcing fact so the limitations gate opens"];
  const PAIRED_ESTIMATE_LIMITATION =
    "This method estimates an effect; it does not gate one — no verdict, threshold, or selection was registered.";

  test("PAIRED_ESTIMATE_LIMITATION is byte-identical to core's established copy", () => {
    const extract = (src: string) => src.match(/const PAIRED_ESTIMATE_LIMITATION =\s*"([^"]+)";/)?.[1];
    const here = fileURLToPath(new URL(".", import.meta.url));
    const verifySrc = readFileSync(join(here, "claim-consistency.ts"), "utf8");
    const coreSrc = readFileSync(join(here, "../../../core/src/verification/claim-consistency.ts"), "utf8");
    expect(extract(verifySrc)).toBe(PAIRED_ESTIMATE_LIMITATION);
    expect(extract(coreSrc)).toBe(PAIRED_ESTIMATE_LIMITATION);
  });

  const pairedMajorityResults = {
    baseline: "armA",
    candidate: "armB",
    n: 2,
    delta: "0.5000",
    interval: null,
    reasons: ["fewer than minN=5 paired tasks (got 2)"],
    clusters: { count: 1 },
    byCandidateClass: [],
    byStratum: [],
    exclusions: [],
    conflicted: { count: 0, cellKeys: [] },
  } as const;

  const pairwiseResults = {
    pairs: [{
      armA: "armA",
      armB: "armB",
      n: 2,
      disagreements: 1,
      rate: "0.5000",
      interval: { lower: "0.0655", upper: "0.9345", alpha: "0.05" },
      byCandidateClass: [],
      byStratum: [],
      exclusions: [],
    }],
    conflicted: { count: 0, cellKeys: [] },
  } as const;

  function judgeRunRecord(method: string, parameters: Readonly<Record<string, unknown>>): RunRecord {
    return {
      arms: [{ armId: "armA", pinning: {} }, { armId: "armB", pinning: {} }],
      replicates: 1,
      policy: {
        independence: RESOLVED_ASSURANCE.independence,
        evaluation: { minVerdicts: RESOLVED_ASSURANCE.minVerdicts, distinctEvaluator: RESOLVED_ASSURANCE.distinctEvaluator },
        submissionBaseline: {},
      },
      analysisPlan: [{
        method,
        version: BENCHMARKING_METHOD_VERSION,
        parameters: { ...parameters, verdictRule: RESOLVED_ASSURANCE.verdictRule },
      }],
    } as unknown as RunRecord;
  }

  function judgeReport(method: string, results: unknown, limitations: readonly string[]): ReportRecord {
    return {
      method: { id: method, version: BENCHMARKING_METHOD_VERSION, parameters: {} },
      preregistered: false,
      results: { perSubject: [{ results }] },
      disclosures: { perSubject: [] },
      limitations,
    } as unknown as ReportRecord;
  }

  function checkJudge(runRecord: RunRecord, reportRecord: ReportRecord): void {
    assertClaimConsistency({
      claim: buildClaimPackage({
        draftId: DRAFT_ID,
        benchmarkSha256: identities.benchmarkSha256,
        runRecord,
        runSha256: identities.runSha256,
        matrixRecord,
        matrixSha256: identities.matrixSha256,
        reportRecord,
        reportSha256: identities.reportSha256!,
        reportEnvelopeSha256: identities.reportEnvelopeSha256,
        venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord),
        verificationCommandVerb: "bundle verify",
        assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
      }),
      identities,
      benchmarkRecord: {} as unknown as BenchmarkRecord,
      runRecord,
      matrixRecord,
      reportRecord,
      draftId: DRAFT_ID,
      assurancePreset: ASSURANCE_PRESET,
      additionalLimitations: FORCING_ADDITIONAL_LIMITATIONS,
    });
  }

  test("accepts a paired-majority-delta@1 Report whose limitations carry venue + additional + PAIRED_ESTIMATE_LIMITATION", () => {
    const runRecord = judgeRunRecord(BENCHMARKING_METHOD_IDS.pairedMajorityDelta, {});
    const limitations = [
      ...localVenueLimitsForRun(runRecord),
      ...FORCING_ADDITIONAL_LIMITATIONS,
      PAIRED_ESTIMATE_LIMITATION,
    ];
    expect(() => checkJudge(
      runRecord,
      judgeReport(BENCHMARKING_METHOD_IDS.pairedMajorityDelta, pairedMajorityResults, limitations),
    )).not.toThrow();
  });

  test("refuses a paired-majority-delta@1 Report that omits PAIRED_ESTIMATE_LIMITATION", () => {
    const runRecord = judgeRunRecord(BENCHMARKING_METHOD_IDS.pairedMajorityDelta, {});
    const limitations = [...localVenueLimitsForRun(runRecord), ...FORCING_ADDITIONAL_LIMITATIONS];
    let caught: BenchmarkProductError | undefined;
    try {
      checkJudge(
        runRecord,
        judgeReport(BENCHMARKING_METHOD_IDS.pairedMajorityDelta, pairedMajorityResults, limitations),
      );
    } catch (cause) {
      if (cause instanceof BenchmarkProductError) caught = cause;
      else throw cause;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toBe(
      "Report limitations are not the exact disclosure derived from the sealed Run and rehearsal history",
    );
  });

  test("accepts a paired-delta@1 Report whose limitations carry PAIRED_ESTIMATE_LIMITATION (same method-conditional arm)", () => {
    const pairedDeltaResults = {
      pairs: 1,
      delta: "0.5000",
      interval: { alpha: "0.05", low: "0.0000", high: "1.0000" },
      reasons: [],
      pairing: { taskDigests: [digest("1")] },
      clustering: { basis: "source", clusters: 1 },
      excluded: { count: 0, cellKeys: [] },
      conflicted: { count: 0, cellKeys: [] },
      bootstrap: { seed: 1, resamples: 1 },
    };
    const runRecord = judgeRunRecord(BENCHMARKING_METHOD_IDS.pairedDelta, {});
    const limitations = [
      ...localVenueLimitsForRun(runRecord),
      ...FORCING_ADDITIONAL_LIMITATIONS,
      PAIRED_ESTIMATE_LIMITATION,
    ];
    expect(() => checkJudge(
      runRecord,
      judgeReport(BENCHMARKING_METHOD_IDS.pairedDelta, pairedDeltaResults, limitations),
    )).not.toThrow();
  });

  test("does NOT require an extra limitation line for pairwise-disagreement@1", () => {
    const runRecord = judgeRunRecord(BENCHMARKING_METHOD_IDS.pairwiseDisagreement, {});
    const limitations = [...localVenueLimitsForRun(runRecord), ...FORCING_ADDITIONAL_LIMITATIONS];
    expect(() => checkJudge(
      runRecord,
      judgeReport(BENCHMARKING_METHOD_IDS.pairwiseDisagreement, pairwiseResults, limitations),
    )).not.toThrow();
  });
});
