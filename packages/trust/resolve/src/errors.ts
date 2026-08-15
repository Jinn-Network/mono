// SPDX-License-Identifier: Apache-2.0

export const TRUST_RESOLVE_ERROR_CODES = [
  "INVALID_INPUT",
  "RESOLUTION_FAILED",
] as const;

export type TrustResolveErrorCode = (typeof TRUST_RESOLVE_ERROR_CODES)[number];

export class TrustResolveError extends Error {
  override readonly name = "TrustResolveError";

  constructor(
    readonly code: TrustResolveErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function invalidInput(message: string, cause?: unknown): never {
  throw new TrustResolveError(
    "INVALID_INPUT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function resolutionFailed(message: string, cause?: unknown): never {
  throw new TrustResolveError(
    "RESOLUTION_FAILED",
    message,
    cause === undefined ? undefined : { cause },
  );
}
