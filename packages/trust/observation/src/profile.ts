// SPDX-License-Identifier: Apache-2.0

/**
 * Receipt-container classes (headless re-derivation §7).
 *
 * Class O is the present discipline: unsigned versioned-Zod JSON, mode 0600,
 * atomic rename, never read by a gate.
 *
 * Class A is a target state: DSSE-sealed signed records using trust-core,
 * JCS-canonical bytes, documentDigest, and externally resolved facts. No
 * production writer ships in this package until a verifier exists.
 */
export const RECEIPT_CLASSES = ["observation", "authority"] as const;
export type ReceiptClass = (typeof RECEIPT_CLASSES)[number];

export const CLASS_O_PROFILE = {
  class: "observation",
  signed: false,
  defaultMode: 0o600,
  atomicRename: true,
  gateReadable: false,
} as const;

export const CLASS_A_PROFILE = {
  class: "authority",
  signed: true,
  sealed: true,
  resolvedExternally: true,
  gateReadable: true,
  presentDiscipline: false,
} as const;

export type ClassOProfile = typeof CLASS_O_PROFILE;
export type ClassAProfile = typeof CLASS_A_PROFILE;
