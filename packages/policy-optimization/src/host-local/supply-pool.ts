// SPDX-License-Identifier: MIT

import {
  canonicalJsonBytes,
  prefixedDigest,
  type JsonValue,
} from "@jinn-network/policy-identity";
import { checkAdmissionReceipt } from "@jinn-network/task-execution-profiles";
import { sealTask } from "@jinn-network/task-execution-protocol";
import {
  dssePreAuthEncoding,
  isCalendarStrictRfc3339,
  parseExactDsseEnvelope,
} from "@jinn-network/trust-core";
import { refuse } from "../errors.js";
import type { SplitPoolCandidate } from "../split-manifest.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

/** Structural mirror of task-derivation's pool boundary; no cross-tree runtime dependency. */
export interface LiveSupplyPoolSummary {
  readonly taskDigest: string;
  readonly evaluationSpecDigest: string;
  readonly receiptDigest: string;
  readonly environmentRecordDigest: string;
  readonly strategyId: string;
  readonly provenance: JsonValue;
  readonly rights: JsonValue;
}

export interface LiveSupplyPoolEntry extends LiveSupplyPoolSummary {
  readonly taskBytes: Uint8Array;
  readonly evaluationSpecBytes: Uint8Array;
}

export interface LiveSupplyPoolPort {
  list(): Promise<readonly LiveSupplyPoolSummary[]>;
  get(taskDigest: string): Promise<LiveSupplyPoolEntry | undefined>;
}

export interface AdmissionReceiptStorePort {
  get(receiptDigest: string): Promise<Uint8Array | undefined>;
}

export interface AdmissionReceiptSignatureVerifier {
  verify(input: {
    readonly issuer: string;
    readonly payloadType: string;
    readonly payloadBytes: Uint8Array;
    readonly preAuthEncoding: Uint8Array;
    readonly keyId: string;
    readonly signature: Uint8Array;
    readonly signatureIndex: number;
  }): boolean | Promise<boolean>;
}

export interface SupplyPoolAssessment {
  readonly id: string;
  readonly repository: string;
  readonly sourceLineage: readonly string[];
  readonly workIdentity: string;
  readonly tupleClass: string;
  readonly compatible: boolean;
  readonly previouslyAttempted: boolean;
  readonly contaminated: boolean;
  readonly scorable: boolean;
}

export interface SupplyPoolAssessmentPort {
  assess(input: {
    readonly entry: LiveSupplyPoolEntry;
    readonly receiptIssuer: string;
    /** Immutable value read from the sealed Task; it is never supplied by the host clock. */
    readonly provenanceTimestamp: string;
  }): SupplyPoolAssessment | Promise<SupplyPoolAssessment>;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function summaryBody(summary: LiveSupplyPoolSummary): JsonValue {
  return {
    taskDigest: summary.taskDigest,
    evaluationSpecDigest: summary.evaluationSpecDigest,
    receiptDigest: summary.receiptDigest,
    environmentRecordDigest: summary.environmentRecordDigest,
    strategyId: summary.strategyId,
    provenance: summary.provenance,
    rights: summary.rights,
  };
}

function exactJson(bytes: Uint8Array, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!sameBytes(canonicalJsonBytes(value as JsonValue), bytes)) throw new Error("not canonical");
  } catch {
    refuse("invalid-document", label, `${label} is not exact canonical UTF-8 JSON`);
  }
  return value;
}

function taskProvenanceTimestamp(taskBytes: Uint8Array): string {
  const task = exactJson(taskBytes, "supplyPool.task") as Record<string, unknown>;
  let resealed: Uint8Array;
  try { resealed = sealTask(task); }
  catch { refuse("invalid-document", "supplyPool.task", "sealed Task validation failed"); }
  if (!sameBytes(resealed, taskBytes)) {
    refuse("invalid-document", "supplyPool.task", "Task bytes are not the exact protocol encoding");
  }
  const payload = task["payload"];
  const provenance = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)["provenance"]
    : undefined;
  const timestamp = typeof provenance === "object" && provenance !== null && !Array.isArray(provenance)
    ? (provenance as Record<string, unknown>)["timestamp"]
    : undefined;
  if (!isCalendarStrictRfc3339(timestamp) || !timestamp.endsWith("Z")) {
    refuse(
      "invalid-document",
      "supplyPool.task.payload.provenance.timestamp",
      "an immutable, calendar-valid upstream UTC timestamp is required; host wall-clock substitution is forbidden",
    );
  }
  return timestamp;
}

async function verifyReceipt(input: {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly taskDigest: string;
  readonly evaluationSpecDigest: string;
  readonly verifier: AdmissionReceiptSignatureVerifier;
}): Promise<string> {
  if (!DIGEST.test(input.digest) || prefixedDigest(input.bytes) !== input.digest) {
    refuse("invalid-document", "supplyPool.receipt", "admission receipt digest does not address its exact bytes");
  }
  let envelope;
  try { envelope = parseExactDsseEnvelope(input.bytes); }
  catch { refuse("invalid-document", "supplyPool.receipt", "admission receipt is not an exact sealed DSSE envelope"); }
  const envelopeValue = exactJson(input.bytes, "supplyPool.receipt");
  const structural = checkAdmissionReceipt({
    envelope: envelopeValue,
    expectedTaskDigest: input.taskDigest,
    expectedEvaluationSpecDigest: input.evaluationSpecDigest,
  });
  if (!structural.ok) {
    refuse("invalid-document", "supplyPool.receipt", "admission receipt subjects or issuer are invalid");
  }
  exactJson(envelope.payloadBytes, "supplyPool.receipt.payload");
  const preAuthEncoding = dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes);
  const verified = await Promise.all(envelope.signatures.map(async (signature, signatureIndex) => {
    if (signature.keyid === undefined || signature.keyid.length === 0) return false;
    return input.verifier.verify({
      issuer: structural.issuer,
      payloadType: envelope.payloadType,
      payloadBytes: envelope.payloadBytes,
      preAuthEncoding,
      keyId: signature.keyid,
      signature: new Uint8Array(Buffer.from(signature.sig, "base64")),
      signatureIndex,
    });
  }));
  if (verified.length === 0 || !verified.every(Boolean)) {
    refuse("invalid-document", "supplyPool.receipt", "admission receipt signature is not trusted for its issuer");
  }
  return structural.issuer;
}

