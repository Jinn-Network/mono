import { describe, it, expect, vi } from 'vitest';
import { SweRebenchV2VerdictV2PayloadSchema } from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import { SweRebenchV2Evaluator } from '../../../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';

describe('SweRebenchV2Evaluator', () => {
  it('emits a passing Verdict (score=1) when test suite passes', async () => {
    const fakeRunner = {
      runEval: vi.fn().mockResolvedValue({
        passed_match: true,
        passed: ['test_a', 'test_b'],
        failed: [],
        log: 'all green',
        exitCode: 0,
      }),
    };
    const fakeFetcher = {
      fetchTaskRow: vi.fn().mockResolvedValue({
        instance_id: 'unidata__netcdf-c-1925',
        repo: 'Unidata/netcdf-c',
        image_name: 'docker.io/swerebenchv2/unidata-netcdf-c:1925-ad6bff3',
        FAIL_TO_PASS: ['test_a'],
        PASS_TO_PASS: ['test_b'],
        test_patch: 'diff --git ...',
        install_config: { install: 'pip install -e .', test_cmd: 'make test', log_parser: 'pytest' },
      }),
    };
    const evaluator = new SweRebenchV2Evaluator({ fetcher: fakeFetcher, runner: fakeRunner });
    const verdict = await evaluator.grade({
      task: {
        instance_id: 'unidata__netcdf-c-1925',
        hf_dataset: 'nebius/SWE-rebench-leaderboard',
        hf_split: '2026_02',
      } as any,
      solutionPayload: { patch: 'diff ...' },
    });
    expect(verdict.score).toBe(1);
    expect(verdict.passed_match).toBe(true);
    expect(verdict.schemaVersion).toBe('swe-rebench-v2-verdict.v2');
    expect(verdict.passedCount).toBe(2);
    expect(verdict.totalCount).toBe(2);
    expect(fakeRunner.runEval).toHaveBeenCalledWith(expect.objectContaining({
      instance_id: 'unidata__netcdf-c-1925',
      repo: 'Unidata/netcdf-c',
      install: 'pip install -e .',
    }));
  });

  it('emits a failing Verdict (score=0) when tests fail', async () => {
    const fakeRunner = {
      runEval: vi.fn().mockResolvedValue({
        passed_match: false,
        passed: [],
        failed: ['test_a'],
        log: 'test_a failed',
        exitCode: 1,
      }),
    };
    const fakeFetcher = {
      fetchTaskRow: vi.fn().mockResolvedValue({
        instance_id: 'unidata__netcdf-c-1925',
        repo: 'Unidata/netcdf-c',
        image_name: 'docker.io/swerebenchv2/unidata-netcdf-c:1925-ad6bff3',
        FAIL_TO_PASS: ['test_a'],
        PASS_TO_PASS: [],
        test_patch: 'diff ...',
        install_config: { test_cmd: 'make test', log_parser: 'pytest' },
      }),
    };
    const evaluator = new SweRebenchV2Evaluator({ fetcher: fakeFetcher, runner: fakeRunner });
    const verdict = await evaluator.grade({
      task: { instance_id: 'unidata__netcdf-c-1925', hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2026_02' } as any,
      solutionPayload: { patch: 'diff ...' },
    });
    expect(verdict.score).toBe(0);
    expect(verdict.passedCount).toBe(0);
    expect(verdict.totalCount).toBe(1);
  });

  it('emits v2 graded counts from passed/failed arrays', async () => {
    const fakeRunner = {
      runEval: vi.fn().mockResolvedValue({
        passed_match: false,
        passed: ['t1', 't2', 't3'],
        failed: ['t4'],
        log: 'three pass, one fail',
        exitCode: 1,
      }),
    };
    const fakeFetcher = {
      fetchTaskRow: vi.fn().mockResolvedValue({
        instance_id: 'unidata__netcdf-c-1925',
        repo: 'Unidata/netcdf-c',
        image_name: 'docker.io/swerebenchv2/unidata-netcdf-c:1925-ad6bff3',
        FAIL_TO_PASS: ['t1', 't2', 't3'],
        PASS_TO_PASS: ['t4'],
        test_patch: 'diff --git ...',
        install_config: { install: 'pip install -e .', test_cmd: 'make test', log_parser: 'pytest' },
      }),
    };
    const evaluator = new SweRebenchV2Evaluator({ fetcher: fakeFetcher, runner: fakeRunner });
    const verdict = await evaluator.grade({
      task: {
        instance_id: 'unidata__netcdf-c-1925',
        hf_dataset: 'nebius/SWE-rebench-leaderboard',
        hf_split: '2026_02',
      } as any,
      solutionPayload: { patch: 'diff ...' },
    });
    expect(verdict.schemaVersion).toBe('swe-rebench-v2-verdict.v2');
    expect(verdict.passedCount).toBe(3);
    expect(verdict.totalCount).toBe(4);
    expect(verdict.score).toBe(0); // binary unchanged: passed_match was false
  });

  it('emits a parseable (0,0) verdict when no gradeable tests', async () => {
    const fakeRunner = {
      runEval: vi.fn().mockResolvedValue({
        passed_match: false,
        passed: [],
        failed: [],
        log: 'no gradeable tests',
        exitCode: 1,
      }),
    };
    const fakeFetcher = {
      fetchTaskRow: vi.fn().mockResolvedValue({
        instance_id: 'unidata__netcdf-c-1925',
        repo: 'Unidata/netcdf-c',
        image_name: 'docker.io/swerebenchv2/unidata-netcdf-c:1925-ad6bff3',
        FAIL_TO_PASS: [],
        PASS_TO_PASS: [],
        test_patch: 'diff ...',
        install_config: { test_cmd: 'make test', log_parser: 'pytest' },
      }),
    };
    const evaluator = new SweRebenchV2Evaluator({ fetcher: fakeFetcher, runner: fakeRunner });
    const verdict = await evaluator.grade({
      task: { instance_id: 'unidata__netcdf-c-1925', hf_dataset: 'nebius/SWE-rebench-leaderboard', hf_split: '2026_02' } as any,
      solutionPayload: { patch: 'diff ...' },
    });
    expect(verdict.totalCount).toBe(0);
    // (0,0) is the intended no-gradeable-tests contract (#1019 §7): parses fine, downstream maps to gradedScore=null.
    expect(() => SweRebenchV2VerdictV2PayloadSchema.parse({
      schemaVersion: verdict.schemaVersion,
      score: verdict.score,
      passed_match: verdict.passed_match,
      evaluator_cost_usd: verdict.evaluator_cost_usd,
      passedCount: verdict.passedCount,
      totalCount: verdict.totalCount,
    })).not.toThrow();
  });

  it('throws on missing image_name in HF row', async () => {
    const fakeRunner = { runEval: vi.fn() };
    const fakeFetcher = {
      fetchTaskRow: vi.fn().mockResolvedValue({
        instance_id: 'X',
        FAIL_TO_PASS: [], PASS_TO_PASS: [], test_patch: '', install_config: {},
      }),
    };
    const evaluator = new SweRebenchV2Evaluator({ fetcher: fakeFetcher, runner: fakeRunner });
    await expect(evaluator.grade({
      task: { instance_id: 'X', hf_dataset: 'd', hf_split: '2026_02' } as any,
      solutionPayload: { patch: '...' },
    })).rejects.toThrow(/image_name/);
  });
});
