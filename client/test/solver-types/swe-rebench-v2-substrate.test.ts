import { describe, it, expect, vi } from 'vitest';
import {
  computeRowHash,
  resolveImageDigest,
  resolveUpstreamEvalCommit,
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
});

describe('resolveImageDigest', () => {
  it('returns the digest portion (after `@`) of the first RepoDigests entry', async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: '["myimg@sha256:abc123def456"]',
      stderr: '',
    });
    const digest = await resolveImageDigest('myimg:latest', runner);
    expect(digest).toBe('sha256:abc123def456');
    expect(runner).toHaveBeenCalledWith('docker', [
      'image', 'inspect', 'myimg:latest', '--format', '{{json .RepoDigests}}',
    ]);
  });

  it('returns null when docker exits non-zero', async () => {
    const runner = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'no such image' });
    expect(await resolveImageDigest('missing:latest', runner)).toBeNull();
  });

  it('returns null when RepoDigests is empty', async () => {
    const runner = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' });
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
    expect(runner).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], { cwd: '/path/to/upstream' });
  });

  it('returns null when git fails', async () => {
    const runner = vi.fn().mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'not a git repo' });
    expect(await resolveUpstreamEvalCommit('/not/a/repo', runner)).toBeNull();
  });
});
