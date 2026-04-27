import { keccak256, pad, toHex, encodeAbiParameters, getAddress, type Address, type Hex } from 'viem';
import type { ChainTestHarness } from './interface.js';

/** OLAS token address on Base (shared by all Base fork e2e tests). */
export const OLAS_TOKEN_BASE = '0x54330d28ca3357F294334BDC454a032e7f353416' as const satisfies Address;

/**
 * Funds `holder` with `amount` OLAS by writing directly to the ERC-20 balance
 * mapping slot. Replaces the OLAS-whale impersonation + transfer dance that
 * three legacy e2e scripts copy-pasted.
 *
 * Slot derivation: balance mapping is at slot 0 for the OLAS token on Base.
 * If a future test targets a token with a different balance slot, parameterize
 * this helper rather than adding another copy.
 */
export async function fundAddressWithOLAS(
  chain: ChainTestHarness,
  holder: Address,
  amount: bigint,
): Promise<void> {
  const slot = computeMappingSlot(getAddress(holder), 0n);
  const value = pad(toHex(amount), { size: 32 });
  await chain.setStorageSlot(OLAS_TOKEN_BASE, slot, value);
}

/** Computes keccak256(abi.encode(key, slot)) for a standard Solidity mapping layout. */
function computeMappingSlot(key: Address, mappingSlot: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [key, mappingSlot],
    ),
  );
}
