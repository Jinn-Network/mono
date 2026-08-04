import { describe, expect, it, vi } from 'vitest';
import {
  appendDailyObservation,
  deriveInstanceEntry,
  deriveVerdict,
  fetchHttpStatusSnapshot,
  parseExistingReceipt,
  readFileStatusSnapshot,
  PHASE_D_LEGACY_SIGNALS,
  type PhaseDObservationReceipt,
  type PhaseDObservationSnapshotEntry,
} from '../../src/monitoring/phase-d-observation-window.js';

const ALL_LEGACY_SIGNALS_SORTED = [...PHASE_D_LEGACY_SIGNALS].sort();

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
    expect(entry.regressions).toBe(0);
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

  // Review CRITICAL/IMPORTANT (P3): "count 5 -> 0, same startedAt" yielded complete:true,
  // resets:0, zeroUse:true. The durable counter file is append-only/monotonic by construction
  // (compatibility/phase-d-transition-usage.ts) — a decrease or disappearance is never legitimate
  // legacy use dropping to zero; it is corrupt or tampered data, and must invalidate the window.
  it('a per-signal count regression (decrease, or disappearance after being present) invalidates completeness even when observationWindowStartedAt never changed (#2380 review P3)', () => {
    const decreased = deriveInstanceEntry({
      instanceId: 'op-a', imageDigest: null, reportedSourceSha: null,
      snapshots: [
        snapshot({ at: '2026-08-01T00:00:00.000Z', counters: [{ signal: 'marketplace-pipeline-invocation', count: 5 }] }),
        snapshot({ at: '2026-08-02T00:00:00.000Z', counters: [{ signal: 'marketplace-pipeline-invocation', count: 0 }] }),
      ],
    });
    expect(decreased.complete).toBe(false);
    expect(decreased.regressions).toBeGreaterThan(0);
    expect(decreased.resets).toBe(0); // observationWindowStartedAt never changed — this is not a reset

    const disappeared = deriveInstanceEntry({
      instanceId: 'op-a', imageDigest: null, reportedSourceSha: null,
      snapshots: [
        snapshot({ at: '2026-08-01T00:00:00.000Z', counters: [{ signal: 'marketplace-pipeline-invocation', count: 5 }] }),
        snapshot({ at: '2026-08-02T00:00:00.000Z', counters: [] }),
      ],
    });
    expect(disappeared.complete).toBe(false);
    expect(disappeared.regressions).toBeGreaterThan(0);

    // A monotonic non-decreasing series across snapshots is fine — not every change is a regression.
    const grew = deriveInstanceEntry({
      instanceId: 'op-a', imageDigest: null, reportedSourceSha: null,
      snapshots: [
        snapshot({ at: '2026-08-01T00:00:00.000Z', counters: [{ signal: 'marketplace-pipeline-invocation', count: 1 }] }),
        snapshot({ at: '2026-08-02T00:00:00.000Z', counters: [{ signal: 'marketplace-pipeline-invocation', count: 3 }] }),
      ],
    });
    expect(grew.complete).toBe(true);
    expect(grew.regressions).toBe(0);
  });
});

