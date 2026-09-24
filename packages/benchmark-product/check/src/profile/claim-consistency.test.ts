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
  DISCLOSURE_SPECIFICATION_RECORD_KIND,
  DISCLOSURE_VARIABLE_KEYS,
  MATRIX_RECORD_KIND,
  SIX_VARIABLE_DISCLOSURE_SPECIFICATION,
  sealDisclosureSpecification,
  type BenchmarkRecord,
  type MatrixRecord,
  type ReportRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { assertClaimConsistency, firstDifference, type ClaimRecordIdentities } from "./claim-consistency.js";
import { buildClaimPackage, ClaimPackageSchema, COMPOSED_CLAIM_PACKAGE_SCHEMA_ID, type ClaimPackage } from "./claim.js";
import {
  ANCHORED_CLAIM_PACKAGE_SCHEMA_ID,
  CLAIM_PACKAGE_SCHEMA_ID,
  PUBLIC_BUNDLE_V6_CHECKS,
  PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
} from "../legacy-closures.js";
import { expectedChecks, readerInstructions } from "../capabilities.js";
import { deriveDisclosureSpecification } from "./disclosure.js";
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

/**
 * Issue #3403: the composed generation's shared claim package, `claim-package/7`.
 *
 * A pre-composition claim says what it carries by its ID: `/4` is "anchored", `/5` is "anchored and
 * qualified", and each id has a hand-written guard. The composed claim carries one id for every
 * combination, and what it must carry is derived from the capability vector its bundle declares:
 * the sections (biconditionally), the check list, and the reader line.
 *
 * The vector is read from the BUNDLE, never from the claim under test. A claim cannot satisfy
 * itself: both "a section the vector does not declare" and "a declaration with no section" are
 * differences the rebuild names, not tautologies the claim's own shape would pass.
 *
 * This replaces the arrangement issue #4191 made while `/10` was `/6`'s closure exactly, where
 * `/10` shared `claim-package/4` and that id admitted a second reader pair. `claim-package/4` is
 * carried by `/6` alone again, and admits the one pair it always did.
 */
