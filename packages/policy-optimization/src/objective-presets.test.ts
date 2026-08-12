import { BENCHMARKING_METHOD_IDS } from "@jinn-network/benchmarking-records";
import { prefixedDigest } from "@jinn-network/policy-identity";
import { describe, expect, test } from "vitest";
import { compileObjectivePreset } from "./objective-presets.js";

describe("objective presets", () => {
  test("more-tasks-succeed@1 compiles exclusively to the three registry methods", () => {
    const objective = compileObjectivePreset("more-tasks-succeed@1", {
      baselineArm: "current", candidateArm: "challenger",
    });
    expect(objective.methods.map((method) => method.id)).toEqual([
      BENCHMARKING_METHOD_IDS.avgAtK,
      BENCHMARKING_METHOD_IDS.pairedMcnemar,
      BENCHMARKING_METHOD_IDS.provenanceClusterSign,
    ]);
    expect(objective.methods.every((method) => method.version === "1")).toBe(true);
  });

  test("same-success-lower-cost@1 freezes sole/10000 and a split-derived seed", () => {
    const bytes = new TextEncoder().encode("sealed split bytes");
    const digest = prefixedDigest(bytes);
    const first = compileObjectivePreset("same-success-lower-cost@1", {
      baselineArm: "current", candidateArm: "challenger", splitManifestBytes: bytes, splitManifestDigest: digest,
    });
    const second = compileObjectivePreset("same-success-lower-cost@1", {
      baselineArm: "current", candidateArm: "challenger", splitManifestBytes: bytes, splitManifestDigest: digest,
    });
    expect(first).toEqual(second);
    expect(first.methods).toEqual([expect.objectContaining({
      id: BENCHMARKING_METHOD_IDS.noninferiorityIut,
      parameters: expect.objectContaining({ verdictRule: "sole", resamples: 10_000 }),
    })]);
    expect(first.methods[0]!.parameters["seed"]).toEqual(expect.any(Number));
  });
});
