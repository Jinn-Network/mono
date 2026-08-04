import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configurePhaseDTransitionUsage,
  phaseDTransitionUsageSnapshot,
} from '../../src/compatibility/phase-d-transition-usage.js';
import {
  NATIVE_PHASE_D_STATUS_SNAPSHOT_FILENAME,
  NATIVE_PHASE_D_USAGE_FILENAME,
  nativeStatusSnapshotSchema,
  readNativeStatusSnapshot,
  recordNativeOperatorComposition,
  startNativeStatusSnapshotLoop,
  writeNativeStatusSnapshot,
  type NativeStatusSnapshotLoopHandle,
} from '../../src/daemon/native-phase-d-observability.js';
import type { OperatorVerticalDecision } from '../../src/daemon/native-vertical-mode.js';
import type { NativeOperatorHealth } from '../../src/daemon/native-operator-host.js';

function health(overrides: Partial<NativeOperatorHealth> = {}): NativeOperatorHealth {
  return {
    mode: 'native-v1',
    role: 'solver',
    roleKeyIds: { 'solver-delivery': 'did:key:zSolver' },
    sourceLag: 0,
    sourceLagBySource: {},
    leaseOwned: true,
    venue: { canonicalBlock: '2', finalizedBlock: '1', caughtUp: true },
    backendReady: true,
    backendRequired: true,
    evidenceReady: true,
    evidenceRequired: true,
    publicSourceReady: true,
    uncertainOperations: 0,
    nativeFallbackCount: 0,
    ...overrides,
  };
}

const decision: OperatorVerticalDecision = {
  requestedMode: 'native-v1',
  effectiveMode: 'native-v1',
  readiness: 'explicit-native-unvalidated',
};

describe('recordNativeOperatorComposition (#2380)', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jinn-native-phase-d-'));
  });

  afterEach(() => {
    configurePhaseDTransitionUsage(undefined);
    rmSync(directory, { recursive: true, force: true });
  });

  it('records native-operator-composition as positive evidence into a durable file under stateDir', () => {
    recordNativeOperatorComposition({ operator: { native: { stateDir: directory } } });

    const path = join(directory, NATIVE_PHASE_D_USAGE_FILENAME);
    expect(existsSync(path)).toBe(true);
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as {
      counters: Array<{ signal: string; count: number }>;
    };
    expect(persisted.counters).toEqual([
      expect.objectContaining({ signal: 'native-operator-composition', count: 1 }),
    ]);
    expect(phaseDTransitionUsageSnapshot().find((row) => row.signal === 'native-operator-composition')?.count)
      .toBe(1);
  });
});