describe("issue #3403: the composed claim package", () => {
  function claimFor(input: { readonly composedCapabilities?: readonly string[]; readonly anchors?: readonly never[] }): ClaimPackage {
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
      venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord, []),
      verificationCommandVerb: "bundle verify",
      assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
      ...input,
    });
  }
  const consistency = (claim: ClaimPackage, bundle: { readonly composedCapabilities?: readonly string[]; readonly anchors?: readonly never[] }) =>
    () => assertClaimConsistency({
      claim,
      identities,
      benchmarkRecord: {} as unknown as BenchmarkRecord,
      runRecord,
      matrixRecord,
      reportRecord,
      draftId: DRAFT_ID,
      assurancePreset: ASSURANCE_PRESET,
      ...bundle,
    });

  test("omitting the vector keeps every pre-composition claim byte-identical", () => {
    const anchored = claimFor({ anchors: [] });
    expect(anchored.claimSchema).toBe(ANCHORED_CLAIM_PACKAGE_SCHEMA_ID);
    expect(anchored.verification.command).toBe(PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND);
    expect(anchored.verification.compatibleCommand).toBe(PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND);
    expect(anchored.verification.checks).toEqual(PUBLIC_BUNDLE_V6_CHECKS);
    expect(claimFor({}).claimSchema).toBe(CLAIM_PACKAGE_SCHEMA_ID);
  });

  test("claim-package/4 admits its one reader pair again, and no other", () => {
    const anchored = claimFor({ anchors: [] });
    expect(ClaimPackageSchema.safeParse(anchored).success).toBe(true);
    for (const verification of [
      { ...anchored.verification, ...readerInstructions(["anchoring"]) },
      { ...anchored.verification, compatibleCommand: PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND },
    ]) {
      expect(ClaimPackageSchema.safeParse({ ...anchored, verification }).success).toBe(false);
    }
  });

  test("supplying the vector, even empty, makes the composed claim: one id, derived pins", () => {
    const base = claimFor({ composedCapabilities: [] });
    expect(base.claimSchema).toBe(COMPOSED_CLAIM_PACKAGE_SCHEMA_ID);
    expect(base.verification.checks).toEqual(expectedChecks([]));
    expect(base.anchors).toBeUndefined();

    const anchored = claimFor({ composedCapabilities: ["anchoring"], anchors: [] });
    expect(anchored.claimSchema).toBe(COMPOSED_CLAIM_PACKAGE_SCHEMA_ID);
    expect(anchored.verification.checks).toEqual(PUBLIC_BUNDLE_V6_CHECKS);
    expect(anchored.verification).toEqual(expect.objectContaining(readerInstructions(["anchoring"])));
    // No composed claim names the first-public 0.1 line: no 0.1 reader understands the format.
    expect(anchored.verification.command).toBe(PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND);
    expect(base.verification.command).toBe(PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND);

    // Section contents move across verbatim: only the id and the pins differ from claim-package/4.
    expect({ ...anchored, claimSchema: undefined, verification: undefined })
      .toEqual({ ...claimFor({ anchors: [] }), claimSchema: undefined, verification: undefined });
    for (const claim of [base, anchored]) expect(ClaimPackageSchema.safeParse(claim).success).toBe(true);
  });

  test("the builder refuses a section and a declaration that do not arrive together", () => {
    expect(() => claimFor({ composedCapabilities: ["anchoring"] })).toThrow(/"anchoring" and its "anchors" section/u);
    expect(() => claimFor({ composedCapabilities: [], anchors: [] })).toThrow(/"anchoring" and its "anchors" section/u);
    // A wilson@1 Report projects no qualification, so the vector cannot declare one.
    expect(() => claimFor({ composedCapabilities: ["binary-qualification"] }))
      .toThrow(/"binary-qualification" and its "qualification" section/u);
    expect(() => claimFor({ composedCapabilities: ["external-import"] }))
      .toThrow(/"external-import" and its "externalImport" section/u);
  });

  test("the builder refuses a vector the registry does not admit, as a typed refusal", () => {
    for (const composedCapabilities of [["zz-unknown"], ["disclosure-specification"], ["binary-qualification", "anchoring"]]) {
      expect(() => claimFor({ composedCapabilities }), JSON.stringify(composedCapabilities)).toThrow(BenchmarkProductError);
    }
  });

  test("the schema pins the checks and the reader line to the sections the claim carries", () => {
    const anchored = claimFor({ composedCapabilities: ["anchoring"], anchors: [] });
    const { anchors: _section, ...stripped } = anchored;
    const undisclosed = { status: "undisclosed", reason: "not-stated" } as const;
    const disclosure = deriveDisclosureSpecification(sealDisclosureSpecification({
      kind: DISCLOSURE_SPECIFICATION_RECORD_KIND,
      specification: SIX_VARIABLE_DISCLOSURE_SPECIFICATION,
      author: "did:key:zPlaceholderAuthorIdentity",
      subject: { kind: MATRIX_RECORD_KIND, digest: { sha256: identities.matrixSha256 } },
      variables: Object.fromEntries(DISCLOSURE_VARIABLE_KEYS.map((key) => [key, undisclosed])),
    }).bytes);
    const issuesOf = (claim: unknown): string[] => {
      const parsed = ClaimPackageSchema.safeParse(claim);
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    };

    // The section removed, the seven checks kept: the sections now imply the base six.
    expect(issuesOf(stripped)).toEqual([expect.stringContaining("six base checks plus each carried capability's")]);
    // The section kept, a check dropped.
    expect(issuesOf({ ...anchored, verification: { ...anchored.verification, checks: [...expectedChecks([])] } }))
      .toEqual([expect.stringContaining("six base checks plus each carried capability's")]);
    // A reader line the vector does not derive.
    expect(issuesOf({ ...anchored, verification: { ...anchored.verification, command: PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND } }))
      .toEqual([expect.stringContaining("must pin the reader release its capability sections derive")]);
    // A disclosure section with no qualification to ride on is a combination the registry refuses,
    // so the claim is refused on resolution, exactly as the manifest declaring it would be.
    expect(issuesOf({ ...anchored, disclosure }))
      .toEqual([expect.stringContaining('capability "disclosure-specification" requires "binary-qualification"')]);
  });

  test("declared without its section: the rebuild names the missing section", () => {
    const refused = consistency(claimFor({ composedCapabilities: [] }), { composedCapabilities: ["anchoring"], anchors: [] });
    expect(refused).toThrow(BenchmarkProductError);
    expect(refused).toThrow(/claim package anchors is not the exact projection/u);
  });

  test("a section without its declaration: the rebuild names the undeclared section", () => {
    const refused = consistency(claimFor({ composedCapabilities: ["anchoring"], anchors: [] }), { composedCapabilities: [] });
    expect(refused).toThrow(/claim package anchors is not the exact projection/u);
  });

  test("a pre-composition claim inside a composed bundle is refused on its id, and the reverse", () => {
    expect(consistency(claimFor({ anchors: [] }), { composedCapabilities: ["anchoring"], anchors: [] }))
      .toThrow(/claim package claimSchema is not the exact projection/u);
    expect(consistency(claimFor({ composedCapabilities: ["anchoring"], anchors: [] }), { anchors: [] }))
      .toThrow(/claim package claimSchema is not the exact projection/u);
  });

  test("the vector the bundle declares makes the matching claim consistent", () => {
    expect(consistency(claimFor({ composedCapabilities: [] }), { composedCapabilities: [] })).not.toThrow();
    expect(consistency(
      claimFor({ composedCapabilities: ["anchoring"], anchors: [] }),
      { composedCapabilities: ["anchoring"], anchors: [] },
    )).not.toThrow();
  });
});

