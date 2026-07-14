/**
 * Tests for task-creator guards, yield, hunk-echo, routing fetcher.
 */

import { describe, expect, it } from 'vitest';
import {
  assertRepoAllowedForMint,
  contestedBandDistance,
  inInformativeBand,
  loadMintRepoDenylist,
} from '../../src/solver-types/_swe-rebench-v2-guards.js';
import { computeExemplarPairYield } from '../../src/solver-types/_swe-rebench-v2-yield.js';
import {
  buildHunkSubsetEcho,
  splitPatchHunks,
} from '../../src/solver-types/_swe-rebench-v2-hunk-echo.js';
import { deriveF2pP2pFromReports } from '../../src/solver-types/_swe-rebench-v2-empirical-tests.js';
import { RoutingTaskRowFetcher } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/routing-task-row-fetcher.js';

describe('task-creator guards', () => {
  it('rejects mint from held-out slate repo', () => {
    const denylist = loadMintRepoDenylist();
    if (denylist.repos.size === 0) return;
    const repo = [...denylist.repos][0]!;
    expect(() => assertRepoAllowedForMint(repo, denylist)).toThrow(/held-out/);
  });

  it('contested band prefers 50% solve rate', () => {
    expect(contestedBandDistance(0.5)).toBeLessThan(contestedBandDistance(0.1));
    expect(inInformativeBand(0.5)).toBe(true);
    expect(inInformativeBand(0.05)).toBe(false);
  });
});

describe('exemplar pair yield', () => {
  it('counts instances with both pass and fail', () => {
    const report = computeExemplarPairYield([
      { instanceId: 'a', passes: 1, fails: 1 },
      { instanceId: 'b', passes: 1, fails: 0 },
    ]);
    expect(report.exemplarPairs).toBe(1);
  });
});

describe('hunk-subset echo', () => {
  it('builds echo candidate from hunk', () => {
    const patch = '@@ -1 +1 @@\n-old\n+new\n';
    const hunks = splitPatchHunks(patch);
    expect(hunks.length).toBeGreaterThan(0);
    const echo = buildHunkSubsetEcho({
      sourceInstanceId: 'acme__widget-1',
      repo: 'acme/widget',
      solverPatch: patch,
      hunk: hunks[0]!,
      baseCommit: 'abc',
    });
    expect(echo.instance_id).toContain('hunk-');
  });
});

describe('empirical F2P/P2P', () => {
  it('derives flip tests', () => {
    const r = deriveF2pP2pFromReports(
      { passed: ['t1'], failed: ['t2'], passed_match: false },
      { passed: ['t1', 't2'], failed: [], passed_match: true },
      ['t1', 't2'],
    );
    expect(r.FAIL_TO_PASS).toEqual(['t2']);
    expect(r.dead).toBe(false);
  });
});

describe('RoutingTaskRowFetcher', () => {
  it('fetches minted rows from ipfs artifact', async () => {
    const fetcher = new RoutingTaskRowFetcher({
      hf: { fetchTaskRow: async () => { throw new Error('hf'); } },
      fetchMintedArtifact: async () => ({
        schemaVersion: 'swe-rebench-v2-minted-pool.v1',
        evalSemanticsVersion: '4',
        generatedAt: new Date().toISOString(),
        rows: [{
          instance_id: 'mint-1',
          repo: 'acme/widget',
          image_name: 'img:tag',
          FAIL_TO_PASS: ['t1'],
          PASS_TO_PASS: [],
          test_patch: '',
          install_config: { test_cmd: 'pytest', log_parser: 'parse_log_pytest' },
        }],
      }),
    });
    const row = await fetcher.fetchTaskRow({
      hf_dataset: 'ipfs://bafytest',
      hf_split: 'minted',
      instance_id: 'mint-1',
    });
    expect(row.repo).toBe('acme/widget');
  });
});