describe('writeNativeStatusSnapshot / readNativeStatusSnapshot (#2380)', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jinn-native-status-snapshot-'));
    path = join(directory, NATIVE_PHASE_D_STATUS_SNAPSHOT_FILENAME);
    configurePhaseDTransitionUsage(join(directory, NATIVE_PHASE_D_USAGE_FILENAME), new Date('2026-08-04T00:00:00.000Z'));
  });

  afterEach(() => {
    configurePhaseDTransitionUsage(undefined);
    rmSync(directory, { recursive: true, force: true });
  });

  it('writes instance identity + phaseDTransitionUsage carrying the durable observation window', () => {
    const snapshot = writeNativeStatusSnapshot({
      path,
      decision,
      health: health(),
      now: () => new Date('2026-08-04T01:00:00.000Z'),
    });

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      kind: 'jinn.native-operator-status-snapshot',
      generatedAt: '2026-08-04T01:00:00.000Z',
      effectiveMode: 'native-v1',
      role: 'solver',
      readiness: 'explicit-native-unvalidated',
    });
    expect(snapshot.implVersion).toEqual(expect.any(String));
    expect(snapshot.reportedSourceSha).toEqual(expect.any(String));
    expect(snapshot.phaseDTransitionUsage).toEqual({
      schemaVersion: 1,
      durable: true,
      observationWindowStartedAt: '2026-08-04T00:00:00.000Z',
      counters: [],
    });

    expect(readNativeStatusSnapshot(path)).toEqual(snapshot);
  });

  it('the snapshot schema is strict: an unrecognized field is rejected, not silently stripped (N2)', () => {
    // A plain z.object() would silently drop an unrecognized key at parse time — a future field
    // added to NativeStatusSnapshot or NativeOperatorHealth without updating this schema would
    // then vanish from the durable file with no error. z.strictObject() makes that drift a loud
    // throw instead. Round-trips a real snapshot (not a hand-built fixture) so the valid case
    // proves the schema still accepts everything writeNativeStatusSnapshot actually produces.
    const snapshot = writeNativeStatusSnapshot({
      path,
      decision,
      health: health(),
      now: () => new Date('2026-08-04T01:00:00.000Z'),
    });
    expect(() => nativeStatusSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(() => nativeStatusSnapshotSchema.parse({ ...snapshot, extra: 'unexpected' })).toThrow();
    expect(() => nativeStatusSnapshotSchema.parse({
      ...snapshot,
      health: { ...snapshot.health, extra: 'unexpected' },
    })).toThrow();
  });

  // Review minor: the snapshot carries roleKeyIds (identifiers, e.g. did:key:..., never private
  // key material) and executableDigest, and is meant to be mounted/shipped off-host — restrict it
  // to the operator like every other durable secret-adjacent file in this repo.
  it('writes the snapshot file with mode 0600', () => {
    writeNativeStatusSnapshot({ path, decision, health: health(), now: () => new Date('2026-08-04T01:00:00.000Z') });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // Review minor: a hardcoded 'native-v1' literal here is the same mislabeling class the review
  // flagged for main.ts/quickstart — echo the resolver's actual decision instead of assuming it.
  it('echoes decision.effectiveMode rather than hardcoding the native-v1 literal', () => {
    const legacyDecision: OperatorVerticalDecision = {
      requestedMode: 'legacy', effectiveMode: 'legacy', readiness: 'explicit-legacy',
    };
    const snapshot = writeNativeStatusSnapshot({
      path, decision: legacyDecision, health: health(), now: () => new Date('2026-08-04T01:00:00.000Z'),
    });
    expect(snapshot.effectiveMode).toBe('legacy');
  });

  it('returns undefined for a missing snapshot file', () => {
    expect(readNativeStatusSnapshot(join(directory, 'absent.json'))).toBeUndefined();
  });

  it('throws on a corrupt snapshot file so the collector can treat it as invalidating', () => {
    writeFileSync(path, '{"not":"a snapshot"}');
    expect(() => readNativeStatusSnapshot(path)).toThrow(/invalid native Phase D status snapshot/u);
  });
});

describe('startNativeStatusSnapshotLoop (#2380)', () => {
  let directory: string;
  let path: string;
  let handle: NativeStatusSnapshotLoopHandle | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'jinn-native-status-loop-'));
    path = join(directory, NATIVE_PHASE_D_STATUS_SNAPSHOT_FILENAME);
    configurePhaseDTransitionUsage(join(directory, NATIVE_PHASE_D_USAGE_FILENAME), new Date('2026-08-04T00:00:00.000Z'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    handle?.stop();
    vi.useRealTimers();
    configurePhaseDTransitionUsage(undefined);
    rmSync(directory, { recursive: true, force: true });
  });

  it('writes a snapshot immediately, then again on the configured interval, refreshing health each tick', async () => {
    let sourceLag = 0;
    const refreshHealth = vi.fn(async () => health({ sourceLag: sourceLag++ }));

    handle = startNativeStatusSnapshotLoop({
      stateDir: directory,
      decision,
      refreshHealth,
      intervalMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(existsSync(path)).toBe(true);
    const first = readNativeStatusSnapshot(path);
    expect(first?.health.sourceLag).toBe(0);
    expect(refreshHealth).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const second = readNativeStatusSnapshot(path);
    expect(second?.health.sourceLag).toBe(1);
    expect(refreshHealth).toHaveBeenCalledTimes(2);

    handle.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refreshHealth).toHaveBeenCalledTimes(2);
  });

  it('reports a failed tick via onError without stopping the loop', async () => {
    const onError = vi.fn();
    let fail = true;
    const refreshHealth = vi.fn(async () => {
      if (fail) { fail = false; throw new Error('transient venue read failure'); }
      return health();
    });

    handle = startNativeStatusSnapshotLoop({
      stateDir: directory,
      decision,
      refreshHealth,
      intervalMs: 60_000,
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(existsSync(path)).toBe(true);
    expect(refreshHealth).toHaveBeenCalledTimes(2);
  });
});
