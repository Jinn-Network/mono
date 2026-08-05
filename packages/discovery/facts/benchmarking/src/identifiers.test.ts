import { assertRecordKindUri } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import {
  BENCHMARK_RECORD_KIND,
  MATRIX_RECORD_KIND,
  REPORT_RECORD_KIND,
  RUN_RECORD_KIND,
} from "./identifiers.js";

// DUAL-ACCEPT (DR-2026-08-04 transition window): canonical
// `https://spec.jinn.network/records/<segment>/v<major>` and the legacy
// `https://jinn.network/records/<segment>/<major>.<minor>` this constant still
// spells. Reference implementation: packages/discovery/protocol/src/origins.ts.
// Component C2 narrows this to the canonical arm once the re-seal has landed.
const RECORD_KIND_GRAMMAR = /^https:\/\/(?:spec\.)?jinn\.network\/records\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\/(?:v[1-9]\d*|\d+\.\d+)$/;

describe("facts/benchmarking identifiers", () => {
  it("exports four grammar-conformant record-kind URIs", () => {
    for (const kind of [
      BENCHMARK_RECORD_KIND,
      RUN_RECORD_KIND,
      MATRIX_RECORD_KIND,
      REPORT_RECORD_KIND,
    ]) {
      expect(() => assertRecordKindUri(kind)).not.toThrow();
      expect(kind).toMatch(RECORD_KIND_GRAMMAR);
    }
  });

  it("pins the four benchmarking record-kind segments", () => {
    expect(BENCHMARK_RECORD_KIND).toBe("https://jinn.network/records/benchmark/1.0");
    expect(RUN_RECORD_KIND).toBe("https://jinn.network/records/benchmark-run/1.0");
    expect(MATRIX_RECORD_KIND).toBe("https://jinn.network/records/benchmark-matrix/1.0");
    expect(REPORT_RECORD_KIND).toBe("https://jinn.network/records/benchmark-report/1.0");
  });

  // The mirrored grammar must already accept the spelling the re-seal will mint, because
  // C1's wave flips this package's constants and nothing else may need to move with them.
  // No constant here uses the canonical arm yet, so only this asserts it.
  it("the mirrored grammar accepts the canonical re-seal spelling", () => {
    expect("https://spec.jinn.network/records/benchmark/v1").toMatch(RECORD_KIND_GRAMMAR);
    expect("https://spec.jinn.network/records/benchmark/v2").toMatch(RECORD_KIND_GRAMMAR);
    expect("https://jinn.network/records/benchmark/1.0").toMatch(RECORD_KIND_GRAMMAR);
    for (const rejected of [
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
