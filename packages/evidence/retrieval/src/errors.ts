import {
  EVIDENCE_RETRIEVAL_FAILURE_CODES,
  type EvidenceRetrievalFailure,
  type EvidenceRetrievalFailureCode,
} from "./contracts.js";

export type EvidenceRetrievalErrorCode =
  | "INVALID_INPUT"
  | "HOST_MISCONFIGURED";

export class EvidenceRetrievalError extends Error {
  readonly code: EvidenceRetrievalErrorCode;

  constructor(code: EvidenceRetrievalErrorCode, message: string) {
    super(message);
    this.name = "EvidenceRetrievalError";
    this.code = code;
  }
}

export function createEvidenceRetrievalFailure(
  input: Omit<EvidenceRetrievalFailure, "retryable"> & {
    readonly retryable?: boolean;
  },
): EvidenceRetrievalFailure {
  if (!EVIDENCE_RETRIEVAL_FAILURE_CODES.includes(input.code)) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `Unknown retrieval failure code: ${String(input.code)}`,
    );
  }
  return Object.freeze({ ...input, retryable: input.retryable ?? false });
}

export function isEvidenceRetrievalFailureCode(
  value: unknown,
): value is EvidenceRetrievalFailureCode {
  return typeof value === "string"
    && (EVIDENCE_RETRIEVAL_FAILURE_CODES as readonly string[]).includes(value);
}
