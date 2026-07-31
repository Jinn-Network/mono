import { describe, expect, test } from "vitest";

import {
  TRAJECTORY_DERIVATION_CONFORMANCE_CASE_COUNT,
  TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS,
} from "./conformance-case-manifest.js";

describe("derivation conformance case manifest", () => {
  test("exports a frozen ordered non-empty case-id list", () => {
    expect(TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS)).toBe(true);
    expect(new Set(TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS).size).toBe(
      TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS.length,
    );
  });

  test("count pin matches manifest length", () => {
    expect(TRAJECTORY_DERIVATION_CONFORMANCE_CASE_COUNT).toBe(
      TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS.length,
    );
  });

  test("mutation: deleting a manifest entry is detectable", () => {
    const shortened = TRAJECTORY_DERIVATION_CONFORMANCE_CASE_IDS.slice(0, -1);
    expect(shortened.length).not.toBe(TRAJECTORY_DERIVATION_CONFORMANCE_CASE_COUNT);
  });
});
