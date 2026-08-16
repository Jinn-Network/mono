import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  VERSION,
  loadQualityScreen,
  resolveExcludedActiveSlateVersions,
} from '../../scripts/build-pilot-slate.js';
import { selectValidatedCleanTasks } from '../../src/pilot/task-selection.js';
import {
  ACTIVE_HELD_OUT_SLATE_VERSIONS,
  hashHeldOutSlateArtifact,
  loadActiveHeldOutSlateIds,
  loadHeldOutSlate,
  type HeldOutSlateArtifact,
} from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';
import type { ValidatedPoolEntry } from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';

const SOLVER_TYPE = 'swe-rebench-v2.v1';
const SLATE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'solver-types',
  'slates',
);
const KNOWN_V3_MEMBER = 'sympy__sympy-27593';
const SHIPPED_V3_HASH =
  'sha256:b6b1230f855fa26bb7daa8feec880a9ee2fcf44a67b54c83830c7ee50db6749e';

const CLEAN_FLAGS = {
  B1: false, B2: false, B3: false, B4: false, B5: false, B6: false,
};

function task(id: string): PoolTask {
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
    meta: {
      llm_metadata: { code: 'A', detected_issues: CLEAN_FLAGS },
    } as PoolTask['meta'],
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

describe('resolveExcludedActiveSlateVersions (#1563)', () => {
  it('excludes the version under construction from active older-slate exclusion', () => {
    expect(
      resolveExcludedActiveSlateVersions(['v1', 'v2', 'v3'], 'v3'),
    ).toEqual(['v1', 'v2']);
    expect(
      resolveExcludedActiveSlateVersions(ACTIVE_HELD_OUT_SLATE_VERSIONS, VERSION),
    ).toEqual(['v1', 'v2']);
  });

  it('keeps shipped v3 members out of the older-slate exclusion set', () => {
    const shipped = loadHeldOutSlate(SOLVER_TYPE, VERSION, { dir: SLATE_DIR });
    expect(shipped.hash).toBe(SHIPPED_V3_HASH);

    const buggy = loadActiveHeldOutSlateIds(
      SOLVER_TYPE,
      ACTIVE_HELD_OUT_SLATE_VERSIONS,
      { dir: SLATE_DIR },
    );
    const fixed = loadActiveHeldOutSlateIds(
      SOLVER_TYPE,
      resolveExcludedActiveSlateVersions(ACTIVE_HELD_OUT_SLATE_VERSIONS, VERSION),
      { dir: SLATE_DIR },
    );
    expect(buggy.has(KNOWN_V3_MEMBER)).toBe(true);
    expect(fixed.has(KNOWN_V3_MEMBER)).toBe(false);
    for (const id of shipped.instanceIds) {
      expect(buggy.has(id)).toBe(true);
      expect(fixed.has(id)).toBe(false);
    }
    // shipped report field contract
    expect(
      resolveExcludedActiveSlateVersions(ACTIVE_HELD_OUT_SLATE_VERSIONS, VERSION),
    ).toEqual(
      JSON.parse(
        readFileSync(
          join(SLATE_DIR, 'held-out-slate.swe-rebench-v2.v3.screening-report.json'),
          'utf8',
        ),
      ).excludedActiveSlateVersions,
    );
  });
});

describe('loadQualityScreen (#1563)', () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('accepts the builder emit shape { schema, model, assessments }', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qs-object-'));
    tmps.push(dir);
    const assessments = [
      { instance_id: 'repo__one-1', code: 'A' as const, reason: 'clean' },
      { instance_id: 'repo__two-2', code: 'B3' as const, reason: 'issue' },
    ];
    const path = join(dir, 'quality-screen.json');
    const body = {
      schema: 'jinn.pilot.quality-screen.v1',
      model: 'claude-haiku-4-5-20251001',
      assessments,
    };
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
    const loaded = loadQualityScreen(path);
    expect(loaded.assessments).toEqual(assessments);
    expect(loaded.bytes).toBe(`${JSON.stringify(body, null, 2)}\n`);
  });

  it('still accepts a legacy bare assessment array', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qs-array-'));
    tmps.push(dir);
    const assessments = [
      { instance_id: 'repo__one-1', code: 'A' as const, reason: 'clean' },
    ];
    const path = join(dir, 'quality-screen.json');
    writeFileSync(path, JSON.stringify(assessments));
    expect(loadQualityScreen(path).assessments).toEqual(assessments);
  });

  it('loads the shipped v3 quality-screen sibling without throwing', () => {
    const path = join(SLATE_DIR, 'held-out-slate.swe-rebench-v2.v3.quality-screen.json');
    const loaded = loadQualityScreen(path);
    expect(loaded.assessments.length).toBe(36);
    expect(loaded.assessments.every((a) => typeof a.instance_id === 'string')).toBe(true);
    expect(JSON.parse(loaded.bytes).schema).toBe('jinn.pilot.quality-screen.v1');
  });

  it('rejects unknown object shapes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qs-bad-'));
    tmps.push(dir);
    const path = join(dir, 'quality-screen.json');
    writeFileSync(path, JSON.stringify({ schema: 'jinn.pilot.quality-screen.v1', model: 'x' }));
    expect(() => loadQualityScreen(path)).toThrow(/assessments|array/i);
  });
});

