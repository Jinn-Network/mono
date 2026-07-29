import { BENCHMARKING_REPORTS_SCOPE } from "@jinn-network/benchmarking-records";
import { ScopeSchema } from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";

/**
 * Cross-tree parse-assertion fixture (plan Global Constraints, Pinned-identifiers table
 * flag F1/F2): `records` (tier 2, protocol-only) can only assert `BENCHMARKING_REPORTS_SCOPE`
 * against a local mirror regex; `aggregate` is the first benchmarking package to depend on
 * `trust-core`, so this is where the value is checked against the REAL, built
 * `ScopeSchema` (the namespaced-scope grammar, `namespace:custom`).
 */
describe("BENCHMARKING_REPORTS_SCOPE parses under trust-core's ScopeVocabulary", () => {
  test("parses without throwing", () => {
    expect(() => ScopeSchema.parse(BENCHMARKING_REPORTS_SCOPE)).not.toThrow();
  });

  test("is exactly the pinned value", () => {
    expect(BENCHMARKING_REPORTS_SCOPE).toBe("jinn:benchmarking-reports");
  });
});
