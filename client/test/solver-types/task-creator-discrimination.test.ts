/**
 * Discrimination check tests — task-creator rung 0 (D3).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  EVAL_SEMANTICS_VERSION,
  KNOWN_BAD_DISCRIMINATION_PATCH,
  ValidatedPoolStore,
  WEAK_SUITE_REASON,
  validatePoolInstances,
  runDiscriminationCheck,
} from '../../src/solver-types/_swe-rebench-v2-validated-pool.js';
import type { PoolTask } from '../../src/solver-types/_swe-rebench-v2-pool.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function poolTask(id: string): PoolTask {
  return {
    instance_id: id,
    hf_dataset: 'nebius/SWE-rebench-leaderboard',
    hf_split: 'test',
    repo: 'acme/widget',
    patch: 'gold',
    test_patch: 'test',
    language: 'python',
  };
}

describe('discrimination check', () => {
  it('hard-rejects minted when known-bad passes', async () => {
    const runner = {
      runEval: vi.fn()
        .mockResolvedValueOnce({ passed_match: true, passed: ['t1'], failed: [] })
        .mockResolvedValueOnce({ passed_match: true, passed: ['t1'], failed: [] }),
    };
    const row = {
      instance_id: 'x',
      repo: 'acme/widget',
      image_name: 'img:tag',
      FAIL_TO_PASS: ['t1'],
      PASS_TO_PASS: [],
      test_patch: '',
      install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
    };
    const disc = await runDiscriminationCheck({
      task: poolTask('x'),
      row,
      runner,
      poolSource: 'minted',
      substrate: { checkedAt: new Date().toISOString() },
    });
    expect(disc.scorable).toBe(false);
    expect(disc.reason).toBe(WEAK_SUITE_REASON);
    expect(disc.discrimination).toBe('fail');
    expect(runner.runEval).toHaveBeenCalledWith(
      expect.objectContaining({ patch: KNOWN_BAD_DISCRIMINATION_PATCH }),
    );
  });

  it('flags benchmark pool when known-bad passes', async () => {
    const runner = {
      runEval: vi.fn()
        .mockResolvedValueOnce({ passed_match: true, passed: ['t1'], failed: [] })
        .mockResolvedValueOnce({ passed_match: true, passed: ['t1'], failed: [] }),
    };
    const row = {
      instance_id: 'x',
      repo: 'acme/widget',
      image_name: 'img:tag',
      FAIL_TO_PASS: ['t1'],
      PASS_TO_PASS: [],
      test_patch: '',
      install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
    };
    const disc = await runDiscriminationCheck({
      task: poolTask('x'),
      row,
      runner,
      poolSource: 'benchmark',
      substrate: { checkedAt: new Date().toISOString() },
    });
    expect(disc.scorable).toBe(true);
    expect(disc.discrimination).toBe('fail');
  });

  it('validatePoolInstances excludes discrimination fail from scorable ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-disc-'));
    const store = new ValidatedPoolStore({ stateDir: dir });
    const fetcher = {
      fetchTaskRow: async () => ({
        instance_id: 'a__1',
        repo: 'acme/widget',
        image_name: 'img:tag',
        FAIL_TO_PASS: ['t1'],
        PASS_TO_PASS: [],
        test_patch: '',
        install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
      }),
    };
    const runner = {
      runEval: vi.fn()
        .mockResolvedValue({ passed_match: true, passed: ['t1'], failed: [], imageDigest: 'sha256:abc' }),
    };
    await validatePoolInstances([poolTask('a__1')], {
      fetcher,
      runner,
      store,
      semanticsVersion: EVAL_SEMANTICS_VERSION,
      upstreamRepoDir: '/fake',
      commandRunner: async () => ({ stdout: 'abc', stderr: '', exitCode: 0 }),
    }, { poolSource: 'benchmark', force: true });
    const ids = await store.getScorableIds(EVAL_SEMANTICS_VERSION);
    expect(ids?.has('a__1')).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});
