import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseStableVersion,
  redactSecrets,
  releaseGateSteps,
  runRelease,
  sdkReleaseTag,
} from '../scripts/lib/release-sdk.mjs';

type MockResult = {
  status?: number;
  stdout?: string;
  stderr?: string;
};
type MockOverride = MockResult | ((call: Call) => MockResult);

type Call = {
  command: string;
  args: string[];
  cwd?: string;
};

const tempDirs: string[] = [];

function mkdirp(path: string) {
  mkdirSync(path, { recursive: true });
}

function makeRoots() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'jinn-release-sdk-'));
  const sdkRoot = join(repoRoot, 'packages/sdk');
  tempDirs.push(repoRoot);
  writeSdkPackage(sdkRoot);
  return { repoRoot, sdkRoot };
}

function writeSdkPackage(sdkRoot: string, version = '0.1.0') {
  rmSync(sdkRoot, { force: true, recursive: true });
  mkdirp(sdkRoot);
  writeFileSync(
    join(sdkRoot, 'package.json'),
    `${JSON.stringify({ name: '@jinn-network/sdk', version }, null, 2)}\n`,
  );
}

function makeRunner(overrides: Record<string, MockOverride> = {}) {
  const calls: Call[] = [];
  const key = (command: string, args: string[]) => `${command} ${args.join(' ')}`;
  const commandRunner = (command: string, args: string[], options: { cwd?: string } = {}) => {
    const call = { command, args, cwd: options.cwd };
    calls.push(call);
    const exact = overrides[key(command, args)];
    if (exact) {
      const resolved = typeof exact === 'function' ? exact(call) : exact;
      return {
        status: resolved.status ?? 0,
        stdout: resolved.stdout ?? '',
        stderr: resolved.stderr ?? '',
      };
    }
    if (command === 'git' && args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
      return { status: 0, stdout: 'main\n', stderr: '' };
    }
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
      return { status: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' };
    }
    if (command === 'git' && args.join(' ') === 'status --short') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'git' && args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args.join(' ') === 'merge-base --is-ancestor origin/main HEAD') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse' && args.includes('--verify')) {
      return { status: 1, stdout: '', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-list') {
      return { status: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'ls-remote') return { status: 0, stdout: '', stderr: '' };
    if (command === 'npm' && args[0] === 'view') return { status: 1, stdout: '', stderr: 'not found' };
    if (command === 'gh' && args[0] === 'auth') return { status: 0, stdout: '', stderr: '' };
    if (command === 'gh' && args[0] === 'repo') return { status: 0, stdout: '{"nameWithOwner":"Jinn-Network/mono"}\n', stderr: '' };
    if (command === 'gh' && args[0] === 'release') return { status: 0, stdout: 'https://github.com/Jinn-Network/mono/releases/tag/sdk-v0.1.0\n', stderr: '' };
    if (command === 'gh' && args[0] === 'run') {
      return {
        status: 0,
        stdout: '[{"databaseId":1,"status":"completed","conclusion":"success","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","url":"https://github.com/Jinn-Network/mono/actions/runs/1"}]\n',
        stderr: '',
      };
    }
    if (command === 'yarn') return { status: 0, stdout: `${args.join(' ')} ok\n`, stderr: '' };
    if (command === 'node') return { status: 0, stdout: 'smoke ok\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, commandRunner };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { force: true, recursive: true });
  }
});

describe('release-sdk helpers', () => {
  it('parses stable versions and uses sdk release tags', () => {
    expect(parseStableVersion('0.1.0')?.version).toBe('0.1.0');
    expect(parseStableVersion('0.1.0-canary.abc')).toBeNull();
    expect(() => sdkReleaseTag('0.1.0-canary.abc')).toThrow(/Invalid stable SDK version/);
    expect(sdkReleaseTag('0.1.0')).toBe('sdk-v0.1.0');
  });

  it('redacts npm tokens and env-style secrets from logs', () => {
    const redacted = redactSecrets('NODE_AUTH_TOKEN=npm_secret npm_anothersecret');

    expect(redacted).not.toContain('npm_secret');
    expect(redacted).not.toContain('npm_anothersecret');
    expect(redacted).toContain('NODE_AUTH_TOKEN=[REDACTED]');
  });

  it('keeps SDK gates focused on package checks', () => {
    expect(releaseGateSteps().map((step: { id: string }) => step.id)).toEqual([
      'gate-yarn-install',
      'gate-typecheck',
      'gate-test',
      'gate-build',
      'gate-pack-smoke',
    ]);
  });
});

