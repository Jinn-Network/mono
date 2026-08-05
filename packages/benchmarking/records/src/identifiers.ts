// Pinned identifiers (design defers exact strings to "implementation"; pinned by the
// benchmarking plan's Pinned-identifiers table, flagged to the program gate as Finding F1).
// Downstream benchmarking code imports these constants; it never hardcodes a copy.

// Addendum 2026-07-28-c (operator ruling at the extension gate): the `protocol` field of all
// four benchmarking record kinds is the https URL form, consistent with the TEP / profiles /
// discovery convention. The design's literal bare token `jinn.benchmarking/1.0` is superseded
// on this point.
export const BENCHMARKING_PROTOCOL = "https://spec.jinn.network/protocols/benchmarking/v1";

export const BENCHMARK_MEDIA_TYPE = "application/vnd.jinn.benchmarking.benchmark.v1+json";
export const RUN_MEDIA_TYPE = "application/vnd.jinn.benchmarking.run.v1+json";
export const MATRIX_MEDIA_TYPE = "application/vnd.jinn.benchmarking.matrix.v1+json";
export const REPORT_MEDIA_TYPE = "application/vnd.jinn.benchmarking.report.v1+json";

// Record-kind URIs (plan §Pinned-identifiers, Finding F1 sub-flag): pre-aligned at fix time to
// the record-discovery record-kind grammar `${RECORDS_ROOT}/<segment>/<major>.<minor>`
// (`RECORDS_ROOT = "https://spec.jinn.network/records"`), verified against
// `2026-07-28-record-discovery.md` §Pinned-identifiers (its `RECORD_KINDS` map +
// `SOURCE_NAME_GRAMMAR` + `assertRecordKindUri`). `records` cannot import discovery's own
// `assertRecordKindUri` (discovery is absent on this branch and `records` is protocol-only,
// Finding F3) — `identifiers.test.ts` asserts a local mirror-regex instead; the authoritative
// check against the built discovery grammar is re-applied in the facts leaf (M6) at the Phase 3
// merge.
export const BENCHMARK_RECORD_KIND = "https://spec.jinn.network/records/benchmark/v1";
export const RUN_RECORD_KIND = "https://spec.jinn.network/records/benchmark-run/v1";
export const MATRIX_RECORD_KIND = "https://spec.jinn.network/records/benchmark-matrix/v1";
export const REPORT_RECORD_KIND = "https://spec.jinn.network/records/benchmark-report/v1";

export const ASSEMBLY_PROCEDURE = "jinn.benchmarking.assembly";
export const ASSEMBLY_PROCEDURE_VERSION = "1.0";

/** §9.2 named-method registry URIs (working titles under `jinn.benchmarking.method/`). */
export const BENCHMARKING_METHOD_IDS = {
  wilson: "jinn.benchmarking.method/wilson",
  avgAtK: "jinn.benchmarking.method/avg-at-k",
  passAtK: "jinn.benchmarking.method/pass-at-k",
  pairedMcnemar: "jinn.benchmarking.method/paired-mcnemar",
  noninferiorityIut: "jinn.benchmarking.method/noninferiority-iut",
  cleanSubset: "jinn.benchmarking.method/clean-subset",
  bradleyTerry: "jinn.benchmarking.method/bradley-terry",
} as const;

/** The v1 registry version every §9.2 method is published at ("@1"). */
export const BENCHMARKING_METHOD_VERSION = "1";

/** DSSE trust binding scope for the Report record (§9.1/§12.1). */
export const BENCHMARKING_REPORTS_SCOPE = "jinn:benchmarking-reports";

/** Trust-policy purposes (data, not a code gate) — §6.3/§12.1. */
export const TRUST_POLICY_PURPOSE_BENCHMARK_PUBLISHER = "benchmark-publisher";
export const TRUST_POLICY_PURPOSE_RUN_OWNER = "run-owner";
