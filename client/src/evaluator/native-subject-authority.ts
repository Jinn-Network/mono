import {
  ADMISSION_RECEIPT_TRUST_SCOPE,
} from "@jinn-network/marketplace-binding";
import {
  DsseEnvelopeSchema,
  VERDICT_DSSE_PAYLOAD_TYPE,
  checkAdmissionReceipt,
} from "@jinn-network/task-execution-profiles";
import {
  DeliveryRecordSchema,
  SubmissionRecordSchema,
  TaskSpecificationSchema,
  documentDigest,
  serializeCanonicalJson,
} from "@jinn-network/task-execution-protocol";
import {
  authenticateRequester,
  parseDsseEnvelope,
  verifyEnvelopeBinding,
  type BindingResolver,
  type DsseChainVerifier,
  type PolicyCheckInput,
  type WitnessVerifier,
} from "@jinn-network/trust-core";
import type { NativeEvaluationAuthority } from "../daemon/native-evaluator-state.js";
import type { SubjectMaterial } from "./subject-material.js";

const SUBMISSION_DSSE_PAYLOAD_TYPE =
  "application/vnd.jinn.task-execution.submission.v1+json";
const DELIVERY_DSSE_PAYLOAD_TYPE =
  "application/vnd.jinn.task-execution.delivery.v1+json";
const ADMISSION_RECEIPT_ANNOTATION_URI =
  "https://jinn.network/annotations/admission-receipt/1.0";

export interface NativeSubjectAuthorityClaim {
  readonly requester: { readonly signerKey: string; readonly sealingTime: string };
  readonly admission: { readonly signerKey: string; readonly effectiveTime: string };
  readonly executor: {
    readonly signerKey: string;
    readonly agent: string;
    readonly declarationKey: string;
    readonly address: string;
  };
  readonly evaluator: {
    readonly signerKey: string;
    readonly agent: string;
    readonly declarationKey: string;
    readonly address: string;
  };
}

export interface NativeSubjectAuthorityDependencies {
  readonly bindingResolver: BindingResolver;
  readonly witnessVerifier: WitnessVerifier;
  readonly dsseVerifier: DsseChainVerifier;
  readonly requesterPolicy: PolicyCheckInput;
  readonly admissionAgentPolicy: PolicyCheckInput;
  readonly executorPolicy: PolicyCheckInput;
  /** B2 role authority: performs key/agent/scope/window/revocation policy at the requested time. */
  readonly evaluatorAuthority: {
    resolve(input: {
      readonly signerKey: string;
      readonly declarationKey: string;
      readonly agent: string;
      readonly address: string;
      readonly atTime: string;
    }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  };
}

export class NativeSubjectAuthorityError extends Error {
  override readonly name = "NativeSubjectAuthorityError";
  constructor(readonly reason: string, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
  }
}

function exactJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new NativeSubjectAuthorityError("invalid-exact-subject", `${label}: ${String(cause)}`);
  }
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

function annotationDigest(submission: ReturnType<typeof SubmissionRecordSchema.parse>): string | undefined {
  const annotation = submission.annotations?.[ADMISSION_RECEIPT_ANNOTATION_URI] as
    | { readonly digest?: { readonly sha256?: string } }
    | undefined;
  return annotation?.digest?.sha256 === undefined
    ? undefined
    : `sha256:${annotation.digest.sha256}`;
}

function requireEnvelopePayload(input: {
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly payloadType: string;
  readonly label: string;
}): void {
  let envelope;
  try {
    envelope = parseDsseEnvelope(input.envelopeBytes);
  } catch (cause) {
    throw new NativeSubjectAuthorityError(`${input.label}-envelope-invalid`, String(cause));
  }
  if (envelope.payloadType !== input.payloadType) {
    throw new NativeSubjectAuthorityError(`${input.label}-payload-type-mismatch`);
  }
  if (!equal(envelope.payloadBytes, input.payloadBytes)) {
    throw new NativeSubjectAuthorityError(`${input.label}-payload-mismatch`);
  }
}

/**
 * Authenticates the complete, exact solution subject before an evaluation claim can be emitted.
 * The returned proof contains only trusted host metadata and resolved identities; it is suitable
 * for immutable persistence beside the evaluation aggregate.
 */
