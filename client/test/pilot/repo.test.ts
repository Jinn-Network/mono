import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPilotWorkDir, prepareBaseCheckout, recoverPatch, GitStepError, type CmdRunner } from '../../src/pilot/repo.js';

/** A scripted fake runner: returns the queued result per call and records args. */
function fakeRunner(script: Array<{ stdout?: string; stderr?: string; exitCode: number }>): {
  run: CmdRunner;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let i = 0;
  const run: CmdRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = script[i++] ?? { exitCode: 0 };
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
  };
  return { run, calls };
}

describe('pilot repo helpers', () => {
  it('prepareBaseCheckout FAILS LOUD on a non-zero clone (ungradeable instance, not a scored fail) and never attempts checkout', async () => {
    const { run, calls } = fakeRunner([{ stderr: 'fatal: repository not found', exitCode: 128 }]);
    await expect(prepareBaseCheckout(run, 'ghost/missing', 'abc123', '/tmp/base')).rejects.toBeInstanceOf(GitStepError);
    // clone only — checkout is skipped, so no empty repo is left for the arms to "solve".
    expect(calls).toEqual([{ cmd: 'git', args: ['clone', 'https://github.com/ghost/missing.git', '/tmp/base'] }]);
  });

  it('prepareBaseCheckout recovers a ref-unreachable base_commit via fetch-by-sha, then checks out', async () => {
    // Upstream history rewrites leave dataset base commits unreachable from
    // any ref: a plain clone lacks them ("unable to read tree"), but GitHub
    // still serves them to an explicit fetch-by-sha (sqlglot-4563/-4618).
    const { run, calls } = fakeRunner([
      { exitCode: 0 },                                                        // clone
      { stderr: 'fatal: unable to read tree (795e7e0e…)', exitCode: 128 },    // checkout misses
      { exitCode: 0 },                                                        // fetch origin <sha>
      { exitCode: 0 },                                                        // retry checkout
    ]);
    await expect(prepareBaseCheckout(run, 'tobymao/sqlglot', '795e7e0e', '/tmp/base')).resolves.toBeUndefined();
    expect(calls[2]!.args).toEqual(['fetch', 'origin', '795e7e0e']);
    expect(calls[3]!.args).toEqual(['checkout', '795e7e0e']);
  });

  it('prepareBaseCheckout FAILS LOUD when the base_commit is unfetchable even by sha', async () => {
    const { run, calls } = fakeRunner([
      { exitCode: 0 },                                                          // clone
      { stderr: 'fatal: reference is not a tree', exitCode: 128 },              // checkout misses
      { stderr: 'fatal: remote error: upload-pack: not our ref', exitCode: 128 }, // fetch-by-sha refused
    ]);
    const err = await prepareBaseCheckout(run, 'a/b', 'deadbeef', '/tmp/base').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitStepError);
    expect((err as GitStepError).step).toBe('checkout');
    expect(calls).toHaveLength(3);
  });

  it('prepareBaseCheckout resolves when both git steps exit 0', async () => {
    const { run } = fakeRunner([{ exitCode: 0 }, { exitCode: 0 }]);
    await expect(prepareBaseCheckout(run, 'a/b', 'c0ffee', '/tmp/base')).resolves.toBeUndefined();
  });

  it('recoverPatch stages untracked files (git add -A → git diff --cached) so a new-file fix is not an empty patch', async () => {
    const { run, calls } = fakeRunner([
      { exitCode: 0 },
      { stdout: 'diff --git a/new_module.py b/new_module.py\nnew file mode 100644\n', exitCode: 0 },
    ]);
    const patch = await recoverPatch(run, '/tmp/arm');
    expect(patch).toContain('new file mode');
    expect(calls[0]!.args).toEqual(['add', '-A']);
    expect(calls[1]!.args).toEqual(['diff', '--cached']);
  });

  it('recoverPatch applies the production SWE-rebench sanitizer to remove model-authored test hunks', async () => {
    const rawPatch = [
      'diff --git a/src/fix.py b/src/fix.py',
      '--- a/src/fix.py',
      '+++ b/src/fix.py',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/tests/test_fix.py b/tests/test_fix.py',
      '--- a/tests/test_fix.py',
      '+++ b/tests/test_fix.py',
      '@@ -1 +1 @@',
      '-old test',
      '+new test',
      '',
    ].join('\n');
    const { run } = fakeRunner([{ exitCode: 0 }, { stdout: rawPatch, exitCode: 0 }]);

    const patch = await recoverPatch(run, '/tmp/arm');

    expect(patch).toContain('src/fix.py');
    expect(patch).not.toContain('tests/test_fix.py');
  });

  it('creates live solver checkouts under the durable pilot output directory', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pilot-work-root-'));
    try {
      const workDir = await createPilotWorkDir(outDir, 'solve-stock-0-');
      expect(workDir.startsWith(join(outDir, 'work'))).toBe(true);
      expect(existsSync(workDir)).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
