import {
  bytesEqual,
  parseEvaluationSpec,
  sealEvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import {
  DeliveryRecordSchema,
  SubmissionRecordSchema,
  TaskSpecificationSchema,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import type { EvaluationOpportunity } from "./opportunities.js";

export interface FetchBytesByDigest {
  byCid(cid: string): Promise<Uint8Array>;
  byDigest(digest: `sha256:${string}`): Promise<Uint8Array>;
}

export interface SubjectMaterialReferences {
  /** The original exact requester Submission, anchored by the source association in later work. */
  readonly submission: { readonly digest: `sha256:${string}` };
  /** The executor-signed DSSE envelope that authenticates the exact Delivery record. */
  readonly deliveryEnvelope: { readonly digest: `sha256:${string}` };
  /** The requester-signed DSSE envelope that authenticates that Submission. */
  readonly requesterEnvelope: { readonly digest: `sha256:${string}` };
  /** The admission receipt envelope that authorized the Task/EvaluationSpec pair. */
  readonly admissionReceipt: { readonly digest: `sha256:${string}` };
}

export interface ExactSubjectArtifact {
  readonly name: string;
  readonly digest: `sha256:${string}`;
  readonly bytes: Uint8Array;
}

export interface SubjectMaterial {
  readonly task: ExactSubjectArtifact;
  readonly submission: ExactSubjectArtifact;
  readonly requesterEnvelope: ExactSubjectArtifact;
  readonly admissionReceipt: ExactSubjectArtifact;
  readonly delivery: ExactSubjectArtifact;
  readonly deliveryEnvelope: ExactSubjectArtifact;
  readonly evidenceRecords: readonly ExactSubjectArtifact[];
  readonly results: readonly ExactSubjectArtifact[];
  readonly evaluationSpec: ExactSubjectArtifact;
}

export class SubjectMaterialError extends Error {
  readonly kind: "unavailable" | "digest-mismatch" | "noncanonical" | "no-evaluation-spec";

  constructor(kind: SubjectMaterialError["kind"], message?: string) {
    super(message ?? kind);
    this.name = "SubjectMaterialError";
    this.kind = kind;
  }
}

function requireDigest(bytes: Uint8Array, expected: `sha256:${string}`): void {
  const actual = documentDigest(bytes);
  if (actual !== expected) {
    throw new SubjectMaterialError("digest-mismatch", `expected ${expected}, got ${actual}`);
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new SubjectMaterialError("unavailable", `${label} is not valid UTF-8 JSON: ${String(cause)}`);
  }
}

function descriptorSha256Digest(
  descriptor: { readonly digest?: Record<string, string> | undefined },
): `sha256:${string}` | undefined {
  const digest = descriptor.digest?.sha256;
  return typeof digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(`sha256:${digest}`)
    ? `sha256:${digest}`
    : undefined;
}

function requireSha256Digest(value: string, label: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new SubjectMaterialError("unavailable", `${label} has no lowercase sha256 digest`);
  }
  return value as `sha256:${string}`;
}

async function fetchByDigest(
  fetcher: FetchBytesByDigest,
  name: string,
  digest: `sha256:${string}`,
): Promise<ExactSubjectArtifact> {
  let bytes: Uint8Array;
  try {
    bytes = await fetcher.byDigest(digest);
  } catch (cause) {
    throw new SubjectMaterialError("unavailable", `failed to fetch ${name}: ${String(cause)}`);
  }
  requireDigest(bytes, digest);
  return { name, digest, bytes };
}

function exactTask(artifact: ExactSubjectArtifact) {
  const parsed = TaskSpecificationSchema.safeParse(parseJson(artifact.bytes, "subject Task"));
  if (!parsed.success) throw new SubjectMaterialError("unavailable", "subject Task failed schema validation");
  if (!bytesEqual(sealTask(parsed.data), artifact.bytes)) {
    throw new SubjectMaterialError("noncanonical", "subject Task bytes are not canonical");
  }
  return parsed.data;
}

function exactSubmission(artifact: ExactSubjectArtifact): void {
  const parsed = SubmissionRecordSchema.safeParse(parseJson(artifact.bytes, "subject Submission"));
  if (!parsed.success) throw new SubjectMaterialError("unavailable", "subject Submission failed schema validation");
  if (!bytesEqual(sealSubmission(parsed.data), artifact.bytes)) {
    throw new SubjectMaterialError("noncanonical", "subject Submission bytes are not canonical");
  }
}

function exactDelivery(artifact: ExactSubjectArtifact) {
  const parsed = DeliveryRecordSchema.safeParse(parseJson(artifact.bytes, "subject Delivery"));
  if (!parsed.success) throw new SubjectMaterialError("unavailable", "subject Delivery failed schema validation");
  if (!bytesEqual(sealDelivery(parsed.data), artifact.bytes)) {
    throw new SubjectMaterialError("noncanonical", "subject Delivery bytes are not canonical");
  }
  return parsed.data;
}

function exactEvaluationSpec(artifact: ExactSubjectArtifact): void {
  let parsed;
  try {
    parsed = parseEvaluationSpec(artifact.bytes);
  } catch (cause) {
    throw new SubjectMaterialError("unavailable", `EvaluationSpec failed schema validation: ${String(cause)}`);
  }
  if (!bytesEqual(sealEvaluationSpec(parsed).bytes, artifact.bytes)) {
    throw new SubjectMaterialError("noncanonical", "EvaluationSpec bytes are not canonical");
  }
}

/**
 * Retrieves the exact material an evaluator will later submit to the decision-grade gate. This
 * primitive is deliberately retrieval-only: it does not authenticate DSSE envelopes, resolve
 * trust, start a process, or settle a transaction.
 */
export async function acquireSubjectMaterial(
  opportunity: Pick<EvaluationOpportunity, "deliveryCid" | "advertisedDeliveryDigest">,
  references: SubjectMaterialReferences,
  fetcher: FetchBytesByDigest,
): Promise<SubjectMaterial> {
  let deliveryBytes: Uint8Array;
  try {
    deliveryBytes = await fetcher.byCid(opportunity.deliveryCid);
  } catch (cause) {
    throw new SubjectMaterialError("unavailable", `failed to fetch Delivery by CID: ${String(cause)}`);
  }
  // The digest originates in a canonical finalized observation. Never derive an expected digest
  // from the fetched bytes: that would make a tampered retrieval appear self-consistent.
  requireDigest(deliveryBytes, opportunity.advertisedDeliveryDigest);
  const delivery: ExactSubjectArtifact = {
    name: "delivery",
    digest: opportunity.advertisedDeliveryDigest,
    bytes: deliveryBytes,
  };
  const deliveryDocument = exactDelivery(delivery);

  const task = await fetchByDigest(
    fetcher,
    "task",
    requireSha256Digest(deliveryDocument.task, "Delivery task"),
  );
  const taskDocument = exactTask(task);
  const evaluationSpecDigest = descriptorSha256Digest(taskDocument.evaluation ?? {});
  if (evaluationSpecDigest === undefined) throw new SubjectMaterialError("no-evaluation-spec");
  const evaluationSpec = await fetchByDigest(fetcher, "evaluation-spec", evaluationSpecDigest);
  exactEvaluationSpec(evaluationSpec);

  const submission = await fetchByDigest(fetcher, "submission", references.submission.digest);
  exactSubmission(submission);
  const deliveryEnvelope = await fetchByDigest(
    fetcher,
    "delivery-envelope",
    references.deliveryEnvelope.digest,
  );
  const requesterEnvelope = await fetchByDigest(
    fetcher,
    "requester-envelope",
    references.requesterEnvelope.digest,
  );
  const admissionReceipt = await fetchByDigest(fetcher, "admission-receipt", references.admissionReceipt.digest);

  const evidenceRecords = await Promise.all((deliveryDocument.evidenceRecords ?? []).map((record, index) =>
    fetchByDigest(
      fetcher,
      `evidence:${record.family}:${index}`,
      requireSha256Digest(record.digest, `evidence:${record.family}:${index}`),
    ),
  ));
  const results = await Promise.all(deliveryDocument.outputs.map(async (output) => {
    const digest = descriptorSha256Digest(output);
    if (digest === undefined) {
      throw new SubjectMaterialError("unavailable", `output ${output.name} has no sha256 digest`);
    }
    return fetchByDigest(fetcher, output.name, digest);
  }));

  return {
    task,
    submission,
    requesterEnvelope,
    admissionReceipt,
    delivery,
    deliveryEnvelope,
    evidenceRecords,
    results,
    evaluationSpec,
  };
}
