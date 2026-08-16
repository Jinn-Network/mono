// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  BENCHMARKING_PROTOCOL_V2,
  BENCHMARK_V2_RECORD_KIND,
  EVIDENCE_COHORT_RECORD_KIND,
  EXECUTION_BATCH_CAPTURE_RECORD_KIND,
  MATRIX_V2_RECORD_KIND,
} from "./identifiers.js";
import {
  parseBenchmarkDefinitionV2,
  sealBenchmarkDefinitionV2,
} from "./benchmark.js";
import {
  parseBenchmarkAnalysisManifest,
  sealBenchmarkAnalysisManifest,
} from "./manifest.js";
import { parseEvidenceCohort, sealEvidenceCohort } from "./cohort.js";
import { parseMatrixV2, sealMatrixV2 } from "./matrix.js";
import {
  parseEvidenceNativeReportV2,
  sealEvidenceNativeReportV2,
} from "./report.js";
import {
  parseHumanLabelResolutionPayload,
  sealHumanLabelResolutionPayload,
} from "./human-label-resolution.js";
import {
  parseExecutionBatchCapture,
  parseExecutionBatchIntent,
  sealExecutionBatchCapture,
  sealExecutionBatchIntent,
} from "./batch.js";
import type {
  DigestBearingResourceDescriptor,
  EvidenceRecordReference,
  TypedRecordReference,
} from "./common.js";

