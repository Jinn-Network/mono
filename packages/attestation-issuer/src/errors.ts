// SPDX-License-Identifier: Apache-2.0

export const ATTESTATION_ISSUER_ERROR_CODES = [
  "INVALID_ISSUANCE_INPUT",
  "SIGNING_FAILED",
  "INVALID_SIGNER_OUTPUT",
  "PROTOCOL_CONFORMANCE_FAILED",
  "PREPARED_ATTESTATION_INVALID",
  "UNSUPPORTED_ATTESTATION_FAMILY",
  "OPERATION_ABORTED",
  "INTERNAL_FAILURE",
] as const;

export type AttestationIssuerErrorCode =
  (typeof ATTESTATION_ISSUER_ERROR_CODES)[number];

export class AttestationIssuerError extends Error {
  override readonly name = "AttestationIssuerError";

  constructor(
    readonly code: AttestationIssuerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function assertIssuerOperationActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AttestationIssuerError(
      "OPERATION_ABORTED",
      "The attestation issuer operation was aborted.",
      { cause: signal.reason },
    );
  }
}

export function invalidInput(message: string, cause?: unknown): never {
  throw new AttestationIssuerError(
    "INVALID_ISSUANCE_INPUT",
    message,
    cause === undefined ? undefined : { cause },
  );
}
