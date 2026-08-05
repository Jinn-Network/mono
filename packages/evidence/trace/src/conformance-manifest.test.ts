import { describe, expect, test } from "vitest";

import {
  TRACE_DERIVATION_CONFORMANCE_CASE_COUNT,
  TRACE_DERIVATION_CONFORMANCE_CASE_IDS,
} from "./conformance-case-manifest.js";

describe("derivation conformance case manifest", () => {
  test("exports a frozen ordered non-empty case-id list", () => {
    expect(TRACE_DERIVATION_CONFORMANCE_CASE_IDS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(TRACE_DERIVATION_CONFORMANCE_CASE_IDS)).toBe(true);
    expect(new Set(TRACE_DERIVATION_CONFORMANCE_CASE_IDS).size).toBe(
      TRACE_DERIVATION_CONFORMANCE_CASE_IDS.length,
    );
  });

  test("count pin matches manifest length", () => {
    expect(TRACE_DERIVATION_CONFORMANCE_CASE_COUNT).toBe(
      TRACE_DERIVATION_CONFORMANCE_CASE_IDS.length,
    );
  });

  test("mutation: deleting a manifest entry is detectable", () => {
    const shortened = TRACE_DERIVATION_CONFORMANCE_CASE_IDS.slice(0, -1);
    expect(shortened.length).not.toBe(TRACE_DERIVATION_CONFORMANCE_CASE_COUNT);
  });
});
