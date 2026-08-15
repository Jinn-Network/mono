// SPDX-License-Identifier: Apache-2.0

export const CHAIN_EXTRACTION_ERROR_CODES = [
  "INVALID_INPUT",
  "CONFORMANCE_FAILURE",
] as const;

export type ChainExtractionErrorCode = (typeof CHAIN_EXTRACTION_ERROR_CODES)[number];

export class ChainExtractionError extends Error {
  override readonly name = "ChainExtractionError";

  constructor(
    readonly code: ChainExtractionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Caller error: malformed input, or a bound the caller broke. */
export function invalidInput(message: string, cause?: unknown): never {
  throw new ChainExtractionError(
    "INVALID_INPUT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * An injected port broke its documented contract. Never an extraction fact --
 * extraction facts are returned as typed failures, not thrown.
 */
export function conformanceFailure(message: string, cause?: unknown): never {
  throw new ChainExtractionError(
    "CONFORMANCE_FAILURE",
    message,
    cause === undefined ? undefined : { cause },
  );
}
