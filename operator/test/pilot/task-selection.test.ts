import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  distillationSourceIds,
  isCleanBenchmarkTask,
  selectValidatedCleanTasks,
  verifySelectedTaskAdmission,
} from '../../src/pilot/task-selection.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';
import type { ValidatedPoolEntry } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';

const CLEAN_FLAGS = {
  B1: false,
  B2: false,
  B3: false,
  B4: false,
  B5: false,
  B6: false,
};

function task(id: string, assessments: unknown = [{ code: 'A', detected_issues: CLEAN_FLAGS }]): PoolTask {
  return {
    instance_id: id,
    hf_dataset: 'nebius/SWE-rebench-leaderboard',
    hf_split: '2025_01',
    repo: 'acme/widget',
    base_commit: 'a'.repeat(40),
    language: 'python',
    problem_statement: 'Fix the widget.',
    interface: 'Function: fix_widget()',
    patch: 'diff --git a/widget.py b/widget.py\n',
    test_patch: 'diff --git a/test_widget.py b/test_widget.py\n',
    meta: { llm_metadata: assessments } as PoolTask['meta'],
  };
}

function validation(id: string): ValidatedPoolEntry {
  return {
    scorable: true,
    reason: 'gold-patch-resolves',
    checkedAt: '2026-07-09T00:00:00.000Z',
    rowHash: `sha256:${createHash('sha256').update(id).digest('hex')}`,
  };
}

describe('benchmark quality admission', () => {
  it('accepts present all-A metadata with every issue flag false', () => {
    expect(isCleanBenchmarkTask(task('clean__task-1'))).toBe(true);
  });

  it('accepts the production V2 singleton llm_metadata shape', () => {
    expect(isCleanBenchmarkTask({
      ...task('clean__task-2'),
      meta: { llm_metadata: { code: 'A', detected_issues: CLEAN_FLAGS } },
    } as PoolTask)).toBe(true);
  });

  it.each(['B1', 'B2', 'B3', 'B4', 'B5', 'B6'])('rejects a true %s issue flag', (issue) => {
    expect(isCleanBenchmarkTask(task('dirty__task-1', [{
      code: issue,
      detected_issues: { ...CLEAN_FLAGS, [issue]: true },
    }]))).toBe(false);
  });

  it.each([
    undefined,
    {},
    { llm_metadata: [] },
    { llm_metadata: [{ code: 'A' }] },
    { llm_metadata: [{ code: 'A', detected_issues: { B1: false } }] },
  ])('rejects missing or malformed quality metadata %#', (meta) => {
    expect(isCleanBenchmarkTask({ ...task('malformed__task-1'), meta } as PoolTask)).toBe(false);
  });
});

describe('distillation provenance exclusion', () => {
  it('collects every source instance from selected clusters only', () => {
    expect(distillationSourceIds({
      selected: [
        { clusterId: 'contrastive:a', instanceIds: ['repo__one-1', 'repo__two-2'] },
        { clusterId: 'lesson:b', instanceIds: ['repo__one-1', 'repo__three-3'] },
      ],
      rejected: [{ clusterId: 'lesson:c', instanceIds: ['not__selected-4'] }],
    })).toEqual(new Set(['repo__one-1', 'repo__two-2', 'repo__three-3']));
  });

  it.each([{}, { selected: {} }, { selected: [{ instanceIds: 'bad' }] }])(
    'rejects malformed selection data %#',
    (raw) => expect(() => distillationSourceIds(raw)).toThrow('selection'),
  );
});

describe('validated clean selection', () => {
  it('is deterministic across pool order and excludes dirty, unvalidated, and provenance tasks', () => {
    const eligible = Array.from({ length: 8 }, (_, index) => task(`eligible__repo-${index}`));
    const dirty = task('dirty__repo-1', [{ code: 'B3', detected_issues: { ...CLEAN_FLAGS, B3: true } }]);
    const unvalidated = task('unvalidated__repo-1');
    const provenance = task('source__repo-1');
    const pool = [...eligible, dirty, unvalidated, provenance];
    const scorableEntries = Object.fromEntries(
      [...eligible, dirty, provenance].map((item) => [item.instance_id, validation(item.instance_id)]),
    );
    const args = {
      scorableEntries,
      excludedIds: new Set([provenance.instance_id]),
      count: 5,
      seed: 'fixed-seed',
    };

    const first = selectValidatedCleanTasks({ ...args, pool });
    const second = selectValidatedCleanTasks({ ...args, pool: [...pool].reverse() });

    expect(second).toEqual(first);
    expect(first).toHaveLength(5);
    expect(first.every((entry) => entry.instance_id.startsWith('eligible__repo-'))).toBe(true);
    expect(new Set(first.map((entry) => entry.instance_id)).size).toBe(5);
  });

  it('requires validation row hashes and enough eligible tasks', () => {
    const candidate = task('eligible__repo-1');
    expect(() => selectValidatedCleanTasks({
      pool: [candidate],
      scorableEntries: {
        [candidate.instance_id]: { ...validation(candidate.instance_id), rowHash: undefined },
      },
      excludedIds: new Set(),
      count: 1,
      seed: 'fixed-seed',
    })).toThrow('eligible');
  });

  it('fails verification on split drift and provenance overlap', () => {
    const candidate = task('eligible__repo-1');
    const selected = selectValidatedCleanTasks({
      pool: [candidate],
      scorableEntries: { [candidate.instance_id]: validation(candidate.instance_id) },
      excludedIds: new Set(),
      count: 1,
      seed: 'fixed-seed',
    });

    expect(() => verifySelectedTaskAdmission({
      selected,
      pool: [{ ...candidate, hf_split: '2025_02' }],
      scorableEntries: { [candidate.instance_id]: validation(candidate.instance_id) },
      excludedIds: new Set(),
    })).toThrow('split');

    expect(() => verifySelectedTaskAdmission({
      selected,
      pool: [candidate],
      scorableEntries: { [candidate.instance_id]: validation(candidate.instance_id) },
      excludedIds: new Set([candidate.instance_id]),
    })).toThrow('excluded');
  });
});
