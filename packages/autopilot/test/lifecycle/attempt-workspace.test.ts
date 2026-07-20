import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultRunner, type CommandRunner } from '../../src/dispatcher/issue-source.js';
import {
  cleanupAttempt,
  countRunnerLiveAttempts,
  createAttemptWorkspace,
  defaultRunnerId,
  readAttemptManifest,
  sweepDeadAttempts,
  updateAttemptManifest,
  type AttemptManifest,
  type CreateAttemptOptions,
} from '../../src/lifecycle/attempt-workspace.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-07-20T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function repositoryFixture(): {
  root: string;
  repo: string;
  remote: string;
  base: string;
  oid: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'jinn-attempt-test-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  const base = join(root, 'worktrees');
  execFileSync('git', ['init', '--bare', remote]);
  execFileSync('git', ['init', repo]);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-u', 'origin', 'main']);
  return { root, repo, remote, base, oid: git(repo, ['rev-parse', 'HEAD']) };
}

function options(
  fixture: ReturnType<typeof repositoryFixture>,
  overrides: Partial<CreateAttemptOptions> = {},
): CreateAttemptOptions {
  return {
    repositoryPath: fixture.repo,
    worktreeBase: fixture.base,
    runnerId: 'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    phase: 'implement',
    subject: 'issue-42',
    issueNumber: 42,
    branch: 'main',
    targetBase: 'main',
    expectedHead: fixture.oid,
    claimOid: fixture.oid,
    selectedLogin: 'impl-bot',
    attemptId: UUID_A,
    now: () => new Date(NOW),
    ...overrides,
  };
}

