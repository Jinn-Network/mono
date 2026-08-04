import { describe, expect, it, vi } from 'vitest';
import {
  appendDailyObservation,
  deriveInstanceEntry,
  deriveVerdict,
  fetchHttpStatusSnapshot,
  readFileStatusSnapshot,
  PHASE_D_LEGACY_SIGNALS,
  type PhaseDObservationReceipt,
  type PhaseDObservationSnapshotEntry,
} from '../../src/monitoring/phase-d-observation-window.js';

function snapshot(overrides: Partial<PhaseDObservationSnapshotEntry> = {}): PhaseDObservationSnapshotEntry {
  return {
    at: '2026-08-04T00:00:00.000Z',
    observationWindowStartedAt: '2026-08-01T00:00:00.000Z',
    durable: true,
    counters: [],
    ...overrides,
  };
}

describe('PHASE_D_LEGACY_SIGNALS (#2380)', () => {
  it('does not include the native-presence signal — it is positive evidence, not a legacy-use counter', () => {
    expect(PHASE_D_LEGACY_SIGNALS).not.toContain('native-operator-composition');
    expect(PHASE_D_LEGACY_SIGNALS).toEqual([
      'legacy-operator-composition',
      'marketplace-pipeline-invocation',
      'legacy-task-submission-synthesis',
      'legacy-evaluator-delivery-watcher-loaded',
      'legacy-wiring-config-field',
    ]);
  });
});

describe('deriveInstanceEntry (#2380)', () => {
  it('is complete when every snapshot is durable and shares one baseline observationWindowStartedAt', () => {
    const entry = deriveInstanceEntry({
      instanceId: 'op-a',
      imageDigest: 'sha256:aaaa',
      reportedSourceSha: 'deadbeef',
      snapshots: [
        snapshot({ at: '2026-08-01T00:00:00.000Z' }),
        snapshot({ at: '2026-08-02T00:00:00.000Z' }),
      ],
    });
    expect(entry.complete).toBe(true);
    expect(entry.resets).toBe(0);
  });

  it('is incomplete with no snapshots at all', () => {
    const entry = deriveInstanceEntry({
      instanceId: 'op-a', imageDigest: null, reportedSourceSha: null, snapshots: [],
    });
    expect(entry.complete).toBe(false);
    expect(entry.resets).toBe(0);
  });

  it('a missing/corrupt snapshot (durable: false or null observationWindowStartedAt) invalidates the window', () => {
    const missingFetch = deriveInstanceEntry({
      instanceId: 'op-a', imageDigest: null, reportedSourceSha: null,
      snapshots: [
        snapshot(),
        snapshot({ at: '2026-08-02T00:00:00.000Z', observationWindowStartedAt: null, durable: false }),
      ],
    });
    expect(missingFetch.complete).toBe(false);

    const notDurable = deriveInstanceEntry({
      instanceId: 'op-a', imageDigest: null, reportedSourceSha: null,
      snapshots: [snapshot({ durable: false })],
    });
    expect(notDurable.complete).toBe(false);
  });

  it('a reset (observationWindowStartedAt changes across snapshots) invalidates the window and is counted', () => {
    const entry = deriveInstanceEntry({
      instanceId: 'op-a', imageDigest: null, reportedSourceSha: null,
      snapshots: [
        snapshot({ at: '2026-08-01T00:00:00.000Z', observationWindowStartedAt: '2026-08-01T00:00:00.000Z' }),
        snapshot({ at: '2026-08-02T00:00:00.000Z', observationWindowStartedAt: '2026-08-02T05:00:00.000Z' }),
        snapshot({ at: '2026-08-03T00:00:00.000Z', observationWindowStartedAt: '2026-08-02T05:00:00.000Z' }),
      ],
    });
    expect(entry.complete).toBe(false);
    expect(entry.resets).toBe(1);
  });
});

