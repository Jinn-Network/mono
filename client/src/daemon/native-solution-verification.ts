import { verify as cryptoVerify, type KeyObject } from 'node:crypto';
import {
  DeliveryRecordSchema,
  DispatchContextSchema,
  SubmissionRecordSchema,
  TaskSpecificationSchema,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
  serializeCanonicalJson,
  type DeliveryRecord,
  type ResourceDescriptor,
} from '@jinn-network/task-execution-protocol';
import { dssePreAuthEncoding, parseDsseEnvelope } from '@jinn-network/trust-core';
import type {
  NativeSolutionVerificationInput,
  NativeSolutionVerificationPort,
} from './native-solution-coordinator.js';
import type {
  NativeRoleBindingDecision,
  NativeRoleIdentity,
  NativeRoleIdentityRole,
} from './role-identities.js';

const EXECUTOR_BINDING_PAYLOAD_TYPE =
  'application/vnd.jinn.marketplace.executor-binding.v1+json';

interface NativeSolutionVerificationIdentitySet {
  readonly agent: string;
  get(role: NativeRoleIdentityRole): NativeRoleIdentity;
  resolveEffective(
    role: NativeRoleIdentityRole,
    atTime: string,
  ): Promise<NativeRoleBindingDecision>;
}

export interface NativeSolutionVerificationDependencies {
  readonly identities: NativeSolutionVerificationIdentitySet;
  resolveEvaluationSpec(digest: `sha256:${string}`): Promise<Uint8Array | undefined>;
}

type VerificationDecision = Awaited<ReturnType<NativeSolutionVerificationPort['verify']>>;

