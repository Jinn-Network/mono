import { afterEach, describe, it, expect, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchReview } from '../../src/dispatcher/review-dispatch.js';
import { WORKTREES_BASE } from '../../src/dispatcher/dispatch.js';
import type { ReviewablePr, DispatcherConfig } from '../../src/dispatcher/types.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import type { SpawnFn } from '../../src/dispatcher/dispatch.js';
import type {
  ReviewLease,
  ReviewLeaseStore,
} from '../../src/dispatcher/review-lease.js';
import type { ReviewCleanupOptions } from '../../src/dispatcher/review-cleanup.js';
import { HERMES_HOMES_DIR } from '../../src/dispatcher/hermes-home.js';

const PR: ReviewablePr = {
  number: 42, title: 'feat: thing', headRefName: 'feat/42-thing', headRefOid: 'sha42',
  isDraft: true, author: 'jinn-bot', hasReviewLabel: true, needsReview: true,
};
const CFG: DispatcherConfig = {
  runtime: 'claude', concurrencyCap: 3, openPrBackpressure: 30, wallClockMs: 1,
  authorAllowlist: [], reviewCap: 3, engineReviewLabel: 'engine:review', reviewBotLogin: 'jinn-bot',
  implGhToken: '', reviewGhToken: '', mergePrepEnabled: false, mergePrepCap: 1, hermesModel: 'gpt-5.6-sol', hermesProvider: 'openai-codex', hermesPythonPath: '/opt/hermes/python',
};
const EXPECTED_WT = join(WORKTREES_BASE, 'pr-42');
const TEST_LEASE_STORE: ReviewLeaseStore = {
  record: () => {},
  read: () => null,
  releaseIfMatches: () => false,
};
const TEST_CLEANUP_OPTIONS: ReviewCleanupOptions = {
  filesystem: {
    lstat: () => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
    }),
    realpath: () => EXPECTED_WT,
    mkdirExclusive: () => {},
    rename: () => {},
    removeNoFollow: () => {},
  },
};

afterEach(() => {
  rmSync(join(HERMES_HOMES_DIR, 'review-42'), {
    recursive: true,
    force: true,
  });
});

