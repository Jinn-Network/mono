import { describe, expect, test } from "vitest";
import {
  ASSEMBLY_PROCEDURE,
  ASSEMBLY_PROCEDURE_VERSION,
  BENCHMARK_MEDIA_TYPE,
  BENCHMARK_RECORD_KIND,
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  BENCHMARKING_PROTOCOL,
  BENCHMARKING_REPORTS_SCOPE,
  MATRIX_MEDIA_TYPE,
  MATRIX_RECORD_KIND,
  REPORT_MEDIA_TYPE,
  REPORT_RECORD_KIND,
  RUN_MEDIA_TYPE,
  RUN_RECORD_KIND,
  TRUST_POLICY_PURPOSE_BENCHMARK_PUBLISHER,
  TRUST_POLICY_PURPOSE_RUN_OWNER,
} from "./identifiers.js";

const MEDIA_TYPES = [BENCHMARK_MEDIA_TYPE, RUN_MEDIA_TYPE, MATRIX_MEDIA_TYPE, REPORT_MEDIA_TYPE];
const RECORD_KINDS = [BENCHMARK_RECORD_KIND, RUN_RECORD_KIND, MATRIX_RECORD_KIND, REPORT_RECORD_KIND];

// Local mirror of the record-discovery record-kind grammar
// `${RECORDS_ROOT}/<segment>/<major>.<minor>` (RECORDS_ROOT = "https://jinn.network/records",
// segment matches SOURCE_NAME_GRAMMAR). `records` is protocol-only (Finding F3) and cannot
// import discovery's own `assertRecordKindUri`; the authoritative check is re-applied in the
// facts leaf (M6) at the Phase 3 merge.
// Mirror of discovery's record-kind URI grammar (DR-2026-08-04, transition window closed):
// one origin, `https://spec.jinn.network`, and one version form, `v<major>`. Mirrored rather
// than imported because this package declares no Jinn dependency. Reference implementation:
// packages/discovery/protocol/src/origins.ts.
const RECORD_KIND_GRAMMAR = /^https:\/\/spec\.jinn\.network\/records\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?\/v[1-9]\d*$/;

describe("pinned identifiers", () => {
  test("protocol is the https URL form (Addendum 2026-07-28-c)", () => {
    expect(BENCHMARKING_PROTOCOL).toBe("https://spec.jinn.network/protocols/benchmarking/v1");
  });

  test("every media type matches the vnd.jinn.benchmarking.*.v1+json shape", () => {
    for (const mediaType of MEDIA_TYPES) {
      expect(mediaType).toMatch(/^application\/vnd\.jinn\.benchmarking\.[a-z]+\.v1\+json$/);
    }
  });

  test("every record-kind URI is grammar-conformant to the record-discovery record-kind shape", () => {
    for (const recordKind of RECORD_KINDS) {
      expect(recordKind).toMatch(RECORD_KIND_GRAMMAR);
    }
  });

  test("record-kind URIs are pairwise distinct and namespaced under benchmark/benchmark-*", () => {
    expect(new Set(RECORD_KINDS).size).toBe(RECORD_KINDS.length);
    expect(BENCHMARK_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark/v1");
    expect(RUN_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark-run/v1");
    expect(MATRIX_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark-matrix/v1");
    expect(REPORT_RECORD_KIND).toBe("https://spec.jinn.network/records/benchmark-report/v1");
  });

  test("assembly procedure id + version are pinned", () => {
    expect(ASSEMBLY_PROCEDURE).toBe("jinn.benchmarking.assembly");
    expect(ASSEMBLY_PROCEDURE_VERSION).toBe("1.0");
  });

  test("the seven §9.2 method URIs are pinned under jinn.benchmarking.method/ at version 1", () => {
    expect(Object.values(BENCHMARKING_METHOD_IDS).sort()).toEqual([
      "jinn.benchmarking.method/avg-at-k",
      "jinn.benchmarking.method/bradley-terry",
      "jinn.benchmarking.method/clean-subset",
      "jinn.benchmarking.method/noninferiority-iut",
      "jinn.benchmarking.method/paired-mcnemar",
      "jinn.benchmarking.method/pass-at-k",
      "jinn.benchmarking.method/wilson",
    ]);
    expect(BENCHMARKING_METHOD_VERSION).toBe("1");
  });

  test("the benchmarking-reports trust scope conforms to the namespaced-scope grammar (namespace:custom)", () => {
    expect(BENCHMARKING_REPORTS_SCOPE).toBe("jinn:benchmarking-reports");
    expect(BENCHMARKING_REPORTS_SCOPE).toMatch(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/);
  });

  test("trust-policy purposes are pinned strings", () => {
    expect(TRUST_POLICY_PURPOSE_BENCHMARK_PUBLISHER).toBe("benchmark-publisher");
    expect(TRUST_POLICY_PURPOSE_RUN_OWNER).toBe("run-owner");
  });

  // The regression test for the C2 narrowing. While the mirror dual-accepted, a pre-re-seal
  // spelling matched as a valid record kind; the two literals at the head of the rejected
  // list below are exactly the spellings that must no longer match (DR-2026-08-04).
  test("the mirrored grammar accepts only the canonical spelling", () => {
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
