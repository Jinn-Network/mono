// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #3943: `report/claim.ts` is the hand-maintained mirror of
 * `@colophon-claims/verify`'s `profile/claim.ts`, and `operations/verify.ts` reaches it through
 * core's own `assertClaimConsistency` -- a reader path of its own. Issue #3855 (PR #3899) typed
 * the ten projection-rebuild refusals on the verify side only, so until this file the SAME
 * malformed sealed Report was classified two ways depending on which entry point read it:
 * `record-integrity` through the standalone verifier, an untyped throw carried as `execution`
 * through here.
 *
 * That is the shift these tests pin: for these ten conditions core's own path now carries the
 * same code and source path a reader already gets from the standalone verifier. Where that code
 * reaches a reader through `colophon-verify`'s exit mapping it is the 2 ("the verifier broke")
 * to 1 ("the bundle is bad") shift issue #3943 named.
 *
 * Pinned structurally on `name` / `code` / `issues[].path` rather than on the prose: messages are
 * free to change, codes and paths are the contract. One case per site, each fixture malforming
 * only the field its own check reads, so the two throws `buildClaimPackage` keeps bare are not
 * what trips -- the last test pins that boundary from the other side.
 */

import { describe, expect, test } from "vitest";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  type MatrixRecord,
  type ReportRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { buildClaimPackage, type ClaimPackage } from "./claim.js";
import { buildLocalVenueHonesty } from "../operations/run-results.js";

const digest = (fill: string) => fill.repeat(64);
const DRAFT_ID = "draft-1";
const ASSURANCE_PRESET = "direct-check";
const RESOLVED_ASSURANCE = {
  independence: "disclosed",
  minVerdicts: 1,
  distinctEvaluator: false,
  verdictRule: "sole",
} as const;

/** One arm, one judged cell -- the smallest sealed shape `buildClaimPackage` projects from. */
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

const wilsonResults = {
  arms: { armA: { n: 1, passRate: "1", wilsonInterval: { low: "0.207", high: "1" } } },
  conflicted: { count: 0, cellKeys: [] },
} as const;

const reportRecord = {
  method: { id: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: {} },
  preregistered: false,
  results: { perSubject: [{ results: wilsonResults }] },
  disclosures: { perSubject: [] },
  limitations: [],
} as unknown as ReportRecord;

const identities = {
  benchmarkSha256: digest("b"),
  runSha256: digest("c"),
  matrixSha256: digest("d"),
  reportSha256: digest("e"),
  reportEnvelopeSha256: digest("f"),
} as const;

describe("issue #3943: core's mirror projection rebuild refuses at the source that carries the malformed fact", () => {
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
      reportSha256: identities.reportSha256,
      reportEnvelopeSha256: identities.reportEnvelopeSha256,
      venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, plannedRun),
      verificationCommandVerb: "bundle verify",
      assurance: { preset: ASSURANCE_PRESET, resolved: RESOLVED_ASSURANCE },
    });
  }

  const refusal = { name: "BenchmarkProductError", code: "record-integrity", issues: [expect.objectContaining({ path: "report.json" })] };

  const wrap = (results: unknown) => ({ perSubject: [{ results }] });
  const versioned = (id: string) => ({ id, version: "99", parameters: {} } as unknown as ReportRecord["method"]);
  const supported = (id: string) =>
    ({ id, version: BENCHMARKING_METHOD_VERSION, parameters: {} } as unknown as ReportRecord["method"]);

  /** paired-delta@1's well-formed comparison shape; `pairs` is the field the case malforms. */
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

  test("a Report carrying no single-subject results wrapper refuses", () => {
    expect(() => projectFrom({ perSubject: [] })).toThrow(expect.objectContaining(refusal));
  });

  test("a wilson@1 Report whose arms/conflicted shape is malformed refuses", () => {
    expect(() => projectFrom(wrap({ ...wilsonResults, arms: "not-an-object" })))
      .toThrow(expect.objectContaining(refusal));
  });

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

  test("a Report naming an unsupported pairwise-disagreement version refuses", () => {
    expect(() => projectFrom(
      wrap(pairwiseDisagreementResults),
      versioned(BENCHMARKING_METHOD_IDS.pairwiseDisagreement),
    )).toThrow(expect.objectContaining(refusal));
  });

  test("a Report naming an unsupported paired-majority-delta version refuses", () => {
    expect(() => projectFrom(
      wrap(pairedMajorityDeltaResults),
      versioned(BENCHMARKING_METHOD_IDS.pairedMajorityDelta),
    )).toThrow(expect.objectContaining(refusal));
  });

  test("a Report naming a method with no claim-package projection refuses", () => {
    const method = { id: "jinn.benchmarking.method/not-wired", version: BENCHMARKING_METHOD_VERSION, parameters: {} };
    expect(() => projectFrom(reportRecord.results, method as unknown as ReportRecord["method"]))
      .toThrow(expect.objectContaining(refusal));
  });

  /** The two throws `buildClaimPackage` keeps bare are internal faults, not reader-facing: the
   * CALLER derives both facts they assert. `execution` stays the right code for them, so they
   * must NOT be typed -- this pins that boundary rather than only the conversions. */
  test("the assurance-primitive mismatch stays an untyped internal fault", () => {
    expect(() => buildClaimPackage({
      draftId: DRAFT_ID,
      benchmarkSha256: identities.benchmarkSha256,
      runRecord,
      runSha256: identities.runSha256,
      matrixRecord,
      matrixSha256: identities.matrixSha256,
      reportRecord,
      reportSha256: identities.reportSha256,
      reportEnvelopeSha256: identities.reportEnvelopeSha256,
      venueHonesty: buildLocalVenueHonesty(matrixRecord.cells, runRecord),
      verificationCommandVerb: "bundle verify",
      assurance: { preset: ASSURANCE_PRESET, resolved: { ...RESOLVED_ASSURANCE, minVerdicts: 99 } },
    })).toThrow(expect.objectContaining({ name: "Error" }));
  });
});
