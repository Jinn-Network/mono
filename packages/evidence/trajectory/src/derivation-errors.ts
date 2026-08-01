// SPDX-License-Identifier: Apache-2.0

export class TrajectoryDerivationCancelledError extends Error {
  readonly category = "trajectory-derivation-cancelled" as const;
  constructor(message = "trajectory derivation verification was cancelled") {
    super(message);
    this.name = "TrajectoryDerivationCancelledError";
  }
}

export class TrajectoryDerivationSigningError extends Error {
  readonly category = "trajectory-derivation-signing-error" as const;
  constructor(message = "trajectory derivation signing failed") {
    super(message);
    this.name = "TrajectoryDerivationSigningError";
  }
}
