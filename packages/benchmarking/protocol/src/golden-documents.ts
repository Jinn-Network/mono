// SPDX-License-Identifier: Apache-2.0

/**
 * The golden tier-2 record chain, pinned byte-for-byte under `fixtures/` (issue #3341).
 *
 * These documents are the exact-byte fixture source for every record kind this package seals.
 * They are deliberately *not* shared with `records.test.ts`: that suite varies its documents to
 * exercise schema refinements and must stay free to evolve, while a published fixture is never
 * edited -- it is superseded by a new fixture plus a dated erratum
 * (`.github/scripts/fixture-immutability.mjs`). Freezing the two together would freeze the wrong
 * thing.
 *
 * Every value here is a literal. Nothing reads the clock, the filesystem, or an RNG, so
 * `buildGoldenDocuments()` returns the same bytes on every machine and every run.
 */

import {
  BENCHMARKING_PROTOCOL_V2,
  BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE,
  CLAIM_PACKAGE_V3_PROFILE,
  EXECUTION_BATCH_CAPTURE_RECORD_KIND,
} from "./identifiers.js";
import { sealBenchmarkDefinitionV2 } from "./benchmark.js";
import { sealBenchmarkAnalysisManifest } from "./manifest.js";
import { sealEvidenceCohort } from "./cohort.js";
import { sealMatrixV2 } from "./matrix.js";
import { sealEvidenceNativeReportV2 } from "./report.js";
import { sealHumanLabelResolutionPayload } from "./human-label-resolution.js";
import { sealExecutionBatchCapture, sealExecutionBatchIntent } from "./batch.js";
import { sealExecutionCommissioningLink } from "./commissioning.js";
import {
  sealEvidenceNativeBundleManifestV5,
  sealEvidenceNativeClaimPackageV3,
} from "./portable.js";
import type { SealedRecord } from "./sealing.js";
import { evidenceReferenceKey } from "./common.js";
import type {
  DigestBearingResourceDescriptor,
  EvidenceRecordReference,
  TypedRecordReference,
} from "./common.js";

/** One fixture directory per tier-2 record kind (amendment §2). */
export const GOLDEN_RECORD_KINDS = [
  "execution-batch-intent",
  "execution-batch-capture",
  "benchmark-v2",
  "analysis-manifest",
  "evidence-cohort",
  "matrix-v2",
  "report-v2",
  "human-label-resolution",
  "execution-commissioning-link",
  "claim-package-v3",
  "bundle-manifest-v5",
] as const;

export type GoldenRecordKind = (typeof GOLDEN_RECORD_KINDS)[number];

