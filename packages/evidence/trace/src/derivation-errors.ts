// SPDX-License-Identifier: Apache-2.0

export class TraceDerivationCancelledError extends Error {
  readonly category = "trace-derivation-cancelled" as const;
  constructor(message = "trace derivation verification was cancelled") {
    super(message);
    this.name = "TraceDerivationCancelledError";
  }
}

export class TraceDerivationSigningError extends Error {
  readonly category = "trace-derivation-signing-error" as const;
  constructor(message = "trace derivation signing failed") {
    super(message);
    this.name = "TraceDerivationSigningError";
  }
}
