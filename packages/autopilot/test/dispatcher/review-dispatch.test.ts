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
  implementerRules: [],
  authorAllowlist: [], reviewCap: 3, engineReviewLabel: 'engine:review', reviewBotLogin: 'jinn-bot',
  implGhToken: '', reviewGhToken: '',
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

  it('authenticates the review session as the reviewer identity via GH_TOKEN (DR-2026-06-15)', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, { ...CFG, reviewGhToken: 'rev-token-xyz' }, { runner, spawn });
    const env = calls[0].opts.env as Record<string, string> | undefined;
    expect(env?.GH_TOKEN).toBe('rev-token-xyz');
  });

  it('inherits the ambient gh account (no GH_TOKEN) when no reviewer token is configured', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn }); // reviewGhToken: ''
    const env = calls[0].opts.env as Record<string, string> | undefined;
    expect(env?.GH_TOKEN).toBeUndefined();
  });

  it('disables the print-mode background-wait ceiling so the review session runs to completion', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn });
    const env = calls[0].opts.env as Record<string, string> | undefined;
    expect(env?.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe('0');
  });

  // P3 (DR-2026-06-15): human-surface detection. The gate reads the changed-file
  // list AND CODEOWNERS from origin/next via the runner (git diff / git show),
  // so the fake serves both — no dependency on the real repo's CODEOWNERS.
  const CODEOWNERS_FIXTURE =
    '/client/src/dashboard/spa/src/pages/ @oaksprout @ritsukai\n/SPEC.md @oaksprout @ritsukai\n';
  function diffRunner(changedFiles: string): CommandRunner {
    return async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return `worktree /x\nHEAD a\nbranch refs/heads/next\n`;
      if (cmd === 'git' && args.includes('show')) return CODEOWNERS_FIXTURE;
      if (cmd === 'git' && args.includes('diff')) return changedFiles;
      if (cmd === 'git') return '';
      throw new Error(`Unexpected: ${cmd} ${args.join(' ')}`);
    };
  }
  function promptOf(calls: Array<{ args: string[] }>): string {
    return calls[0].args[calls[0].args.indexOf('-p') + 1];
  }

  it('marks a PR touching a code-owned path as HUMAN-SURFACE / advisory (no approve)', async () => {
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner: diffRunner('client/src/dashboard/spa/src/pages/Tasks.tsx\n'), spawn });
    const prompt = promptOf(calls);
    expect(prompt).toContain('HUMAN-SURFACE');
    expect(prompt).toContain('review:needs-human');
    expect(prompt).not.toContain('APPROVE-ELIGIBLE');
  });

  it('marks a PR touching only non-owned paths as APPROVE-ELIGIBLE', async () => {
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner: diffRunner('packages/autopilot/src/dispatcher/loop.ts\n'), spawn });
    const prompt = promptOf(calls);
    expect(prompt).toContain('APPROVE-ELIGIBLE');
    expect(prompt).not.toContain('HUMAN-SURFACE');
  });

  it('fails safe to advisory when the changed-file list cannot be determined', async () => {
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner: diffRunner(''), spawn }); // empty diff → advisory
    expect(promptOf(calls)).toContain('HUMAN-SURFACE');
  });
});
