// SPDX-License-Identifier: Apache-2.0

import {
  REPORT_V2_MEDIA_TYPE,
  REPORT_V3_RECORD_KIND,
  documentDigest,
  parseEvidenceNativeReportV2,
  parseMatrixV2,
  sealEvidenceNativeReportV2,
  type EvidenceNativeReportV2,
  type SealedRecord,
  type TypedRecordReference,
} from "@jinn-network/benchmarking-protocol";
import { parseExactDsseEnvelope, sealSignedPayload, type DsseSigner } from "@jinn-network/trust-core";

export interface IssueEvidenceNativeReportInput {
  readonly report: EvidenceNativeReportV2;
  readonly matrixBytes: Uint8Array;
  readonly signer: DsseSigner;
  readonly signal?: AbortSignal;
}

export interface IssuedEvidenceNativeReport {
  readonly payload: SealedRecord;
  readonly envelopeBytes: Uint8Array;
  readonly reference: TypedRecordReference;
}

function assertMatrixSubject(report: EvidenceNativeReportV2, matrixBytes: Uint8Array): void {
  parseMatrixV2(matrixBytes);
  const actual = documentDigest(matrixBytes).slice(7);
  if (report.subjects[0].digest.sha256 !== actual) {
    throw new TypeError("Report v2 must subject the exact Matrix v2 bytes");
  }
}

export async function issueEvidenceNativeReport(
  input: IssueEvidenceNativeReportInput,
): Promise<IssuedEvidenceNativeReport> {
  assertMatrixSubject(input.report, input.matrixBytes);
  const payload = sealEvidenceNativeReportV2(input.report);
  const envelope = await sealSignedPayload({
    payloadBytes: payload.bytes,
    payloadType: REPORT_V2_MEDIA_TYPE,
    signer: input.signer,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return {
    payload,
    envelopeBytes: envelope.envelopeBytes,
    reference: {
      recordKind: REPORT_V3_RECORD_KIND,
      record: {
        name: "benchmark-report.v3.dsse.json",
        digest: { sha256: envelope.recordDigest.slice(7) },
        mediaType: "application/vnd.dsse.envelope.v1+json",
      },
    },
  };
}

export function verifyEvidenceNativeReport(input: {
  readonly envelopeBytes: Uint8Array;
  readonly matrixBytes: Uint8Array;
}): { readonly report: EvidenceNativeReportV2; readonly payloadBytes: Uint8Array } {
  const envelope = parseExactDsseEnvelope(input.envelopeBytes);
  if (envelope.payloadType !== REPORT_V2_MEDIA_TYPE) {
    throw new TypeError("Report v3 envelope has the wrong payload type");
  }
  const report = parseEvidenceNativeReportV2(envelope.payloadBytes);
  assertMatrixSubject(report, input.matrixBytes);
  return { report, payloadBytes: envelope.payloadBytes };
}
