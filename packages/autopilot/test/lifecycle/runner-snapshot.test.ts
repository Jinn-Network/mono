import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FULL_RECONCILE_MS,
  createConfiguredIncrementalLifecycleSnapshotSource,
  isRoutineCachedStatus,
  LifecycleSnapshotCoordinator,
  parseAutopilotStateDirectory,
  parseSnapshotRuntimeConfig,
  runLifecycleCadence,
} from '../../src/lifecycle/runner-snapshot.js';
import type {
  GitHubLifecycleSnapshot,
  LifecycleSnapshotSource,
  SnapshotReadMode,
} from '../../src/lifecycle/snapshot.js';
import { IncrementalSnapshotUnavailableError } from '../../src/lifecycle/incremental-snapshot-source.js';
import { LifecycleDiscoveryCacheCorruptError } from '../../src/lifecycle/lifecycle-cache.js';
import { EMPTY_GITHUB_USAGE } from '../../src/lifecycle/github-usage.js';

const START = new Date('2026-07-22T10:00:00.000Z');

function completeSnapshot(
  mode: SnapshotReadMode,
  capturedAt = START.toISOString(),
  lastFullReconciliationAt = START.toISOString(),
): GitHubLifecycleSnapshot {
  return {
    project: {
      items: [],
      rateLimit: {
        remaining: 4_000,
        used: 1_000,
        resetAt: '2026-07-22T11:00:00.000Z',
      },
      currentSprintIterationId: null,
    },
    issues: [],
    pullRequests: [],
    branches: [],
    diagnostics: [],
    lifecycle: { items: [] },
    capturedAt,
    snapshotMode: mode,
    snapshotComplete: true,
    lastFullReconciliationAt,
    githubUsage: {
      ...EMPTY_GITHUB_USAGE,
      graphqlRequests: 1,
      graphqlCost: 1,
      graphqlRemaining: 4_000,
      graphqlResetAt: '2026-07-22T11:00:00.000Z',
    },
  };
}

function startupFallbackSnapshot(
  overrides: Partial<GitHubLifecycleSnapshot> = {},
): GitHubLifecycleSnapshot {
  return {
    ...completeSnapshot(
      'incremental',
      START.toISOString(),
      new Date(START.getTime() - 1).toISOString(),
    ),
    ...overrides,
  };
}

function source(
  reads: SnapshotReadMode[],
  implementation: (mode: SnapshotReadMode) => Promise<GitHubLifecycleSnapshot> = async (mode) => (
    completeSnapshot(mode)
  ),
): LifecycleSnapshotSource {
  return {
    async read(options) {
      reads.push(options.mode);
      return implementation(options.mode);
    },
  };
}

describe('Autopilot snapshot runtime configuration', () => {
  it('passes an explicit absolute state directory to the incremental source', () => {
    let received: { readonly stateDirectory?: string } | undefined;
    const sentinel = { kind: 'source' };
    const stateDirectory = parseAutopilotStateDirectory({
      JINN_AUTOPILOT_STATE_DIRECTORY: '/private/tmp/jinn-autopilot-canary-state',
    });
    const result = createConfiguredIncrementalLifecycleSnapshotSource(
      {} as Parameters<typeof createConfiguredIncrementalLifecycleSnapshotSource>[0],
      stateDirectory,
      (options) => {
        received = options;
        return sentinel;
      },
    );

    expect(result).toBe(sentinel);
    expect(received?.stateDirectory).toBe('/private/tmp/jinn-autopilot-canary-state');
    expect(parseAutopilotStateDirectory({})).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['relative', 'relative/cache'],
  ])('rejects an %s state directory before constructing a cache or network source', (_label, raw) => {
    let sourceConstructions = 0;

    expect(() => createConfiguredIncrementalLifecycleSnapshotSource(
      {} as Parameters<typeof createConfiguredIncrementalLifecycleSnapshotSource>[0],
      parseAutopilotStateDirectory({ JINN_AUTOPILOT_STATE_DIRECTORY: raw }),
      () => {
        sourceConstructions += 1;
        return { kind: 'source' };
      },
    )).toThrow(/JINN_AUTOPILOT_STATE_DIRECTORY.*absolute|non-empty/i);
    expect(sourceConstructions).toBe(0);
  });

  it('defaults to incremental mode and an hourly full reconciliation', () => {
    expect(parseSnapshotRuntimeConfig({})).toEqual({
      mode: 'incremental',
      fullReconcileMs: DEFAULT_FULL_RECONCILE_MS,
    });
  });

  it('treats only one-shot observe status as cache-first; persistent observe still seeds full', () => {
    expect(isRoutineCachedStatus({
      mode: 'observe', once: true, commandKind: 'status', fullReconcile: false,
    })).toBe(true);
    expect(isRoutineCachedStatus({
      mode: 'observe', once: false, commandKind: 'status', fullReconcile: false,
    })).toBe(false);
    expect(isRoutineCachedStatus({
      mode: 'observe', once: true, commandKind: 'explain-issue', fullReconcile: false,
    })).toBe(false);
    expect(isRoutineCachedStatus({
      mode: 'observe', once: true, commandKind: 'status', fullReconcile: true,
    })).toBe(false);
  });

  it.each(['incremental', 'full'] as const)('accepts %s snapshot mode', (mode) => {
    expect(parseSnapshotRuntimeConfig({
      JINN_AUTOPILOT_SNAPSHOT_MODE: mode,
      JINN_AUTOPILOT_FULL_RECONCILE_MS: '900000',
    })).toEqual({ mode, fullReconcileMs: 900_000 });
  });

  it('fails loud for unknown modes and invalid reconciliation intervals', () => {
    expect(() => parseSnapshotRuntimeConfig({
      JINN_AUTOPILOT_SNAPSHOT_MODE: 'webhook',
    })).toThrow(/JINN_AUTOPILOT_SNAPSHOT_MODE/);
    expect(() => parseSnapshotRuntimeConfig({
      JINN_AUTOPILOT_FULL_RECONCILE_MS: '0',
    })).toThrow(/JINN_AUTOPILOT_FULL_RECONCILE_MS/);
  });
});

