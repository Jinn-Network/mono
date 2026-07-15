import { describe, it, expect } from 'vitest';
import { syncDrift } from '../../src/dispatcher/drift-sweep.js';
import type { ProjectSnapshot, SnapshotItem } from '../../src/dispatcher/project-snapshot.js';
import type { FieldCache } from '../../src/dispatcher/field-cache.js';
import type { PrLink, PrState } from '../../src/dispatcher/pr-links.js';
import type { TaskWorktree } from '../../src/dispatcher/state.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

const FIELD_CACHE: FieldCache = {
  projectId: 'PVT_x',
  status: { fieldId: 'F_status', options: { Todo: 'o_todo', 'In Progress': 'o_ip', Human: 'o_human', 'In Review': 'o_ir', Done: 'o_done' } },
  blockedOn: { fieldId: 'F_blk', options: { Nothing: 'o_nothing', Human: 'o_bhuman', 'Another issue': 'o_another' } },
};

function item(number: number, over: Partial<SnapshotItem> = {}): SnapshotItem {
  return {
    id: `PVTI_${number}`, number, contentType: 'Issue',
    status: 'In Progress', priority: 'P1', effort: 'Low', blockedOn: 'Nothing',
    issueType: 'feat', blockedByIssues: [], sprintIterationId: null, ...over,
  };
}

function snap(items: SnapshotItem[]): ProjectSnapshot {
  return { items, rateLimit: { remaining: 5000, used: 0, resetAt: 'x' }, currentSprintIterationId: null };
}

function link(prNumber: number, state: PrState, over: Partial<PrLink> = {}): PrLink {
  return {
    prNumber, headRefName: `feat/${prNumber}-x`, baseRefName: 'next', state,
    isDraft: true, author: 'ritsukai', labels: [], ...over,
  };
}

function wt(issueNumber: number, over: Partial<TaskWorktree> = {}): [number, TaskWorktree] {
  return [issueNumber, {
    issueNumber,
    worktreePath: `/w/jinn-mono_worktrees/${issueNumber}`,
    branch: `feat/${issueNumber}-work`,
    ...over,
  }];
}

/**
 * Scripted runner: `dirtyPaths` answer `git -C <p> status --porcelain`,
 * `unpushedPaths` answer `git -C <p> log … --not --remotes`, `gh pr create`
 * returns a PR URL. Everything is recorded.
 */
function fakeRunner(cfg: { dirtyPaths?: string[]; unpushedPaths?: string[]; failOn?: (cmd: string, args: string[]) => boolean } = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cfg.failOn?.(cmd, args)) throw new Error('scripted failure');
    if (cmd === 'git' && args.includes('status')) {
      const p = args[args.indexOf('-C') + 1];
      return cfg.dirtyPaths?.includes(p) ? ' M some/file.ts' : '';
    }
    if (cmd === 'git' && args.includes('--remotes')) {
      const p = args[args.indexOf('-C') + 1];
      return cfg.unpushedPaths?.includes(p) ? 'abc123 stranded commit' : '';
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      return 'https://github.com/Jinn-Network/mono/pull/999';
    }
    return '';
  };
  return { runner, calls };
}

const FRESH_LOG = () => 60_000; // 1 min — alive
const DEAD_LOG = () => 90 * 60_000; // 90 min — dead
const NO_LOG = () => null;

