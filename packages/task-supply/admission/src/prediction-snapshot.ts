// SPDX-License-Identifier: Apache-2.0

import { PREDICTION_FORECAST_PROFILE_DIGEST } from "@jinn-network/task-execution-profiles";
import { canonicalJsonBytes, recordDigest, sealSignedRecord, type DsseSigner } from "@jinn-network/trust-core";
import { ADMISSION_RECEIPT_MEDIA_TYPE, IN_TOTO_STATEMENT_TYPE } from "./identifiers.js";
import { refuse } from "./refusals.js";

export const PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1 = {
  admissionPolicyVersion: "https://spec.jinn.network/task-admission/policy/prediction-snapshot/v1",
  predicateType: "https://spec.jinn.network/attestations/prediction-snapshot-admission/v1",
} as const;

// #2534 F3b: derived from the profile builder, never transcribed. This constant used to be the
// literal `sha256:e61dc765…`; re-sealing prediction-forecast/1.0 under `spec.jinn.network` moved
// the real digest and this copy stayed behind, so admission refused every conforming Task.
const PREDICTION_PROFILE_DIGEST = PREDICTION_FORECAST_PROFILE_DIGEST;
const DECIMAL_PROBABILITY = /^(0(?:\.\d+)?|1(?:\.0+)?)$/u;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const PREDICTION_PARSER_DIGEST = "sha256:fdf33b359e1d142a372b374abddab4e582fd4cbff5a32e53de9333a5515c2d1a";

const PREDICTION_EVALUATOR_FAMILY_BLOCK = {
  image: { name: "prediction-image", digest: { sha256: "c".repeat(64) }, accessClass: "public" },
  platform: "linux/amd64",
  workspace: {},
  testMaterial: [],
  parser: { id: "network.jinn.parser.prediction-market", version: "1.0.0", digest: PREDICTION_PARSER_DIGEST },
  transitions: { failToPass: ["prediction-valid"], passToPass: [] },
  timeout: 60,
};

const PREDICTION_MEASUREMENTS = [
  { name: "integrity", type: "boolean", required: true },
  { name: "resolved", type: "boolean", required: true },
  { name: "outcomeYes", type: "boolean", required: false },
  { name: "solverBrier", type: "string", direction: "lower-better", required: false },
  { name: "consensusBrier", type: "string", required: false },
  { name: "brierSpread", type: "string", direction: "lower-better", required: false },
];

const PREDICTION_VERDICT_RULE = {
  all: [
    { threshold: { measurement: "integrity", op: "eq", value: true } },
    { inconclusiveWhen: { threshold: { measurement: "resolved", op: "eq", value: false } }, class: "market-unresolved" },
  ],
};

function isExactlyCanonical(actual: unknown, expected: unknown): boolean {
  return Buffer.compare(Buffer.from(canonicalJsonBytes(actual)), Buffer.from(canonicalJsonBytes(expected))) === 0;
}

export interface PredictionSnapshotAdmissionReceiptV1 {
  readonly schemaVersion: "https://spec.jinn.network/records/prediction-snapshot-admission-receipt/v1";
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
  if (
    specification.protocol !== "https://spec.jinn.network/profiles/evaluation-spec/v1"
    || specification.semanticsVersion !== "4"
    || specification.family !== "deterministic-process"
    || Object.keys(specification).sort().join(",") !== "evidenceConventions,family,familyBlock,grader,measurements,protocol,semanticsVersion,unscorable,verdictRule"
  ) {
    return refuse("invalid-candidate", "prediction admission requires a deterministic-process EvaluationSpec");
  }
  const grader = specification.grader as Record<string, unknown> | undefined;
  const block = specification.familyBlock as Record<string, unknown> | undefined;
  if (
    grader === undefined
    || !isExactlyCanonical(grader, { name: "public-grader", digest: { sha256: "b".repeat(64) }, accessClass: "public" })
    || block === undefined
    || !isExactlyCanonical(block, PREDICTION_EVALUATOR_FAMILY_BLOCK)
    || !isExactlyCanonical(specification.measurements, PREDICTION_MEASUREMENTS)
    || !isExactlyCanonical(specification.verdictRule, PREDICTION_VERDICT_RULE)
    || !isExactlyCanonical(specification.unscorable, [{ name: "market-unresolved", disposition: "recorded-inconclusive" }])
    || !isExactlyCanonical(specification.evidenceConventions, { requiredRefs: [] })
  ) {
    return refuse("invalid-candidate", "prediction admission requires a compatible prediction evaluator");
  }
  return { digest: recordDigest(bytes) };
}