describe('selection impact of self-exclusion (#1563 AC1)', () => {
  it('preserves a v3 member that full-ACTIVE exclusion would drop, yielding a stable fixture hash', () => {
    const filler = Array.from({ length: 5 }, (_, i) => task(`eligible__repo-${i}`));
    const v3Member = task(KNOWN_V3_MEMBER);
    const pool = [...filler, v3Member];
    const scorableEntries = Object.fromEntries(
      pool.map((item) => [item.instance_id, validation(item.instance_id)]),
    );
    const seed = 'jinn.pilot.validated-clean.v3';

    const buggyExcluded = new Set(
      loadActiveHeldOutSlateIds(SOLVER_TYPE, ACTIVE_HELD_OUT_SLATE_VERSIONS, { dir: SLATE_DIR }),
    );
    const fixedExcluded = new Set(
      loadActiveHeldOutSlateIds(
        SOLVER_TYPE,
        resolveExcludedActiveSlateVersions(ACTIVE_HELD_OUT_SLATE_VERSIONS, VERSION),
        { dir: SLATE_DIR },
      ),
    );

    expect(buggyExcluded.has(KNOWN_V3_MEMBER)).toBe(true);
    expect(fixedExcluded.has(KNOWN_V3_MEMBER)).toBe(false);

    expect(() => selectValidatedCleanTasks({
      pool,
      scorableEntries,
      excludedIds: buggyExcluded,
      count: 6,
      seed,
    })).toThrow(/eligible/);

    const selected = selectValidatedCleanTasks({
      pool,
      scorableEntries,
      excludedIds: fixedExcluded,
      count: 6,
      seed,
    });
    expect(selected.map((e) => e.instance_id)).toContain(KNOWN_V3_MEMBER);
    expect(selected).toHaveLength(6);

    const artifact: HeldOutSlateArtifact = {
      schemaVersion: 'held-out-slate.v1',
      solverType: SOLVER_TYPE,
      version: VERSION,
      generatedAt: '2026-07-10T12:57:36.423Z',
      instanceIds: selected.map((e) => e.instance_id),
    };
    const hash = hashHeldOutSlateArtifact(artifact);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Re-select and re-hash: deterministic under fixed exclusion.
    const selectedAgain = selectValidatedCleanTasks({
      pool: [...pool].reverse(),
      scorableEntries,
      excludedIds: fixedExcluded,
      count: 6,
      seed,
    });
    expect(selectedAgain.map((e) => e.instance_id)).toEqual(
      selected.map((e) => e.instance_id),
    );
    expect(
      hashHeldOutSlateArtifact({ ...artifact, instanceIds: selectedAgain.map((e) => e.instance_id) }),
    ).toBe(hash);

    // Shipped hash is locked against the real artifact; fixture hash differs
    // because hermetic pools cannot replay the original HF + validated-pool inputs.
    expect(loadHeldOutSlate(SOLVER_TYPE, VERSION, { dir: SLATE_DIR }).hash).toBe(SHIPPED_V3_HASH);
    expect(hash).not.toBe(SHIPPED_V3_HASH);
  });
});
