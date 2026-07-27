// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import {
  EXECUTION_VERIFICATION_PREDICATE_TYPE,
  RESULT_EVALUATION_PREDICATE_TYPE,
  recordDigest,
  validateExecutionVerification,
  validateResultEvaluation,
  type ExecutionVerificationEvidence,
  type ResultEvaluationEvidence,
} from "@jinn-network/evidence-protocol";

import { cloneBytes, cloneJsonValue } from "./deterministic-json.js";
import { AttestationIssuerError } from "./errors.js";
import type {
  AnyPreparedAttestation,
  PreparedExecutionVerification,
  PreparedResultEvaluation,
} from "./types.js";

type Family = AnyPreparedAttestation["family"];

function decodeCanonicalStandardBase64(value: unknown, label: string): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new Error(`${label} is not padded standard base64.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error(`${label} is not canonical padded standard base64.`);
  }
  return new Uint8Array(bytes);
}

function exactStatement<TStatement>(payloadBytes: Uint8Array): TStatement {
  return cloneJsonValue(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes)),
  ) as TStatement;
}

function cloneResultValue(value: ResultEvaluationEvidence): ResultEvaluationEvidence {
  return {
    envelope: cloneJsonValue(value.envelope) as ResultEvaluationEvidence["envelope"],
    statement: exactStatement<ResultEvaluationEvidence["statement"]>(
      value.payloadBytes,
    ),
    payloadBytes: cloneBytes(value.payloadBytes),
  };
}

function cloneVerificationValue(
  value: ExecutionVerificationEvidence,
): ExecutionVerificationEvidence {
  return {
    envelope: cloneJsonValue(value.envelope) as ExecutionVerificationEvidence["envelope"],
    statement: exactStatement<ExecutionVerificationEvidence["statement"]>(
      value.payloadBytes,
    ),
    payloadBytes: cloneBytes(value.payloadBytes),
  };
}

function diagnosticMessage(
  diagnostics: readonly { code: string; path: string; message: string }[],
): string {
  return [...diagnostics]
    .sort((a, b) =>
      a.path.localeCompare(b.path) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message))
    .map(({ code, path, message }) => `${code} ${path || "/"}: ${message}`)
    .join("; ");
}

export function createPreparedAttestation(
  family: Family,
  envelopeBytes: Uint8Array,
  errorCode: "PREPARED_ATTESTATION_INVALID" | "PROTOCOL_CONFORMANCE_FAILED" =
    "PREPARED_ATTESTATION_INVALID",
): AnyPreparedAttestation {
  let exactBytes: Uint8Array;
  try {
    exactBytes = cloneBytes(envelopeBytes);
  } catch (cause) {
    throw new AttestationIssuerError(
      errorCode,
      "Attestation envelope bytes must be a readable Uint8Array.",
      { cause },
    );
  }
  if (family === "result-evaluation") {
    const report = validateResultEvaluation(exactBytes);
    if (!report.conforms || !report.value) {
      throw new AttestationIssuerError(
        errorCode,
        `Result Evaluation envelope does not conform: ${diagnosticMessage(report.diagnostics)}`,
      );
    }
    const value = cloneResultValue(report.value);
    return {
      family,
      recordDigest: report.recordDigest,
      envelopeBytes: cloneBytes(exactBytes),
      payloadBytes: cloneBytes(value.payloadBytes),
      value,
    } satisfies PreparedResultEvaluation;
  }
  const report = validateExecutionVerification(exactBytes);
  if (!report.conforms || !report.value) {
    throw new AttestationIssuerError(
      errorCode,
      `Execution Verification envelope does not conform: ${diagnosticMessage(report.diagnostics)}`,
    );
  }
  const value = cloneVerificationValue(report.value);
  return {
    family,
    recordDigest: report.recordDigest,
    envelopeBytes: cloneBytes(exactBytes),
    payloadBytes: cloneBytes(value.payloadBytes),
    value,
  } satisfies PreparedExecutionVerification;
}

function detectFamily(envelopeBytes: Uint8Array): Family {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(envelopeBytes);
    const envelope = JSON.parse(text) as unknown;
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      Array.isArray(envelope) ||
      typeof (envelope as { payload?: unknown }).payload !== "string" ||
      !Array.isArray((envelope as { signatures?: unknown }).signatures)
    ) {
      throw new Error("Envelope, payload, or signatures are malformed.");
    }
    const payload = (envelope as { payload: string }).payload;
    const signatures = (envelope as { signatures: unknown[] }).signatures;
    if (signatures.length === 0) {
      throw new Error("Envelope signatures are missing.");
    }
    for (const [index, signature] of signatures.entries()) {
      if (
        typeof signature !== "object" ||
        signature === null ||
        Array.isArray(signature)
      ) {
        throw new Error(`Envelope signature ${index} is malformed.`);
      }
      decodeCanonicalStandardBase64(
        (signature as { sig?: unknown }).sig,
        `Envelope signature ${index}`,
      );
    }
    const statement = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        decodeCanonicalStandardBase64(payload, "Envelope payload"),
      ),
    ) as unknown;
    if (typeof statement !== "object" || statement === null || Array.isArray(statement)) {
      throw new Error("Statement is malformed.");
    }
    const predicateType = (statement as { predicateType?: unknown }).predicateType;
    if (predicateType === RESULT_EVALUATION_PREDICATE_TYPE) return "result-evaluation";
    if (predicateType === EXECUTION_VERIFICATION_PREDICATE_TYPE) {
      return "execution-verification";
    }
    if (typeof predicateType === "string") {
      throw new AttestationIssuerError(
        "UNSUPPORTED_ATTESTATION_FAMILY",
        `Unsupported attestation predicate type: ${predicateType}`,
      );
    }
    throw new Error("Statement predicateType is missing.");
  } catch (cause) {
    if (cause instanceof AttestationIssuerError) throw cause;
    throw new AttestationIssuerError(
      "PREPARED_ATTESTATION_INVALID",
      "Prepared attestation bytes are not a readable DSSE Statement.",
      { cause },
    );
  }
}

export function parsePreparedAttestation(
  envelopeBytes: Uint8Array,
): AnyPreparedAttestation {
  if (!(envelopeBytes instanceof Uint8Array)) {
    throw new AttestationIssuerError(
      "PREPARED_ATTESTATION_INVALID",
      "Prepared envelope bytes must be a Uint8Array.",
    );
  }
  return createPreparedAttestation(detectFamily(envelopeBytes), envelopeBytes);
}

export function preparedDigest(envelopeBytes: Uint8Array): string {
  return recordDigest(envelopeBytes);
}
