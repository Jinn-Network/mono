/**
 * Integration test for `GET /v1/notifications` (issue #2408, spec §6.5; PR #2424 review
 * findings F1/F2/F3/F4). Uses the same dependency-injection pattern as
 * `test/api/rewards-endpoint.test.ts` (`gatherRaw` / `assemble` overrides) so the test controls
 * exactly what `GatheredStatusRaw` / `StatusV1Response` the handler sees, without needing a
 * real RPC client or fleet state on disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { addNotificationsRoutes } from '../../src/api/notifications-endpoint.js';
import { Store } from '../../src/store/store.js';
import type { GatheredStatusRaw } from '../../src/api/status-build.js';
import type { StatusV1Response } from '../../src/api/contract/status.js';
import { getEventBuffer, emitStructured } from '../../src/events/emitter.js';
import { invalidateGatheredStatusCache } from '../../src/api/gathered-status-cache.js';
import { markRestartRequired, resetRestartRequiredForTest } from '../../src/api/restart-required-state.js';

function minimalRaw(overrides: Partial<GatheredStatusRaw> = {}): GatheredStatusRaw {
  return {
    shutdownState: null,
    dbPath: ':memory:',
    activityCounts: {},
    recentActivity: [],
    lastRewardClaimTickAt: null,
    rewardClaimIntervalMs: 0,
    fleet: null,
    rpc: { ok: true },
    master: { address: null },
    pollIntervalMs: 5000,
    masterDailyEstimateWei: '0',
    ...overrides,
  };
}

function minimalAssembled(overrides: Partial<StatusV1Response> = {}): StatusV1Response {
  return {
    contractVersion: { major: 1, minor: 0 },
    statusMode: 'full',
    version: '0.1.5',
    effectiveMode: 'legacy',
    latestVersion: null,
    daemon: { shutdownState: null, startedAt: null, timestamp: new Date().toISOString() },
    rpc: { ok: true },
    fleet: { loaded: false, services: [], stakedLikeCount: 0, completeCount: 0 },
    autoRestake: { enabled: false, checkIntervalMs: 0 },
    activity: { counts: {}, recent: [] },
    rewards: { claimLoopIntervalMs: 0, lastClaimTickAt: null, claimedStakingRewardsWei: '0', claimedStakingRewardsLast24hWei: null },
    balances: { eth: { master: { address: null, balanceWei: null }, agent: { address: null, balanceWei: null }, safe: { address: null, balanceWei: null } } },
    masterGas: { address: null, dailyEstimateWei: '0' },
    earnings: { hint: '' },
    nextActions: [],
    costSurface: {} as StatusV1Response['costSurface'],
    harness: { ready: true, name: null, reason: null },
    security: { lastPasswordRotationAt: null },
    ...overrides,
  } as StatusV1Response;
}

describe('GET /v1/notifications', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
    getEventBuffer().clear();
    // The shared gather/assemble cache (gathered-status-cache.ts, review finding F3) is a
    // process-wide singleton — without clearing it, a later test in this file would silently
    // reuse an earlier test's cached raw/assembled instead of calling its own injected
    // gatherRaw/assemble overrides.
    invalidateGatheredStatusCache();
    resetRestartRequiredForTest();
  });

  afterEach(() => {
    store.close();
    getEventBuffer().clear();
    invalidateGatheredStatusCache();
    resetRestartRequiredForTest();
  });

  it('returns an empty, healthy payload with the envelope fields', async () => {
    const app = new Hono();
    addNotificationsRoutes(app, {
      store,
      getStatus: () => undefined,
      // A running-mode fleet (every service operational) + a joined SolverNet so
      // bootstrap_blocked / no_solvernets_joined don't fire — isolates this test to the
      // envelope shape, not the bootstrap-mode derivation (covered separately below).
      gatherRaw: async () =>
        minimalRaw({ fleet: { services: [{ step: 'complete' }] } as unknown as GatheredStatusRaw['fleet'] }),
      assemble: () => minimalAssembled(),
      getBootstrapExtras: () => ({ executionWiring: [{ workKind: 'cid1' }] }),
    });

    const res = await app.request('/v1/notifications');
    expect(res.status).toBe(200);
    const body = await res.json() as { schemaVersion: number; generatedAt: string; notifications: unknown[] };
    expect(body.schemaVersion).toBe(1);
    expect(typeof body.generatedAt).toBe('string');
    expect(body.notifications).toEqual([]);
  });

  it('derives bootstrap_blocked from raw.fleet (no services ⇒ not running)', async () => {
    const app = new Hono();
    addNotificationsRoutes(app, {
      store,
      getStatus: () => undefined,
      gatherRaw: async () => minimalRaw({ fleet: { services: [] } as unknown as GatheredStatusRaw['fleet'] }),
      assemble: () => minimalAssembled(),
    });

    const res = await app.request('/v1/notifications');
    const body = await res.json() as { notifications: Array<{ kind: string }> };
    expect(body.notifications.map((n) => n.kind)).toContain('bootstrap_blocked');
  });

  it('derives running mode (no bootstrap_blocked) when every service is operational', async () => {
    const app = new Hono();
    addNotificationsRoutes(app, {
      store,
      getStatus: () => undefined,
      gatherRaw: async () =>
        minimalRaw({ fleet: { services: [{ step: 'complete' }] } as unknown as GatheredStatusRaw['fleet'] }),
      assemble: () => minimalAssembled(),
      getBootstrapExtras: () => ({ executionWiring: [{ workKind: 'cid1' }] }),
    });

    const res = await app.request('/v1/notifications');
    const body = await res.json() as { notifications: Array<{ kind: string }> };
    expect(body.notifications.map((n) => n.kind)).not.toContain('bootstrap_blocked');
    expect(body.notifications.map((n) => n.kind)).not.toContain('no_solvernets_joined');
  });

  it('emits rpc_all_failed from getBootstrapExtras.rpcSlotHealth when every slot failed AND the live read also fails (review finding F2)', async () => {
    const app = new Hono();
    addNotificationsRoutes(app, {
      store,
      getStatus: () => undefined,
      gatherRaw: async () => minimalRaw({ rpc: { ok: false } }),
      assemble: () => minimalAssembled({ rpc: { ok: false } }),
      getBootstrapExtras: () => ({
        rpcSlotHealth: [
          { ok: false, host: 'primary.example' },
          { ok: false, host: 'secondary.example' },
        ],
      }),
    });

    const res = await app.request('/v1/notifications');
    const body = await res.json() as { notifications: Array<{ kind: string; severity: string }> };
    const kinds = body.notifications.map((n) => n.kind);
    expect(kinds).toContain('rpc_all_failed');
    expect(body.notifications.find((n) => n.kind === 'rpc_all_failed')?.severity).toBe('blocking');
  });

  it('does NOT emit rpc_all_failed on boot-probe-only evidence when the live read is healthy (review finding F2)', async () => {
    const app = new Hono();
    addNotificationsRoutes(app, {
      store,
      getStatus: () => undefined,
      gatherRaw: async () => minimalRaw({ rpc: { ok: true } }),
      assemble: () => minimalAssembled({ rpc: { ok: true } }),
      getBootstrapExtras: () => ({
        rpcSlotHealth: [
          { ok: false, host: 'primary.example' },
          { ok: false, host: 'secondary.example' },
        ],
      }),
    });

    const res = await app.request('/v1/notifications');
    const body = await res.json() as { notifications: Array<{ kind: string }> };
    expect(body.notifications.map((n) => n.kind)).not.toContain('rpc_all_failed');
  });

  it('does NOT emit rpc_unreachable server-side (review finding F4)', async () => {
    const app = new Hono();
    addNotificationsRoutes(app, {
      store,
      getStatus: () => undefined,
      gatherRaw: async () => minimalRaw({ rpc: { ok: false } }),
      assemble: () => minimalAssembled({ rpc: { ok: false } }),
    });

    const res = await app.request('/v1/notifications');
    const body = await res.json() as { notifications: Array<{ kind: string }> };
    expect(body.notifications.map((n) => n.kind)).not.toContain('rpc_unreachable');
  });

  it('sorts blocking-first then warning then info', async () => {
    const app = new Hono();
    addNotificationsRoutes(app, {
      store,
      getStatus: () => undefined,
      gatherRaw: async () =>
        minimalRaw({
          fleet: { services: [] } as unknown as GatheredStatusRaw['fleet'],
          version: '0.1.5',
        }),
      assemble: () => minimalAssembled({ latestVersion: '0.1.6', version: '0.1.5' }),
    });

    const res = await app.request('/v1/notifications');
    const body = await res.json() as { notifications: Array<{ severity: string }> };
    const severityOrder: Record<string, number> = { blocking: 0, warning: 1, info: 2 };
    const severities = body.notifications.map((n) => severityOrder[n.severity]);
    expect(severities).toEqual([...severities].sort((a, b) => a - b));
  });

  // ── restart_required — explicit flag, not mtime (review finding F1) ───────────────────────

  it('restart_required fires when the shared restart-required flag is set', async () => {
    markRestartRequired();

    const app = new Hono();
    addNotificationsRoutes(app, {
      store,
      getStatus: () => undefined,
      gatherRaw: async () => minimalRaw(),
      assemble: () => minimalAssembled(),
    });

    const res = await app.request('/v1/notifications');
    const body = await res.json() as { notifications: Array<{ kind: string }> };
    expect(body.notifications.map((n) => n.kind)).toContain('restart_required');
  });

  it('restart_required stays silent when the flag was never set', async () => {
    const app = new Hono();
    addNotificationsRoutes(app, {
      store,
      getStatus: () => undefined,
      gatherRaw: async () => minimalRaw(),
      assemble: () => minimalAssembled(),
    });

    const res = await app.request('/v1/notifications');
    const body = await res.json() as { notifications: Array<{ kind: string }> };
    expect(body.notifications.map((n) => n.kind)).not.toContain('restart_required');
  });

  it('derives claim_failed from the live event ring, within the 30-minute window', async () => {
    emitStructured({ kind: 'intent', message: 'Task claim failed', errorCode: 'claim_failed' });

    const app = new Hono();
    addNotificationsRoutes(app, {
      store,
      getStatus: () => undefined,
      gatherRaw: async () => minimalRaw(),
      assemble: () => minimalAssembled(),
    });

    const res = await app.request('/v1/notifications');
    const body = await res.json() as { notifications: Array<{ kind: string; message: string }> };
    const cf = body.notifications.find((n) => n.kind === 'claim_failed');
    expect(cf).toBeDefined();
    expect(cf!.message).toContain('1 claim attempt');
  });

  it('masks a thrown error message and still returns a well-formed envelope', async () => {
    const app = new Hono();
    addNotificationsRoutes(app, {
      store,
      getStatus: () => undefined,
      gatherRaw: async () => {
        throw new Error('boom https://user:secret@example.com/rpc');
      },
    });

    const res = await app.request('/v1/notifications');
    expect(res.status).toBe(500);
    const body = await res.json() as { notifications: unknown[]; error?: string };
    expect(body.notifications).toEqual([]);
    expect(body.error).not.toContain('secret');
  });
});
