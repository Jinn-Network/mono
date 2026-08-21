/**
 * Canonical contract addresses, keyed by chainId.
 *
 * Single source of truth for the hardcoded (non-artifact-resolved) contract
 * addresses the client touches. Only static mainnet/testnet literals live here;
 * Base Sepolia values that resolve from deployment artifacts at runtime stay in
 * `earning/contracts.ts` (`resolveBaseSepoliaConfig`).
 *
 * Leaf module — imports only viem types, never any internal module, so it can
 * be depended on from anywhere without introducing an import cycle.
 */

import type { Address } from 'viem';

// ── JinnRouter ────────────────────────────────────────────────────────────────

/**
 * Default JinnRouter addresses by chain ID. Base mainnet only; Base Sepolia is
 * deliberately absent — it is loaded from the deployment artifact at runtime.
 */
export const JINN_ROUTER_ADDRESSES: Record<number, Address> = {
  8453: '0xfFa7118A3D820cd4E820010837D65FAfF463181B', // Base mainnet
};

/**
 * Resolve the JinnRouter address for a chainId, or `null` if the chain has no
 * static default.
 */
export function getJinnRouterAddress(chainId: number): Address | null {
  return JINN_ROUTER_ADDRESSES[chainId] ?? null;
}

// ── ERC-8004 IdentityRegistry ───────────────────────────────────────────────
//
// Source of truth: erc-8004/erc-8004-contracts/scripts/addresses.ts. Only the
// chains the client compiles for are mirrored here; the registry is also
// deployed on Sepolia/Mainnet for completeness, but the bootstrap currently
// runs against Base or Base Sepolia.

export const IDENTITY_REGISTRY_ADDRESSES: Record<number, Address> = {
  8453: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',  // Base mainnet
  84532: '0x8004A818BFB912233c491871b3d84c89A494BD9e', // Base Sepolia
  // Mainnet (1) and Sepolia (11155111) share the Base mainnet / Base
  // Sepolia vanity addresses respectively; not currently consumed from
  // the client.
  1: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  11155111: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
};

/**
 * Resolve the IdentityRegistry address for a chainId, or `null` if the chain
 * is not known.
 */
export function getIdentityRegistryAddress(chainId: number): Address | null {
  return IDENTITY_REGISTRY_ADDRESSES[chainId] ?? null;
}

// ── OLAS / Autonolas (Base mainnet) ──────────────────────────────────────────
//
// Static mainnet literals inlined by BASE_CONFIG in `earning/contracts.ts`.

/** OLAS token (Base mainnet). */
export const OLAS_TOKEN: Address = '0x54330d28ca3357F294334BDC454a032e7f353416';

/** OLAS Mech Marketplace (Base mainnet). */
export const MECH_MARKETPLACE: Address = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';

/** Jinn staking contract / JinnRouter activity checker proxy (Base mainnet). */
export const STAKING_CONTRACT: Address = '0x51c5f4982b9b0b3c0482678f5847ea6228cc8e54';

/**
 * stOLAS ExternalStakingDistributor (LemonTree, Base mainnet).
 *
 * KNOWN LIMITATION (since Base block 48626242 / 2026-07-14): fresh `stake()`
 * onboarding (serviceId = 0) reverts UnauthorizedMultisig because the
 * distributor's immutable same-address implementation (0xFbBE…E2aB) is no
 * longer whitelisted by ServiceRegistryL2. Existing service redeploy and
 * `reStake()` paths use the still-whitelisted RecoveryModule (0x359d…E74c)
 * and remain available. Base Sepolia is unaffected.
 */
export const STOLAS_DISTRIBUTOR: Address = '0x40abf47B926181148000DbCC7c8DE76A3a61a66f';
