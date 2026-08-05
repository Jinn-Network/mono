import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommandTimeoutError,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_DOCKER_PULL_TIMEOUT_MS,
  computeRowHash,
  defaultCommandRunner,
  pullDigestQualifiedImage,
  resolveCommandTimeoutMs,
  resolveDockerPullTimeoutMs,
  resolveImageDigest,
  resolveImagePlatform,
  resolveUpstreamEvalCommit,
  type CommandRunner,
} from '../../src/solver-types/_swe-rebench-v2-substrate.js';

function basicArgs() {
  return {
    hf_dataset: 'd', hf_split: 's', instance_id: 'i', repo: 'r', base_commit: 'c',
    image_name: 'img', patch: 'p', test_patch: 'tp',
    install_config: { install: ['x'], test_cmd: ['y'], log_parser: 'parse_log_pytest' },
    FAIL_TO_PASS: ['a'], PASS_TO_PASS: ['b'],
  };
}

describe('computeRowHash', () => {
  it('is deterministic over field reorderings of the same input', () => {
    const a = computeRowHash({
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      instance_id: 'x__1',
      repo: 'acme/widget',
      base_commit: 'deadbeef',
      image_name: 'img:latest',
      patch: 'diff a',
      test_patch: 'diff b',
      install_config: { install: ['pip install .'], test_cmd: ['pytest'], log_parser: 'parse_log_pytest' },
      FAIL_TO_PASS: ['t::a', 't::b'],
      PASS_TO_PASS: ['t::c'],
    });
    const b = computeRowHash({
      // same data, different key order
      PASS_TO_PASS: ['t::c'],
      FAIL_TO_PASS: ['t::a', 't::b'],
      install_config: { log_parser: 'parse_log_pytest', test_cmd: ['pytest'], install: ['pip install .'] },
      test_patch: 'diff b',
      patch: 'diff a',
      image_name: 'img:latest',
      base_commit: 'deadbeef',
      repo: 'acme/widget',
      instance_id: 'x__1',
      hf_split: '2026_02',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
    });
    expect(a).toEqual(b);
  });

  it('changes when any covered field changes', () => {
    const base = computeRowHash(basicArgs());
    expect(base).not.toEqual(computeRowHash({ ...basicArgs(), image_name: 'OTHER' }));
    expect(base).not.toEqual(computeRowHash({ ...basicArgs(), patch: 'p2' }));
    expect(base).not.toEqual(computeRowHash({ ...basicArgs(), FAIL_TO_PASS: ['z'] }));
  });

  it('has a sha256: prefix and 64-hex-char body', () => {
    expect(computeRowHash(basicArgs())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('treats array element order as significant', () => {
    const a = computeRowHash({ ...basicArgs(), FAIL_TO_PASS: ['t::a', 't::b'] });
    const b = computeRowHash({ ...basicArgs(), FAIL_TO_PASS: ['t::b', 't::a'] });
    expect(a).not.toEqual(b);
  });
});

describe('resolveImageDigest', () => {
  it('returns the digest portion (after `@`) of the first RepoDigests entry', async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '["myimg@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456ab12"]',
      stderr: '',
    });
    const digest = await resolveImageDigest('myimg:latest', runner);
    expect(digest).toBe('sha256:abc123def456abc123def456abc123def456abc123def456abc123def456ab12');
    expect(runner).toHaveBeenCalledWith('docker', [
      'image', 'inspect', 'myimg:latest', '--format', '{{json .RepoDigests}}',
    ], { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS });
  });

  it('returns null when docker exits non-zero', async () => {
    const runner = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'no such image' });
    expect(await resolveImageDigest('missing:latest', runner)).toBeNull();
  });

  it('returns null when RepoDigests is empty', async () => {
    const runner = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' });
    expect(await resolveImageDigest('myimg:latest', runner)).toBeNull();
  });

  it('returns null when the digest after `@` is malformed', async () => {
    const runner = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '["myimg@notadigest"]', stderr: '' });
    expect(await resolveImageDigest('myimg:latest', runner)).toBeNull();
  });
});

describe('resolveUpstreamEvalCommit', () => {
  it('returns the trimmed rev-parse output', async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '0123456789abcdef0123456789abcdef01234567\n',
      stderr: '',
    });
    const sha = await resolveUpstreamEvalCommit('/path/to/upstream', runner);
    expect(sha).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(runner).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], {
      cwd: '/path/to/upstream',
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    });
  });

  it('returns null when git fails', async () => {
    const runner = vi.fn().mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'not a git repo' });
    expect(await resolveUpstreamEvalCommit('/not/a/repo', runner)).toBeNull();
  });
});

/**
 * A wedged Docker daemon makes `docker image inspect` / `docker rmi` never
 * return. Before these bounds existed, every shell-out here resolved only on
 * child `close`/`error`, so one wedged daemon hung a whole run indefinitely
 * (observed: a `run-pilot` stuck >10h, leaving stale attempt records behind).
 */
