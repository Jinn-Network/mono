import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { dispatchReview } from '../../src/dispatcher/review-dispatch.js';
import { WORKTREES_BASE } from '../../src/dispatcher/dispatch.js';
import type { ReviewablePr, DispatcherConfig } from '../../src/dispatcher/types.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import type { SpawnFn } from '../../src/dispatcher/dispatch.js';

const PR: ReviewablePr = {
  number: 42, title: 'feat: thing', headRefName: 'feat/42-thing', headRefOid: 'sha42',
  isDraft: true, author: 'jinn-bot', hasReviewLabel: true, needsReview: true,
};
const CFG: DispatcherConfig = {
  concurrencyCap: 3, openPrBackpressure: 30, wallClockMs: 1, defaultImplementer: 'claude',
  authorAllowlist: [], reviewCap: 3, engineReviewLabel: 'engine:review', reviewBotLogin: 'jinn-bot',
};
const EXPECTED_WT = join(WORKTREES_BASE, 'pr-42');

function makeRunner(worktreeList = `worktree /x\nHEAD a\nbranch refs/heads/next\n`) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return worktreeList;
    if (cmd === 'git') return '';
    throw new Error(`Unexpected: ${cmd} ${args.join(' ')}`);
  };
  return { runner, calls };
}
function makeSpawn(pid = 4242) {
  const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
  const spawn: SpawnFn = (cmd, args, opts) => { calls.push({ cmd, args, opts: opts as Record<string, unknown> }); return { pid }; };
  return { spawn, calls };
}

describe('dispatchReview', () => {
  it('creates a pr-<N> worktree on the PR head branch off origin/<headRefName>', async () => {
    const { runner, calls } = makeRunner();
    const { spawn } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn });
    const add = calls.find((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(add).toBeDefined();
    expect(add!.args[2]).toBe(EXPECTED_WT);
    expect(add!.args).toContain('-B');
    expect(add!.args[add!.args.indexOf('-B') + 1]).toBe('feat/42-thing');
    expect(add!.args[add!.args.length - 1]).toBe('origin/feat/42-thing');
    expect(calls.some((c) => c.cmd === 'git' && c.args[0] === 'fetch')).toBe(true);
  });

  it('is idempotent — skips git worktree add when pr-<N> already exists', async () => {
    const list = `worktree /x\nHEAD a\nbranch refs/heads/next\n\nworktree ${EXPECTED_WT}\nHEAD b\nbranch refs/heads/feat/42-thing\n`;
    const { runner, calls } = makeRunner(list);
    const { spawn } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn });
    expect(calls.find((c) => c.cmd === 'git' && c.args[1] === 'add')).toBeUndefined();
  });

  it('spawns claude -p with a review-pr prompt naming the PR and the pre-created worktree', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn });
    expect(calls).toHaveLength(1);
    const prompt = calls[0].args[calls[0].args.indexOf('-p') + 1];
    expect(prompt).toContain('review-pr');
    expect(prompt).toContain('#42');
    expect(prompt).toContain(EXPECTED_WT);
    expect(prompt).toContain('already exists');
    expect(prompt).toContain('CLAUDE.md');
    expect(prompt).toContain('non-interactive');
    expect(calls[0].opts.cwd).toBe(EXPECTED_WT);
    expect(calls[0].opts.detached).toBe(true);
  });

  it('does NOT pass plan-posture flags', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn });
    expect(calls[0].args).not.toContain('--mode');
    expect(calls[0].args).not.toContain('--permission-mode');
  });

  it('returns an InFlightReview with prNumber, branch, worktree, pid', async () => {
    const { runner } = makeRunner();
    const { spawn } = makeSpawn(7777);
    const s = await dispatchReview(PR, CFG, { runner, spawn });
    expect(s.prNumber).toBe(42);
    expect(s.branch).toBe('feat/42-thing');
    expect(s.worktreePath).toBe(EXPECTED_WT);
    expect(s.pid).toBe(7777);
  });
});
