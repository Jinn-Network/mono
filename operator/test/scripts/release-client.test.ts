import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clientReleaseTag,
  parseStableVersion,
  redactSecrets,
  releaseGateSteps,
  REQUIRED_SDK_VERSION,
  runRelease,
} from '../../scripts/lib/release-client.mjs';

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

function makeRoots() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'jinn-release-client-'));
  const clientRoot = join(repoRoot, 'operator');
  tempDirs.push(repoRoot);
  rmSync(clientRoot, { force: true, recursive: true });
  writeFileSync(join(repoRoot, '.placeholder'), '');
  return { repoRoot, clientRoot };
}

function writeClientPackage(clientRoot: string, version = '1.2.3') {
  rmSync(clientRoot, { force: true, recursive: true });
  mkdirp(clientRoot);
  writeFileSync(
    join(clientRoot, 'package.json'),
    `${JSON.stringify({ name: '@jinn-network/operator', version }, null, 2)}\n`,
  );
}

function mkdirp(path: string) {
  mkdirSync(path, { recursive: true });
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
    if (command === 'npm' && args.join(' ') === `view @jinn-network/sdk@${REQUIRED_SDK_VERSION} version`) {
      return { status: 0, stdout: `${REQUIRED_SDK_VERSION}\n`, stderr: '' };
    }
    if (command === 'npm' && args[0] === 'view') return { status: 1, stdout: '', stderr: 'not found' };
    if (command === 'gh' && args[0] === 'auth') return { status: 0, stdout: '', stderr: '' };
    if (command === 'gh' && args[0] === 'repo') return { status: 0, stdout: '{"nameWithOwner":"Jinn-Network/mono"}\n', stderr: '' };
    if (command === 'gh' && args[0] === 'release') return { status: 0, stdout: 'https://github.com/Jinn-Network/mono/releases/tag/client-v1.2.3\n', stderr: '' };
    if (command === 'gh' && args[0] === 'run') {
      return {
        status: 0,
        stdout: '[{"databaseId":1,"status":"completed","conclusion":"success","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","url":"https://github.com/Jinn-Network/mono/actions/runs/1"}]\n',
        stderr: '',
      };
    }
    if (command === 'docker' && args[0] === 'version') return { status: 0, stdout: '26.1.0\n', stderr: '' };
    if (command === 'docker' && args[0] === 'run') return { status: 0, stdout: '{"schemaVersion":1}\n', stderr: '' };
    if (command === 'npx') return { status: 0, stdout: '{"schemaVersion":1}\n', stderr: '' };
    if (command === 'yarn') return { status: 0, stdout: `${args.join(' ')} ok\n`, stderr: '' };
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

describe('release-client helpers', () => {
  it('parses stable versions and rejects prereleases', () => {
    expect(parseStableVersion('1.2.3')?.version).toBe('1.2.3');
    expect(parseStableVersion('1.2.3-canary.abc')).toBeNull();
    expect(() => clientReleaseTag('1.2.3-canary.abc')).toThrow(/Invalid stable client version/);
    expect(clientReleaseTag('1.2.3')).toBe('client-v1.2.3');
  });

  it('redacts Claude tokens and env-style secrets from logs', () => {
    const redacted = redactSecrets(
      'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-secret JINN_PASSWORD=hunter2 sk-ant-oat01-other',
    );

    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('sk-ant-oat01-secret');
    expect(redacted).toContain('CLAUDE_CODE_OAUTH_TOKEN=[REDACTED]');
    expect(redacted).toContain('JINN_PASSWORD=[REDACTED]');
  });

  it('bootstraps the Docker acceptance operator during release gates', () => {
    const setup = releaseGateSteps(false).find((step: { id: string }) => step.id === 'gate-acceptance-setup');

    expect(setup?.args).toEqual(['setup:testnet-acceptance-operator', '--bootstrap']);
  });

  it('includes olas-rails-smoke as a non-skipped release gate', () => {
    const steps = releaseGateSteps(false).map((step: { id: string; args: string[] }) => step);
    const olasRailsSmoke = steps.find((step) => step.id === 'gate-olas-rails-smoke');

    expect(olasRailsSmoke?.args).toEqual(['release:olas-rails-smoke']);
    expect(releaseGateSteps(true).some((step: { id: string }) => step.id === 'gate-olas-rails-smoke')).toBe(false);
  });

  it('derives REQUIRED_SDK_VERSION from the sdk manifest instead of a pinned literal', () => {
    // A pinned literal here has the identical failure mode as the workflow
    // literals it sits alongside (marketplace-surfaces design §6 R1): a
    // stable client release would refuse or mispin the moment the sdk
    // version bumps. Guard both the source shape and the runtime value.
    const source = readFileSync(
      new URL('../../scripts/lib/release-client.mjs', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/REQUIRED_SDK_VERSION\s*=\s*['"`]\d+\.\d+\.\d+/);
    expect(source).toMatch(/'packages',\s*'sdk',\s*'package\.json'/);

    const sdkPackageJson = JSON.parse(
      readFileSync(new URL('../../../packages/sdk/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(REQUIRED_SDK_VERSION).toBe(sdkPackageJson.version);
  });
});

describe('release-client runner', () => {
  it('runs prepare gates in order and writes a report', async () => {
    const { repoRoot, clientRoot } = makeRoots();
    writeClientPackage(clientRoot);
    const { calls, commandRunner } = makeRunner();

    const report = await runRelease({
      repoRoot,
      clientRoot,
      mode: 'prepare',
      skipAcceptance: true,
      commandRunner,
      now: new Date('2026-04-26T12:00:00.000Z'),
      sleep: async () => undefined,
    });

    expect(report.status).toBe('completed');
    expect(report.version).toBe('1.2.3');
    expect(report.tag).toBe('client-v1.2.3');
    expect(report.sdkVerification).toEqual({
      package: '@jinn-network/sdk',
      version: REQUIRED_SDK_VERSION,
    });
    expect(report.consumerGate).toEqual({
      mode: 'local',
      sdkVersion: REQUIRED_SDK_VERSION,
      stepId: 'gate-pack-smoke',
    });
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
      'install --immutable',
      'release:operator-gate',
      'test',
    ]);
    const contractsInstallIndex = calls.findIndex((call) =>
      call.command === 'yarn' &&
      call.args.join(' ') === 'install --immutable' &&
      call.cwd?.endsWith('/contracts'),
    );
    const operatorGateIndex = calls.findIndex((call) =>
      call.command === 'yarn' &&
      call.args.join(' ') === 'release:operator-gate',
    );
    expect(contractsInstallIndex).toBeGreaterThan(-1);
    expect(operatorGateIndex).toBeGreaterThan(contractsInstallIndex);
    const forgeCalls = calls
      .filter((call) => call.command === 'forge')
      .map((call) => call.args.join(' '));
    expect(forgeCalls).toEqual([
      'test --match-contract Invariant',
    ]);
    expect(calls.some((call) =>
      call.command === 'node' &&
      call.args.join(' ') === '../operator/scripts/ensure-forge-std.mjs' &&
      call.cwd?.endsWith('/contracts'),
    )).toBe(true);
    expect(calls.some((call) =>
      call.command === 'yarn' &&
      call.args.join(' ') === 'test' &&
      call.cwd?.endsWith('/contracts'),
    )).toBe(true);
  });

  it('fails before release gates until the manifest-derived SDK version exists on npm', async () => {
    const { repoRoot, clientRoot } = makeRoots();
    writeClientPackage(clientRoot);
    const { calls, commandRunner } = makeRunner({
      [`npm view @jinn-network/sdk@${REQUIRED_SDK_VERSION} version`]: {
        status: 1,
        stderr: 'npm error E404',
      },
    });

    await expect(runRelease({
      repoRoot,
      clientRoot,
      mode: 'prepare',
      skipAcceptance: true,
      commandRunner,
      now: new Date('2026-04-26T12:00:00.000Z'),
      sleep: async () => undefined,
    })).rejects.toThrow(new RegExp(`@jinn-network/sdk@${REQUIRED_SDK_VERSION.replace(/\./g, '\\.')}`));

    expect(calls.some((call) => call.command === 'yarn')).toBe(false);
  });

  it('fails before gates when HEAD is behind origin/main', async () => {
    const { repoRoot, clientRoot } = makeRoots();
    writeClientPackage(clientRoot);
    const { calls, commandRunner } = makeRunner({
      'git merge-base --is-ancestor origin/main HEAD': {
        status: 1,
        stderr: 'not ancestor',
      },
    });

    await expect(runRelease({
      repoRoot,
      clientRoot,
      mode: 'prepare',
      skipAcceptance: true,
      commandRunner,
      now: new Date('2026-04-26T12:00:00.000Z'),
      sleep: async () => undefined,
    })).rejects.toThrow(/HEAD is not behind origin\/main|preflight-not-behind-main|verify HEAD/);

    expect(calls.some((call) => call.command === 'yarn')).toBe(false);
  });

  it('skips successful steps when resuming a report', async () => {
    const { repoRoot, clientRoot } = makeRoots();
    writeClientPackage(clientRoot);
    const first = makeRunner();
    const firstReport = await runRelease({
      repoRoot,
      clientRoot,
      mode: 'prepare',
      skipAcceptance: true,
      commandRunner: first.commandRunner,
      now: new Date('2026-04-26T12:00:00.000Z'),
      sleep: async () => undefined,
    });
    const second = makeRunner();

    const resumed = await runRelease({
      repoRoot,
      clientRoot,
      mode: 'prepare',
      resumeDir: firstReport.reportDir,
      skipAcceptance: true,
      commandRunner: second.commandRunner,
      now: new Date('2026-04-26T12:05:00.000Z'),
      sleep: async () => undefined,
    });

    expect(resumed.status).toBe('completed');
    expect(second.calls.some((call) => call.command === 'yarn')).toBe(false);
    const saved = JSON.parse(readFileSync(firstReport.reportPath, 'utf8'));
    expect(saved.steps.some((step: { id: string }) => step.id === 'gate-build')).toBe(true);
  });

  it('rejects publish when acceptance is skipped', async () => {
    const { repoRoot, clientRoot } = makeRoots();
    writeClientPackage(clientRoot);
    const { commandRunner } = makeRunner();

    await expect(runRelease({
      repoRoot,
      clientRoot,
      mode: 'publish',
      skipAcceptance: true,
      commandRunner,
      now: new Date('2026-04-26T12:00:00.000Z'),
      sleep: async () => undefined,
    })).rejects.toThrow(/skip-acceptance.*publish/i);
  });

  it('allows command-flow validation on an already-published version when acceptance is skipped', async () => {
    const { repoRoot, clientRoot } = makeRoots();
    writeClientPackage(clientRoot);
    const { calls, commandRunner } = makeRunner({
      'git rev-parse -q --verify refs/tags/client-v1.2.3': {
        status: 0,
        stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
      },
      'git ls-remote --tags origin refs/tags/client-v1.2.3': {
        status: 0,
        stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/client-v1.2.3\n',
      },
      'npm view @jinn-network/operator@1.2.3 version': {
        status: 0,
        stdout: '1.2.3\n',
      },
    });

    const report = await runRelease({
      repoRoot,
      clientRoot,
      mode: 'prepare',
      skipAcceptance: true,
      commandRunner,
      now: new Date('2026-04-26T12:00:00.000Z'),
      sleep: async () => undefined,
    });

    expect(report.status).toBe('completed');
    expect(calls.some((call) => call.command === 'yarn' && call.args.join(' ') === 'release:operator-gate')).toBe(true);
    expect(calls.some((call) => call.command === 'yarn' && call.args.join(' ') === 'release:olas-rails-smoke')).toBe(false);
  });

  it('resumes publish after local tag creation when the tag points at the release commit', async () => {
    const { repoRoot, clientRoot } = makeRoots();
    writeClientPackage(clientRoot);
    writeFileSync(join(clientRoot, '.env.acceptance'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test-token\n');
    const first = makeRunner({
      'git push origin client-v1.2.3': { status: 1, stderr: 'network failed' },
    });

    const failed = await runRelease({
      repoRoot,
      clientRoot,
      mode: 'publish',
      commandRunner: first.commandRunner,
      now: new Date('2026-04-26T12:00:00.000Z'),
      sleep: async () => undefined,
    }).catch((err) => err);
    expect(String(failed.message)).toContain('push client-v1.2.3');

    let npmViewCalls = 0;
    const second = makeRunner({
      'git rev-parse -q --verify refs/tags/client-v1.2.3': {
        status: 0,
        stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
      },
      'git rev-list -n 1 client-v1.2.3': {
        status: 0,
        stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
      },
      'npm view @jinn-network/operator@1.2.3 version': () => {
        npmViewCalls += 1;
        return npmViewCalls === 1
          ? { status: 1, stderr: 'not found' }
          : { status: 0, stdout: '1.2.3\n' };
      },
    });

    const resumed = await runRelease({
      repoRoot,
      clientRoot,
      mode: 'publish',
      resumeDir: failed.step.stdoutPath.split('/logs/')[0],
      commandRunner: second.commandRunner,
      now: new Date('2026-04-26T12:05:00.000Z'),
      sleep: async () => undefined,
      workflowPollMs: 1,
      workflowTimeoutMs: 1000,
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.consumerGate).toEqual({
      mode: 'registry',
      sdkVersion: REQUIRED_SDK_VERSION,
      clientVersion: '1.2.3',
      stepId: 'verify-external-consumer',
    });
    expect(second.calls.some((call) => call.command === 'git' && call.args.join(' ') === 'tag client-v1.2.3')).toBe(false);
    expect(second.calls.some((call) => call.command === 'git' && call.args.join(' ') === 'push origin client-v1.2.3')).toBe(true);
  });
});
