// SPDX-License-Identifier: Apache-2.0

import {
  BENCHMARKING_PROTOCOL_V2,
  EXECUTION_COMMISSIONING_LINK_RECORD_KIND,
  documentDigest,
  parseExecutionCommissioningLink,
  sealExecutionCommissioningLink,
  type EvidenceRecordReference,
  type SealedRecord,
} from "@jinn-network/benchmarking-protocol";
import {
  backfillExecutionCommissioningLinks,
  type NativeCaptureStore,
  type NativeCommissioningLineage,
} from "@jinn-network/benchmarking-native-capture";
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

/**
 * One evaluator-D execution plus its real TEP commissioning records. Shared by the hand-sealed
 * parity case below and by the dual-write/backfill case that followed it (issue #3339), so both
 * make their claim about the same bytes.
 */
function commissionedEvaluatorD() {
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

  return {
    evidenceBytes,
    evidenceDigestBeforeCommissioning,
    attempt,
    link,
    lineage: {
      publisher: "urn:publisher:colophon",
      submission: {
        recordKind: "https://spec.jinn.network/records/task-execution-submission/v1",
        record: descriptor("submission.json", recordDigest(submissionBytes), SUBMISSION_MEDIA_TYPE),
      },
      attempts: [attempt],
      deliveries: [{
        recordKind: "https://spec.jinn.network/records/task-execution-delivery/v1",
        record: descriptor("delivery.json", recordDigest(deliveryBytes), DELIVERY_MEDIA_TYPE),
      }],
    } satisfies NativeCommissioningLineage,
  };
}

/** The minimum `NativeCaptureStore` the commissioning paths touch: evidence in, records out. */
function commissioningStore(evidenceBytes: Uint8Array) {
  const evidence = new Map([[recordDigest(evidenceBytes).slice(7), evidenceBytes]]);
  const written: { recordKind: string; record: SealedRecord }[] = [];
  const store: NativeCaptureStore = {
    loadSession: () => undefined,
    saveSession: () => {},
    putRecord: (recordKind: string, name: string, record: SealedRecord) => {
      written.push({ recordKind, record });
      return { recordKind, record: { name, digest: { sha256: record.digest.slice(7) } } };
    },
    putExecution: () => { throw new Error("unused"); },
    putArtifact: () => {},
    resolveEvidence: (reference: EvidenceRecordReference) => {
      const bytes = evidence.get(reference.record.digest.sha256);
      if (bytes === undefined) throw new Error("missing execution evidence");
      return bytes;
    },
  };
  return { store, written, evidence };
}

describe("optional TEP commissioning parity", () => {
  test("a real Submission/Attempt/Delivery link does not change evaluator-D evidence identity", () => {
    const { evidenceBytes, evidenceDigestBeforeCommissioning, attempt, link } = commissionedEvaluatorD();

    const parsed = parseExecutionCommissioningLink(link.bytes);
    expect(parsed.execution.record.digest.sha256).toBe(evidenceDigestBeforeCommissioning.slice(7));
    expect(parsed.attempts).toEqual([attempt]);
    expect(parsed.deliveries).toHaveLength(1);
    expect(recordDigest(evidenceBytes)).toBe(evidenceDigestBeforeCommissioning);
    expect(documentDigest(link.bytes)).not.toBe(evidenceDigestBeforeCommissioning);
  });

  test("the operational backfill path reaches the same conclusion over the same TEP records", () => {
    const { evidenceBytes, evidenceDigestBeforeCommissioning, attempt, link, lineage } = commissionedEvaluatorD();
    const { store, written, evidence } = commissioningStore(evidenceBytes);
    const execution: EvidenceRecordReference = {
      family: "execution-evidence",
      record: descriptor("ro-crate-metadata.json", evidenceDigestBeforeCommissioning, "application/ld+json"),
    };

    const [result] = backfillExecutionCommissioningLinks({
      store,
      clock: { now: () => "2026-08-16T17:00:03.000Z" },
      capture: { units: [{ unitKey: "instrument-D/call-4", executionEvidence: execution }] },
      lineage: new Map([["instrument-D/call-4", lineage]]),
    });

    // The link is a record of its own, written beside the evidence and never into it.
    expect(written).toHaveLength(1);
    expect(written[0]!.recordKind).toBe(EXECUTION_COMMISSIONING_LINK_RECORD_KIND);
    const parsed = parseExecutionCommissioningLink(result!.link.bytes);
    expect(parsed.execution.record.digest.sha256).toBe(evidenceDigestBeforeCommissioning.slice(7));
    expect(parsed.attempts).toEqual([attempt]);
    expect(parsed.deliveries).toHaveLength(1);

    // Parity is byte-identity, not field-by-field agreement (issue #3819). The lineage carries the
    // same publisher, submission, attempts and deliveries as the hand-sealed link, and the clock is
    // pinned to the same `linkedAt`, so the two documents must seal to the same digest. Without
    // this, a change to how `writeExecutionCommissioningLink` normalizes lineage into a sealed
    // document -- a reordering, a dropped optional, a canonicalization difference -- would keep
    // every assertion above green while breaking the parity this test is named for.
    expect(documentDigest(result!.link.bytes)).toBe(documentDigest(link.bytes));

    // The evidence the store holds is byte-identical to what it held before the backfill ran.
    expect(evidence.get(evidenceDigestBeforeCommissioning.slice(7))).toEqual(evidenceBytes);
    expect(recordDigest(evidenceBytes)).toBe(evidenceDigestBeforeCommissioning);
  });
});
