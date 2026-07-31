// SPDX-License-Identifier: Apache-2.0

/**
 * Failure categories this package raises. Every one is a *derivation-side* fault; an
 * admission refusal is not an error — it is a first-class outcome (design §7.2) and
 * appears only in the run summary.
 */
export type DerivationErrorCategory =
  | "invalid-input"
  | "invalid-extension"
  | "environment-mismatch"
  | "gold-mismatch"
  | "pool-conflict";

export class DerivationError extends Error {
  constructor(
    readonly category: DerivationErrorCategory,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DerivationError";
  }
}
