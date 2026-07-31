import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectCandidates, parseExcludeFile, resolveExclusions } from '../../scripts/skills-bench/build-slate.js';
import { splitSlate } from '../../src/skills-bench/slate.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';

// Real active held-out id (swe-rebench-v2.v1 slate v3) — exercises the actual
// loadActiveHeldOutSlateIds exclusion selectCandidates hard-codes, not a mock.
const KNOWN_HELD_OUT_ID = 'sympy__sympy-27593';

function task(id: string, repo: string): PoolTask {
  return {
    instance_id: id,
    hf_dataset: 'nebius/SWE-rebench-leaderboard',
    hf_split: '2025_01',
    repo,
  };
}

describe('selectCandidates (#skills-bench build-slate)', () => {
  it('drops a known active held-out id', () => {
    const pool = [
      task(KNOWN_HELD_OUT_ID, 'sympy/sympy'),
      task('fix-widget-0001', 'acme/widget'),
    ];
    const selected = selectCandidates(pool, 'jinn.skills-bench.v1', 10);
    expect(selected.map((c) => c.instance_id)).not.toContain(KNOWN_HELD_OUT_ID);
    expect(selected.map((c) => c.instance_id)).toContain('fix-widget-0001');
  });

  it('caps candidates at 2 per repo', () => {
    const pool = Array.from({ length: 5 }, (_, i) => task(`fix-widget-${String(i).padStart(4, '0')}`, 'acme/widget'));
    const selected = selectCandidates(pool, 'jinn.skills-bench.v1', 10);
    expect(selected).toHaveLength(2);
    expect(selected.every((c) => c.repo === 'acme/widget')).toBe(true);
  });

  it('enforces the per-repo cap across multiple repos while keeping eligible ids', () => {
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => task(`fix-widget-${String(i).padStart(4, '0')}`, 'acme/widget')),
      ...Array.from({ length: 3 }, (_, i) => task(`fix-gadget-${String(i).padStart(4, '0')}`, 'acme/gadget')),
    ];
    const selected = selectCandidates(pool, 'jinn.skills-bench.v1', 10);
    const perRepo = new Map<string, number>();
    for (const c of selected) perRepo.set(c.repo, (perRepo.get(c.repo) ?? 0) + 1);
    expect(perRepo.get('acme/widget')).toBe(2);
    expect(perRepo.get('acme/gadget')).toBe(2);
    expect(selected).toHaveLength(4);
  });

  it('is deterministic for a fixed seed regardless of input order', () => {
    const pool = Array.from({ length: 5 }, (_, i) => task(`fix-widget-${String(i).padStart(4, '0')}`, `acme/repo-${i}`));
    const a = selectCandidates(pool, 'jinn.skills-bench.v1', 10);
    const b = selectCandidates([...pool].reverse(), 'jinn.skills-bench.v1', 10);
    expect(a.map((c) => c.instance_id)).toEqual(b.map((c) => c.instance_id));
  });

  it('excludes an additionalExcludeIds member even when it seed-ranks first', () => {
    const pool = Array.from({ length: 6 }, (_, i) => task(`fix-widget-${String(i).padStart(4, '0')}`, `acme/repo-${i}`));
    const withoutExclusion = selectCandidates(pool, 'jinn.skills-bench.v1', 10);
    const topRanked = withoutExclusion[0]!.instance_id;

    const withExclusion = selectCandidates(pool, 'jinn.skills-bench.v1', 10, new Set([topRanked]));
    expect(withExclusion.map((c) => c.instance_id)).not.toContain(topRanked);
    expect(withExclusion).toHaveLength(withoutExclusion.length - 1);
    // Every other member survives untouched — exclusion doesn't reorder the rest.
    expect(withExclusion.map((c) => c.instance_id))
      .toEqual(withoutExclusion.slice(1).map((c) => c.instance_id));
  });

  it('applies additionalExcludeIds before the per-repo cap and seed-ranked take', () => {
    // 3 candidates in one repo (cap is 2); excluding the seed-ranked-first of
    // the three must let the third-ranked one in under the cap instead of
    // silently shrinking the repo's contribution to 1.
    const pool = [task('fix-a', 'acme/widget'), task('fix-b', 'acme/widget'), task('fix-c', 'acme/widget')];
    const unfiltered = selectCandidates(pool, 'jinn.skills-bench.v1', 10);
    expect(unfiltered).toHaveLength(2); // cap enforced pre-exclusion, sanity check
    const firstRanked = unfiltered[0]!.instance_id;

    const filtered = selectCandidates(pool, 'jinn.skills-bench.v1', 10, new Set([firstRanked]));
    expect(filtered.map((c) => c.instance_id)).not.toContain(firstRanked);
    expect(filtered).toHaveLength(2); // the cap still admits 2 — the third candidate fills in
  });

  it('a same-seed rebuild minus exclusions differs in hash and membership', () => {
    const pool = Array.from({ length: 40 }, (_, i) => task(`fix-widget-${String(i).padStart(4, '0')}`, `acme/repo-${i % 20}`));
    const seed = 'jinn.skills-bench.v1';
    const full = selectCandidates(pool, seed, 32);
    const slateA = splitSlate(full, { seed, feedbackSize: 15, holdoutSize: 15 });

    const excludedId = full[0]!.instance_id;
    const filtered = selectCandidates(pool, seed, 32, new Set([excludedId]));
    const slateB = splitSlate(filtered, { seed, feedbackSize: 15, holdoutSize: 15 });

    expect(slateA.sha256).not.toBe(slateB.sha256);
    const idsA = new Set([...slateA.feedback, ...slateA.holdout].map((c) => c.instance_id));
    const idsB = new Set([...slateB.feedback, ...slateB.holdout].map((c) => c.instance_id));
    expect(idsA.has(excludedId)).toBe(true);
    expect(idsB.has(excludedId)).toBe(false);
  });
});

