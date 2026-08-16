// SPDX-License-Identifier: Apache-2.0

import {
  BENCHMARKING_PROTOCOL_V2,
  documentDigest,
  parseExecutionCommissioningLink,
  sealExecutionCommissioningLink,
} from "@jinn-network/benchmarking-protocol";
import { recordDigest, validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import { buildExecutionEvidence, type ExecutionEvidenceArtifactSource } from "@jinn-network/execution-evidence-builder";
import {
  DELIVERY_MEDIA_TYPE,
  SUBMISSION_MEDIA_TYPE,
  DeliveryRecordSchema,
  SubmissionRecordSchema,
  sealDelivery,
  sealSubmission,
} from "@jinn-network/task-execution-protocol";
import { describe, expect, test } from "vitest";

const encoder = new TextEncoder();
const origin = { kind: "producer-observed", observer: "urn:agent:colophon-parity" } as const;

function source(bytes: Uint8Array, name: string, mediaType: string): ExecutionEvidenceArtifactSource {
  return { digest: recordDigest(bytes), size: bytes.byteLength, name, mediaType };
}

function descriptor(name: string, digest: `sha256:${string}`, mediaType?: string) {
  return { name, digest: { sha256: digest.slice(7) }, ...(mediaType === undefined ? {} : { mediaType }) };
}

describe("optional TEP commissioning parity", () => {
  test("a real Submission/Attempt/Delivery link does not change evaluator-D evidence identity", () => {
    const taskBytes = encoder.encode('{"candidate":"answer-1","instruction":"apply instrument D","question":"memory-1"}');
    const resultBytes = encoder.encode('{"observation":"supported","opinion":"ACCEPT"}');
    const runtimeBytes = encoder.encode('{"inspect":"0.3.255","instrument":"D"}');
    const traceBytes = encoder.encode('{"events":[{"type":"model"}]}');
    const executableBytes = encoder.encode("inspect-ai@0.3.255");
    const task = source(taskBytes, "judge-request.json", "application/json");
    const result = source(resultBytes, "judge-response.json", "application/json");
    const runtime = source(runtimeBytes, "inspect-runtime.json", "application/json");
    const trace = source(traceBytes, "inspect-trace.json", "application/json");
    const executable = source(executableBytes, "inspect", "application/octet-stream");
    const evidenceBytes = buildExecutionEvidence({
      recording: {
        executionId: "urn:uuid:70000000-0000-4000-8000-000000000001",
        startedAt: "2026-08-16T17:00:00.000Z",
        record: {
          name: "Inspect instrument D commissioned call",
          description: "One actual evaluator-D execution, independently identified from its commissioning lineage.",
          license: "https://creativecommons.org/publicdomain/zero/1.0/",
        },
        task: { entityId: "task/request.json", name: task.name!, source: task, origin },
        initialInputs: [],
        executor: { entityId: "urn:evaluator:instrument-D", kind: "software", name: "Instrument D", origin },
        runtime: {
          entityId: "runtime/inspect.json",
          specification: runtime,
          name: "Inspect",
          softwareVersion: "0.3.255",
          origin,
          components: [{
            kind: "controlled",
            artifact: { kind: "file", entityId: "runtime/inspect", source: executable, origin },
          }],
        },
        producer: { entityId: "urn:agent:colophon-parity", kind: "software", name: "Colophon", origin },
      },
      additionalInputs: [],
      runtimeObservations: [],
      outcome: "completed",
      endedAt: "2026-08-16T17:00:01.000Z",
      finalizedAt: "2026-08-16T17:00:02.000Z",
      results: [{ kind: "file", entityId: "results/response.json", source: result, origin }],
      nativeTrace: {
        artifact: { kind: "file", entityId: "trace/inspect.json", source: trace, origin },
        format: { entityId: "https://inspect.aisi.org.uk/formats/eval-sample-trace" },
      },
    });
    expect(validateExecutionEvidence(evidenceBytes)).toMatchObject({ conforms: true, diagnostics: [] });
    const evidenceDigestBeforeCommissioning = recordDigest(evidenceBytes);

    const submissionBytes = sealSubmission(SubmissionRecordSchema.parse({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      submission: "urn:uuid:70000000-0000-4000-8000-000000000002",
      task: { name: task.name, digest: { sha256: task.digest.slice(7) }, mediaType: task.mediaType },
      requester: "urn:operator:golden",
      idempotencyKey: "golden/instrument-D/call-commissioned",
      nonce: "instrument-D:4",
      deadline: "2026-08-16T17:05:00.000Z",
    }));
    const attempt = "urn:uuid:70000000-0000-4000-8000-000000000003";
    const deliveryBytes = sealDelivery(DeliveryRecordSchema.parse({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      attempt,
      task: task.digest,
      outputs: [{ name: result.name, digest: { sha256: result.digest.slice(7) }, mediaType: result.mediaType }],
      outcome: "fulfilled",
      executionIds: ["urn:uuid:70000000-0000-4000-8000-000000000001"],
      evidenceRecords: [{ family: "execution-evidence", digest: evidenceDigestBeforeCommissioning }],
      createdAt: "2026-08-16T17:00:02.000Z",
    }));
    const link = sealExecutionCommissioningLink({
      protocol: BENCHMARKING_PROTOCOL_V2,
      execution: {
        family: "execution-evidence",
        record: descriptor("ro-crate-metadata.json", evidenceDigestBeforeCommissioning, "application/ld+json"),
      },
      submission: {
        recordKind: "https://spec.jinn.network/records/task-execution-submission/v1",
        record: descriptor("submission.json", recordDigest(submissionBytes), SUBMISSION_MEDIA_TYPE),
      },
      attempts: [attempt],
      deliveries: [{
        recordKind: "https://spec.jinn.network/records/task-execution-delivery/v1",
        record: descriptor("delivery.json", recordDigest(deliveryBytes), DELIVERY_MEDIA_TYPE),
      }],
      publisher: "urn:publisher:colophon",
      linkedAt: "2026-08-16T17:00:03.000Z",
    });

    const parsed = parseExecutionCommissioningLink(link.bytes);
    expect(parsed.execution.record.digest.sha256).toBe(evidenceDigestBeforeCommissioning.slice(7));
    expect(parsed.attempts).toEqual([attempt]);
    expect(parsed.deliveries).toHaveLength(1);
    expect(recordDigest(evidenceBytes)).toBe(evidenceDigestBeforeCommissioning);
    expect(documentDigest(link.bytes)).not.toBe(evidenceDigestBeforeCommissioning);
  });
});