function forecastFromTask(task: Record<string, unknown>, evaluationSpecDigest: string): PredictionSnapshotAdmissionReceiptV1["forecast"] {
  const requiredTaskFields = ["evaluation", "instructions", "outputs", "payload", "profile", "protocol"];
  const taskFields = Object.keys(task);
  if (
    task.protocol !== "https://spec.jinn.network/profiles/task-execution/v1"
    || typeof task.instructions !== "string" || task.instructions.length === 0
    || !requiredTaskFields.every((field) => taskFields.includes(field))
    || taskFields.some((field) => !requiredTaskFields.includes(field) && field !== "author" && !/^[a-z][a-z0-9+.-]*:/iu.test(field))
    || (task.author !== undefined && (typeof task.author !== "string" || !/^[a-z][a-z0-9+.-]*:/iu.test(task.author)))
  ) {
    return refuse("invalid-candidate", "prediction Task does not satisfy the frozen native contract");
  }
  const profile = task.profile as { uri?: unknown; digest?: { sha256?: unknown } } | undefined;
  if (
    profile?.uri !== "https://spec.jinn.network/task-profiles/prediction-forecast/1.0"
    || profile.digest?.sha256 !== PREDICTION_PROFILE_DIGEST.slice("sha256:".length)
  ) {
    return refuse("invalid-candidate", "prediction Task does not name the sealed prediction-forecast/1.0 profile");
  }
  const evaluation = task.evaluation as { name?: unknown; digest?: { sha256?: unknown } } | undefined;
  if (evaluation?.name !== "evaluation-spec.json" || evaluation.digest?.sha256 !== evaluationSpecDigest.slice("sha256:".length)) {
    return refuse("invalid-candidate", "prediction Task must bind the exact supplied EvaluationSpec");
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
    || Buffer.compare(Buffer.from(canonicalJsonBytes((outputs[0] as Record<string, unknown>).schema)), Buffer.from(canonicalJsonBytes({
      type: "object", additionalProperties: false,
      properties: { probabilityYes: { type: "string", pattern: "^(0(\\.\\d+)?|1(\\.0+)?)$" }, submittedAt: { type: "string", format: "date-time" } },
      required: ["probabilityYes", "submittedAt"],
    }))) !== 0
  ) {
    return refuse("invalid-candidate", "prediction Task must declare exactly one prediction output");
  }
  const payload = task.payload;
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload)
    || Object.keys(payload).sort().join(",") !== "forecast"
  ) {
    return refuse("invalid-candidate", "prediction Task payload must have only forecast");
  }
  const forecast = (payload as { forecast?: unknown }).forecast;
  if (typeof forecast !== "object" || forecast === null || Array.isArray(forecast)) {
    return refuse("invalid-candidate", "prediction Task payload must carry forecast");
  }
  const value = forecast as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "consensusProbabilityYes,marketId,observedAt,question,resolvesAt") {
    return refuse("invalid-candidate", "prediction forecast must have closed payload properties");
  }
  const { marketId, question, consensusProbabilityYes, observedAt, resolvesAt } = value;
  if (
    typeof marketId !== "string" || marketId.length === 0 || typeof question !== "string" || question.length === 0
    || typeof consensusProbabilityYes !== "string" || !DECIMAL_PROBABILITY.test(consensusProbabilityYes)
    || typeof observedAt !== "string" || !RFC3339_UTC.test(observedAt) || Number.isNaN(Date.parse(observedAt))
    || typeof resolvesAt !== "string" || !RFC3339_UTC.test(resolvesAt) || Number.isNaN(Date.parse(resolvesAt))
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
    schemaVersion: "https://spec.jinn.network/records/prediction-snapshot-admission-receipt/v1",
    admissionPolicyVersion: PREDICTION_SNAPSHOT_ADMISSION_POLICY_V1.admissionPolicyVersion,
    issuer: input.issuer,
    task: {
      documentDigest: recordDigest(input.taskBytes),
      evaluationSpecDigest: specification.digest,
    },
    forecast: forecastFromTask(task, specification.digest),
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
