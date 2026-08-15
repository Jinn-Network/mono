/**
 * Regression coverage for issue #2405 (spec §4.1 intent-module law), plus
 * the F1 concurrency-race repair from the follow-up review on PR #2412.
 *
 * `POST /api/admin/claim-rewards` used to run the CLI verb in-process via a
 * fabricated `CommandContext` (`runCommandJson`), whose signer context ran
 * `checkDaemonGuard` with `willBroadcast` defaulting true — tripping the
 * guard precisely when the daemon (i.e. the route's own process) was alive.
 * The fix re-points the route at a pure intent module
 * (`intents/claim-rewards.ts`) built from the daemon's own already-live
 * signer/client objects; the daemon-guard is now a CLI-front-end-only
 * property that this route never touches.
 *
 * Separately: `tickStolasDistributorClaims` pre-reads the pending reward,
 * THEN broadcasts. Two ticks racing this route (double-click, MCP beside
 * the SPA, a proxy retry, or the periodic loop landing beside a manual
 * claim) could both pass the pre-read before either sent, burning gas on a
 * revert. The intent module now serializes the whole tick (not just the
 * send) behind a module-level single-flight — the "F1 concurrency" describe
 * block below proves it with a real (non-injected) send path.
 */
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicClient, WalletClient } from 'viem';
import { addAdminRoutes, type ClaimRewardsRouteContext } from '../../src/api/admin-endpoint.js';
import { checkDaemonGuard } from '../../src/cli/daemon-guard.js';
import { FleetStateStore } from '../../src/earning/store.js';
import { createDefaultFleetState, type ServiceState } from '../../src/earning/types.js';
import { Store } from '../../src/store/store.js';
import {
  __setExecSyncForTesting,
  __resetExecSyncForTesting,
} from '../../src/lifecycle/process-discovery.js';

const DISTRIBUTOR = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const STAKING_PROXY = '0x0000000000000000000000000000000000000002';
const MASTER_ADDRESS = '0xcccccccccccccccccccccccccccccccccccccccc' as `0x${string}`;

function stakedService(overrides: Partial<ServiceState> = {}): ServiceState {
  return {
    index: 1,
    agent_address: '0x1111111111111111111111111111111111111111',
    safe_address: '0x2222222222222222222222222222222222222222',
    service_id: 42,
    mech_address: '0x3333333333333333333333333333333333333333',
    staking_address: STAKING_PROXY,
    step: 'complete',
    error: null,
    agent_id: null,
    agent_uri: null,
    identity_registry_address: null,
    agent_registered_tx: null,
    safe_bound_to_agent: false,
    error_revert_reason: null,
    error_short_message: null,
    ...overrides,
  };
}

/** A fleet store with one staked, claim-eligible service. */
async function seedFleetStore(earningDir: string): Promise<FleetStateStore> {
  const fleetStore = new FleetStateStore(earningDir);
  const state = createDefaultFleetState('base-sepolia');
  state.services = [stakedService()];
  await fleetStore.save(state);
  return fleetStore;
}

/** Fixed signing account; each call resolves a distinct fake tx hash. */
function fakeMasterWallet(callLog: string[]): WalletClient {
  let n = 0;
  return {
    account: { address: MASTER_ADDRESS },
    sendTransaction: vi.fn(async () => {
      callLog.push('sendTransaction');
      n += 1;
      return `0xhash${n}`;
    }),
  } as unknown as WalletClient;
}

/**
 * Exercises the REAL (non-injected) send path — `viemSendTransactionWithRetry`
 * / `waitForTransactionReceiptWithRetry` (tx-retry.ts), including nonce
 * tracking and the `withEoaBroadcastLock` — rather than stolas-claim.ts's
 * `retryDeps` test seam, since the route/intent never supplies one.
 * `pendingRewards` is consumed one value per `readContract` call (in order,
 * pinned to the last entry once exhausted), letting a test simulate on-chain
 * state moving between ticks.
 */
