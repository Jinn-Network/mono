import { describe, it, expect } from 'vitest';
import { prepareBaseCheckout, recoverPatch, GitStepError, type CmdRunner } from '../../src/pilot/repo.js';

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
});
