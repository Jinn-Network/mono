import { assertRecordKindUri } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import {
  BENCHMARK_ACCOUNTING_RECORD_KIND,
  BENCHMARK_RECORD_KIND,
  MATRIX_RECORD_KIND,
  REPORT_RECORD_KIND,
  REPORT_V2_RECORD_KIND,
  RUN_RECORD_KIND,
} from "./identifiers.js";

// Mirror of discovery's record-kind URI grammar (DR-2026-08-04, transition window closed):
// one origin, `https://spec.jinn.network`, and one version form, `v<major>`. Mirrored rather
// than imported because this package declares no Jinn dependency. Reference implementation:
// packages/discovery/protocol/src/origins.ts.
const RECORD_KIND_GRAMMAR = /^https:\/\/spec\.jinn\.network\/records\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\/v[1-9]\d*$/;

describe("facts/benchmarking identifiers", () => {
  it("exports six grammar-conformant record-kind URIs", () => {
    for (const kind of [
      BENCHMARK_RECORD_KIND,
      RUN_RECORD_KIND,
      MATRIX_RECORD_KIND,
      REPORT_RECORD_KIND,
      REPORT_V2_RECORD_KIND,
      BENCHMARK_ACCOUNTING_RECORD_KIND,
    ]) {
      expect(() => assertRecordKindUri(kind)).not.toThrow();
      expect(kind).toMatch(RECORD_KIND_GRAMMAR);
    }
  });

  it("pins the benchmarking record-kind segments", () => {
    expect(BENCHMARK_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark/v1");
    expect(RUN_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark-run/v1");
    expect(MATRIX_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark-matrix/v1");
    expect(REPORT_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark-report/v1");
    expect(REPORT_V2_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark-report/v2");
    expect(BENCHMARK_ACCOUNTING_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark-accounting/v1");
  });

  // The regression test for the C2 narrowing. While the mirror dual-accepted, a pre-re-seal
  // spelling matched as a valid record kind; the two literals at the head of the rejected
  // list below are exactly the spellings that must no longer match (DR-2026-08-04).
  it("the mirrored grammar accepts only the canonical spelling", () => {
    expect("https://spec.jinn.network/records/benchmark/v1").toMatch(RECORD_KIND_GRAMMAR);
    expect("https://spec.jinn.network/records/benchmark/v2").toMatch(RECORD_KIND_GRAMMAR);
    for (const rejected of [
      "https://jinn.network/records/benchmark/1.0",
      "https://spec.jinn.network/records/benchmark/1.0",
      "https://spec.jinn.network/records/benchmark/v0",
      "https://spec.jinn.network/records/benchmark/1",
      "https://spec.jinn.network/records/benchmark/v1/facts/v1",
      "https://evil.jinn.network/records/benchmark/v1",
      "https://jinn.network.evil.example/records/benchmark/v1",
    ]) {
      expect(rejected).not.toMatch(RECORD_KIND_GRAMMAR);
    }
  });
});