describe('LifecycleSnapshotCoordinator', () => {
  it('keeps persistent failed reports on normal cadence without a busy loop', async () => {
    const reports = ['failed', 'ok', 'failed'] as const;
    const observed: string[] = [];
    const waits: number[] = [];
    let cursor = 0;

    await runLifecycleCadence({
      once: false,
      intervalMs: 600_000,
      runCycle: async () => {
        observed.push(reports[cursor]!);
        cursor += 1;
      },
      shouldContinue: () => cursor < reports.length,
      wait: async (ms) => { waits.push(ms); },
    });

    expect(observed).toEqual(['failed', 'ok', 'failed']);
    expect(waits).toEqual([600_000, 600_000]);
  });

  it('propagates one-shot failures without waiting or retrying', async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(runLifecycleCadence({
      once: true,
      intervalMs: 600_000,
      runCycle: async () => {
        calls += 1;
        throw new Error('one-shot failed');
      },
      shouldContinue: () => true,
      wait: async (ms) => { waits.push(ms); },
    })).rejects.toThrow('one-shot failed');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('runs startup full, incremental cadence, and a full read at the exact hourly boundary', async () => {
    let now = START;
    const reads: SnapshotReadMode[] = [];
    const coordinator = new LifecycleSnapshotCoordinator({
      source: source(reads, async (mode) => completeSnapshot(
        mode,
        now.toISOString(),
        mode === 'full' ? now.toISOString() : START.toISOString(),
      )),
      configuredMode: 'incremental',
      fullReconcileMs: 60 * 60_000,
      startupFull: true,
      allowPartial: false,
      now: () => now,
      readUsage: () => EMPTY_GITHUB_USAGE,
    });

    await coordinator.read(500);
    now = new Date(START.getTime() + 60 * 60_000 - 1);
    await coordinator.read(500);
    now = new Date(START.getTime() + 60 * 60_000);
    await coordinator.read(500);

    expect(reads).toEqual(['full', 'incremental', 'full']);
  });

  it('keeps full mode as an every-cycle rollback path', async () => {
    const reads: SnapshotReadMode[] = [];
    const coordinator = new LifecycleSnapshotCoordinator({
      source: source(reads),
      configuredMode: 'full',
      fullReconcileMs: DEFAULT_FULL_RECONCILE_MS,
      startupFull: false,
      allowPartial: false,
      now: () => START,
      readUsage: () => EMPTY_GITHUB_USAGE,
    });

    await coordinator.read(500);
    await coordinator.read(500);
    expect(reads).toEqual(['full', 'full']);
  });

  it('keeps a failed due full reconciliation due for the next retry', async () => {
    let now = START;
    let rejectFull = false;
    const reads: SnapshotReadMode[] = [];
    const resetUsage: Array<boolean | undefined> = [];
    const coordinator = new LifecycleSnapshotCoordinator({
      source: {
        async read(options) {
          reads.push(options.mode);
          resetUsage.push(options.resetUsage);
          if (options.mode === 'full' && rejectFull) throw new Error('full failed');
          return completeSnapshot(
            options.mode,
            now.toISOString(),
            options.mode === 'full' ? now.toISOString() : START.toISOString(),
          );
        },
      },
      configuredMode: 'incremental',
      fullReconcileMs: 60 * 60_000,
      startupFull: true,
      allowPartial: false,
      now: () => now,
      readUsage: () => EMPTY_GITHUB_USAGE,
    });

    await coordinator.read(500);
    now = new Date(START.getTime() + 60 * 60_000);
    rejectFull = true;
    await expect(coordinator.read(500)).resolves.toMatchObject({
      snapshotMode: 'incremental',
      snapshotWarning: expect.stringMatching(/full reconciliation failed.*full failed/i),
    });
    rejectFull = false;
    await coordinator.read(500);

    expect(reads).toEqual(['full', 'full', 'incremental', 'full']);
    expect(resetUsage).toEqual([undefined, undefined, false, undefined]);
  });

  it('does not weaken the full rollback or explicit authoritative read with fallback', async () => {
    for (const options of [
      { configuredMode: 'full' as const, forceFull: false },
      { configuredMode: 'incremental' as const, forceFull: true },
    ]) {
      const reads: SnapshotReadMode[] = [];
      const coordinator = new LifecycleSnapshotCoordinator({
        source: source(reads, async () => {
          throw new Error('full failed');
        }),
        configuredMode: options.configuredMode,
        fullReconcileMs: DEFAULT_FULL_RECONCILE_MS,
        startupFull: true,
        allowPartial: false,
        forceFull: options.forceFull,
        now: () => START,
        readUsage: () => EMPTY_GITHUB_USAGE,
      });
      await expect(coordinator.read(500)).rejects.toThrow('full failed');
      expect(reads).toEqual(['full']);
    }
  });

  it('keeps full due when both the requested full and incremental fallback fail', async () => {
    const reads: SnapshotReadMode[] = [];
    let fail = true;
    const coordinator = new LifecycleSnapshotCoordinator({
      source: source(reads, async (mode) => {
        if (fail) throw new Error(`${mode} failed`);
        return completeSnapshot(mode);
      }),
      configuredMode: 'incremental',
      fullReconcileMs: DEFAULT_FULL_RECONCILE_MS,
      startupFull: true,
      allowPartial: false,
      now: () => START,
      readUsage: () => EMPTY_GITHUB_USAGE,
    });

    await expect(coordinator.read(500)).rejects.toThrow(/both failed/i);
    fail = false;
    await coordinator.read(500);
    expect(reads).toEqual(['full', 'incremental', 'full']);
  });

  it('does not advance the last successful full when a later due full and fallback both fail', async () => {
    let now = START;
    let fail = false;
    const reads: SnapshotReadMode[] = [];
    const coordinator = new LifecycleSnapshotCoordinator({
      source: source(reads, async (mode) => {
        if (fail) throw new Error(`${mode} failed`);
        return completeSnapshot(
          mode,
          now.toISOString(),
          mode === 'full' ? now.toISOString() : START.toISOString(),
        );
      }),
      configuredMode: 'incremental',
      fullReconcileMs: DEFAULT_FULL_RECONCILE_MS,
      startupFull: true,
      allowPartial: false,
      now: () => now,
      readUsage: () => EMPTY_GITHUB_USAGE,
    });

    await coordinator.read(500);
    now = new Date(START.getTime() + DEFAULT_FULL_RECONCILE_MS);
    fail = true;
    await expect(coordinator.read(500)).rejects.toThrow(/both failed/i);
    fail = false;
    await coordinator.read(500);
    expect(reads).toEqual(['full', 'full', 'incremental', 'full']);
  });

  it.each([
    ['incomplete', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, snapshotComplete: false,
    })],
    ['wrong mode', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, snapshotMode: 'full' as const,
    })],
    ['missing mode', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, snapshotMode: undefined,
    })],
    ['stale capture', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, capturedAt: '2026-07-22T09:59:59.999Z',
    })],
    ['future capture', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, capturedAt: '2026-07-22T10:00:00.001Z',
    })],
    ['invalid capture', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, capturedAt: '2026-02-30T10:00:00.000Z',
    })],
    ['missing last-full marker', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, lastFullReconciliationAt: undefined,
    })],
    ['invalid last-full marker', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, lastFullReconciliationAt: '2026-02-30T10:00:00.000Z',
    })],
    ['non-canonical last-full marker', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, lastFullReconciliationAt: '2026-07-22T09:59:59.999+00:00',
    })],
    ['last-full marker after capture', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, lastFullReconciliationAt: '2026-07-22T10:00:00.001Z',
    })],
    ['advanced startup marker', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, lastFullReconciliationAt: START.toISOString(),
    })],
    ['missing usage', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, githubUsage: undefined,
    })],
    ['no live request', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot,
      githubUsage: {
        ...snapshot.githubUsage!,
        graphqlRequests: 0,
        graphqlCost: 0,
        restRequests: 0,
      },
    })],
    ['missing remaining', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot,
      githubUsage: { ...snapshot.githubUsage!, graphqlRemaining: null },
    })],
    ['invalid cost', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot,
      githubUsage: { ...snapshot.githubUsage!, graphqlCost: -1 },
    })],
    ['invalid reset marker', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot,
      githubUsage: {
        ...snapshot.githubUsage!,
        graphqlResetAt: '2026-07-22T11:00:00+00:00',
      },
    })],
  ] as const)('rejects a failed-full fallback with non-authoritative %s evidence', async (
    _label,
    mutate,
  ) => {
    const reads: SnapshotReadMode[] = [];
    let recovered = false;
    const coordinator = new LifecycleSnapshotCoordinator({
      source: source(reads, async (mode) => {
        if (mode === 'full') {
          if (!recovered) throw new Error('full failed');
          return completeSnapshot('full');
        }
        return mutate(startupFallbackSnapshot()) as GitHubLifecycleSnapshot;
      }),
      configuredMode: 'incremental',
      fullReconcileMs: DEFAULT_FULL_RECONCILE_MS,
      startupFull: true,
      allowPartial: false,
      now: () => START,
      readUsage: () => EMPTY_GITHUB_USAGE,
    });

    await expect(coordinator.read(500)).rejects.toThrow(/both failed/i);
    recovered = true;
    await expect(coordinator.read(500)).resolves.toMatchObject({ snapshotMode: 'full' });
    expect(reads).toEqual(['full', 'incremental', 'full']);
  });

  it('rejects a fallback that masquerades as the failed later full reconciliation', async () => {
    let now = START;
    let failFull = false;
    const reads: SnapshotReadMode[] = [];
    const coordinator = new LifecycleSnapshotCoordinator({
      source: source(reads, async (mode) => {
        if (mode === 'full') {
          if (failFull) throw new Error('full failed');
          return completeSnapshot('full', now.toISOString(), now.toISOString());
        }
        return completeSnapshot('incremental', now.toISOString(), now.toISOString());
      }),
      configuredMode: 'incremental',
      fullReconcileMs: DEFAULT_FULL_RECONCILE_MS,
      startupFull: true,
      allowPartial: false,
      now: () => now,
      readUsage: () => EMPTY_GITHUB_USAGE,
    });

    await coordinator.read(500);
    now = new Date(START.getTime() + DEFAULT_FULL_RECONCILE_MS);
    failFull = true;
    await expect(coordinator.read(500)).rejects.toThrow(/both failed/i);
    failFull = false;
    await expect(coordinator.read(500)).resolves.toMatchObject({ snapshotMode: 'full' });
    expect(reads).toEqual(['full', 'full', 'incremental', 'full']);
  });

  it.each([
    ['incomplete', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, snapshotComplete: false,
    })],
    ['wrong mode', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, snapshotMode: 'incremental' as const,
    })],
    ['missing mode', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, snapshotMode: undefined,
    })],
    ['stale capture', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot,
      capturedAt: '2026-07-22T09:59:59.999Z',
      lastFullReconciliationAt: '2026-07-22T09:59:59.999Z',
    })],
    ['invalid capture', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot,
      capturedAt: '2026-02-30T10:00:00.000Z',
      lastFullReconciliationAt: '2026-02-30T10:00:00.000Z',
    })],
    ['missing capture', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, capturedAt: undefined,
    }) as unknown as GitHubLifecycleSnapshot],
    ['missing last-full marker', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, lastFullReconciliationAt: undefined,
    })],
    ['invalid last-full marker', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, lastFullReconciliationAt: '2026-02-30T10:00:00.000Z',
    })],
    ['mismatched marker', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, lastFullReconciliationAt: '2026-07-22T10:00:00.001Z',
    })],
    ['missing usage', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot, githubUsage: undefined,
    })],
    ['no live request', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot,
      githubUsage: { ...snapshot.githubUsage!, graphqlRequests: 0 },
    })],
    ['missing remaining', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot,
      githubUsage: { ...snapshot.githubUsage!, graphqlRemaining: null },
    })],
    ['invalid reset marker', (snapshot: GitHubLifecycleSnapshot) => ({
      ...snapshot,
      githubUsage: {
        ...snapshot.githubUsage!,
        graphqlResetAt: '2026-07-22T11:00:00+00:00',
      },
    })],
  ] as const)('rejects a requested full with non-authoritative %s evidence', async (
    _label,
    mutate,
  ) => {
    const reads: SnapshotReadMode[] = [];
    let fullReads = 0;
    const coordinator = new LifecycleSnapshotCoordinator({
      source: source(reads, async (mode) => {
        if (mode === 'incremental') return startupFallbackSnapshot();
        fullReads += 1;
        const authoritative = completeSnapshot('full');
        return fullReads === 1 ? mutate(authoritative) : authoritative;
      }),
      configuredMode: 'incremental',
      fullReconcileMs: DEFAULT_FULL_RECONCILE_MS,
      startupFull: true,
      allowPartial: false,
      now: () => START,
      readUsage: () => EMPTY_GITHUB_USAGE,
    });

    await expect(coordinator.read(500)).resolves.toMatchObject({
      snapshotMode: 'incremental',
      snapshotWarning: expect.stringMatching(/full.*authoritative/i),
    });
    await expect(coordinator.read(500)).resolves.toMatchObject({ snapshotMode: 'full' });
    expect(reads).toEqual(['full', 'incremental', 'full']);
  });

  it('repairs a future-dated full marker with an authoritative read', async () => {
    let now = START;
    const reads: SnapshotReadMode[] = [];
    let fullReads = 0;
    const coordinator = new LifecycleSnapshotCoordinator({
      source: source(reads, async (mode) => {
        if (mode === 'incremental') return startupFallbackSnapshot();
        fullReads += 1;
        const marker = fullReads === 1
          ? new Date(now.getTime() + 60_000).toISOString()
          : now.toISOString();
        return completeSnapshot(mode, marker, marker);
      }),
      configuredMode: 'incremental',
      fullReconcileMs: DEFAULT_FULL_RECONCILE_MS,
      startupFull: true,
      allowPartial: false,
      now: () => now,
      readUsage: () => EMPTY_GITHUB_USAGE,
    });

    await coordinator.read(500);
    now = new Date(START.getTime() + 1_000);
    await coordinator.read(500);
    expect(reads).toEqual(['full', 'incremental', 'full']);
  });

  it('uses an incremental update for routine status and returns a marked partial view without a seed', async () => {
    const reads: SnapshotReadMode[] = [];
    const coordinator = new LifecycleSnapshotCoordinator({
      source: source(reads, async () => {
        throw new IncrementalSnapshotUnavailableError();
      }),
      configuredMode: 'incremental',
      fullReconcileMs: DEFAULT_FULL_RECONCILE_MS,
      startupFull: false,
      allowPartial: true,
      now: () => START,
      readUsage: () => EMPTY_GITHUB_USAGE,
    });

    const snapshot = await coordinator.read(500);
    expect(reads).toEqual(['incremental']);
    expect(snapshot).toMatchObject({
      snapshotMode: 'incremental',
      snapshotComplete: false,
      lastFullReconciliationAt: null,
      capturedAt: START.toISOString(),
      partialReason: expect.stringMatching(/no complete full-reconciliation seed/i),
      lifecycle: { items: [] },
    });
  });

  it('also degrades a corrupt routine-status cache to a partial non-authoritative view', async () => {
    const coordinator = new LifecycleSnapshotCoordinator({
      source: source([], async () => {
        throw new LifecycleDiscoveryCacheCorruptError('invalid JSON');
      }),
      configuredMode: 'incremental',
      fullReconcileMs: DEFAULT_FULL_RECONCILE_MS,
      startupFull: false,
      allowPartial: true,
      now: () => START,
      readUsage: () => EMPTY_GITHUB_USAGE,
    });

    await expect(coordinator.read(500)).resolves.toMatchObject({
      snapshotComplete: false,
      partialReason: expect.stringMatching(/corrupt.*invalid JSON/i),
    });
  });

  it('forces an authoritative full one-shot even for routine status', async () => {
    const reads: SnapshotReadMode[] = [];
    const coordinator = new LifecycleSnapshotCoordinator({
      source: source(reads),
      configuredMode: 'incremental',
      fullReconcileMs: DEFAULT_FULL_RECONCILE_MS,
      startupFull: false,
      allowPartial: true,
      forceFull: true,
      now: () => START,
      readUsage: () => EMPTY_GITHUB_USAGE,
    });

    await coordinator.read(500);
    expect(reads).toEqual(['full']);
  });
});
