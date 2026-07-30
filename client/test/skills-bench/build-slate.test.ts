import { describe, expect, it } from 'vitest';
import { selectCandidates } from '../../scripts/skills-bench/build-slate.js';
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
});
