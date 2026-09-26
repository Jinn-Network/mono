// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #3943: `report/claim.ts` is the hand-maintained mirror of
 * `@colophon-claims/check`'s `profile/claim.ts`, and `operations/verify.ts` reaches it through
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
import { expectedChecks, readerInstructions } from "@colophon-claims/check";
import { buildClaimPackage, ClaimPackageSchema, COMPOSED_CLAIM_PACKAGE_SCHEMA_ID, type ClaimPackage } from "./claim.js";
import { buildLocalVenueHonesty } from "../operations/run-results.js";
import { assertClaimConsistency } from "../verification/claim-consistency.js";
import {
  ANCHORED_CLAIM_PACKAGE_SCHEMA_ID,
  CLAIM_PACKAGE_SCHEMA_ID,
  PUBLIC_BUNDLE_V6_CHECKS,
  PUBLIC_BUNDLE_V6_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
  PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
} from "../legacy-closures.js";

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

/**
 * Issue #3403, mirrored from `@colophon-claims/check`'s own
 * `profile/claim-consistency.test.ts`. The two claim projections are hand-maintained copies that
 * must agree byte for byte, so the composed claim package is asserted on both sides rather than on
 * whichever one a given entry point happens to reach.
 *
 * The composed generation's claim carries one id, `claim-package/7`, for every capability vector.
 * What it must carry is derived from the vector its bundle declares: the sections (biconditionally),
 * the check list, and the reader line. `claim-package/4` is carried by `/6` alone again, and admits
 * the one reader pair it always did.
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
      reportSha256: identities.reportSha256,
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
      benchmarkRecord: {} as never,
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
    // No composed claim names the first-public 0.1 line or v7's verify 0.2.1: neither reader
    // understands the format. It names the first checker release (issue #4746).
    expect(anchored.verification.command).toBe("npx @colophon-claims/check@0.2.1 <bundle-dir>");
    expect(base.verification.command).toBe("npx @colophon-claims/check@0.2.1 <bundle-dir>");

    // Section contents move across verbatim: only the id and the pins differ from claim-package/4.
    expect({ ...anchored, claimSchema: undefined, verification: undefined })
      .toEqual({ ...claimFor({ anchors: [] }), claimSchema: undefined, verification: undefined });
    for (const claim of [base, anchored]) expect(ClaimPackageSchema.safeParse(claim).success).toBe(true);
  });

  test("the builder refuses a section and a declaration that do not arrive together", () => {
    expect(() => claimFor({ composedCapabilities: ["anchoring"] })).toThrow(/"anchoring" and its "anchors" section/u);
    expect(() => claimFor({ composedCapabilities: [], anchors: [] })).toThrow(/"anchoring" and its "anchors" section/u);
    expect(() => claimFor({ composedCapabilities: ["binary-qualification"] }))
      .toThrow(/"binary-qualification" and its "qualification" section/u);
    expect(() => claimFor({ composedCapabilities: ["external-import"] }))
      .toThrow(/"external-import" and its "externalImport" section/u);
    // A vector the registry does not admit is refused before any section is looked at.
    expect(() => claimFor({ composedCapabilities: ["zz-unknown"] })).toThrow(/does not implement capability "zz-unknown"/u);
  });

  test("the schema pins the checks and the reader line to the sections the claim carries", () => {
    const anchored = claimFor({ composedCapabilities: ["anchoring"], anchors: [] });
    const { anchors: _section, ...stripped } = anchored;
    const issuesOf = (claim: unknown): string[] => {
      const parsed = ClaimPackageSchema.safeParse(claim);
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    };
    expect(issuesOf(stripped)).toEqual([expect.stringContaining("six base checks plus each carried capability's")]);
    expect(issuesOf({ ...anchored, verification: { ...anchored.verification, command: PUBLIC_BUNDLE_V6_VERIFICATION_COMMAND } }))
      .toEqual([expect.stringContaining("must pin the reader release its capability sections derive")]);
  });

  test("a composed claim naming a reader that predates /10 is refused (issue #4746)", () => {
    // verify 0.2.1 is the release /7 and /8 pin. It predates the composed generation and refuses
    // every /10 bundle at manifest parse, so neither of its lines is admitted on a composed claim.
    const issuesOf = (claim: unknown): string[] => {
      const parsed = ClaimPackageSchema.safeParse(claim);
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    };
    for (const claim of [
      claimFor({ composedCapabilities: [] }),
      claimFor({ composedCapabilities: ["anchoring"], anchors: [] }),
    ]) {
      expect(issuesOf(claim)).toEqual([]);
      for (const verification of [
        {
          ...claim.verification,
          command: PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND,
          compatibleCommand: PUBLIC_BUNDLE_V7_COMPATIBLE_VERIFICATION_COMMAND,
        },
        { ...claim.verification, command: PUBLIC_BUNDLE_V7_VERIFICATION_COMMAND },
      ]) {
        expect(issuesOf({ ...claim, verification }))
          .toEqual([expect.stringContaining("must pin the reader release its capability sections derive")]);
      }
    }
  });

  test("the rebuild reads the vector from the bundle, so neither half of the biconditional passes", () => {
    // Declared without its section, and a section without its declaration.
    expect(consistency(claimFor({ composedCapabilities: [] }), { composedCapabilities: ["anchoring"], anchors: [] }))
      .toThrow(/claim package anchors is not the exact projection/u);
    expect(consistency(claimFor({ composedCapabilities: ["anchoring"], anchors: [] }), { composedCapabilities: [] }))
      .toThrow(/claim package anchors is not the exact projection/u);
    // A pre-composition claim inside a composed bundle, and the reverse.
    expect(consistency(claimFor({ anchors: [] }), { composedCapabilities: ["anchoring"], anchors: [] }))
      .toThrow(/claim package claimSchema is not the exact projection/u);
    expect(consistency(claimFor({ composedCapabilities: ["anchoring"], anchors: [] }), { anchors: [] }))
      .toThrow(/claim package claimSchema is not the exact projection/u);
    // The vector the bundle declares makes the matching claim consistent.
    expect(consistency(
      claimFor({ composedCapabilities: ["anchoring"], anchors: [] }),
      { composedCapabilities: ["anchoring"], anchors: [] },
    )).not.toThrow();
  });
});
