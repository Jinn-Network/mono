/**
 * Shared chain/address constants for the live indexer target.
 *
 * Kept side-effect-free so runtime probes and ponder.config.ts can agree on
 * the active Base Sepolia router without importing Ponder config itself.
 */

export const BASE_SEPOLIA_CHAIN_ID = 84532;

export const BASE_SEPOLIA_RPC_FALLBACK_URL = 'https://sepolia.base.org';

export const BASE_SEPOLIA_JINN_ROUTER_ADDRESS =
  '0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247' as const;

export const BASE_SEPOLIA_JINN_ROUTER_START_BLOCK = 43_523_445;

export const BASE_SEPOLIA_IDENTITY_REGISTRY_ADDRESS =
  '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;

export const BASE_SEPOLIA_IDENTITY_REGISTRY_START_BLOCK = 41_100_000;
