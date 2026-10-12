// SPDX-License-Identifier: Apache-2.0

/**
 * The `/10` capability `terminal-bench-2-1-comparability`, core's side.
 *
 * `report/claim.ts` and `verification/claim-consistency.ts` are the hand-maintained mirrors of the
 * checker's. The sentence, the section schema, the pinned slate, and every assertion are imported
 * from `@colophon-claims/check`, so both sides seal and rebuild the same bytes. These tests pin
 * that core composes the section and the sentence's slot exactly as the checker does, and refuses
 * the same disagreements.
 */

import { describe, expect, test } from "vitest";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  parseBenchmark,
  type BenchmarkRecord,
  type MatrixRecord,
  type ReportRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import {
  EXTERNAL_IMPORT_CAPABILITY,
  TERMINAL_BENCH_21_COMPARABILITY_CAPABILITY,
  TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
  TERMINAL_BENCH_21_PINS,
  deriveClaimTerminalBench21Comparability,
  type ClaimExternalImportSection,
  type ClaimTerminalBench21ComparabilitySection,
} from "@colophon-claims/check";
import { buildTerminalBench21Tasks } from "../intake/terminal-bench-2-1.js";
import { buildLocalVenueHonesty, localVenueLimitsForRun } from "../operations/run-results.js";
import { SUITE_NOT_LEADERBOARD_READY_LIMITATION } from "../runtime/suite-protocol/comparability.js";
import { assertClaimConsistency } from "../verification/claim-consistency.js";
import { buildClaimPackage, ClaimPackageSchema, type ClaimPackage } from "./claim.js";

const TOKEN = TERMINAL_BENCH_21_COMPARABILITY_CAPABILITY;
const VECTOR = [EXTERNAL_IMPORT_CAPABILITY, TOKEN] as const;
const digest = (fill: string) => fill.repeat(64);
const DRAFT_ID = "draft-1";
const ASSURANCE_PRESET = "direct-check";
const RESOLVED_ASSURANCE = {
  independence: "disclosed",
  minVerdicts: 1,
  distinctEvaluator: false,
  verdictRule: "sole",
} as const;

/** The Benchmark the product's own builder seals for the one-task slice. */
const built = buildTerminalBench21Tasks({ coverage: "one_task" });
const benchmark = parseBenchmark(built.benchmark.bytes);
const TASK_SHA256 = built.tasks[0]!.sha256;

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

const CELL_KEY = `${TASK_SHA256}/armA/1`;
const matrixRecord = {
  cells: [{
    cellKey: CELL_KEY,
    taskDigest: TASK_SHA256,
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
  benchmarkSha256: built.benchmark.sha256,
  runSha256: digest("c"),
  matrixSha256: digest("d"),
  reportSha256: digest("e"),
  reportEnvelopeSha256: digest("f"),
} as const;

function importedFrom(harness: string): ClaimExternalImportSection {
  return {
    dumpSha256: digest("a"),
    dumpByteLength: 10,
    declarationSha256: digest("9"),
    source: { harness, version: "0.21.0" },
    rows: [{ cellKey: CELL_KEY, outcome: "graded" }],
  };
}
const HARBOR_IMPORT = importedFrom("harbor");

const VENUE = [...localVenueLimitsForRun(runRecord, true, false)];
const SEALED = [...VENUE, TERMINAL_BENCH_21_COMPARABILITY_LIMIT];
const section = deriveClaimTerminalBench21Comparability({ benchmarkRecord: benchmark, importSourceHarness: "harbor" });

function claimFor(input: {
  readonly composedCapabilities?: readonly string[];
  readonly section?: ClaimTerminalBench21ComparabilitySection;
  readonly report: ReportRecord;
}): ClaimPackage {
  const imported = input.composedCapabilities?.includes(EXTERNAL_IMPORT_CAPABILITY) === true;
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
    venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord, [], imported, false),
    verificationCommandVerb: "bundle verify",
    assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
    ...(input.composedCapabilities === undefined ? {} : { composedCapabilities: input.composedCapabilities }),
    ...(imported ? { externalImport: HARBOR_IMPORT } : {}),
    ...(input.section === undefined ? {} : { terminalBench21Comparability: input.section }),
  });
}

