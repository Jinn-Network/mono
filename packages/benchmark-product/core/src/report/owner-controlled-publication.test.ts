// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #3401, core's side: `report/claim.ts` and `verification/claim-consistency.ts` are the
 * hand-maintained mirrors of the checker's, and `operations/run-results.ts` keeps its own copy of
 * the five venue sentences. The sixth sentence is imported from `@colophon-claims/check`, so both
 * sides seal the same bytes; these tests pin that core composes it exactly as the checker does, and
 * refuses the same two disagreements: the sentence without the declaration, and the declaration
 * without the sentence.
 */

import { describe, expect, test } from "vitest";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  type BenchmarkRecord,
  type MatrixRecord,
  type ReportRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import {
  IMPORTED_RUN_PINNING_LIMIT,
  OWNER_CONTROLLED_PUBLICATION_CAPABILITY,
  OWNER_CONTROLLED_PUBLICATION_LIMIT,
} from "@colophon-claims/check";
import { buildClaimPackage, ClaimPackageSchema, type ClaimPackage } from "./claim.js";
import { LOCAL_VENUE_LIMITS, buildLocalVenueHonesty, localVenueLimitsForRun } from "../operations/run-results.js";
import { assertClaimConsistency } from "../verification/claim-consistency.js";

const OCP = OWNER_CONTROLLED_PUBLICATION_CAPABILITY;
const digest = (fill: string) => fill.repeat(64);
const DRAFT_ID = "draft-1";
const ASSURANCE_PRESET = "direct-check";
const RESOLVED_ASSURANCE = {
  independence: "disclosed",
  minVerdicts: 1,
  distinctEvaluator: false,
  verdictRule: "sole",
} as const;

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

function reportWith(limitations: readonly string[]): ReportRecord {
  return {
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
    limitations: [...limitations],
  } as unknown as ReportRecord;
}

const identities = {
  benchmarkSha256: digest("b"),
  runSha256: digest("c"),
  matrixSha256: digest("d"),
  reportSha256: digest("e"),
  reportEnvelopeSha256: digest("f"),
} as const;

function claimFor(input: {
  readonly composedCapabilities?: readonly string[];
  readonly declared: boolean;
  readonly report: ReportRecord;
}): ClaimPackage {
  return buildClaimPackage({
    draftId: DRAFT_ID,
    benchmarkSha256: identities.benchmarkSha256,
    runRecord,
    runSha256: identities.runSha256,
    matrixRecord,
    matrixSha256: identities.matrixSha256,
    reportRecord: input.report,
    reportSha256: identities.reportSha256,
    reportEnvelopeSha256: identities.reportEnvelopeSha256,
    venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord, [], false, input.declared),
    verificationCommandVerb: "bundle verify",
    assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
    ...(input.composedCapabilities === undefined ? {} : { composedCapabilities: input.composedCapabilities }),
    ...(input.declared ? { ownerControlledPublication: OWNER_CONTROLLED_PUBLICATION_LIMIT } : {}),
  });
}

function verify(claim: ClaimPackage, bundle: { readonly composedCapabilities?: readonly string[]; readonly report: ReportRecord }): () => void {
  return () => assertClaimConsistency({
    claim,
    identities,
    benchmarkRecord: {} as unknown as BenchmarkRecord,
    runRecord,
    matrixRecord,
    reportRecord: bundle.report,
    draftId: DRAFT_ID,
    assurancePreset: ASSURANCE_PRESET,
    ...(bundle.composedCapabilities === undefined ? {} : { composedCapabilities: bundle.composedCapabilities }),
  });
}

const FIVE = [...LOCAL_VENUE_LIMITS];
const SIX = [...LOCAL_VENUE_LIMITS, OWNER_CONTROLLED_PUBLICATION_LIMIT];

describe("core's venue sentences (issue #3401)", () => {
  test("not declared: the five, as the same array", () => {
    expect(LOCAL_VENUE_LIMITS).toHaveLength(5);
    expect(localVenueLimitsForRun(runRecord)).toBe(LOCAL_VENUE_LIMITS);
    expect(localVenueLimitsForRun(runRecord, false, false)).toBe(LOCAL_VENUE_LIMITS);
  });

  test("declared: appended after the five, the import-aware five included", () => {
    expect(localVenueLimitsForRun(runRecord, false, true)).toEqual(SIX);
    expect(localVenueLimitsForRun(runRecord, true, true)).toEqual([
      ...FIVE.slice(0, 2),
      IMPORTED_RUN_PINNING_LIMIT,
      ...FIVE.slice(3),
      OWNER_CONTROLLED_PUBLICATION_LIMIT,
    ]);
    expect(buildLocalVenueHonesty(matrixRecord.cells, runRecord, [], false, true).limits).toEqual(SIX);
  });
});

