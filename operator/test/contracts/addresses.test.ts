import { describe, expect, it } from 'vitest';
import {
  getJinnRouterAddress,
  getIdentityRegistryAddress,
  STOLAS_DISTRIBUTOR,
} from '../../src/contracts/addresses.js';

describe('contract addresses', () => {
  it('resolves the Base mainnet JinnRouter and returns null for Base Sepolia', () => {
    expect(getJinnRouterAddress(8453)).toBe('0xfFa7118A3D820cd4E820010837D65FAfF463181B');
    // Base Sepolia is deliberately absent — artifact-resolved at runtime.
    expect(getJinnRouterAddress(84532)).toBeNull();
  });

  it('resolves the IdentityRegistry vanity addresses', () => {
    expect(getIdentityRegistryAddress(8453)).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
    expect(getIdentityRegistryAddress(84532)).toBe('0x8004A818BFB912233c491871b3d84c89A494BD9e');
  });

  it('pins the stOLAS ExternalStakingDistributor', () => {
    expect(STOLAS_DISTRIBUTOR).toBe('0x40abf47B926181148000DbCC7c8DE76A3a61a66f');
  });
});