describe('attempt workspace and manifest', () => {
  it('gives two processes unique detached attempts in one Git common directory', async () => {
    const fixture = repositoryFixture();
    const [one, two] = await Promise.all([
      createAttemptWorkspace(options(fixture), defaultRunner),
      createAttemptWorkspace(options(fixture, {
        runnerId: 'host-101-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attemptId: UUID_B,
      }), defaultRunner),
    ]);

    expect(one.paths.worktree).toBe(join(
      fixture.base,
      'v2',
      one.runnerId,
      'implement',
      `issue-42-${UUID_A}`,
      'worktree',
    ));
    expect(two.paths.worktree).not.toBe(one.paths.worktree);
    expect(git(one.paths.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(git(two.paths.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(git(one.paths.worktree, ['rev-parse', 'HEAD'])).toBe(fixture.oid);
    expect(git(two.paths.worktree, ['rev-parse', 'HEAD'])).toBe(fixture.oid);
    expect(readFileSync(one.paths.askpass, 'utf8')).not.toContain('selected-secret');
    expect(readdirSync(one.paths.ghConfigDir)).toEqual([]);
  });

  it('builds a collision-resistant filesystem-safe default runner id', () => {
    const id = defaultRunnerId({
      configured: undefined,
      hostname: 'Build Host.example',
      pid: 123,
      bootId: UUID_A,
    });
    expect(id).toBe(`build-host.example-123-${UUID_A}`);
    expect(() => defaultRunnerId({
      configured: 'runner/escaped',
      hostname: 'host',
      pid: 1,
      bootId: UUID_A,
    })).toThrow(/filesystem-safe/);
    expect(defaultRunnerId({
      environment: { JINN_AUTOPILOT_RUNNER_ID: 'configured-runner' },
      hostname: 'ignored',
      pid: 1,
      bootId: UUID_A,
    })).toBe('configured-runner');
  });

  it('strictly decodes manifests and atomically updates timestamps/PID', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);

    expect(readAttemptManifest(manifest.paths.manifest)).toEqual(manifest);
    const raw = JSON.parse(readFileSync(manifest.paths.manifest, 'utf8')) as Record<string, unknown>;
    raw.token = 'must-not-be-accepted';
    writeFileSync(manifest.paths.manifest, JSON.stringify(raw));
    expect(() => readAttemptManifest(manifest.paths.manifest)).toThrow(/Unknown field: token/);
    delete raw.token;
    writeFileSync(manifest.paths.manifest, JSON.stringify(raw));

    const updated = updateAttemptManifest(manifest.paths.manifest, (current) => ({
      ...current,
      pid: 4242,
      timestamps: {
        ...current.timestamps,
        updatedAt: '2026-07-20T00:01:00.000Z',
        childStartedAt: '2026-07-20T00:01:00.000Z',
      },
    }));
    expect(updated.pid).toBe(4242);
    expect(readAttemptManifest(manifest.paths.manifest)).toEqual(updated);
    expect(readdirSync(manifest.paths.attemptDir).filter((name) => name.includes('.tmp-')))
      .toEqual([]);
    expect(JSON.stringify(updated)).not.toMatch(/must-not-be-accepted|token/i);
  });

  it('counts only this runner’s live manifests for local capacity', async () => {
    const fixture = repositoryFixture();
    const one = await createAttemptWorkspace(options(fixture, {
      pid: 100,
    }), defaultRunner);
    await createAttemptWorkspace(options(fixture, {
      runnerId: 'other-200-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptId: UUID_B,
      pid: 200,
    }), defaultRunner);

    expect(countRunnerLiveAttempts(
      join(fixture.base, 'v2'),
      one.runnerId,
      (pid) => pid === 100 || pid === 200,
    )).toBe(1);
  });
});

describe('safe attempt cleanup', () => {
  it('removes a clean attempt whose HEAD is reachable from the fetched publication ref', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);

    const result = await cleanupAttempt(manifest.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    });
    expect(result).toEqual({ status: 'removed', attemptId: UUID_A });
    expect(() => readFileSync(manifest.paths.manifest)).toThrow();
  });

  it('treats an already-removed exact worktree as redundant cleanup', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);
    git(fixture.repo, ['worktree', 'remove', manifest.paths.worktree]);

    await expect(cleanupAttempt(manifest.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toEqual({ status: 'removed', attemptId: UUID_A });
  });

  it('retains dirty, ahead, and live attempts with structured reasons', async () => {
    const dirtyFixture = repositoryFixture();
    const dirty = await createAttemptWorkspace(options(dirtyFixture), defaultRunner);
    writeFileSync(join(dirty.paths.worktree, 'dirty.txt'), 'dirty\n');
    await expect(cleanupAttempt(dirty.paths.manifest, defaultRunner, {
      v2Base: join(dirtyFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'dirty' } });

    const aheadFixture = repositoryFixture();
    const ahead = await createAttemptWorkspace(options(aheadFixture), defaultRunner);
    writeFileSync(join(ahead.paths.worktree, 'ahead.txt'), 'ahead\n');
    git(ahead.paths.worktree, ['add', 'ahead.txt']);
    git(ahead.paths.worktree, ['commit', '-m', 'ahead']);
    await expect(cleanupAttempt(ahead.paths.manifest, defaultRunner, {
      v2Base: join(aheadFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'ahead' } });

    const liveFixture = repositoryFixture();
    const live = await createAttemptWorkspace(options(liveFixture, { pid: 444 }), defaultRunner);
    await expect(cleanupAttempt(live.paths.manifest, defaultRunner, {
      v2Base: join(liveFixture.base, 'v2'),
      isPidAlive: (pid) => pid === 444,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'live' } });
  });

  it('retains authentication failure, missing objects, malformed manifests, and escaped paths', async () => {
    const authFixture = repositoryFixture();
    const auth = await createAttemptWorkspace(options(authFixture), defaultRunner);
    const authRunner: CommandRunner = async (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('fetch')) {
        throw new Error('authentication failed and selected-secret appeared here');
      }
      return defaultRunner(cmd, args, opts);
    };
    const authResult = await cleanupAttempt(auth.paths.manifest, authRunner, {
      v2Base: join(authFixture.base, 'v2'),
      isPidAlive: () => false,
    });
    expect(authResult).toMatchObject({
      status: 'retained',
      reason: { code: 'authentication-failed' },
    });
    expect(JSON.stringify(authResult)).not.toContain('selected-secret');

    const missingFixture = repositoryFixture();
    const missing = await createAttemptWorkspace(options(missingFixture), defaultRunner);
    const missingRunner: CommandRunner = async (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('rev-parse') && args.some((arg) => arg.includes('HEAD'))) {
        throw new Error('missing');
      }
      return defaultRunner(cmd, args, opts);
    };
    await expect(cleanupAttempt(missing.paths.manifest, missingRunner, {
      v2Base: join(missingFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'missing-object' } });

    const malformedFixture = repositoryFixture();
    const malformed = await createAttemptWorkspace(options(malformedFixture), defaultRunner);
    writeFileSync(malformed.paths.manifest, '{"version":2,"oops":true}');
    await expect(cleanupAttempt(malformed.paths.manifest, defaultRunner, {
      v2Base: join(malformedFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'malformed' } });

    const escapedFixture = repositoryFixture();
    const escaped = await createAttemptWorkspace(options(escapedFixture), defaultRunner);
    const escapedRaw = JSON.parse(readFileSync(escaped.paths.manifest, 'utf8')) as AttemptManifest;
    writeFileSync(escaped.paths.manifest, JSON.stringify({
      ...escapedRaw,
      paths: { ...escapedRaw.paths, attemptDir: escapedFixture.root },
    }));
    await expect(cleanupAttempt(escaped.paths.manifest, defaultRunner, {
      v2Base: join(escapedFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'escaped-path' } });

    const symlinkFixture = repositoryFixture();
    const symlinked = await createAttemptWorkspace(options(symlinkFixture), defaultRunner);
    git(symlinkFixture.repo, ['worktree', 'remove', symlinked.paths.worktree]);
    symlinkSync(symlinkFixture.repo, symlinked.paths.worktree, 'dir');
    await expect(cleanupAttempt(symlinked.paths.manifest, defaultRunner, {
      v2Base: join(symlinkFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'escaped-path' } });
    expect(readFileSync(join(symlinkFixture.repo, 'README.md'), 'utf8')).toBe('base\n');
  });

  it('retains ambiguous Git inspection errors instead of forcing removal', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);
    const runner: CommandRunner = async (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('status')) throw new Error('unexpected git failure');
      return defaultRunner(cmd, args, opts);
    };
    await expect(cleanupAttempt(manifest.paths.manifest, runner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'ambiguous' } });
    expect(readFileSync(manifest.paths.manifest, 'utf8')).toContain(UUID_A);
  });

  it('sanitizes ambient credentials for the exact askpass fetch', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ambient-secret');
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);
    let fetchSeen = false;
    const runner: CommandRunner = async (cmd, args, opts) => {
      if (cmd === 'git' && args.includes('fetch')) {
        fetchSeen = true;
        expect(opts?.env).toMatchObject({
          GH_TOKEN: 'selected-secret',
          GITHUB_TOKEN: '',
          GIT_ASKPASS: manifest.paths.askpass,
          GIT_TERMINAL_PROMPT: '0',
        });
      }
      return defaultRunner(cmd, args, opts);
    };
    try {
      await expect(cleanupAttempt(manifest.paths.manifest, runner, {
        v2Base: join(fixture.base, 'v2'),
        isPidAlive: () => false,
        env: { GH_TOKEN: 'selected-secret' },
      })).resolves.toEqual({ status: 'removed', attemptId: UUID_A });
      expect(fetchSeen).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sweeps dead same-host attempts while retaining live children', async () => {
    const fixture = repositoryFixture();
    const dead = await createAttemptWorkspace(options(fixture, {
      pid: 100,
      host: 'same-host',
    }), defaultRunner);
    const live = await createAttemptWorkspace(options(fixture, {
      runnerId: 'same-host-200-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      attemptId: UUID_B,
      pid: 200,
      host: 'same-host',
    }), defaultRunner);

    const results = await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: (pid) => pid === 200,
    });

    expect(results).toEqual(expect.arrayContaining([
      { status: 'removed', attemptId: dead.attemptId },
      {
        status: 'retained',
        attemptId: live.attemptId,
        reason: { code: 'live', detail: 'Attempt child PID is still live.' },
      },
    ]));
    expect(() => readFileSync(dead.paths.manifest)).toThrow();
    expect(readFileSync(live.paths.manifest, 'utf8')).toContain(live.attemptId);
  });
});
