// SPDX-License-Identifier: Apache-2.0

export const CHAIN_VERIFICATION_ERROR_CODES = [
  "INVALID_INPUT",
  "CONFORMANCE_FAILURE",
] as const;

export type ChainVerificationErrorCode = (typeof CHAIN_VERIFICATION_ERROR_CODES)[number];

export class ChainVerificationError extends Error {
  override readonly name = "ChainVerificationError";

  constructor(
    readonly code: ChainVerificationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Caller error: malformed input, or a profile rule the caller broke. */
export function invalidInput(message: string, cause?: unknown): never {
  throw new ChainVerificationError(
    "INVALID_INPUT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Port error: an injected dependency broke its documented contract. Never an environment
 * fact -- environment facts become attestations, not exceptions.
 */
export function conformanceFailure(message: string, cause?: unknown): never {
  throw new ChainVerificationError(
    "CONFORMANCE_FAILURE",
    message,
    cause === undefined ? undefined : { cause },
  );
}