function hex(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function descriptor(
  index: number,
  name = `record-${index}`,
): DigestBearingResourceDescriptor {
  return { name, digest: { sha256: hex(index) } };
}

function typed(
  index: number,
  recordKind: string,
): TypedRecordReference {
  return { recordKind, record: descriptor(index) };
}

function evidence(
  index: number,
  family: EvidenceRecordReference["family"],
): EvidenceRecordReference {
  return { family, record: descriptor(index) };
}

describe("evidence-native benchmarking records", () => {
  test("keeps two human opinions separate from their unanimous label resolution", () => {
    const sealed = sealHumanLabelResolutionPayload({
      protocol: BENCHMARKING_PROTOCOL_V2,
      task: descriptor(10, "memory-task"),
      results: [descriptor(11, "candidate-answer")],
      policy: {
        id: "https://spec.jinn.network/policies/two-human-unanimity/v1",
        version: "1.0.0",
        requiredReviewers: 2,
        agreement: "unanimous",
      },
      basis: {
        kind: "independent-human-evaluations",
        evaluations: [
          evidence(12, "result-evaluation"),
          evidence(13, "result-evaluation"),
        ],
        reviewers: ["urn:reviewer:alice", "urn:reviewer:bob"],
      },
      resolution: { status: "admitted", label: "ACCEPT" },
      admittingOperator: "urn:operator:admission",
      publisher: "urn:publisher:colophon",
      issuer: "urn:issuer:label-resolution",
      resolvedAt: "2026-08-16T11:00:00Z",
    });
    expect(parseHumanLabelResolutionPayload(sealed.bytes)).toMatchObject({
      resolution: { status: "admitted", label: "ACCEPT" },
      basis: { evaluations: expect.arrayContaining([
        evidence(12, "result-evaluation"),
        evidence(13, "result-evaluation"),
      ]) },
    });
  });

  test("seals and exactly parses prospective batch intent and capture", () => {
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
    expect(parseExecutionBatchIntent(intent.bytes).invocation.argv).toEqual([
      "run",
      "--job",
      "job.toml",
    ]);

    const capture = sealExecutionBatchCapture({
      protocol: BENCHMARKING_PROTOCOL_V2,
      intent: { name: "intent", digest: { sha256: intent.digest.slice(7) } },
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
          identifiers: [
            { scheme: "urn:harbor:trial-id", value: "trial-0001" },
          ],
          status: "captured",
          executionEvidence: evidence(7, "execution-evidence"),
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
    expect(parseExecutionBatchCapture(capture.bytes).units).toHaveLength(1);
  });

  test("represents one subject with four automated judges, three calls, and two humans", () => {
    const benchmark = sealBenchmarkDefinitionV2({
      protocol: BENCHMARKING_PROTOCOL_V2,
      name: "Memory qualification",
      description: "One-subject reduction of the #2706 golden lifecycle.",
      version: "1.0.0",
      items: [
        {
          task: descriptor(20, "memory-task"),
          identifiers: [],
        },
      ],
      reveal: { policy: "immediate" },
    });
    expect(parseBenchmarkDefinitionV2(benchmark.bytes).items).toHaveLength(1);

    const manifest = sealBenchmarkAnalysisManifest({
      protocol: BENCHMARKING_PROTOCOL_V2,
      benchmark: {
        name: "benchmark-v2",
        digest: { sha256: benchmark.digest.slice(7) },
      },
      owner: "urn:agent:analysis-owner",
      sources: [
        {
          source: typed(21, EXECUTION_BATCH_CAPTURE_RECORD_KIND),
          cutoff: "2026-08-16T10:00:00Z",
        },
      ],
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
    expect(parseBenchmarkAnalysisManifest(manifest.bytes).multiplicity).toMatchObject({
      correlationUnit: "execution",
    });

    const automated = Array.from({ length: 12 }, (_, index) =>
      evidence(100 + index, "result-evaluation"),
    );
    const humans = [
      evidence(200, "result-evaluation"),
      evidence(201, "result-evaluation"),
    ];
    const evaluations = [...automated, ...humans].sort((left, right) =>
      left.record.digest.sha256 < right.record.digest.sha256 ? -1 : 1,
    );
    const resolution = evidence(220, "human-label-resolution");
    const subjectExecution = evidence(30, "execution-evidence");
    const cohort = sealEvidenceCohort({
      protocol: BENCHMARKING_PROTOCOL_V2,
      manifest: {
        name: "analysis-manifest",
        digest: { sha256: manifest.digest.slice(7) },
      },
      boundary: {
        sources: [{ source: typed(21, EXECUTION_BATCH_CAPTURE_RECORD_KIND) }],
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
          evaluations: {
            considered: evaluations,
            admitted: evaluations,
            excluded: [],
          },
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
    const parsedCohort = parseEvidenceCohort(cohort.bytes);
    expect(parsedCohort.members[0]!.evaluations.admitted).toHaveLength(14);
    expect(parsedCohort.members[0]!.labelResolutions.admitted).toEqual([
      resolution,
    ]);

    const matrix = sealMatrixV2({
      protocol: BENCHMARKING_PROTOCOL_V2,
      manifest: {
        name: "analysis-manifest",
        digest: { sha256: manifest.digest.slice(7) },
      },
      cohort: {
        name: "cohort",
        digest: { sha256: cohort.digest.slice(7) },
      },
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
      completeness: {
        expected: 1,
        admitted: 1,
        excluded: 0,
        unavailable: 0,
        status: "complete",
      },
      assembly: {
        procedure: "jinn.benchmarking.assembly",
        version: "3.0",
        implementation: descriptor(40, "assembler"),
      },
    });
    expect(parseMatrixV2(matrix.bytes).cells[0]!.admittedEvaluations).toHaveLength(14);

    const report = sealEvidenceNativeReportV2({
      protocol: BENCHMARKING_PROTOCOL_V2,
      subjects: [
        { name: "matrix-v2", digest: { sha256: matrix.digest.slice(7) } },
      ],
      manifest: {
        name: "analysis-manifest",
        digest: { sha256: manifest.digest.slice(7) },
      },
      cohort: {
        name: "cohort",
        digest: { sha256: cohort.digest.slice(7) },
      },
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
    expect(parseEvidenceNativeReportV2(report.bytes).results).toEqual({
      qualification: "pass",
    });

    const chain = new TextDecoder().decode(
      new Uint8Array([
        ...benchmark.bytes,
        ...manifest.bytes,
        ...cohort.bytes,
        ...matrix.bytes,
        ...report.bytes,
      ]),
    );
    expect(chain).not.toContain("Submission");
    expect(chain).not.toContain("Attempt");
    expect(chain).not.toContain("Delivery");
    expect(BENCHMARK_V2_RECORD_KIND).toContain("/benchmark/v2");
    expect(EVIDENCE_COHORT_RECORD_KIND).toContain("evidence-cohort/v1");
    expect(MATRIX_V2_RECORD_KIND).toContain("matrix/v2");
  });
});
