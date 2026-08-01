import { createHash } from 'node:crypto';
import { ADMISSION_RECEIPT_ANNOTATION_URI } from '@jinn-network/marketplace-binding';
import {
  IN_TOTO_STATEMENT_TYPE,
  VERDICT_DSSE_PAYLOAD_TYPE,
} from '@jinn-network/task-execution-profiles';
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealSubmission,
  type SubmissionRecord,
} from '@jinn-network/task-execution-protocol';
import { sealSignedRecord, type DsseSigner } from '@jinn-network/trust-core';

export interface BridgeSubject {
  readonly submission: {
    readonly document: SubmissionRecord;
    readonly bytes: Uint8Array;
    readonly digest: `sha256:${string}`;
  };
  readonly admissionReceipt: {
    readonly envelopeBytes: Uint8Array;
    readonly digest: `sha256:${string}`;
    readonly effectiveTime: string;
  };
  readonly derivation: 'legacy';
}

/** Fixed namespace for bridge-era subject Submission URNs. Never regenerate this constant. */
const BRIDGE_SUBMISSION_NAMESPACE = 'd9c05a5e-1f0f-52b4-9f0b-3f2a7b6c4d81';

const LEGACY_DERIVATION_ANNOTATION_URI =
  'https://jinn.network/annotations/legacy-derivation/1.0' as const;

const ADMISSION_RECEIPT_PREDICATE_TYPE =
  'https://jinn.network/attestations/admission-receipt/v1' as const;

function bareHex(digest: `sha256:${string}`): string {
  return digest.slice('sha256:'.length);
}

/** UUIDv5 over `(chainId, taskId)` so every operator names the Submission identically. */
function deriveBridgeSubmissionUri(chainId: number, taskId: bigint): `urn:uuid:${string}` {
  const name = `${chainId}:${taskId.toString(10)}`;
  const namespaceBytes = Uint8Array.from(
    (BRIDGE_SUBMISSION_NAMESPACE.replace(/-/g, '').match(/.{2}/g) ?? []).map((byte) =>
      Number.parseInt(byte, 16),
    ),
  );
  const hash = createHash('sha1')
    .update(Buffer.from(namespaceBytes))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = Uint8Array.prototype.slice.call(hash, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return `urn:uuid:${uuid}`;
}

function deriveAnchorKey(chainId: number, taskId: bigint): string {
  return `${chainId}:${taskId.toString(10)}`;
}

export async function synthesizeBridgeSubject(input: {
  readonly subjectTaskDigest: `sha256:${string}`;
  readonly evaluationSpecDigest: `sha256:${string}`;
  readonly requesterAgentIri: string;
  readonly admissionAgentIri: string;
  readonly legacyAnchor: {
    readonly chainId: number;
    readonly taskId: bigint;
    readonly blockHash: `0x${string}`;
  };
  readonly now: string;
  readonly signer: DsseSigner;
}): Promise<BridgeSubject> {
  const anchorKey = deriveAnchorKey(input.legacyAnchor.chainId, input.legacyAnchor.taskId);
  const taskDigestHex = bareHex(input.subjectTaskDigest);
  const evaluationSpecDigestHex = bareHex(input.evaluationSpecDigest);

  const admissionStatement = {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      { name: 'task', digest: { sha256: taskDigestHex } },
      { name: 'evaluation-spec', digest: { sha256: evaluationSpecDigestHex } },
    ],
    predicateType: ADMISSION_RECEIPT_PREDICATE_TYPE,
    predicate: { issuer: input.admissionAgentIri },
  };

  const sealedReceipt = await sealSignedRecord({
    record: admissionStatement,
    payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
    signer: input.signer,
  });

  const receiptDescriptor = {
    name: 'admission-receipt' as const,
    mediaType: VERDICT_DSSE_PAYLOAD_TYPE,
    digest: { sha256: bareHex(sealedReceipt.recordDigest) },
  };

  const submissionUri = deriveBridgeSubmissionUri(
    input.legacyAnchor.chainId,
    input.legacyAnchor.taskId,
  );

  const document = {
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: submissionUri,
    task: { digest: { sha256: taskDigestHex } },
    requester: input.requesterAgentIri,
    idempotencyKey: `bridge-submission:${anchorKey}`,
    nonce: `bridge-nonce:${anchorKey}`,
    deadline: input.now,
    annotations: {
      [ADMISSION_RECEIPT_ANNOTATION_URI]: receiptDescriptor,
      [LEGACY_DERIVATION_ANNOTATION_URI]: {
        chainId: input.legacyAnchor.chainId,
        taskId: input.legacyAnchor.taskId.toString(10),
        blockHash: input.legacyAnchor.blockHash.toLowerCase(),
      },
    },
  };

  const bytes = sealSubmission(document);

  return {
    submission: {
      document: document as SubmissionRecord,
      bytes,
      digest: documentDigest(bytes),
    },
    admissionReceipt: {
      envelopeBytes: sealedReceipt.envelopeBytes,
      digest: sealedReceipt.recordDigest,
      effectiveTime: input.now,
    },
    derivation: 'legacy',
  };
}
