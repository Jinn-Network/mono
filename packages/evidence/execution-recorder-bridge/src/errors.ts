// SPDX-License-Identifier: Apache-2.0

import {
  EvidenceRepositoryError,
  type EvidenceRepositoryErrorCode,
} from "@jinn-network/evidence-repository";
import {
  ExecutionRecorderError,
  type ExecutionRecorderErrorCode,
} from "@jinn-network/execution-recorder";

import type { RecorderBridgeErrorPayload } from "./protocol.js";

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

// Sanitized, bridge-owned messages for every dependency error code. These are
// deliberately independent of the dependency's own `Error#message`, which may
// embed a local filesystem path (see the Recorder's `UNSAFE_PATH` messages).
// Standard output must never carry such a path back to the caller.
const RECORDER_ERROR_MESSAGES: Record<ExecutionRecorderErrorCode, string> = {
  INVALID_CAPTURE_INPUT: "Execution recorder rejected the capture input.",
  RECORDING_NOT_FOUND: "No execution recording exists at the workspace.",
  WORKSPACE_VERSION_UNSUPPORTED:
    "The execution recording workspace version is unsupported.",
  RECORDING_CONFLICT:
    "The execution recording state conflicts with the request.",
  WORKSPACE_CORRUPT: "The execution recording workspace is corrupt.",
  CAPTURED_OBJECT_CORRUPT: "A captured object in the workspace is corrupt.",
  UNSAFE_PATH: "An artifact source path failed a safety check.",
  RECORDING_FINALIZED: "The execution recording is already finalized.",
  OPERATION_ABORTED: "The execution recorder operation was aborted.",
  IO_FAILURE: "The execution recorder encountered an I/O failure.",
  PROTOCOL_CONFORMANCE_FAILED:
    "The execution record failed protocol conformance.",
};

const REPOSITORY_ERROR_MESSAGES: Record<EvidenceRepositoryErrorCode, string> = {
  INVALID_REFERENCE: "The Evidence Repository rejected an invalid reference.",
  CONTENT_CORRUPT: "The Evidence Repository detected corrupt content.",
  REFERENCE_CONFLICT: "The Evidence Repository detected a reference conflict.",
  DEPENDENCY_UNAVAILABLE: "The Evidence Repository dependency is unavailable.",
  ACCESS_DENIED: "The Evidence Repository denied access.",
  CONTENT_TOO_LARGE: "The Evidence Repository content exceeds its declared limit.",
  OPERATION_ABORTED: "The Evidence Repository operation was aborted.",
  IO_FAILURE: "The Evidence Repository encountered an I/O failure.",
};

function recorderErrorDetails(
  error: ExecutionRecorderError,
): Readonly<Record<string, unknown>> | undefined {
  const details: Record<string, unknown> = {};
  if (typeof error.details?.entityId === "string") {
    details.entityId = error.details.entityId;
  }
  if (error.details?.diagnostics !== undefined) {
    details.diagnostics = error.details.diagnostics;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * Converts any error thrown while dispatching a Recorder Bridge operation
 * into a wire-safe `RecorderBridgeErrorPayload`. Never forwards a `cause`,
 * a stack trace, request payloads, artifact bytes, repository credentials,
 * or a source path — those never leave this process.
 */
export function toRecorderBridgeErrorPayload(
  error: unknown,
): RecorderBridgeErrorPayload {
  if (error instanceof RecorderBridgeError) {
    return { domain: "bridge", code: error.code, message: error.message };
  }
  if (error instanceof ExecutionRecorderError) {
    const details = recorderErrorDetails(error);
    return {
      domain: "recorder",
      code: error.code,
      message: RECORDER_ERROR_MESSAGES[error.code],
      ...(details === undefined ? {} : { details }),
    };
  }
  if (error instanceof EvidenceRepositoryError) {
    return {
      domain: "repository",
      code: error.code,
      message: REPOSITORY_ERROR_MESSAGES[error.code],
    };
  }
  return {
    domain: "bridge",
    code: "INTERNAL_ERROR",
    message: "Recorder Bridge operation failed.",
  };
}