describe('parseExcludeFile', () => {
  it('accepts plain instance-id strings', () => {
    const parsed = parseExcludeFile(JSON.stringify(['zarr-developers__zarr-python-2629', 'foo__bar-1']));
    expect(parsed).toEqual([
      { instance_id: 'zarr-developers__zarr-python-2629', reason: expect.any(String) },
      { instance_id: 'foo__bar-1', reason: expect.any(String) },
    ]);
  });

  it('accepts {instance_id, reason} objects', () => {
    const parsed = parseExcludeFile(JSON.stringify([{ instance_id: 'zarr-developers__zarr-python-2629', reason: 'conftest_import_error' }]));
    expect(parsed).toEqual([{ instance_id: 'zarr-developers__zarr-python-2629', reason: 'conftest_import_error' }]);
  });

  it('supports mixed plain-id and object entries in the same file', () => {
    const parsed = parseExcludeFile(JSON.stringify([
      'plain-id-1',
      { instance_id: 'obj-id-1', reason: 'some reason' },
    ]));
    expect(parsed.map((e) => e.instance_id)).toEqual(['plain-id-1', 'obj-id-1']);
    expect(parsed[1]!.reason).toBe('some reason');
  });

  it('rejects a non-array JSON payload', () => {
    expect(() => parseExcludeFile(JSON.stringify({ instance_id: 'x' }))).toThrow(/JSON array/);
  });

  it('rejects an entry that is neither a string nor an {instance_id} object', () => {
    expect(() => parseExcludeFile(JSON.stringify([42]))).toThrow(/instance_id/);
  });
});

describe('resolveExclusions', () => {
  it('merges --exclude-instances (comma list) into ExcludedCandidate entries', () => {
    const resolved = resolveExclusions({ excludeInstances: 'id-1, id-2 ,id-3' });
    expect(resolved.map((e) => e.instance_id)).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('merges --exclude-file and --exclude-instances, de-duping a shared id in favor of the flag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'exclude-file-'));
    const file = join(dir, 'exclude.json');
    await writeFile(file, JSON.stringify([{ instance_id: 'dup-id', reason: 'from-file' }, { instance_id: 'file-only-id', reason: 'x' }]));

    const resolved = resolveExclusions({ excludeFile: file, excludeInstances: 'dup-id,flag-only-id' });
    expect(resolved).toHaveLength(3); // dup-id counted once
    const dup = resolved.find((e) => e.instance_id === 'dup-id')!;
    expect(dup.reason).not.toBe('from-file'); // --exclude-instances applied after the file, so it wins
    expect(resolved.map((e) => e.instance_id)).toEqual(
      expect.arrayContaining(['dup-id', 'file-only-id', 'flag-only-id']),
    );
  });

  it('is empty when neither flag is given', () => {
    expect(resolveExclusions({})).toEqual([]);
  });
});
