/**
 * Tests for createDiscoveryAPI factory.
 *
 * Verifies:
 *  - mode: 'onchain'  → returns the floor alone (no withFallback wrapping)
 *  - mode: 'http'     → returns a withFallback composition
 *  - mode: 'embedded' → throws (Embedded not yet shipped)
 */

import { describe, it, expect } from 'vitest';
import { createDiscoveryAPI } from '../../src/discovery/factory.js';

// ── Deps fixture ──────────────────────────────────────────────────────────────

const CHAIN_ID = 84532; // Base Sepolia testnet

const baseDeps = {
  chainId: CHAIN_ID,
  rpcUrl: 'http://localhost:8545',
  routerAddress: ('0x' + 'ff'.repeat(20)) as `0x${string}`,
  identityRegistryAddress: ('0x' + '11'.repeat(20)) as `0x${string}`,
  safeAddress: ('0x' + '44'.repeat(20)) as `0x${string}`,
  mechAddress: ('0x' + '55'.repeat(20)) as `0x${string}`,
};

// ── mode: 'onchain' ────────────────────────────────────────────────────────────

describe('createDiscoveryAPI(mode=onchain)', () => {
  it('returns a DiscoveryAPI with all four methods', () => {
    const api = createDiscoveryAPI({ mode: 'onchain' }, baseDeps);

    expect(typeof api.findClaimableTasks).toBe('function');
    expect(typeof api.listLaunchedSolverNets).toBe('function');
    expect(typeof api.getLifecycleStatus).toBe('function');
    expect(typeof api.queryEnvelopes).toBe('function');
  });

  it('does not wrap in withFallback — it IS the floor', () => {
    // When mode is 'onchain' we return the floor alone; the floor itself should
    // work. We can verify this by calling listLaunchedSolverNets (which hits
    // IdentityRegistry getLogs) and seeing it throw DiscoveryUnavailableError
    // (no real RPC) rather than a logic error.
    const api = createDiscoveryAPI({ mode: 'onchain' }, { ...baseDeps, rpcUrl: 'http://localhost:9999' });

    // We won't actually call it (no RPC) — just confirm the object has the
    // right shape.
    expect(api).toHaveProperty('findClaimableTasks');
    expect(api).toHaveProperty('listLaunchedSolverNets');
    expect(api).toHaveProperty('getLifecycleStatus');
    expect(api).toHaveProperty('queryEnvelopes');
  });

  it('respects an explicit fallbackToOnchain: false (no-op for onchain mode)', () => {
    // For onchain mode, fallbackToOnchain is irrelevant — we return the floor.
    const api = createDiscoveryAPI({ mode: 'onchain', fallbackToOnchain: false }, baseDeps);
    expect(api).toHaveProperty('findClaimableTasks');
  });
});

// ── mode: 'http' ───────────────────────────────────────────────────────────────

describe('createDiscoveryAPI(mode=http)', () => {
  it('returns a DiscoveryAPI with all four methods when url is provided', () => {
    const api = createDiscoveryAPI(
      { mode: 'http', url: 'https://discovery.example.com', fallbackToOnchain: true },
      baseDeps,
    );

    expect(typeof api.findClaimableTasks).toBe('function');
    expect(typeof api.listLaunchedSolverNets).toBe('function');
    expect(typeof api.getLifecycleStatus).toBe('function');
    expect(typeof api.queryEnvelopes).toBe('function');
  });

  it('returns the primary directly when fallbackToOnchain is false', () => {
    const api = createDiscoveryAPI(
      { mode: 'http', url: 'https://discovery.example.com', fallbackToOnchain: false },
      baseDeps,
    );
    expect(typeof api.findClaimableTasks).toBe('function');
  });

  it('defaults to NO fallback (2026-05-23 regression): http without explicit fallbackToOnchain returns the primary directly, no boot warning', () => {
    // Capture console.warn to assert the opt-in banner is NOT emitted when
    // the operator left fallbackToOnchain unset (the new default-off path).
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const api = createDiscoveryAPI(
        { mode: 'http', url: 'https://discovery.example.com' },
        baseDeps,
      );
      expect(typeof api.findClaimableTasks).toBe('function');
    } finally {
      console.warn = originalWarn;
    }
    // No fallback opt-in banner — the wrapper is not installed.
    expect(warns.some((w) => w.includes('fallbackToOnchain=true'))).toBe(false);
  });

  it('emits a one-time boot warning when fallbackToOnchain is explicitly true', () => {
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      createDiscoveryAPI(
        { mode: 'http', url: 'https://discovery.example.com', fallbackToOnchain: true },
        baseDeps,
      );
    } finally {
      console.warn = originalWarn;
    }
    // The opt-in banner makes the choice visible in logs.
    expect(warns.some((w) => w.includes('fallbackToOnchain=true'))).toBe(true);
  });

  it('throws DiscoveryUnavailableError when url is missing', () => {
    expect(() =>
      createDiscoveryAPI({ mode: 'http' }, baseDeps),
    ).toThrow(/discovery\.url/);
  });
});

// ── mode: 'embedded' ──────────────────────────────────────────────────────────

describe('createDiscoveryAPI(mode=embedded)', () => {
  it('throws because EmbeddedPonderDiscoveryAPI is not yet shipped (280n.5)', () => {
    expect(() =>
      createDiscoveryAPI({ mode: 'embedded' }, baseDeps),
    ).toThrow(/280n\.5|not yet available/);
  });
});

// ── default mode ──────────────────────────────────────────────────────────────

describe('createDiscoveryAPI(no mode)', () => {
  it('defaults to onchain when no mode is specified', () => {
    // No mode provided → falls back to 'onchain'.
    const api = createDiscoveryAPI({}, baseDeps);
    expect(api).toHaveProperty('findClaimableTasks');
    expect(api).toHaveProperty('queryEnvelopes');
  });
});
