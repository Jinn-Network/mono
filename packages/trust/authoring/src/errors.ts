// SPDX-License-Identifier: Apache-2.0

/** Every authoring refusal that is not a custody-store fault (`IdentityStoreError`). */
export class TrustAuthoringError extends Error {
  override readonly name = "TrustAuthoringError";
}
