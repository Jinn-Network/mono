/**
 * Cost-assertion coverage for the shared ~3s-TTL gather/assemble cache (issue #2408, PR #2424
 * review finding F3). Uses an injectable `now()` (equivalent to fake timers for this module's
 * purposes — the cache only ever consults `now()`, never the real clock) so TTL expiry is
 * deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import type { GatheredStatusRaw } from '../../src/api/status-build.js';
import type { StatusV1Response } from '../../src/api/contract/status.js';
import {
  getCachedGatheredStatus,
  invalidateGatheredStatusCache,
} from '../../src/api/gathered-status-cache.js';

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

function minimalAssembled(): StatusV1Response {
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
  } as StatusV1Response;
}

describe('getCachedGatheredStatus', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
    invalidateGatheredStatusCache();
  });

  afterEach(() => {
    store.close();
    invalidateGatheredStatusCache();
  });

  it('two calls within the TTL window trigger exactly one underlying gather', async () => {
    const gatherRaw = vi.fn(async () => minimalRaw());
    const assemble = vi.fn(() => minimalAssembled());
    let nowMs = 1_000_000;

    await getCachedGatheredStatus(store, undefined, { gatherRaw, assemble, now: () => nowMs, ttlMs: 3000 });
    nowMs += 1500; // still within the 3s TTL
    await getCachedGatheredStatus(store, undefined, { gatherRaw, assemble, now: () => nowMs, ttlMs: 3000 });

    expect(gatherRaw).toHaveBeenCalledTimes(1);
    expect(assemble).toHaveBeenCalledTimes(1);
  });

  it('a third call after TTL expiry triggers a second underlying gather', async () => {
    const gatherRaw = vi.fn(async () => minimalRaw());
    const assemble = vi.fn(() => minimalAssembled());
    let nowMs = 1_000_000;

    await getCachedGatheredStatus(store, undefined, { gatherRaw, assemble, now: () => nowMs, ttlMs: 3000 });
    nowMs += 1500;
    await getCachedGatheredStatus(store, undefined, { gatherRaw, assemble, now: () => nowMs, ttlMs: 3000 });
    nowMs += 2000; // total 3500ms since the first gather — past the 3s TTL
    await getCachedGatheredStatus(store, undefined, { gatherRaw, assemble, now: () => nowMs, ttlMs: 3000 });

    expect(gatherRaw).toHaveBeenCalledTimes(2);
    expect(assemble).toHaveBeenCalledTimes(2);
  });

  it('returns independent clones — mutating one caller\'s result never leaks into the next read', async () => {
    const gatherRaw = vi.fn(async () => minimalRaw());
    const assemble = vi.fn(() => minimalAssembled());
    let nowMs = 2_000_000;

    const first = await getCachedGatheredStatus(store, undefined, { gatherRaw, assemble, now: () => nowMs });
    // Mutate top-level fields the way rewards-endpoint.ts / gather-status.ts's tail
    // enrichments do in production.
    (first.raw as GatheredStatusRaw).pendingStakingRewardsWei = 'mutated';
    (first.assembled as StatusV1Response & { spend?: unknown }).spend = { mutated: true };

    nowMs += 100; // still within TTL — second call is a cache hit
    const second = await getCachedGatheredStatus(store, undefined, { gatherRaw, assemble, now: () => nowMs });

    expect(second.raw.pendingStakingRewardsWei).toBeUndefined();
    expect((second.assembled as StatusV1Response & { spend?: unknown }).spend).toBeUndefined();
    expect(gatherRaw).toHaveBeenCalledTimes(1);
  });

  it('falls back to the real gatherGatheredStatusRaw / assembleStatusV1 when no overrides are supplied', async () => {
    const result = await getCachedGatheredStatus(store, undefined);
    expect(result.raw.dbPath).toBe(store.path);
    expect(result.assembled.statusMode).toBe('sqlite_only');
  });

  // ── Single-flight (review round 2 finding N1) ──────────────────────────────────────────────

  it('concurrent callers on a cache miss share exactly one underlying gather (single-flight)', async () => {
    let resolveGather!: (raw: GatheredStatusRaw) => void;
    const gatherRaw = vi.fn(
      () => new Promise<GatheredStatusRaw>((resolve) => { resolveGather = resolve; }),
    );
    const assemble = vi.fn(() => minimalAssembled());

    // Three concurrent callers, all before the gather resolves.
    const p1 = getCachedGatheredStatus(store, undefined, { gatherRaw, assemble });
    const p2 = getCachedGatheredStatus(store, undefined, { gatherRaw, assemble });
    const p3 = getCachedGatheredStatus(store, undefined, { gatherRaw, assemble });

    expect(gatherRaw).toHaveBeenCalledTimes(1);

    resolveGather(minimalRaw());
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(gatherRaw).toHaveBeenCalledTimes(1);
    expect(assemble).toHaveBeenCalledTimes(1);
    // Every caller gets its own clone, all sourced from the one gather.
    expect(r1.raw).not.toBe(r2.raw);
    expect(r1.raw).toEqual(r2.raw);
    expect(r2.raw).toEqual(r3.raw);
  });

  it('a rejected gather does not poison future calls — the next call retries fresh', async () => {
    const gatherRaw = vi
      .fn<() => Promise<GatheredStatusRaw>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(minimalRaw());
    const assemble = vi.fn(() => minimalAssembled());

    await expect(getCachedGatheredStatus(store, undefined, { gatherRaw, assemble })).rejects.toThrow('boom');
    // The in-flight slot must have been cleared on rejection, not left wedged.
    const result = await getCachedGatheredStatus(store, undefined, { gatherRaw, assemble });
    expect(result.raw).toBeDefined();
    expect(gatherRaw).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers during an in-flight gather that then rejects all see the same rejection, and the next call after that retries fresh', async () => {
    let rejectGather!: (err: Error) => void;
    const gatherRaw = vi
      .fn<() => Promise<GatheredStatusRaw>>()
      .mockImplementationOnce(
        () => new Promise<GatheredStatusRaw>((_resolve, reject) => { rejectGather = reject; }),
      )
      .mockResolvedValueOnce(minimalRaw());
    const assemble = vi.fn(() => minimalAssembled());

    const p1 = getCachedGatheredStatus(store, undefined, { gatherRaw, assemble });
    const p2 = getCachedGatheredStatus(store, undefined, { gatherRaw, assemble });
    expect(gatherRaw).toHaveBeenCalledTimes(1);

    rejectGather(new Error('boom'));
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');

    const result = await getCachedGatheredStatus(store, undefined, { gatherRaw, assemble });
    expect(result.raw).toBeDefined();
    expect(gatherRaw).toHaveBeenCalledTimes(2);
  });
});
