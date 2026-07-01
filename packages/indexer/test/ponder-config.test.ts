/**
 * Tests for `packages/indexer/ponder.config.ts` env-driven RPC fallback
 * resolution. Per AC4 (issue #592) the indexer's base-sepolia chain block
 * must use a viem `fallback()` transport sourced from PONDER_RPC_URL_84532
 * (comma-separated), capped at 4 providers, with `ethGetLogsBlockRange: 2000`
 * so the slowest fallback (sepolia.base.org at 2k) doesn't blow up under
 * chunking.
 *
 * Ponder configs aren't normally unit-tested, but this one has dynamic env
 * parsing — exactly the surface where bugs would silently turn a 4-RPC
 * chain into a 1-RPC chain or drop the block-range cap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV: Record<string, string | undefined> = {};
const TRACKED_ENVS = ['PONDER_RPC_URL_84532'];

beforeEach(() => {
  for (const key of TRACKED_ENVS) {
    ORIGINAL_ENV[key] = process.env[key];
    delete process.env[key];
  }
  // Drop cached module state so each test re-evaluates ponder.config.ts
  // with the current env.
  vi.resetModules();
});

afterEach(() => {
  for (const key of TRACKED_ENVS) {
    const v = ORIGINAL_ENV[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
});

async function loadConfig(): Promise<{
  chains: { baseSepolia: any };
  contracts: {
    JinnRouter: {
      chain: {
        baseSepolia: {
          address: string;
        };
      };
    };
  };
}> {
  const mod = await import('../ponder.config.js');
  return mod.default;
}

describe('ponder.config baseSepolia fallback (AC4)', () => {
  it('builds a fallback transport from a 5-URL env, capping at 4 providers', async () => {
    process.env.PONDER_RPC_URL_84532 = [
      'https://a.example',
      'https://b.example',
      'https://c.example',
      'https://d.example',
      'https://e.example',
    ].join(',');

    const config = await loadConfig();
    const transport = config.chains.baseSepolia.rpc;
    expect(typeof transport).toBe('function');
    // Walk the transport to confirm fallback semantics: viem stamps a
    // FallbackTransport with `transports` on the returned thing.
    const instantiated = transport({ chain: { id: 84532 } as any });
    expect(instantiated.config.type).toBe('fallback');
    expect(Array.isArray(instantiated.value.transports)).toBe(true);
    // Capped at 4 — slot 5 is dropped.
    expect(instantiated.value.transports.length).toBe(4);
  });

  it('falls back to the default sepolia.base.org when env is unset', async () => {
    const config = await loadConfig();
    const transport = config.chains.baseSepolia.rpc;
    const instantiated = transport({ chain: { id: 84532 } as any });
    expect(instantiated.config.type).toBe('fallback');
    expect(instantiated.value.transports.length).toBe(1);
  });

  it('sets ethGetLogsBlockRange: 2000 on baseSepolia (AC4)', async () => {
    const config = await loadConfig();
    expect(config.chains.baseSepolia.ethGetLogsBlockRange).toBe(2000);
  });

  it('declares only the baseSepolia chain (Sepolia L1 / JinnDistributor removed)', async () => {
    const config = await loadConfig();
    expect(Object.keys(config.chains)).toEqual(['baseSepolia']);
  });

  it('indexes the active tokenless Base Sepolia router from #1304', async () => {
    const config = await loadConfig();
    expect(config.contracts.JinnRouter.chain.baseSepolia.address).toBe(
      '0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247',
    );
  });
});
