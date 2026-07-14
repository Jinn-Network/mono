import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HarvestStateStore,
  MAX_HARVEST_INFRA_RETRIES,
  classifyHarvestFailure,
  harvestTaskKey,
} from '../../src/solver-types/_swe-rebench-v2-harvest-state.js';

const repo = 'acme/widget';
const base = 'a'.repeat(40);
const fix = 'b'.repeat(40);

const candidate = {
  instance_id: 'acme__widget__echo-bbbbbbbbbbbb',
  repo,
  base_commit: base,
  fix_commit: fix,
  gold_patch: 'diff --git a/src/widget.ts b/src/widget.ts',
  test_patch: 'diff --git a/test/widget.test.ts b/test/widget.test.ts',
  test_paths: ['test/widget.test.ts'],
  language: 'typescript',
  problem_statement: 'fix widget',
};

describe('HarvestStateStore v2', () => {
  it('migrates v1 cursor/rejections without discarding them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harvest-state-v1-'));
    try {
      await writeFile(join(dir, 'harvest-state.json'), JSON.stringify({
        schemaVersion: 'swe-rebench-v2-harvest-state.v1',
        updatedAt: '2026-01-01T00:00:00.000Z',
        repos: { [repo]: { lastScannedCommit: base, rejected: { old: { reason: 'policy: denied', at: '2026-01-01T00:00:00.000Z' } } } },
      }));
      const store = new HarvestStateStore({ stateDir: dir });
      expect((await store.getRepo(repo))?.lastScannedCommit).toBe(base);
      expect(store.isRejected(await store.getRepo(repo), 'old')).toBe(true);
      expect(JSON.parse(await readFile(join(dir, 'harvest-state.json'), 'utf8')).schemaVersion).toBe('swe-rebench-v2-harvest-state.v2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists discovered jobs before atomically advancing the cursor and resumes them due', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harvest-state-jobs-'));
    try {
      const store = new HarvestStateStore({ stateDir: dir });
      await store.persistDiscoveredJobs({ repo, cursor: fix, candidates: [candidate], recipeHash: 'sha256:recipe' });
      const taskKey = harvestTaskKey(repo, fix);
      expect((await store.getJob(taskKey))?.candidate.test_patch).toBe(candidate.test_patch);
      expect((await store.getRepo(repo))?.lastScannedCommit).toBe(fix);
      expect((await store.getDueJobs()).map((job) => job.taskKey)).toEqual([taskKey]);

      // A restarted store gets the same durable job rather than re-mining or losing it.
      const restarted = new HarvestStateStore({ stateDir: dir });
      expect((await restarted.getDueJobs()).map((job) => job.taskKey)).toEqual([taskKey]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('classifies policy/input/flaky outcomes as terminal and bounds infrastructure retries', async () => {
    expect(classifyHarvestFailure('policy: denied license')).toBe('terminal_policy');
    expect(classifyHarvestFailure('unsupported: no trusted recipe')).toBe('awaiting_input');
    expect(classifyHarvestFailure('flaky empirical outcome')).toBe('quarantined');

    const dir = await mkdtemp(join(tmpdir(), 'harvest-state-retry-'));
    try {
      const store = new HarvestStateStore({ stateDir: dir });
      await store.persistDiscoveredJobs({ repo, cursor: fix, candidates: [candidate] });
      const taskKey = harvestTaskKey(repo, fix);
      for (let attempt = 1; attempt <= MAX_HARVEST_INFRA_RETRIES; attempt += 1) {
        await store.markJobFailure(taskKey, 'docker transport reset', { now: new Date(`2026-01-01T00:00:0${attempt}.000Z`), retryDelayMs: 0 });
      }
      expect((await store.getJob(taskKey))?.disposition).toBe('failed_infrastructure');
      expect((await store.getDueJobs(new Date('2026-01-02T00:00:00.000Z')))).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('requeues only matching awaiting-input jobs when trusted configuration arrives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harvest-state-resume-'));
    try {
      const store = new HarvestStateStore({ stateDir: dir });
      await store.persistDiscoveredJobs({ repo, cursor: fix, candidates: [candidate] });
      const taskKey = harvestTaskKey(repo, fix);
      await store.markJobFailure(taskKey, 'awaiting_input:recipe-required: no trusted recipe');

      const untouched = await store.resumeAwaitingInputJobs({
        repo,
        recipeHash: 'sha256:recipe-v2',
        predicate: (job) => job.baseCommit === 'not-this-base',
      });
      expect(untouched).toEqual([]);
      expect((await store.getJob(taskKey))?.disposition).toBe('awaiting_input');

      const resumed = await store.resumeAwaitingInputJobs({
        repo,
        recipeHash: 'sha256:recipe-v2',
        predicate: (job) => job.baseCommit === base,
      });
      expect(resumed.map((job) => job.taskKey)).toEqual([taskKey]);
      const job = await store.getJob(taskKey);
      expect(job).toMatchObject({ disposition: 'pending', stage: 'discovered', recipeHash: 'sha256:recipe-v2' });
      expect((await store.getDueJobs()).map((due) => due.taskKey)).toEqual([taskKey]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not reopen a missing-test-patch awaiting job when an explicit recipe arrives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harvest-state-no-test-requeue-'));
    try {
      const store = new HarvestStateStore({ stateDir: dir });
      await store.persistDiscoveredJobs({ repo, cursor: fix, candidates: [candidate] });
      const taskKey = harvestTaskKey(repo, fix);
      await store.markJobFailure(taskKey, 'awaiting_input:test-patch-required: commit carries no regression test patch');

      expect(await store.resumeAwaitingInputJobs({
        repo,
        recipeHash: 'sha256:recipe-v2',
        predicate: () => true,
      })).toEqual([]);
      expect(await store.getJob(taskKey)).toMatchObject({
        disposition: 'awaiting_input',
        reason: 'awaiting_input:test-patch-required: commit carries no regression test patch',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
