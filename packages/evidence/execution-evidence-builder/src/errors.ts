// SPDX-License-Identifier: Apache-2.0

import type { ConformanceDiagnostic } from "@jinn-network/evidence-protocol";

export const EXECUTION_EVIDENCE_BUILDER_ERROR_CODES = [
  "RECORDING_CONFLICT",
  "PROTOCOL_CONFORMANCE_FAILED",
] as const;

export type ExecutionEvidenceBuilderErrorCode =
  (typeof EXECUTION_EVIDENCE_BUILDER_ERROR_CODES)[number];

export interface ExecutionEvidenceBuilderErrorDetails {
  readonly entityId?: string;
  readonly diagnostics?: readonly ConformanceDiagnostic[];
}

export class ExecutionEvidenceBuilderError extends Error {
  override readonly name = "ExecutionEvidenceBuilderError";

  constructor(
    readonly code: ExecutionEvidenceBuilderErrorCode,
    message: string,
    readonly details?: ExecutionEvidenceBuilderErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
