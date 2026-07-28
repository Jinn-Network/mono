// SPDX-License-Identifier: Apache-2.0

export const RECORDER_BRIDGE_ERROR_CODES = [
  "PARSE_ERROR",
  "INVALID_REQUEST",
  "UNSUPPORTED_PROTOCOL",
  "METHOD_NOT_FOUND",
  "RECORDING_NOT_ATTACHED",
  "EXECUTION_ID_MISMATCH",
  "INTERNAL_ERROR",
] as const;

export type RecorderBridgeErrorCode =
  (typeof RECORDER_BRIDGE_ERROR_CODES)[number];

export class RecorderBridgeError extends Error {
  override readonly name = "RecorderBridgeError";

  constructor(
    readonly code: RecorderBridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}
