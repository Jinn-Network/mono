// @ts-nocheck — Stage 5: deleted merge-prep/review-fix/project-status fixtures.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultRunner, type CommandRunner } from '../../src/dispatcher/issue-source.js';
import { SelectedCredential } from '../../src/lifecycle/credentials.js';
import {
  advanceAttemptExpectedHead,
  advanceAttemptReviewPair,
  cleanupAttempt,
  countRunnerLiveAttempts,
  createAttemptWorkspace,
  defaultRunnerId,
  listRunnerLiveAttempts,
  markAttemptExited,
  markAttemptRunning,
  readAttemptManifest,
  sweepDeadAttempts,
  trackAttemptChild,
  updateAttemptManifest,
  type AttemptManifest,
  type CreateAttemptOptions,
} from '../../src/lifecycle/attempt-workspace.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
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
    credential: new SelectedCredential('impl-bot', 'implementation', 'selected-secret'),
    attemptId: UUID_A,
    now: () => new Date(NOW),
    ...overrides,
  };
}

function terminalAttempt(manifest: AttemptManifest): AttemptManifest {
  markAttemptRunning(manifest.paths.manifest, 4242, () =>
    new Date('2026-07-20T00:01:00.000Z'));
  return markAttemptExited(
    manifest.paths.manifest,
    () => new Date('2026-07-20T00:02:00.000Z'),
    manifest.expectedHead,
  );
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
    expect(readdirSync(one.paths.ghConfigDir)).toEqual(['hosts.yml']);
  });

  it('writes the runtime-independent gh-config hosts.yml and token file at creation, and points the askpass helper at the file instead of $GH_TOKEN (#1883)', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture, {
      selectedLogin: 'impl-bot',
      credential: new SelectedCredential('impl-bot', 'implementation', 'the-raw-token'),
    }), defaultRunner);

    // Token file: sibling to the manifest, 0o600, holds exactly the raw token.
    expect(manifest.paths.tokenFile).toBe(join(manifest.paths.attemptDir, 'gh-token'));
    expect(readFileSync(manifest.paths.tokenFile, 'utf8').trim()).toBe('the-raw-token');
    expect(statSync(manifest.paths.tokenFile).mode & 0o777).toBe(0o600);

    // gh CLI's own hosts.yml: 0o600, in the (already 0o700) gh-config dir.
    const hostsYamlPath = join(manifest.paths.ghConfigDir, 'hosts.yml');
    const hostsYaml = readFileSync(hostsYamlPath, 'utf8');
    expect(hostsYaml).toBe(
      'github.com:\n    oauth_token: the-raw-token\n    user: impl-bot\n    git_protocol: https\n',
    );
    expect(statSync(hostsYamlPath).mode & 0o777).toBe(0o600);
    expect(statSync(manifest.paths.ghConfigDir).mode & 0o777).toBe(0o700);

    // Askpass no longer echoes an env var; it reads the token file by path.
    const askpass = readFileSync(manifest.paths.askpass, 'utf8');
    expect(askpass).not.toContain('GH_TOKEN');
    expect(askpass).not.toContain('the-raw-token');
    expect(askpass).toContain(`cat "${manifest.paths.tokenFile}"`);
  });

  it('binds the strict manifest to the canonical repository and remote identity', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);

    expect(manifest.repository).toEqual({
      root: realpathSync(fixture.repo),
      gitCommonDir: realpathSync(git(fixture.repo, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ])),
      remoteName: 'origin',
      remoteUrlHash: createHash('sha256').update(fixture.remote).digest('hex'),
    });

    const raw = JSON.parse(readFileSync(manifest.paths.manifest, 'utf8')) as Record<string, unknown>;
    raw.repository = {
      ...(raw.repository as Record<string, unknown>),
      unexpected: true,
    };
    writeFileSync(manifest.paths.manifest, JSON.stringify(raw));
    expect(() => readAttemptManifest(manifest.paths.manifest)).toThrow(
      /Unknown field: unexpected/,
    );
  });

  it('validates the complete manifest before side effects and exactly rolls back Git add failure', async () => {
    const invalidFixture = repositoryFixture();
    await expect(createAttemptWorkspace(options(invalidFixture, {
      expectedHead: 'not-an-oid',
    }), defaultRunner)).rejects.toThrow(/OID/);
    expect(existsSync(invalidFixture.base)).toBe(false);

    const failureFixture = repositoryFixture();
    const attemptDir = join(
      failureFixture.base,
      'v2',
      'host-100-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'implement',
      `issue-42-${UUID_A}`,
    );
    const failingRunner: CommandRunner = async (cmd, args, opts) => {
      const result = await defaultRunner(cmd, args, opts);
      if (cmd === 'git' && args.includes('add') && args.includes('--detach')) {
        throw new Error('injected failure after worktree registration');
      }
      return result;
    };

    await expect(createAttemptWorkspace(
      options(failureFixture),
      failingRunner,
    )).rejects.toThrow(/injected failure/);
    expect(existsSync(attemptDir)).toBe(false);
    expect(git(failureFixture.repo, ['worktree', 'list', '--porcelain']))
      .not.toContain(join(attemptDir, 'worktree'));

    const collisionFixture = repositoryFixture();
    const collision = await createAttemptWorkspace(options(collisionFixture), defaultRunner);
    rmSync(collision.paths.attemptDir, { recursive: true });
    await expect(createAttemptWorkspace(
      options(collisionFixture),
      defaultRunner,
    )).rejects.toThrow(/already registered/);
    expect(git(collisionFixture.repo, ['worktree', 'list', '--porcelain']))
      .toContain(`issue-42-${UUID_A}/worktree`);
  });

  it('rejects review ref metadata without a generation before any side effect', async () => {
    const fixture = repositoryFixture();
    let commandCalls = 0;
    const observingRunner: CommandRunner = async (cmd, args, runnerOptions) => {
      commandCalls++;
      return defaultRunner(cmd, args, runnerOptions);
    };

    await expect(createAttemptWorkspace(options(fixture, {
      phase: 'review',
      subject: 'pr-7',
      prNumber: 7,
      reviewRefOid: fixture.oid,
    }), observingRunner)).rejects.toThrow(/generation.*ref OID|ref OID.*generation/i);
    expect(commandCalls).toBe(0);
    expect(existsSync(fixture.base)).toBe(false);
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

  it('strictly decodes manifests and atomically tracks preparing, running, and exited', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);

    expect(manifest.processState).toBe('preparing');
    expect(readAttemptManifest(manifest.paths.manifest)).toEqual(manifest);
    const raw = JSON.parse(readFileSync(manifest.paths.manifest, 'utf8')) as Record<string, unknown>;
    raw.token = 'must-not-be-accepted';
    writeFileSync(manifest.paths.manifest, JSON.stringify(raw));
    expect(() => readAttemptManifest(manifest.paths.manifest)).toThrow(/Unknown field: token/);
    delete raw.token;
    writeFileSync(manifest.paths.manifest, JSON.stringify(raw));

    const running = markAttemptRunning(manifest.paths.manifest, 4242, () =>
      new Date('2026-07-20T00:01:00.000Z'));
    expect(running).toMatchObject({ processState: 'running', pid: 4242 });

    const child = Object.assign(new EventEmitter(), { pid: 4242 });
    trackAttemptChild(manifest.paths.manifest, child, {
      alreadyRunning: true,
      now: () => new Date('2026-07-20T00:02:00.000Z'),
    });
    child.emit('exit', 0);
    const updated = readAttemptManifest(manifest.paths.manifest);
    expect(updated).toMatchObject({ processState: 'exited', pid: 4242 });
    expect(updated.timestamps.childExitedAt).toBe('2026-07-20T00:02:00.000Z');

    const second = await createAttemptWorkspace(options(fixture, {
      attemptId: UUID_B,
    }), defaultRunner);
    const alreadyExited = Object.assign(new EventEmitter(), { pid: 5252, exitCode: 0 });
    trackAttemptChild(second.paths.manifest, alreadyExited, {
      now: () => new Date('2026-07-20T00:03:00.000Z'),
      terminalHead: second.expectedHead,
    });
    expect(readAttemptManifest(second.paths.manifest).processState).toBe('exited');
    expect(readdirSync(manifest.paths.attemptDir).filter((name) => name.includes('.tmp-')))
      .toEqual([]);
    // The earlier injected garbage `token` field (rejected above) must not
    // have been silently re-accepted; the legitimate `paths.tokenFile` field
    // is expected here and is not what this assertion is guarding against.
    expect(JSON.stringify(updated)).not.toMatch(/must-not-be-accepted/i);
    expect(Object.keys(JSON.parse(JSON.stringify(updated)) as Record<string, unknown>))
      .not.toContain('token');
  });

  it('locks every static manifest authority, identity, and path field across updates', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture, {
      phase: 'review',
      subject: 'pr-7',
      prNumber: 7,
      reviewGeneration: UUID_C,
      reviewRefOid: fixture.oid,
      reviewApprovalPolicy: 'approve-eligible',
    }), defaultRunner);
    const original = readFileSync(manifest.paths.manifest, 'utf8');
    const otherOid = 'a'.repeat(40);
    const mutations: Array<readonly [
      string,
      (current: AttemptManifest) => AttemptManifest,
    ]> = [
      ['version', (current) => ({ ...current, version: 3 as 2 })],
      ['attempt ID', (current) => ({ ...current, attemptId: UUID_B })],
      ['runner ID', (current) => ({ ...current, runnerId: 'other-runner' })],
      ['host', (current) => ({ ...current, host: 'other-host' })],
      ['phase', (current) => {
        const {
          reviewGeneration: _reviewGeneration,
          reviewRefOid: _reviewRefOid,
          reviewApprovalPolicy: _reviewApprovalPolicy,
          ...withoutReview
        } = current;
        return { ...withoutReview, phase: 'merge-prep' };
      }],
      ['subject and PR identity', (current) => ({
        ...current,
        subject: 'pr-8',
        prNumber: 8,
      })],
      ['issue identity', (current) => ({ ...current, issueNumber: 43 })],
      ['selected login', (current) => ({ ...current, selectedLogin: 'other-bot' })],
      ['branch', (current) => ({ ...current, branch: 'feature/other' })],
      ['in-place branch mutation', (current) => {
        (current as { branch: string }).branch = 'feature/in-place';
        return current;
      }],
      ['target base', (current) => ({ ...current, targetBase: 'next' })],
      ['expected head', (current) => ({ ...current, expectedHead: otherOid })],
      ['claim OID', (current) => ({ ...current, claimOid: otherOid })],
      ['review authority', (current) => ({
        ...current,
        reviewGeneration: UUID_B,
        reviewRefOid: otherOid,
      })],
      ['repository root', (current) => ({
        ...current,
        repository: { ...current.repository, root: join(fixture.root, 'other-root') },
      })],
      ['Git common directory', (current) => ({
        ...current,
        repository: {
          ...current.repository,
          gitCommonDir: join(fixture.root, 'other-common-dir'),
        },
      })],
      ['remote identity', (current) => ({
        ...current,
        repository: {
          ...current.repository,
          remoteName: 'upstream',
          remoteUrlHash: 'b'.repeat(64),
        },
      })],
      ['exact paths', (current) => ({
        ...current,
        paths: {
          ...current.paths,
          log: join(current.paths.attemptDir, 'other.log'),
        },
      })],
      ['creation timestamp', (current) => ({
        ...current,
        timestamps: {
          ...current.timestamps,
          createdAt: '2026-07-19T23:59:00.000Z',
        },
      })],
    ];

    for (const [name, mutate] of mutations) {
      let error: unknown;
      try {
        updateAttemptManifest(manifest.paths.manifest, mutate);
      } catch (caught) {
        error = caught;
      }
      expect.soft(error, `${name} must be rejected`).toBeInstanceOf(Error);
      expect.soft(
        readFileSync(manifest.paths.manifest, 'utf8'),
        `${name} must be rejected before writing`,
      ).toBe(original);
      writeFileSync(manifest.paths.manifest, original);
    }
  });

  it('advances review head and ref together through one exact manifest CAS', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture, {
      phase: 'review',
      subject: 'pr-7',
      prNumber: 7,
      reviewGeneration: UUID_C,
      reviewRefOid: fixture.oid,
      reviewApprovalPolicy: 'approve-eligible',
    }), defaultRunner);
    const nextHead = 'a'.repeat(40);
    const nextReview = 'b'.repeat(40);

    const advanced = advanceAttemptReviewPair(
      manifest.paths.manifest,
      manifest.expectedHead,
      manifest.reviewRefOid!,
      nextHead,
      nextReview,
      () => new Date('2026-07-20T00:01:00.000Z'),
    );

    expect(advanced).toMatchObject({
      expectedHead: nextHead,
      reviewRefOid: nextReview,
      reviewGeneration: UUID_C,
      reviewApprovalPolicy: 'approve-eligible',
    });
    expect(() => advanceAttemptReviewPair(
      manifest.paths.manifest,
      manifest.expectedHead,
      manifest.reviewRefOid!,
      'c'.repeat(40),
      'd'.repeat(40),
    )).toThrow(/authority pair changed/i);
    expect(readAttemptManifest(manifest.paths.manifest)).toMatchObject({
      expectedHead: nextHead,
      reviewRefOid: nextReview,
    });
  });

  it('advances only the progressive expected head through an exact manifest CAS', async () => {
    const fixture = repositoryFixture();
    const current = await createAttemptWorkspace(options(fixture), defaultRunner);
    const nextHead = 'a'.repeat(40);

    const advanced = advanceAttemptExpectedHead(
      current.paths.manifest,
      current.expectedHead,
      nextHead,
      () => new Date('2026-07-20T00:05:00.000Z'),
    );

    expect(advanced.expectedHead).toBe(nextHead);
    expect(advanced.claimOid).toBe(current.claimOid);
    expect(advanced.paths).toEqual(current.paths);
    expect(advanced.timestamps.updatedAt).toBe('2026-07-20T00:05:00.000Z');
    expect(() => advanceAttemptExpectedHead(
      current.paths.manifest,
      current.expectedHead,
      'b'.repeat(40),
    )).toThrow(/expected head changed/i);
    expect(readAttemptManifest(current.paths.manifest).expectedHead).toBe(nextHead);
  });

  it('rejects in-place nested static repository and path mutations', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(options(fixture), defaultRunner);
    const original = readFileSync(manifest.paths.manifest, 'utf8');
    const mutations: Array<readonly [
      string,
      (current: AttemptManifest) => AttemptManifest,
    ]> = [
      ['repository root', (current) => {
        (current.repository as { root: string }).root = join(fixture.root, 'other-root');
        return current;
      }],
      ['Git common directory', (current) => {
        (current.repository as { gitCommonDir: string }).gitCommonDir = join(
          fixture.root,
          'other-common-dir',
        );
        return current;
      }],
      ['remote URL hash', (current) => {
        (current.repository as { remoteUrlHash: string }).remoteUrlHash = 'b'.repeat(64);
        return current;
      }],
      ['worktree path', (current) => {
        (current.paths as { worktree: string }).worktree = join(fixture.root, 'other-worktree');
        return current;
      }],
      ['log path', (current) => {
        (current.paths as { log: string }).log = join(fixture.root, 'other.log');
        return current;
      }],
      ['manifest path', (current) => {
        (current.paths as { manifest: string }).manifest = join(fixture.root, 'other-manifest.json');
        return current;
      }],
    ];

    for (const [name, mutate] of mutations) {
      expect(() => updateAttemptManifest(manifest.paths.manifest, mutate), name).toThrow(
        /static attempt fields/,
      );
      expect(readFileSync(manifest.paths.manifest, 'utf8')).toBe(original);
    }
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
    await createAttemptWorkspace(options(fixture, {
      attemptId: UUID_C,
    }), defaultRunner);

    expect(countRunnerLiveAttempts(
      join(fixture.base, 'v2'),
      one.runnerId,
      (pid) => pid === 100 || pid === 200,
    )).toBe(2);
    expect(listRunnerLiveAttempts(
      join(fixture.base, 'v2'),
      one.runnerId,
      (pid) => pid === 100 || pid === 200,
    ).map((attempt) => attempt.attemptId).sort()).toEqual([UUID_A, UUID_C]);
  });
});