export async function verifyNativeSubjectAuthority(input: {
  readonly material: SubjectMaterial;
  readonly claim: NativeSubjectAuthorityClaim;
  readonly dependencies: NativeSubjectAuthorityDependencies;
}): Promise<NativeEvaluationAuthority> {
  const { material, claim, dependencies } = input;
  const task = TaskSpecificationSchema.parse(exactJson(material.task.bytes, "Task"));
  const submission = SubmissionRecordSchema.parse(exactJson(material.submission.bytes, "Submission"));
  const delivery = DeliveryRecordSchema.parse(exactJson(material.delivery.bytes, "Delivery"));

  if (submission.task.digest?.sha256 === undefined
    || `sha256:${submission.task.digest.sha256}` !== material.task.digest) {
    throw new NativeSubjectAuthorityError("submission-task-mismatch");
  }
  if (delivery.task !== material.task.digest) {
    throw new NativeSubjectAuthorityError("delivery-task-mismatch");
  }
  if (annotationDigest(submission) !== material.admissionReceipt.digest) {
    throw new NativeSubjectAuthorityError("admission-receipt-digest-mismatch");
  }
  const resultDigests = new Set(material.results.map(({ digest }) => digest));
  if (delivery.outputs.length !== resultDigests.size
    || delivery.outputs.some(({ digest }) => digest?.sha256 === undefined
      || !resultDigests.has(`sha256:${digest.sha256}`))) {
    throw new NativeSubjectAuthorityError("delivery-result-graph-mismatch");
  }
  const evidenceDigests = new Set(material.evidenceRecords.map(({ digest }) => digest));
  if ((delivery.evidenceRecords?.length ?? 0) !== evidenceDigests.size
    || (delivery.evidenceRecords ?? []).some(({ digest }) => !evidenceDigests.has(digest as `sha256:${string}`))) {
    throw new NativeSubjectAuthorityError("delivery-evidence-graph-mismatch");
  }

  requireEnvelopePayload({
    envelopeBytes: material.requesterEnvelope.bytes,
    payloadBytes: material.submission.bytes,
    payloadType: SUBMISSION_DSSE_PAYLOAD_TYPE,
    label: "requester",
  });
  const requester = await authenticateRequester({
    envelopeBytes: material.requesterEnvelope.bytes,
    key: claim.requester.signerKey,
    requesterAgent: submission.requester,
    sealingTime: claim.requester.sealingTime,
  }, {
    bindingResolver: dependencies.bindingResolver,
    dsseVerifier: dependencies.dsseVerifier,
    policy: dependencies.requesterPolicy,
  });
  if (!requester.ok) {
    throw new NativeSubjectAuthorityError("requester-authentication-failed", requester.reason);
  }

  const receiptEnvelope = DsseEnvelopeSchema.parse(exactJson(material.admissionReceipt.bytes, "admission receipt"));
  if (receiptEnvelope.payloadType !== VERDICT_DSSE_PAYLOAD_TYPE) {
    throw new NativeSubjectAuthorityError("admission-receipt-payload-type-mismatch");
  }
  const receipt = checkAdmissionReceipt({
    envelope: receiptEnvelope,
    expectedTaskDigest: material.task.digest,
    expectedEvaluationSpecDigest: material.evaluationSpec.digest,
  });
  if (!receipt.ok) throw new NativeSubjectAuthorityError("admission-receipt-invalid", receipt.reason);
  const admission = await verifyEnvelopeBinding({
    envelopeBytes: material.admissionReceipt.bytes,
    key: claim.admission.signerKey,
    agent: receipt.issuer,
    family: ADMISSION_RECEIPT_TRUST_SCOPE,
    atTime: claim.admission.effectiveTime,
  }, {
    bindingResolver: dependencies.bindingResolver,
    witnessVerifier: dependencies.witnessVerifier,
    dsseVerifier: dependencies.dsseVerifier,
    policy: dependencies.admissionAgentPolicy,
  });
  if (!admission.ok) {
    throw new NativeSubjectAuthorityError("admission-binding-failed", admission.reason);
  }

  requireEnvelopePayload({
    envelopeBytes: material.deliveryEnvelope.bytes,
    payloadBytes: material.delivery.bytes,
    payloadType: DELIVERY_DSSE_PAYLOAD_TYPE,
    label: "executor",
  });
  const executor = await verifyEnvelopeBinding({
    envelopeBytes: material.deliveryEnvelope.bytes,
    key: claim.executor.signerKey,
    agent: claim.executor.agent,
    family: "deliveries",
    atTime: delivery.createdAt,
  }, {
    bindingResolver: dependencies.bindingResolver,
    witnessVerifier: dependencies.witnessVerifier,
    dsseVerifier: dependencies.dsseVerifier,
    policy: dependencies.executorPolicy,
  });
  if (!executor.ok) throw new NativeSubjectAuthorityError("executor-binding-failed", executor.reason);

  if (claim.executor.agent === claim.evaluator.agent
    || claim.executor.address.toLowerCase() === claim.evaluator.address.toLowerCase()) {
    throw new NativeSubjectAuthorityError("self-evaluation-refused");
  }
  const evaluatorBinding = await dependencies.evaluatorAuthority.resolve({
    ...claim.evaluator,
    atTime: claim.admission.effectiveTime,
  });
  if (!evaluatorBinding.ok) {
    throw new NativeSubjectAuthorityError("evaluator-binding-failed", evaluatorBinding.reason);
  }

  const proof = {
    subject: {
      task: material.task.digest,
      submission: material.submission.digest,
      requesterEnvelope: material.requesterEnvelope.digest,
      admissionReceipt: material.admissionReceipt.digest,
      delivery: material.delivery.digest,
      deliveryEnvelope: material.deliveryEnvelope.digest,
      evaluationSpec: material.evaluationSpec.digest,
      results: material.results.map(({ digest }) => digest),
      evidence: material.evidenceRecords.map(({ digest }) => digest),
    },
    requester: { key: claim.requester.signerKey, agent: submission.requester, at: claim.requester.sealingTime },
    admission: { key: claim.admission.signerKey, agent: receipt.issuer, at: claim.admission.effectiveTime },
    executor: { key: claim.executor.signerKey, agent: claim.executor.agent, at: delivery.createdAt },
    evaluator: { key: claim.evaluator.signerKey, agent: claim.evaluator.agent },
  };
  const verificationDigest = documentDigest(serializeCanonicalJson(
    proof as Parameters<typeof serializeCanonicalJson>[0],
  ));
  return {
    requester: claim.requester,
    admission: claim.admission,
    executor: { ...claim.executor, effectiveTime: delivery.createdAt },
    evaluator: claim.evaluator,
    verificationDigest,
  };
}
