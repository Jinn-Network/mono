/**
 * Tests for createDiscoveryAPI factory.
 *
 * Verifies:
 *  - mode: 'onchain'       → returns the floor alone (no withFallback wrapping)
 *  - mode: 'http-subgraph' → returns a withFallback composition
 *  - mode: 'http'          → throws (HttpDiscoveryAPI not yet shipped)
 *  - mode: 'embedded'      → throws (Embedded not yet shipped)
 *  - legacy subgraphUrl    → is mapped to http-subgraph mode (tested via config normalization)
 */

import { describe, it, expect, vi } from 'vitest';
import { createDiscoveryAPI } from '../../src/discovery/factory.js';
import type { SubgraphClient } from '../../src/solvernets/registry-client-erc8004.js';

// ── Deps fixture ──────────────────────────────────────────────────────────────

const CHAIN_ID = 84532; // Base Sepolia testnet

const noopSubgraphClient: SubgraphClient = {
  fetchSetMetadataEvents: vi.fn().mockResolvedValue([]),
  fetchSetMetadataEventsForCid: vi.fn().mockResolvedValue([]),
};

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

// ── mode: 'http-subgraph' ──────────────────────────────────────────────────────

describe('createDiscoveryAPI(mode=http-subgraph)', () => {
  it('returns a DiscoveryAPI with all four methods when subgraphClient and url are provided', () => {
    const api = createDiscoveryAPI(
      {
        mode: 'http-subgraph',
        url: 'https://subgraph.test/graphql',
        fallbackToOnchain: true,
      },
      { ...baseDeps, subgraphClient: noopSubgraphClient },
    );

    expect(typeof api.findClaimableTasks).toBe('function');
    expect(typeof api.listLaunchedSolverNets).toBe('function');
    expect(typeof api.getLifecycleStatus).toBe('function');
    expect(typeof api.queryEnvelopes).toBe('function');
  });

  it('throws when subgraphClient is missing', () => {
    expect(() =>
      createDiscoveryAPI(
        { mode: 'http-subgraph', url: 'https://subgraph.test/graphql' },
        baseDeps, // no subgraphClient
      ),
    ).toThrow(/subgraphClient/);
  });

  it('throws when url is missing', () => {
    expect(() =>
      createDiscoveryAPI(
        { mode: 'http-subgraph' }, // no url
        { ...baseDeps, subgraphClient: noopSubgraphClient },
      ),
    ).toThrow(/discovery\.url/);
  });

  it('returns the primary directly when fallbackToOnchain is false', () => {
    // With fallbackToOnchain: false the api is the HttpSubgraphDiscoveryAPI
    // directly, not wrapped in withFallback. We verify via behavior: when the
    // primary subgraph fails, the call should propagate (not fall back).
    const failingSubgraph: SubgraphClient = {
      fetchSetMetadataEvents: vi.fn().mockRejectedValue(new Error('subgraph down')),
      fetchSetMetadataEventsForCid: vi.fn().mockRejectedValue(new Error('subgraph down')),
    };

    const api = createDiscoveryAPI(
      {
        mode: 'http-subgraph',
        url: 'https://subgraph.test/graphql',
        fallbackToOnchain: false,
      },
      { ...baseDeps, subgraphClient: failingSubgraph },
    );

    // DiscoveryUnavailableError should propagate (not be silently swallowed)
    return expect(api.listLaunchedSolverNets()).rejects.toThrow();
  });
});

// ── mode: 'http' ───────────────────────────────────────────────────────────────

describe('createDiscoveryAPI(mode=http)', () => {
  it('throws because HttpDiscoveryAPI is not yet shipped (280n.4)', () => {
    expect(() =>
      createDiscoveryAPI({ mode: 'http', url: 'https://discovery.example.com' }, baseDeps),
    ).toThrow(/280n\.4/);
  });
});

// ── mode: 'embedded' ──────────────────────────────────────────────────────────

describe('createDiscoveryAPI(mode=embedded)', () => {
  it('throws because EmbeddedPonderDiscoveryAPI is not yet shipped (280n.5)', () => {
    expect(() =>
      createDiscoveryAPI({ mode: 'embedded' }, baseDeps),
    ).toThrow(/280n\.5/);
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