describe("firstDifference", () => {
  test("equal objects report no difference even when later keys would sort first", () => {
    expect(firstDifference({ assurance: "same", headline: "same" }, { assurance: "same", headline: "same" })).toBeUndefined();
  });

  test("names the edited leaf instead of the first key in sorted order", () => {
    expect(firstDifference(
      { assurance: { disclosure: "ok" }, headline: { armA: { passRate: "1" } } },
      { assurance: { disclosure: "ok" }, headline: { armA: { passRate: "0.5" } } },
    )).toBe("headline.armA.passRate");
  });

  test("indexes into the array element that differs", () => {
    expect(firstDifference({ checks: ["a", "b"] }, { checks: ["a", "c"] })).toBe("checks.1");
  });

  test("a field present on only one side is itself the first difference", () => {
    expect(firstDifference({ a: 1 }, { a: 1, b: 2 })).toBe("b");
  });
});

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

/**
 * Issue #3855: the projection rebuild is on the reader path -- `assertClaimConsistency` calls
 * `buildClaimPackage` on every successful verification -- so a sealed Report whose results do not
 * carry the shape its own method produces is a named disagreement with the record a reader was
 * handed, not an internal fault. It refuses with the package's typed error, at `report.json`, the
 * source that carries the malformed fact. Pinned structurally on `name` / `code` / `issues[].path`
 * rather than on the prose: messages are free to change, codes and paths are the contract.
 */
