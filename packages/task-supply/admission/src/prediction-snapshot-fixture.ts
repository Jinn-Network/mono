// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";
import { canonicalJsonBytes, dssePreAuthEncoding, parseSignedRecordEnvelope, recordDigest } from "@jinn-network/trust-core";
import { ADMISSION_RECEIPT_MEDIA_TYPE } from "./identifiers.js";
import { admitPredictionSnapshot } from "./prediction-snapshot.js";

const FIXTURE_ROOT = new URL("../fixtures/prediction-snapshot-v1/", import.meta.url);
const ARTIFACT_NAMES = ["task", "evaluationSpec", "admissionReceiptDsse", "submission", "requesterDsse"] as const;

type ArtifactName = (typeof ARTIFACT_NAMES)[number];
type Digest = `sha256:${string}`;

interface FixtureManifest {
  fixtureVersion: number;
  profile: string;
  operation: { id: string; relationship: string };
  artifacts: Record<ArtifactName, { path: string; digest: Digest }>;
  subjects: {
    taskDigest: Digest;
    evaluationSpecDigest: Digest;
    admissionReceiptDigest: Digest;
    submissionDigest: Digest;
    requesterDsseDigest: Digest;
  };
}

interface VerificationKey {
  keyid: string;
  algorithm: "Ed25519";
  publicKey: Record<string, string>;
}

/**
 * Reads the five B1 contract artifacts as exact, opaque bytes. Callers that make a
 * decision from the template must first run `verifyPredictionSnapshotFixture()`;
 * this loader intentionally does not parse and reserialize any of the records.
 */
export async function loadPredictionSnapshotFixture(): Promise<{
  readonly task: Uint8Array;
  readonly evaluationSpec: Uint8Array;
  readonly admissionReceiptDsse: Uint8Array;
  readonly submission: Uint8Array;
  readonly requesterDsse: Uint8Array;
}> {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", FIXTURE_ROOT), "utf8")) as FixtureManifest;
  const artifacts = await Promise.all(ARTIFACT_NAMES.map(async (name) => [
    name,
    new Uint8Array(await readFile(new URL(manifest.artifacts[name].path, FIXTURE_ROOT))),
  ] as const));
  return Object.fromEntries(artifacts) as Record<ArtifactName, Uint8Array>;
}