describe("core's claim mirror (issue #3401)", () => {
  test("a declared claim carries the section, the six venue sentences, and the Report's six", () => {
    const report = reportWith(SIX);
    const claim = claimFor({ composedCapabilities: [OCP], declared: true, report });
    expect(claim.ownerControlledPublication).toBe(OWNER_CONTROLLED_PUBLICATION_LIMIT);
    expect(claim.limitations).toEqual(SIX);
    expect(ClaimPackageSchema.safeParse(claim).success).toBe(true);
    expect(verify(claim, { composedCapabilities: [OCP], report })).not.toThrow();
  });

  test("an undeclared claim keeps the five and carries no section", () => {
    const report = reportWith(FIVE);
    const claim = claimFor({ composedCapabilities: [], declared: false, report });
    expect(claim.ownerControlledPublication).toBeUndefined();
    expect(verify(claim, { composedCapabilities: [], report })).not.toThrow();
  });

  test("the builder refuses a declaration and a section that do not arrive together", () => {
    const report = reportWith(SIX);
    const build = (composedCapabilities: readonly string[], section: boolean) => () => buildClaimPackage({
      draftId: DRAFT_ID,
      benchmarkSha256: identities.benchmarkSha256,
      runRecord,
      runSha256: identities.runSha256,
      matrixRecord,
      matrixSha256: identities.matrixSha256,
      reportRecord: report,
      reportSha256: identities.reportSha256,
      reportEnvelopeSha256: identities.reportEnvelopeSha256,
      venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord, [], false, true),
      verificationCommandVerb: "bundle verify",
      assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
      composedCapabilities,
      ...(section ? { ownerControlledPublication: OWNER_CONTROLLED_PUBLICATION_LIMIT } : {}),
    });
    expect(build([OCP], false)).toThrow(/"owner-controlled-publication" and its "ownerControlledPublication" section/u);
    expect(build([], true)).toThrow(/"owner-controlled-publication" and its "ownerControlledPublication" section/u);
  });

  test("the schema admits the section on a composed claim alone, and only with the ruled wording", () => {
    const composed = claimFor({ composedCapabilities: [OCP], declared: true, report: reportWith(SIX) });
    expect(ClaimPackageSchema.safeParse({ ...composed, ownerControlledPublication: "Another sentence." }).success).toBe(false);
    const legacy = claimFor({ declared: false, report: reportWith(FIVE) });
    const parsed = ClaimPackageSchema.safeParse({ ...legacy, ownerControlledPublication: OWNER_CONTROLLED_PUBLICATION_LIMIT });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message))
      .toEqual([expect.stringContaining("only the composed claim-package/7 allocation carries an ownerControlledPublication section")]);
  });

  test("the sentence without the declaration is refused, on the claim and on the Report", () => {
    const six = reportWith(SIX);
    expect(verify(claimFor({ composedCapabilities: [OCP], declared: true, report: six }), { composedCapabilities: [], report: six }))
      .toThrow(/claim package (ownerControlledPublication|venueHonesty\.limits\.5) is not the exact projection/u);
    expect(verify(claimFor({ composedCapabilities: [], declared: false, report: six }), { composedCapabilities: [], report: six }))
      .toThrow(/does not declare owner-controlled-publication/u);
    // A pre-composition bundle cannot declare it at all.
    expect(verify(claimFor({ declared: false, report: six }), { report: six }))
      .toThrow(/does not declare owner-controlled-publication/u);
  });

  test("the declaration without the sentence is refused, on the claim and on the Report", () => {
    const six = reportWith(SIX);
    expect(verify(claimFor({ composedCapabilities: [], declared: false, report: six }), { composedCapabilities: [OCP], report: six }))
      .toThrow(/claim package (ownerControlledPublication|venueHonesty\.limits) is not the exact projection/u);
    const five = reportWith(FIVE);
    expect(verify(claimFor({ composedCapabilities: [OCP], declared: true, report: five }), { composedCapabilities: [OCP], report: five }))
      .toThrow(/must seal the publication-source sentence in its Report limitations/u);
  });
});
