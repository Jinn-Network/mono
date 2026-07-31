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

// --reeval-of / --force-reeval flag parsing (re-evaluation freshness guard,
// spec §3.1 step 7, reeval-guard.ts). The assert call itself is unit-tested
// directly against reeval-guard.ts (reeval-guard.test.ts) — this covers only
// that run-bench.ts's CLI surface parses and validates the new flags
// correctly, mirroring how --half/--candidate-id are validated above them.
describe('parseArgs (--reeval-of / --force-reeval)', () => {
  it('defaults reevalOf to undefined and forceReeval to false', async () => {
    const { parseArgs } = await import('../../scripts/skills-bench/run-bench.js');
    const cfg = parseArgs(['--task-set', '../bench/task-sets/tdd', '--arms', '../bench/arms/a.json', '--out', '/tmp/o']);
    expect(cfg.reevalOf).toBeUndefined();
    expect(cfg.forceReeval).toBe(false);
  });

  it('parses --reeval-of <skill> for a --task-set run', async () => {
    const { parseArgs } = await import('../../scripts/skills-bench/run-bench.js');
    const cfg = parseArgs([
      '--task-set', '../bench/task-sets/tdd', '--arms', '../bench/arms/a.json', '--out', '/tmp/o',
      '--reeval-of', 'tdd',
    ]);
    expect(cfg.reevalOf).toBe('tdd');
    expect(cfg.forceReeval).toBe(false);
  });

  it('parses --force-reeval alongside --reeval-of (the loud override path)', async () => {
    const { parseArgs } = await import('../../scripts/skills-bench/run-bench.js');
    const cfg = parseArgs([
      '--task-set', '../bench/task-sets/tdd', '--arms', '../bench/arms/a.json', '--out', '/tmp/o',
      '--reeval-of', 'tdd', '--force-reeval',
    ]);
    expect(cfg.forceReeval).toBe(true);
  });

  it('rejects --force-reeval without --reeval-of', async () => {
    const { parseArgs } = await import('../../scripts/skills-bench/run-bench.js');
    expect(() => parseArgs([
      '--task-set', '../bench/task-sets/tdd', '--arms', '../bench/arms/a.json', '--out', '/tmp/o',
      '--force-reeval',
    ])).toThrow(/--force-reeval requires --reeval-of/);
  });

  it('rejects --reeval-of combined with --slate (holdout ledger already covers --slate)', async () => {
    const { parseArgs } = await import('../../scripts/skills-bench/run-bench.js');
    expect(() => parseArgs([
      '--slate', '../bench/slate/slate.json', '--arms', '../bench/arms/a.json', '--out', '/tmp/o',
      '--reeval-of', 'tdd',
    ])).toThrow(/--reeval-of is --task-set only/);
  });
});
