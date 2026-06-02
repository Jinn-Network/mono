/**
 * Tests for `withFallback` — the DiscoveryAPI health-tracking fallback wrapper.
 *
 * Covers:
 * - Primary success → floor not called
 * - Primary throws DiscoveryUnavailableError → floor called, result returned
 * - Primary throws network-shaped error → floor called
 * - After unhealthyThreshold consecutive failures, primary skipped until
 *   retryAfterMs elapses (fake timers)
 * - After retryAfterMs, primary is probed again
 * - console.warn emitted exactly once on entering degraded mode
 * - All four DiscoveryAPI methods exercised through the wrapper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withFallback, type WithFallbackOptions } from '../../src/discovery/with-fallback.js';
import {
  DiscoveryUnavailableError,
  type DiscoveryAPI,
  type ClaimableTaskCandidate,
  type SolverNetManifestSummary,
  type SolverNetLifecycleStatus,
  type EnvelopeRef,
} from '../../src/discovery/types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const OPERATOR_ADDRESS = `0x${'ab'.repeat(20)}` as `0x${string}`;

const TASK_CANDIDATE: ClaimableTaskCandidate = {
  taskId: '1',
  taskCidDigest: `0x${'11'.repeat(32)}`,
  manifestDigest: `0x${'22'.repeat(32)}`,
  attemptCount: 0,
  operatorAttemptCount: 0,
};

const SOLVER_NET_SUMMARY: SolverNetManifestSummary = {
  manifestCid: 'bafyTest',
  solverNetId: 'sn-001',
  name: 'Test SolverNet',
  network: 'base',
  launcherAgentId: '42',
  launcherSafeAddress: `0x${'cc'.repeat(20)}`,
  status: 'launched',
  statusUpdatedAt: '2026-05-11T00:00:00Z',
  contractId: 'jinn-router-v3',
  contractVersion: '3.0.0',
  solutionPriceWei: '1000000000000000',
  verdictPriceWei: '500000000000000',
  openRoles: ['solver'],
  anchorBlock: 12345678,
};

const LIFECYCLE_STATUS: SolverNetLifecycleStatus = {
  status: 'launched',
  statusUpdatedAt: '2026-05-11T00:00:00Z',
  sourceBlock: 12345678,
};

const ENVELOPE_REF: EnvelopeRef = {
  manifestCid: 'bafyEnvelope',
  manifestHash: '0x' + 'aa'.repeat(32),
  operator: { agentId: '99', safeAddress: `0x${'dd'.repeat(20)}` },
  evidenceTier: 'committed',
  publishedAt: 1715385600,
};

// ── Stub builder ─────────────────────────────────────────────────────────────

type MethodName = keyof DiscoveryAPI;

/**
 * Returns a stub DiscoveryAPI where each method resolves immediately. Pass
 * `overrides` to replace specific methods with mocks or throwing fns.
 */
function makeStub(overrides?: Partial<Record<MethodName, DiscoveryAPI[MethodName]>>): DiscoveryAPI {
  const defaults: DiscoveryAPI = {
    findClaimableTasks: vi.fn(async () => [TASK_CANDIDATE]),
    listLaunchedSolverNets: vi.fn(async () => [SOLVER_NET_SUMMARY]),
    getLifecycleStatus: vi.fn(async () => LIFECYCLE_STATUS),
    getSolverNetOperatorCount: vi.fn(async () => 1),
    queryEnvelopes: vi.fn(async () => [ENVELOPE_REF]),
  } as unknown as DiscoveryAPI;
  return { ...defaults, ...(overrides ?? {}) };
}

/**
 * Returns a stub where every method throws the given error.
 */
