// SPDX-License-Identifier: Apache-2.0

export type DerivationErrorCategory = "invalid-input";

export class DerivationError extends Error {
  constructor(readonly category: DerivationErrorCategory, message: string) {
    super(message);
    this.name = "DerivationError";
  }
}
