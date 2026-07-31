import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyGradeability,
  sweepGradeability,
  type GradeabilitySweepReport,
} from '../../scripts/skills-bench/sweep-gradeability.js';
import type { SkillsBenchSlate } from '../../src/skills-bench/slate.js';
import type { HfFetcher, HfRow, EvalRunner } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { EvalCouldNotGradeError } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';

function fixtureRow(instance_id: string): HfRow {
  return {
    instance_id,
    repo: 'acme/widget',
    image_name: 'jinn/widget-task:0001',
    FAIL_TO_PASS: ['test_foo'],
    PASS_TO_PASS: ['test_bar'],
    test_patch: '',
    install_config: { install: 'pip install -e .', test_cmd: 'pytest', log_parser: 'pytest' },
  };
}

function slate(over: Partial<SkillsBenchSlate> = {}): SkillsBenchSlate {
  return {
    version: 'skills-bench-slate.v1',
    seed: 'test-seed',
    feedback: [
      { instance_id: 'inst-gradeable', repo: 'acme/widget', hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2025_01' },
      { instance_id: 'inst-ungradeable', repo: 'acme/gadget', hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2025_01' },
    ],
    holdout: [
      { instance_id: 'inst-holdout', repo: 'acme/thing', hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2025_01' },
    ],
    sha256: 'fixture-slate-sha256',
    ...over,
  };
}

function fakeFetcher(): HfFetcher {
  return {
    async fetchTaskRow({ instance_id }) {
      return fixtureRow(instance_id);
    },
  };
}

/** Dispatch-based fake EvalRunner — no docker ever runs. `behavior` maps
 *  instance_id to what runEval should do; a missing entry is a test bug. */
function fakeRunner(behavior: Record<string, () => Promise<unknown>>): { runner: EvalRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: EvalRunner = {
    async runEval(args) {
      calls.push(args.instance_id);
      const fn = behavior[args.instance_id];
      if (!fn) throw new Error(`test bug: no behavior fixture for ${args.instance_id}`);
      return (await fn()) as Awaited<ReturnType<EvalRunner['runEval']>>;
    },
  };
  return { runner, calls };
}

describe('classifyGradeability', () => {
  it('completed → gradeable, no reason', () => {
    expect(classifyGradeability({ kind: 'completed' })).toEqual({ status: 'gradeable' });
  });

  it('could-not-grade → ungradeable, carries the reason', () => {
    expect(classifyGradeability({ kind: 'could-not-grade', reason: 'conftest_import_error' }))
      .toEqual({ status: 'ungradeable', reason: 'conftest_import_error' });
  });

  it('unexpected → error, carries the message', () => {
    expect(classifyGradeability({ kind: 'unexpected', message: 'ECONNREFUSED' }))
      .toEqual({ status: 'error', reason: 'ECONNREFUSED' });
  });
});

describe('sweepGradeability', () => {
  it('classifies a completed eval as gradeable, an EvalCouldNotGradeError as ungradeable, and an unexpected throw as error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sweep-'));
    const reportPath = join(dir, 'gradeability-sweep.json');
    const { runner } = fakeRunner({
      'inst-gradeable': async () => ({ passed_match: false, passed: [], failed: ['test_foo'], log: '', exitCode: 1 }),
      'inst-ungradeable': async () => { throw new EvalCouldNotGradeError('conftest_import_error', 'ImportError: ...'); },
      'inst-holdout': async () => { throw new Error('docker daemon unreachable'); },
    });

    const report = await sweepGradeability({
      slate: slate(),
      reportPath,
      deps: { fetcher: fakeFetcher(), runner },
    });

    expect(report.slateSha256).toBe('fixture-slate-sha256');
    expect(report.results['inst-gradeable']!.status).toBe('gradeable');
    expect(report.results['inst-gradeable']!.reason).toBeUndefined();
    expect(report.results['inst-ungradeable']).toMatchObject({ status: 'ungradeable', reason: 'conftest_import_error' });
    expect(report.results['inst-holdout']).toMatchObject({ status: 'error', reason: 'docker daemon unreachable' });
    // Per-instance timing recorded.
    for (const r of Object.values(report.results)) {
      expect(typeof r.durationMs).toBe('number');
      expect(r.gradedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('is durable: the report on disk reflects every instance graded so far', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sweep-durable-'));
    const reportPath = join(dir, 'gradeability-sweep.json');
    const { runner } = fakeRunner({
      'inst-gradeable': async () => ({ passed_match: false, passed: [], failed: [], log: '', exitCode: 1 }),
      'inst-ungradeable': async () => { throw new EvalCouldNotGradeError('bad_image'); },
      'inst-holdout': async () => ({ passed_match: false, passed: [], failed: [], log: '', exitCode: 1 }),
    });

    await sweepGradeability({ slate: slate(), reportPath, deps: { fetcher: fakeFetcher(), runner } });

    const onDisk = JSON.parse(await readFile(reportPath, 'utf8')) as GradeabilitySweepReport;
    expect(Object.keys(onDisk.results).sort()).toEqual(['inst-gradeable', 'inst-holdout', 'inst-ungradeable']);
  });

  it('resumes: a re-run skips instances already classified and never re-invokes the runner for them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sweep-resume-'));
    const reportPath = join(dir, 'gradeability-sweep.json');

    const first = fakeRunner({
      'inst-gradeable': async () => ({ passed_match: false, passed: [], failed: [], log: '', exitCode: 1 }),
      'inst-ungradeable': async () => { throw new EvalCouldNotGradeError('conftest_import_error'); },
      'inst-holdout': async () => ({ passed_match: false, passed: [], failed: [], log: '', exitCode: 1 }),
    });
    await sweepGradeability({ slate: slate(), reportPath, deps: { fetcher: fakeFetcher(), runner: first.runner } });
    expect(first.calls.sort()).toEqual(['inst-gradeable', 'inst-holdout', 'inst-ungradeable']);

    // Second run against the same report path: the runner must not be
    // called again for any already-classified instance.
    const second = fakeRunner({
      'inst-gradeable': async () => { throw new Error('should not be re-invoked'); },
      'inst-ungradeable': async () => { throw new Error('should not be re-invoked'); },
      'inst-holdout': async () => { throw new Error('should not be re-invoked'); },
    });
    const resumed = await sweepGradeability({ slate: slate(), reportPath, deps: { fetcher: fakeFetcher(), runner: second.runner } });

    expect(second.calls).toEqual([]);
    expect(Object.keys(resumed.results)).toHaveLength(3);
    expect(resumed.results['inst-ungradeable']!.status).toBe('ungradeable');
  });

  it('re-attempts an instance whose cached status is "error" on resume, but still skips gradeable/ungradeable ones (I3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sweep-error-retry-'));
    const reportPath = join(dir, 'gradeability-sweep.json');

    const first = fakeRunner({
      'inst-gradeable': async () => ({ passed_match: false, passed: [], failed: [], log: '', exitCode: 1 }),
      'inst-ungradeable': async () => { throw new EvalCouldNotGradeError('conftest_import_error'); },
      'inst-holdout': async () => { throw new Error('docker daemon unreachable'); }, // -> status 'error'
    });
    await sweepGradeability({ slate: slate(), reportPath, deps: { fetcher: fakeFetcher(), runner: first.runner } });

    const onDiskFirst = JSON.parse(await readFile(reportPath, 'utf8')) as GradeabilitySweepReport;
    expect(onDiskFirst.results['inst-holdout']!.status).toBe('error');

    // Second run: the runner must NOT be re-invoked for the gradeable/
    // ungradeable instances (terminal verdicts), but MUST be re-invoked for
    // the errored one — this time it succeeds.
    const second = fakeRunner({
      'inst-gradeable': async () => { throw new Error('should not be re-invoked'); },
      'inst-ungradeable': async () => { throw new Error('should not be re-invoked'); },
      'inst-holdout': async () => ({ passed_match: false, passed: [], failed: [], log: '', exitCode: 1 }),
    });
    const resumed = await sweepGradeability({ slate: slate(), reportPath, deps: { fetcher: fakeFetcher(), runner: second.runner } });

    expect(second.calls).toEqual(['inst-holdout']);
    expect(resumed.results['inst-gradeable']!.status).toBe('gradeable');
    expect(resumed.results['inst-ungradeable']!.status).toBe('ungradeable');
    expect(resumed.results['inst-holdout']!.status).toBe('gradeable');
  });

  it('only sweeps a requested subset via instanceIds, and throws on an unknown id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sweep-subset-'));
    const reportPath = join(dir, 'gradeability-sweep.json');
    const { runner, calls } = fakeRunner({
      'inst-gradeable': async () => ({ passed_match: false, passed: [], failed: [], log: '', exitCode: 1 }),
    });

    const report = await sweepGradeability({
      slate: slate(),
      instanceIds: ['inst-gradeable'],
      reportPath,
      deps: { fetcher: fakeFetcher(), runner },
    });

    expect(calls).toEqual(['inst-gradeable']);
    expect(Object.keys(report.results)).toEqual(['inst-gradeable']);

    await expect(sweepGradeability({
      slate: slate(),
      instanceIds: ['does-not-exist'],
      reportPath: join(dir, 'other-report.json'),
      deps: { fetcher: fakeFetcher(), runner },
    })).rejects.toThrow(/not found in slate/);
  });

  it('refuses to resume a report written for a different slate sha256', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sweep-mismatch-'));
    const reportPath = join(dir, 'gradeability-sweep.json');
    const { runner } = fakeRunner({
      'inst-gradeable': async () => ({ passed_match: false, passed: [], failed: [], log: '', exitCode: 1 }),
      'inst-ungradeable': async () => ({ passed_match: false, passed: [], failed: [], log: '', exitCode: 1 }),
      'inst-holdout': async () => ({ passed_match: false, passed: [], failed: [], log: '', exitCode: 1 }),
    });
    await sweepGradeability({ slate: slate(), reportPath, deps: { fetcher: fakeFetcher(), runner } });

    await expect(sweepGradeability({
      slate: slate({ sha256: 'a-different-sha256' }),
      reportPath,
      deps: { fetcher: fakeFetcher(), runner },
    })).rejects.toThrow(/mismatch/);
  });
});
