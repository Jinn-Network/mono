import { describe, expect, test } from "vitest";
import { resolveAssurance } from "../../domain/draft.js";
import { deriveInspectEvaluationStrategy } from "./assurance.js";

describe("deriveInspectEvaluationStrategy", () => {
  test.each([
    ["direct-check", "embedded"],
    ["separate-evaluator", "separate-log-verification"],
    ["evaluator-panel", "separate-log-verification"],
    ["strict-agreement", "separate-log-verification"],
  ] as const)("maps %s to %s", (preset, expected) => {
    expect(deriveInspectEvaluationStrategy(resolveAssurance({ preset }))).toBe(expected);
  });

  test("uses embedded only at the exact direct-check primitive boundary", () => {
    for (const overrides of [
      { independence: "gating" as const },
      { minVerdicts: 2 },
      { distinctEvaluator: true },
      { verdictRule: "majority" as const },
    ]) {
      expect(deriveInspectEvaluationStrategy(resolveAssurance({
        preset: "direct-check",
        overrides,
      }))).toBe("separate-log-verification");
    }
    expect(deriveInspectEvaluationStrategy(resolveAssurance({
      preset: "separate-evaluator",
      overrides: {
        independence: "disclosed",
        minVerdicts: 1,
        distinctEvaluator: false,
        verdictRule: "sole",
      },
    }))).toBe("embedded");
  });
});
