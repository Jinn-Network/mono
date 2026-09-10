/**
 * Regression coverage for issue #2416 — the token-gated surfaces #2402's
 * first cut left unmasked.
 *
 * #2415 closed the *unauthenticated* leak (`/v1/status`, the balance cache).
 * These three routes are UI-token-gated — a different risk class, deferred
 * rather than scope-crept — and still stringified an RPC-derived error
 * verbatim. `OnchainDiscoveryAPI` builds a viem client on the operator's
 * `rpcUrl` and runs getLogs/multicall, and on mainnet onchain is the DEFAULT
 * discovery mode, so a failing paid primary's key-in-path reached the
 * response body through `(err as Error).message`.
 *
 * The masking dialect is `sanitizeErrorText` (operator/src/rpc/transport.ts) —
 * the one host-only vocabulary #642 converged on, and the one
 * `check-no-error-leak.mjs` enforces. It is strictly stronger than the
 * `.message` it replaces: it walks the `Error.cause` chain, so a nested viem
 * `HttpRequestError` URL cannot bypass it.
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { addDiscoveryRoutes } from '../../src/api/discovery-endpoint.js';
import { addRewardsRoutes } from '../../src/api/rewards-endpoint.js';
import { addAdminRoutes } from '../../src/api/admin-endpoint.js';
import type { ArchiveReads } from '../../src/archive/reads.js';
import type { PluginPublicationReader } from '../../src/plugin-registry/publication-reader.js';

vi.mock('../../src/intents/claim-rewards.js', () => ({
  claimRewardsIntent: vi.fn(),
}));
import { claimRewardsIntent } from '../../src/intents/claim-rewards.js';

/** A paid provider's key-in-path primary, the shape the guard exists for. */
const RPC_HOST = 'base-mainnet.paid-provider.example';
const RPC_SECRET = 'SUPERSECRETKEY1234567';
const RPC_URL = `https://${RPC_HOST}/v2/${RPC_SECRET}`;

/**
 * Two real leak shapes.
 *
 * `direct` — the URL sits in the top-level `.message`, exactly what viem's
 * `HttpRequestError` produces for a plain transport failure. This is the leak
 * `(err as Error).message` shipped verbatim.
 *
 * `nested` — the URL is reachable only through `.cause`, the shape viem
 * produces when it wraps a transport error in a call-level error. Masking the
 * top-level message alone does not reach it, which is why the choke point is
 * `sanitizeErrorText` (cause-walking) rather than a bare
 * `maskUrlsInMessage(err.message)`.
 */
function rpcFailure(shape: 'direct' | 'nested'): Error {
  if (shape === 'direct') return new Error(`HTTP request failed. URL: ${RPC_URL}`);
  const outer = new Error('The request failed.');
  (outer as { cause?: unknown }).cause = new Error(`HTTP request failed. URL: ${RPC_URL}`);
  return outer;
}

const SHAPES = ['direct', 'nested'] as const;

function expectMasked(body: string): void {
  expect(body).not.toContain(RPC_SECRET);
  expect(body).not.toContain(RPC_URL);
  // The host survives — masking must not destroy the diagnostic.
  expect(body).toContain(RPC_HOST);
}

describe('#2416 — RPC-derived errors are masked on token-gated surfaces', () => {
  describe('discovery-endpoint', () => {
    function app(shape: 'direct' | 'nested'): Hono {
      const reader = {
        listPluginPublications: vi.fn().mockRejectedValue(rpcFailure(shape)),
        getPluginScores: vi.fn().mockRejectedValue(rpcFailure(shape)),
        listBuilderArtifacts: vi.fn().mockRejectedValue(rpcFailure(shape)),
      } as unknown as PluginPublicationReader;
      const archiveReads = {
        getTaskPostCounts: vi.fn().mockRejectedValue(rpcFailure(shape)),
        getTaskStatuses: vi.fn().mockResolvedValue(new Map()),
      } as unknown as ArchiveReads;
      const a = new Hono();
      addDiscoveryRoutes(a, { pluginReader: () => reader, archiveReads: () => archiveReads });
      return a;
    }

    const PATHS = [
      '/v1/discovery/plugin-publications',
      '/v1/discovery/builder-artifacts?builderAgentId=42',
      '/v1/discovery/task-post-counts',
      '/v1/discovery/plugin-scores?cid=bafycid',
    ];

    it.each(PATHS.flatMap((path) => SHAPES.map((shape) => [path, shape] as const)))(
      '%s masks a %s RPC-URL leak',
      async (path, shape) => {
        const res = await app(shape).request(path);
        expect(res.status).toBe(503);
        expectMasked(await res.text());
      },
    );
  });

  it.each(SHAPES)('rewards-endpoint masks a %s RPC-URL leak', async (shape) => {
    const a = new Hono();
    addRewardsRoutes(a, {
      store: {} as never,
      getStatus: () => undefined,
      gatherRaw: vi.fn().mockRejectedValue(rpcFailure(shape)) as never,
    });
    const res = await a.request('/v1/rewards');
    expect(res.status).toBe(500);
    expectMasked(await res.text());
  });

  it.each(SHAPES)('admin claim-rewards masks a %s RPC-URL leak', async (shape) => {
    vi.mocked(claimRewardsIntent).mockRejectedValue(rpcFailure(shape));
    const a = new Hono();
    addAdminRoutes(a, {
      onRestartRequested: () => {},
      onStopRequested: () => {},
      claimRewards: { holder: { current: {} as never } },
    });
    const res = await a.request('/api/admin/claim-rewards', { method: 'POST' });
    expect(res.status).toBe(500);
    expectMasked(await res.text());
  });
});
