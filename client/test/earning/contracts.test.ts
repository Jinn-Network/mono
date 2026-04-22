import { describe, expect, it } from 'vitest';
import { getChainConfig } from '../../src/earning/contracts.js';

describe('getChainConfig', () => {
  it('bundles the Base Sepolia ClaimRegistry as a zero-config default', () => {
    const cfg = getChainConfig('base-sepolia');

    expect(cfg.claimRegistry).toBe('0xd229A2C20333B747675090Ce38B8a1Fb2dafe6AC');
  });

  it('does not invent a Base mainnet ClaimRegistry default', () => {
    const cfg = getChainConfig('base');

    expect(cfg.claimRegistry).toBeUndefined();
  });
});
