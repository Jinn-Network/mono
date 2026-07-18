import { describe, it, expect, vi } from 'vitest';
import { runReviewPass } from '../scripts/run-autopilot.js';
import { DEFAULT_CONFIG } from '../src/dispatcher/types.js';
import { REVIEW_REAP_MS } from '../src/dispatcher/review-loop.js';
import { reviewWorktreePath } from '../src/dispatcher/review-lease.js';
import type { CommandRunner } from '../src/dispatcher/issue-source.js';
import type { SpawnFn } from '../src/dispatcher/dispatch.js';
import type { ReviewLeaseStore } from '../src/dispatcher/review-lease.js';

const TEST_LEASE_STORE: ReviewLeaseStore = {
  record: () => {},
  read: () => null,
  releaseIfMatches: () => false,
};

const childProcess = vi.hoisted(() => {
  const order: string[] = [];
  let spawnOpts: Record<string, unknown> | undefined;
  let exitHandler: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  let errorHandler: ((error: Error) => void) | undefined;
  const child = {
    pid: 1,
    once: vi.fn((event: string, handler: typeof exitHandler) => {
      order.push(`once:${event}`);
      if (event === 'exit') exitHandler = handler;
      if (event === 'error') errorHandler = handler as unknown as (error: Error) => void;
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
    getErrorHandler: () => errorHandler,
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
    await runReviewPass(
      { ...DEFAULT_CONFIG, reviewBotLogin: '' },
      runner,
      undefined,
      TEST_LEASE_STORE,
    );
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
      TEST_LEASE_STORE,
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
      undefined,
      TEST_LEASE_STORE,
    );

    expect(childProcess.getSpawnOpts()).not.toHaveProperty('onExit');
    expect(childProcess.child.once).toHaveBeenCalledWith('exit', expect.any(Function));
    expect(childProcess.child.once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(childProcess.getExitHandler()).toBeTypeOf('function');
    expect(childProcess.getErrorHandler()).toBeTypeOf('function');
    expect(childProcess.order).toEqual(['spawn', 'once:error', 'once:exit', 'unref']);
  });

  it('treats child error as terminal cleanup and invokes cleanup only once if exit follows', async () => {
    childProcess.order.length = 0;
    childProcess.spawn.mockClear();
    childProcess.child.once.mockClear();
    childProcess.child.unref.mockClear();
    const removals: string[][] = [];
    const canonicalPath = reviewWorktreePath(50);
    let currentLease: ReturnType<ReviewLeaseStore['read']> = null;
    let worktreeListCalls = 0;

    const runner: CommandRunner = async (cmd, args) => {
      if (args[0] === 'pr' && args[1] === 'list') return PR_LIST;
      if (args[0] === 'pr' && args[1] === 'view') return PR_VIEW;
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        worktreeListCalls += 1;
        return worktreeListCalls <= 2
          ? 'worktree /x\nHEAD a\nbranch refs/heads/next\n'
          : `worktree ${canonicalPath}\nHEAD a\ndetached\n`;
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse') {
        return `${canonicalPath}\n`;
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        removals.push(args);
        return '';
      }
      if (cmd === 'git') return '';
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    };
    const leaseStore: ReviewLeaseStore = {
      record: (lease) => { currentLease = lease; },
      read: () => currentLease,
      releaseIfMatches: (_prNumber, leaseId) => {
        if (currentLease?.leaseId !== leaseId) return false;
        currentLease = null;
        return true;
      },
    };

    await runReviewPass(
      { ...DEFAULT_CONFIG, reviewBotLogin: 'jinn-bot', authorAllowlist: ['jinn-bot'] },
      runner,
      undefined,
      leaseStore,
      {
        filesystem: {
          lstat: () => ({
            isDirectory: () => true,
            isSymbolicLink: () => false,
          }),
          realpath: () => canonicalPath,
          mkdirExclusive: () => {},
          rename: () => {},
          removeNoFollow: () => {},
        },
      },
    );

    expect(() => childProcess.getErrorHandler()?.(new Error('spawn failed'))).not.toThrow();
    childProcess.getExitHandler()?.(1, null);
    await vi.waitFor(() => expect(removals).toHaveLength(1));
  });

  it('uses the same Git-first remove-release sequence for fallback reaping', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not found'), { code: 'ESRCH' });
    });
    const canonicalPath = reviewWorktreePath(50);
    const startedAt = Date.now() - REVIEW_REAP_MS - 10_000;
    const calls: string[][] = [];
    const released: number[] = [];
    const leaseStore: ReviewLeaseStore = {
      record: () => {},
      read: (prNumber) => prNumber === 50
        ? {
            version: 2,
            leaseId: 'lease-50',
            prNumber,
            worktreePath: canonicalPath,
            pid: 5050,
            startedAt,
          }
        : null,
      releaseIfMatches: (prNumber, leaseId) => {
        if (leaseId !== 'lease-50') return false;
        released.push(prNumber);
        return true;
      },
    };
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return '[]';
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return [
          `worktree ${canonicalPath}`,
          'HEAD a',
          'detached',
          '',
        ].join('\n');
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse') {
        return `${canonicalPath}\n`;
      }
      if (cmd === 'git') {
        calls.push(args);
        return '';
      }
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    };

    await runReviewPass(
      { ...DEFAULT_CONFIG, reviewBotLogin: 'jinn-bot', authorAllowlist: ['jinn-bot'] },
      runner,
      undefined,
      leaseStore,
      {
        filesystem: {
          lstat: () => ({
            isDirectory: () => true,
            isSymbolicLink: () => false,
          }),
          realpath: () => canonicalPath,
          mkdirExclusive: () => {},
          rename: () => {},
          removeNoFollow: () => {},
        },
      },
    );

    expect(calls).toEqual([
      ['worktree', 'remove', '--force', canonicalPath],
    ]);
    expect(released).toEqual([50]);
    processKill.mockRestore();
  });
});
