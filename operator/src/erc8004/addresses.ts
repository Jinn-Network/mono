/**
 * Canonical ERC-8004 registry addresses, keyed by chainId.
 *
 * Single source of truth for the three deployed registries Jinn touches:
 *
 *   - IdentityRegistry  — minted operator agent NFTs + per-execution `setMetadata`.
 *   - ReputationRegistry — evaluator → harness feedback (DR §4.3).
 *   - ValidationRegistry — Phase 1b challenge mechanism (DR §4.4).
 *
 * Cross-checked against the canonical `erc-8004/erc-8004-contracts`
 * reference. Mainnets and their respective testnets share vanity prefixes
 * (0x8004…); the chains 1/8453 vs 11155111/84532 pair accordingly.
 *
 * IdentityRegistry addresses are defined in
 * `operator/src/contracts/addresses.ts` (the canonical per-chainId map); we
 * re-export them below for the consolidated ERC-8004 surface.
 *
 * If you add a chain, update the ReputationRegistry/ValidationRegistry maps
 * here and the IdentityRegistry map in `operator/src/contracts/addresses.ts`.
 */

import type { Address } from 'viem';

// IdentityRegistry addresses live in the canonical contracts/addresses.ts map.
export { IDENTITY_REGISTRY_ADDRESSES, getIdentityRegistryAddress } from '../contracts/addresses.js';

// ── ReputationRegistry ────────────────────────────────────────────────────────

/**
 * Canonical 0x8004… ReputationRegistry deployments.
 */
export const REPUTATION_REGISTRY_ADDRESSES: Record<number, Address> = {
  // Base mainnet
  8453: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  // Base Sepolia
  84532: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  // Ethereum mainnet (shares Base mainnet vanity)
  1: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  // Ethereum Sepolia (shares Base Sepolia vanity)
  11155111: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
};

/**
 * Resolve the ReputationRegistry address for a chainId, or `null` if the
 * chain is not known.
 */
export function getReputationRegistryAddress(chainId: number): Address | null {
  return REPUTATION_REGISTRY_ADDRESSES[chainId] ?? null;
}

// ── ValidationRegistry ────────────────────────────────────────────────────────

/**
 * Canonical 0x8004… ValidationRegistry deployments.
 */
export const VALIDATION_REGISTRY_ADDRESSES: Record<number, Address> = {
  // Base mainnet
  8453: '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
  // Base Sepolia
  84532: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
  // Ethereum mainnet (shares Base mainnet vanity)
  1: '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
  // Sepolia (shares Base Sepolia vanity)
  11155111: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
};

/**
 * Resolve the ValidationRegistry address for a chainId, or `null` if the
 * chain is not known.
 */
export function getValidationRegistryAddress(chainId: number): Address | null {
  return VALIDATION_REGISTRY_ADDRESSES[chainId] ?? null;
}
