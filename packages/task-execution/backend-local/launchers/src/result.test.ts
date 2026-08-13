import { describe, expect, test } from "vitest";
import type { LaunchPlan } from "./contract.js";
import { interpretResult } from "./result.js";

describe("interpretResult typed blame", () => {
  test("preserves an exact launcher-provided infrastructure category", () => {
    const plan = {
      argv: ["grader"],
      env: {},
      cwd: "/work",
      validExitCodes: [0],
      blameExitCodes: [{
        match: { exitCode: 71 },
        blame: "infrastructure",
        reasonCode: "evaluation-provider-unavailable",
        category: "dependency-unavailable",
      }],
      resultContract: { envelopeFormat: "test" },
      interruptionBehavior: "repeatable",
    } satisfies LaunchPlan;
    expect(interpretResult(plan, { exitCode: 71 })).toMatchObject({
      state: "failed",
      blame: "infrastructure",
      reasonCode: "evaluation-provider-unavailable",
      category: "dependency-unavailable",
    });
  });

  test("untyped rules preserve the legacy result shape", () => {
    const plan = {
      argv: ["grader"],
      env: {},
      cwd: "/work",
      validExitCodes: [0],
      blameExitCodes: [{ match: { exitCode: 70 }, blame: "infrastructure", reasonCode: "operational" }],
      resultContract: { envelopeFormat: "test" },
      interruptionBehavior: "repeatable",
    } satisfies LaunchPlan;
    expect(interpretResult(plan, { exitCode: 70 })).toEqual({
      state: "failed",
      blame: "infrastructure",
      reasonCode: "operational",
    });
  });
});