function exactCanonical(bytes: Uint8Array, label: string): Record<string, unknown> {
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${label} is not an object`);
  const canonical = canonicalJsonBytes(parsed);
  if (Buffer.compare(Buffer.from(canonical), Buffer.from(bytes)) !== 0) {
    throw new Error(`${label} is not its exact canonical protocol bytes`);
  }
  return parsed as Record<string, unknown>;
}

function digestSetValue(value: Digest): string {
  return value.slice("sha256:".length);
}

function verifyEnvelopeSignature(bytes: Uint8Array, key: VerificationKey, label: string): Record<string, unknown> {
  const envelope = parseSignedRecordEnvelope(bytes, ADMISSION_RECEIPT_MEDIA_TYPE);
  const signature = envelope.signatures.find((candidate) => candidate.keyid === key.keyid);
  if (signature === undefined) throw new Error(`${label} is not signed by the fixture key`);
  const ok = verify(null, Buffer.from(dssePreAuthEncoding(ADMISSION_RECEIPT_MEDIA_TYPE, envelope.payloadBytes)), createPublicKey({ key: key.publicKey as never, format: "jwk" }), Buffer.from(signature.sig, "base64"));
  if (!ok) throw new Error(`${label} DSSE PAE signature does not verify`);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.payloadBytes)) as Record<string, unknown>;
}

/** Verifies every fixture byte, digest, subject, and causal relationship offline. */
export async function verifyPredictionSnapshotFixture(): Promise<{
  profile: string;
  operationId: string;
  artifactDigests: Record<ArtifactName, Digest>;
}> {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", FIXTURE_ROOT), "utf8")) as FixtureManifest;
  if (manifest.fixtureVersion !== 1) throw new Error("unexpected prediction fixture version");
  const verificationKey = JSON.parse(await readFile(new URL("verification-key.json", FIXTURE_ROOT), "utf8")) as VerificationKey;
  const bytes = await loadPredictionSnapshotFixture();
  const artifactDigests = Object.fromEntries(ARTIFACT_NAMES.map((name) => [name, recordDigest(bytes[name])])) as Record<ArtifactName, Digest>;
  for (const name of ARTIFACT_NAMES) {
    if (artifactDigests[name] !== manifest.artifacts[name].digest) throw new Error(`${name} digest differs from manifest`);
  }

  const task = exactCanonical(bytes.task, "Task");
  exactCanonical(bytes.evaluationSpec, "EvaluationSpec");
  exactCanonical(bytes.submission, "Submission");
  const reproduced = admitPredictionSnapshot({
    taskBytes: bytes.task,
    evaluationSpecBytes: bytes.evaluationSpec,
    issuer: "did:jinn:admitter",
  });

  const receiptStatement = verifyEnvelopeSignature(bytes.admissionReceiptDsse, verificationKey, "admission receipt");
  const requesterStatement = verifyEnvelopeSignature(bytes.requesterDsse, verificationKey, "requester envelope");
  if (receiptStatement._type !== "https://in-toto.io/Statement/v1" || requesterStatement._type !== "https://in-toto.io/Statement/v1") {
    throw new Error("fixture DSSE payload is not an in-toto Statement/v1");
  }
  if (receiptStatement.predicateType !== "https://jinn.network/attestations/prediction-snapshot-admission/v1") {
    throw new Error("admission receipt predicate type is wrong");
  }
  const receiptPredicate = receiptStatement.predicate;
  if (Buffer.compare(Buffer.from(canonicalJsonBytes(receiptPredicate)), Buffer.from(canonicalJsonBytes(reproduced))) !== 0) {
    throw new Error("admission receipt predicate does not reproduce");
  }
  const taskDigest = artifactDigests.task;
  const evaluationSpecDigest = artifactDigests.evaluationSpec;
  const admissionReceiptDigest = artifactDigests.admissionReceiptDsse;
  const submissionDigest = artifactDigests.submission;
  const requesterDsseDigest = artifactDigests.requesterDsse;
  if (
    taskDigest !== manifest.subjects.taskDigest
    || evaluationSpecDigest !== manifest.subjects.evaluationSpecDigest
    || admissionReceiptDigest !== manifest.subjects.admissionReceiptDigest
    || submissionDigest !== manifest.subjects.submissionDigest
    || requesterDsseDigest !== manifest.subjects.requesterDsseDigest
  ) throw new Error("manifest subject digests do not equal exact artifact bytes");

  const taskProfile = task.profile as { uri?: unknown } | undefined;
  if (taskProfile?.uri !== manifest.profile) throw new Error("Task profile does not equal manifest profile");
  const taskEvaluation = (task.evaluation as { digest?: { sha256?: unknown } } | undefined)?.digest?.sha256;
  if (taskEvaluation !== digestSetValue(evaluationSpecDigest)) throw new Error("Task does not bind the exact EvaluationSpec");
  const submission = exactCanonical(bytes.submission, "Submission");
  if ((submission.task as { digest?: { sha256?: unknown } } | undefined)?.digest?.sha256 !== digestSetValue(taskDigest)) {
    throw new Error("Submission does not bind the exact Task");
  }
  const admissionAnnotation = (submission.annotations as Record<string, unknown> | undefined)?.["https://jinn.network/annotations/admission-receipt/1.0"] as { name?: unknown; mediaType?: unknown; digest?: { sha256?: unknown } } | undefined;
  if (admissionAnnotation?.name !== "admission-receipt" || admissionAnnotation.mediaType !== ADMISSION_RECEIPT_MEDIA_TYPE || admissionAnnotation.digest?.sha256 !== digestSetValue(admissionReceiptDigest)) {
    throw new Error("Submission does not bind the exact admission receipt envelope");
  }
  const receiptSubjects = receiptStatement.subject;
  if (Buffer.compare(Buffer.from(canonicalJsonBytes(receiptSubjects)), Buffer.from(canonicalJsonBytes([
    { name: "task", digest: { sha256: digestSetValue(taskDigest) } },
    { name: "evaluation-spec", digest: { sha256: digestSetValue(evaluationSpecDigest) } },
  ]))) !== 0) throw new Error("admission receipt subjects are not the exact Task/EvaluationSpec pair");
  const requesterSubject = requesterStatement.subject;
  if (Buffer.compare(Buffer.from(canonicalJsonBytes(requesterSubject)), Buffer.from(canonicalJsonBytes([
    { name: "submission", digest: { sha256: digestSetValue(submissionDigest) } },
  ]))) !== 0) throw new Error("requester envelope does not subject-bind the exact Submission");
  if (requesterStatement.predicateType !== "https://jinn.network/attestations/requester-submission/v1") throw new Error("requester envelope predicate type is wrong");
  const requesterPredicate = requesterStatement.predicate as Record<string, unknown> | undefined;
  if (
    requesterPredicate === undefined
    || requesterPredicate.requester !== submission.requester
    || requesterPredicate.taskDigest !== taskDigest
    || requesterPredicate.submissionDigest !== submissionDigest
    || requesterPredicate.admissionReceiptDigest !== admissionReceiptDigest
  ) throw new Error("requester envelope predicate does not bind the exact graph");
  const operationId = `native-prediction-forecast:${taskDigest.slice(7, 23)}:${submissionDigest.slice(7, 23)}`;
  if (manifest.operation.id !== operationId || manifest.operation.relationship !== "requester seals Task -> EvaluationSpec -> admission receipt DSSE -> Submission -> requester DSSE") {
    throw new Error("manifest operation identity or relationship is not derived from immutable material");
  }
  return { profile: manifest.profile, operationId: manifest.operation.id, artifactDigests };
}
