/**
 * The recomputed-checks caveat (issue #3756). `describeRecomputedChecks` sits behind published entry
 * points an untyped caller reaches, so a check name it does not know is the verifier's own refusal,
 * never the word "undefined" in a reader's caveat.
 */

import { describe, expect, test } from "vitest";
import { describeRecomputedChecks, type VerificationOutcome } from "./outcome.js";
import { BenchmarkProductError } from "./profile/errors.js";

function outcomeOf(outcomes: readonly { check: unknown; state: string }[]): VerificationOutcome {
  return { outcomes, passed: outcomes.length, notFetched: 0, total: outcomes.length } as unknown as VerificationOutcome;
}

const V4_CHECKS = [
  "manifest", "evidence-closure", "trust", "matrix-rederivation",
  "report-verification", "claim-consistency",
];

describe("describeRecomputedChecks", () => {
  test.each([
    ["an unknown name", "bogus"],
    ["an inherited key", "constructor"],
    ["another inherited key", "toString"],
    ["the prototype key", "__proto__"],
    ["a symbol", Symbol("x")],
  ])("refuses %s with record-integrity", (_label, check) => {
    let thrown: unknown;
    try {
      describeRecomputedChecks(outcomeOf([{ check, state: "passed" }]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BenchmarkProductError);
    expect((thrown as BenchmarkProductError).code).toBe("record-integrity");
  });

  test("renders a real six-check closure unchanged", () => {
    expect(describeRecomputedChecks(outcomeOf(V4_CHECKS.map((check) => ({ check, state: "passed" })))))
      .toBe("the bundle's integrity, evidence closure, signing trust, calculations, the report, and claim consistency");
  });

  test("still leaves a deferred check out", () => {
    expect(describeRecomputedChecks(outcomeOf([
      { check: "manifest", state: "passed" },
      { check: "artifact-integrity", state: "not fetched" },
    ]))).toBe("the bundle's integrity");
  });
});
