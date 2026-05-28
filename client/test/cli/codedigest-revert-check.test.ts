import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodedigestRevertCheckCommand } from '../../src/cli/commands/codedigest-revert-check.js';

function ctx(argv: string[]) {
  const out: string[] = [];
  return {
    ctx: {
      argv,
      stdoutIsTty: false,
      writer: { write: (s: string) => { out.push(s); return true; } },
      exit: vi.fn(),
      env: {},
    },
    out,
  };
}

describe('jinn codedigest-revert-check', () => {
  it('emits recommendRevert=true for a significant regression', async () => {
    const cmd = createCodedigestRevertCheckCommand({
      buildDiscovery: () => ({
        getCodeDigestRewards: async () => [
          { codeDigest: 'sha256:CHILD', attempts: 100, passes: 40, passRate: 0.4, avgScore: 0.4 },
          { codeDigest: 'sha256:PARENT', attempts: 100, passes: 80, passRate: 0.8, avgScore: 0.8 },
        ],
      }) as never,
    });
    const { ctx: c, out } = ctx(['--code-digest', 'sha256:CHILD', '--parent-code-digest', 'sha256:PARENT', '--json']);
    await cmd.run(c as never);
    const payload = JSON.parse(out.join(''));
    expect(payload.recommendRevert).toBe(true);
    expect(payload.reason).toBe('significant_regression');
  });

  it('emits recommendRevert=false reason=insufficient_samples when a digest has no aggregate', async () => {
    const cmd = createCodedigestRevertCheckCommand({
      buildDiscovery: () => ({
        getCodeDigestRewards: async () => [
          { codeDigest: 'sha256:PARENT', attempts: 100, passes: 80, passRate: 0.8, avgScore: 0.8 },
        ], // CHILD absent => zero attempts
      }) as never,
    });
    const { ctx: c, out } = ctx(['--code-digest', 'sha256:CHILD', '--parent-code-digest', 'sha256:PARENT', '--json']);
    await cmd.run(c as never);
    const payload = JSON.parse(out.join(''));
    expect(payload.recommendRevert).toBe(false);
    expect(payload.reason).toBe('insufficient_samples');
  });

  it('emits recommendRevert=false on DiscoveryUnavailableError (skip reverts on degraded data)', async () => {
    const { DiscoveryUnavailableError } = await import('../../src/discovery/types.js');
    const cmd = createCodedigestRevertCheckCommand({
      buildDiscovery: () => ({
        getCodeDigestRewards: async () => { throw new DiscoveryUnavailableError('down'); },
      }) as never,
    });
    const { ctx: c, out } = ctx(['--code-digest', 'sha256:CHILD', '--parent-code-digest', 'sha256:PARENT', '--json']);
    await cmd.run(c as never);
    const payload = JSON.parse(out.join(''));
    expect(payload.recommendRevert).toBe(false);
    expect(payload.reason).toBe('discovery_unavailable');
  });

  it('hashes impl-state-dir commits directly and queries those two codeDigests (#764 Task 12)', async () => {
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const repo = mkdtempSync(join(tmpdir(), 'cli-implstate-'));
    try {
      git(repo, 'init', '--initial-branch=main', '--quiet');
      git(repo, 'config', 'user.email', 'test@example.invalid');
      git(repo, 'config', 'user.name', 'test');
      mkdirSync(join(repo, 'skills'), { recursive: true });
      writeFileSync(join(repo, 'skills', 'base.md'), 'base', 'utf8');
      git(repo, 'add', '-A'); git(repo, 'commit', '--quiet', '-m', 'init');
      const parentSha = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, 'skills', 'a.md'), 'change-a', 'utf8');
      git(repo, 'add', '-A'); git(repo, 'commit', '--quiet', '-m', 'improve: a');
      const commitSha = git(repo, 'rev-parse', 'HEAD');

      const seenDigests: string[] = [];
      const cmd = createCodedigestRevertCheckCommand({
        buildDiscovery: () => ({
          getCodeDigestRewards: async (args: { codeDigests: string[] }) => {
            seenDigests.push(...args.codeDigests);
            return [];
          },
        }) as never,
      });
      const { ctx: c, out } = ctx([
        '--impl-state-dir', repo,
        '--commit', commitSha,
        '--parent', parentSha,
        '--json',
      ]);
      await cmd.run(c as never);

      expect(seenDigests).toHaveLength(2);
      expect(new Set(seenDigests).size).toBe(2); // distinct codeDigests
      for (const d of seenDigests) expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
      const payload = JSON.parse(out.join(''));
      expect(payload.recommendRevert).toBe(false);
      expect(payload.reason).toBe('insufficient_samples'); // no aggregates
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
