import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MineableTraceStore,
  buildMineableRecord,
  type MineableTraceRecord,
} from '../../src/solver-types/_swe-rebench-v2-mineable-store.js';

function record(overrides: Partial<MineableTraceRecord> = {}): MineableTraceRecord {
  return {
    sourceId: 'src-1',
    kind: 'solvernet-execution',
    repo: 'acme/widget',
    baseCommit: 'abc123',
    acceptedDiff: 'diff --git a/x b/x\n+1\n',
    testRuns: [{ cmd: 'pytest', exitCode: 0, at: '2026-07-01T00:00:00.000Z' }],
    intermediateFailureDiffs: ['diff --git a/x b/x\n-1\n'],
    skillEvents: [{ skill: 'systematic-debugging', action: 'invoked' }],
    sourceInstanceId: 'inst-1',
    publishMinedTasksConsent: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'mineable-trace-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('MineableTraceStore', () => {
  it('refuses to append without tier-1 consent (fail closed, D2)', async () => {
    await withTmpDir(async (dir) => {
      const store = new MineableTraceStore({ stateDir: dir });
      await expect(store.append(record(), 'off')).rejects.toThrow(/consent/);
      expect(await store.listUnmined()).toEqual([]);
      // AC1a: a tier-1 refused append performs ZERO I/O — the store file must not
      // even be created. The store throws before any writeJsonAtomic, so no file
      // exists on disk after a refused append.
      expect(existsSync(join(dir, 'mineable-traces.json'))).toBe(false);
    });
  });

  it('appends with consent and round-trips all five contract fields', async () => {
    await withTmpDir(async (dir) => {
      const store = new MineableTraceStore({ stateDir: dir });
      const r = record();
      await store.append(r, 'retain_local');
      const [got] = await store.listUnmined();
      expect(got).toEqual(r);
    });
  });

  it('markMined removes from the unmined list but keeps the record on disk', async () => {
    await withTmpDir(async (dir) => {
      const store = new MineableTraceStore({ stateDir: dir });
      await store.append(record({ sourceId: 's1' }), 'retain_local');
      await store.markMined('s1');
      expect(await store.listUnmined()).toEqual([]);
    });
  });
});

describe('buildMineableRecord', () => {
  it('fills optional contract fields with empty defaults and stamps createdAt from now()', () => {
    const got = buildMineableRecord({
      sourceId: 'req-1',
      kind: 'solvernet-execution',
      repo: 'acme/widget',
      baseCommit: 'a'.repeat(40),
      acceptedDiff: 'diff --git a/x b/x\n+1\n',
      publishMinedTasksConsent: false,
      now: () => '2026-07-13T00:00:00.000Z',
    });
    expect(got).toEqual({
      sourceId: 'req-1',
      kind: 'solvernet-execution',
      repo: 'acme/widget',
      baseCommit: 'a'.repeat(40),
      acceptedDiff: 'diff --git a/x b/x\n+1\n',
      testRuns: [],
      intermediateFailureDiffs: [],
      skillEvents: [],
      publishMinedTasksConsent: false,
      createdAt: '2026-07-13T00:00:00.000Z',
    });
    expect(got.sourceInstanceId).toBeUndefined();
  });

  it('carries through explicit optional fields, including sourceInstanceId', () => {
    const got = buildMineableRecord({
      sourceId: 'req-2',
      kind: 'solvernet-execution',
      repo: 'acme/widget',
      baseCommit: 'b'.repeat(40),
      acceptedDiff: 'diff --git a/y b/y\n+2\n',
      testRuns: [{ cmd: 'pytest', exitCode: 0, at: '2026-07-01T00:00:00.000Z' }],
      intermediateFailureDiffs: ['diff --git a/y b/y\n-2\n'],
      skillEvents: [{ skill: 'systematic-debugging', action: 'invoked' }],
      sourceInstanceId: 'org__widget-1',
      publishMinedTasksConsent: true,
      now: () => '2026-07-13T00:00:00.000Z',
    });
    expect(got.sourceInstanceId).toBe('org__widget-1');
    expect(got.testRuns).toEqual([{ cmd: 'pytest', exitCode: 0, at: '2026-07-01T00:00:00.000Z' }]);
    expect(got.intermediateFailureDiffs).toEqual(['diff --git a/y b/y\n-2\n']);
    expect(got.skillEvents).toEqual([{ skill: 'systematic-debugging', action: 'invoked' }]);
    expect(got.publishMinedTasksConsent).toBe(true);
  });
});
