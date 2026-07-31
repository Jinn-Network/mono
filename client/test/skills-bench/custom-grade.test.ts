import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CmdRunner } from '../../src/pilot/repo.js';
import type { SkillTaskV1 } from '../../src/skills-bench/task-set.js';
import { runCustomGrade, CustomGradeError, DEFAULT_CUSTOM_GRADE_TIMEOUT_MS } from '../../src/skills-bench/custom-grade.js';

type FakeResult = { exitCode: number; stdout?: string; stderr?: string };
type Call = { cmd: string; args: string[] };

/** Dispatch-based fake CmdRunner — no real docker/child_process ever runs.
 *  `onExec` inspects the shell command string passed to `docker exec ...
 *  bash -lc <cmd>` so each test only needs to special-case the step(s) it
 *  cares about; everything else defaults to a clean success. */
function makeFakeRunner(overrides: {
  onDockerRun?: () => FakeResult;
  onDockerCp?: (args: string[]) => FakeResult;
  onDockerRm?: () => FakeResult;
  onExec?: (shellCmd: string) => FakeResult | undefined;
} = {}): { run: CmdRunner; calls: Call[] } {
  const calls: Call[] = [];
  const ok: FakeResult = { exitCode: 0 };
  const run: CmdRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd !== 'docker') return { stdout: '', stderr: '', exitCode: 0 };
    const sub = args[0];
    if (sub === 'run') {
      const r = overrides.onDockerRun?.() ?? ok;
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
    }
    if (sub === 'cp') {
      const r = overrides.onDockerCp?.(args) ?? ok;
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
    }
    if (sub === 'rm') {
      const r = overrides.onDockerRm?.() ?? ok;
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
    }
    if (sub === 'exec') {
      const shellCmd = args[4] ?? '';
      if (shellCmd.startsWith('test -d')) {
        const r = overrides.onExec?.(shellCmd) ?? ok; // default: has git (baked checkout)
        return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
      }
      if (shellCmd.includes('rev-parse HEAD')) {
        const r = overrides.onExec?.(shellCmd) ?? { exitCode: 0, stdout: task().commit };
        return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
      }
      const r = overrides.onExec?.(shellCmd) ?? ok;
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
    }
    if (sub === 'system') return { stdout: '', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  return { run, calls };
}

function task(over: Partial<SkillTaskV1> = {}): SkillTaskV1 {
  return {
    id: 'fix-widget-0001',
    repo: 'org/widget-repo',
    commit: 'a'.repeat(40),
    image: 'jinn/widget-task:0001',
    requirement: {
      background: 'bg', requirement: 'req', fileOps: 'ops', acceptance: 'acc',
    },
    verifierFiles: ['verifiers/test_widget_size.py'],
    referencePatchFile: 'patches/fix-widget-0001.patch',
    ...over,
  };
}

async function makeTaskSetDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'custom-grade-'));
  await mkdir(join(dir, 'verifiers'), { recursive: true });
  await mkdir(join(dir, 'patches'), { recursive: true });
  await writeFile(join(dir, 'verifiers/test_widget_size.py'), 'def test_size():\n    assert True\n');
  await writeFile(join(dir, 'patches/fix-widget-0001.patch'), 'diff --git a/x b/x\n');
  return dir;
}

const bigFreeDisk = async (): Promise<number> => 999_000_000_000;