describe('safe attempt cleanup', () => {
  it('retains an attempt when its creating repository identity no longer matches', async () => {
    const fixture = repositoryFixture();
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );
    git(fixture.repo, ['remote', 'set-url', 'origin', join(fixture.root, 'other.git')]);

    await expect(cleanupAttempt(manifest.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({
      status: 'retained',
      reason: { code: 'ambiguous' },
    });
    expect(readFileSync(manifest.paths.manifest, 'utf8')).toContain(UUID_A);
  });

  it('removes a clean attempt whose HEAD is reachable from the fetched publication ref', async () => {
    const fixture = repositoryFixture();
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );

    const result = await cleanupAttempt(manifest.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    });
    expect(result).toEqual({ status: 'removed', attemptId: UUID_A });
    expect(() => readFileSync(manifest.paths.manifest)).toThrow();
  });

  it('treats an already-removed exact worktree as redundant cleanup', async () => {
    const fixture = repositoryFixture();
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );
    git(fixture.repo, ['worktree', 'remove', manifest.paths.worktree]);

    await expect(cleanupAttempt(manifest.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toEqual({ status: 'removed', attemptId: UUID_A });
  });

  it('requires registry absence and remote reachability before removing missing-worktree metadata', async () => {
    const unrecordedFixture = repositoryFixture();
    const unrecorded = await createAttemptWorkspace(options(unrecordedFixture), defaultRunner);
    markAttemptRunning(unrecorded.paths.manifest, 3131);
    markAttemptExited(unrecorded.paths.manifest);
    git(unrecordedFixture.repo, ['worktree', 'remove', unrecorded.paths.worktree]);
    await expect(cleanupAttempt(unrecorded.paths.manifest, defaultRunner, {
      v2Base: join(unrecordedFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({
      status: 'retained',
      reason: { code: 'ambiguous' },
    });

    const registeredFixture = repositoryFixture();
    const registered = terminalAttempt(
      await createAttemptWorkspace(options(registeredFixture), defaultRunner),
    );
    rmSync(registered.paths.worktree, { recursive: true });

    await expect(cleanupAttempt(registered.paths.manifest, defaultRunner, {
      v2Base: join(registeredFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({
      status: 'retained',
      reason: { code: 'ambiguous' },
    });
    expect(git(registeredFixture.repo, ['worktree', 'list', '--porcelain']))
      .toContain(registered.paths.worktree);

    const unreachableFixture = repositoryFixture();
    const unreachable = terminalAttempt(
      await createAttemptWorkspace(options(unreachableFixture), defaultRunner),
    );
    git(unreachableFixture.repo, ['worktree', 'remove', unreachable.paths.worktree]);
    execFileSync('git', [
      `--git-dir=${unreachableFixture.remote}`,
      'update-ref',
      '-d',
      'refs/heads/main',
    ]);

    await expect(cleanupAttempt(unreachable.paths.manifest, defaultRunner, {
      v2Base: join(unreachableFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained' });
    expect(readFileSync(unreachable.paths.manifest, 'utf8')).toContain(UUID_A);
  });

  it('performs missing-worktree cleanup with local Git reads/fetch only', async () => {
    const fixture = repositoryFixture();
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );
    git(fixture.repo, ['worktree', 'remove', manifest.paths.worktree]);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const observingRunner: CommandRunner = async (cmd, args, opts) => {
      calls.push({ cmd, args });
      return defaultRunner(cmd, args, opts);
    };

    await expect(cleanupAttempt(manifest.paths.manifest, observingRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toEqual({ status: 'removed', attemptId: UUID_A });
    expect(calls.every(({ cmd }) => cmd === 'git')).toBe(true);
    expect(calls.some(({ args }) =>
      args.includes('push') || args.includes('update-ref'))).toBe(false);
  });

  it('contains a concurrent missing-worktree metadata removal race', async () => {
    const fixture = repositoryFixture();
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );
    git(fixture.repo, ['worktree', 'remove', manifest.paths.worktree]);
    let raced = false;
    const racingRunner: CommandRunner = async (cmd, args, runnerOptions) => {
      const output = await defaultRunner(cmd, args, runnerOptions);
      if (!raced && cmd === 'git' && args.includes('merge-base')) {
        raced = true;
        rmSync(manifest.paths.attemptDir, { recursive: true });
      }
      return output;
    };

    await expect(cleanupAttempt(manifest.paths.manifest, racingRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toEqual({
      status: 'already-removed',
      attemptId: manifest.attemptId,
    });
  });

  it('reconciles dead running processState to exited before retaining dirty worktrees', async () => {
    const fixture = repositoryFixture();
    const manifest = await createAttemptWorkspace(
      options(fixture, { pid: 4242 }),
      defaultRunner,
    );
    writeFileSync(join(manifest.paths.worktree, 'dirty.txt'), 'dirty\n');

    await expect(cleanupAttempt(manifest.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'dirty' } });
    expect(readAttemptManifest(manifest.paths.manifest).processState).toBe('exited');
  });

  it('retains dirty, ahead, and live attempts with structured reasons', async () => {
    const dirtyFixture = repositoryFixture();
    const dirty = terminalAttempt(
      await createAttemptWorkspace(options(dirtyFixture), defaultRunner),
    );
    writeFileSync(join(dirty.paths.worktree, 'dirty.txt'), 'dirty\n');
    await expect(cleanupAttempt(dirty.paths.manifest, defaultRunner, {
      v2Base: join(dirtyFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'dirty' } });

    const aheadFixture = repositoryFixture();
    const ahead = terminalAttempt(
      await createAttemptWorkspace(options(aheadFixture), defaultRunner),
    );
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

  it('retains preparing attempts because they have no positive terminal evidence', async () => {
    const fixture = repositoryFixture();
    const preparing = await createAttemptWorkspace(options(fixture), defaultRunner);

    await expect(cleanupAttempt(preparing.paths.manifest, defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({
      status: 'retained',
      reason: { code: 'ambiguous' },
    });
    expect(readAttemptManifest(preparing.paths.manifest).processState).toBe('preparing');
  });

  it('retains authentication failure, missing objects, malformed manifests, and escaped paths', async () => {
    const authFixture = repositoryFixture();
    const auth = terminalAttempt(
      await createAttemptWorkspace(options(authFixture), defaultRunner),
    );
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
    const missing = terminalAttempt(
      await createAttemptWorkspace(options(missingFixture), defaultRunner),
    );
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
    const malformed = terminalAttempt(
      await createAttemptWorkspace(options(malformedFixture), defaultRunner),
    );
    writeFileSync(malformed.paths.manifest, '{"version":2,"oops":true}');
    await expect(cleanupAttempt(malformed.paths.manifest, defaultRunner, {
      v2Base: join(malformedFixture.base, 'v2'),
      isPidAlive: () => false,
    })).resolves.toMatchObject({ status: 'retained', reason: { code: 'malformed' } });

    const escapedFixture = repositoryFixture();
    const escaped = terminalAttempt(
      await createAttemptWorkspace(options(escapedFixture), defaultRunner),
    );
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
    const symlinked = terminalAttempt(
      await createAttemptWorkspace(options(symlinkFixture), defaultRunner),
    );
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
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );
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
    const manifest = terminalAttempt(
      await createAttemptWorkspace(options(fixture), defaultRunner),
    );
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

  it('isolates cleanup failures so one attempt cannot abort the remaining sweep', async () => {
    const fixture = repositoryFixture();
    const failing = await createAttemptWorkspace(options(fixture, {
      pid: 100,
      host: 'same-host',
    }), defaultRunner);
    const removable = terminalAttempt(
      await createAttemptWorkspace(options(fixture, {
        runnerId: 'same-host-200-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attemptId: UUID_B,
        host: 'same-host',
      }), defaultRunner),
    );

    const results = await sweepDeadAttempts(defaultRunner, {
      v2Base: join(fixture.base, 'v2'),
      host: 'same-host',
      isPidAlive: (pid) => {
        if (pid === 100) throw new Error('injected process inspection failure');
        return false;
      },
    });

    expect(results).toEqual(expect.arrayContaining([
      {
        status: 'retained',
        attemptId: failing.attemptId,
        reason: {
          code: 'ambiguous',
          detail: 'Attempt cleanup failed unexpectedly and was isolated.',
        },
      },
      { status: 'removed', attemptId: removable.attemptId },
    ]));
    expect(readFileSync(failing.paths.manifest, 'utf8')).toContain(failing.attemptId);
    expect(() => readFileSync(removable.paths.manifest)).toThrow();
  });
});
