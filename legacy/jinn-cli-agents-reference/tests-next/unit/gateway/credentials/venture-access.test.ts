/**
 * Unit Test: Venture Credential Access Resolution
 * Module: services/x402-gateway/credentials/venture-credentials.ts
 *        services/x402-gateway/credentials/venture-resolver.ts
 *
 * Tests the access resolution logic by calling the real checkVentureAccess
 * and checkVentureCredentialAccess functions with properly mocked DB/network deps.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { VentureCredential, TrustTier } from '../../../../services/x402-gateway/credentials/types.js';

// ---------------------------------------------------------------------------
// Hoisted setup — runs before any module-level side-effects
// ---------------------------------------------------------------------------
const { mockQuery, mockGetOperator, mockGetSupabaseClient } = vi.hoisted(() => {
  process.env.ACL_DATABASE_URL = 'postgresql://mock:mock@localhost:5432/mockdb';
  return {
    mockQuery: vi.fn(),
    mockGetOperator: vi.fn(),
    mockGetSupabaseClient: vi.fn().mockReturnValue(null),
  };
});

// ---------------------------------------------------------------------------
// Mock pg — controls what pool.query() returns
// ---------------------------------------------------------------------------
vi.mock('pg', () => ({
  __esModule: true,
  default: {
    Pool: vi.fn().mockImplementation(() => ({
      query: mockQuery,
      on: vi.fn(),
    })),
  },
}));

// ---------------------------------------------------------------------------
// Mock operators (getOperator used by venture-resolver)
// ---------------------------------------------------------------------------
vi.mock('../../../../services/x402-gateway/credentials/operators.js', () => ({
  getOperator: (...args: unknown[]) => mockGetOperator(...args),
  calculateTrustTier: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock supabase (imported by venture-resolver)
// ---------------------------------------------------------------------------
vi.mock('../../../../services/x402-gateway/credentials/supabase.js', () => ({
  getSupabaseClient: (...args: unknown[]) => mockGetSupabaseClient(...args),
}));

// ---------------------------------------------------------------------------
// Imports (AFTER vi.mock — vitest hoists mocks above imports)
// ---------------------------------------------------------------------------
import { checkVentureAccess } from '../../../../services/x402-gateway/credentials/venture-credentials.js';
import { checkVentureCredentialAccess, discoverVentureProviders } from '../../../../services/x402-gateway/credentials/venture-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVC(overrides: Partial<VentureCredential> = {}): VentureCredential {
  return {
    ventureId: 'v-test',
    provider: 'twitter',
    nangoConnectionId: 'conn-1',
    minTrustTier: 'untrusted',
    accessMode: 'venture_only',
    pricePerAccess: '0',
    active: true,
    ...overrides,
  };
}

function vcToRow(vc: VentureCredential): Record<string, unknown> {
  return {
    venture_id: vc.ventureId,
    provider: vc.provider,
    nango_connection_id: vc.nangoConnectionId,
    min_trust_tier: vc.minTrustTier,
    access_mode: vc.accessMode,
    price_per_access: vc.pricePerAccess,
    active: vc.active,
  };
}

/**
 * Configure mockQuery for the sequential pool.query() calls that
 * checkVentureAccess makes:
 *  1. getVentureCredential SELECT
 *  2. blocklist SELECT (only if credential is active)
 *  3. whitelist SELECT (only if not blocked)
 */
function setupPoolQueries(opts: {
  credential?: VentureCredential | null;
  blockedRows?: Record<string, unknown>[];
  allowedRows?: Record<string, unknown>[];
}) {
  const vc = opts.credential;
  mockQuery.mockResolvedValueOnce({ rows: vc ? [vcToRow(vc)] : [] });
  if (vc && vc.active) {
    mockQuery.mockResolvedValueOnce({ rows: opts.blockedRows ?? [] });
    mockQuery.mockResolvedValueOnce({ rows: opts.allowedRows ?? [] });
  }
}

function makeOperator(overrides: Partial<{ trustTier: TrustTier }> = {}) {
  return {
    address: '0xoperator1',
    serviceId: 1,
    trustTier: 'trusted' as TrustTier,
    tierOverride: 'trusted' as TrustTier | null,
    registeredAt: '2025-01-01',
    updatedAt: '2025-01-01',
    ...overrides,
  };
}

/**
 * Mock global.fetch to simulate Ponder returning a sender address,
 * and mock getSupabaseClient to simulate Supabase returning a venture.
 */
