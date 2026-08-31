// SPDX-License-Identifier: Apache-2.0

export const BENCHMARKING_PROTOCOL_V2 =
  "https://spec.jinn.network/protocols/benchmarking/v2" as const;

export const EXECUTION_BATCH_INTENT_RECORD_KIND =
  "https://spec.jinn.network/records/execution-batch-intent/v1" as const;
export const EXECUTION_BATCH_CAPTURE_RECORD_KIND =
  "https://spec.jinn.network/records/execution-batch-capture/v1" as const;
export const BENCHMARK_V2_RECORD_KIND =
  "https://spec.jinn.network/records/benchmark/v2" as const;
export const BENCHMARK_ANALYSIS_MANIFEST_RECORD_KIND =
  "https://spec.jinn.network/records/benchmark-analysis-manifest/v1" as const;
export const EVIDENCE_COHORT_RECORD_KIND =
  "https://spec.jinn.network/records/benchmark-evidence-cohort/v1" as const;
export const MATRIX_V2_RECORD_KIND =
  "https://spec.jinn.network/records/benchmark-matrix/v2" as const;
export const REPORT_V3_RECORD_KIND =
  "https://spec.jinn.network/records/benchmark-report/v3" as const;
export const EXECUTION_COMMISSIONING_LINK_RECORD_KIND =
  "https://spec.jinn.network/records/execution-commissioning-link/v1" as const;
export const HUMAN_LABEL_RESOLUTION_RECORD_KIND =
  "https://spec.jinn.network/records/human-label-resolution/v1" as const;

export const EXECUTION_BATCH_INTENT_MEDIA_TYPE =
  "application/vnd.jinn.benchmarking.execution-batch-intent.v1+json" as const;
export const EXECUTION_BATCH_CAPTURE_MEDIA_TYPE =
  "application/vnd.jinn.benchmarking.execution-batch-capture.v1+json" as const;
export const BENCHMARK_V2_MEDIA_TYPE =
  "application/vnd.jinn.benchmarking.benchmark.v2+json" as const;
export const BENCHMARK_ANALYSIS_MANIFEST_MEDIA_TYPE =
  "application/vnd.jinn.benchmarking.analysis-manifest.v1+json" as const;
export const EVIDENCE_COHORT_MEDIA_TYPE =
  "application/vnd.jinn.benchmarking.evidence-cohort.v1+json" as const;
export const MATRIX_V2_MEDIA_TYPE =
  "application/vnd.jinn.benchmarking.matrix.v2+json" as const;
export const REPORT_V2_MEDIA_TYPE =
  "application/vnd.jinn.benchmarking.report.v2+json" as const;
export const EXECUTION_COMMISSIONING_LINK_MEDIA_TYPE =
  "application/vnd.jinn.benchmarking.execution-commissioning-link.v1+json" as const;
export const HUMAN_LABEL_RESOLUTION_MEDIA_TYPE =
  "application/vnd.jinn.benchmarking.human-label-resolution.v1+json" as const;

export const MATRIX_V2_ASSEMBLY_PROCEDURE =
  "jinn.benchmarking.assembly" as const;
export const MATRIX_V2_ASSEMBLY_VERSION = "3.0" as const;

export const CLAIM_PACKAGE_V3_PROFILE =
  "https://spec.jinn.network/profiles/claim-package/3" as const;
/**
 * The full-evidence profile of `benchmark-product-public-bundle/5`: every artifact body the
 * evidence graph references is carried in the bundle.
 */
export const BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE =
  "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5" as const;
/**
 * The metadata-first profile of the same format (issue #2986): identical grammar, identical member
 * naming, and byte-identical retained members, minus the evidence artifact bodies. The declared
 * signer public keys stay -- they are trust material the signature check reads, not evidence. The
 * omitted bodies remain named by exact digest in `claim-package/3`'s `records.artifacts`, which is
 * how the two profiles cross-reference.
 */
export const BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_METADATA_FIRST_PROFILE =
  "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first" as const;
