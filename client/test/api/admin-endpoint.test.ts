/**
 * Regression coverage for issue #2405 (spec §4.1 intent-module law).
 *
 * `POST /api/admin/claim-rewards` used to run the CLI verb in-process via a
 * fabricated `CommandContext` (`runCommandJson`), whose signer context ran
 * `checkDaemonGuard` with `willBroadcast` defaulting true — tripping the
 * guard precisely when the daemon (i.e. the route's own process) was alive.
 * The fix re-points the route at a pure intent module
 * (`intents/claim-rewards.ts`) built from the daemon's own already-live
 * signer/client objects; the daemon-guard is now a CLI-front-end-only
 * property that this route never touches.
 */
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient, WalletClient } from 'viem';
import { addAdminRoutes, type ClaimRewardsRouteContext } from '../../src/api/admin-endpoint.js';
import { FleetStateStore } from '../../src/earning/store.js';
import { Store } from '../../src/store/store.js';
import {
  __setExecSyncForTesting,
  __resetExecSyncForTesting,
} from '../../src/lifecycle/process-discovery.js';

function makeApp(claimRewardsHolder: { current: ClaimRewardsRouteContext | undefined }) {
  const app = new Hono();
  addAdminRoutes(app, {
    onRestartRequested: vi.fn(),
    onStopRequested: vi.fn(),
    claimRewards: { holder: claimRewardsHolder },
  });
  return app;
}

describe('POST /api/admin/claim-rewards', () => {
  it('returns 503 (not a daemon-guard block) when bootstrap has not populated the holder yet', async () => {
    const app = makeApp({ current: undefined });
    const res = await app.request('/api/admin/claim-rewards', { method: 'POST' });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/bootstrap/i);
  });

  it('invokes the claim-rewards intent with the route context and returns its result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'admin-claim-wiring-'));
    const fleetStore = new FleetStateStore(join(root, 'earning'));
    const jinnStore = new Store(':memory:');
    try {
      const ctx: ClaimRewardsRouteContext = {
        publicClient: {} as PublicClient,
        masterWallet: {} as WalletClient,
        fleetStore,
        chain: 'base-sepolia',
        // No distributor configured -> the underlying tick short-circuits
        // before ever touching publicClient/masterWallet (see
        // earning/stolas-claim.ts's skippedNoDistributor branch), so the
        // stub clients above are never dereferenced.
        distributorAddress: undefined,
        jinnStore,
      };
      const app = makeApp({ current: ctx });

      const res = await app.request('/api/admin/claim-rewards', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        result: { verb: string; skippedNoDistributor: boolean; submitted: number };
      };
      expect(body.ok).toBe(true);
      expect(body.result.verb).toBe('claim-rewards');
      expect(body.result.skippedNoDistributor).toBe(true);
      expect(body.result.submitted).toBe(0);
    } finally {
      jinnStore.close();
    }
  });

  describe('regression: a live daemon.pid has no effect on the route', () => {
    let root: string;
    let killSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'admin-claim-guard-'));
      const earningDir = join(root, 'earning');
      mkdirSync(earningDir, { recursive: true });
      // A daemon.pid that `checkDaemonGuard` (the CLI-only guard) would
      // classify as a confirmed-live jinn daemon.
      writeFileSync(join(earningDir, 'daemon.pid'), '987654\n', 'utf-8');
      __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
      killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    });

    afterEach(() => {
      killSpy.mockRestore();
      __resetExecSyncForTesting();
    });

    it('broadcasts (completes the claim tick) instead of returning a daemon-guard envelope', async () => {
      const earningDir = join(root, 'earning');
      const fleetStore = new FleetStateStore(earningDir);
      const jinnStore = new Store(':memory:');
      try {
        const ctx: ClaimRewardsRouteContext = {
          publicClient: {} as PublicClient,
          masterWallet: {} as WalletClient,
          fleetStore,
          chain: 'base-sepolia',
          distributorAddress: undefined,
          jinnStore,
        };
        const app = makeApp({ current: ctx });

        const res = await app.request('/api/admin/claim-rewards', { method: 'POST' });
        const body = (await res.json()) as {
          ok: boolean;
          result?: { code?: string; verb?: string };
        };

        // Pre-fix, this would have been ok:false / 500 with
        // result.code === 'invalid_invocation' and a "Refusing to
        // broadcast" message (the daemon-guard envelope).
        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.result?.code).toBeUndefined();
        expect(body.result?.verb).toBe('claim-rewards');
      } finally {
        jinnStore.close();
      }
    });
  });
});
