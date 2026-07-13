import { describe, it, expect } from 'vitest';
import { resolveStackReady } from '../../src/dispatcher/stack-readiness.js';
import type { PolledIssue } from '../../src/dispatcher/types.js';
import type { PrLink, PrState } from '../../src/dispatcher/pr-links.js';

// A dependent issue: Blocked on Another issue, one blocker (#50) by default set
// per-test. Every field otherwise valid so only the dependency logic is under test.
const base: PolledIssue = {
  number: 100,
  title: 'dependent',
  shape: 'feat',
  blockedOn: 'Another issue',
  blockedByIssues: [50],
  effort: 'Medium',
  priority: 'P2',
  status: 'Todo',
  onBoard: true,
  author: 'ritsukai',
  projectItemId: 'PVTI_100',
  inCurrentSprint: false,
};

// Allowlist is pre-lowercased by the caller (loop.ts). Blocker PRs default to an
// allowlisted author so tests exercise the readiness logic, not the author gate,
// unless they override it.
const ALLOW: ReadonlySet<string> = new Set(['ritsukai', 'oaksprout']);

function link(state: PrState, head: string, over: Partial<PrLink> = {}): PrLink {
  return { prNumber: 500, headRefName: head, baseRefName: 'next', state, isDraft: true, author: 'ritsukai', ...over };
}

function prMap(entries: Record<number, PrLink[]>): Map<number, PrLink[]> {
  return new Map(Object.entries(entries).map(([k, v]) => [Number(k), v]));
}

const resolve = (
  polled: PolledIssue[],
  map: Map<number, PrLink[]>,
  allow: ReadonlySet<string> = ALLOW,
) => resolveStackReady(polled, map, allow);

describe('resolveStackReady', () => {
  it('ignores an issue with no blocked_by edges', () => {
    const out = resolve([{ ...base, blockedByIssues: [] }], prMap({}));
    expect(out.has(100)).toBe(false);
  });

  it('admits + stacks on the blocker head when the single blocker has an open PR', () => {
    const out = resolve(
      [{ ...base, blockedByIssues: [50] }],
      prMap({ 50: [link('OPEN', 'feat/50-blocker')] }),
    );
    expect(out.get(100)).toEqual({ baseBranch: 'feat/50-blocker' });
  });

  it('admits with base=next when the single blocker has already merged', () => {
    const out = resolve(
      [{ ...base, blockedByIssues: [50] }],
      prMap({ 50: [link('MERGED', 'feat/50-blocker')] }),
    );
    expect(out.get(100)).toEqual({ baseBranch: 'next' });
  });

  it('stays blocked when the blocker has no PR at all', () => {
    const out = resolve([{ ...base, blockedByIssues: [50] }], prMap({}));
    expect(out.has(100)).toBe(false);
  });

  it('stays blocked when the blocker only has a closed-unmerged PR (abandoned)', () => {
    const out = resolve(
      [{ ...base, blockedByIssues: [50] }],
      prMap({ 50: [link('CLOSED', 'feat/50-blocker')] }),
    );
    expect(out.has(100)).toBe(false);
  });

  it('prefers the open PR when a blocker has both a closed attempt and an open PR', () => {
    const out = resolve(
      [{ ...base, blockedByIssues: [50] }],
      prMap({ 50: [link('CLOSED', 'feat/50-old'), link('OPEN', 'feat/50-live')] }),
    );
    expect(out.get(100)).toEqual({ baseBranch: 'feat/50-live' });
  });

  it('treats a merged blocker as satisfied even if a stray open PR also exists', () => {
    const out = resolve(
      [{ ...base, blockedByIssues: [50] }],
      prMap({ 50: [link('MERGED', 'feat/50-blocker'), link('OPEN', 'feat/50-stray')] }),
    );
    expect(out.get(100)).toEqual({ baseBranch: 'next' });
  });

  it('admits with base=next when all of multiple blockers are merged', () => {
    const out = resolve(
      [{ ...base, blockedByIssues: [50, 60] }],
      prMap({ 50: [link('MERGED', 'a')], 60: [link('MERGED', 'b')] }),
    );
    expect(out.get(100)).toEqual({ baseBranch: 'next' });
  });

  it('stacks on the single unmerged blocker when the other blocker is merged', () => {
    const out = resolve(
      [{ ...base, blockedByIssues: [50, 60] }],
      prMap({ 50: [link('MERGED', 'a')], 60: [link('OPEN', 'feat/60-live')] }),
    );
    expect(out.get(100)).toEqual({ baseBranch: 'feat/60-live' });
  });

  it('does NOT admit when more than one blocker is unmerged with an open PR (multi-parent out of scope)', () => {
    const out = resolve(
      [{ ...base, blockedByIssues: [50, 60] }],
      prMap({ 50: [link('OPEN', 'a')], 60: [link('OPEN', 'b')] }),
    );
    expect(out.has(100)).toBe(false);
  });

  it('does NOT admit when one of several blockers has no PR', () => {
    const out = resolve(
      [{ ...base, blockedByIssues: [50, 60] }],
      prMap({ 50: [link('OPEN', 'a')] }), // 60 has no PR
    );
    expect(out.has(100)).toBe(false);
  });

  // --- author trust boundary (review 2026-07-13) ---

  it('does NOT stack on an OPEN blocker PR authored by a non-allowlisted login', () => {
    const out = resolve(
      [{ ...base, blockedByIssues: [50] }],
      prMap({ 50: [link('OPEN', 'feat/50-blocker', { author: 'outsider' })] }),
    );
    expect(out.has(100)).toBe(false);
  });

  it('stacks when the only allowlisted open PR sits alongside a non-allowlisted one', () => {
    const out = resolve(
      [{ ...base, blockedByIssues: [50] }],
      prMap({ 50: [link('OPEN', 'feat/50-attacker', { author: 'outsider' }), link('OPEN', 'feat/50-trusted', { author: 'oaksprout' })] }),
    );
    expect(out.get(100)).toEqual({ baseBranch: 'feat/50-trusted' });
  });

  it('still trusts a MERGED blocker regardless of the PR author (already reviewed + merged)', () => {
    const out = resolve(
      [{ ...base, blockedByIssues: [50] }],
      prMap({ 50: [link('MERGED', 'feat/50-blocker', { author: 'outsider' })] }),
    );
    expect(out.get(100)).toEqual({ baseBranch: 'next' });
  });

  it('matches the allowlist case-insensitively (author compared lowercased)', () => {
    const out = resolve(
      [{ ...base, blockedByIssues: [50] }],
      prMap({ 50: [link('OPEN', 'feat/50-blocker', { author: 'RitsuKai' })] }),
      new Set(['ritsukai']),
    );
    expect(out.get(100)).toEqual({ baseBranch: 'feat/50-blocker' });
  });
});
