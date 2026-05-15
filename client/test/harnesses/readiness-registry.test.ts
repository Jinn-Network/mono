import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { HarnessReadinessRegistry } from '../../src/harnesses/readiness-registry.js';
import type { Harness, ReadyStatus } from '../../src/harnesses/types.js';

function fakeHarness(name: string, ready: ReadyStatus | (() => Promise<ReadyStatus>)): Harness {
  return {
    name,
    version: '0.0.0',
    supports: () => true,
    run: async () => { throw new Error('not used'); },
    isReady: typeof ready === 'function' ? ready : async () => ready,
  };
}

describe('HarnessReadinessRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns ready snapshot for each joined harness', async () => {
    const claude = fakeHarness('claude-code-learner', { ready: true, reason: 'ok' });
    const evaluator = fakeHarness('swe-rebench-v2-evaluator', { ready: false, reason: 'docker not running' });
    const registry = new HarnessReadinessRegistry({
      harnessesByName: { 'claude-code-learner': claude, 'swe-rebench-v2-evaluator': evaluator },
      joinedHarnessesByCid: {
        'bafkrei.claude': { harnessName: 'claude-code-learner', roles: ['solver'] },
        'bafkrei.eval': { harnessName: 'swe-rebench-v2-evaluator', roles: ['evaluator'] },
      },
      tickIntervalMs: 4000,
    });
    await registry.refreshNow();
    const snapshot = registry.getSnapshot();
    expect(snapshot.harnesses).toEqual([
      expect.objectContaining({ harnessName: 'claude-code-learner', ready: true, manifestCids: ['bafkrei.claude'] }),
      expect.objectContaining({ harnessName: 'swe-rebench-v2-evaluator', ready: false, manifestCids: ['bafkrei.eval'] }),
    ]);
  });

  it('isReadyForClaim returns ready=false for unknown manifestCid', async () => {
    const registry = new HarnessReadinessRegistry({
      harnessesByName: {},
      joinedHarnessesByCid: {},
      tickIntervalMs: 4000,
    });
    await registry.refreshNow();
    const status = registry.isReadyForClaim('bafkrei.unknown');
    expect(status.ready).toBe(false);
    expect(status.reason).toContain('not in joinedSolverNets');
  });

  it('isReadyForClaim returns cached status from last refresh', async () => {
    const claude = fakeHarness('claude-code-learner', { ready: true, reason: 'ok' });
    const registry = new HarnessReadinessRegistry({
      harnessesByName: { 'claude-code-learner': claude },
      joinedHarnessesByCid: {
        'bafkrei.claude': { harnessName: 'claude-code-learner', roles: ['solver'] },
      },
      tickIntervalMs: 4000,
    });
    await registry.refreshNow();
    expect(registry.isReadyForClaim('bafkrei.claude').ready).toBe(true);
  });

  it('treats unknown harness name as not-registered', async () => {
    const registry = new HarnessReadinessRegistry({
      harnessesByName: {},  // empty registry
      joinedHarnessesByCid: {
        'bafkrei.x': { harnessName: 'mystery-harness', roles: ['solver'] },
      },
      tickIntervalMs: 4000,
    });
    await registry.refreshNow();
    const snapshot = registry.getSnapshot();
    expect(snapshot.harnesses[0]?.ready).toBe(false);
    expect(snapshot.harnesses[0]?.reason).toContain('not registered');
  });

  it('catches isReady() exceptions and reports ready=false', async () => {
    const broken = fakeHarness('claude-code-learner', async () => {
      throw new Error('boom');
    });
    const registry = new HarnessReadinessRegistry({
      harnessesByName: { 'claude-code-learner': broken },
      joinedHarnessesByCid: {
        'bafkrei.claude': { harnessName: 'claude-code-learner', roles: ['solver'] },
      },
      tickIntervalMs: 4000,
    });
    await registry.refreshNow();
    const snapshot = registry.getSnapshot();
    expect(snapshot.harnesses[0]?.ready).toBe(false);
    expect(snapshot.harnesses[0]?.reason).toContain('isReady threw');
    expect(snapshot.harnesses[0]?.reason).toContain('boom');
  });

  // Note: start() schedules the interval but does NOT call refreshNow() immediately,
  // so counter=0 on entry; the explicit refreshNow() below drives the first read (counter→1).
  it('background tick refreshes snapshot every interval', async () => {
    let counter = 0;
    const flaky = fakeHarness('claude-code-learner', async () => ({
      ready: counter++ > 0,
      reason: counter === 1 ? 'starting up' : 'ok',
    }));
    const registry = new HarnessReadinessRegistry({
      harnessesByName: { 'claude-code-learner': flaky },
      joinedHarnessesByCid: {
        'bafkrei.claude': { harnessName: 'claude-code-learner', roles: ['solver'] },
      },
      tickIntervalMs: 4000,
    });
    registry.start();
    await registry.refreshNow();
    expect(registry.isReadyForClaim('bafkrei.claude').ready).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(registry.isReadyForClaim('bafkrei.claude').ready).toBe(true);
    registry.stop();
  });
});
