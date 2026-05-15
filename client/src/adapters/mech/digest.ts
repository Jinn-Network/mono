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
