import { describe, it, expect, vi } from 'vitest';
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
        image_name: 'docker.io/swerebenchv2/unidata-netcdf-c:1925-ad6bff3',
        FAIL_TO_PASS: ['test_a'],
        PASS_TO_PASS: ['test_b'],
        test_patch: 'diff --git ...',
        install_config: { test_cmd: 'make test', log_parser: 'pytest' },
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
