import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_PROTOCOL,
  cellKey,
  documentDigest,
  sealMatrix,
  sealReport,
  sealRun,
} from "@jinn-network/benchmarking-records";
import { describe, expect, test } from "vitest";
import { compileObjectivePreset } from "./objective-presets.js";
import { projectRecommendation } from "./recommendation.js";

const task = "a".repeat(64);
const current = `sha256:${"1".repeat(64)}`;
const challenger = `sha256:${"2".repeat(64)}`;
const author = "urn:uuid:10000000-0000-5000-8000-000000000001";

function fixture(signP = "0.03125") {
  const objective = compileObjectivePreset("more-tasks-succeed@1", {
    baselineArm: "current", candidateArm: "challenger",
  });
  const run = sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: "b".repeat(64) } },
    owner: author,
    arms: [
      { armId: "current", pinning: { loadout: { op: "eq", value: "current" } } },
      { armId: "challenger", pinning: { loadout: { op: "eq", value: "challenger" } } },
    ],
    replicates: 1,
    policy: {
      completenessFloor: "1", cellWindow: 1,
      replacement: { allowed: false }, independence: "disclosed",
      evaluation: { minVerdicts: 1 }, submissionBaseline: {},
    },
    analysisPlan: objective.methods.map((method) => ({
      method: method.id, version: method.version, parameters: method.parameters,
    })),
    closeAt: "2026-08-05T00:00:00Z",
  });
  const verification = { harness: "match", model: "match", loadout: "match", isolation: "match", checksFailed: [] };
  const counts = { expected: 1, judged: 1, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 0, replacements: 0 };
  const matrix = sealMatrix({
    protocol: BENCHMARKING_PROTOCOL,
    run: { digest: { sha256: run.digest.slice(7) } },
    closeBoundary: { at: "2026-08-05T00:00:00Z" },
    cells: ["challenger", "current"].map((armId) => ({
      cellKey: cellKey(task, armId, 1), taskDigest: task, armId, replicate: 1,
      dispatches: 1, accounted: 1,
      submission: `sha256:${armId === "current" ? "d".repeat(64) : "e".repeat(64)}`,
      delivery: `sha256:${armId === "current" ? "f".repeat(64) : "9".repeat(64)}`,
      verdicts: [`sha256:${"c".repeat(64)}`], validVerdicts: [`sha256:${"c".repeat(64)}`],
      outcome: "judged", verification, integrityTier: "re-derivable",
    })),
    exclusions: [],
    attrition: { perArm: { current: counts, challenger: counts }, asymmetryFlags: [] },
    completeness: { expected: 2, judged: 2, floor: "1", runOutcome: "complete" },
    assembly: { procedure: "fixture", version: "1" },
  });
  const disclosure = {
    subjectSha256: matrix.digest.slice(7),
    integrityTiers: { "re-derivable": 2, "attested-only": 0 },
    pinning: Object.fromEntries(["harness", "model", "loadout", "isolation"].map((axis) => [axis, { match: 2, mismatch: 0, unverifiable: 0 }])),
    independence: 2,
    completeness: { expected: 2, judged: 2, floor: "1", runOutcome: "complete" },
    attrition: { perArm: { current: counts, challenger: counts }, asymmetryFlags: [] },
  };
  const resultFor = (id: string) => id === BENCHMARKING_METHOD_IDS.pairedMcnemar
    ? { improved: 6, regressed: 0, "pValue": "0.03125" }
    : id === BENCHMARKING_METHOD_IDS.provenanceClusterSign
      ? { favorable: 6, unfavorable: 0, nonTied: 6, "pValue": signP }
      : { arms: {} };
  const reports = objective.methods.map((method) => sealReport({
    protocol: BENCHMARKING_PROTOCOL,
    subjects: [{ digest: { sha256: matrix.digest.slice(7) } }],
    method,
    preregistered: true,
    results: { perSubject: [{ subjectSha256: matrix.digest.slice(7), results: resultFor(method.id) }] },
    disclosures: { perSubject: [disclosure] },
    author,
  }).bytes);
  return { objective, run: run.bytes, matrix: matrix.bytes, reports };
}

describe("projectRecommendation", () => {
  test("proves a challenger only when both exact tests and all gates pass", () => {
    const value = fixture();
    const decision = projectRecommendation({
      objectivePreset: "more-tasks-succeed@1", objective: value.objective,
      currentTupleDigest: current, challengerTupleDigest: challenger,
      runBytes: value.run, matrixBytes: value.matrix, reportBytes: value.reports,
    });
    expect(decision.status).toBe("proven");
    expect(decision.recommendedTupleDigest).toBe(challenger);
    expect(decision.basis.runDigest).toBe(documentDigest(value.run));
  });

  test("keeps current with explicit reason codes when a proof gate misses", () => {
    const value = fixture("0.0625");
    const decision = projectRecommendation({
      objectivePreset: "more-tasks-succeed@1", objective: value.objective,
      currentTupleDigest: current, challengerTupleDigest: challenger,
      runBytes: value.run, matrixBytes: value.matrix, reportBytes: value.reports,
    });
    expect(decision.status).toBe("inconclusive");
    expect(decision.recommendedTupleDigest).toBe(current);
    expect(decision.reasonCodes).toContain("provenance-sign-not-significant");
  });
});