describe('syncDrift — phantoms (In Progress, no worktree)', () => {
  it('open PR → Status flips to In Review', async () => {
    const { runner, calls } = fakeRunner();
    const report = await syncDrift(
      snap([item(100)]),
      new Map([[100, [link(10, 'OPEN')]]]),
      new Map(),
      FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.toInReview).toEqual([100]);
    const edit = calls.find((c) => c.args.includes('item-edit'));
    expect(edit?.args).toContain('o_ir');
  });

  it('no PR → Status flips to Todo with an explanatory comment', async () => {
    const { runner, calls } = fakeRunner();
    const report = await syncDrift(
      snap([item(100)]), new Map(), new Map(), FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.toTodo).toEqual([100]);
    expect(calls.find((c) => c.args.includes('item-edit'))?.args).toContain('o_todo');
    expect(calls.some((c) => c.args.includes('comment'))).toBe(true);
  });

  it('merged PR only → skipped (merge will close the issue)', async () => {
    const { runner, calls } = fakeRunner();
    const report = await syncDrift(
      snap([item(100)]),
      new Map([[100, [link(10, 'MERGED')]]]),
      new Map(), FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.toInReview).toEqual([]);
    expect(report.toTodo).toEqual([]);
    expect(report.skipped.some((s) => s.includes('#100'))).toBe(true);
    expect(calls.filter((c) => c.cmd === 'gh')).toHaveLength(0);
  });

  it('Blocked on: Human phantom is parked by design — untouched', async () => {
    const { runner, calls } = fakeRunner();
    const report = await syncDrift(
      snap([item(100, { blockedOn: 'Human' })]),
      new Map(), new Map(), FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.toTodo).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('syncDrift — stale worktrees', () => {
  it('Done issue + clean worktree → worktree removed AND branch ref deleted', async () => {
    // Leaving the ref would fatal the next `worktree add -b` for the same
    // deterministic branch name and abort the cycle's dispatch loop
    // (review 2026-07-15 Critical).
    const { runner, calls } = fakeRunner();
    const report = await syncDrift(
      snap([item(100, { status: 'Done' })]),
      new Map(), new Map([wt(100)]), FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.removed).toEqual([100]);
    const rm = calls.find((c) => c.args.includes('remove'));
    expect(rm?.args).toEqual(['worktree', 'remove', '--force', '/w/jinn-mono_worktrees/100']);
    const del = calls.find((c) => c.args[0] === 'branch');
    expect(del?.args).toEqual(['branch', '-D', 'feat/100-work']);
  });

  it('Done issue with unpushed squash-merge leftovers → still removed (work landed)', async () => {
    // After a squash-merge + remote-branch deletion the local commits are
    // unreachable from remotes, but the work is on next — the branch is a
    // disposable leftover, not stranded work.
    const { runner, calls } = fakeRunner({ unpushedPaths: ['/w/jinn-mono_worktrees/100'] });
    const report = await syncDrift(
      snap([item(100, { status: 'Done' })]),
      new Map(), new Map([wt(100)]), FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.removed).toEqual([100]);
    expect(calls.some((c) => c.args[0] === 'branch')).toBe(true);
  });

  it('re-queued Todo with unpushed commits → worktree RETAINED (re-dispatch reuses it)', async () => {
    // The broken state is ref-without-worktree; a retained worktree is safe
    // (dispatch.ts reuses an existing path). Never manufacture the broken state.
    const { runner, calls } = fakeRunner({ unpushedPaths: ['/w/jinn-mono_worktrees/100'] });
    const report = await syncDrift(
      snap([item(100, { status: 'Todo' })]),
      new Map(), new Map([wt(100)]), FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.removed).toEqual([]);
    expect(report.skipped.some((s) => s.includes('worktree retained'))).toBe(true);
    expect(calls.some((c) => c.args.includes('remove'))).toBe(false);
    expect(calls.some((c) => c.args[0] === 'branch')).toBe(false);
  });

  it('re-queued Todo fully pushed → removed + local ref deleted (remote keeps the work)', async () => {
    const { runner, calls } = fakeRunner();
    const report = await syncDrift(
      snap([item(100, { status: 'Todo' })]),
      new Map(), new Map([wt(100)]), FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.removed).toEqual([100]);
    expect(calls.find((c) => c.args[0] === 'branch')?.args).toEqual(['branch', '-D', 'feat/100-work']);
  });

  it('Todo issue + dirty worktree → skipped, nothing removed', async () => {
    const { runner, calls } = fakeRunner({ dirtyPaths: ['/w/jinn-mono_worktrees/100'] });
    const report = await syncDrift(
      snap([item(100, { status: 'Todo' })]),
      new Map(), new Map([wt(100)]), FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.removed).toEqual([]);
    expect(report.skipped.some((s) => s.includes('dirty'))).toBe(true);
    expect(calls.some((c) => c.args.includes('remove'))).toBe(false);
  });

  it('In Review worktree is expected — untouched', async () => {
    const { runner, calls } = fakeRunner();
    const report = await syncDrift(
      snap([item(100, { status: 'In Review' })]),
      new Map(), new Map([wt(100)]), FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.removed).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('off-board issue with a MERGED closing PR → removed; without → skipped', async () => {
    const { runner } = fakeRunner();
    const report = await syncDrift(
      snap([]),
      new Map([[100, [link(10, 'MERGED')]]]),
      new Map([wt(100), wt(200)]),
      FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.removed).toEqual([100]);
    expect(report.skipped.some((s) => s.includes('#200'))).toBe(true);
  });

  it('parked (Blocked on: Human) worktree is retained by design', async () => {
    const { runner, calls } = fakeRunner();
    const report = await syncDrift(
      snap([item(100, { status: 'Todo', blockedOn: 'Human' })]),
      new Map(), new Map([wt(100)]), FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.removed).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('syncDrift — strand reaper', () => {
  it('dead session + committed work + no PR → push, draft PR, In Review', async () => {
    const { runner, calls } = fakeRunner();
    const report = await syncDrift(
      snap([item(100)]),
      new Map(), new Map([wt(100)]), FIELD_CACHE, runner, { fileAgeMs: DEAD_LOG },
    );
    expect(report.reaped).toEqual([{ issueNumber: 100, prNumber: 999 }]);
    const push = calls.find((c) => c.cmd === 'git' && c.args.includes('push'));
    expect(push?.args).toContain('feat/100-work');
    const pr = calls.find((c) => c.cmd === 'gh' && c.args[1] === 'create');
    expect(pr?.args).toContain('--draft');
    expect(pr?.args).toContain('engine:review');
    expect(pr?.args.join(' ')).toContain('Closes #100');
    expect(calls.find((c) => c.args.includes('item-edit'))?.args).toContain('o_ir');
  });

  it('live session (fresh log) → untouched', async () => {
    const { runner, calls } = fakeRunner();
    const report = await syncDrift(
      snap([item(100)]),
      new Map(), new Map([wt(100)]), FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.reaped).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('unknown log age (unreadable) → untouched, never reaped on a guess', async () => {
    const { runner, calls } = fakeRunner();
    const report = await syncDrift(
      snap([item(100)]),
      new Map(), new Map([wt(100)]), FIELD_CACHE, runner, { fileAgeMs: NO_LOG },
    );
    expect(report.reaped).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('in-flight with an open PR is normal — never reaped', async () => {
    const { runner, calls } = fakeRunner();
    const report = await syncDrift(
      snap([item(100)]),
      new Map([[100, [link(10, 'OPEN')]]]),
      new Map([wt(100)]), FIELD_CACHE, runner, { fileAgeMs: DEAD_LOG },
    );
    expect(report.reaped).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('dead session with dirty tree → skipped for a human', async () => {
    const { runner, calls } = fakeRunner({ dirtyPaths: ['/w/jinn-mono_worktrees/100'] });
    const report = await syncDrift(
      snap([item(100)]),
      new Map(), new Map([wt(100)]), FIELD_CACHE, runner, { fileAgeMs: DEAD_LOG },
    );
    expect(report.reaped).toEqual([]);
    expect(report.skipped.some((s) => s.includes('uncommitted'))).toBe(true);
    expect(calls.some((c) => c.args.includes('push'))).toBe(false);
  });

  it('detached strand → skipped for a human', async () => {
    const { runner } = fakeRunner();
    const report = await syncDrift(
      snap([item(100)]),
      new Map(), new Map([wt(100, { branch: '' })]), FIELD_CACHE, runner, { fileAgeMs: DEAD_LOG },
    );
    expect(report.reaped).toEqual([]);
    expect(report.skipped.some((s) => s.includes('detached'))).toBe(true);
  });
});

describe('syncDrift — resilience', () => {
  it('a failure on one item never blocks the rest', async () => {
    const { runner } = fakeRunner({
      failOn: (cmd, args) => cmd === 'git' && args.includes('remove') && args.some((a) => a.includes('/100')),
    });
    const report = await syncDrift(
      snap([item(100, { status: 'Done' }), item(200, { status: 'Done' })]),
      new Map(), new Map([wt(100), wt(200)]), FIELD_CACHE, runner, { fileAgeMs: FRESH_LOG },
    );
    expect(report.removed).toEqual([200]);
  });
});
