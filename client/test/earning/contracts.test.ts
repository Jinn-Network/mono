import { describe, expect, it } from 'vitest';
import {
  IDENTITY_REGISTRY_ADDRESSES,
  getChainConfig,
} from '../../src/earning/contracts.js';

describe('getChainConfig', () => {
  it('does not expose legacy claim coordination on Base Sepolia clean-break config', () => {
    const cfg = getChainConfig('base-sepolia');

    expect('claimRegistry' in cfg).toBe(false);
  });

  it('does not expose legacy claim coordination on Base mainnet clean-break config', () => {
    const cfg = getChainConfig('base');

    expect('claimRegistry' in cfg).toBe(false);
  });

  // ── ERC-8004 IdentityRegistry (jinn-mono-j07) ────────────────────────────
  it('exposes the canonical IdentityRegistry on Base mainnet', () => {
    const cfg = getChainConfig('base');
    // Vanity address from subgraph/networks.json (cross-checked against
    // erc-8004/erc-8004-contracts/scripts/addresses.ts).
    expect(cfg.identityRegistry).toBe(
      '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    );
  });

  it('exposes the canonical IdentityRegistry on Base Sepolia', () => {
    const cfg = getChainConfig('base-sepolia');
    expect(cfg.identityRegistry).toBe(
      '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    );
  });

  it('IDENTITY_REGISTRY_ADDRESSES is keyed by chainId for both Base + Sepolia variants', () => {
    expect(IDENTITY_REGISTRY_ADDRESSES[8453]).toBe(
      '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    );
    expect(IDENTITY_REGISTRY_ADDRESSES[84532]).toBe(
      '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    );
  });
});
