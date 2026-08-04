/**
 * Issue #2407 / spec §5: the resolved broadcast-target address set
 * ({staking proxy, distributor, marketplace, router, OLAS token}) is hashed
 * (sha256, sorted JSON) at boot and compared against a checked-in
 * per-network constant. A mismatch is integrity class — fail closed, never
 * degrade-open — because deployment-artifact paths are env-overridable
 * (earning/contracts.ts ChainConfigOverrides / JINN_TESTNET_*_DEPLOYMENT)
 * and address fields are otherwise only presence-checked.
 */
import { describe, expect, it } from 'vitest';
import {
  PINNED_ADDRESS_SETS,
  hashBroadcastTargetAddressSet,
  isAddressDigestCheckOverridden,
  verifyBroadcastTargetAddressSet,
  type BroadcastTargetAddressSet,
} from '../../src/earning/address-digests.js';
import { getChainConfig } from '../../src/earning/contracts.js';

function setFromChainConfig(chain: 'base' | 'base-sepolia'): BroadcastTargetAddressSet {
  const cfg = getChainConfig(chain);
  return {
    stakingProxy: cfg.stakingContract,
    distributor: cfg.distributorAddress,
    marketplace: cfg.mechMarketplace,
    router: cfg.jinnRouter,
    olasToken: cfg.olasToken,
  };
}

describe('hashBroadcastTargetAddressSet', () => {
  it('is stable regardless of key order and address casing', () => {
    const a: BroadcastTargetAddressSet = {
      stakingProxy: '0xAbC0000000000000000000000000000000000001',
      distributor: '0xdef0000000000000000000000000000000000002',
      marketplace: '0x1230000000000000000000000000000000000003',
      router: '0x4560000000000000000000000000000000000004',
      olasToken: '0x7890000000000000000000000000000000000005',
    };
    const b: BroadcastTargetAddressSet = {
      olasToken: '0x7890000000000000000000000000000000000005'.toLowerCase(),
      router: '0x4560000000000000000000000000000000000004'.toUpperCase().replace('0X', '0x'),
      marketplace: '0x1230000000000000000000000000000000000003',
      distributor: '0xDEF0000000000000000000000000000000000002',
      stakingProxy: '0xabc0000000000000000000000000000000000001',
    };
    expect(hashBroadcastTargetAddressSet(a)).toBe(hashBroadcastTargetAddressSet(b));
  });

  it('changes when any single field diverges', () => {
    const base: BroadcastTargetAddressSet = {
      stakingProxy: '0xabc0000000000000000000000000000000000001',
      distributor: '0xdef0000000000000000000000000000000000002',
      marketplace: '0x1230000000000000000000000000000000000003',
      router: '0x4560000000000000000000000000000000000004',
      olasToken: '0x7890000000000000000000000000000000000005',
    };
    const diverged = { ...base, router: '0x9990000000000000000000000000000000000009' };
    expect(hashBroadcastTargetAddressSet(base)).not.toBe(hashBroadcastTargetAddressSet(diverged));
  });
});

describe('PINNED_ADDRESS_SETS', () => {
  it('has an entry for Base mainnet (8453) and Base Sepolia (84532)', () => {
    expect(PINNED_ADDRESS_SETS[8453]).toBeDefined();
    expect(PINNED_ADDRESS_SETS[84532]).toBeDefined();
  });

  it('matches the CURRENT default-resolved ChainConfig for both networks (derived, never hand-typed)', () => {
    expect(setFromChainConfig('base')).toEqual(PINNED_ADDRESS_SETS[8453]);
    expect(setFromChainConfig('base-sepolia')).toEqual(PINNED_ADDRESS_SETS[84532]);
  });
});

describe('verifyBroadcastTargetAddressSet', () => {
  it('passes when the resolved set matches the pinned digest for the chain', () => {
    const result = verifyBroadcastTargetAddressSet({
      chainId: 8453,
      set: setFromChainConfig('base'),
    });
    expect(result.ok).toBe(true);
  });

  it('fails closed and names the diverged field when one address differs', () => {
    const set = setFromChainConfig('base');
    const tampered: BroadcastTargetAddressSet = { ...set, router: '0x0000000000000000000000000000000000dEaD' };
    const result = verifyBroadcastTargetAddressSet({ chainId: 8453, set: tampered });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diverged).toEqual(['router']);
      expect(result.message).toContain('router');
    }
  });

  it('names every diverged field when more than one address differs', () => {
    const set = setFromChainConfig('base-sepolia');
    const tampered: BroadcastTargetAddressSet = {
      ...set,
      marketplace: '0x0000000000000000000000000000000000dEaD',
      olasToken: '0x0000000000000000000000000000000000bEEf',
    };
    const result = verifyBroadcastTargetAddressSet({ chainId: 84532, set: tampered });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(new Set(result.diverged)).toEqual(new Set(['marketplace', 'olasToken']));
    }
  });

  it('fails closed for an unrecognized chainId (no pinned constant to compare against)', () => {
    const result = verifyBroadcastTargetAddressSet({
      chainId: 999_999,
      set: setFromChainConfig('base'),
    });
    expect(result.ok).toBe(false);
  });

  describe('isAddressDigestCheckOverridden (JINN_ADDRESS_DIGEST_OVERRIDE escape)', () => {
    it('is false when unset', () => {
      expect(isAddressDigestCheckOverridden({})).toBe(false);
    });

    it('is false for explicit 0 / false / no', () => {
      expect(isAddressDigestCheckOverridden({ JINN_ADDRESS_DIGEST_OVERRIDE: '0' })).toBe(false);
      expect(isAddressDigestCheckOverridden({ JINN_ADDRESS_DIGEST_OVERRIDE: 'false' })).toBe(false);
      expect(isAddressDigestCheckOverridden({ JINN_ADDRESS_DIGEST_OVERRIDE: 'no' })).toBe(false);
    });

    it('is true for 1 (the local-Anvil-fork escape)', () => {
      expect(isAddressDigestCheckOverridden({ JINN_ADDRESS_DIGEST_OVERRIDE: '1' })).toBe(true);
    });

    it('is true for any other non-empty truthy-ish value', () => {
      expect(isAddressDigestCheckOverridden({ JINN_ADDRESS_DIGEST_OVERRIDE: 'true' })).toBe(true);
      expect(isAddressDigestCheckOverridden({ JINN_ADDRESS_DIGEST_OVERRIDE: 'anvil-fork' })).toBe(true);
    });
  });

  it('is case-insensitive on address comparison', () => {
    const set = setFromChainConfig('base');
    const upper: BroadcastTargetAddressSet = {
      ...set,
      stakingProxy: set.stakingProxy!.toUpperCase().replace('0X', '0x'),
    };
    const result = verifyBroadcastTargetAddressSet({ chainId: 8453, set: upper });
    expect(result.ok).toBe(true);
  });
});
