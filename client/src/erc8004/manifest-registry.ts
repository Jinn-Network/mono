/**
 * ERC-8004 `manifest:` anchor registry surface (#1829).
 *
 * A bulk substrate batch (bridge output; reference-record batches) anchors ONE
 * `manifest:<manifestCid>` record on the existing `IdentityRegistry.setMetadata`
 * write surface — there is NO new contract. The payload commits the merkle root
 * over the batch member CIDs (see `merkle.ts`) so any single member is provable
 * against the on-chain root without a per-member anchor.
 *
 * This module owns only the KEY + ENCODE/DECODE/VALIDATE half (template:
 * `plugin-registry.ts`). Unlike the plug-in path (which routes through a Safe),
 * the manifest anchor deliberately reuses `IdentityPublisher` (agent EOA) so it
 * shares the bridge's single-EOA nonce ledger / broadcast lock — see
 * `IdentityPublisher.publishManifest` for the write half.
 *
 * See `docs/superpowers/specs/2026-07-17-corpus-supply-design.md` §9 and
 * DR-2026-07-17 Decision 5.
 */

import { decodeAbiParameters, encodeAbiParameters, type Hex } from 'viem';
import { MANIFEST_PAYLOAD_TUPLE } from './abis.js';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * On-chain manifest anchor payload (the `MANIFEST_PAYLOAD_TUPLE`).
 *
 * `version` is the on-chain uint16 tuple version (pinned to 0). It is distinct
 * from the `jinn.manifest.v0` IPFS-body `schemaVersion` string — the body
 * carries the enumerable member list; this tuple carries only the trust anchor.
 */
export interface ManifestPayload {
  /** On-chain tuple version (= 0). */
  version: 0;
  /** Root over member-CID leaves (see `merkle.ts`). 32-byte hex. */
  merkleRoot: Hex;
  /** Number of members in the batch (≥1, ≤ uint32 max). */
  memberCount: number;
  /** Unix seconds. Must fit in uint64. */
  createdAt: number;
}

export class ManifestPayloadValidationError extends Error {
  constructor(reason: string) {
    super(`manifest payload validation failed: ${reason}`);
    this.name = 'ManifestPayloadValidationError';
  }
}

// ── Validator ────────────────────────────────────────────────────────────────

const MAX_UINT32 = 0xffff_ffff;
const MAX_UINT64 = 0xffff_ffff_ffff_ffffn;

export function validateManifestPayload(payload: ManifestPayload): ManifestPayload {
  if (payload.version !== 0) {
    throw new ManifestPayloadValidationError(`version must be 0, got ${payload.version}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(payload.merkleRoot)) {
    throw new ManifestPayloadValidationError('merkleRoot must be 32-byte hex (0x + 64 hex chars)');
  }
  if (!Number.isInteger(payload.memberCount) || payload.memberCount < 1) {
    throw new ManifestPayloadValidationError(
      `memberCount must be a positive integer (≥1); got ${payload.memberCount}`,
    );
  }
  if (payload.memberCount > MAX_UINT32) {
    throw new ManifestPayloadValidationError(
      `memberCount exceeds uint32 range; got ${payload.memberCount}`,
    );
  }
  if (!Number.isInteger(payload.createdAt) || payload.createdAt < 0) {
    throw new ManifestPayloadValidationError(
      `createdAt must be a non-negative integer; got ${payload.createdAt}`,
    );
  }
  if (BigInt(payload.createdAt) > MAX_UINT64) {
    throw new ManifestPayloadValidationError(
      `createdAt exceeds uint64 range; got ${payload.createdAt}`,
    );
  }
  return payload;
}

// ── Encoders ─────────────────────────────────────────────────────────────────

export function encodeManifestPayload(payload: ManifestPayload): Hex {
  validateManifestPayload(payload);
  return encodeAbiParameters(MANIFEST_PAYLOAD_TUPLE, [
    payload.version,
    payload.merkleRoot,
    payload.memberCount,
    BigInt(payload.createdAt),
  ]);
}

export function decodeManifestPayload(hex: Hex): ManifestPayload {
  const [version, merkleRoot, memberCount, createdAt] = decodeAbiParameters(
    MANIFEST_PAYLOAD_TUPLE,
    hex,
  );
  const payload: ManifestPayload = {
    version: version as 0,
    merkleRoot,
    memberCount: Number(memberCount),
    createdAt: Number(createdAt),
  };
  return validateManifestPayload(payload);
}

// ── Metadata key ─────────────────────────────────────────────────────────────

/** Canonical prefix for manifest metadata keys on the IdentityRegistry. */
export const MANIFEST_METADATA_KEY_PREFIX = 'manifest:';

/** Build `manifest:<cid>`. Never strips, never normalises. */
export function buildManifestMetadataKey(manifestCid: string): string {
  if (typeof manifestCid !== 'string' || manifestCid.length === 0) {
    throw new ManifestPayloadValidationError('manifestCid must be a non-empty string');
  }
  return `${MANIFEST_METADATA_KEY_PREFIX}${manifestCid}`;
}

/** Parse a `manifest:<cid>` key; returns null when the prefix doesn't match or the cid is empty. */
export function parseManifestMetadataKey(key: string): { manifestCid: string } | null {
  if (typeof key !== 'string' || !key.startsWith(MANIFEST_METADATA_KEY_PREFIX)) {
    return null;
  }
  const manifestCid = key.slice(MANIFEST_METADATA_KEY_PREFIX.length);
  if (manifestCid.length === 0) {
    return null;
  }
  return { manifestCid };
}
