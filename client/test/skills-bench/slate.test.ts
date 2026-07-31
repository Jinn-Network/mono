import { describe, expect, it } from 'vitest';
import { splitSlate, hashSlate, type SlateCandidate } from '../../src/skills-bench/slate.js';

function candidates(n: number): SlateCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    instance_id: `fix-widget-${String(i).padStart(4, '0')}`,
    repo: `org/repo-${i % 7}`, // 7 repos so repo-dedup logic is exercised
    hf_dataset: 'nebius/SWE-rebench-leaderboard',
    hf_split: 'test',
  }));
}

describe('splitSlate', () => {
  it('is deterministic for a fixed seed and disjoint', () => {
    const a = splitSlate(candidates(40), { seed: 'test-seed', feedbackSize: 15, holdoutSize: 15 });
    const b = splitSlate(candidates(40), { seed: 'test-seed', feedbackSize: 15, holdoutSize: 15 });
    expect(a.sha256).toBe(b.sha256);
    expect(a.feedback).toHaveLength(15);
    expect(a.holdout).toHaveLength(15);
    const fb = new Set(a.feedback.map((c) => c.instance_id));
    for (const h of a.holdout) expect(fb.has(h.instance_id)).toBe(false);
  });

  it('changes with the seed', () => {
    const a = splitSlate(candidates(40), { seed: 's1', feedbackSize: 15, holdoutSize: 15 });
    const b = splitSlate(candidates(40), { seed: 's2', feedbackSize: 15, holdoutSize: 15 });
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('throws when the pool is too small', () => {
    expect(() => splitSlate(candidates(20), { seed: 's', feedbackSize: 15, holdoutSize: 15 }))
      .toThrow(/pool too small/);
  });

  it('hash covers membership and halves', () => {
    const a = splitSlate(candidates(40), { seed: 's1', feedbackSize: 15, holdoutSize: 15 });
    const tampered = { ...a, holdout: a.holdout.slice(1) };
    expect(hashSlate(tampered)).not.toBe(a.sha256);
  });
});

describe('hashSlate — excluded back-compat and coverage', () => {
  it('an absent excluded array hashes identically to an explicit empty one', () => {
    const a = splitSlate(candidates(40), { seed: 's1', feedbackSize: 15, holdoutSize: 15 });
    const { sha256: _drop, ...withoutSha } = a;
    const withExplicitEmpty = { ...withoutSha, excluded: [] };
    expect(hashSlate(withExplicitEmpty)).toBe(a.sha256);
  });

  it('excluded is covered by the hash — adding an exclusion changes it', () => {
    const a = splitSlate(candidates(40), { seed: 's1', feedbackSize: 15, holdoutSize: 15 });
    const { sha256: _drop, ...withoutSha } = a;
    const withExclusion = { ...withoutSha, excluded: [{ instance_id: 'fix-widget-0099', reason: 'ungradeable' }] };
    expect(hashSlate(withExclusion)).not.toBe(a.sha256);
  });

  it('changing the reason on an excluded entry changes the hash', () => {
    const base = { version: 'skills-bench-slate.v1' as const, seed: 's1', feedback: [], holdout: [] };
    const withReasonA = { ...base, excluded: [{ instance_id: 'x', reason: 'reason-a' }] };
    const withReasonB = { ...base, excluded: [{ instance_id: 'x', reason: 'reason-b' }] };
    expect(hashSlate(withReasonA)).not.toBe(hashSlate(withReasonB));
  });
});
