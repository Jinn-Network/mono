// SPDX-License-Identifier: MIT

import { keccak256 } from "viem";

/**
 * Today-mode divergence (design §6.3): the deployed router requires the keccak evidence hash at
 * delivery-claim, computed binding-internally over the exact sealed Delivery bytes -- the same
 * bytes uploaded as the raw-codec CID (`venue/ipfs.ts`). This is a binding-internal digest, not
 * a stack seal (protocol/discovery own their own sealed-document digests); it dies with the
 * revision (§5.1: one sha256 scheme everywhere).
 */
export function keccakEvidenceHash(sealedBytes: Uint8Array): `0x${string}` {
  return keccak256(sealedBytes);
}

/** Thrown by `rejectZeroEvidenceHash` (survives verbatim from the mech adapter, §6.3). */
export class ZeroEvidenceHashError extends Error {
  constructor() {
    super("evidence hash is the all-zero hash -- refusing to claim delivery with a null digest");
    this.name = "ZeroEvidenceHashError";
  }
}

const ZERO_HASH = `0x${"0".repeat(64)}` as const;

/** The zero-evidence-hash guard (survives verbatim from the mech adapter, §6.3). */
export function rejectZeroEvidenceHash(hash: `0x${string}`): void {
  if (hash === ZERO_HASH) throw new ZeroEvidenceHashError();
}
