import { describe, it, expect } from 'vitest';
import {
  classifyCandidate,
  classifyStuck,
  rollupVerdict,
  syncMerges,
  type MergeCandidate,
  type RollupEntry,
} from '../../src/dispatcher/merge-sweep.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

const ALLOWLIST: ReadonlySet<string> = new Set(['ritsukai', 'ritsukai2000']);

const GREEN: RollupEntry[] = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];

function candidate(over: Partial<MergeCandidate> = {}): MergeCandidate {
  return {
    number: 10,
    title: 'a stuck PR',
    isDraft: false,
    author: 'ritsukai',
    labels: ['engine:review', 'review:approved'],
    reviewDecision: 'APPROVED',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefName: 'feat/10-x',
    headRefOid: 'abc123def456',
    statusChecks: GREEN,
    ...over,
  };
}

describe('rollupVerdict', () => {
  it('all completed-success → green (SKIPPED and NEUTRAL count as green)', () => {
    expect(
      rollupVerdict([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'SKIPPED' },
        { status: 'COMPLETED', conclusion: 'NEUTRAL' },
      ]),
    ).toBe('green');
  });

  it('any in-progress check → pending', () => {
    expect(rollupVerdict([...GREEN, { status: 'IN_PROGRESS' }])).toBe('pending');
  });

  it('any failure → failed, even with others pending', () => {
    expect(
      rollupVerdict([
        { status: 'IN_PROGRESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
    ).toBe('failed');
  });

  it('StatusContext shapes: SUCCESS green, PENDING pending, FAILURE failed', () => {
    expect(rollupVerdict([{ state: 'SUCCESS' }])).toBe('green');
    expect(rollupVerdict([{ state: 'PENDING' }])).toBe('pending');
    expect(rollupVerdict([{ state: 'FAILURE' }])).toBe('failed');
  });

  it('no checks reported → pending (never merge blind)', () => {
    expect(rollupVerdict([])).toBe('pending');
  });
});

describe('classifyCandidate', () => {
  it('the full happy path is eligible', () => {
    expect(classifyCandidate(candidate(), ALLOWLIST)).toBe('eligible');
  });

  it('draft → not eligible (un-draft IS the merge-ready signal)', () => {
    expect(classifyCandidate(candidate({ isDraft: true }), ALLOWLIST)).toContain('draft');
  });

  it('non-allowlisted author → not eligible', () => {
    expect(classifyCandidate(candidate({ author: 'outsider' }), ALLOWLIST)).toContain('allowlist');
  });

  it('review:needs-human label → routed to a human, never auto-merged', () => {
    const c = candidate({ labels: ['engine:review', 'review:needs-human'] });
    expect(classifyCandidate(c, ALLOWLIST)).toContain('review:needs-human');
  });

  it('not APPROVED → not eligible', () => {
    expect(
      classifyCandidate(candidate({ reviewDecision: 'CHANGES_REQUESTED' }), ALLOWLIST),
    ).toContain('CHANGES_REQUESTED');
  });

  it('pending checks → not eligible', () => {
    expect(
      classifyCandidate(candidate({ statusChecks: [{ status: 'QUEUED' }] }), ALLOWLIST),
    ).toContain('pending');
  });

  it('CONFLICTING → not eligible', () => {
    expect(classifyCandidate(candidate({ mergeable: 'CONFLICTING' }), ALLOWLIST)).toContain(
      'CONFLICTING',
    );
  });

  it('BEHIND → the one-update-branch lane', () => {
    expect(classifyCandidate(candidate({ mergeStateStatus: 'BEHIND' }), ALLOWLIST)).toBe('behind');
  });

  it('BLOCKED merge state → not eligible (branch protection unsatisfied)', () => {
    expect(classifyCandidate(candidate({ mergeStateStatus: 'BLOCKED' }), ALLOWLIST)).toContain(
      'BLOCKED',
    );
  });
});

describe('classifyStuck', () => {
  it('APPROVED + green + CONFLICTING → conflicting', () => {
    expect(classifyStuck(candidate({ mergeable: 'CONFLICTING' }), ALLOWLIST)).toBe('conflicting');
  });

  it('mergeStateStatus DIRTY alone → conflicting', () => {
    expect(
      classifyStuck(candidate({ mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' }), ALLOWLIST),
    ).toBe('conflicting');
  });

  it('LABEL-BLIND: stays conflicting even carrying review:needs-human (survives its own escalation)', () => {
    const c = candidate({
      mergeable: 'CONFLICTING',
      labels: ['engine:review', 'review:needs-human'],
    });
    // classifyCandidate short-circuits on the label; classifyStuck must not.
    expect(classifyCandidate(c, ALLOWLIST)).toContain('review:needs-human');
    expect(classifyStuck(c, ALLOWLIST)).toBe('conflicting');
  });

  it('clean/mergeable → null (not stuck)', () => {
    expect(classifyStuck(candidate(), ALLOWLIST)).toBeNull();
  });

  it('UNKNOWN mergeable with no DIRTY → null (transient, GitHub still computing)', () => {
    expect(classifyStuck(candidate({ mergeable: 'UNKNOWN' }), ALLOWLIST)).toBeNull();
  });

  it('not-yet-cleared PRs are never stuck (draft / not-approved / pending / non-allowlisted)', () => {
    expect(classifyStuck(candidate({ mergeable: 'CONFLICTING', isDraft: true }), ALLOWLIST)).toBeNull();
    expect(
      classifyStuck(candidate({ mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED' }), ALLOWLIST),
    ).toBeNull();
    expect(
      classifyStuck(candidate({ mergeable: 'CONFLICTING', statusChecks: [{ status: 'IN_PROGRESS' }] }), ALLOWLIST),
    ).toBeNull();
    expect(classifyStuck(candidate({ mergeable: 'CONFLICTING', author: 'outsider' }), ALLOWLIST)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// syncMerges — scripted end-to-end over the gh seam
// ---------------------------------------------------------------------------

function scriptedRunner(cfg: {
  list: unknown[];
  files?: Record<number, string[]>;
  codeowners?: string;
  failMerge?: number[];
  /** `behind_by` returned by the compare API. Default 0 (up to date). */
  behindBy?: number;
  failCompare?: boolean;
}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return JSON.stringify(cfg.list);
    if (cmd === 'gh' && args[0] === 'api' && (args[1] ?? '').includes('/compare/next...')) {
      if (cfg.failCompare) throw new Error('compare failed');
      return String(cfg.behindBy ?? 0);
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      const n = Number(args[2]);
      return JSON.stringify({ files: (cfg.files?.[n] ?? ['client/src/x.ts']).map((p) => ({ path: p })) });
    }
    if (cmd === 'git' && args[0] === 'show') return cfg.codeowners ?? '# no owned paths\n';
    if (cmd === 'gh' && args[1] === 'merge' && cfg.failMerge?.includes(Number(args[2]))) {
      throw new Error('merge blocked');
    }
    return '';
  };
  return { runner, calls };
}

function ghEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 10,
    title: 'a stuck PR',
    isDraft: false,
    author: { login: 'ritsukai' },
    labels: [{ name: 'engine:review' }],
    reviewDecision: 'APPROVED',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefName: 'feat/10-x',
    headRefOid: 'abc123def456',
    statusCheckRollup: GREEN,
    ...over,
  };
}

describe('syncMerges', () => {
  it('merges an eligible non-code-owned PR with --squash', async () => {
    const { runner, calls } = scriptedRunner({ list: [ghEntry()] });
    const report = await syncMerges(runner, ALLOWLIST, new Set());
    expect(report.merged).toEqual([10]);
    const merge = calls.find((c) => c.args[1] === 'merge');
    expect(merge?.args).toContain('--squash');
    expect(merge?.args).not.toContain('--admin');
    // TOCTOU pin: the merge is scoped to the exact head the sweep validated.
    expect(merge?.args).toContain('--match-head-commit');
    expect(merge?.args).toContain('abc123def456');
  });

  it('a CONFLICTING PR is reported as stuck (conflicting) and never merged', async () => {
    const { runner, calls } = scriptedRunner({
      list: [ghEntry({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })],
    });
    const report = await syncMerges(runner, ALLOWLIST, new Set());
    expect(report.merged).toEqual([]);
    expect(report.stuck).toEqual([
      {
        number: 10,
        title: 'a stuck PR',
        reason: 'conflicting',
        headRefName: 'feat/10-x',
        headRefOid: 'abc123def456',
        escalated: false,
      },
    ]);
    expect(calls.some((c) => c.args[1] === 'merge')).toBe(false);
  });

  it('a CONFLICTING PR already labeled needs-human is stuck with escalated:true', async () => {
    const { runner } = scriptedRunner({
      list: [ghEntry({ mergeable: 'CONFLICTING', labels: [{ name: 'engine:review' }, { name: 'review:needs-human' }] })],
    });
    const report = await syncMerges(runner, ALLOWLIST, new Set());
    expect(report.stuck).toHaveLength(1);
    expect(report.stuck[0]).toMatchObject({ reason: 'conflicting', escalated: true });
  });

  it('still-BEHIND after update-branch is reported as stuck, keeping the legacy skipped string', async () => {
    const attempted = new Set<number>([10]); // one update-branch already spent this process
    const { runner } = scriptedRunner({ list: [ghEntry({ mergeStateStatus: 'BEHIND' })] });
    const report = await syncMerges(runner, ALLOWLIST, attempted);
    expect(report.skipped.some((s) => s.includes('still BEHIND'))).toBe(true); // back-compat
    expect(report.stuck).toEqual([
      {
        number: 10, title: 'a stuck PR', reason: 'still-behind',
        headRefName: 'feat/10-x', headRefOid: 'abc123def456', escalated: false,
      },
    ]);
  });

  it('an update-branch failure is reported as stuck (update-branch-failed)', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const runner: CommandRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gh' && args[1] === 'list') return JSON.stringify([ghEntry({ mergeStateStatus: 'BEHIND' })]);
      if (cmd === 'gh' && args[1] === 'update-branch') throw new Error('update would conflict');
      return '';
    };
    const report = await syncMerges(runner, ALLOWLIST, new Set());
    expect(report.stuck.map((s) => s.reason)).toEqual(['update-branch-failed']);
  });

  it('a clean sweep reports no stuck PRs', async () => {
    const { runner } = scriptedRunner({ list: [ghEntry()] });
    const report = await syncMerges(runner, ALLOWLIST, new Set());
    expect(report.stuck).toEqual([]);
  });

  it('refuses to merge an eligible PR with an empty headRefOid (no blind merge)', async () => {
    const { runner, calls } = scriptedRunner({ list: [ghEntry({ headRefOid: '' })] });
    const report = await syncMerges(runner, ALLOWLIST, new Set());
    expect(report.merged).toEqual([]);
    expect(report.skipped.some((s) => s.includes('missing headRefOid'))).toBe(true);
    expect(calls.some((c) => c.args[1] === 'merge')).toBe(false);
  });

  it('code-owned PR is never merged (DR-2026-06-03)', async () => {
    const { runner, calls } = scriptedRunner({
      list: [ghEntry()],
      files: { 10: ['docs/engineering/handbook.md'] },
      codeowners: 'docs/engineering/ @Jinn-Network/maintainers\n',
    });
    const report = await syncMerges(runner, ALLOWLIST, new Set());
    expect(report.merged).toEqual([]);
    expect(report.skipped.some((s) => s.includes('code-owned'))).toBe(true);
    expect(calls.some((c) => c.args[1] === 'merge')).toBe(false);
  });

  it('unreadable CODEOWNERS fails safe — no merge', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const runner: CommandRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gh' && args[1] === 'list') return JSON.stringify([ghEntry()]);
      if (cmd === 'git' && args[0] === 'show') throw new Error('no such ref');
      if (cmd === 'gh' && args[1] === 'view') return JSON.stringify({ files: [{ path: 'x.ts' }] });
      return '';
    };
    const report = await syncMerges(runner, ALLOWLIST, new Set());
    expect(report.merged).toEqual([]);
    expect(calls.some((c) => c.args[1] === 'merge')).toBe(false);
  });

  it('BEHIND gets exactly one update-branch across cycles', async () => {
    const attempted = new Set<number>();
    const list = [ghEntry({ mergeStateStatus: 'BEHIND' })];
    const first = scriptedRunner({ list });
    const r1 = await syncMerges(first.runner, ALLOWLIST, attempted);
    expect(r1.updatedBranch).toEqual([10]);
    expect(first.calls.some((c) => c.args[1] === 'update-branch')).toBe(true);

    const second = scriptedRunner({ list });
    const r2 = await syncMerges(second.runner, ALLOWLIST, attempted);
    expect(r2.updatedBranch).toEqual([]);
    expect(r2.skipped.some((s) => s.includes('still BEHIND'))).toBe(true);
    expect(second.calls.some((c) => c.args[1] === 'update-branch')).toBe(false);
  });

  it('a failing merge is reported and the sweep continues', async () => {
    const { runner } = scriptedRunner({
      list: [ghEntry(), ghEntry({ number: 11 })],
      failMerge: [10],
    });
    const report = await syncMerges(runner, ALLOWLIST, new Set());
    expect(report.merged).toEqual([11]);
    expect(report.skipped.some((s) => s.includes('#10'))).toBe(true);
  });

  it('ineligible candidates are reported with reasons, not merged', async () => {
    const { runner, calls } = scriptedRunner({
      list: [ghEntry({ isDraft: true }), ghEntry({ number: 11, reviewDecision: 'REVIEW_REQUIRED' })],
    });
    const report = await syncMerges(runner, ALLOWLIST, new Set());
    expect(report.merged).toEqual([]);
    expect(report.skipped).toHaveLength(2);
    expect(calls.some((c) => c.args[1] === 'merge')).toBe(false);
  });

  it('stale-base gate: behind next per the compare API → update-branch, never a stale merge', async () => {
    // next runs strict=false protection, so GitHub reports a behind PR CLEAN
    // with green-but-stale checks — the #1730-class hazard at the merge layer.
    const { runner, calls } = scriptedRunner({ list: [ghEntry()], behindBy: 3 });
    const report = await syncMerges(runner, ALLOWLIST, new Set());
    expect(report.merged).toEqual([]);
    expect(report.updatedBranch).toEqual([10]);
    expect(calls.some((c) => c.args[1] === 'merge')).toBe(false);
  });

  it('stale-base gate: compare API failure fails safe — no merge on unverifiable freshness', async () => {
    const { runner, calls } = scriptedRunner({ list: [ghEntry()], failCompare: true });
    const report = await syncMerges(runner, ALLOWLIST, new Set());
    expect(report.merged).toEqual([]);
    expect(calls.some((c) => c.args[1] === 'merge')).toBe(false);
  });

  it('stale-base gate: up-to-date (behind_by 0) merges normally', async () => {
    const { runner } = scriptedRunner({ list: [ghEntry()], behindBy: 0 });
    const report = await syncMerges(runner, ALLOWLIST, new Set());
    expect(report.merged).toEqual([10]);
  });
});