function fail(reason: string): VerificationDecision {
  return { ok: false, reason };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function descriptorDigest(descriptor: ResourceDescriptor): `sha256:${string}` | undefined {
  const sha256 = descriptor.digest?.sha256;
  return typeof sha256 === 'string' ? `sha256:${sha256}` : undefined;
}

function parseCanonicalRecord<T>(input: {
  readonly bytes: Uint8Array;
  readonly parse: (value: unknown) => { readonly success: boolean; readonly data?: T };
  readonly seal: (value: T) => Uint8Array;
}): T | undefined {
  try {
    const parsed = input.parse(parseJson(input.bytes));
    if (!parsed.success || parsed.data === undefined) return undefined;
    return bytesEqual(input.seal(parsed.data), input.bytes) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function deliveryMatchesInput(parsed: DeliveryRecord, input: DeliveryRecord): boolean {
  try {
    return bytesEqual(sealDelivery(parsed), sealDelivery(input));
  } catch {
    return false;
  }
}

function verifyArtifactGraph(input: NativeSolutionVerificationInput): VerificationDecision {
  if (input.outputs.length !== input.delivery.outputs.length) return fail('output-cardinality-mismatch');
  const outputRows = new Map(input.outputs.map((row) => [`${row.name ?? ''}\0${row.digest}`, row]));
  for (const descriptor of input.delivery.outputs) {
    const digest = descriptorDigest(descriptor);
    if (digest === undefined) return fail('output-digest-missing');
    const row = outputRows.get(`${descriptor.name}\0${digest}`);
    if (row === undefined) return fail('output-reference-mismatch');
    if (documentDigest(row.bytes) !== digest) return fail('output-digest-mismatch');
    if (row.family !== (descriptor.mediaType ?? 'application/octet-stream')) {
      return fail('output-media-type-mismatch');
    }
  }

  const evidenceReferences = input.delivery.evidenceRecords ?? [];
  if (input.evidence.length !== evidenceReferences.length) return fail('evidence-cardinality-mismatch');
  const evidenceRows = new Map(input.evidence.map((row) => [`${row.family}\0${row.digest}`, row]));
  for (const reference of evidenceReferences) {
    const row = evidenceRows.get(`${reference.family}\0${reference.digest}`);
    if (row === undefined) return fail('evidence-reference-mismatch');
    if (documentDigest(row.bytes) !== reference.digest) return fail('evidence-digest-mismatch');
  }
  return { ok: true };
}

function verifyDeliveryEnvelope(input: {
  readonly bytes: Uint8Array;
  readonly deliveryBytes: Uint8Array;
  readonly keyId: string;
  readonly publicKey: KeyObject;
}): VerificationDecision {
  try {
    const envelope = parseDsseEnvelope(input.bytes);
    if (envelope.payloadType !== EXECUTOR_BINDING_PAYLOAD_TYPE) {
      return fail('delivery-envelope-payload-type-mismatch');
    }
    if (!bytesEqual(envelope.payloadBytes, input.deliveryBytes)) {
      return fail('delivery-envelope-payload-mismatch');
    }
    const signatures = envelope.signatures.filter(({ keyid }) => keyid === input.keyId);
    if (signatures.length !== 1) return fail('delivery-envelope-signer-mismatch');
    const signature = Buffer.from(signatures[0]!.sig, 'base64');
    if (!cryptoVerify(
      null,
      dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes),
      input.publicKey,
      signature,
    )) return fail('delivery-envelope-signature-invalid');
    return { ok: true };
  } catch {
    return fail('delivery-envelope-invalid');
  }
}

/**
 * Builds the settlement-grade solution verifier used by native-v1. Every decision is derived
 * from the exact persisted graph. In particular, executor authority is resolved again at the
 * Delivery's `createdAt`; the successful boot-time binding is never reused as settlement proof.
 */
export function buildNativeSolutionVerification(
  dependencies: NativeSolutionVerificationDependencies,
): NativeSolutionVerificationPort {
  return {
    async verify(input): Promise<VerificationDecision> {
      if (input.engagement.operatorAgent !== dependencies.identities.agent) {
        return fail('delivery-operator-mismatch');
      }
      if (input.effectiveTime !== input.delivery.createdAt) return fail('delivery-effective-time-mismatch');

      const task = parseCanonicalRecord({
        bytes: input.taskBytes,
        parse: (value) => TaskSpecificationSchema.safeParse(value),
        seal: sealTask,
      });
      if (task === undefined) return fail('task-invalid');
      const submission = parseCanonicalRecord({
        bytes: input.submissionBytes,
        parse: (value) => SubmissionRecordSchema.safeParse(value),
        seal: sealSubmission,
      });
      if (submission === undefined) return fail('submission-invalid');
      const delivery = parseCanonicalRecord({
        bytes: input.deliveryBytes,
        parse: (value) => DeliveryRecordSchema.safeParse(value),
        seal: sealDelivery,
      });
      if (delivery === undefined || !deliveryMatchesInput(delivery, input.delivery)) {
        return fail('delivery-invalid');
      }

      const taskDigest = documentDigest(input.taskBytes);
      const submissionDigest = documentDigest(input.submissionBytes);
      if (taskDigest !== input.engagement.taskDigest) return fail('task-digest-mismatch');
      if (submissionDigest !== input.engagement.submissionDigest) return fail('submission-digest-mismatch');
      if (submission.submission !== input.engagement.submissionUri) return fail('submission-uri-mismatch');
      if (descriptorDigest(submission.task) !== taskDigest) return fail('submission-task-mismatch');

      let dispatch: ReturnType<typeof DispatchContextSchema.parse>;
      try {
        dispatch = DispatchContextSchema.parse(parseJson(input.dispatchContextBytes));
        if (!bytesEqual(
          serializeCanonicalJson(dispatch as Parameters<typeof serializeCanonicalJson>[0]),
          input.dispatchContextBytes,
        )) return fail('dispatch-context-invalid');
      } catch {
        return fail('dispatch-context-invalid');
      }
      if (
        dispatch.taskDigest !== taskDigest
        || dispatch.submission !== submission.submission
        || dispatch.nonce !== submission.nonce
        || dispatch.attempt !== input.engagement.attemptUri
      ) return fail('dispatch-context-mismatch');

      if (delivery.task !== taskDigest || delivery.attempt !== input.engagement.attemptUri) {
        return fail('delivery-reference-mismatch');
      }
      if (input.effectiveTime !== delivery.createdAt) return fail('delivery-effective-time-mismatch');

      const artifactDecision = verifyArtifactGraph(input);
      if (!artifactDecision.ok) return artifactDecision;

      const evaluationDigest = task.evaluation === undefined
        ? undefined
        : descriptorDigest(task.evaluation);
      if (evaluationDigest === undefined) return fail('evaluation-spec-reference-missing');
      const evaluationSpecBytes = await dependencies.resolveEvaluationSpec(evaluationDigest);
      if (evaluationSpecBytes === undefined) return fail('evaluation-spec-unavailable');
      if (documentDigest(evaluationSpecBytes) !== evaluationDigest) {
        return fail('evaluation-spec-digest-mismatch');
      }

      const deliveryIdentity = dependencies.identities.get('solver-delivery');
      const envelopeDecision = verifyDeliveryEnvelope({
        bytes: input.deliveryEnvelopeBytes,
        deliveryBytes: input.deliveryBytes,
        keyId: deliveryIdentity.keyId,
        publicKey: deliveryIdentity.publicKey,
      });
      if (!envelopeDecision.ok) return envelopeDecision;

      const binding = await dependencies.identities.resolveEffective(
        'solver-delivery',
        delivery.createdAt,
      );
      if (!binding.ok) return fail(`delivery-binding-${binding.reason}`);
      return { ok: true };
    },
  };
}
