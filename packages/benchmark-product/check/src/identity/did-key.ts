// SPDX-License-Identifier: Apache-2.0

/**
 * The Ed25519 public key inside a `did:key:z…` identifier (issue #2983). The decoders are
 * `@jinn-network/verify`'s, and the fingerprint a reader falls back to is this package's.
 */

import { createHash } from "node:crypto";
import { ed25519PublicKeyBytesFromDidKey, ed25519PublicKeyFromDidKey } from "@jinn-network/verify";

export { ed25519PublicKeyBytesFromDidKey, ed25519PublicKeyFromDidKey };

/**
 * `sha256:<64 hex>` over the raw public-key bytes — the bare fingerprint a reader falls back to
 * when no domain is bound. It digests the KEY, not the identifier that spells it, so it is the same
 * value for the same key in every bundle format this reader understands.
 */
export function keyFingerprintFromDidKey(keyId: string): string | undefined {
  const raw = ed25519PublicKeyBytesFromDidKey(keyId);
  if (raw === undefined) return undefined;
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}
