/**
 * Regression pair for PR #2424 review round 2, findings B1/B2.
 *
 * Root cause: `/v1/status`'s handler built its OWN enriched `StatusGatherConfig`
 * (`{ ...liveStatus, discovery, harnessReadiness }`) inline, while `/v1/rewards` and
 * `/v1/notifications` were wired with the bare `() => liveStatus` — no `harnessReadiness`, no
 * `discovery`. Once the three shared the gather/assemble cache (review finding F3), that
 * divergence became load-bearing: whichever caller filled the unkeyed cache slot first decided
 * the shape for the whole TTL window.
 *   - B1: if a sibling (rewards/notifications) filled the slot first, `/v1/status` could
 *     transiently serve `DEFAULT_HARNESS_ROLLUP` instead of the real harness rollup.
 *   - B2: independent of caching, `/v1/notifications`'s OWN `harness_not_ready` derivation
 *     always read the un-enriched (always-ready) rollup, making that blocking kind unreachable
 *     in production.
 *
 * Fix: `server.ts`'s `resolveStatusGatherConfig` is now the ONE enrichment resolver, used by all
 * three routes. This test drives the real `startApiServer` (mocked viem, no real RPC) with a
 * harness readiness registry reporting a joined-but-not-ready harness, and asserts both halves.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import type { HarnessReadinessRegistry } from '../../src/harnesses/readiness-registry.js';

function mockViem(): void {
  vi.doMock('viem', async (importOriginal) => {
    const actual = await importOriginal<typeof import('viem')>();
    return {
      ...actual,
      createPublicClient: ({ chain }: { chain: { id: number } }) => ({
        getBlockNumber: async () => 123n,
        getChainId: async () => chain.id,
        getBalance: async () => 0n,
        multicall: async (req: { contracts: ReadonlyArray<{ functionName: string }> }) =>
          req.contracts.map(() => ({ status: 'success' as const, result: 0n })),
        readContract: async () => 0n,
        getLogs: async () => [],
      }),
      http: () => ({}),
    };
  });
}

/** A joined harness the registry reports as NOT ready. */
const NOT_READY_REGISTRY = {
  getSnapshot: () => ({
    lastRefreshedAt: new Date().toISOString(),
    harnesses: [
      { harnessName: 'claude-code', manifestCids: ['cid-1'], ready: false, reason: 'not authenticated' },
    ],
  }),
  getJoinedHarnessesByCid: () => ({
    'cid-1': { harnessName: 'claude-code', roles: ['solver'] as Array<'solver' | 'evaluator'> },
  }),
} as unknown as HarnessReadinessRegistry;

describe('shared StatusGatherConfig enrichment across /v1/status, /v1/rewards, /v1/notifications (review round 2 B1/B2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('viem');
    vi.resetModules();
  });

  it('B2: /v1/notifications emits harness_not_ready when the harness readiness registry reports not-ready', async () => {
    mockViem();
    const { startApiServer } = await import('../../src/api/server.js');

    const store = new Store(':memory:');
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-shared-config-b2-'));
    const server = await startApiServer({
      port: 0,
      store,
      apiToken: 't',
      harnessReadinessRegistry: NOT_READY_REGISTRY,
      status: {
        earningDir,
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/notifications`, {
        headers: { Authorization: 'Bearer t' },
      });
      const body = await res.json() as { notifications: Array<{ kind: string; severity: string }> };
      const kinds = body.notifications.map((n) => n.kind);
      expect(kinds).toContain('harness_not_ready');
      expect(body.notifications.find((n) => n.kind === 'harness_not_ready')?.severity).toBe('blocking');
    } finally {
      await server.close();
      store.close();
    }
  });

  it('B1: /v1/status still carries the real harness rollup after a sibling endpoint fills the shared cache slot first', async () => {
    mockViem();
    const { startApiServer } = await import('../../src/api/server.js');

    const store = new Store(':memory:');
    const earningDir = mkdtempSync(join(tmpdir(), 'jinn-shared-config-b1-'));
    const server = await startApiServer({
      port: 0,
      store,
      apiToken: 't',
      harnessReadinessRegistry: NOT_READY_REGISTRY,
      status: {
        earningDir,
        rpcUrl: 'http://127.0.0.1:0',
        network: 'testnet',
        pollIntervalMs: 5000,
        rewardClaimIntervalMs: 0,
      },
    });
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      // Notifications hits first — this is the caller that used to be wired with a bare,
      // un-enriched `getStatus`. It fills the shared cache slot for the TTL window.
      await fetch(`${baseUrl}/v1/notifications`, { headers: { Authorization: 'Bearer t' } });

      // /v1/status, reading the SAME cache slot within the TTL, must still see the real
      // (not-ready) harness rollup — not DEFAULT_HARNESS_ROLLUP.
      // `/v1/status` is operator-class as of spec §14.5 (#2404) — this server has no `ui`,
      // so the exactly-one rule resolves the gate to `requireBearer`. Asserting the status
      // code first keeps an auth regression from surfacing as a TypeError on a 401 body.
      const statusRes = await fetch(`${baseUrl}/v1/status`, { headers: { Authorization: 'Bearer t' } });
      expect(statusRes.status).toBe(200);
      const statusBody = await statusRes.json() as { harness: { ready: boolean; name: string | null } };
      expect(statusBody.harness.ready).toBe(false);
      expect(statusBody.harness.name).toBe('claude-code');
    } finally {
      await server.close();
      store.close();
    }
  });
});