function verify(claim: ClaimPackage, bundle: {
  readonly composedCapabilities?: readonly string[];
  readonly benchmarkRecord?: BenchmarkRecord;
  readonly report: ReportRecord;
  readonly externalImport?: ClaimExternalImportSection;
  readonly additionalLimitations?: readonly string[];
}): () => void {
  const imported = bundle.composedCapabilities?.includes(EXTERNAL_IMPORT_CAPABILITY) === true;
  return () => assertClaimConsistency({
    claim,
    identities,
    benchmarkRecord: bundle.benchmarkRecord ?? benchmark,
    runRecord,
    matrixRecord,
    reportRecord: bundle.report,
    draftId: DRAFT_ID,
    assurancePreset: ASSURANCE_PRESET,
    ...(bundle.composedCapabilities === undefined ? {} : { composedCapabilities: bundle.composedCapabilities }),
    ...(imported ? { externalImport: bundle.externalImport ?? HARBOR_IMPORT } : {}),
    ...(bundle.additionalLimitations === undefined ? {} : { additionalLimitations: bundle.additionalLimitations }),
  });
}

describe("core's claim mirror of terminal-bench-2-1-comparability", () => {
  test("the builder's one-task Benchmark projects the section the checker pins", () => {
    expect(section).toEqual({
      datasetId: TERMINAL_BENCH_21_PINS.datasetId,
      datasetRevision: TERMINAL_BENCH_21_PINS.datasetRevision,
      upstreamCommit: TERMINAL_BENCH_21_PINS.upstreamCommit,
      slateDigest: TERMINAL_BENCH_21_PINS.slateDigest,
      coverage: "one_task",
      selectedTaskCount: 1,
      datasetTaskCount: 89,
      limit: TERMINAL_BENCH_21_COMPARABILITY_LIMIT,
    });
  });

  test("a declared claim carries the section and the Report's sentence, and verifies", () => {
    const report = reportWith(SEALED);
    const claim = claimFor({ composedCapabilities: VECTOR, section, report });
    expect(claim.terminalBench21Comparability).toEqual(section);
    expect(claim.limitations).toEqual(SEALED);
    expect(ClaimPackageSchema.safeParse(claim).success).toBe(true);
    expect(verify(claim, { composedCapabilities: VECTOR, report })).not.toThrow();
  });

  test("an undeclared claim carries neither", () => {
    const report = reportWith(VENUE);
    const claim = claimFor({ composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], report });
    expect(claim.terminalBench21Comparability).toBeUndefined();
    expect(verify(claim, { composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], report })).not.toThrow();
  });

  test("the builder refuses a declaration and a section that do not arrive together", () => {
    const report = reportWith(SEALED);
    expect(() => claimFor({ composedCapabilities: VECTOR, report }))
      .toThrow(/"terminal-bench-2-1-comparability" and its "terminalBench21Comparability" section/u);
    expect(() => claimFor({ composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], section, report }))
      .toThrow(/"terminal-bench-2-1-comparability" and its "terminalBench21Comparability" section/u);
  });

  test("the schema admits the section on a composed claim alone, closed, with the sealed wording", () => {
    const composed = claimFor({ composedCapabilities: VECTOR, section, report: reportWith(SEALED) });
    expect(ClaimPackageSchema.safeParse({ ...composed, terminalBench21Comparability: { ...section, limit: "Another sentence." } }).success)
      .toBe(false);
    expect(ClaimPackageSchema.safeParse({ ...composed, terminalBench21Comparability: { ...section, leaderboardSubmitReady: false } }).success)
      .toBe(false);
    const legacy = claimFor({ report: reportWith([...localVenueLimitsForRun(runRecord)]) });
    const parsed = ClaimPackageSchema.safeParse({ ...legacy, terminalBench21Comparability: section });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message))
      .toEqual([expect.stringContaining("only the composed claim-package/7 allocation carries a terminalBench21Comparability section")]);
  });

  test("the sentence without the declaration is refused, on the claim and on the Report", () => {
    const sealed = reportWith(SEALED);
    expect(verify(claimFor({ composedCapabilities: VECTOR, section, report: sealed }), { composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], report: sealed }))
      .toThrow(/claim package terminalBench21Comparability is not the exact projection/u);
    expect(verify(claimFor({ composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], report: sealed }), { composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], report: sealed }))
      .toThrow(/does not declare terminal-bench-2-1-comparability/u);
    // A pre-composition bundle cannot declare it at all.
    const legacySealed = reportWith([...localVenueLimitsForRun(runRecord), TERMINAL_BENCH_21_COMPARABILITY_LIMIT]);
    expect(verify(claimFor({ report: legacySealed }), { report: legacySealed }))
      .toThrow(/does not declare terminal-bench-2-1-comparability/u);
  });

  test("the declaration without the sentence is refused, on the claim and on the Report", () => {
    const sealed = reportWith(SEALED);
    expect(verify(claimFor({ composedCapabilities: [EXTERNAL_IMPORT_CAPABILITY], report: sealed }), { composedCapabilities: VECTOR, report: sealed }))
      .toThrow(/claim package (claimSchema|terminalBench21Comparability) is not the exact projection/u);
    const bare = reportWith(VENUE);
    expect(verify(claimFor({ composedCapabilities: VECTOR, section, report: bare }), { composedCapabilities: VECTOR, report: bare }))
      .toThrow(/must seal the comparability sentence once in its Report limitations/u);
  });

  test("an edited section is refused on the field that was edited", () => {
    const report = reportWith(SEALED);
    const claim = claimFor({ composedCapabilities: VECTOR, section, report });
    const edited = { ...claim, terminalBench21Comparability: { ...section, coverage: "full" } } as ClaimPackage;
    expect(verify(edited, { composedCapabilities: VECTOR, report }))
      .toThrow(/claim package terminalBench21Comparability\.coverage is not the exact projection/u);
  });

  test("a Benchmark whose Task is off the pin, or whose import does not name Harbor, is refused", () => {
    const report = reportWith(SEALED);
    const claim = claimFor({ composedCapabilities: VECTOR, section, report });
    const offPin = { ...benchmark, items: [{ task: { digest: { sha256: digest("5") } } }] } as unknown as BenchmarkRecord;
    expect(verify(claim, { composedCapabilities: VECTOR, benchmarkRecord: offPin, report }))
      .toThrow(/not the pinned official Task/u);
    expect(verify(claim, { composedCapabilities: VECTOR, report, externalImport: importedFrom("my-own-runner") }))
      .toThrow(/imported from "my-own-runner", not from a Harbor jobs directory/u);
  });

  test("the sentence follows every line core derives ahead of it, the older suite sentence included", () => {
    // Core alone can be handed a suite limitation (a bound evaluation runtime). The sentence's slot
    // is directly after it, which is where `report` seals it.
    const withSuite = [...VENUE, SUITE_NOT_LEADERBOARD_READY_LIMITATION, TERMINAL_BENCH_21_COMPARABILITY_LIMIT];
    const report = reportWith(withSuite);
    const claim = claimFor({ composedCapabilities: VECTOR, section, report });
    expect(verify(claim, { composedCapabilities: VECTOR, report, additionalLimitations: [SUITE_NOT_LEADERBOARD_READY_LIMITATION] }))
      .not.toThrow();
    const swapped = reportWith([...VENUE, TERMINAL_BENCH_21_COMPARABILITY_LIMIT, SUITE_NOT_LEADERBOARD_READY_LIMITATION]);
    expect(verify(claimFor({ composedCapabilities: VECTOR, section, report: swapped }), {
      composedCapabilities: VECTOR,
      report: swapped,
      additionalLimitations: [SUITE_NOT_LEADERBOARD_READY_LIMITATION],
    })).toThrow(/must seal the comparability sentence once in its Report limitations/u);
  });

  test("the older suite sentence is a different sentence and is unchanged", () => {
    expect(SUITE_NOT_LEADERBOARD_READY_LIMITATION).toBe(
      "This run is not a Terminal-Bench 2.1 leaderboard submission: coverage is not the full official dataset, execution was not protocol-conforming, the Matrix does not account every dataset task × 5 as judged or Harbor-error 0, or ATIF trajectories are missing from the retained Harbor job.",
    );
    expect(TERMINAL_BENCH_21_COMPARABILITY_LIMIT).not.toBe(SUITE_NOT_LEADERBOARD_READY_LIMITATION);
  });
});
