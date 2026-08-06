/**
 * SolverNet manifest cryptography — canonicalize, hash, sign, verify.
 *
 * Implements the wire-format primitives for a `SolverNetManifestV1` per
 * `spec/2026-05-05-solvernet-creation-and-launch.md` §6.3 and §7:
 *
 *   canonical = canonicalJson(manifest_without_signature)   // RFC 8785 JCS
 *   hash      = sha256(canonical)                            // bytes32
 *   signature = eip-191 personal_sign(hash) by launcher agent EOA
 *
 * Verification recovers the signer from the signature + canonical hash and,
 * optionally, asserts the recovered signer agrees with the on-chain ERC-8004
 * IdentityRegistry binding for `manifest.launcher.{agentId, safeAddress}`.
 *
 * The chain-binding check takes an `IdentityRegistryReader` interface so this
 * module remains free of viem `PublicClient` plumbing and easy to mock. Task 4
 * (`IdentityRegistryBackedSolverNetRegistryClient`) wires the real reader.
 */

import { sha256, recoverMessageAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { type SolverNetManifestV1 } from '@jinn-network/sdk/solvernets';

import { canonicalJson } from '../util/canonical-json.js';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The manifest body sans `signature`. Used as the input shape to `signManifest`
 * — callers assemble every field except the signature, then this module signs
 * and returns the complete `SolverNetManifestV1`.
 */
export type UnsignedSolverNetManifestV1 = Omit<SolverNetManifestV1, 'signature'>;

/**
 * Read-side surface for the ERC-8004 IdentityRegistry, narrowed to the two
 * lookups needed to verify a manifest's chain binding. The on-chain client is
 * wired in Task 4; tests pass a fake here.
 *
 * Both methods accept an optional `atBlock` — the spec wants chain-binding
 * verification to be reproducible at the exact block the manifest references,
 * so callers can pin reads to a known head.
 */
export interface IdentityRegistryReader {
  /**
   * Resolve the agentId currently bound to `wallet`, or null when the registry
   * has no record. `wallet` is the agent EOA that signed the manifest.
   */
  getAgentByWallet(
    wallet: `0x${string}`,
    atBlock?: bigint,
  ): Promise<{ agentId: string } | null>;

  /**
   * Resolve the master Safe address bound to `agentId`, or null when the
   * registry has no record.
   */
  getSafeForAgent(
    agentId: string,
    atBlock?: bigint,
  ): Promise<`0x${string}` | null>;
}

/**
 * Discriminated union: when `valid` is true, `signer` is guaranteed
 * present; when false, `reason` is guaranteed present and `signer` is
 * optional (set when recovery succeeded but mismatched the claim).
 */
export type VerifyManifestSignatureResult =
  | { valid: true; signer: `0x${string}` }
  | { valid: false; signer?: `0x${string}`; reason: string };

export interface VerifyManifestAgainstChainResult {
  valid: boolean;
  reason?: string;
}

// ── Canonical form ───────────────────────────────────────────────────────────

/**
 * Canonical JSON of a manifest with `signature` stripped. RFC 8785 JCS via
 * the shared `canonicalJson` helper. Two independent verifiers that share a
 * conforming JCS implementation reproduce this byte-for-byte.
 */
export function canonicalManifestJson(
  manifest: SolverNetManifestV1 | UnsignedSolverNetManifestV1,
): string {
  const { signature: _omit, ...body } = manifest as SolverNetManifestV1;
  return canonicalJson(body);
}

/**
 * sha256 of the canonical manifest bytes — the bytes32 the launcher signs and
 * the chain anchors via the launched-record (§6.2). Independent of the
 * `signature` field.
 */
export function manifestHash(
  manifest: SolverNetManifestV1 | UnsignedSolverNetManifestV1,
): `0x${string}` {
  const canonical = canonicalManifestJson(manifest);
  const bytes = new TextEncoder().encode(canonical);
  // viem's `sha256` returns a lowercase 0x-prefixed 32-byte hex string when
  // given a Uint8Array — exactly the bytes32 wire format we want.
  return sha256(bytes) as `0x${string}`;
}

// ── Sign / verify ────────────────────────────────────────────────────────────

/**
 * Sign an unsigned manifest with the launcher's agent EOA private key.
 *
 * Precondition: the address derived from `agentEoaPrivateKey` MUST equal
 * `unsigned.launcher.agentEoa` (case-insensitive). If it does not, this
 * throws immediately — failing here gives a clear "wrong key for the declared
 * agent EOA" error rather than producing a manifest that fails downstream
 * verification with a confusing recovered-vs-claimed signer mismatch.
 *
 * Steps (per §6.3 + §7):
 *   1. canonicalManifestJson(unsigned)     // RFC 8785 JCS, signature stripped
 *   2. sha256(canonical)                    // bytes32 hash
 *   3. EIP-191 personal_sign(hash bytes)    // 65-byte signature
 *
 * Returns a complete `SolverNetManifestV1` with `signature` populated.
 */
export async function signManifest(
  unsigned: UnsignedSolverNetManifestV1,
  agentEoaPrivateKey: `0x${string}`,
): Promise<SolverNetManifestV1> {
  const account = privateKeyToAccount(agentEoaPrivateKey);

  if (account.address.toLowerCase() !== unsigned.launcher.agentEoa.toLowerCase()) {
    throw new Error(
      `agentEoaPrivateKey derives address ${account.address} but manifest.launcher.agentEoa is ${unsigned.launcher.agentEoa}`,
    );
  }

  const hash = manifestHash(unsigned);

  // EIP-191 personal_sign over the raw 32-byte hash. viem prepends the
  // "\x19Ethereum Signed Message:\n32" prefix automatically when `message` is
  // `{ raw: Hex }`.
  const value = (await account.signMessage({ message: { raw: hash } })) as Hex;

  return {
    ...unsigned,
    signature: {
      alg: 'eip-191',
      signer: account.address as `0x${string}`,
      value,
    },
  };
}

/**
 * Recover the signer from the manifest's signature and check it agrees with
 * the manifest's `signature.signer` claim. Independent of any chain state.
 *
 * Returns `{ valid: false, reason }` for any failure mode (wrong alg, malformed
 * signature, recovery mismatch). Never throws on input shape — the
 * `SolverNetManifestV1Schema` validator handles top-level shape elsewhere; this
 * helper only enforces the cryptographic invariant.
 */
export async function verifyManifestSignature(
  manifest: SolverNetManifestV1,
): Promise<VerifyManifestSignatureResult> {
  if (manifest.signature.alg !== 'eip-191') {
    return { valid: false, reason: `unsupported signature alg: ${manifest.signature.alg}` };
  }

  const hash = manifestHash(manifest);

  let recovered: `0x${string}`;
  try {
    recovered = (await recoverMessageAddress({
      message: { raw: hash },
      signature: manifest.signature.value,
    })) as `0x${string}`;
  } catch (err) {
    return {
      valid: false,
      reason: `recoverMessageAddress failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (recovered.toLowerCase() !== manifest.signature.signer.toLowerCase()) {
    return {
      valid: false,
      signer: recovered,
      reason: `recovered signer ${recovered} does not match signature.signer ${manifest.signature.signer}`,
    };
  }

  return { valid: true, signer: recovered };
}

// ── Chain-binding verification ───────────────────────────────────────────────

/**
 * Verify a manifest end-to-end against the ERC-8004 IdentityRegistry:
 *
 *   1. The cryptographic signature is valid and the recovered signer matches
 *      `manifest.signature.signer`.
 *   2. The recovered signer is bound on-chain to an agentId that equals
 *      `manifest.launcher.agentId`.
 *   3. That agentId is bound on-chain to a master Safe that equals
 *      `manifest.launcher.safeAddress`.
 *
 * Failing the signature check short-circuits — the registry is not queried,
 * so a tampered manifest costs no on-chain reads.
 *
 * Returns `{ valid: true }` on success, `{ valid: false, reason }` otherwise.
 */
export async function verifyManifestAgainstChain(
  manifest: SolverNetManifestV1,
  registry: IdentityRegistryReader,
  atBlock?: bigint,
): Promise<VerifyManifestAgainstChainResult> {
  const sigResult = await verifyManifestSignature(manifest);
  if (!sigResult.valid) {
    return { valid: false, reason: sigResult.reason };
  }

  const signer = sigResult.signer;

  const agentRecord = await registry.getAgentByWallet(signer, atBlock);
  if (!agentRecord) {
    return {
      valid: false,
      reason: `IdentityRegistry has no agent bound to signer wallet ${signer}`,
    };
  }

  if (agentRecord.agentId !== manifest.launcher.agentId) {
    return {
      valid: false,
      reason: `chain agentId (${agentRecord.agentId}) does not match manifest.launcher.agentId (${manifest.launcher.agentId})`,
    };
  }

  const chainSafe = await registry.getSafeForAgent(agentRecord.agentId, atBlock);
  if (!chainSafe) {
    return {
      valid: false,
      reason: `IdentityRegistry has no Safe bound to agentId ${agentRecord.agentId}`,
    };
  }

  if (chainSafe.toLowerCase() !== manifest.launcher.safeAddress.toLowerCase()) {
    return {
      valid: false,
      reason: `chain Safe (${chainSafe}) does not match manifest.launcher.safeAddress (${manifest.launcher.safeAddress})`,
    };
  }

  return { valid: true };
}
