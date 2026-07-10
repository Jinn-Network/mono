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

  it('prepareBaseCheckout FAILS LOUD on a non-zero checkout (unfetchable base_commit)', async () => {
    const { run, calls } = fakeRunner([{ exitCode: 0 }, { stderr: 'fatal: reference is not a tree', exitCode: 128 }]);
    const err = await prepareBaseCheckout(run, 'a/b', 'deadbeef', '/tmp/base').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitStepError);
    expect((err as GitStepError).step).toBe('checkout');
    expect(calls).toHaveLength(2);
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
