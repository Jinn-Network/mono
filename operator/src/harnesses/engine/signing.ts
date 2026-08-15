/**
 * Shared canonical signing helper for the harness engine.
 *
 * Extracted from manifest-assembly.ts and portfolio-v0-evaluator/index.ts to
 * eliminate duplicated keccak256 → secp256k1 sign → assemble-recovery-byte logic.
 *
 * Signing method: raw secp256k1 ECDSA, no EIP-191 prefix.
 * Uses viem `sign({ hash, privateKey })` from `viem/accounts`.
 */

import { keccak256, toHex, hexToBytes, type Hex } from 'viem';
import { sign } from 'viem/accounts';
import { canonicalJson } from './canonical-json.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SignedCanonical {
  /** Canonical JSON string of the object (sorted keys, no whitespace). */
  canonicalJson: string;
  /** keccak256 hash of the canonical JSON bytes. */
  hash: `0x${string}`;
  /** 65-byte secp256k1 signature: r ++ s ++ recoveryByte, hex-encoded. */
  sig: `0x${string}`;
  /** Address of the signing key (passed through from caller). */
  signer: `0x${string}`;
}

// ── signCanonical ─────────────────────────────────────────────────────────────

/**
 * Serialise `obj` to canonical JSON, hash it with keccak256, sign with
 * `privateKey`, and return the hash + 65-byte signature.
 *
 * @param obj           Object to sign (must be JSON-serialisable).
 * @param privateKey    Agent EOA private key.
 * @param signerAddress Address corresponding to `privateKey` (caller-supplied
 *                      to avoid a redundant `privateKeyToAccount` call when the
 *                      caller already has it).
 */
export async function signCanonical(
  obj: unknown,
  privateKey: `0x${string}`,
  signerAddress: `0x${string}`,
): Promise<SignedCanonical> {
  const canonical = canonicalJson(obj);
  const canonicalBytes = new TextEncoder().encode(canonical);
  const hash = keccak256(canonicalBytes) as `0x${string}`;

  const sigResult = await sign({ hash, privateKey });
  // viem sign() returns { r, s, v, yParity } — use yParity (canonical) with
  // fallback to v for older viem versions that may not populate yParity.
  const recoveryByte = sigResult.yParity ?? (sigResult.v === 28n ? 1 : 0);
  const sig = toHex(
    new Uint8Array([
      ...hexToBytes(sigResult.r),
      ...hexToBytes(sigResult.s),
      recoveryByte,
    ]),
  ) as `0x${string}`;

  return { canonicalJson: canonical, hash, sig, signer: signerAddress };
}
