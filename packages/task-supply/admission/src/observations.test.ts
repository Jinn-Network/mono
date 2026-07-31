import { describe, expect, it } from "vitest";
import { ObservationSchema, deriveTransitions, stableObservation } from "./observations.js";
import { AdmissionRefusalError } from "./refusals.js";

const observation = (passed: string[], failed: string[]) => ({ passed, failed, passedMatch: true });

function refusalOf(run: () => unknown): { code: string; detail: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof AdmissionRefusalError) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("ObservationSchema", () => {
  it("accepts a well-formed observation", () => {
    expect(ObservationSchema.parse(observation(["a"], ["b"]))).toStrictEqual({
      passed: ["a"], failed: ["b"], passedMatch: true,
    });
  });

  it("rejects an unknown key", () => {
    expect(ObservationSchema.safeParse({ ...observation(["a"], []), extra: 1 }).success).toBe(false);
  });

  it("rejects an identifier repeated within one observation", () => {
    expect(ObservationSchema.safeParse(observation(["a"], ["a"])).success).toBe(false);
    expect(ObservationSchema.safeParse(observation(["a", "a"], [])).success).toBe(false);
  });
});

describe("stableObservation", () => {
  it("returns the single observation when both repeats are canonical-JSON identical", () => {
    const first = observation(["a"], ["b"]);
    const second = { failed: ["b"], passed: ["a"], passedMatch: true };
    expect(stableObservation([first, second], "broken", "tests/test_thing.py"))
      .toStrictEqual(first);
  });

  it("refuses when the repeats differ", () => {
    const refusal = refusalOf(() =>
      stableObservation([observation(["a"], ["b"]), observation(["a", "b"], [])], "fixed", "tests/t.py"));
    expect(refusal.code).toBe("unstable-observations");
    expect(refusal.detail).toContain("fixed observations for tests/t.py");
  });

  it("refuses when a side does not carry exactly two repeats", () => {
    const refusal = refusalOf(() => stableObservation([observation(["a"], [])], "broken", "tests/t.py"));
    expect(refusal.code).toBe("unstable-observations");
    expect(refusal.detail).toContain("exactly 2");
  });
});

describe("deriveTransitions", () => {
  it("derives fail-to-pass and pass-to-pass in code-unit order", () => {
    const before = observation(["keeps", "also"], ["zeta", "alpha"]);
    const after = observation(["keeps", "also", "zeta", "alpha"], []);
    expect(deriveTransitions(before, after)).toStrictEqual({
      failToPass: ["alpha", "zeta"],
      passToPass: ["also", "keeps"],
    });
  });

  it("does not depend on the runner's emission order", () => {
    const before = observation(["b", "a"], ["d", "c"]);
    const after = observation(["a", "b", "c", "d"], []);
    const reversed = deriveTransitions(
      observation(["a", "b"], ["c", "d"]),
      observation(["d", "c", "b", "a"], []),
    );
    expect(deriveTransitions(before, after)).toStrictEqual(reversed);
  });

  it("counts a test that regresses as neither transition", () => {
    expect(deriveTransitions(observation(["a"], []), observation([], ["a"])))
      .toStrictEqual({ failToPass: [], passToPass: [] });
  });

  it("does not count an assertion absent from the empty-side reading as fail-to-pass", () => {
    // Design 7.1: "no patch (empty) -> fail-to-pass tests fail" — an empty side that parsed
    // nothing at all (a collection error, a broken container) is not evidence of
    // discrimination, so absence must never read as failure.
    expect(deriveTransitions(observation([], []), observation(["a", "b"], [])))
      .toStrictEqual({ failToPass: [], passToPass: [] });
    expect(deriveTransitions(
      observation(["keeps"], ["target"]),
      observation(["keeps", "target", "brand_new"], []),
    )).toStrictEqual({ failToPass: ["target"], passToPass: ["keeps"] });
  });
});