describe('runCustomGrade', () => {
  it('returns passed:true when pytest exits 0', async () => {
    const taskSetDir = await makeTaskSetDir();
    const { run } = makeFakeRunner({
      onExec: (cmd) => (cmd.includes('pytest') ? { exitCode: 0, stdout: '1 passed' } : undefined),
    });
    const result = await runCustomGrade(
      { task: task(), taskSetDir, patch: 'diff --git a/x b/x\n' },
      { run, freeDiskBytes: bigFreeDisk },
    );
    expect(result).toEqual({ passed: true, log: '1 passed', exitCode: 0 });
  });

  it('returns passed:false when pytest exits 1 (a real failure, not an error)', async () => {
    const taskSetDir = await makeTaskSetDir();
    const { run } = makeFakeRunner({
      onExec: (cmd) => (cmd.includes('pytest') ? { exitCode: 1, stdout: '1 failed' } : undefined),
    });
    const result = await runCustomGrade(
      { task: task(), taskSetDir, patch: '' },
      { run, freeDiskBytes: bigFreeDisk },
    );
    expect(result).toEqual({ passed: false, log: '1 failed', exitCode: 1 });
  });

  it('throws CustomGradeError (not a verdict) when pytest exits 5 — no tests collected', async () => {
    const taskSetDir = await makeTaskSetDir();
    const { run } = makeFakeRunner({
      onExec: (cmd) => (cmd.includes('pytest') ? { exitCode: 5, stdout: 'no tests ran' } : undefined),
    });
    const err = await runCustomGrade(
      { task: task(), taskSetDir, patch: '' },
      { run, freeDiskBytes: bigFreeDisk },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomGradeError);
    expect((err as CustomGradeError).reason).toBe('pytest_exit_5');
  });

  it('classifies a known infra signature in the pytest log instead of a bare exit-code reason', async () => {
    const taskSetDir = await makeTaskSetDir();
    const { run } = makeFakeRunner({
      onExec: (cmd) => (cmd.includes('pytest') ? { exitCode: 2, stdout: 'No module named pytest' } : undefined),
    });
    const err = await runCustomGrade(
      { task: task(), taskSetDir, patch: '' },
      { run, freeDiskBytes: bigFreeDisk },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomGradeError);
    expect((err as CustomGradeError).reason).toBe('pytest_missing');
  });

  it('throws CustomGradeError when the container fails to start', async () => {
    const taskSetDir = await makeTaskSetDir();
    const { run, calls } = makeFakeRunner({
      onDockerRun: () => ({ exitCode: 1, stderr: 'Cannot connect to the Docker daemon' }),
    });
    const err = await runCustomGrade(
      { task: task(), taskSetDir, patch: '' },
      { run, freeDiskBytes: bigFreeDisk },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomGradeError);
    expect((err as CustomGradeError).reason).toBe('container_start_failed');
    // no exec/cp calls happen after a failed container start
    expect(calls.some((c) => c.args[0] === 'exec')).toBe(false);
  });

  it('throws CustomGradeError when neither a baked checkout nor a fresh clone reaches the pinned commit', async () => {
    const taskSetDir = await makeTaskSetDir();
    const { run } = makeFakeRunner({
      onExec: (cmd) => {
        if (cmd.startsWith('test -d')) return { exitCode: 1 }; // no .git — needs a clone
        if (cmd.startsWith('git clone')) return { exitCode: 128, stderr: 'repository not found' };
        return undefined;
      },
    });
    const err = await runCustomGrade(
      { task: task(), taskSetDir, patch: '' },
      { run, freeDiskBytes: bigFreeDisk },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomGradeError);
    expect((err as CustomGradeError).reason).toBe('checkout_failed');
  });

  it('reconciles to the pinned commit via fetch+checkout when the baked HEAD differs', async () => {
    const taskSetDir = await makeTaskSetDir();
    const { run, calls } = makeFakeRunner({
      onExec: (cmd) => {
        if (cmd.includes('rev-parse HEAD')) return { exitCode: 0, stdout: 'f'.repeat(40) }; // different sha
        if (cmd.includes('pytest')) return { exitCode: 0, stdout: 'ok' };
        return undefined;
      },
    });
    await runCustomGrade({ task: task(), taskSetDir, patch: '' }, { run, freeDiskBytes: bigFreeDisk });
    const execCmds = calls.filter((c) => c.args[0] === 'exec').map((c) => c.args[4] ?? '');
    expect(execCmds.some((c) => c.includes(`fetch origin ${task().commit}`))).toBe(true);
    expect(execCmds.some((c) => c.includes(`checkout ${task().commit}`))).toBe(true);
  });

  it('throws CustomGradeError when patch apply fails', async () => {
    const taskSetDir = await makeTaskSetDir();
    const { run } = makeFakeRunner({
      onExec: (cmd) => (cmd.includes('git apply') ? { exitCode: 1, stderr: 'patch does not apply' } : undefined),
    });
    const err = await runCustomGrade(
      { task: task(), taskSetDir, patch: 'diff --git a/x b/x\n' },
      { run, freeDiskBytes: bigFreeDisk },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomGradeError);
    expect((err as CustomGradeError).reason).toBe('patch_apply_failed');
  });

  it('skips patch apply entirely for the empty patch (no git-apply exec call at all)', async () => {
    const taskSetDir = await makeTaskSetDir();
    const { run, calls } = makeFakeRunner({
      onExec: (cmd) => (cmd.includes('pytest') ? { exitCode: 1, stdout: 'not resolved' } : undefined),
    });
    await runCustomGrade({ task: task(), taskSetDir, patch: '' }, { run, freeDiskBytes: bigFreeDisk });
    const execCmds = calls.filter((c) => c.args[0] === 'exec').map((c) => c.args[4] ?? '');
    expect(execCmds.some((c) => c.includes('git apply'))).toBe(false);
    expect(calls.some((c) => c.args[0] === 'cp' && c.args[1]?.includes('patch'))).toBe(false);
  });

  it('throws CustomGradeError when copying a verifier file into the container fails', async () => {
    const taskSetDir = await makeTaskSetDir();
    const { run } = makeFakeRunner({
      onDockerCp: (args) => (args[1]?.includes('verifiers') ? { exitCode: 1, stderr: 'no such file' } : { exitCode: 0 }),
    });
    const err = await runCustomGrade(
      { task: task(), taskSetDir, patch: '' },
      { run, freeDiskBytes: bigFreeDisk },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomGradeError);
    expect((err as CustomGradeError).reason).toBe('verifier_copy_failed');
  });

  it('always tears down the container (docker rm -f), success or failure', async () => {
    const taskSetDir = await makeTaskSetDir();
    const { run: okRun, calls: okCalls } = makeFakeRunner({
      onExec: (cmd) => (cmd.includes('pytest') ? { exitCode: 0, stdout: 'ok' } : undefined),
    });
    await runCustomGrade({ task: task(), taskSetDir, patch: '' }, { run: okRun, freeDiskBytes: bigFreeDisk });
    expect(okCalls.some((c) => c.args[0] === 'rm' && c.args.includes('-f'))).toBe(true);

    const { run: failRun, calls: failCalls } = makeFakeRunner({
      onDockerRun: () => ({ exitCode: 1, stderr: 'boom' }),
    });
    await runCustomGrade(
      { task: task(), taskSetDir, patch: '' }, { run: failRun, freeDiskBytes: bigFreeDisk },
    ).catch(() => {});
    expect(failCalls.some((c) => c.args[0] === 'rm' && c.args.includes('-f'))).toBe(true);
  });

  it('throws InsufficientDiskError when free disk stays below the floor after prune, without starting a container', async () => {
    const taskSetDir = await makeTaskSetDir();
    let pruned = false;
    const { run, calls } = makeFakeRunner();
    const err = await runCustomGrade(
      { task: task(), taskSetDir, patch: '' },
      {
        run,
        diskFloorBytes: 10_000_000_000,
        freeDiskBytes: async () => 1_000_000_000,
        systemPrune: async () => { pruned = true; },
      },
    ).catch((e: unknown) => e);
    expect((err as Error).name).toBe('InsufficientDiskError');
    expect(pruned).toBe(true);
    expect(calls.some((c) => c.args[0] === 'run')).toBe(false);
  });

  it('times out a wedged grade step and reports it as CustomGradeError(grade_timeout)', async () => {
    const taskSetDir = await makeTaskSetDir();
    const hang: CmdRunner = () => new Promise(() => {}); // never resolves — including the cleanup rm -f
    const err = await runCustomGrade(
      { task: task({ timeoutMs: 20 }), taskSetDir, patch: '' },
      { run: hang, freeDiskBytes: bigFreeDisk, cleanupTimeoutMs: 20 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomGradeError);
    expect((err as CustomGradeError).reason).toBe('grade_timeout');
  });

  it('uses the default timeout when neither task.timeoutMs nor opts.timeoutMs is set', () => {
    expect(DEFAULT_CUSTOM_GRADE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('bounds a wedged docker rm -f teardown instead of hanging forever, even on a successful grade', async () => {
    const { run } = makeFakeRunner({
      onExec: (cmd) => (cmd.includes('pytest') ? { exitCode: 0, stdout: 'ok' } : undefined),
    });
    // Wrap `run` so only the `rm -f` call hangs — everything else behaves.
    const partialHang: CmdRunner = (cmd, cmdArgs, opts) => {
      if (cmd === 'docker' && cmdArgs[0] === 'rm') return new Promise(() => {});
      return run(cmd, cmdArgs, opts);
    };
    const taskSetDir = await makeTaskSetDir();
    const result = await runCustomGrade(
      { task: task(), taskSetDir, patch: '' },
      { run: partialHang, freeDiskBytes: bigFreeDisk, cleanupTimeoutMs: 20 },
    );
    expect(result.passed).toBe(true);
  });
});
