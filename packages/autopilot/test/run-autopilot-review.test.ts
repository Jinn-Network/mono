import { describe, it, expect, vi } from 'vitest';
import { runReviewPass } from '../scripts/run-autopilot.js';
import { DEFAULT_CONFIG } from '../src/dispatcher/types.js';
import type { CommandRunner } from '../src/dispatcher/issue-source.js';
import type { SpawnFn } from '../src/dispatcher/dispatch.js';

const childProcess = vi.hoisted(() => {
  const order: string[] = [];
  let spawnOpts: Record<string, unknown> | undefined;
  let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const child = {
    pid: 1,
    once: vi.fn((event: string, handler: typeof exitHandler) => {
      order.push(`once:${event}`);
      exitHandler = handler;
      return child;
    }),
    unref: vi.fn(() => {
      order.push('unref');
    }),
  };
  const spawn = vi.fn((_cmd: string, _args: string[], opts: Record<string, unknown>) => {
    order.push('spawn');
    spawnOpts = opts;
    return child;
  });
  return {
    order,
    child,
    spawn,
    getSpawnOpts: () => spawnOpts,
    getExitHandler: () => exitHandler,
  };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: childProcess.spawn,
}));

const PR_LIST = JSON.stringify([
  { number: 50, title: 'feat: x', headRefName: 'feat/50-x', headRefOid: 's50', isDraft: true, author: { login: 'jinn-bot' } },
]);
const PR_VIEW = JSON.stringify({ reviews: [], commits: [{ committedDate: '2026-05-29T09:00:00Z' }] });

describe('runReviewPass', () => {
  it('is a no-op when reviewBotLogin is empty', async () => {
    const calls: string[] = [];
    const runner: CommandRunner = async (cmd) => { calls.push(cmd); return ''; };
    await runReviewPass({ ...DEFAULT_CONFIG, reviewBotLogin: '' }, runner);
    expect(calls).toEqual([]);
  });

  it('dispatches a review session for a labelled PR needing review', async () => {
    const spawnCalls: Array<{ args: string[] }> = [];
    const spawn: SpawnFn = (_cmd, args) => { spawnCalls.push({ args }); return { pid: 1 }; };
    const runner: CommandRunner = async (cmd, args) => {
      if (args[0] === 'pr' && args[1] === 'list') return PR_LIST;
      if (args[0] === 'pr' && args[1] === 'view') return PR_VIEW;
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return 'worktree /x\nHEAD a\nbranch refs/heads/next\n';
      if (cmd === 'git') return '';
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    };
    // PR #50 is authored by jinn-bot; allowlist it so the review-side author
    // gate (DR-2026-06-15) permits dispatch — the implementer bot is a trusted
    // author so the engine reviews its own PRs.
    await runReviewPass(
      { ...DEFAULT_CONFIG, reviewBotLogin: 'jinn-bot', authorAllowlist: ['jinn-bot'] },
      runner,
      spawn,
    );
    expect(spawnCalls).toHaveLength(1);
    const prompt = spawnCalls[0].args[spawnCalls[0].args.indexOf('-p') + 1];
    expect(prompt).toContain('review-pr');
    expect(prompt).toContain('#50');
  });

  it('strips onExit, registers it before unref, and forwards it to the child exit event', async () => {
    childProcess.order.length = 0;
    childProcess.spawn.mockClear();
    childProcess.child.once.mockClear();
    childProcess.child.unref.mockClear();

    const runner: CommandRunner = async (cmd, args) => {
      if (args[0] === 'pr' && args[1] === 'list') return PR_LIST;
      if (args[0] === 'pr' && args[1] === 'view') return PR_VIEW;
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return 'worktree /x\nHEAD a\nbranch refs/heads/next\n';
      }
      if (cmd === 'git') return '';
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    };

    await runReviewPass(
      { ...DEFAULT_CONFIG, reviewBotLogin: 'jinn-bot', authorAllowlist: ['jinn-bot'] },
      runner,
    );

    expect(childProcess.getSpawnOpts()).not.toHaveProperty('onExit');
    expect(childProcess.child.once).toHaveBeenCalledWith('exit', expect.any(Function));
    expect(childProcess.getExitHandler()).toBeTypeOf('function');
    expect(childProcess.order).toEqual(['spawn', 'once:exit', 'unref']);
  });
});
