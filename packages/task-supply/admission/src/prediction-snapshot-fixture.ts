// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { canonicalJsonBytes, parseSignedRecordEnvelope, recordDigest } from "@jinn-network/trust-core";
import { ADMISSION_RECEIPT_MEDIA_TYPE } from "./identifiers.js";
import { admitPredictionSnapshot } from "./prediction-snapshot.js";

const FIXTURE_ROOT = new URL("../fixtures/prediction-snapshot-v1/", import.meta.url);
const ARTIFACT_NAMES = ["task", "evaluationSpec", "admissionReceiptDsse", "submission", "requesterDsse"] as const;

type ArtifactName = (typeof ARTIFACT_NAMES)[number];
type Digest = `sha256:${string}`;

interface FixtureManifest {
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

function statementFromEnvelope(bytes: Uint8Array, label: string): Record<string, unknown> {
  const envelope = parseSignedRecordEnvelope(bytes, ADMISSION_RECEIPT_MEDIA_TYPE);
  const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelope.payloadBytes));
  if (typeof record !== "object" || record === null || Array.isArray(record)) throw new Error(`${label} payload is not a statement object`);
  return record as Record<string, unknown>;
}

/** Verifies every fixture byte, digest, subject, and causal relationship offline. */
export async function verifyPredictionSnapshotFixture(): Promise<{
  profile: string;
  operationId: string;
  artifactDigests: Record<ArtifactName, Digest>;
}> {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", FIXTURE_ROOT), "utf8")) as FixtureManifest;
  const artifacts = await Promise.all(ARTIFACT_NAMES.map(async (name) => [
    name,
    new Uint8Array(await readFile(new URL(manifest.artifacts[name].path, FIXTURE_ROOT))),
  ] as const));
  const bytes = Object.fromEntries(artifacts) as Record<ArtifactName, Uint8Array>;
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

  const receiptStatement = statementFromEnvelope(bytes.admissionReceiptDsse, "admission receipt");
  const requesterStatement = statementFromEnvelope(bytes.requesterDsse, "requester envelope");
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
  const receiptSubjects = receiptStatement.subject;
  if (Buffer.compare(Buffer.from(canonicalJsonBytes(receiptSubjects)), Buffer.from(canonicalJsonBytes([
    { name: "task", digest: { sha256: digestSetValue(taskDigest) } },
    { name: "evaluation-spec", digest: { sha256: digestSetValue(evaluationSpecDigest) } },
  ]))) !== 0) throw new Error("admission receipt subjects are not the exact Task/EvaluationSpec pair");
  const requesterSubject = requesterStatement.subject;
  if (Buffer.compare(Buffer.from(canonicalJsonBytes(requesterSubject)), Buffer.from(canonicalJsonBytes([
    { name: "submission", digest: { sha256: digestSetValue(submissionDigest) } },
  ]))) !== 0) throw new Error("requester envelope does not subject-bind the exact Submission");
  return { profile: manifest.profile, operationId: manifest.operation.id, artifactDigests };
}
