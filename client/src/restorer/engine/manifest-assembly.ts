/**
 * Restorer engine — manifest assembly + signing.
 *
 * §5.1 Restoration manifest, §5.5 Signing.
 *
 * Assembles a `portfolio.v0.manifest.v1` object from engine-controlled
 * provenance fields + impl-supplied output, then:
 *   1. Serialises to canonical JSON (sorted keys, no whitespace) minus the
 *      `signature` field.
 *   2. keccak256-hashes the canonical JSON bytes.
 *   3. Signs the 32-byte hash with the agent EOA's private key via secp256k1
 *      (raw ECDSA, no EIP-191 prefix — uses viem's `sign({ hash, privateKey })`
 *      from `viem/accounts`).
 *   4. Uploads the signed manifest to IPFS and returns the CID.
 */

import type { Hex } from 'viem';
import { signCanonical } from './signing.js';
import { uploadToIpfs } from '../../adapters/mech/ipfs.js';
import type { Artifact } from '../../types/portfolio.js';
import type { Snapshot } from '../../types/portfolio.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ManifestProvenance {
  intentCid: string;
  onchainCreationTx: string;
  onchainCreationBlock: number;
  requestId: string;
  safeAddress: string;
  agentEoa: string;
  windowStartTs: number;
  windowEndTs: number;
}

export interface ManifestImplOutput {
  preSnapshot: Snapshot;
  postSnapshot: Snapshot;
  fills: unknown[];
  gating: Record<string, unknown>;
  informational?: Record<string, unknown>;
  rationale?: Array<{ ts: number; sessionId: string; note: string; relatedFillTids?: number[] }>;
}

export interface AssembledManifest {
  manifest: Record<string, unknown>;
  manifestCid: string;
  signatureHash: Hex;
}

export interface ManifestAssemblyDeps {
  ipfsRegistryUrl: string;
  agentEoaPrivateKey: Hex;
  /** Safe multisig address. When provided, used for manifest.restorer.safeAddress. */
  safeAddress?: `0x${string}`;
}

export interface ManifestAssemblyOptions {
  /**
   * Timestamp to use for `generatedAt` field. Persisting and reusing across
   * retries ensures the manifest CID is deterministic (idempotent PACKAGING).
   * Defaults to Date.now() if not provided (first-run case).
   */
  generatedAt?: number;
}

// ── Assembly ──────────────────────────────────────────────────────────────────

/**
 * Assemble, sign, and upload the portfolio.v0.manifest.v1.
 *
 * Returns the full manifest object, its IPFS CID, and the keccak256 hash
 * that was signed (useful as evidenceHash for claimDelivery).
 */
export async function assembleAndSignManifest(
  provenance: ManifestProvenance,
  implOutput: ManifestImplOutput,
  artifacts: Artifact[],
  deps: ManifestAssemblyDeps,
  opts: ManifestAssemblyOptions = {},
): Promise<AssembledManifest> {
  // Use caller-supplied generatedAt (persisted on first pack, reused on retry)
  // to keep the manifest CID deterministic across PACKAGING retries.
  const generatedAt = opts.generatedAt ?? Date.now();

  // Build unsigned manifest (signature field absent)
  const unsigned: Record<string, unknown> = {
    schemaVersion: 'portfolio.v0.manifest.v1',
    generatedAt,
    intent: {
      cid: provenance.intentCid,
      onchainCreationTx: provenance.onchainCreationTx,
      onchainCreationBlock: provenance.onchainCreationBlock,
      requestId: provenance.requestId,
    },
    restorer: {
      safeAddress: provenance.safeAddress,
      agentEoa: provenance.agentEoa,
    },
    window: {
      startTs: provenance.windowStartTs,
      endTs: provenance.windowEndTs,
    },
    preSnapshot: implOutput.preSnapshot,
    postSnapshot: implOutput.postSnapshot,
    fills: implOutput.fills,
    gating: implOutput.gating,
    ...(implOutput.informational !== undefined
      ? { informational: implOutput.informational }
      : {}),
    artifacts,
    ...(implOutput.rationale !== undefined
      ? { rationale: implOutput.rationale }
      : {}),
  };

  // Sign the unsigned manifest using the shared canonical signing helper.
  const signed = await signCanonical(
    unsigned,
    deps.agentEoaPrivateKey,
    provenance.agentEoa as `0x${string}`,
  );
  const hash = signed.hash as Hex;

  const signedManifest: Record<string, unknown> = {
    ...unsigned,
    signature: {
      algo: 'secp256k1',
      signer: provenance.agentEoa,
      hash: signed.hash,
      sig: signed.sig,
    },
  };

  // Upload to IPFS
  const manifestCid = await uploadToIpfs(deps.ipfsRegistryUrl, signedManifest);

  return {
    manifest: signedManifest,
    manifestCid,
    signatureHash: hash,
  };
}