describe("issue #3855: the projection rebuild refuses at the source that carries the malformed fact", () => {
  /** A Run whose sealed plan carries the method under test, so the assurance cross-check upstream
   * of the projection passes and the projection itself is what the assertion reaches. */
  function planFor(method: ReportRecord["method"]): RunRecord {
    return {
      ...runRecord,
      analysisPlan: [{ method: method.id, version: method.version, parameters: { verdictRule: RESOLVED_ASSURANCE.verdictRule } }],
    } as unknown as RunRecord;
  }

  function projectFrom(results: unknown, method?: ReportRecord["method"]): ClaimPackage {
    const plannedRun = method === undefined ? runRecord : planFor(method);
    return buildClaimPackage({
      draftId: DRAFT_ID,
      benchmarkSha256: identities.benchmarkSha256,
      runRecord: plannedRun,
      runSha256: identities.runSha256,
      matrixRecord,
      matrixSha256: identities.matrixSha256,
      reportRecord: {
        ...reportRecord,
        ...(method === undefined ? {} : { method }),
        results,
      } as unknown as ReportRecord,
      reportSha256: identities.reportSha256!,
      reportEnvelopeSha256: identities.reportEnvelopeSha256,
      venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, plannedRun),
      verificationCommandVerb: "bundle verify",
      assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
    });
  }

  const refusal = { name: "BenchmarkProductError", code: "record-integrity", issues: [expect.objectContaining({ path: "report.json" })] };

  test("a Report carrying no single-subject results wrapper refuses", () => {
    expect(() => projectFrom({ perSubject: [] })).toThrow(expect.objectContaining(refusal));
  });

  test("a Report whose results do not carry its method's shape refuses", () => {
    expect(() => projectFrom({ perSubject: [{ results: { conflicted: { count: 0, cellKeys: [] } } }] }))
      .toThrow(expect.objectContaining(refusal));
  });

  test("a Report naming a method with no claim-package projection refuses", () => {
    const method = { id: "jinn.benchmarking.method/not-wired", version: BENCHMARKING_METHOD_VERSION, parameters: {} };
    expect(() => projectFrom(reportRecord.results, method as ReportRecord["method"]))
      .toThrow(expect.objectContaining(refusal));
  });

  test("a Report naming an unsupported version of a wired method refuses", () => {
    const method = { id: BENCHMARKING_METHOD_IDS.pairwiseDisagreement, version: "99", parameters: {} };
    expect(() => projectFrom(reportRecord.results, method as ReportRecord["method"]))
      .toThrow(expect.objectContaining(refusal));
  });

  /**
   * Issue #3942: the four cases above pin four of the ten conversions. The six below pin the
   * rest, one per site, so no conversion can be reverted to a bare throw with the suite still
   * green. Each fixture is a WELL-FORMED result wrapper for its own method with exactly ONE
   * field malformed, so `singleSubjectResults` and the two bare outer checks in
   * `buildClaimPackage` itself are not what trips -- the target check is.
   */
  const wrap = (results: unknown) => ({ perSubject: [{ results }] });
  const versioned = (id: string) => ({ id, version: "99", parameters: {} } as unknown as ReportRecord["method"]);
  const supported = (id: string) =>
    ({ id, version: BENCHMARKING_METHOD_VERSION, parameters: {} } as unknown as ReportRecord["method"]);

  /** paired-delta@1's well-formed comparison shape; `pairs` is the field each case malforms. */
  const pairedDeltaResults = {
    pairs: 2,
    delta: "0.5000",
    interval: { alpha: "0.05", low: "0.0000", high: "1.0000" },
    reasons: [],
    pairing: { taskDigests: [digest("1")] },
    clustering: { basis: "source", clusters: 1 },
    excluded: { count: 0, cellKeys: [] },
    conflicted: { count: 0, cellKeys: [] },
    bootstrap: { seed: 1, resamples: 1 },
  } as const;

  /** binary-instrument@1 carries only `conflicted` through this projection. */
  const binaryInstrumentResults = { conflicted: { count: 0, cellKeys: [] } } as const;

  /** pairwise-disagreement@1's well-formed pairs/conflicted shape. */
  const pairwiseDisagreementResults = {
    pairs: [{ armA: "armA", armB: "armB", n: 2, disagreements: 1, rate: "0.5000" }],
    conflicted: { count: 0, cellKeys: [] },
  } as const;

  /** paired-majority-delta@1's well-formed baseline/candidate/delta shape. */
  const pairedMajorityDeltaResults = {
    baseline: "armA",
    candidate: "armB",
    n: 2,
    delta: "0.5000",
    interval: null,
    reasons: [],
    clusters: { count: 1 },
    byCandidateClass: [],
    byStratum: [],
    exclusions: [],
    conflicted: { count: 0, cellKeys: [] },
  } as const;

  test("a paired-delta@1 Report whose comparison shape is malformed refuses", () => {
    expect(() => projectFrom(
      wrap({ ...pairedDeltaResults, pairs: "2" }),
      supported(BENCHMARKING_METHOD_IDS.pairedDelta),
    )).toThrow(expect.objectContaining(refusal));
  });

  test("a binary-instrument@1 Report whose conflicted shape is malformed refuses", () => {
    expect(() => projectFrom(
      wrap({ conflicted: { count: "0", cellKeys: [] } }),
      supported(BENCHMARKING_METHOD_IDS.binaryInstrument),
    )).toThrow(expect.objectContaining(refusal));
  });

  test("a pairwise-disagreement@1 Report whose pairs/conflicted shape is malformed refuses", () => {
    expect(() => projectFrom(
      wrap({ ...pairwiseDisagreementResults, pairs: {} }),
      supported(BENCHMARKING_METHOD_IDS.pairwiseDisagreement),
    )).toThrow(expect.objectContaining(refusal));
  });

  test("a paired-majority-delta@1 Report whose baseline/candidate/delta shape is malformed refuses", () => {
    expect(() => projectFrom(
      wrap({ ...pairedMajorityDeltaResults, baseline: 1 }),
      supported(BENCHMARKING_METHOD_IDS.pairedMajorityDelta),
    )).toThrow(expect.objectContaining(refusal));
  });

  test("a Report naming an unsupported binary-instrument version refuses", () => {
    expect(() => projectFrom(
      wrap(binaryInstrumentResults),
      versioned(BENCHMARKING_METHOD_IDS.binaryInstrument),
    )).toThrow(expect.objectContaining(refusal));
  });

  test("a Report naming an unsupported paired-majority-delta version refuses", () => {
    expect(() => projectFrom(
      wrap(pairedMajorityDeltaResults),
      versioned(BENCHMARKING_METHOD_IDS.pairedMajorityDelta),
    )).toThrow(expect.objectContaining(refusal));
  });

  /** The two throws `buildClaimPackage` keeps bare are internal faults, not reader-facing: the
   * CALLER derives both facts they assert. `execution` stays the right code for them, so they must
   * NOT be typed -- this pins that boundary rather than only the conversions. */
  test("the assurance-primitive mismatch stays an untyped internal fault", () => {
    expect(() => buildClaimPackage({
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
      assurance: { preset: ASSURANCE_PRESET, resolved: { ...RESOLVED_ASSURANCE, minVerdicts: 99 } },
    })).toThrow(expect.objectContaining({ name: "Error" }));
  });
});