describe('deriveVerdict (#2380)', () => {
  // A single-day, zero-width window (startedAt === endedAt === the instance's snapshot `at`)
  // keeps coverage trivially satisfied so these tests can focus on the zero/non-zero signal logic
  // rather than window-span math (covered separately below).
  const WINDOW = { startedAt: '2026-08-04T00:00:00.000Z', endedAt: '2026-08-04T00:00:00.000Z' };

  function completeInstance(counters: PhaseDObservationSnapshotEntry['counters']) {
    return deriveInstanceEntry({
      instanceId: 'op-a', imageDigest: null, reportedSourceSha: null,
      snapshots: [snapshot({ counters })],
    });
  }

  // Review IMPORTANT: the durable counter file never persists an explicit zero-count row (a
  // signal that never fires simply never appears in `counters` — see
  // compatibility/phase-d-transition-usage.ts). The old fixture asserted zeroUse via an
  // unreachable `count: 0` row; the real "zero use" shape is an EMPTY counters array with
  // durable: true, which is what a genuinely idle legacy signal actually looks like on the wire.
  it('is zeroUse when the window is closed, every instance is complete, coverage is continuous, and no legacy signal ever appears — signalsCovered is the full durable-instrumented list, never structurally empty (#2380 review IMPORTANT)', () => {
    const verdict = deriveVerdict({
      instances: [completeInstance([]), completeInstance([])],
      ...WINDOW,
    });
    expect(verdict.zeroUse).toBe(true);
    expect(verdict.signalsCovered).toEqual(ALL_LEGACY_SIGNALS_SORTED);
    expect(verdict.signalsCovered.length).toBeGreaterThan(0);
  });

  it('is not zeroUse when any legacy signal is non-zero', () => {
    const verdict = deriveVerdict({
      instances: [completeInstance([{ signal: 'marketplace-pipeline-invocation', count: 3 }])],
      ...WINDOW,
    });
    expect(verdict.zeroUse).toBe(false);
  });

  it('is not zeroUse when any instance is incomplete, even if all observed counts are zero — no coverage, no claim', () => {
    const incomplete = deriveInstanceEntry({
      instanceId: 'op-b', imageDigest: null, reportedSourceSha: null,
      snapshots: [snapshot({ durable: false, observationWindowStartedAt: null })],
    });
    const verdict = deriveVerdict({ instances: [completeInstance([]), incomplete], ...WINDOW });
    expect(verdict.zeroUse).toBe(false);
  });

  it('is not zeroUse over an empty fleet — there is nothing to observe, so nothing to claim', () => {
    expect(deriveVerdict({ instances: [], ...WINDOW }).zeroUse).toBe(false);
  });

  it('ignores native-operator-composition when computing zeroUse — it is positive presence evidence, not a legacy-use counter', () => {
    const verdict = deriveVerdict({
      instances: [completeInstance([{ signal: 'native-operator-composition', count: 40 }])],
      ...WINDOW,
    });
    expect(verdict.zeroUse).toBe(true);
  });

  // Review CRITICAL 3 (P9): "one run, one instance" yielded zeroUse:true. `startedAt`/`endedAt`
  // were read onto the receipt but never consulted by the verdict itself.
  describe('window coverage (#2380 review CRITICAL 3 / P9)', () => {
    it('is never zeroUse while the window is still open, no matter how clean the single observation looks', () => {
      const verdict = deriveVerdict({
        instances: [completeInstance([])],
        startedAt: '2026-08-04T00:00:00.000Z',
        endedAt: null,
      });
      expect(verdict.zeroUse).toBe(false);
    });

    it('is not zeroUse when the window is closed but only one collection stands in for a much longer span', () => {
      // Window spans 10 days; the only snapshot sits at the very start, leaving a ~10-day gap to
      // endedAt — far beyond the default ~2-day coverage tolerance.
      const oneEarlySnapshot = deriveInstanceEntry({
        instanceId: 'op-a', imageDigest: null, reportedSourceSha: null,
        snapshots: [snapshot({ at: '2026-08-01T00:00:00.000Z' })],
      });
      const verdict = deriveVerdict({
        instances: [oneEarlySnapshot],
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: '2026-08-11T00:00:00.000Z',
      });
      expect(verdict.zeroUse).toBe(false);
    });

    it('is zeroUse when the closed window has continuous daily coverage across its full span', () => {
      const dailyCovered = deriveInstanceEntry({
        instanceId: 'op-a', imageDigest: null, reportedSourceSha: null,
        snapshots: [
          snapshot({ at: '2026-08-01T00:00:00.000Z' }),
          snapshot({ at: '2026-08-02T00:00:00.000Z' }),
          snapshot({ at: '2026-08-03T00:00:00.000Z' }),
        ],
      });
      const verdict = deriveVerdict({
        instances: [dailyCovered],
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: '2026-08-03T00:00:00.000Z',
      });
      expect(verdict.zeroUse).toBe(true);
    });

    it('rejects a gap between two otherwise-clean collections wider than the coverage tolerance', () => {
      const gappy = deriveInstanceEntry({
        instanceId: 'op-a', imageDigest: null, reportedSourceSha: null,
        snapshots: [
          snapshot({ at: '2026-08-01T00:00:00.000Z' }),
          snapshot({ at: '2026-08-08T00:00:00.000Z' }), // 7-day gap
        ],
      });
      const verdict = deriveVerdict({
        instances: [gappy],
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: '2026-08-08T00:00:00.000Z',
      });
      expect(verdict.zeroUse).toBe(false);
    });
  });
});

