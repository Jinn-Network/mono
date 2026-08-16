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
  recheckDiscrimination,
  summarizeWeakSuite,
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

describe('recheckDiscrimination', () => {
  it('flags an unchecked benchmark entry whose known-bad patch passes, and leaves it scorable=true (D3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-disc-recheck-'));
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('repo__pkg-1', { scorable: true, reason: 'gold-patch-resolves', checkedAt: new Date().toISOString() }, EVAL_SEMANTICS_VERSION);
    const fetcher = {
      fetchTaskRow: async () => ({
        instance_id: 'repo__pkg-1',
        repo: 'acme/widget',
        image_name: 'img:tag',
        FAIL_TO_PASS: ['t1'],
        PASS_TO_PASS: [],
        test_patch: '',
        install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
      }),
    };
    const runner = {
      runEval: vi.fn().mockResolvedValue({ passed_match: true, passed: ['t1'], failed: [] }),
    };
    const result = await recheckDiscrimination({
      pool: [poolTask('repo__pkg-1')],
      store,
      fetcher,
      runner,
      semanticsVersion: EVAL_SEMANTICS_VERSION,
    });
    expect(result.checked).toBe(1);
    expect(result.skipped).toEqual({ alreadyVerdicted: 0, limitExceeded: 0, orphanedPoolTask: 0, evalError: 0 });
    expect(result.flagged).toEqual(['repo__pkg-1']);
    const entry = await store.getEntry('repo__pkg-1', EVAL_SEMANTICS_VERSION);
    expect(entry?.discrimination).toBe('fail');
    expect(entry?.scorable).toBe(true); // benchmark pool: flag, never hard-reject
    await rm(dir, { recursive: true, force: true });
  });

  it('skips entries that already carry a discrimination verdict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-disc-recheck-'));
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('repo__pkg-2', { scorable: true, reason: 'gold-patch-resolves', checkedAt: new Date().toISOString(), discrimination: 'pass' }, EVAL_SEMANTICS_VERSION);
    const fetcher = { fetchTaskRow: vi.fn() };
    const runner = { runEval: vi.fn(async () => { throw new Error('must not be called'); }) };
    const result = await recheckDiscrimination({
      pool: [poolTask('repo__pkg-2')],
      store,
      fetcher,
      runner,
      semanticsVersion: EVAL_SEMANTICS_VERSION,
    });
    expect(result.checked).toBe(0);
    expect(result.skipped).toEqual({ alreadyVerdicted: 1, limitExceeded: 0, orphanedPoolTask: 0, evalError: 0 });
    expect(result.flagged).toEqual([]);
    expect(fetcher.fetchTaskRow).not.toHaveBeenCalled();
    expect(runner.runEval).not.toHaveBeenCalled();
    await rm(dir, { recursive: true, force: true });
  });

  it('counts orphaned pool tasks separately from recheckable backlog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-disc-recheck-'));
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('repo__orphan', { scorable: true, reason: 'gold-patch-resolves', checkedAt: new Date().toISOString() }, EVAL_SEMANTICS_VERSION);
    const fetcher = { fetchTaskRow: vi.fn() };
    const runner = { runEval: vi.fn() };
    const result = await recheckDiscrimination({
      pool: [poolTask('repo__other')],
      store,
      fetcher,
      runner,
      semanticsVersion: EVAL_SEMANTICS_VERSION,
    });
    expect(result.checked).toBe(0);
    expect(result.skipped).toEqual({ alreadyVerdicted: 0, limitExceeded: 0, orphanedPoolTask: 1, evalError: 0 });
    expect(fetcher.fetchTaskRow).not.toHaveBeenCalled();
    await rm(dir, { recursive: true, force: true });
  });

  it('counts limit-exceeded skips separately once the batch bound is hit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-disc-recheck-'));
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('repo__pkg-1', { scorable: true, reason: 'gold-patch-resolves', checkedAt: new Date().toISOString() }, EVAL_SEMANTICS_VERSION);
    await store.record('repo__pkg-2', { scorable: true, reason: 'gold-patch-resolves', checkedAt: new Date().toISOString() }, EVAL_SEMANTICS_VERSION);
    const fetcher = {
      fetchTaskRow: async () => ({
        instance_id: 'x',
        repo: 'acme/widget',
        image_name: 'img:tag',
        FAIL_TO_PASS: ['t1'],
        PASS_TO_PASS: [],
        test_patch: '',
        install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
      }),
    };
    const runner = {
      runEval: vi.fn().mockResolvedValue({ passed_match: true, passed: ['t1'], failed: [] }),
    };
    const result = await recheckDiscrimination({
      pool: [poolTask('repo__pkg-1'), poolTask('repo__pkg-2')],
      store,
      fetcher,
      runner,
      semanticsVersion: EVAL_SEMANTICS_VERSION,
      limit: 1,
    });
    expect(result.checked).toBe(1);
    expect(result.skipped).toEqual({ alreadyVerdicted: 0, limitExceeded: 1, orphanedPoolTask: 0, evalError: 0 });
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps post-limit orphaned pool tasks visible instead of folding them into the batch bound', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-disc-recheck-'));
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('repo__pkg-1', { scorable: true, reason: 'gold-patch-resolves', checkedAt: new Date().toISOString() }, EVAL_SEMANTICS_VERSION);
    await store.record('repo__orphan', { scorable: true, reason: 'gold-patch-resolves', checkedAt: new Date().toISOString() }, EVAL_SEMANTICS_VERSION);
    const fetcher = {
      fetchTaskRow: async () => ({
        instance_id: 'repo__pkg-1',
        repo: 'acme/widget',
        image_name: 'img:tag',
        FAIL_TO_PASS: ['t1'],
        PASS_TO_PASS: [],
        test_patch: '',
        install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
      }),
    };
    const runner = {
      runEval: vi.fn().mockResolvedValue({ passed_match: true, passed: ['t1'], failed: [] }),
    };
    const result = await recheckDiscrimination({
      pool: [poolTask('repo__pkg-1')],
      store,
      fetcher,
      runner,
      semanticsVersion: EVAL_SEMANTICS_VERSION,
      limit: 1,
    });
    expect(result.checked).toBe(1);
    expect(result.skipped).toEqual({ alreadyVerdicted: 0, limitExceeded: 0, orphanedPoolTask: 1, evalError: 0 });
    await rm(dir, { recursive: true, force: true });
  });

  it('counts fetch/eval errors separately so a retryable backlog stays visible', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jinn-disc-recheck-'));
    const store = new ValidatedPoolStore({ stateDir: dir });
    await store.record('repo__pkg-1', { scorable: true, reason: 'gold-patch-resolves', checkedAt: new Date().toISOString() }, EVAL_SEMANTICS_VERSION);
    const fetcher = { fetchTaskRow: vi.fn().mockRejectedValue(new Error('hf down')) };
    const runner = { runEval: vi.fn() };
    const result = await recheckDiscrimination({
      pool: [poolTask('repo__pkg-1')],
      store,
      fetcher,
      runner,
      semanticsVersion: EVAL_SEMANTICS_VERSION,
    });
    expect(result.checked).toBe(0);
    expect(result.skipped).toEqual({ alreadyVerdicted: 0, limitExceeded: 0, orphanedPoolTask: 0, evalError: 1 });
    const entry = await store.getEntry('repo__pkg-1', EVAL_SEMANTICS_VERSION);
    expect(entry?.discrimination).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('summarizeWeakSuite', () => {
  it('computes the rate over verdicted entries only, reporting undecided entries as unchecked', () => {
    const file = {
      entries: {
        pass1: { scorable: true, reason: 'gold-patch-resolves', checkedAt: 't', discrimination: 'pass' },
        pass2: { scorable: true, reason: 'gold-patch-resolves', checkedAt: 't', discrimination: 'pass' },
        fail1: { scorable: true, reason: 'gold-patch-resolves', checkedAt: 't', discrimination: 'fail' },
        unchecked1: { scorable: true, reason: 'gold-patch-resolves', checkedAt: 't' },
        unscorable1: { scorable: false, reason: 'gold-patch-not-resolved', checkedAt: 't' },
      },
    };
    expect(summarizeWeakSuite(file)).toEqual({
      checked: 3,
      flagged: 1,
      unchecked: { backlog: 1, orphaned: 0 },
      rate: 1 / 3,
    });
  });

  it('returns a null rate when nothing has been discrimination-checked yet', () => {
    const file = { entries: { a: { scorable: true, reason: 'gold-patch-resolves', checkedAt: 't' } } };
    expect(summarizeWeakSuite(file)).toEqual({
      checked: 0,
      flagged: 0,
      unchecked: { backlog: 1, orphaned: 0 },
      rate: null,
    });
  });

  it('splits unchecked entries into backlog vs orphaned when pool ids are supplied', () => {
    const file = {
      entries: {
        inPool: { scorable: true, reason: 'gold-patch-resolves', checkedAt: 't' },
        orphan: { scorable: true, reason: 'gold-patch-resolves', checkedAt: 't' },
        verdicted: { scorable: true, reason: 'gold-patch-resolves', checkedAt: 't', discrimination: 'pass' },
      },
    };
    expect(summarizeWeakSuite(file, new Set(['inPool']))).toEqual({
      checked: 1,
      flagged: 0,
      unchecked: { backlog: 1, orphaned: 1 },
      rate: 0,
    });
  });
});
