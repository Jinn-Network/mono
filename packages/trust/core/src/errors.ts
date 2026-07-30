// SPDX-License-Identifier: Apache-2.0

export const TRUST_CORE_ERROR_CODES = [
  "INVALID_INPUT",
  "CONFORMANCE_FAILURE",
] as const;

export type TrustCoreErrorCode = (typeof TRUST_CORE_ERROR_CODES)[number];

export class TrustCoreError extends Error {
  override readonly name = "TrustCoreError";

  constructor(
    readonly code: TrustCoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function invalidInput(message: string, cause?: unknown): never {
  throw new TrustCoreError(
    "INVALID_INPUT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function conformanceFailure(message: string, cause?: unknown): never {
  throw new TrustCoreError(
    "CONFORMANCE_FAILURE",
    message,
    cause === undefined ? undefined : { cause },
  );
}