function makeRunner(worktreeList = `worktree /x\nHEAD a\nbranch refs/heads/next\n`) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') return worktreeList;
    if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse') return `${EXPECTED_WT}\n`;
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
  it('creates a DETACHED pr-<N> worktree at origin/<headRefName> (never claims the branch)', async () => {
    // -B would fail whenever the head branch is checked out in the impl worktree
    // (`jinn-mono_worktrees/<N>`, which persists while the issue is In Review) —
    // git refuses a second checkout, and that blocked review dispatch entirely.
    const { runner, calls } = makeRunner();
    const { spawn } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn, leaseStore: TEST_LEASE_STORE });
    const add = calls.find((c) => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(add).toBeDefined();
    expect(add!.args).toContain('--detach');
    expect(add!.args).not.toContain('-B');
    expect(add!.args).not.toContain('-b');
    expect(add!.args[add!.args.indexOf('--detach') + 1]).toBe(EXPECTED_WT);
    expect(add!.args[add!.args.length - 1]).toBe('origin/feat/42-thing');
    expect(calls.some((c) => c.cmd === 'git' && c.args[0] === 'fetch')).toBe(true);
  });

  it('tells the session the worktree is detached and how to push', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn, leaseStore: TEST_LEASE_STORE });
    const prompt = calls[0].args[calls[0].args.indexOf('-p') + 1];
    expect(prompt).toContain('DETACHED');
    expect(prompt).toContain('JINN_REVIEW_HEAD_REF');
    expect(prompt).toContain('fixed Jinn-Network/mono HTTPS remote');
    expect(prompt).toContain(
      'bind every GitHub command to JINN_REVIEW_GH_TOKEN at the command point',
    );
    expect(prompt).not.toContain(PR.headRefName);
    expect(prompt).not.toContain('git push origin');
  });

  it('is idempotent — skips git worktree add when pr-<N> already exists', async () => {
    const list = `worktree /x\nHEAD a\nbranch refs/heads/next\n\nworktree ${EXPECTED_WT}\nHEAD b\nbranch refs/heads/feat/42-thing\n`;
    const { runner, calls } = makeRunner(list);
    const { spawn } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn, leaseStore: TEST_LEASE_STORE });
    expect(calls.find((c) => c.cmd === 'git' && c.args[1] === 'add')).toBeUndefined();
  });

  it('spawns claude -p with a review-pr prompt naming the PR and the pre-created worktree', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn, leaseStore: TEST_LEASE_STORE });
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

  it('passes the named reviewer credential and expected login to every review shell', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(
      PR,
      {
        ...CFG,
        reviewGhToken: 'review-token',
        reviewBotLogin: 'review-bot',
      },
      { runner, spawn, leaseStore: TEST_LEASE_STORE },
    );

    expect(calls[0].opts.env).toMatchObject({
      GH_TOKEN: 'review-token',
      JINN_REVIEW_GH_TOKEN: 'review-token',
      JINN_REVIEW_BOT_LOGIN: 'review-bot',
      JINN_REVIEW_HEAD_REF: PR.headRefName,
      JINN_AUTOPILOT_RUNTIME: 'claude',
    });
  });

  it('uses Hermes globally while preserving the reviewer identity and default effort', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(
      PR,
      {
        ...CFG,
        runtime: 'hermes',
        reviewGhToken: 'review-token',
        reviewBotLogin: 'review-bot',
      },
      { runner, spawn, leaseStore: TEST_LEASE_STORE },
    );

    expect(calls[0].cmd).toBe('/opt/hermes/python');
    expect(calls[0].args).not.toContain('--effort');
    expect(calls[0].opts.env).toMatchObject({
      GH_TOKEN: 'review-token',
      JINN_REVIEW_GH_TOKEN: 'review-token',
      JINN_AUTOPILOT_RUNTIME: 'hermes',
      HERMES_HOME: expect.stringContaining('review-42'),
    });
  });

  it('validates a safe head ref with git before fetching or spawning', async () => {
    const { runner, calls } = makeRunner();
    const { spawn } = makeSpawn();

    await dispatchReview(PR, CFG, { runner, spawn, leaseStore: TEST_LEASE_STORE });

    expect(calls[0]).toEqual({
      cmd: 'git',
      args: ['check-ref-format', 'refs/heads/feat/42-thing'],
    });
    expect(calls.findIndex((call) => call.args[0] === 'check-ref-format')).toBeLessThan(
      calls.findIndex((call) => call.args[0] === 'fetch'),
    );
  });

  it.each([
    'feat/$(id)',
    'feat/`id`',
  ])('rejects shell-active head ref %s before any command or spawn', async (headRefName) => {
    const { runner, calls: runnerCalls } = makeRunner();
    const { spawn, calls: spawnCalls } = makeSpawn();

    await expect(
      dispatchReview(
        { ...PR, headRefName },
        CFG,
        { runner, spawn, leaseStore: TEST_LEASE_STORE },
      ),
    ).rejects.toThrow(/safe Git branch name/);

    expect(runnerCalls).toHaveLength(0);
    expect(spawnCalls).toHaveLength(0);
  });

  it('fails a git-invalid head ref before spawn', async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'check-ref-format') {
        throw new Error('invalid ref');
      }
      throw new Error(`Unexpected command after invalid ref: ${cmd} ${args.join(' ')}`);
    };
    const { spawn, calls } = makeSpawn();

    await expect(
      dispatchReview(
        { ...PR, headRefName: 'feat/bad..ref' },
        CFG,
        { runner, spawn, leaseStore: TEST_LEASE_STORE },
      ),
    ).rejects.toThrow(/invalid ref/);

    expect(calls).toHaveLength(0);
  });

  it('does NOT pass plan-posture flags', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn, leaseStore: TEST_LEASE_STORE });
    expect(calls[0].args).not.toContain('--mode');
    expect(calls[0].args).not.toContain('--permission-mode');
  });

  it('returns an InFlightReview with prNumber, branch, worktree, pid', async () => {
    const { runner } = makeRunner();
    const { spawn } = makeSpawn(7777);
    const s = await dispatchReview(PR, CFG, { runner, spawn, leaseStore: TEST_LEASE_STORE });
    expect(s.prNumber).toBe(42);
    expect(s.branch).toBe('feat/42-thing');
    expect(s.worktreePath).toBe(EXPECTED_WT);
    expect(s.pid).toBe(7777);
  });

  it('persists a canonical ownership lease for restart recovery', async () => {
    const { runner } = makeRunner();
    const { spawn } = makeSpawn(7777);
    const recorded: ReviewLease[] = [];
    const leaseStore: ReviewLeaseStore = {
      record: (lease) => { recorded.push(lease); },
      read: () => null,
      releaseIfMatches: () => false,
    };

    const session = await dispatchReview(PR, CFG, { runner, spawn, leaseStore });

    expect(recorded).toEqual([
      {
        version: 2,
        leaseId: expect.any(String),
        prNumber: 42,
        worktreePath: EXPECTED_WT,
        pid: 7777,
        startedAt: session.startedAt,
      },
    ]);
  });

  it('releases the ownership lease when the reviewer terminates', async () => {
    const { runner } = makeRunner(`worktree ${EXPECTED_WT}\nHEAD b\ndetached\n`);
    const { spawn, calls } = makeSpawn();
    const released: number[] = [];
    const leaseStore: ReviewLeaseStore = {
      record: () => {},
      read: () => recordedLease,
      releaseIfMatches: (prNumber, leaseId) => {
        if (recordedLease?.leaseId !== leaseId) return false;
        released.push(prNumber);
        recordedLease = null;
        return true;
      },
    };
    let recordedLease: ReviewLease | null = null;
    leaseStore.record = (lease) => { recordedLease = lease; };
    await dispatchReview(PR, CFG, {
      runner,
      spawn,
      leaseStore,
      cleanupOptions: TEST_CLEANUP_OPTIONS,
    });
    const onExit = calls[0].opts.onExit as
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | undefined;

    onExit?.(0, null);

    await vi.waitFor(() => expect(released).toEqual([42]));
  });

  it('authenticates the review session as the reviewer identity via GH_TOKEN (DR-2026-06-15)', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, { ...CFG, reviewGhToken: 'rev-token-xyz' }, { runner, spawn, leaseStore: TEST_LEASE_STORE });
    const env = calls[0].opts.env as Record<string, string> | undefined;
    expect(env?.GH_TOKEN).toBe('rev-token-xyz');
  });

  it('inherits the ambient gh account (no GH_TOKEN) when no reviewer token is configured', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn, leaseStore: TEST_LEASE_STORE }); // reviewGhToken: ''
    const env = calls[0].opts.env as Record<string, string> | undefined;
    expect(env?.GH_TOKEN).toBeUndefined();
  });

  it('disables the print-mode background-wait ceiling so the review session runs to completion', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner, spawn, leaseStore: TEST_LEASE_STORE });
    const env = calls[0].opts.env as Record<string, string> | undefined;
    expect(env?.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe('0');
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '../42' as unknown as number,
  ])('rejects invalid runtime PR number %s before any side effect', async (number) => {
    const { runner, calls: runnerCalls } = makeRunner(
      `worktree ${EXPECTED_WT}\nHEAD b\ndetached\n`,
    );
    const { spawn, calls: spawnCalls } = makeSpawn();

    await expect(
      dispatchReview({ ...PR, number }, CFG, { runner, spawn, leaseStore: TEST_LEASE_STORE }),
    ).rejects.toThrow('positive safe integer');

    expect(runnerCalls).toEqual([]);
    expect(spawnCalls).toEqual([]);
  });

  it('asks Git to remove only its exact pr-N worktree after the reviewer exits', async () => {
    const { runner, calls: runnerCalls } = makeRunner(
      `worktree ${EXPECTED_WT}\nHEAD b\ndetached\n`,
    );
    const { spawn, calls: spawnCalls } = makeSpawn();

    let recordedLease: ReviewLease | null = null;
    const leaseStore: ReviewLeaseStore = {
      record: (lease) => { recordedLease = lease; },
      read: () => recordedLease,
      releaseIfMatches: (_prNumber, leaseId) => {
        if (recordedLease?.leaseId !== leaseId) return false;
        recordedLease = null;
        return true;
      },
    };
    await dispatchReview(PR, CFG, {
      runner,
      spawn,
      leaseStore,
      cleanupOptions: TEST_CLEANUP_OPTIONS,
    });

    const onExit = spawnCalls[0].opts.onExit as
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | undefined;
    expect(onExit).toBeTypeOf('function');

    onExit?.(0, null);
    await vi.waitFor(() => {
      expect(
        runnerCalls.filter(
          ({ cmd, args }) =>
            cmd === 'git' &&
            (
              (args[0] === 'worktree' && args[1] === 'remove')
            ),
        ),
      ).toEqual([
        {
          cmd: 'git',
          args: ['worktree', 'remove', '--force', EXPECTED_WT],
        },
      ]);
    });
  });

  it('retains the lease when Git removal fails and remains registered', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { spawn, calls: spawnCalls } = makeSpawn();
    const runnerCalls: string[][] = [];
    const released: number[] = [];
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return `worktree ${EXPECTED_WT}\nHEAD b\ndetached\n`;
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse') {
        return `${EXPECTED_WT}\n`;
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        runnerCalls.push(args);
        throw new Error('remove failed');
      }
      if (cmd === 'git') {
        runnerCalls.push(args);
        return '';
      }
      throw new Error(`Unexpected: ${cmd} ${args.join(' ')}`);
    };
    const leaseStore: ReviewLeaseStore = {
      record: (lease) => { recordedLease = lease; },
      read: () => recordedLease,
      releaseIfMatches: (prNumber, leaseId) => {
        if (recordedLease?.leaseId !== leaseId) return false;
        released.push(prNumber);
        recordedLease = null;
        return true;
      },
    };
    let recordedLease: ReviewLease | null = null;

    await dispatchReview(PR, CFG, {
      runner,
      spawn,
      leaseStore,
      cleanupOptions: TEST_CLEANUP_OPTIONS,
    });
    const onExit = spawnCalls[0].opts.onExit as
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | undefined;
    onExit?.(1, null);

    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(
      runnerCalls.filter((args) => args[0] === 'worktree' && args[1] === 'remove'),
    ).toEqual([['worktree', 'remove', '--force', EXPECTED_WT]]);
    expect(released).toEqual([]);
    error.mockRestore();
  });

  it('does not run pre-unregister cleanup when canonical removal fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { spawn, calls: spawnCalls } = makeSpawn();
    const cleanupCalls: string[][] = [];
    const released: number[] = [];
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return `worktree ${EXPECTED_WT}\nHEAD b\ndetached\n`;
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse') {
        return `${EXPECTED_WT}\n`;
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'clean') {
        cleanupCalls.push(args);
        return '';
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('remove failed');
      }
      if (cmd === 'git') return '';
      throw new Error(`Unexpected: ${cmd} ${args.join(' ')}`);
    };
    const leaseStore: ReviewLeaseStore = {
      record: (lease) => { recordedLease = lease; },
      read: () => recordedLease,
      releaseIfMatches: (prNumber, leaseId) => {
        if (recordedLease?.leaseId !== leaseId) return false;
        released.push(prNumber);
        recordedLease = null;
        return true;
      },
    };
    let recordedLease: ReviewLease | null = null;

    await dispatchReview(PR, CFG, {
      runner,
      spawn,
      leaseStore,
      cleanupOptions: TEST_CLEANUP_OPTIONS,
    });
    const onExit = spawnCalls[0].opts.onExit as
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | undefined;
    onExit?.(1, null);

    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(cleanupCalls).toEqual([]);
    expect(released).toEqual([]);
    error.mockRestore();
  });

  it('logs an asynchronous cleanup rejection without throwing from the child exit event', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { spawn, calls: spawnCalls } = makeSpawn();
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return `worktree ${EXPECTED_WT}\nHEAD b\ndetached\n`;
      }
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse') {
        return `${EXPECTED_WT}\n`;
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('locked');
      }
      if (cmd === 'git') return '';
      throw new Error(`Unexpected: ${cmd} ${args.join(' ')}`);
    };

    let current: ReviewLease | null = null;
    const leaseStore: ReviewLeaseStore = {
      record: (lease) => { current = lease; },
      read: () => current,
      releaseIfMatches: () => false,
    };
    await dispatchReview(PR, CFG, {
      runner,
      spawn,
      leaseStore,
      cleanupOptions: TEST_CLEANUP_OPTIONS,
    });
    const onExit = spawnCalls[0].opts.onExit as
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | undefined;

    expect(() => onExit?.(1, null)).not.toThrow();
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('review #42 worktree cleanup failed'),
        expect.any(Error),
      );
    });
    error.mockRestore();
  });

  it('logs a synchronous cleanup throw without throwing from the child exit event', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { spawn, calls: spawnCalls } = makeSpawn();
    const base = makeRunner(`worktree ${EXPECTED_WT}\nHEAD b\ndetached\n`);
    const runner = ((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('locked synchronously');
      }
      return base.runner(cmd, args);
    }) as CommandRunner;

    let current: ReviewLease | null = null;
    const leaseStore: ReviewLeaseStore = {
      record: (lease) => { current = lease; },
      read: () => current,
      releaseIfMatches: () => false,
    };
    await dispatchReview(PR, CFG, {
      runner,
      spawn,
      leaseStore,
      cleanupOptions: TEST_CLEANUP_OPTIONS,
    });
    const onExit = spawnCalls[0].opts.onExit as
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | undefined;

    expect(() => onExit?.(1, null)).not.toThrow();
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('review #42 worktree cleanup failed'),
        expect.objectContaining({ message: 'locked synchronously' }),
      );
    });
    error.mockRestore();
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
    await dispatchReview(PR, CFG, { runner: diffRunner('client/src/dashboard/spa/src/pages/Tasks.tsx\n'), spawn, leaseStore: TEST_LEASE_STORE });
    const prompt = promptOf(calls);
    expect(prompt).toContain('HUMAN-SURFACE');
    expect(prompt).toContain('review:needs-human');
    expect(prompt).not.toContain('APPROVE-ELIGIBLE');
  });

  it('marks a PR touching only non-owned paths as APPROVE-ELIGIBLE', async () => {
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner: diffRunner('packages/autopilot/src/dispatcher/loop.ts\n'), spawn, leaseStore: TEST_LEASE_STORE });
    const prompt = promptOf(calls);
    expect(prompt).toContain('APPROVE-ELIGIBLE');
    expect(prompt).not.toContain('HUMAN-SURFACE');
  });

  it('fails safe to advisory when the changed-file list cannot be determined', async () => {
    const { spawn, calls } = makeSpawn();
    await dispatchReview(PR, CFG, { runner: diffRunner(''), spawn, leaseStore: TEST_LEASE_STORE }); // empty diff → advisory
    expect(promptOf(calls)).toContain('HUMAN-SURFACE');
  });
});
