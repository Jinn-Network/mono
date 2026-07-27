// SPDX-License-Identifier: MIT
import type { LocalRuntimeOperationOptions } from "./types.js";

export const LOCAL_EVIDENCE_RUNTIME_ERROR_CODES = [
  "ROOT_IN_USE",
  "ROOT_VERSION_UNSUPPORTED",
  "RUNTIME_CORRUPT",
  "UNSAFE_PATH",
  "RUNTIME_CLOSING",
  "RUNTIME_CLOSED",
  "INVALID_QUERY",
  "OPERATION_ABORTED",
  "SYNCHRONIZATION_UNAVAILABLE",
  "IO_FAILURE",
] as const;

export type LocalEvidenceRuntimeErrorCode =
  (typeof LOCAL_EVIDENCE_RUNTIME_ERROR_CODES)[number];

export class LocalEvidenceRuntimeError extends Error {
  override readonly name = "LocalEvidenceRuntimeError";

  constructor(
    readonly code: LocalEvidenceRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function isLocalEvidenceRuntimeError(
  error: unknown,
): error is LocalEvidenceRuntimeError {
  return error instanceof LocalEvidenceRuntimeError;
}

export function assertLocalRuntimeOperationActive(
  options?: LocalRuntimeOperationOptions,
): void {
  if (options?.signal?.aborted) {
    throw new LocalEvidenceRuntimeError(
      "OPERATION_ABORTED",
      "The local evidence runtime operation was aborted.",
    );
  }
}

export function localRuntimeIoError(
  error: unknown,
  message: string,
): LocalEvidenceRuntimeError {
  if (error instanceof LocalEvidenceRuntimeError) return error;
  return new LocalEvidenceRuntimeError("IO_FAILURE", message, { cause: error });
}