describe('release-sdk runner', () => {
  it('runs prepare gates in order and writes a report', async () => {
    const { repoRoot, sdkRoot } = makeRoots();
    const { calls, commandRunner } = makeRunner();

    const report = await runRelease({
      repoRoot,
      sdkRoot,
      mode: 'prepare',
      commandRunner,
      now: new Date('2026-05-02T12:00:00.000Z'),
      sleep: async () => undefined,
    });

    expect(report.status).toBe('completed');
    expect(report.version).toBe('0.1.0');
    expect(report.tag).toBe('sdk-v0.1.0');
    expect(existsSync(report.reportPath)).toBe(true);
    const yarnCalls = calls
      .filter((call) => call.command === 'yarn')
      .map((call) => call.args.join(' '));
    expect(yarnCalls).toEqual([
      'install --immutable',
      'typecheck',
      'test',
      'build',
      'pack:smoke',
    ]);
  });

  it('rejects publish when the SDK version already exists on npm', async () => {
    const { repoRoot, sdkRoot } = makeRoots();
    const { commandRunner } = makeRunner({
      'npm view @jinn-network/sdk@0.1.0 version': {
        status: 0,
        stdout: '0.1.0\n',
      },
    });

    await expect(runRelease({
      repoRoot,
      sdkRoot,
      mode: 'publish',
      commandRunner,
      now: new Date('2026-05-02T12:00:00.000Z'),
      sleep: async () => undefined,
    })).rejects.toThrow(/already exists on npm/);
  });

  it('publishes with sdk-v tags and waits only for the SDK npm workflow', async () => {
    const { repoRoot, sdkRoot } = makeRoots();
    let npmViewCalls = 0;
    const { calls, commandRunner } = makeRunner({
      'npm view @jinn-network/sdk@0.1.0 version': () => {
        npmViewCalls += 1;
        return npmViewCalls === 1
          ? { status: 1, stderr: 'not found' }
          : { status: 0, stdout: '0.1.0\n' };
      },
    });

    const report = await runRelease({
      repoRoot,
      sdkRoot,
      mode: 'publish',
      commandRunner,
      now: new Date('2026-05-02T12:00:00.000Z'),
      sleep: async () => undefined,
      workflowPollMs: 1,
      workflowTimeoutMs: 1000,
    });

    expect(report.status).toBe('completed');
    expect(calls.some((call) => call.command === 'git' && call.args.join(' ') === 'tag sdk-v0.1.0')).toBe(true);
    expect(calls.some((call) => call.command === 'git' && call.args.join(' ') === 'push origin sdk-v0.1.0')).toBe(true);
    expect(calls.some((call) => call.command === 'gh' && call.args.includes('sdk-v0.1.0'))).toBe(true);
    const workflowCalls = calls.filter((call) => call.command === 'gh' && call.args[0] === 'run');
    expect(workflowCalls).toHaveLength(1);
    expect(workflowCalls[0]?.args).toContain('sdk-npm-publish.yml');
    expect(calls.some((call) =>
      call.command === 'node' &&
      call.args.join(' ') === 'scripts/smoke-test-pack.mjs @jinn-network/sdk@0.1.0',
    )).toBe(true);
  });

  it('resumes publish after local tag creation when the tag points at the release commit', async () => {
    const { repoRoot, sdkRoot } = makeRoots();
    const first = makeRunner({
      'git push origin sdk-v0.1.0': { status: 1, stderr: 'network failed' },
    });

    const failed = await runRelease({
      repoRoot,
      sdkRoot,
      mode: 'publish',
      commandRunner: first.commandRunner,
      now: new Date('2026-05-02T12:00:00.000Z'),
      sleep: async () => undefined,
    }).catch((err) => err);
    expect(String(failed.message)).toContain('push sdk-v0.1.0');

    let npmViewCalls = 0;
    const second = makeRunner({
      'git rev-parse -q --verify refs/tags/sdk-v0.1.0': {
        status: 0,
        stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
      },
      'git rev-list -n 1 sdk-v0.1.0': {
        status: 0,
        stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
      },
      'npm view @jinn-network/sdk@0.1.0 version': () => {
        npmViewCalls += 1;
        return npmViewCalls === 1
          ? { status: 1, stderr: 'not found' }
          : { status: 0, stdout: '0.1.0\n' };
      },
    });

    const resumed = await runRelease({
      repoRoot,
      sdkRoot,
      mode: 'publish',
      resumeDir: failed.step.stdoutPath.split('/logs/')[0],
      commandRunner: second.commandRunner,
      now: new Date('2026-05-02T12:05:00.000Z'),
      sleep: async () => undefined,
      workflowPollMs: 1,
      workflowTimeoutMs: 1000,
    });

    expect(resumed.status).toBe('completed');
    expect(second.calls.some((call) => call.command === 'git' && call.args.join(' ') === 'tag sdk-v0.1.0')).toBe(false);
    expect(second.calls.some((call) => call.command === 'git' && call.args.join(' ') === 'push origin sdk-v0.1.0')).toBe(true);
  });
});