describe('command timeouts', () => {
  /** Stands in for a shell-out against a wedged daemon: it simply never settles. */
  const neverResolves: CommandRunner = () => new Promise<never>(() => {});
  const DIGEST_REF = `img@sha256:${'a'.repeat(64)}`;
  const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

  afterEach(() => {
    delete process.env['JINN_SWE_REBENCH_COMMAND_TIMEOUT_MS'];
    delete process.env['JINN_SWE_REBENCH_DOCKER_PULL_TIMEOUT_MS'];
    vi.restoreAllMocks();
  });

  describe('resolveCommandTimeoutMs / resolveDockerPullTimeoutMs', () => {
    it('prefers the explicit option over the env var', () => {
      process.env['JINN_SWE_REBENCH_COMMAND_TIMEOUT_MS'] = '999';
      expect(resolveCommandTimeoutMs(1234)).toBe(1234);
    });

    it('falls back to the env var, then to the default', () => {
      expect(resolveCommandTimeoutMs()).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
      process.env['JINN_SWE_REBENCH_COMMAND_TIMEOUT_MS'] = '4321';
      expect(resolveCommandTimeoutMs()).toBe(4321);
    });

    it('bounds `docker pull` separately and far more generously', () => {
      expect(resolveDockerPullTimeoutMs()).toBe(DEFAULT_DOCKER_PULL_TIMEOUT_MS);
      expect(DEFAULT_DOCKER_PULL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_COMMAND_TIMEOUT_MS);
      process.env['JINN_SWE_REBENCH_DOCKER_PULL_TIMEOUT_MS'] = '77';
      expect(resolveDockerPullTimeoutMs()).toBe(77);
      // The two knobs are independent.
      expect(resolveCommandTimeoutMs()).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    });

    it('accepts an explicit 0 as "disabled"', () => {
      expect(resolveCommandTimeoutMs(0)).toBe(0);
      process.env['JINN_SWE_REBENCH_COMMAND_TIMEOUT_MS'] = '0';
      expect(resolveCommandTimeoutMs()).toBe(0);
    });

    it('treats an empty env value as unset, not as disabled', () => {
      process.env['JINN_SWE_REBENCH_COMMAND_TIMEOUT_MS'] = '';
      expect(resolveCommandTimeoutMs()).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
    });

    it('warns and uses the default for a non-numeric env value', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env['JINN_SWE_REBENCH_COMMAND_TIMEOUT_MS'] = 'forever';
      expect(resolveCommandTimeoutMs()).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('JINN_SWE_REBENCH_COMMAND_TIMEOUT_MS'),
      );
    });
  });

  describe('helpers bound an injected runner', () => {
    it('rejects resolveImageDigest with CommandTimeoutError', async () => {
      await expect(resolveImageDigest('img:latest', neverResolves, 25))
        .rejects.toBeInstanceOf(CommandTimeoutError);
    });

    it('rejects resolveImagePlatform with CommandTimeoutError', async () => {
      await expect(resolveImagePlatform('img:latest', neverResolves, 25))
        .rejects.toBeInstanceOf(CommandTimeoutError);
    });

    it('rejects pullDigestQualifiedImage with CommandTimeoutError', async () => {
      await expect(pullDigestQualifiedImage(DIGEST_REF, neverResolves, 25))
        .rejects.toBeInstanceOf(CommandTimeoutError);
    });

    it('rejects resolveUpstreamEvalCommit with CommandTimeoutError', async () => {
      await expect(resolveUpstreamEvalCommit('/repo', neverResolves, 25))
        .rejects.toBeInstanceOf(CommandTimeoutError);
    });

    it('carries the command and bound on the error, so a caller can tell it from a Docker failure', async () => {
      const err = await resolveImageDigest('img:latest', neverResolves, 25).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommandTimeoutError);
      const timeout = err as CommandTimeoutError;
      expect(timeout.name).toBe('CommandTimeoutError');
      expect(timeout.bin).toBe('docker');
      expect(timeout.args).toContain('inspect');
      expect(timeout.timeoutMs).toBe(25);
      // A real Docker failure is a resolved non-zero exit, never this error.
      expect(await resolveImageDigest('img:latest', async () => ({
        exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon',
      }))).toBeNull();
    });

    it('does not bound the call when the timeout is 0', async () => {
      const slow: CommandRunner = async () => {
        await delay(40);
        return { exitCode: 0, stdout: '["myimg@sha256:' + 'b'.repeat(64) + '"]', stderr: '' };
      };
      expect(await resolveImageDigest('img:latest', slow, 0)).toBe(`sha256:${'b'.repeat(64)}`);
    });
  });

  describe('defaultCommandRunner', () => {
    it('rejects with CommandTimeoutError when the child outlives the bound', async () => {
      await expect(defaultCommandRunner(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { timeoutMs: 100 },
      )).rejects.toBeInstanceOf(CommandTimeoutError);
    });

    it('kills the child instead of leaking it', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'swe-rebench-substrate-timeout-'));
      const beat = join(dir, 'beat');
      try {
        await expect(defaultCommandRunner(
          process.execPath,
          [
            '-e',
            `const fs = require('fs');` +
              `setInterval(() => fs.appendFileSync(${JSON.stringify(beat)}, 'x'), 20);`,
          ],
          { timeoutMs: 200 },
        )).rejects.toBeInstanceOf(CommandTimeoutError);
        // The child heartbeats every 20ms; once killed, the file stops growing.
        await delay(400);
        const sizeAfterKill = statSync(beat).size;
        await delay(400);
        expect(statSync(beat).size).toBe(sizeAfterKill);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('still resolves normally for a command that finishes inside the bound', async () => {
      const res = await defaultCommandRunner(
        process.execPath,
        ['-e', 'process.stdout.write("ok")'],
        { timeoutMs: 30_000 },
      );
      expect(res).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    });
  });
});
