import { describe, expect, test } from "vitest";
import type { VerdictRule } from "@jinn-network/task-execution-profiles";
import {
  InspectCellSummaryV2Schema,
  InspectLogObservationSchema,
  projectInspectCellVerdict,
  verifyInspectLogProjection,
} from "./artifacts.js";
import type { InspectSelectionManifest } from "./manifest.js";

const projections = [
  { measurementName: "correct", scorerName: "correctness", passValue: "C" },
  { measurementName: "safe", scorerName: "policy", subScoreKey: "safe", passValue: true },
] as const;

function manifest(verdictRule: VerdictRule): InspectSelectionManifest {
  return {
    schema: "jinn.network/benchmark-product/inspect-selection/3",
    scorers: [
      { name: "correctness", definition: {} },
      { name: "policy", definition: {} },
      { name: "diagnostic", definition: {} },
    ],
    scoring: {
      projections: [...projections],
      verdictRule,
      inspectMetrics: null,
      inspectEpochReducers: null,
    },
  } as unknown as InspectSelectionManifest;
}

function summary(correct: boolean, safe: boolean) {
  return InspectCellSummaryV2Schema.parse({
    schema: "jinn.network/benchmark-product/inspect-cell-summary/2",
    terminal: "scored",
    inspectStatus: "success",
    expectedSamples: 1,
    observedSamples: 1,
    erroredSamples: 0,
    invalidated: false,
    scorers: [
      { name: "correctness", presentSamples: 1, missingSamples: 0, valueShapes: ["string"] },
      // A non-selected dictionary member and even a missing non-selected scorer output never
      // become an invented Jinn claim; only the sealed projections below determine the verdict.
      { name: "policy", presentSamples: 1, missingSamples: 0, valueShapes: ["object"] },
      { name: "diagnostic", presentSamples: 0, missingSamples: 1, valueShapes: [] },
    ],
    measurements: [
      { measurementName: "correct", scorerName: "correctness", missingSamples: 0, invalidValueSamples: 0, value: correct },
      { measurementName: "safe", scorerName: "policy", subScoreKey: "safe", missingSamples: 0, invalidValueSamples: 0, value: safe },
    ],
    verdict: null,
    evaluatedAt: "2026-08-13T12:00:00.000Z",
    nativeLogSha256: "a".repeat(64),
    nativeLogBytes: 1,
  });
}

describe("multiple Inspect scorer projection", () => {
  test("supports sealed all, any, and nested verdict rules without inventing a scorer reducer", () => {
    const correct = { threshold: { measurement: "correct", op: "eq", value: true } } as const;
    const safe = { threshold: { measurement: "safe", op: "eq", value: true } } as const;
    expect(projectInspectCellVerdict(summary(true, false), manifest({ all: [correct, safe] }))).toBe("fail");
    expect(projectInspectCellVerdict(summary(true, false), manifest({ any: [correct, safe] }))).toBe("pass");
    expect(projectInspectCellVerdict(
      summary(true, false),
      manifest({ all: [correct, { not: safe }] }),
    )).toBe("pass");
    expect(projectInspectCellVerdict(
      summary(true, false),
      manifest({ inconclusiveWhen: { not: safe }, class: "policy-review" }),
    )).toBe("inconclusive");
  });

  test("rejects reordered or incomplete measurements before a verdict can be sealed", () => {
    const rule = {
      all: projections.map((projection) => ({
        threshold: { measurement: projection.measurementName, op: "eq" as const, value: true },
      })),
    };
    const reordered = summary(true, true);
    reordered.measurements.reverse();
    expect(() => projectInspectCellVerdict(reordered, manifest(rule))).toThrow(/sealed projection/u);

    const incomplete = summary(true, true);
    incomplete.measurements[0] = { ...incomplete.measurements[0]!, missingSamples: 1, value: null };
    expect(() => projectInspectCellVerdict(incomplete, manifest(rule))).toThrow(/incomplete/u);

    const scorerReordered = summary(true, true);
    scorerReordered.scorers.reverse();
    expect(() => projectInspectCellVerdict(scorerReordered, manifest(rule))).toThrow(/ordered scorer/u);
  });

  test("accepts only a native-log observation that exactly reproduces the sealed projection", () => {
    const rule = {
      all: projections.map((projection) => ({
        threshold: { measurement: projection.measurementName, op: "eq" as const, value: true },
      })),
    };
    const executionSummary = { ...summary(true, true), verdict: "pass" as const };
    const observation = InspectLogObservationSchema.parse({
      schema: "jinn.network/benchmark-product/inspect-log-observation/1",
      summarySchema: executionSummary.schema,
      terminal: executionSummary.terminal,
      inspectStatus: executionSummary.inspectStatus,
      expectedSamples: executionSummary.expectedSamples,
      observedSamples: executionSummary.observedSamples,
      erroredSamples: executionSummary.erroredSamples,
      invalidated: executionSummary.invalidated,
      scorers: executionSummary.scorers,
      measurements: executionSummary.measurements,
      nativeLogSha256: executionSummary.nativeLogSha256,
      nativeLogBytes: executionSummary.nativeLogBytes,
    });
    expect(verifyInspectLogProjection(executionSummary, observation, manifest(rule))).toEqual({
      verdict: "pass",
      measurements: [
        { name: "correct", value: true },
        { name: "safe", value: true },
      ],
    });

    if (observation.summarySchema !== "jinn.network/benchmark-product/inspect-cell-summary/2") {
      throw new Error("expected multi-scorer observation");
    }
    const altered = InspectLogObservationSchema.parse({
      ...observation,
      measurements: [{ ...observation.measurements[0]!, value: false }, observation.measurements[1]!],
    });
    expect(() => verifyInspectLogProjection(executionSummary, altered, manifest(rule))).toThrow(/differs/u);
  });
});
