// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, recordDigest, sealSignedRecord, type DsseSigner } from "@jinn-network/trust-core";
import { ADMISSION_RECEIPT_MEDIA_TYPE, IN_TOTO_STATEMENT_TYPE } from "./identifiers.js";
import { refuse } from "./refusals.js";

export const PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1 = {
  admissionPolicyVersion: "https://jinn.network/task-admission/policy/prediction-snapshot/1",
  predicateType: "https://jinn.network/attestations/prediction-snapshot-admission/v1",
} as const;

const PREDICTION_PROFILE_DIGEST = "sha256:e61dc765d1a93b71639cb566d6bd3ca1335cfd53cb415e904ff840670d212937";
const DECIMAL_PROBABILITY = /^(0(?:\.\d+)?|1(?:\.0+)?)$/u;

export interface PredictionSnapshotAdmissionReceiptV1 {
  readonly schemaVersion: "https://jinn.network/records/prediction-snapshot-admission-receipt/1";
  readonly admissionPolicyVersion: typeof PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1.admissionPolicyVersion;
  readonly issuer: string;
  readonly task: {
    readonly documentDigest: `sha256:${string}`;
    readonly evaluationSpecDigest: `sha256:${string}`;
  };
  readonly forecast: {
    readonly marketId: string;
    readonly consensusProbabilityYes: string;
    readonly observedAt: string;
    readonly resolvesAt: string;
  };
}

export interface PredictionSnapshotAdmissionInput {
  readonly taskBytes: Uint8Array;
  readonly evaluationSpecBytes: Uint8Array;
  readonly issuer: string;
}

export interface SealedPredictionSnapshotAdmissionReceipt {
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly receiptDigest: `sha256:${string}`;
}

function parseExactDocument(bytes: Uint8Array, label: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    return refuse("invalid-candidate", `${label} bytes are not UTF-8 JSON: ${String(cause)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return refuse("invalid-candidate", `${label} is not an object`);
  const canonical = canonicalJsonBytes(raw);
  if (Buffer.compare(Buffer.from(canonical), Buffer.from(bytes)) !== 0) {
    return refuse("invalid-candidate", `${label} bytes are not canonical JSON bytes`);
  }
  return raw as Record<string, unknown>;
}

function exactEvaluationSpec(bytes: Uint8Array): { digest: `sha256:${string}` } {
  const specification = parseExactDocument(bytes, "prediction EvaluationSpec");
  if (specification.protocol !== "https://jinn.network/profiles/evaluation-spec/1.0" || specification.family !== "deterministic-process") {
    return refuse("invalid-candidate", "prediction admission requires a deterministic-process EvaluationSpec");
  }
  const grader = specification.grader;
  if (typeof grader !== "object" || grader === null || Array.isArray(grader) || (grader as Record<string, unknown>).access === "private") {
    return refuse("invalid-candidate", "prediction admission requires a public single-grader EvaluationSpec");
  }
  return { digest: recordDigest(bytes) };
}

function forecastFromTask(task: Record<string, unknown>): PredictionSnapshotAdmissionReceiptV1["forecast"] {
  const profile = task.profile as { uri?: unknown; digest?: { sha256?: unknown } } | undefined;
  if (
    profile?.uri !== "https://jinn.network/task-profiles/prediction-forecast/1.0"
    || profile.digest?.sha256 !== PREDICTION_PROFILE_DIGEST.slice("sha256:".length)
  ) {
    return refuse("invalid-candidate", "prediction Task does not name the sealed prediction-forecast/1.0 profile");
  }
  const outputs = task.outputs;
  if (
    !Array.isArray(outputs)
    || outputs.length !== 1
    || typeof outputs[0] !== "object"
    || outputs[0] === null
    || (outputs[0] as Record<string, unknown>).name !== "prediction"
    || (outputs[0] as Record<string, unknown>).mediaType !== "application/json"
    || (outputs[0] as Record<string, unknown>).required !== true
  ) {
    return refuse("invalid-candidate", "prediction Task must declare exactly one prediction output");
  }
  const payload = task.payload;
  const forecast = typeof payload === "object" && payload !== null
    ? (payload as { forecast?: unknown }).forecast
    : undefined;
  if (typeof forecast !== "object" || forecast === null || Array.isArray(forecast)) {
    return refuse("invalid-candidate", "prediction Task payload must carry forecast");
  }
  const value = forecast as Record<string, unknown>;
  const { marketId, consensusProbabilityYes, observedAt, resolvesAt } = value;
  if (
    typeof marketId !== "string" || marketId.length === 0
    || typeof consensusProbabilityYes !== "string" || !DECIMAL_PROBABILITY.test(consensusProbabilityYes)
    || typeof observedAt !== "string" || Number.isNaN(Date.parse(observedAt))
    || typeof resolvesAt !== "string" || Number.isNaN(Date.parse(resolvesAt))
    || Date.parse(resolvesAt) <= Date.parse(observedAt)
  ) {
    return refuse("invalid-candidate", "prediction forecast has invalid market identity, consensusProbabilityYes, or time bounds");
  }
  return { marketId, consensusProbabilityYes, observedAt, resolvesAt };
}

/**
 * Deterministically admits one exact public prediction snapshot pair. This is intentionally a
 * pure pre-runtime policy: no chain, database, wall clock, or evaluator invocation participates.
 */
export function admitPredictionSnapshot(input: PredictionSnapshotAdmissionInput): PredictionSnapshotAdmissionReceiptV1 {
  if (input.issuer.length === 0) return refuse("invalid-candidate", "prediction admission issuer is required");
  const task = parseExactDocument(input.taskBytes, "prediction Task");
  const specification = exactEvaluationSpec(input.evaluationSpecBytes);
  return {
    schemaVersion: "https://jinn.network/records/prediction-snapshot-admission-receipt/1",
    admissionPolicyVersion: PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1.admissionPolicyVersion,
    issuer: input.issuer,
    task: {
      documentDigest: recordDigest(input.taskBytes),
      evaluationSpecDigest: specification.digest,
    },
    forecast: forecastFromTask(task),
  };
}

/** Same DSSE/in-toto envelope shape as all existing admission receipts; only the predicate differs. */
export async function sealPredictionSnapshotAdmissionReceipt(
  receipt: PredictionSnapshotAdmissionReceiptV1,
  signer: DsseSigner,
): Promise<SealedPredictionSnapshotAdmissionReceipt> {
  const sealed = await sealSignedRecord({
    payloadType: ADMISSION_RECEIPT_MEDIA_TYPE,
    signer,
    record: {
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [
        { name: "task", digest: { sha256: receipt.task.documentDigest.slice("sha256:".length) } },
        { name: "evaluation-spec", digest: { sha256: receipt.task.evaluationSpecDigest.slice("sha256:".length) } },
      ],
      predicateType: PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1.predicateType,
      predicate: receipt,
    },
  });
  return { envelopeBytes: sealed.envelopeBytes, payloadBytes: sealed.payloadBytes, receiptDigest: sealed.recordDigest };
}
