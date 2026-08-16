// SPDX-License-Identifier: Apache-2.0

import {
  BENCHMARKING_PROTOCOL_V2,
  EXECUTION_BATCH_CAPTURE_RECORD_KIND,
  documentDigest,
  sealBenchmarkAnalysisManifest,
  sealEvidenceCohort,
  type DigestBearingResourceDescriptor,
  type EvidenceRecordReference,
} from "@jinn-network/benchmarking-protocol";
import {
  DSSE_PAYLOAD_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  RESULT_EVALUATION_PREDICATE_TYPE,
  recordDigest,
} from "@jinn-network/evidence-protocol";
import {
  buildExecutionEvidence,
  type ExecutionEvidenceArtifactSource,
  type ExecutionEvidenceBuilderInput,
} from "@jinn-network/execution-evidence-builder";
import { describe, expect, test } from "vitest";

import {
  assembleEvidenceMatrix,
  verifyEvidenceCohort,
  verifyEvidenceMatrix,
} from "./index.js";

const ORIGIN = {
  kind: "producer-observed",
  observer: "urn:agent:golden-capture",
} as const;

function source(digit: string, mediaType: string): ExecutionEvidenceArtifactSource {
  return { digest: `sha256:${digit.repeat(64)}`, size: 4, mediaType };
}

function subjectInput(): ExecutionEvidenceBuilderInput {
  return {
    recording: {
      executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-16T09:00:00.000Z",
      record: {
        name: "Memory subject",
        description: "Harbor Trial projected as one atomic subject execution.",
        license: "https://creativecommons.org/publicdomain/zero/1.0/",
      },
      task: {
        entityId: "task/memory.json",
        name: "Memory question",
        source: source("1", "application/json"),
        origin: ORIGIN,
      },
      initialInputs: [],
      executor: {
        entityId: "urn:agent:memory-system",
        kind: "software",
        name: "Memory system",
        origin: ORIGIN,
      },
      runtime: {
        entityId: "runtime/harbor.json",
        specification: source("2", "application/json"),
        name: "Harbor",
        softwareVersion: "0.21.0",
        origin: ORIGIN,
        components: [{
          kind: "controlled",
          artifact: {
            kind: "file",
            entityId: "runtime/harbor.bin",
            source: source("d", "application/octet-stream"),
            origin: ORIGIN,
          },
        }],
      },
      producer: {
        entityId: "urn:agent:golden-capture",
        kind: "software",
        name: "Colophon capture",
        origin: ORIGIN,
      },
    },
    additionalInputs: [],
    runtimeObservations: [],
    outcome: "completed",
    endedAt: "2026-08-16T09:00:01.000Z",
    finalizedAt: "2026-08-16T09:00:02.000Z",
    results: [{
      kind: "file",
      entityId: "results/answer.txt",
      source: source("3", "text/plain"),
      origin: ORIGIN,
    }],
    nativeTrace: {
      artifact: {
        kind: "file",
        entityId: "trace/atif.json",
        source: source("4", "application/json"),
        origin: ORIGIN,
      },
      format: { entityId: "https://harborframework.com/formats/atif" },
    },
  };
}

function descriptor(name: string, digest: `sha256:${string}`): DigestBearingResourceDescriptor {
  return { name, digest: { sha256: digest.slice(7) } };
}

function reference(
  family: EvidenceRecordReference["family"],
  name: string,
  bytes: Uint8Array,
): EvidenceRecordReference {
  return { family, record: descriptor(name, recordDigest(bytes)) };
}