describe('deriveVerdict (#2380)', () => {
  function completeInstance(counters: PhaseDObservationSnapshotEntry['counters']) {
    return deriveInstanceEntry({
      instanceId: 'op-a', imageDigest: null, reportedSourceSha: null,
      snapshots: [snapshot({ counters })],
    });
  }

  it('is zeroUse when every instance is complete and every legacy signal reads zero in its latest snapshot', () => {
    const verdict = deriveVerdict([
      completeInstance([{ signal: 'marketplace-pipeline-invocation', count: 0 }]),
      completeInstance([{ signal: 'legacy-operator-composition', count: 0 }]),
    ]);
    expect(verdict.zeroUse).toBe(true);
    expect(verdict.signalsCovered).toEqual(['legacy-operator-composition', 'marketplace-pipeline-invocation']);
  });

  it('is not zeroUse when any legacy signal is non-zero', () => {
    const verdict = deriveVerdict([
      completeInstance([{ signal: 'marketplace-pipeline-invocation', count: 3 }]),
    ]);
    expect(verdict.zeroUse).toBe(false);
  });

  it('is not zeroUse when any instance is incomplete, even if all observed counts are zero — no coverage, no claim', () => {
    const incomplete = deriveInstanceEntry({
      instanceId: 'op-b', imageDigest: null, reportedSourceSha: null,
      snapshots: [snapshot({ durable: false, observationWindowStartedAt: null })],
    });
    const verdict = deriveVerdict([
      completeInstance([{ signal: 'marketplace-pipeline-invocation', count: 0 }]),
      incomplete,
    ]);
    expect(verdict.zeroUse).toBe(false);
  });

  it('is not zeroUse over an empty fleet — there is nothing to observe, so nothing to claim', () => {
    expect(deriveVerdict([]).zeroUse).toBe(false);
  });

  it('ignores native-operator-composition when computing zeroUse and signalsCovered', () => {
    const verdict = deriveVerdict([
      completeInstance([{ signal: 'native-operator-composition', count: 40 }]),
    ]);
    expect(verdict.zeroUse).toBe(true);
    expect(verdict.signalsCovered).toEqual([]);
  });
});

describe('appendDailyObservation (#2380)', () => {
  it('builds a fresh receipt with the fixed support boundary when no prior receipt exists', () => {
    const receipt = appendDailyObservation({
      existing: undefined,
      windowId: 'phase-d-2026-08-04',
      approvedBy: 'ritsuKai2000',
      startedAt: '2026-08-04T00:00:00.000Z',
      endedAt: null,
      collectedAt: '2026-08-04T01:00:00.000Z',
      fetched: [
        {
          instanceId: 'op-a',
          imageDigest: 'sha256:aaaa',
          reportedSourceSha: 'deadbeef',
          result: {
            ok: true,
            durable: true,
            observationWindowStartedAt: '2026-08-04T00:00:00.000Z',
            counters: [{ signal: 'marketplace-pipeline-invocation', count: 0 }],
          },
        },
      ],
    });

    expect(receipt).toEqual<PhaseDObservationReceipt>({
      schemaVersion: 1,
      kind: 'jinn.phase-d-observation-window',
      windowId: 'phase-d-2026-08-04',
      approvedBy: 'ritsuKai2000',
      startedAt: '2026-08-04T00:00:00.000Z',
      endedAt: null,
      supportBoundary: { claim: 'first-party-operational', disclaims: ['unknown-independent-operators'] },
      instances: [{
        instanceId: 'op-a',
        imageDigest: 'sha256:aaaa',
        reportedSourceSha: 'deadbeef',
        snapshots: [{
          at: '2026-08-04T01:00:00.000Z',
          observationWindowStartedAt: '2026-08-04T00:00:00.000Z',
          durable: true,
          counters: [{ signal: 'marketplace-pipeline-invocation', count: 0 }],
        }],
        complete: true,
        resets: 0,
      }],
      verdict: { zeroUse: true, signalsCovered: ['marketplace-pipeline-invocation'] },
    });
  });

  it('appends to an existing instance\'s snapshot history rather than overwriting it', () => {
    const existing = appendDailyObservation({
      existing: undefined,
      windowId: 'w1', approvedBy: 'ritsu', startedAt: '2026-08-01T00:00:00.000Z', endedAt: null,
      collectedAt: '2026-08-01T01:00:00.000Z',
      fetched: [{
        instanceId: 'op-a', imageDigest: 'sha256:aaaa', reportedSourceSha: 'deadbeef',
        result: { ok: true, durable: true, observationWindowStartedAt: '2026-08-01T00:00:00.000Z', counters: [] },
      }],
    });

    const next = appendDailyObservation({
      existing,
      windowId: 'w1', approvedBy: 'ritsu', startedAt: '2026-08-01T00:00:00.000Z', endedAt: null,
      collectedAt: '2026-08-02T01:00:00.000Z',
      fetched: [{
        instanceId: 'op-a', imageDigest: 'sha256:aaaa', reportedSourceSha: 'deadbeef',
        result: { ok: true, durable: true, observationWindowStartedAt: '2026-08-01T00:00:00.000Z', counters: [] },
      }],
    });

    expect(next.instances).toHaveLength(1);
    expect(next.instances[0]?.snapshots.map((s) => s.at)).toEqual([
      '2026-08-01T01:00:00.000Z',
      '2026-08-02T01:00:00.000Z',
    ]);
    expect(next.instances[0]?.complete).toBe(true);
  });

  it('records a fetch failure as a missing/corrupt snapshot, invalidating that instance\'s window', () => {
    const receipt = appendDailyObservation({
      existing: undefined,
      windowId: 'w1', approvedBy: 'ritsu', startedAt: '2026-08-01T00:00:00.000Z', endedAt: null,
      collectedAt: '2026-08-01T01:00:00.000Z',
      fetched: [{
        instanceId: 'op-b', imageDigest: null, reportedSourceSha: null, result: { ok: false },
      }],
    });
    expect(receipt.instances[0]).toMatchObject({
      complete: false,
      snapshots: [{ at: '2026-08-01T01:00:00.000Z', observationWindowStartedAt: null, durable: false, counters: [] }],
    });
    expect(receipt.verdict.zeroUse).toBe(false);
  });

  it('rejects a windowId mismatch against the existing receipt rather than silently starting a new window', () => {
    const existing = appendDailyObservation({
      existing: undefined,
      windowId: 'w1', approvedBy: 'ritsu', startedAt: '2026-08-01T00:00:00.000Z', endedAt: null,
      collectedAt: '2026-08-01T01:00:00.000Z',
      fetched: [],
    });
    expect(() => appendDailyObservation({
      existing,
      windowId: 'w2', approvedBy: 'ritsu', startedAt: '2026-08-01T00:00:00.000Z', endedAt: null,
      collectedAt: '2026-08-02T01:00:00.000Z',
      fetched: [],
    })).toThrow(/windowId mismatch/u);
  });
});

