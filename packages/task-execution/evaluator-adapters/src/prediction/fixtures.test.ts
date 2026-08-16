// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { PREDICTION_FIXTURES } from "./fixtures.js";

describe("prediction fixtures", () => {
  test("every fixture names its legacy provenance", () => {
    expect(PREDICTION_FIXTURES.length).toBeGreaterThanOrEqual(9);
    for (const fixture of PREDICTION_FIXTURES) {
      expect(fixture.provenance).toMatch(/^operator\/(src|test)\/.+:\d+/u);
    }
  });

  test("all three protocol verdicts are represented", () => {
    const verdicts = new Set(PREDICTION_FIXTURES.map((f) => f.expect.verdict));
    expect(verdicts).toEqual(new Set(["pass", "fail", "inconclusive"]));
  });

  test("scored fixtures carry six-fraction-digit decimal strings, never JSON numbers", () => {
    for (const fixture of PREDICTION_FIXTURES) {
      for (const value of [
        fixture.expect.solverBrier,
        fixture.expect.consensusBrier,
        fixture.expect.brierSpread,
      ]) {
        if (value === undefined) continue;
        expect(typeof value).toBe("string");
        expect(value).toMatch(/^-?\d+\.\d{6}$/u);
      }
    }
  });
});
