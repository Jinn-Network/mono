/**
 * Design finding F1 for #4826 — the pre-launch mainnet clamp rewrote
 * `config.rpcUrl` but left `config.rpcUrls` holding the mainnet chain. The
 * daemon's own viem clients already read `config.rpcUrls`, so the clamp was
 * already partially bypassed; switching the fleet bootstrap onto the resolved
 * chain would extend that bypass to the bootstrap too.
 *
 * Extracted from `main.ts` because that file executes on import. Same shape as
 * `resolveMainEntryEffectiveMode` in `daemon/daemon-startup-info.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPreLaunchMainnetClamp,
  PRE_LAUNCH_TESTNET_RPC_URL,
} from '../src/pre-launch-network-clamp.js';

function mainnetConfig() {
  return {
    network: 'mainnet' as const,
    rpcUrl: 'https://mainnet.base.org',
    rpcUrls: ['https://mainnet.base.org', 'https://base.llamarpc.com'] as readonly string[],
  };
}

describe('applyPreLaunchMainnetClamp', () => {
  it('clamps both the head URL and the resolved chain when mainnet is disabled', () => {
    const config = mainnetConfig();

    expect(applyPreLaunchMainnetClamp(config, {})).toBe(true);

    expect(config.network).toBe('testnet');
    expect(config.rpcUrl).toBe(PRE_LAUNCH_TESTNET_RPC_URL);
    expect(config.rpcUrls).toEqual([PRE_LAUNCH_TESTNET_RPC_URL]);
  });

  it('leaves a mainnet config untouched when JINN_ENABLE_MAINNET=1', () => {
    const config = mainnetConfig();
    const before = { ...config, rpcUrls: [...config.rpcUrls] };

    expect(applyPreLaunchMainnetClamp(config, { JINN_ENABLE_MAINNET: '1' })).toBe(false);

    expect(config.network).toBe(before.network);
    expect(config.rpcUrl).toBe(before.rpcUrl);
    expect(config.rpcUrls).toEqual(before.rpcUrls);
  });

  it('leaves a testnet config untouched', () => {
    const config = {
      network: 'testnet' as const,
      rpcUrl: 'https://base-sepolia.publicnode.com',
      rpcUrls: ['https://base-sepolia.publicnode.com'] as readonly string[],
    };

    expect(applyPreLaunchMainnetClamp(config, {})).toBe(false);

    expect(config.network).toBe('testnet');
    expect(config.rpcUrl).toBe('https://base-sepolia.publicnode.com');
    expect(config.rpcUrls).toEqual(['https://base-sepolia.publicnode.com']);
  });
});