function malformedCandidate(summary: LiveSupplyPoolSummary, entry?: LiveSupplyPoolEntry): SplitPoolCandidate {
  const taskBytes = entry?.taskBytes ?? new Uint8Array();
  const evaluationSpecBytes = entry?.evaluationSpecBytes ?? new Uint8Array();
  const taskDigest = DIGEST.test(summary.taskDigest) ? summary.taskDigest : prefixedDigest(taskBytes);
  const evaluationSpecDigest = DIGEST.test(summary.evaluationSpecDigest)
    ? summary.evaluationSpecDigest
    : prefixedDigest(evaluationSpecBytes);
  const receiptDigest = DIGEST.test(summary.receiptDigest)
    ? summary.receiptDigest
    : prefixedDigest(new Uint8Array());
  const identity = summary.taskDigest.length === 0 ? taskDigest : summary.taskDigest;
  return {
    id: identity,
    task: { bytes: taskBytes, digest: taskDigest },
    evaluationSpec: {
      bytes: evaluationSpecBytes,
      digest: evaluationSpecDigest,
    },
    admission: {
      receiptBytes: new Uint8Array(),
      receiptDigest,
      verified: false,
      positive: false,
      taskDigest,
      evaluationSpecDigest,
    },
    repository: `malformed/${identity}`,
    sourceLineage: [identity],
    workIdentity: identity,
    tupleClass: "malformed",
    compatible: false,
    previouslyAttempted: false,
    contaminated: false,
    scorable: false,
  };
}

/**
 * Materializes the selected pool listing into split candidates. List/get ambiguity is a coherent
 * snapshot failure; malformed individual work is retained as a deterministic exclusion.
 */
export async function readVerifiedSupplyPool(input: {
  readonly pool: LiveSupplyPoolPort;
  readonly receipts: AdmissionReceiptStorePort;
  readonly receiptVerifier: AdmissionReceiptSignatureVerifier;
  readonly assessment: SupplyPoolAssessmentPort;
}): Promise<readonly SplitPoolCandidate[]> {
  const summaries = [...await input.pool.list()].sort((left, right) =>
    left.taskDigest < right.taskDigest ? -1 : left.taskDigest > right.taskDigest ? 1 : 0);
  if (new Set(summaries.map((summary) => summary.taskDigest)).size !== summaries.length) {
    refuse("invalid-document", "supplyPool", "the selected pool listing is ambiguous");
  }
  const candidates: SplitPoolCandidate[] = [];
  for (const summary of summaries) {
    if (!DIGEST.test(summary.taskDigest) || !DIGEST.test(summary.evaluationSpecDigest)
      || !DIGEST.test(summary.receiptDigest)) {
      candidates.push(malformedCandidate(summary));
      continue;
    }
    const entry = await input.pool.get(summary.taskDigest);
    if (entry === undefined) {
      candidates.push(malformedCandidate(summary));
      continue;
    }
    let listed: Uint8Array;
    let stored: Uint8Array;
    try {
      listed = canonicalJsonBytes(summaryBody(summary));
      stored = canonicalJsonBytes(summaryBody(entry));
    } catch {
      refuse("invalid-document", "supplyPool", "the selected pool contains non-I-JSON metadata");
    }
    if (!sameBytes(listed, stored)) {
      refuse("invalid-document", "supplyPool", "the selected pool changed between list and get");
    }
    try {
      if (prefixedDigest(entry.taskBytes) !== entry.taskDigest
        || prefixedDigest(entry.evaluationSpecBytes) !== entry.evaluationSpecDigest) {
        throw new Error("digest mismatch");
      }
      const receiptBytes = await input.receipts.get(entry.receiptDigest);
      if (receiptBytes === undefined) throw new Error("missing receipt");
      const timestamp = taskProvenanceTimestamp(entry.taskBytes);
      const issuer = await verifyReceipt({
        bytes: receiptBytes,
        digest: entry.receiptDigest,
        taskDigest: entry.taskDigest,
        evaluationSpecDigest: entry.evaluationSpecDigest,
        verifier: input.receiptVerifier,
      });
      const assessment = await input.assessment.assess({
        entry,
        receiptIssuer: issuer,
        provenanceTimestamp: timestamp,
      });
      candidates.push({
        ...assessment,
        task: { bytes: entry.taskBytes, digest: entry.taskDigest },
        evaluationSpec: { bytes: entry.evaluationSpecBytes, digest: entry.evaluationSpecDigest },
        admission: {
          receiptBytes,
          receiptDigest: entry.receiptDigest,
          verified: true,
          positive: true,
          taskDigest: entry.taskDigest,
          evaluationSpecDigest: entry.evaluationSpecDigest,
        },
      });
    } catch {
      candidates.push(malformedCandidate(summary, entry));
    }
  }
  return candidates;
}