function makeThrowingStub(error: Error): DiscoveryAPI {
  return {
    findClaimableTasks: vi.fn(async () => { throw error; }),
    listLaunchedSolverNets: vi.fn(async () => { throw error; }),
    getLifecycleStatus: vi.fn(async () => { throw error; }),
    getSolverNetOperatorCount: vi.fn(async () => { throw error; }),
    queryEnvelopes: vi.fn(async () => { throw error; }),
  } as unknown as DiscoveryAPI;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWrapper(
  primary: DiscoveryAPI,
  floor: DiscoveryAPI,
  opts?: WithFallbackOptions,
): DiscoveryAPI {
  return withFallback(primary, floor, opts);
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withFallback — basic routing', () => {
  it('returns primary result and does not call floor on success', async () => {
    const primary = makeStub();
    const floor = makeStub();
    const api = makeWrapper(primary, floor);

    const result = await api.findClaimableTasks({
      solverNetManifestCids: ['bafyA'],
      operatorAddress: OPERATOR_ADDRESS,
    });

    expect(result).toEqual([TASK_CANDIDATE]);
    expect(floor.findClaimableTasks).not.toHaveBeenCalled();
  });

  it('routes to floor and returns floor result when primary throws DiscoveryUnavailableError', async () => {
    const error = new DiscoveryUnavailableError('indexer down');
    const primary = makeThrowingStub(error);
    const floorResult: ClaimableTaskCandidate[] = [];
    const floor = makeStub({ findClaimableTasks: vi.fn(async () => floorResult) });
    const api = makeWrapper(primary, floor);

    const result = await api.findClaimableTasks({
      solverNetManifestCids: ['bafyA'],
      operatorAddress: OPERATOR_ADDRESS,
    });

    expect(result).toBe(floorResult);
    expect(floor.findClaimableTasks).toHaveBeenCalledOnce();
  });

  it('routes to floor when primary throws a "fetch failed" network error', async () => {
    const error = new Error('fetch failed');
    const primary = makeThrowingStub(error);
    const floor = makeStub();
    const api = makeWrapper(primary, floor);

    await api.findClaimableTasks({
      solverNetManifestCids: ['bafyA'],
      operatorAddress: OPERATOR_ADDRESS,
    });

    expect(floor.findClaimableTasks).toHaveBeenCalledOnce();
  });

  it('routes to floor when primary throws a timeout error', async () => {
    const error = new Error('request timed out');
    const primary = makeThrowingStub(error);
    const floor = makeStub();
    const api = makeWrapper(primary, floor);

    await api.findClaimableTasks({
      solverNetManifestCids: [],
      operatorAddress: OPERATOR_ADDRESS,
    });

    expect(floor.findClaimableTasks).toHaveBeenCalledOnce();
  });

  it('routes to floor when primary throws an error with code SERVER_ERROR and no matching message', async () => {
    // Simulates viem/RPC errors that carry a `.code` property but whose `.message`
    // does not include any of the substring checks — proves the code-based path is reached.
    const error = Object.assign(new Error('something opaque'), { code: 'SERVER_ERROR' });
    const primary = makeThrowingStub(error);
    const floor = makeStub();
    const api = makeWrapper(primary, floor);

    await api.findClaimableTasks({ solverNetManifestCids: [], operatorAddress: OPERATOR_ADDRESS });

    expect(floor.findClaimableTasks).toHaveBeenCalledOnce();
  });

  it('propagates non-network errors from the primary without calling floor', async () => {
    const error = new TypeError('unexpected schema change');
    const primary = makeThrowingStub(error);
    const floor = makeStub();
    const api = makeWrapper(primary, floor);

    await expect(
      api.findClaimableTasks({ solverNetManifestCids: [], operatorAddress: OPERATOR_ADDRESS }),
    ).rejects.toThrow('unexpected schema change');

    expect(floor.findClaimableTasks).not.toHaveBeenCalled();
  });
});

