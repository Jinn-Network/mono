// SPDX-License-Identifier: Apache-2.0

import type { ExecutionRecorderErrorDetails } from "./types.js";

export const EXECUTION_RECORDER_ERROR_CODES = [
  "INVALID_CAPTURE_INPUT",
  "RECORDING_NOT_FOUND",
  "WORKSPACE_VERSION_UNSUPPORTED",
  "RECORDING_CONFLICT",
  "WORKSPACE_CORRUPT",
  "CAPTURED_OBJECT_CORRUPT",
  "UNSAFE_PATH",
  "RECORDING_FINALIZED",
  "OPERATION_ABORTED",
  "IO_FAILURE",
  "PROTOCOL_CONFORMANCE_FAILED",
] as const;

export type ExecutionRecorderErrorCode =
  (typeof EXECUTION_RECORDER_ERROR_CODES)[number];

export class ExecutionRecorderError extends Error {
  override readonly name = "ExecutionRecorderError";

  constructor(
    readonly code: ExecutionRecorderErrorCode,
    message: string,
    readonly details?: ExecutionRecorderErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function invalidCaptureInput(
  message: string,
  entityId?: string,
): never {
  throw new ExecutionRecorderError(
    "INVALID_CAPTURE_INPUT",
    message,
    entityId === undefined ? undefined : { entityId },
  );
}

export function assertRecorderOperationActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ExecutionRecorderError(
      "OPERATION_ABORTED",
      "Execution recorder operation was aborted.",
      undefined,
      { cause: signal.reason },
    );
  }
}