function setupVentureContext(sender: string, venture: { id: string; name: string } | null) {
  // Mock fetch (Ponder GraphQL query)
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      data: { request: { sender } },
    }),
  } as Response);

  // Mock supabase client
  if (venture) {
    mockGetSupabaseClient.mockReturnValueOnce({
      from: () => ({
        select: () => ({
          eq: (_col1: string, _val1: string) => ({
            eq: (_col2: string, _val2: string) => ({
              limit: () => ({
                single: () =>
                  Promise.resolve({ data: venture, error: null }),
              }),
            }),
          }),
        }),
      }),
    });
  } else {
    mockGetSupabaseClient.mockReturnValueOnce(null);
  }
}

/**
 * Setup for when we want resolveVentureContext to return null
 * (no Ponder result → null).
 */
function setupNoVentureContext() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      data: { request: null },
    }),
  } as Response);
}

// ---------------------------------------------------------------------------
// Reset ALL mocks between tests (including queued values)
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockQuery.mockReset();
  mockGetOperator.mockReset();
  mockGetSupabaseClient.mockReset().mockReturnValue(null);
  vi.restoreAllMocks(); // Restore fetch spy
});

// ===== checkVentureAccess (direct DB mock) ============================

describe('checkVentureAccess', () => {
  const defaultParams = {
    ventureId: 'v-test',
    provider: 'twitter',
    operatorAddress: '0xOperator1',
    operatorTrustTier: 'trusted' as TrustTier,
  };

  it('returns no_credential with blockGlobalFallback=false when credential is missing', async () => {
    setupPoolQueries({ credential: null });
    const result = await checkVentureAccess(defaultParams);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_credential');
    expect(result.blockGlobalFallback).toBe(false);
  });

  it('returns no_credential when credential is inactive', async () => {
    setupPoolQueries({ credential: makeVC({ active: false }) });
    const result = await checkVentureAccess(defaultParams);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_credential');
    expect(result.blockGlobalFallback).toBe(false);
  });

  it('venture_only sets blockGlobalFallback=true when operator meets tier', async () => {
    setupPoolQueries({
      credential: makeVC({ accessMode: 'venture_only', minTrustTier: 'untrusted' }),
    });
    const result = await checkVentureAccess({ ...defaultParams, operatorTrustTier: 'trusted' });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('tier_met');
    expect(result.blockGlobalFallback).toBe(true);
  });

  it('union_with_global sets blockGlobalFallback=false even when denied', async () => {
    setupPoolQueries({
      credential: makeVC({ accessMode: 'union_with_global', minTrustTier: 'trusted' }),
    });
    const result = await checkVentureAccess({ ...defaultParams, operatorTrustTier: 'untrusted' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('tier_not_met');
    expect(result.blockGlobalFallback).toBe(false);
  });

  it('blocklist denies even when operator meets tier', async () => {
    setupPoolQueries({
      credential: makeVC({ minTrustTier: 'untrusted' }),
      blockedRows: [{ '?column?': 1 }],
    });
    const result = await checkVentureAccess({ ...defaultParams, operatorTrustTier: 'trusted' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('blocked');
    expect(result.ventureCredential).toBeDefined();
  });

  it('whitelist allows even when operator does not meet tier', async () => {
    setupPoolQueries({
      credential: makeVC({ minTrustTier: 'trusted' }),
      blockedRows: [],
      allowedRows: [{ '?column?': 1 }],
    });
    const result = await checkVentureAccess({ ...defaultParams, operatorTrustTier: 'untrusted' });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('whitelisted');
    expect(result.ventureCredential).toBeDefined();
  });

  it('tier_met when operator meets minimum trust tier (no list entries)', async () => {
    setupPoolQueries({ credential: makeVC({ minTrustTier: 'untrusted' }) });
    const result = await checkVentureAccess({ ...defaultParams, operatorTrustTier: 'trusted' });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('tier_met');
  });

  it('tier_not_met when operator is below minimum trust tier (no list entries)', async () => {
    setupPoolQueries({ credential: makeVC({ minTrustTier: 'trusted' }) });
    const result = await checkVentureAccess({ ...defaultParams, operatorTrustTier: 'untrusted' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('tier_not_met');
  });

  it('blocked result preserves ventureCredential for audit', async () => {
    const vc = makeVC({ ventureId: 'v-audit', provider: 'github' });
    setupPoolQueries({ credential: vc, blockedRows: [{ '?column?': 1 }] });
    const result = await checkVentureAccess({
      ventureId: 'v-audit',
      provider: 'github',
      operatorAddress: '0xBlocked',
      operatorTrustTier: 'trusted',
    });
    expect(result.ventureCredential).toBeDefined();
    expect(result.ventureCredential!.ventureId).toBe('v-audit');
    expect(result.ventureCredential!.provider).toBe('github');
  });

  it.each([
    { op: 'trusted' as TrustTier, min: 'untrusted' as TrustTier, expected: true },
    { op: 'trusted' as TrustTier, min: 'trusted' as TrustTier, expected: true },
    { op: 'untrusted' as TrustTier, min: 'untrusted' as TrustTier, expected: true },
    { op: 'untrusted' as TrustTier, min: 'trusted' as TrustTier, expected: false },
  ])('tier gate: op=$op min=$min → allowed=$expected', async ({ op, min, expected }) => {
    setupPoolQueries({ credential: makeVC({ minTrustTier: min }) });
    const result = await checkVentureAccess({ ...defaultParams, operatorTrustTier: op });
    expect(result.allowed).toBe(expected);
    expect(result.reason).toBe(expected ? 'tier_met' : 'tier_not_met');
  });
});

// ===== checkVentureCredentialAccess (mock fetch + supabase + operators) ====

describe('checkVentureCredentialAccess', () => {
  const defaultParams = {
    requestId: 'req-1',
    provider: 'twitter',
    operatorAddress: '0xOperator1',
  };

  it('returns no_venture_context when no sender in Ponder', async () => {
    setupNoVentureContext();
    const result = await checkVentureCredentialAccess(defaultParams);
    expect(result.ventureAccessGranted).toBe(false);
    expect(result.reason).toBe('no_venture_context');
    expect(result.blockGlobalFallback).toBe(false);
  });

  it('denies unregistered operators with operator_not_registered', async () => {
    setupVentureContext('0xSender1', { id: 'v-test', name: 'Test Venture' });
    mockGetOperator.mockResolvedValue(null);
    // The code looks up the credential even for unregistered operators
    // to determine whether venture_only should block global fallback.
    setupPoolQueries({ credential: makeVC({ accessMode: 'venture_only' }) });
    const result = await checkVentureCredentialAccess(defaultParams);
    expect(result.ventureAccessGranted).toBe(false);
    expect(result.reason).toBe('operator_not_registered');
    expect(result.blockGlobalFallback).toBe(true); // venture_only blocks global fallback
  });

  it('grants access to registered trusted operator with matching credential', async () => {
    setupVentureContext('0xSender1', { id: 'v-test', name: 'Test Venture' });
    mockGetOperator.mockResolvedValue(makeOperator({ trustTier: 'trusted' }));
    setupPoolQueries({ credential: makeVC({ minTrustTier: 'untrusted' }) });
    const result = await checkVentureCredentialAccess(defaultParams);
    expect(result.ventureAccessGranted).toBe(true);
    expect(result.reason).toBe('tier_met');
    expect(result.ventureCredential).toBeDefined();
  });

  it('returns venture_no_credential when venture has no credential for provider', async () => {
    setupVentureContext('0xSender1', { id: 'v-test', name: 'Test Venture' });
    mockGetOperator.mockResolvedValue(makeOperator());
    setupPoolQueries({ credential: null });
    const result = await checkVentureCredentialAccess(defaultParams);
    expect(result.ventureAccessGranted).toBe(false);
    expect(result.reason).toBe('venture_no_credential');
    expect(result.blockGlobalFallback).toBe(false);
  });
});

// ===== discoverVentureProviders (capabilities probe) =======================

describe('discoverVentureProviders', () => {
  const defaultParams = {
    requestId: 'req-1',
    operatorAddress: '0xOperator1',
  };

  /**
   * Setup mockQuery for listVentureCredentials followed by
   * checkVentureAccess for each credential.
   *
   * listVentureCredentials: 1 query (SELECT * FROM venture_credentials)
   * checkVentureAccess per credential: up to 3 queries
   *   1. getVentureCredential SELECT
   *   2. blocklist SELECT
   *   3. whitelist SELECT (if not blocked)
   */
  function setupListAndAccess(
    credentials: VentureCredential[],
    accessPerProvider: Array<{
      blockedRows?: Record<string, unknown>[];
      allowedRows?: Record<string, unknown>[];
    }>,
  ) {
    // listVentureCredentials query
    mockQuery.mockResolvedValueOnce({
      rows: credentials.map(vcToRow),
    });
    // For each credential, setup checkVentureAccess queries
    for (let i = 0; i < credentials.length; i++) {
      const vc = credentials[i];
      const access = accessPerProvider[i] ?? {};
      // getVentureCredential
      mockQuery.mockResolvedValueOnce({ rows: [vcToRow(vc)] });
      if (vc.active) {
        // blocklist check
        mockQuery.mockResolvedValueOnce({ rows: access.blockedRows ?? [] });
        // whitelist check (only if not blocked)
        if (!access.blockedRows?.length) {
          mockQuery.mockResolvedValueOnce({ rows: access.allowedRows ?? [] });
        }
      }
    }
  }

  it('returns empty when no venture context', async () => {
    setupNoVentureContext();
    const result = await discoverVentureProviders(defaultParams);
    expect(result.accessible).toEqual([]);
    expect(result.blockedFromGlobal).toEqual([]);
  });

  it('venture_only + blocked → provider in blockedFromGlobal, not accessible', async () => {
    setupVentureContext('0xSender1', { id: 'v-test', name: 'Test Venture' });
    mockGetOperator.mockResolvedValue(makeOperator({ trustTier: 'trusted' }));

    const vc = makeVC({ provider: 'supabase', accessMode: 'venture_only' });
    setupListAndAccess(
      [vc],
      [{ blockedRows: [{ '?column?': 1 }] }],
    );

    const result = await discoverVentureProviders(defaultParams);
    expect(result.accessible).toEqual([]);
    expect(result.blockedFromGlobal).toEqual(['supabase']);
  });

  it('venture_only + allowed → provider in accessible, not blockedFromGlobal', async () => {
    setupVentureContext('0xSender1', { id: 'v-test', name: 'Test Venture' });
    mockGetOperator.mockResolvedValue(makeOperator({ trustTier: 'trusted' }));

    const vc = makeVC({ provider: 'supabase', accessMode: 'venture_only', minTrustTier: 'untrusted' });
    setupListAndAccess(
      [vc],
      [{}], // no blocklist/whitelist entries → tier_met
    );

    const result = await discoverVentureProviders(defaultParams);
    expect(result.accessible).toEqual(['supabase']);
    expect(result.blockedFromGlobal).toEqual([]);
  });

  it('union_with_global + blocked → provider in neither (global fallback allowed)', async () => {
    setupVentureContext('0xSender1', { id: 'v-test', name: 'Test Venture' });
    mockGetOperator.mockResolvedValue(makeOperator({ trustTier: 'trusted' }));

    const vc = makeVC({ provider: 'github', accessMode: 'union_with_global' });
    setupListAndAccess(
      [vc],
      [{ blockedRows: [{ '?column?': 1 }] }],
    );

    const result = await discoverVentureProviders(defaultParams);
    expect(result.accessible).toEqual([]);
    expect(result.blockedFromGlobal).toEqual([]); // union_with_global does NOT block global
  });

  it('unregistered operator + venture_only → provider in blockedFromGlobal', async () => {
    setupVentureContext('0xSender1', { id: 'v-test', name: 'Test Venture' });
    mockGetOperator.mockResolvedValue(null); // unregistered

    const vc = makeVC({ provider: 'umami', accessMode: 'venture_only' });
    // listVentureCredentials query only (no checkVentureAccess for unregistered)
    mockQuery.mockResolvedValueOnce({ rows: [vcToRow(vc)] });

    const result = await discoverVentureProviders(defaultParams);
    expect(result.accessible).toEqual([]);
    expect(result.blockedFromGlobal).toEqual(['umami']);
  });

  it('unregistered operator + union_with_global → provider in neither', async () => {
    setupVentureContext('0xSender1', { id: 'v-test', name: 'Test Venture' });
    mockGetOperator.mockResolvedValue(null); // unregistered

    const vc = makeVC({ provider: 'github', accessMode: 'union_with_global' });
    mockQuery.mockResolvedValueOnce({ rows: [vcToRow(vc)] });

    const result = await discoverVentureProviders(defaultParams);
    expect(result.accessible).toEqual([]);
    expect(result.blockedFromGlobal).toEqual([]); // union_with_global does NOT block
  });
});
