// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest } from "./digest.js";

export interface GoldRef {
  /** The digest an admission receipt records as `goldPatchHash` (design §7.1). */
  readonly goldPatchHash: Sha256Digest;
}

/**
 * Local-only storage for gold patches. These bytes are the answers to admitted tasks: they
 * are what admission needs to prove a suite resolves and discriminates, and they are the
 * one thing a solver must not receive. Nothing in this package writes them anywhere else,
 * and the supply pool has no field that could carry them.
 */
export interface GoldStore {
  put(goldPatch: Uint8Array): Promise<GoldRef>;
  get(goldPatchHash: string): Promise<Uint8Array | undefined>;
}
