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
import { buildLocalVenueHonesty } from "./run-results.js";

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
