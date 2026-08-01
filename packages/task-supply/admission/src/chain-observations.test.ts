import { describe, expect, it } from "vitest";
import {
  ChainObservationSchema,
  deriveConjunction,
  stableChainObservation,
} from "./chain-observations.js";
import { ChainAdmissionRefusalError } from "./chain-refusals.js";

const observation = (
  successPredicates: Array<{ id: string; satisfied: boolean }>,
  safetyConstraints: Array<{ id: string; satisfied: boolean }> = [],
  conjunction?: boolean,
) => ({
  successPredicates,
  safetyConstraints,
  conjunction: conjunction ?? successPredicates.every((outcome) => outcome.satisfied),
  outOfSliceReads: 0,
  envelopeExceeded: false,
  appliedScriptDigest: null,
});

function refusalOf(run: () => unknown): { code: string; detail: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof ChainAdmissionRefusalError) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("ChainObservationSchema", () => {
  it("accepts a well-formed observation", () => {
    expect(ChainObservationSchema.parse(observation([
      { id: "borrow-event", satisfied: true },
    ]))).toStrictEqual(observation([{ id: "borrow-event", satisfied: true }]));
  });

  it("rejects an unknown key", () => {
    expect(ChainObservationSchema.safeParse({ ...observation([{ id: "a", satisfied: true }]), extra: 1 }).success)
      .toBe(false);
  });

  it("rejects an empty successPredicates list", () => {
    expect(ChainObservationSchema.safeParse({
      successPredicates: [],
      safetyConstraints: [],
      conjunction: false,
      outOfSliceReads: 0,
      envelopeExceeded: false,
      appliedScriptDigest: null,
    }).success).toBe(false);
  });

  it("rejects duplicate predicate ids within successPredicates", () => {
    expect(ChainObservationSchema.safeParse(observation([
      { id: "a", satisfied: true },
      { id: "a", satisfied: false },
    ])).success).toBe(false);
  });

  it("rejects duplicate predicate ids within safetyConstraints", () => {
    expect(ChainObservationSchema.safeParse(observation(
      [{ id: "a", satisfied: true }],
      [{ id: "s", satisfied: true }, { id: "s", satisfied: false }],
    )).success).toBe(false);
  });
});

describe("deriveConjunction", () => {
  it("is the AND over successPredicates only", () => {
    const obs = observation(
      [{ id: "a", satisfied: true }, { id: "b", satisfied: false }],
      [{ id: "s", satisfied: false }],
      false,
    );
    expect(deriveConjunction(obs)).toBe(false);
  });

  it("ignores safetyConstraints when deriving conjunction", () => {
    const obs = observation(
      [{ id: "a", satisfied: true }],
      [{ id: "s", satisfied: false }],
      true,
    );
    expect(deriveConjunction(obs)).toBe(true);
  });
});

describe("stableChainObservation", () => {
  it("returns the single observation when both repeats are canonical-JSON identical", () => {
    const first = observation([{ id: "a", satisfied: true }, { id: "b", satisfied: false }], [], false);
    const second = {
      appliedScriptDigest: null,
      conjunction: false,
      envelopeExceeded: false,
      outOfSliceReads: 0,
      safetyConstraints: [],
      successPredicates: [{ id: "a", satisfied: true }, { id: "b", satisfied: false }],
    };
    expect(stableChainObservation([first, second], "do-nothing")).toStrictEqual(first);
  });

  it("refuses when the repeats differ by any byte", () => {
    const refusal = refusalOf(() => stableChainObservation([
      observation([{ id: "a", satisfied: true }], [], true),
      observation([{ id: "a", satisfied: false }], [], false),
    ], "reference"));
    expect(refusal.code).toBe("unstable-observations");
    expect(refusal.detail).toContain("reference observations are not identical");
  });

  it("refuses when a side does not carry exactly two repeats", () => {
    const refusal = refusalOf(() => stableChainObservation([
      observation([{ id: "a", satisfied: true }]),
    ], "do-nothing"));
    expect(refusal.code).toBe("unstable-observations");
    expect(refusal.detail).toContain("exactly 2");
  });

  it("refuses when the host-reported conjunction disagrees with its own vector", () => {
    const refusal = refusalOf(() => stableChainObservation([
      observation([{ id: "a", satisfied: true }], [], false),
      observation([{ id: "a", satisfied: true }], [], false),
    ], "reference"));
    expect(refusal.code).toBe("inconsistent-observation");
    expect(refusal.detail).toContain("reported conjunction false");
  });
});
