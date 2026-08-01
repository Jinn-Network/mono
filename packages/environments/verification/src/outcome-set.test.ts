// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  canonicalOutcomeSetBytes,
  outcomeSetDigest,
  outcomeSetsEqual,
  tallyOutcomeSet,
  type OutcomeSet,
} from "./outcome-set.js";
import { EnvironmentVerificationError } from "./errors.js";

const OUTCOMES: OutcomeSet = {
  "tests/test_b.py::test_two": "fail",
  "tests/test_a.py::test_one": "pass",
  "tests/test_c.py::test_three": "skip",
};

describe("outcome sets", () => {
  it("canonicalizes independently of key insertion order", () => {
    const permuted: OutcomeSet = {
      "tests/test_c.py::test_three": "skip",
      "tests/test_a.py::test_one": "pass",
      "tests/test_b.py::test_two": "fail",
    };
    expect(canonicalOutcomeSetBytes(permuted)).toEqual(canonicalOutcomeSetBytes(OUTCOMES));
    expect(outcomeSetDigest(permuted)).toBe(outcomeSetDigest(OUTCOMES));
  });

  it("digests to the sha256:-prefixed form of its canonical bytes", () => {
    expect(outcomeSetDigest(OUTCOMES)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("compares by set equality over test-id -> status, never by timing", () => {
    expect(outcomeSetsEqual(OUTCOMES, { ...OUTCOMES })).toBe(true);
    expect(
      outcomeSetsEqual(OUTCOMES, { ...OUTCOMES, "tests/test_b.py::test_two": "pass" }),
    ).toBe(false);
    expect(outcomeSetsEqual(OUTCOMES, { ...OUTCOMES, "tests/test_d.py::test_four": "pass" }))
      .toBe(false);
  });

  it("tallies an expected-fail baseline without rejecting it", () => {
    expect(tallyOutcomeSet(OUTCOMES)).toEqual({ passing: 1, failing: 1, skipped: 1 });
  });

  it("refuses statuses outside pass|fail|skip and empty test ids", () => {
    expect(() => outcomeSetDigest({ "t": "errored" } as unknown as OutcomeSet))
      .toThrow(EnvironmentVerificationError);
    expect(() => outcomeSetDigest({ "": "pass" })).toThrow(EnvironmentVerificationError);
  });
});
