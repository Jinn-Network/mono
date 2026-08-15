// SPDX-License-Identifier: Apache-2.0

import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { toChecksumAddress } from "@jinn-network/trust-core";

// ---------------------------------------------------------------------------
// A deterministic, REAL secp256k1/EIP-191 test signer -- the EOA ceremony
// leg of `verify.ts` (`verifyEoaCeremony`, T8/T9) independently recovers
// the signer from raw signature bytes, so the kit's EOA fixtures need
// genuine, verifiable signatures, not fakes. This is the only ceremony
// type the kit signs for real: Safe/agentId/OIDC/GitHub-human ceremonies
// are the resolver's job (`trust-resolve`'s `witness.ts`/`binding-
// resolver.ts`), and `verify.ts`'s own ceremony leg trusts a non-null
// `ResolvedBinding` for those types without re-verifying (see
// `verifyCeremonyLeg` in trust-core's `verify.ts`) -- so the kit's fake
// `BindingResolver` can mark them resolved without any signature at all.
// ---------------------------------------------------------------------------

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** EIP-191 `personal_sign` digest -- mirrors trust-core's own
 * (unexported) `personalSignDigest` in `ceremony.ts`. */
function personalSignDigest(messageBytes: Uint8Array): Uint8Array {
  const prefix = ascii(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  return keccak_256(concatenate([prefix, messageBytes]));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface EoaTestSigner {
  readonly address: `0x${string}`;
  /** Signs `messageBytes` with EIP-191 `personal_sign`, returning the
   * 65-byte `r || s || v` wire format `recoverEip191Address` expects. */
  sign(messageBytes: Uint8Array): Uint8Array;
}

/**
 * Derives a deterministic secp256k1 keypair from `seed` (SHA-256 of the
 * seed string as the private key -- reproducible across test runs, never
 * used outside this kit). Returns the EIP-55 checksummed address and a
 * signer producing genuine, `recoverEip191Address`-verifiable signatures.
 */
export function createEoaTestSigner(seed: string): EoaTestSigner {
  const privateKey = sha256(new TextEncoder().encode(seed));
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const addressBytes = keccak_256(publicKey.slice(1)).slice(-20);
  const address = toChecksumAddress(`0x${bytesToHex(addressBytes)}`);

  return {
    address,
    sign(messageBytes: Uint8Array): Uint8Array {
      const digest = personalSignDigest(messageBytes);
      const recovered = secp256k1.sign(digest, privateKey, { format: "recovered", prehash: false });
      const recovery = recovered[0]!;
      const r = recovered.slice(1, 33);
      const s = recovered.slice(33, 65);
      return concatenate([r, s, Uint8Array.of(recovery + 27)]);
    },
  };
}
