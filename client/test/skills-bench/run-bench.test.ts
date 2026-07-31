import { describe, expect, it, vi } from 'vitest';

// I1: --grade-timeout-ms must reach runCustomGrade in --task-set mode, the
// same way cfg.gradeTimeoutMs already reaches PythonEvalRunner in --slate
// mode. run-bench.ts has no other importable surface (it is a CLI
// entrypoint), so this mocks its one dependency on custom-grade.ts and
// asserts the plumbing directly — no Docker, no real grading.
const runCustomGrade = vi.fn();
vi.mock('../../src/skills-bench/custom-grade.js', () => ({
  runCustomGrade: (...args: unknown[]) => runCustomGrade(...args),
  CustomGradeError: class CustomGradeError extends Error {},
}));

describe('gradeTaskAttempt (I1 grade-timeout-ms plumbing)', () => {
  it('passes gradeTimeoutMs through to runCustomGrade as opts.timeoutMs', async () => {
    const { gradeTaskAttempt } = await import('../../scripts/skills-bench/run-bench.js');
    runCustomGrade.mockResolvedValueOnce({ passed: true, log: '', exitCode: 0 });

    const task = {
      id: 'fix-widget-0001', repo: 'org/widget', commit: 'a'.repeat(40), image: 'jinn/widget:0001',
      requirement: { background: 'b', requirement: 'r', fileOps: 'f', acceptance: 'a' },
      verifierFiles: ['verifiers/test_a.py'], referencePatchFile: 'patches/a.patch',
    };

    await gradeTaskAttempt('/task-set-dir', task as never, 'diff --git a/x b/x\n', 123_456);

    expect(runCustomGrade).toHaveBeenCalledTimes(1);
    const [args, opts] = runCustomGrade.mock.calls[0]!;
    expect(args).toMatchObject({ task, taskSetDir: '/task-set-dir', patch: 'diff --git a/x b/x\n' });
    expect(opts).toEqual({ timeoutMs: 123_456 });
  });

  it('never calls runCustomGrade for an empty patch (scored not-resolved without spending a grade)', async () => {
    const { gradeTaskAttempt } = await import('../../scripts/skills-bench/run-bench.js');
    runCustomGrade.mockClear();

    const task = {
      id: 'fix-widget-0002', repo: 'org/widget', commit: 'a'.repeat(40), image: 'jinn/widget:0001',
      requirement: { background: 'b', requirement: 'r', fileOps: 'f', acceptance: 'a' },
      verifierFiles: ['verifiers/test_a.py'], referencePatchFile: 'patches/a.patch',
    };

    const result = await gradeTaskAttempt('/task-set-dir', task as never, '   ', 999);
    expect(result).toBe(false);
    expect(runCustomGrade).not.toHaveBeenCalled();
  });
});