function evaluationBytes(verdict: "pass" | "fail" | "inconclusive", instrument: string): Uint8Array {
  const statement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      descriptor("results/answer.txt", `sha256:${"3".repeat(64)}`),
      descriptor("task/memory.json", `sha256:${"1".repeat(64)}`),
    ],
    predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
    predicate: {
      evaluatedAt: "2026-08-16T09:10:00.000Z",
      evaluator: { id: `urn:evaluator:${instrument}` },
      evaluationMethod: descriptor(`${instrument}.json`, `sha256:${"5".repeat(64)}`),
      taskSubject: "task/memory.json",
      resultSubjects: ["results/answer.txt"],
      verdict,
      measurements: [{ name: "binary-opinion", value: verdict }],
    },
  };
  const payload = new TextEncoder().encode(JSON.stringify(statement));
  return new TextEncoder().encode(JSON.stringify({
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: Buffer.from(payload).toString("base64"),
    signatures: [{ keyid: `urn:key:${instrument}`, sig: "AA==" }],
  }));
}

function fixture() {
  const executionBytes = buildExecutionEvidence(subjectInput());
  const execution = reference("execution-evidence", "ro-crate-metadata.json", executionBytes);
  const evaluationBytesValue = evaluationBytes("pass", "instrument-a");
  const evaluation = reference("result-evaluation", "instrument-a.dsse.json", evaluationBytesValue);
  const manifest = sealBenchmarkAnalysisManifest({
    protocol: BENCHMARKING_PROTOCOL_V2,
    benchmark: descriptor("benchmark-v2", `sha256:${"6".repeat(64)}`),
    owner: "urn:agent:analysis-owner",
    sources: [{
      source: {
        recordKind: EXECUTION_BATCH_CAPTURE_RECORD_KIND,
        record: descriptor("capture", `sha256:${"7".repeat(64)}`),
      },
      cutoff: "2026-08-16T10:00:00Z",
    }],
    groups: [{ groupId: "memory", selection: descriptor("selection", `sha256:${"8".repeat(64)}`) }],
    taskRelation: { exactDigestRequired: true },
    multiplicity: {
      correlationUnit: "execution",
      duplicatePolicy: "retain-distinct",
      retryPolicy: "correlated",
      assignmentPolicy: descriptor("assignment", `sha256:${"9".repeat(64)}`),
    },
    evaluationAdmission: {
      evaluatorAllowlist: [],
      methodAllowlist: [],
      minimumClaims: 1,
      distinctEvaluators: false,
      humanLabelPolicy: "not-required",
      conflictPolicy: "preserve-unresolved",
      supersessionPolicy: "preserve-all",
      trustPolicy: descriptor("trust", `sha256:${"a".repeat(64)}`),
    },
    verificationAdmission: {
      requiredChecks: [],
      trustPolicy: descriptor("verification-trust", `sha256:${"b".repeat(64)}`),
      failurePolicy: "disclose",
    },
    completeness: {
      required: "complete",
      unavailableSource: "indeterminate",
      discoveredOmission: "fail",
      excludedMember: "count-attrition",
    },
    analysisPlan: [{ id: "binary-opinion", version: "1", parameters: {} }],
    closeAt: "2026-08-16T10:00:00Z",
    preregistration: "post-hoc-exploratory",
  });
  const cohort = sealEvidenceCohort({
    protocol: BENCHMARKING_PROTOCOL_V2,
    manifest: descriptor("manifest", manifest.digest),
    boundary: {
      sources: [{
        source: {
          recordKind: EXECUTION_BATCH_CAPTURE_RECORD_KIND,
          record: descriptor("capture", `sha256:${"7".repeat(64)}`),
        },
      }],
      resolvedAt: "2026-08-16T10:00:01Z",
    },
    members: [{
      memberKey: "memory/0001/0",
      execution,
      taskDigest: `sha256:${"1".repeat(64)}`,
      resultDigests: [`sha256:${"3".repeat(64)}`],
      groupId: "memory",
      slotId: "0001",
      replicate: 0,
      correlationKey: "harbor/job-1/trial-1",
      evaluations: { considered: [evaluation], admitted: [evaluation], excluded: [] },
      verifications: { considered: [], admitted: [], excluded: [] },
      labelResolutions: { considered: [], admitted: [], excluded: [] },
      assurance: {
        origin: "native-direct",
        timing: "prospective-native-observed",
        closure: "complete-relative-to-sealed-source",
        availability: "public-exact",
        limitations: [],
      },
    }],
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
  const records = new Map([
    [`execution-evidence\u0000${execution.record.digest.sha256}`, executionBytes],
    [`result-evaluation\u0000${evaluation.record.digest.sha256}`, evaluationBytesValue],
  ]);
  return {
    execution,
    evaluation,
    manifest,
    cohort,
    records: {
      resolve(candidate: EvidenceRecordReference) {
        const bytes = records.get(`${candidate.family}\u0000${candidate.record.digest.sha256}`);
        if (bytes === undefined) throw new Error("missing exact evidence record");
        return bytes;
      },
    },
  };
}

describe("evidence-native cohort verification and Matrix assembly", () => {
  test("verifies exact Task+Result claim bindings with no commissioning records", () => {
    const value = fixture();
    const verified = verifyEvidenceCohort({
      cohortBytes: value.cohort.bytes,
      manifestBytes: value.manifest.bytes,
      records: value.records,
    });
    expect(verified).toMatchObject({ conforms: true, diagnostics: [] });
    if (!verified.conforms) throw new Error("fixture must conform");
    expect(verified.members[0]?.evaluations.size).toBe(1);

    const assembled = assembleEvidenceMatrix({
      cohortBytes: value.cohort.bytes,
      manifestBytes: value.manifest.bytes,
      records: value.records,
      implementation: descriptor("assembly-3.0", `sha256:${"c".repeat(64)}`),
      deriveCell: () => ({
        outcome: "accepted",
        integrity: "re-derivable",
        measurements: [],
        trust: {
          signatureValid: "unknown",
          identityBound: "unknown",
          purposeAuthorized: "unknown",
          policyTrusted: "unknown",
          partyIndependenceEstablished: "unknown",
        },
        disclosures: [],
      }),
    });
    expect(new TextDecoder().decode(assembled.record.bytes)).not.toMatch(/Submission|Attempt|Delivery/u);
    expect(verifyEvidenceMatrix({
      matrixBytes: assembled.record.bytes,
      cohortBytes: value.cohort.bytes,
      manifestBytes: value.manifest.bytes,
      records: value.records,
      implementation: descriptor("assembly-3.0", `sha256:${"c".repeat(64)}`),
      deriveCell: () => ({
        outcome: "accepted",
        integrity: "re-derivable",
        measurements: [],
        trust: {
          signatureValid: "unknown",
          identityBound: "unknown",
          purposeAuthorized: "unknown",
          policyTrusted: "unknown",
          partyIndependenceEstablished: "unknown",
        },
        disclosures: [],
      }),
    })).toMatchObject({ conforms: true });
    expect(documentDigest(value.cohort.bytes)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  test("rejects a Result Evaluation that is content-addressed but subjects different bytes", () => {
    const value = fixture();
    const wrongBytes = evaluationBytes("pass", "instrument-a");
    const envelope = JSON.parse(new TextDecoder().decode(wrongBytes));
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    statement.subject[1].digest.sha256 = "f".repeat(64);
    envelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    const mutated = new TextEncoder().encode(JSON.stringify(envelope));
    const wrongReference = reference("result-evaluation", "wrong.dsse.json", mutated);
    const originalCohort = JSON.parse(new TextDecoder().decode(value.cohort.bytes));
    originalCohort.members[0].evaluations = {
      considered: [wrongReference], admitted: [wrongReference], excluded: [],
    };
    const cohort = sealEvidenceCohort(originalCohort);
    const verified = verifyEvidenceCohort({
      cohortBytes: cohort.bytes,
      manifestBytes: value.manifest.bytes,
      records: {
        resolve(candidate) {
          if (candidate.family === "execution-evidence") return value.records.resolve(value.execution);
          return mutated;
        },
      },
    });
    expect(verified).toMatchObject({
      conforms: false,
      diagnostics: [{ code: "EVALUATION_SUBJECT_MISMATCH" }],
    });
  });
});
