import { assertRecordKindUri } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import {
  BENCHMARK_RECORD_KIND,
  MATRIX_RECORD_KIND,
  REPORT_RECORD_KIND,
  RUN_RECORD_KIND,
} from "./identifiers.js";

describe("facts/benchmarking identifiers", () => {
  it("exports four grammar-conformant record-kind URIs", () => {
    for (const kind of [
      BENCHMARK_RECORD_KIND,
      RUN_RECORD_KIND,
      MATRIX_RECORD_KIND,
      REPORT_RECORD_KIND,
    ]) {
      expect(() => assertRecordKindUri(kind)).not.toThrow();
      expect(kind).toMatch(/^https:\/\/jinn\.network\/records\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\/\d+\.\d+$/);
    }
  });

  it("pins the four benchmarking record-kind segments", () => {
    expect(BENCHMARK_RECORD_KIND).toBe("https://jinn.network/records/benchmark/1.0");
    expect(RUN_RECORD_KIND).toBe("https://jinn.network/records/benchmark-run/1.0");
    expect(MATRIX_RECORD_KIND).toBe("https://jinn.network/records/benchmark-matrix/1.0");
    expect(REPORT_RECORD_KIND).toBe("https://jinn.network/records/benchmark-report/1.0");
  });
});