describe('fetchHttpStatusSnapshot (#2380)', () => {
  it('extracts phaseDTransitionUsage from a healthy GET /v1/status response, sending the bearer token when provided', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      phaseDTransitionUsage: {
        durable: true,
        observationWindowStartedAt: '2026-08-04T00:00:00.000Z',
        counters: [{ signal: 'marketplace-pipeline-invocation', count: 0 }],
      },
    }), { status: 200 }));

    const result = await fetchHttpStatusSnapshot({
      url: 'http://127.0.0.1:7331/v1/status',
      token: 'shh',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({
      ok: true,
      durable: true,
      observationWindowStartedAt: '2026-08-04T00:00:00.000Z',
      counters: [{ signal: 'marketplace-pipeline-invocation', count: 0 }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:7331/v1/status',
      expect.objectContaining({ headers: { authorization: 'Bearer shh' } }),
    );
  });

  it('degrades to { ok: false } on a non-2xx response, a network throw, or a response missing phaseDTransitionUsage', async () => {
    await expect(fetchHttpStatusSnapshot({
      url: 'http://x/v1/status',
      fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
    })).resolves.toEqual({ ok: false });

    await expect(fetchHttpStatusSnapshot({
      url: 'http://x/v1/status',
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    })).resolves.toEqual({ ok: false });

    await expect(fetchHttpStatusSnapshot({
      url: 'http://x/v1/status',
      fetchImpl: (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch,
    })).resolves.toEqual({ ok: false });
  });
});

describe('readFileStatusSnapshot (#2380)', () => {
  it('extracts phaseDTransitionUsage from a native durable status snapshot file', () => {
    const result = readFileStatusSnapshot({
      path: '/native/phase-d-status-snapshot.v1.json',
      readFileImpl: () => JSON.stringify({
        phaseDTransitionUsage: {
          durable: true,
          observationWindowStartedAt: '2026-08-04T00:00:00.000Z',
          counters: [],
        },
      }),
    });
    expect(result).toEqual({
      ok: true, durable: true, observationWindowStartedAt: '2026-08-04T00:00:00.000Z', counters: [],
    });
  });

  it('degrades to { ok: false } when the file is missing, unreadable, or corrupt JSON', () => {
    expect(readFileStatusSnapshot({
      path: '/missing.json',
      readFileImpl: () => { throw new Error('ENOENT'); },
    })).toEqual({ ok: false });

    expect(readFileStatusSnapshot({
      path: '/corrupt.json',
      readFileImpl: () => 'not json',
    })).toEqual({ ok: false });

    expect(readFileStatusSnapshot({
      path: '/wrong-shape.json',
      readFileImpl: () => JSON.stringify({ hello: 'world' }),
    })).toEqual({ ok: false });
  });
});
