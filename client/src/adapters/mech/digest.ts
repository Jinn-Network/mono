import { keccak256, toBytes, type Hex } from 'viem';

/**
 * Compute the on-chain manifest digest for a given CID.
 *
 * The JinnRouter stores `keccak256(toBytes(manifestCid))` as the
 * `manifestDigest` discriminator on TaskCreated events. This helper
 * produces that value so callers can filter/match without importing
 * the full task-subgraph module.
 */
export function manifestDigestForCid(manifestCid: string): Hex {
  return keccak256(toBytes(manifestCid));
}

const HEX_DIGEST = /^0x[0-9a-fA-F]{64}$/u;

/**
 * Stage 5 discovery values are `executionWiring[].legacyManifestDigest`
 * (already `keccak256(toBytes(cid))`). Pre-stage-5 callers still pass CIDs.
 * Hex 32-byte digests pass through; anything else is hashed as a CID.
 */
export function manifestDigestForCidOrDigest(value: string): Hex {
  if (HEX_DIGEST.test(value)) return value.toLowerCase() as Hex;
  return manifestDigestForCid(value);
}