describe('appendDailyObservation (#2380)', () => {
  it('builds a fresh, closed-window receipt with the fixed support boundary when no prior receipt exists', () => {
    const receipt = appendDailyObservation({
      existing: undefined,
      windowId: 'phase-d-2026-08-04',
      approvedBy: 'ritsuKai2000',
      startedAt: '2026-08-04T00:00:00.000Z',
      endedAt: '2026-08-04T01:00:00.000Z',
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
            counters: [],
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
      endedAt: '2026-08-04T01:00:00.000Z',
      supportBoundary: { claim: 'first-party-operational', disclaims: ['unknown-independent-operators'] },
      instances: [{
        instanceId: 'op-a',
        imageDigest: 'sha256:aaaa',
        reportedSourceSha: 'deadbeef',
        snapshots: [{
          at: '2026-08-04T01:00:00.000Z',
          observationWindowStartedAt: '2026-08-04T00:00:00.000Z',
          durable: true,
          counters: [],
        }],
        complete: true,
        resets: 0,
        regressions: 0,
      }],
      verdict: { zeroUse: true, signalsCovered: ALL_LEGACY_SIGNALS_SORTED },
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

  // Review IMPORTANT: approvedBy is the human-approval field on a deletion-authorizing artifact;
  // it must be exactly as unforgeable across runs as windowId already is.
  it('rejects an approvedBy or startedAt mismatch against the existing receipt (#2380 review IMPORTANT)', () => {
    const existing = appendDailyObservation({
      existing: undefined,
      windowId: 'w1', approvedBy: 'ritsu', startedAt: '2026-08-01T00:00:00.000Z', endedAt: null,
      collectedAt: '2026-08-01T01:00:00.000Z',
      fetched: [],
    });
    expect(() => appendDailyObservation({
      existing,
      windowId: 'w1', approvedBy: 'someone-else', startedAt: '2026-08-01T00:00:00.000Z', endedAt: null,
      collectedAt: '2026-08-02T01:00:00.000Z',
      fetched: [],
    })).toThrow(/approvedBy mismatch/u);
    expect(() => appendDailyObservation({
      existing,
      windowId: 'w1', approvedBy: 'ritsu', startedAt: '2026-07-01T00:00:00.000Z', endedAt: null,
      collectedAt: '2026-08-02T01:00:00.000Z',
      fetched: [],
    })).toThrow(/startedAt mismatch/u);
  });

  // Review CRITICAL 1 (P1): "instance removed from fleet manifest" erased 7 recorded legacy uses
  // and yielded zeroUse:true. Shrinking the population must never improve the verdict.
  it('carries a dropped instance forward as a missing observation rather than erasing its history when the fleet manifest shrinks (#2380 review CRITICAL 1 / P1)', () => {
    const day1 = appendDailyObservation({
      existing: undefined,
      windowId: 'w-p1', approvedBy: 'ritsu', startedAt: '2026-08-01T00:00:00.000Z', endedAt: null,
      collectedAt: '2026-08-01T00:00:00.000Z',
      fetched: [{
        instanceId: 'op-dropped', imageDigest: 'sha256:aaaa', reportedSourceSha: 'deadbeef',
        result: {
          ok: true, durable: true, observationWindowStartedAt: '2026-08-01T00:00:00.000Z',
          counters: [{ signal: 'marketplace-pipeline-invocation', count: 7 }],
        },
      }],
    });
    expect(day1.instances).toHaveLength(1);
    expect(day1.verdict.zeroUse).toBe(false);

    // Day 2: op-dropped is no longer in the fleet manifest at all (host decommissioned mid-drain,
    // per docs/runbooks/cutover-stage-1-drain.md's own "fleet composition changes" framing).
    const day2 = appendDailyObservation({
      existing: day1,
      windowId: 'w-p1', approvedBy: 'ritsu', startedAt: '2026-08-01T00:00:00.000Z',
      endedAt: '2026-08-02T00:00:00.000Z',
      collectedAt: '2026-08-02T00:00:00.000Z',
      fetched: [],
    });

    expect(day2.instances).toHaveLength(1);
    const carried = day2.instances[0]!;
    expect(carried.instanceId).toBe('op-dropped');
    expect(carried.snapshots).toHaveLength(2);
    expect(carried.snapshots[1]).toEqual({
      at: '2026-08-02T00:00:00.000Z', observationWindowStartedAt: null, durable: false, counters: [],
    });
    // The 7 legacy invocations recorded on day 1 remain visible in history — not erased.
    expect(carried.snapshots[0]?.counters).toEqual([{ signal: 'marketplace-pipeline-invocation', count: 7 }]);
    expect(carried.complete).toBe(false);
    expect(day2.verdict.zeroUse).toBe(false);
  });
});

describe('parseExistingReceipt (#2380 review IMPORTANT — receipt provenance)', () => {
  it('accepts a well-formed receipt', () => {
    const receipt = appendDailyObservation({
      existing: undefined,
      windowId: 'w1', approvedBy: 'ritsu', startedAt: '2026-08-01T00:00:00.000Z', endedAt: null,
      collectedAt: '2026-08-01T00:00:00.000Z',
      fetched: [],
    });
    expect(parseExistingReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });

  it('rejects a non-object, wrong schemaVersion/kind, or a receipt missing its instances array', () => {
    expect(() => parseExistingReceipt(null)).toThrow();
    expect(() => parseExistingReceipt('a string')).toThrow();
    expect(() => parseExistingReceipt({
      schemaVersion: 2, kind: 'jinn.phase-d-observation-window',
      windowId: 'w1', approvedBy: 'ritsu', startedAt: '2026-08-01T00:00:00.000Z', instances: [],
    })).toThrow(/invalid or unrecognized shape/u);
    // The exact shape a well-formed-but-truncated file would have: right windowId, no instances.
    expect(() => parseExistingReceipt({
      schemaVersion: 1, kind: 'jinn.phase-d-observation-window',
      windowId: 'w1', approvedBy: 'ritsu', startedAt: '2026-08-01T00:00:00.000Z',
    })).toThrow(/invalid or unrecognized shape/u);
  });
});

describe('fetchHttpStatusSnapshot (#2380)', () => {
  it('extracts phaseDTransitionUsage from a healthy GET /v1/status response, sending the bearer token when provided', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      phaseDTransitionUsage: {
        durable: true,
        observationWindowStartedAt: '2026-08-04T00:00:00.000Z',
        counters: [{ signal: 'marketplace-pipeline-invocation', count: 3 }],
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
      counters: [{ signal: 'marketplace-pipeline-invocation', count: 3 }],
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

  // Review IMPORTANT: "count: 0 and negatives, more permissive than the writer." The real writer
  // (compatibility/phase-d-transition-usage.ts) never persists a zero or negative count.
  it('degrades to { ok: false } on a counter row with a zero, negative, or non-integer count — the real writer can never produce one', async () => {
    async function withCounters(counters: unknown) {
      return fetchHttpStatusSnapshot({
        url: 'http://x/v1/status',
        fetchImpl: (async () => new Response(JSON.stringify({
          phaseDTransitionUsage: { durable: true, observationWindowStartedAt: '2026-08-04T00:00:00.000Z', counters },
        }), { status: 200 })) as unknown as typeof fetch,
      });
    }
    await expect(withCounters([{ signal: 'marketplace-pipeline-invocation', count: 0 }])).resolves.toEqual({ ok: false });
    await expect(withCounters([{ signal: 'marketplace-pipeline-invocation', count: -1 }])).resolves.toEqual({ ok: false });
    await expect(withCounters([{ signal: 'marketplace-pipeline-invocation', count: 1.5 }])).resolves.toEqual({ ok: false });
  });
});

describe('readFileStatusSnapshot (#2380)', () => {
  it('extracts phaseDTransitionUsage from a fresh native durable status snapshot file', () => {
    const result = readFileStatusSnapshot({
      path: '/native/phase-d-status-snapshot.v1.json',
      collectedAt: '2026-08-04T00:01:00.000Z',
      readFileImpl: () => JSON.stringify({
        generatedAt: '2026-08-04T00:00:00.000Z',
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

  it('degrades to { ok: false } when the file is missing, unreadable, corrupt JSON, or missing generatedAt', () => {
    expect(readFileStatusSnapshot({
      path: '/missing.json', collectedAt: '2026-08-04T00:00:00.000Z',
      readFileImpl: () => { throw new Error('ENOENT'); },
    })).toEqual({ ok: false });

    expect(readFileStatusSnapshot({
      path: '/corrupt.json', collectedAt: '2026-08-04T00:00:00.000Z',
      readFileImpl: () => 'not json',
    })).toEqual({ ok: false });

    expect(readFileStatusSnapshot({
      path: '/wrong-shape.json', collectedAt: '2026-08-04T00:00:00.000Z',
      readFileImpl: () => JSON.stringify({ hello: 'world' }),
    })).toEqual({ ok: false });

    // Has phaseDTransitionUsage but no top-level generatedAt — e.g. an operator misconfigured a
    // file-snapshot fleet entry to point at the raw counter file
    // (compatibility/phase-d-transition-usage.ts's own persisted state) instead of native's
    // wrapping status snapshot (native-phase-d-observability.ts's NativeStatusSnapshot).
    expect(readFileStatusSnapshot({
      path: '/raw-counter-file.json', collectedAt: '2026-08-04T00:00:00.000Z',
      readFileImpl: () => JSON.stringify({
        schemaVersion: 1, observationWindowStartedAt: '2026-08-04T00:00:00.000Z', counters: [],
      }),
    })).toEqual({ ok: false });
  });

  // Review CRITICAL 2 (P6): a frozen snapshot file (writer dead, or the box quietly flipped back
  // to legacy) was indistinguishable from a live one and was accepted as evidence of zero use
  // repeatedly, across as many collector runs as it took the box to actually get noticed.
  it('degrades to { ok: false } once the file is older than the staleness tolerance relative to collectedAt', () => {
    const fresh = readFileStatusSnapshot({
      path: '/native/snapshot.json', collectedAt: '2026-08-04T00:05:00.000Z',
      readFileImpl: () => JSON.stringify({
        generatedAt: '2026-08-04T00:00:00.000Z',
        phaseDTransitionUsage: { durable: true, observationWindowStartedAt: '2026-08-01T00:00:00.000Z', counters: [] },
      }),
    });
    expect(fresh).toEqual({ ok: true, durable: true, observationWindowStartedAt: '2026-08-01T00:00:00.000Z', counters: [] });

    const stale = readFileStatusSnapshot({
      path: '/native/snapshot.json', collectedAt: '2026-08-05T00:00:00.000Z', // 24h later
      readFileImpl: () => JSON.stringify({
        generatedAt: '2026-08-04T00:00:00.000Z', // frozen — the writer never ticked again
        phaseDTransitionUsage: { durable: true, observationWindowStartedAt: '2026-08-01T00:00:00.000Z', counters: [] },
      }),
    });
    expect(stale).toEqual({ ok: false });
  });

  it('rejects staleness across repeated daily collector runs against a frozen file, invalidating the instance (#2380 review CRITICAL 2 / P6)', () => {
    const frozenGeneratedAt = '2026-08-01T00:00:00.000Z';
    const fileContents = JSON.stringify({
      generatedAt: frozenGeneratedAt,
      phaseDTransitionUsage: { durable: true, observationWindowStartedAt: '2026-08-01T00:00:00.000Z', counters: [] },
    });
    let receipt: PhaseDObservationReceipt | undefined;
    const startOfDay0 = Date.parse('2026-08-01T00:00:00.000Z');
    for (let day = 0; day < 3; day += 1) {
      const collectedAt = new Date(startOfDay0 + day * 24 * 60 * 60 * 1000).toISOString();
      const result = readFileStatusSnapshot({ path: '/native/snapshot.json', collectedAt, readFileImpl: () => fileContents });
      receipt = appendDailyObservation({
        existing: receipt,
        windowId: 'w-p6', approvedBy: 'ritsu', startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: day === 2 ? collectedAt : null,
        collectedAt,
        fetched: [{ instanceId: 'op-native', imageDigest: null, reportedSourceSha: null, result }],
      });
    }
    const instance = receipt!.instances[0]!;
    // Day 0: fresh (age 0). Days 1-2: the writer never ticked again — stale, degrades to missing.
    expect(instance.snapshots.map((s) => s.durable)).toEqual([true, false, false]);
    expect(instance.complete).toBe(false);
    expect(receipt!.verdict.zeroUse).toBe(false);
  });
});