describe('withFallback — degraded mode', () => {
  it('marks primary unhealthy and skips it after unhealthyThreshold consecutive failures', async () => {
    vi.useFakeTimers();
    const THRESHOLD = 3;
    const error = new DiscoveryUnavailableError('down');
    const primary = makeThrowingStub(error);
    const floor = makeStub();
    const api = makeWrapper(primary, floor, { unhealthyThreshold: THRESHOLD, retryAfterMs: 60_000 });

    // Three calls to hit the threshold.
    for (let i = 0; i < THRESHOLD; i++) {
      await api.findClaimableTasks({ solverNetManifestCids: [], operatorAddress: OPERATOR_ADDRESS });
    }

    // After threshold, primary should be skipped.
    vi.clearAllMocks();
    await api.findClaimableTasks({ solverNetManifestCids: [], operatorAddress: OPERATOR_ADDRESS });

    expect(primary.findClaimableTasks).not.toHaveBeenCalled();
    expect(floor.findClaimableTasks).toHaveBeenCalledOnce();
  });

  it('re-engages primary after retryAfterMs has elapsed', async () => {
    vi.useFakeTimers();
    const THRESHOLD = 3;
    const RETRY_MS = 60_000;
    const error = new DiscoveryUnavailableError('down');
    const primary = makeThrowingStub(error);
    const floor = makeStub();
    const api = makeWrapper(primary, floor, { unhealthyThreshold: THRESHOLD, retryAfterMs: RETRY_MS });

    // Exhaust threshold.
    for (let i = 0; i < THRESHOLD; i++) {
      await api.findClaimableTasks({ solverNetManifestCids: [], operatorAddress: OPERATOR_ADDRESS });
    }

    // Advance time past retry window.
    vi.advanceTimersByTime(RETRY_MS + 1);

    // Reset mocks so we can observe who gets called on the next call.
    vi.clearAllMocks();

    // Primary is now healthy-again stub (succeeds).
    const workingPrimary: DiscoveryAPI = {
      ...primary,
      findClaimableTasks: vi.fn(async () => [TASK_CANDIDATE]),
    };
    // We need a fresh withFallback referencing the new primary? No — the
    // original primary stub still throws. The point is that the wrapper
    // *attempts* the primary. Let's verify it calls primary again.

    // Re-stub to resolve on next attempt so we can confirm the probe happened.
    (primary.findClaimableTasks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    await api.findClaimableTasks({ solverNetManifestCids: [], operatorAddress: OPERATOR_ADDRESS });

    expect(primary.findClaimableTasks).toHaveBeenCalledOnce();
  });

  it('re-degrades immediately when the post-window probe fails with a network error', async () => {
    vi.useFakeTimers();
    const THRESHOLD = 3;
    const RETRY_MS = 60_000;
    const netErr = new DiscoveryUnavailableError('down');
    // Primary fails on every call (probe included).
    const primary = makeThrowingStub(netErr);
    const floor = makeStub();
    const api = makeWrapper(primary, floor, { unhealthyThreshold: THRESHOLD, retryAfterMs: RETRY_MS });

    // Exhaust the threshold → degraded.
    for (let i = 0; i < THRESHOLD; i++) {
      await api.findClaimableTasks({ solverNetManifestCids: [], operatorAddress: OPERATOR_ADDRESS });
    }

    // Advance past the retry window so the next call is a probe.
    vi.advanceTimersByTime(RETRY_MS + 1);
    vi.clearAllMocks();

    // Probe call — primary is attempted and fails with a network error.
    await api.findClaimableTasks({ solverNetManifestCids: [], operatorAddress: OPERATOR_ADDRESS });
    expect(primary.findClaimableTasks).toHaveBeenCalledOnce();
    expect(floor.findClaimableTasks).toHaveBeenCalledOnce();

    // Next call must route straight to the floor again — the failed probe
    // re-degraded immediately, without needing `unhealthyThreshold` more failures.
    vi.clearAllMocks();
    await api.findClaimableTasks({ solverNetManifestCids: [], operatorAddress: OPERATOR_ADDRESS });
    expect(primary.findClaimableTasks).not.toHaveBeenCalled();
    expect(floor.findClaimableTasks).toHaveBeenCalledOnce();
  });

  it('emits console.warn exactly once when entering degraded mode', async () => {
    vi.useFakeTimers();
    const THRESHOLD = 2;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = new DiscoveryUnavailableError('down');
    const primary = makeThrowingStub(error);
    const floor = makeStub();
    const api = makeWrapper(primary, floor, { unhealthyThreshold: THRESHOLD, retryAfterMs: 60_000 });

    // Call enough times to trigger degraded mode and then some.
    for (let i = 0; i < THRESHOLD + 3; i++) {
      await api.findClaimableTasks({ solverNetManifestCids: [], operatorAddress: OPERATOR_ADDRESS });
    }

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('unhealthy');
  });
});

describe('withFallback — all four methods', () => {
  /**
   * Parameterized check: each method on the wrapper routes to the floor when
   * the primary throws DiscoveryUnavailableError.
   */
  const ERROR = new DiscoveryUnavailableError('unavailable');

  it('findClaimableTasks routes to floor on DiscoveryUnavailableError', async () => {
    const primary = makeThrowingStub(ERROR);
    const floor = makeStub();
    const api = makeWrapper(primary, floor);

    const result = await api.findClaimableTasks({
      solverNetManifestCids: ['bafyA'],
      operatorAddress: OPERATOR_ADDRESS,
    });

    expect(result).toEqual([TASK_CANDIDATE]);
    expect(floor.findClaimableTasks).toHaveBeenCalledOnce();
  });

  it('listLaunchedSolverNets routes to floor on DiscoveryUnavailableError', async () => {
    const primary = makeThrowingStub(ERROR);
    const floor = makeStub();
    const api = makeWrapper(primary, floor);

    const result = await api.listLaunchedSolverNets({ launcherAgentId: '42' });

    expect(result).toEqual([SOLVER_NET_SUMMARY]);
    expect(floor.listLaunchedSolverNets).toHaveBeenCalledOnce();
  });

  it('getLifecycleStatus routes to floor on DiscoveryUnavailableError', async () => {
    const primary = makeThrowingStub(ERROR);
    const floor = makeStub();
    const api = makeWrapper(primary, floor);

    const result = await api.getLifecycleStatus('bafyTest');

    expect(result).toEqual(LIFECYCLE_STATUS);
    expect(floor.getLifecycleStatus).toHaveBeenCalledOnce();
  });

  it('queryEnvelopes routes to floor on DiscoveryUnavailableError', async () => {
    const primary = makeThrowingStub(ERROR);
    const floor = makeStub();
    const api = makeWrapper(primary, floor);

    const result = await api.queryEnvelopes({ solverType: 'prediction.v0' });

    expect(result).toEqual([ENVELOPE_REF]);
    expect(floor.queryEnvelopes).toHaveBeenCalledOnce();
  });

  it('getSolverNetOperatorCount routes to floor on DiscoveryUnavailableError', async () => {
    const primary = makeThrowingStub(ERROR);
    const floor = makeStub();
    const api = makeWrapper(primary, floor);

    const result = await api.getSolverNetOperatorCount('bafkreitest');

    expect(result).toBe(1);
    expect(floor.getSolverNetOperatorCount).toHaveBeenCalledOnce();
  });

  it('does NOT fall through to floor for getInstanceSuccessCounts — propagates DiscoveryUnavailableError so launcher aborts (#669)', async () => {
    // An empty Map from the floor is indistinguishable from "all instances
    // have 0 successes", which is the under-count bug #669 fixes. The wrapper
    // must propagate DiscoveryUnavailableError so the launcher tick aborts.
    const primary = {
      getInstanceSuccessCounts: vi.fn(async () => {
        throw new DiscoveryUnavailableError('indexer down');
      }),
    } as unknown as DiscoveryAPI;
    const floor = {
      getInstanceSuccessCounts: vi.fn(async () => new Map<string, number>()),
    } as unknown as DiscoveryAPI;
    const api = makeWrapper(primary, floor);
    await expect(
      api.getInstanceSuccessCounts({ manifestCid: 'bafy' }),
    ).rejects.toBeInstanceOf(DiscoveryUnavailableError);
    expect(floor.getInstanceSuccessCounts).not.toHaveBeenCalled();
  });

  it('does NOT fall through to floor for getInstanceClaimCounts — propagates DiscoveryUnavailableError so the launcher aborts (#802)', async () => {
    // An empty Map from the floor is indistinguishable from "every task has 0
    // consumed slots", which would mark every posting `live` and suppress all
    // reposts. The wrapper must propagate the error so the launcher tick aborts.
    const primary = {
      getInstanceClaimCounts: vi.fn(async () => {
        throw new DiscoveryUnavailableError('indexer down');
      }),
    } as unknown as DiscoveryAPI;
    const floor = {
      getInstanceClaimCounts: vi.fn(async () => new Map()),
    } as unknown as DiscoveryAPI;
    const api = makeWrapper(primary, floor);
    await expect(
      api.getInstanceClaimCounts({ manifestCid: 'bafy' }),
    ).rejects.toBeInstanceOf(DiscoveryUnavailableError);
    expect(floor.getInstanceClaimCounts).not.toHaveBeenCalled();
  });

  it('getTaskPostCounts routes to floor on DiscoveryUnavailableError (supply signal, #918)', async () => {
    const floorResult = {
      windowEndBlock: 100,
      windowEndTs: 1_000,
      chain: { h1: 1, h6: 2, h24: 3, windowEndBlock: 100, windowEndTs: 1_000 },
      byCid: {},
    };
    const primary = {
      getTaskPostCounts: vi.fn(async () => {
        throw new DiscoveryUnavailableError('indexer down');
      }),
    } as unknown as DiscoveryAPI;
    const floor = {
      getTaskPostCounts: vi.fn(async () => floorResult),
    } as unknown as DiscoveryAPI;
    const api = makeWrapper(primary, floor);
    const result = await api.getTaskPostCounts();
    expect(result).toBe(floorResult);
    expect(floor.getTaskPostCounts).toHaveBeenCalledOnce();
  });
});

describe('DiscoveryUnavailableError', () => {
  it('has the expected name and message', () => {
    const err = new DiscoveryUnavailableError('test error');
    expect(err.name).toBe('DiscoveryUnavailableError');
    expect(err.message).toBe('test error');
    expect(err instanceof Error).toBe(true);
  });

  it('stores an optional cause', () => {
    const inner = new Error('root cause');
    const err = new DiscoveryUnavailableError('wrapped', inner);
    expect(err.cause).toBe(inner);
  });
});
