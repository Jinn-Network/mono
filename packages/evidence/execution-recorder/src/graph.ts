// SPDX-License-Identifier: Apache-2.0

import {
  buildExecutionEvidence as buildPureExecutionEvidence,
  ExecutionEvidenceBuilderError,
  type ExecutionEvidenceBuilderInput,
} from "@jinn-network/execution-evidence-builder";

import { ExecutionRecorderError } from "./errors.js";

export type ExecutionEvidenceMapperInput = ExecutionEvidenceBuilderInput;

/**
 * Compatibility wrapper for the recorder's internal mapper. New I/O-free
 * producers should import `@jinn-network/execution-evidence-builder` directly.
 */
export function buildExecutionEvidence(
  input: ExecutionEvidenceMapperInput,
): Uint8Array {
  try {
    return buildPureExecutionEvidence(input);
  } catch (error) {
    if (error instanceof ExecutionEvidenceBuilderError) {
      throw new ExecutionRecorderError(
        error.code,
        error.message,
        error.details,
        { cause: error },
      );
    }
    throw error;
  }
}