function fakePublicClient(callLog: string[], pendingRewards: bigint[]): PublicClient {
  let call = 0;
  return {
    readContract: vi.fn(async () => {
      callLog.push('readContract');
      const value = pendingRewards[Math.min(call, pendingRewards.length - 1)];
      call += 1;
      return value;
    }),
    getChainId: vi.fn().mockResolvedValue(84532),
    // Same value for every blockTag -> pending === latest -> no
    // stuck-nonce-recovery detour (see recoverStuckNonceIfNeeded, tx-retry.ts).
    getTransactionCount: vi.fn().mockResolvedValue(9),
    waitForTransactionReceipt: vi.fn(async () => {
      callLog.push('waitForTransactionReceipt');
      return { status: 'success' };
    }),
  } as unknown as PublicClient;
}

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

  it('broadcasts a real claim through the production send path and records it in the Store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'admin-claim-broadcast-'));
    const fleetStore = await seedFleetStore(join(root, 'earning'));
    const jinnStore = new Store(':memory:');
    const callLog: string[] = [];
    // F5: the route must supply its own origin label ('admin-route') on the
    // resulting activity-feed log line, distinct from the CLI's
    // ('claim-rewards') and the loop's ('reward-claim'). `emitEvent` writes
    // that label to stderr/the file logger as `component`, not to a DB
    // column — spy on stderr to prove it flowed through.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const ctx: ClaimRewardsRouteContext = {
        publicClient: fakePublicClient(callLog, [5n]),
        masterWallet: fakeMasterWallet(callLog),
        fleetStore,
        chain: 'base-sepolia',
        distributorAddress: DISTRIBUTOR,
        jinnStore,
      };
      const app = makeApp({ current: ctx });

      const res = await app.request('/api/admin/claim-rewards', { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        result: { submitted: number; claims: Array<{ txHash: string; amountWei: string }> };
      };
      expect(body.ok).toBe(true);
      expect(body.result.submitted).toBe(1);
      expect(body.result.claims).toEqual([
        expect.objectContaining({ txHash: '0xhash1', amountWei: '5' }),
      ]);
      expect(callLog).toEqual(['readContract', 'sendTransaction', 'waitForTransactionReceipt']);

      const claimed = jinnStore.getClaimedRewardsByService();
      expect(Object.keys(claimed)).toHaveLength(1);
      expect(claimed[0]).toMatchObject({ total: '5' });

      const rewardClaimedLine = stderrSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('"kind":"reward_claimed"'));
      expect(rewardClaimedLine).toBeDefined();
      expect(JSON.parse(rewardClaimedLine!)).toMatchObject({ component: 'admin-route' });
    } finally {
      stderrSpy.mockRestore();
      jinnStore.close();
    }
  });

  describe('F1 concurrency: two callers racing the same tick', () => {
    it('serializes ticks instead of both passing the pre-read before either sends', async () => {
      const root = mkdtempSync(join(tmpdir(), 'admin-claim-race-'));
      const fleetStore = await seedFleetStore(join(root, 'earning'));
      const jinnStore = new Store(':memory:');
      const callLog: string[] = [];
      try {
        // First tick's pre-read observes the pending reward (5n); by the
        // time the second (queued) tick's pre-read runs, the on-chain
        // reward is already claimed (0n). Pre-fix, both concurrent ticks'
        // pre-reads would race and both see 5n -- the nonce lock would then
        // serialize the sends, and the second send would revert against an
        // already-zero reward (wasted gas; a 500 under strict:true for a
        // claim that actually succeeded).
        const publicClient = fakePublicClient(callLog, [5n, 0n]);
        const masterWallet = fakeMasterWallet(callLog);
        const ctx: ClaimRewardsRouteContext = {
          publicClient,
          masterWallet,
          fleetStore,
          chain: 'base-sepolia',
          distributorAddress: DISTRIBUTOR,
          jinnStore,
        };
        const app = makeApp({ current: ctx });

        const [res1, res2] = await Promise.all([
          app.request('/api/admin/claim-rewards', { method: 'POST' }),
          app.request('/api/admin/claim-rewards', { method: 'POST' }),
        ]);
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);
        const [body1, body2] = (await Promise.all([res1.json(), res2.json()])) as Array<{
          ok: boolean;
          result: { submitted: number; skippedNoPending: number };
        }>;
        expect(body1.ok).toBe(true);
        expect(body2.ok).toBe(true);

        // Both ticks ran their own full pre-read (neither call was deduped
        // away) — exactly one found a nonzero reward and submitted; the
        // other correctly observed the post-claim state and skipped.
        expect([body1.result.submitted, body2.result.submitted].sort()).toEqual([0, 1]);
        expect([body1.result.skippedNoPending, body2.result.skippedNoPending].sort()).toEqual([0, 1]);

        // And they never interleaved: the second tick's readContract call
        // only happens after the first tick's full send+receipt cycle
        // completes -- one unbroken run per tick, never two pre-reads back
        // to back.
        expect(callLog).toEqual([
          'readContract',
          'sendTransaction',
          'waitForTransactionReceipt',
          'readContract',
        ]);

        const claimed = jinnStore.getClaimedRewardsByService();
        expect(Object.keys(claimed)).toHaveLength(1);
        expect(claimed[0]).toMatchObject({ total: '5' });
      } finally {
        jinnStore.close();
      }
    });
  });

  describe('regression: a live daemon.pid has no effect on the route', () => {
    let earningDir: string;
    let prevEarningDir: string | undefined;
    let killSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      const root = mkdtempSync(join(tmpdir(), 'admin-claim-guard-'));
      earningDir = join(root, 'earning');
      mkdirSync(earningDir, { recursive: true });
      // A daemon.pid that `checkDaemonGuard` (the CLI-only guard) classifies
      // as a confirmed-live jinn daemon.
      writeFileSync(join(earningDir, 'daemon.pid'), '987654\n', 'utf-8');
      // Wire JINN_EARNING_DIR at the SAME directory holding the planted
      // pidfile, so `checkDaemonGuard({earningDir: config.earningDir})`
      // would genuinely trip if this route ever regressed back to building
      // a CLI signer context -- the assertion at the end of the test proves
      // the fixture is real, not decorative.
      prevEarningDir = process.env['JINN_EARNING_DIR'];
      process.env['JINN_EARNING_DIR'] = earningDir;
      __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
      killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    });

    afterEach(() => {
      killSpy.mockRestore();
      __resetExecSyncForTesting();
      if (prevEarningDir === undefined) delete process.env['JINN_EARNING_DIR'];
      else process.env['JINN_EARNING_DIR'] = prevEarningDir;
    });

    it('broadcasts (completes the claim tick) instead of returning a daemon-guard envelope', async () => {
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

        // Prove the fixture is live: the CLI-only guard, pointed at the
        // exact same earningDir, really does classify it as blocked.
        const guard = checkDaemonGuard({ earningDir });
        expect(guard.blocked).toBe(true);
      } finally {
        jinnStore.close();
      }
    });
  });
});