function hex(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function descriptor(index: number, name: string): DigestBearingResourceDescriptor {
  return { name, digest: { sha256: hex(index) } };
}

function typed(index: number, recordKind: string, name: string): TypedRecordReference {
  return { recordKind, record: descriptor(index, name) };
}

function evidence(
  index: number,
  family: EvidenceRecordReference["family"],
  name: string,
): EvidenceRecordReference {
  return { family, record: descriptor(index, name) };
}

function of(sealed: SealedRecord, name: string): DigestBearingResourceDescriptor {
  return { name, digest: { sha256: sealed.digest.slice(7) } };
}

/**
 * Seals the golden chain. Later records reference earlier ones by digest, so editing any document
 * moves every downstream fixture -- which is exactly the drift the pinned bytes exist to catch.
 */
export function buildGoldenDocuments(): Record<GoldenRecordKind, SealedRecord> {
  const intent = sealExecutionBatchIntent({
    protocol: BENCHMARKING_PROTOCOL_V2,
    owner: "urn:agent:owner",
    adapter: {
      id: "urn:jinn:native-adapter:harbor",
      version: "1.0.0",
      mappingVersion: "harbor-trial/1",
    },
    invocation: {
      executable: { path: "/opt/harbor", artifact: descriptor(1, "harbor") },
      argv: ["run", "--job", "job.toml"],
      environment: [{ name: "LANG", value: "C.UTF-8" }],
      workingDirectoryPolicy: "isolated-workspace",
      runtimeClosure: [descriptor(2, "harbor-runtime")],
    },
    source: descriptor(3, "job.toml"),
    expectedScope: {
      unitKind: "harbor-trial",
      expectedUnitCount: 1,
      scope: descriptor(4, "job-scope"),
    },
    privacy: {
      policy: descriptor(5, "privacy-policy"),
      publication: "transport-neutral",
      defaultAvailability: "digest-only",
      lowEntropyDigestPolicy: "explicit-review",
    },
    sealedAt: "2026-08-16T09:00:00Z",
  });

  const subjectExecution = evidence(30, "execution-evidence", "ro-crate-metadata.json");

  const capture = sealExecutionBatchCapture({
    protocol: BENCHMARKING_PROTOCOL_V2,
    intent: of(intent, "intent"),
    owner: "urn:agent:owner",
    adapter: {
      id: "urn:jinn:native-adapter:harbor",
      version: "1.0.0",
      mappingVersion: "harbor-trial/1",
    },
    source: descriptor(6, "job-archive"),
    units: [
      {
        unitKey: "trial-0001",
        identifiers: [{ scheme: "urn:harbor:trial-id", value: "trial-0001" }],
        status: "captured",
        executionEvidence: subjectExecution,
        projectedEvaluations: [],
        limitations: [],
      },
    ],
    closure: {
      inventoryCount: 1,
      capturedCount: 1,
      failedCount: 0,
      tombstoneCount: 0,
      excludedCount: 0,
      checks: [{ name: "source-unchanged", status: "pass" }],
    },
    assurance: {
      origin: "native-direct",
      timing: "prospective-native-observed",
      closure: "complete-relative-to-sealed-source",
      availability: "digest-only",
      limitations: [],
    },
    capturedAt: "2026-08-16T09:01:00Z",
  });

  const benchmark = sealBenchmarkDefinitionV2({
    protocol: BENCHMARKING_PROTOCOL_V2,
    name: "Memory qualification",
    description: "One-subject reduction of the #2706 golden lifecycle.",
    version: "1.0.0",
    items: [{ task: descriptor(20, "memory-task"), identifiers: [] }],
    reveal: { policy: "immediate" },
  });

  const captureSource: TypedRecordReference = {
    recordKind: EXECUTION_BATCH_CAPTURE_RECORD_KIND,
    record: of(capture, "batch-capture"),
  };

  const manifest = sealBenchmarkAnalysisManifest({
    protocol: BENCHMARKING_PROTOCOL_V2,
    benchmark: of(benchmark, "benchmark-v2"),
    owner: "urn:agent:analysis-owner",
    sources: [{ source: captureSource, cutoff: "2026-08-16T10:00:00Z" }],
    groups: [{ groupId: "memory", selection: descriptor(22, "group") }],
    taskRelation: { exactDigestRequired: true },
    multiplicity: {
      correlationUnit: "execution",
      duplicatePolicy: "retain-distinct",
      retryPolicy: "correlated",
      assignmentPolicy: descriptor(23, "assignment"),
    },
    evaluationAdmission: {
      evaluatorAllowlist: [],
      methodAllowlist: [],
      minimumClaims: 1,
      distinctEvaluators: false,
      humanLabelPolicy: "two-human-unanimous",
      conflictPolicy: "preserve-unresolved",
      supersessionPolicy: "preserve-all",
      trustPolicy: descriptor(24, "evaluation-trust"),
    },
    verificationAdmission: {
      requiredChecks: [],
      trustPolicy: descriptor(25, "verification-trust"),
      failurePolicy: "disclose",
    },
    completeness: {
      required: "complete",
      unavailableSource: "indeterminate",
      discoveredOmission: "fail",
      excludedMember: "count-attrition",
    },
    analysisPlan: [
      {
        id: "jinn.benchmarking.method/binary-instrument",
        version: "2",
        parameters: { calls: 3, instruments: 4 },
      },
    ],
    closeAt: "2026-08-16T10:00:00Z",
    preregistration: "post-hoc-exploratory",
  });

  const automated = Array.from({ length: 12 }, (_, index) =>
    evidence(100 + index, "result-evaluation", `automated-${index}`),
  );
  const humans = [
    evidence(200, "result-evaluation", "human-alice"),
    evidence(201, "result-evaluation", "human-bob"),
  ];
  const evaluations = [...automated, ...humans].sort((left, right) =>
    left.record.digest.sha256 < right.record.digest.sha256 ? -1 : 1,
  );
  const resolution = evidence(220, "human-label-resolution", "unanimous-label");

  const humanLabelResolution = sealHumanLabelResolutionPayload({
    protocol: BENCHMARKING_PROTOCOL_V2,
    task: descriptor(20, "memory-task"),
    results: [descriptor(31, "candidate-answer")],
    policy: {
      id: "https://spec.jinn.network/policies/two-human-unanimity/v1",
      version: "1.0.0",
      requiredReviewers: 2,
      agreement: "unanimous",
    },
    basis: {
      kind: "independent-human-evaluations",
      evaluations: humans,
      reviewers: ["urn:reviewer:alice", "urn:reviewer:bob"],
    },
    resolution: { status: "admitted", label: "ACCEPT" },
    admittingOperator: "urn:operator:admission",
    publisher: "urn:publisher:colophon",
    issuer: "urn:issuer:label-resolution",
    resolvedAt: "2026-08-16T11:00:00Z",
  });

  const cohort = sealEvidenceCohort({
    protocol: BENCHMARKING_PROTOCOL_V2,
    manifest: of(manifest, "analysis-manifest"),
    boundary: {
      sources: [{ source: captureSource }],
      resolvedAt: "2026-08-16T10:00:01Z",
    },
    members: [
      {
        memberKey: "memory/0001/0",
        execution: subjectExecution,
        taskDigest: `sha256:${hex(20)}`,
        resultDigests: [`sha256:${hex(31)}`],
        groupId: "memory",
        slotId: "0001",
        replicate: 0,
        correlationKey: "harbor-job/trial-0001",
        evaluations: { considered: evaluations, admitted: evaluations, excluded: [] },
        verifications: { considered: [], admitted: [], excluded: [] },
        labelResolutions: {
          considered: [resolution],
          admitted: [resolution],
          excluded: [],
        },
        assurance: {
          origin: "native-direct",
          timing: "prospective-native-observed",
          closure: "complete-relative-to-sealed-source",
          availability: "digest-only",
          limitations: [],
        },
      },
    ],
    excludedExecutions: [],
    closure: {
      status: "complete-relative-to-sealed-source",
      candidateCount: 1,
      admittedCount: 1,
      excludedCount: 0,
      unavailableCount: 0,
      limitations: [],
    },
  });

  const matrix = sealMatrixV2({
    protocol: BENCHMARKING_PROTOCOL_V2,
    manifest: of(manifest, "analysis-manifest"),
    cohort: of(cohort, "cohort"),
    cells: [
      {
        memberKey: "memory/0001/0",
        groupId: "memory",
        slotId: "0001",
        replicate: 0,
        execution: subjectExecution,
        taskDigest: `sha256:${hex(20)}`,
        resultDigests: [`sha256:${hex(31)}`],
        consideredEvaluations: evaluations,
        admittedEvaluations: evaluations,
        consideredVerifications: [],
        admittedVerifications: [],
        admittedLabelResolutions: [resolution],
        outcome: "accepted",
        integrity: "re-derivable",
        measurements: [],
        trust: {
          signatureValid: "pass",
          identityBound: "pass",
          purposeAuthorized: "pass",
          policyTrusted: "pass",
          partyIndependenceEstablished: "unknown",
        },
        disclosures: [],
      },
    ],
    completeness: { expected: 1, admitted: 1, excluded: 0, unavailable: 0, status: "complete" },
    assembly: {
      procedure: "jinn.benchmarking.assembly",
      version: "3.0",
      implementation: descriptor(40, "assembler"),
    },
  });

  const report = sealEvidenceNativeReportV2({
    protocol: BENCHMARKING_PROTOCOL_V2,
    subjects: [of(matrix, "matrix-v2")],
    manifest: of(manifest, "analysis-manifest"),
    cohort: of(cohort, "cohort"),
    method: {
      id: "jinn.benchmarking.method/binary-instrument",
      version: "2",
      parameters: { calls: 3, instruments: 4 },
      implementation: descriptor(41, "analysis-implementation"),
    },
    preregistration: "post-hoc-exploratory",
    results: { qualification: "pass" },
    disclosures: {
      evidenceOrigin: { "native-direct": 1 },
      timing: { "prospective-native-observed": 1 },
      closure: { "complete-relative-to-sealed-source": 1 },
      taskRelation: { "exact-digest": 1 },
      availability: { "digest-only": 1 },
      conflictsPreserved: 0,
      commissioningRequired: false,
    },
    limitations: [],
    author: "urn:agent:analysis-owner",
  });

  const commissioningLink = sealExecutionCommissioningLink({
    protocol: BENCHMARKING_PROTOCOL_V2,
    execution: subjectExecution,
    submission: typed(50, "https://spec.jinn.network/records/task-execution-submission/v1", "submission.json"),
    attempts: ["urn:uuid:70000000-0000-4000-8000-000000000003"],
    deliveries: [
      typed(51, "https://spec.jinn.network/records/task-execution-delivery/v1", "delivery.json"),
    ],
    publisher: "urn:publisher:colophon",
    linkedAt: "2026-08-16T17:00:03Z",
  });

  const reportEnvelope = descriptor(42, "report.dsse.json");
  const claimPackage = sealEvidenceNativeClaimPackageV3({
    claimSchema: "benchmark-product.claim-package/3",
    profile: CLAIM_PACKAGE_V3_PROFILE,
    records: {
      benchmark: of(benchmark, "benchmark-v2.json"),
      manifest: of(manifest, "analysis-manifest.json"),
      cohort: of(cohort, "cohort.json"),
      matrix: of(matrix, "matrix.json"),
      reportPayload: of(report, "report.json"),
      reportEnvelope,
      evidence: [subjectExecution, ...evaluations, resolution].sort((left, right) =>
        evidenceReferenceKey(left) < evidenceReferenceKey(right) ? -1 : 1,
      ),
      artifacts: [descriptor(60, "task.bin"), descriptor(61, "result.bin")],
    },
    method: {
      id: "jinn.benchmarking.method/binary-instrument",
      version: "2",
      parameters: { calls: 3, instruments: 4 },
    },
    results: { qualification: "pass" },
    closure: {
      status: "complete-relative-to-sealed-source",
      candidateCount: 1,
      admittedCount: 1,
      excludedCount: 0,
      unavailableCount: 0,
      limitations: [],
    },
    trust: {
      signers: [
        {
          keyId: "urn:key:report",
          identity: "urn:publisher:colophon",
          purpose: "report",
          publicKey: descriptor(70, "report.pub"),
          algorithm: "ed25519",
        },
      ],
      signatureValidityIsNotAuthorization: true,
    },
    verification: {
      checks: [
        "manifest",
        "evidence-closure",
        "artifact-integrity",
        "signature-validity",
        "matrix-rederivation",
        "report-verification",
        "claim-consistency",
      ],
      command: "colophon bundle verify",
    },
    issuedAt: "2026-08-16T12:00:00Z",
  });

  const bundleManifest = sealEvidenceNativeBundleManifestV5({
    format: "benchmark-product-public-bundle/5",
    profile: BENCHMARK_PRODUCT_PUBLIC_BUNDLE_V5_PROFILE,
    files: [
      { path: "claim-package.json", sha256: claimPackage.digest.slice(7), bytes: claimPackage.bytes.byteLength },
      { path: "records/cohort.json", sha256: cohort.digest.slice(7), bytes: cohort.bytes.byteLength },
      { path: "records/matrix.json", sha256: matrix.digest.slice(7), bytes: matrix.bytes.byteLength },
      { path: "records/report.json", sha256: report.digest.slice(7), bytes: report.bytes.byteLength },
    ],
  });

  return {
    "execution-batch-intent": intent,
    "execution-batch-capture": capture,
    "benchmark-v2": benchmark,
    "analysis-manifest": manifest,
    "evidence-cohort": cohort,
    "matrix-v2": matrix,
    "report-v2": report,
    "human-label-resolution": humanLabelResolution,
    "execution-commissioning-link": commissioningLink,
    "claim-package-v3": claimPackage,
    "bundle-manifest-v5": bundleManifest,
  };
}
