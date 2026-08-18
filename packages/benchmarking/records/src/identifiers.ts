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
/** Report v2 is an exact DSSE envelope around the unchanged Report v1 payload. */
export const SIGNED_REPORT_MEDIA_TYPE = "application/vnd.dsse.envelope.v1+json";
export const BENCHMARK_ACCOUNTING_MEDIA_TYPE = "application/vnd.jinn.benchmarking.accounting.v1+json";
export const BENCHMARK_OBSERVATION_ARCHIVE_MEDIA_TYPE = "application/vnd.jinn.benchmarking.observation-archive.v1+json";

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
export const REPORT_V2_RECORD_KIND = "https://spec.jinn.network/records/benchmark-report/v2";
export const BENCHMARK_ACCOUNTING_RECORD_KIND = "https://spec.jinn.network/records/benchmark-accounting/v1";
/** Local protocol-layer mirror; importing Discovery here would invert the frozen dependency. */
export const TRUST_AUTHORIZATION_RECORD_KIND = "https://spec.jinn.network/records/authorization/v1";

export const BENCHMARK_OBSERVATION_ARCHIVE_PROFILE =
  "https://spec.jinn.network/profiles/benchmark-observation-archive/v1";
export const BENCHMARK_PUBLICATION_EXTENSION =
  "https://spec.jinn.network/extensions/benchmark-publication/v1";
/**
 * Declared anchoring intent, sealed into the Run record (anchor-evidence design §7.3). The value
 * lists intended anchor-provider profiles and NEVER endpoints: an endpoint is machine-local
 * configuration, and sealing one would make the record depend on where it was produced.
 */
export const ANCHOR_INTENT_EXTENSION =
  "https://spec.jinn.network/extensions/anchor-intent/v1";

export const ASSEMBLY_PROCEDURE = "jinn.benchmarking.assembly";
export const ASSEMBLY_PROCEDURE_VERSION = "1.0";
export const MATRIX_ASSEMBLY_PROCEDURE = ASSEMBLY_PROCEDURE;
export const MATRIX_ASSEMBLY_PROCEDURE_VERSION = "2.0";
export const BENCHMARK_ACCOUNTING_PROCEDURE = "jinn.benchmarking.accounting";
export const BENCHMARK_ACCOUNTING_PROCEDURE_VERSION = "1.0";

/** §9.2 named-method registry URIs (working titles under `jinn.benchmarking.method/`). */
export const BENCHMARKING_METHOD_IDS = {
  wilson: "jinn.benchmarking.method/wilson",
  avgAtK: "jinn.benchmarking.method/avg-at-k",
  passAtK: "jinn.benchmarking.method/pass-at-k",
  pairedMcnemar: "jinn.benchmarking.method/paired-mcnemar",
  provenanceClusterSign: "jinn.benchmarking.method/provenance-cluster-sign",
  noninferiorityIut: "jinn.benchmarking.method/noninferiority-iut",
  pairedDelta: "jinn.benchmarking.method/paired-delta",
  cleanSubset: "jinn.benchmarking.method/clean-subset",
  binaryInstrument: "jinn.benchmarking.method/binary-instrument",
  bradleyTerry: "jinn.benchmarking.method/bradley-terry",
} as const;

/** The v1 registry version every §9.2 method is published at ("@1"). */
export const BENCHMARKING_METHOD_VERSION = "1";

/** DSSE trust binding scope for the Report record (§9.1/§12.1). */
export const BENCHMARKING_REPORTS_SCOPE = "jinn:benchmarking-reports";

/** Trust-policy purposes (data, not a code gate) — §6.3/§12.1. */
export const TRUST_POLICY_PURPOSE_BENCHMARK_PUBLISHER = "benchmark-publisher";
export const TRUST_POLICY_PURPOSE_RUN_OWNER = "run-owner";
