import { describe, it, expect } from 'vitest';
import { selectUnlabeled, syncReviewLabels } from '../../src/dispatcher/label-sweep.js';
import type { PrLink, PrState } from '../../src/dispatcher/pr-links.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

const ALLOWLIST: ReadonlySet<string> = new Set(['ritsukai', 'ritsukai2000']);
const LABEL = 'engine:review';

function link(over: Partial<PrLink> = {}): PrLink {
  return {
    prNumber: 10,
    headRefName: 'feat/100-do-the-thing',
    baseRefName: 'next',
    state: 'OPEN' as PrState,
    isDraft: true,
    author: 'ritsukai',
    labels: [],
    ...over,
  };
}

function recordingRunner(): { runner: CommandRunner; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    return '';
  };
  return { runner, calls };
}

describe('selectUnlabeled', () => {
  it('selects an open, allowlisted, session-branch PR missing the label (the #1730 case)', () => {
    const map = new Map([[100, [link()]]]);
    expect(selectUnlabeled(map, ALLOWLIST, LABEL)).toEqual([
      { issueNumber: 100, prNumber: 10 },
    ]);
  });

  it('skips a PR that already carries the label', () => {
    const map = new Map([[100, [link({ labels: [LABEL] })]]]);
    expect(selectUnlabeled(map, ALLOWLIST, LABEL)).toEqual([]);
  });

  it('never re-enrols a human-gated (reaped-strand) PR', () => {
    // A reaped strand carries review:needs-human and a session-fingerprint
    // branch; without the guard it would be re-labelled engine:review and
    // re-enter auto-merge, defeating the human gate (review 2026-07-15).
    const map = new Map([[100, [link({ labels: ['review:needs-human'] })]]]);
    expect(selectUnlabeled(map, ALLOWLIST, LABEL)).toEqual([]);
  });

  it('skips closed and merged PRs', () => {
    const map = new Map([
      [100, [link({ state: 'CLOSED' as PrState })]],
      [200, [link({ prNumber: 20, headRefName: 'feat/200-x', state: 'MERGED' as PrState })]],
    ]);
    expect(selectUnlabeled(map, ALLOWLIST, LABEL)).toEqual([]);
  });

  it('skips a non-allowlisted author (trust boundary — review RUNS the branch)', () => {
    const map = new Map([[100, [link({ author: 'attacker' })]]]);
    expect(selectUnlabeled(map, ALLOWLIST, LABEL)).toEqual([]);
  });

  it('matches the author case-insensitively (GitHub logins are case-insensitive)', () => {
    const map = new Map([[100, [link({ author: 'RitsuKai2000' })]]]);
    expect(selectUnlabeled(map, ALLOWLIST, LABEL)).toHaveLength(1);
  });

  it('skips a human-named branch — never force-enrols a manual PR', () => {
    // Allowlisted logins are shared with humans; only the dispatch branch
    // fingerprint <shape>/<N>-… identifies a session PR.
    const map = new Map([[100, [link({ headRefName: 'my-manual-fix' })]]]);
    expect(selectUnlabeled(map, ALLOWLIST, LABEL)).toEqual([]);
  });

  it('requires the branch issue number to match the closing-link issue', () => {
    // A PR closing #100 from branch feat/999-… is not #100's session PR.
    const map = new Map([[100, [link({ headRefName: 'feat/999-other' })]]]);
    expect(selectUnlabeled(map, ALLOWLIST, LABEL)).toEqual([]);
  });

  it('dedupes a PR that closes multiple issues', () => {
    const l = link();
    const map = new Map([
      [100, [l]],
      [101, [{ ...l, headRefName: 'feat/101-alias' }]],
    ]);
    // Same prNumber appears under two issues; only the first qualifying hit
    // is kept.
    const picked = selectUnlabeled(map, ALLOWLIST, LABEL);
    expect(picked.map((p) => p.prNumber)).toEqual([10]);
  });
});

describe('syncReviewLabels', () => {
  it('applies the label via gh pr edit --add-label', async () => {
    const { runner, calls } = recordingRunner();
    const map = new Map([[100, [link()]]]);
    const { labeled } = await syncReviewLabels(map, ALLOWLIST, runner);
    expect(labeled).toEqual([10]);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args).toContain('--add-label');
    expect(calls[0].args).toContain('engine:review');
    expect(calls[0].args).toContain('10');
  });

  it('a per-PR failure is swallowed and the sweep continues', async () => {
    const calls: number[] = [];
    const runner: CommandRunner = async (_cmd, args) => {
      const pr = Number(args[2]);
      calls.push(pr);
      if (pr === 10) throw new Error('boom');
      return '';
    };
    const map = new Map([
      [100, [link()]],
      [200, [link({ prNumber: 20, headRefName: 'feat/200-y' })]],
    ]);
    const { labeled } = await syncReviewLabels(map, ALLOWLIST, runner);
    expect(calls).toEqual([10, 20]);
    expect(labeled).toEqual([20]);
  });

  it('no qualifying PRs → no gh calls', async () => {
    const { runner, calls } = recordingRunner();
    const map = new Map([[100, [link({ labels: ['engine:review'] })]]]);
    const { labeled } = await syncReviewLabels(map, ALLOWLIST, runner);
    expect(labeled).toEqual([]);
    expect(calls).toEqual([]);
  });
});
