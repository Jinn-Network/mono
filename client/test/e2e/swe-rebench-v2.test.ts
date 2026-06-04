/**
 * swe-rebench-v2 SolverNet pipeline composition e2e.
 *
 * Public command: `yarn e2e:swe-rebench-v2`
 *
 * Option B (lightweight integration): exercises pool builder + state store +
 * generator policy + escrow calculator + evaluator with mocked HF fetcher and
 * mocked eval-runner. Verifies the pipeline composes correctly end-to-end
 * without Anvil, Docker pulls, or on-chain calls.
 *
 * Cases:
 *   1. Pool builder + policy → picks eligible task, skips saturated.
 *   2. Escrow calculator → produces sensible wei value for realistic inputs.
 *   3. Evaluator (mocked deps) → emits passing Verdict on passed_match=true.
 *   4. State-update after 5 successes saturates a task; policy moves on.
 *   5. Full loop: pool → policy → grade → state-update → re-select closes
 *      the lifecycle round-trip.
 *
 * Full Anvil-fork e2e (on-chain Task posting via JinnRouter, real Docker
 * pulls for the eval container) is deferred to the Phase A.5 integration
 * sprint.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §9.2
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  selectNextPostingCandidate,
  DEFAULT_GENERATOR_CONFIG,
} from '../../src/solver-types/swe-rebench-v2-auto.js';
import { GeneratorStateStore } from '../../src/solver-types/_swe-rebench-v2-state.js';
import { buildHistoricalPool } from '../../src/solver-types/_swe-rebench-v2-pool.js';
import { computeEscrowWei } from '../../src/solver-types/_swe-rebench-v2-escrow.js';
import { SweRebenchV2Evaluator } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { runPhase, summarize, assert } from './task-first-helpers.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_ROWS = [
  { instance_id: 'unidata__netcdf-c-1925', language: 'c' },
  { instance_id: 'org__repo-42',           language: 'python' },
  { instance_id: 'org__repo-43',           language: 'go' },
];

const MOCK_HF_ROW = {
  instance_id: 'unidata__netcdf-c-1925',
  image_name: 'docker.io/swerebenchv2/unidata__netcdf-c-1925:latest',
  FAIL_TO_PASS: ['test_issue_1925'],
  PASS_TO_PASS: ['test_existing'],
  test_patch: 'diff --git a/test.c b/test.c\n+/* stub */',
  install_config: { test_cmd: 'make test', log_parser: 'pytest' },
};

const MOCK_TASK = {
  schemaVersion: 'swe-rebench-v2.v1' as const,
  instance_id: 'unidata__netcdf-c-1925',
  repo: 'unidata/netcdf-c',
  base_commit: 'a'.repeat(40),
  language: 'c' as const,
  problem_statement: 'Fix netcdf issue 1925',
  interface: '',
  hf_dataset: 'nebius/SWE-rebench-leaderboard',
  hf_split: '2026_02',
  deadline_unix: Math.floor(Date.now() / 1000) + 3600,
  round_month: '2026-02',
};

const MOCK_SOLUTION_PAYLOAD = {
  patch: '--- a/nc_test.c\n+++ b/nc_test.c\n@@ -1 +1 @@\n-broken\n+fixed',
};

// ── Evaluator mock factory ─────────────────────────────────────────────────────

function makeMockEvaluator(opts: { passedMatch: boolean }) {
  return new SweRebenchV2Evaluator({
    fetcher: {
      fetchTaskRow: async () => MOCK_HF_ROW,
    },
    runner: {
      runEval: async () => ({
        passed_match: opts.passedMatch,
        passed: opts.passedMatch ? ['test_issue_1925'] : [],
        failed: opts.passedMatch ? [] : ['test_issue_1925'],
        log: 'mock eval log',
        exitCode: 0,
      }),
    },
  });
}

// ── Test phases ───────────────────────────────────────────────────────────────

async function runPoolAndPolicy(): Promise<void> {
  const pool = await buildHistoricalPool({
    months: ['2026_02', '2026_03'],
    fetchSplit: async (split) => {
      // First split returns all three rows; second split re-emits the first
      // to verify deduplication (first-seen wins).
      if (split === '2026_02') return FAKE_ROWS;
      return [{ instance_id: 'unidata__netcdf-c-1925', language: 'c' }];
    },
  });

  assert(pool.length === 3, `pool should have 3 deduplicated tasks, got ${pool.length}`);
  assert(
    pool.every((t) => t.hf_dataset === 'nebius/SWE-rebench-leaderboard'),
    'all pool tasks should carry hf_dataset',
  );

  // All tasks start with zero counters → first eligible task is picked.
  const counters = new Map<string, any>();
  const next = selectNextPostingCandidate({
    pool,
    counters,
    config: DEFAULT_GENERATOR_CONFIG,
    now: Date.now(),
  });
  assert(next !== undefined, 'policy should return a candidate from a fresh pool');
  // selectNextPostingCandidate tie-breaks by instance_id alphabetically;
  // 'org__repo-42' < 'org__repo-43' < 'unidata__netcdf-c-1925'.
  assert(
    next!.instance_id === 'org__repo-42',
    `expected org__repo-42 (alphabetically first), got ${next?.instance_id}`,
  );

  // Mark netcdf task as saturated (5 successes), verify policy skips to next.
  counters.set('unidata__netcdf-c-1925', { posted: 5, successful: 5, last_posted_at: 0 });
  const next2 = selectNextPostingCandidate({
    pool,
    counters,
    config: DEFAULT_GENERATOR_CONFIG,
    now: Date.now(),
  });
  assert(next2 !== undefined, 'policy should return another candidate after saturation');
  assert(
    next2!.instance_id !== 'unidata__netcdf-c-1925',
    'saturated task must not be selected again',
  );
}

async function runEscrowCalculator(): Promise<void> {
  const baseWei = 1_000_000_000_000_000_000n; // 1 ETH in wei

  // Minimal complexity → multiplier close to 1.
  const minimal = computeEscrowWei({
    loc: 0, files: 0, tests: 0,
    params: {
      base_escrow_wei: baseWei,
      alpha: 0.5, beta: 0.3, gamma: 0.2,
      loc_normalizer: 100, files_normalizer: 5, tests_normalizer: 10,
    },
  });
  assert(minimal >= baseWei, `minimal escrow should be >= base; got ${minimal}`);

  // Realistic complexity for the unidata__netcdf-c-1925 fixture (50 LoC, 3 files, 5 tests).
  const realistic = computeEscrowWei({
    loc: 50, files: 3, tests: 5,
    params: {
      base_escrow_wei: baseWei,
      alpha: 0.5, beta: 0.3, gamma: 0.2,
      loc_normalizer: 100, files_normalizer: 5, tests_normalizer: 10,
    },
  });
  assert(realistic > baseWei, `realistic escrow should exceed base; got ${realistic}`);

  // High complexity → capped at MAX_MULTIPLIER × base (5×).
  const high = computeEscrowWei({
    loc: 10_000, files: 1_000, tests: 1_000,
    params: {
      base_escrow_wei: baseWei,
      alpha: 0.5, beta: 0.3, gamma: 0.2,
      loc_normalizer: 100, files_normalizer: 5, tests_normalizer: 10,
    },
  });
  const cap = 5n * baseWei;
  assert(high <= cap, `high-complexity escrow should be capped at 5× base; got ${high}, cap=${cap}`);
}

async function runEvaluatorPassing(): Promise<void> {
  const evaluator = makeMockEvaluator({ passedMatch: true });
  const verdict = await evaluator.grade({
    task: MOCK_TASK,
    solutionPayload: MOCK_SOLUTION_PAYLOAD,
  });
  assert(verdict.passed_match === true, `verdict.passed_match should be true, got ${verdict.passed_match}`);
  assert(verdict.score === 1, `passing verdict should have score=1, got ${verdict.score}`);
  // #1019: the harness publishes the GRADED v2 verdict (passedCount/totalCount),
  // not the binary v1 — Tier 2 of the learner's two-tier gate consumes the counts.
  assert(verdict.schemaVersion === 'swe-rebench-v2-verdict.v2', `schemaVersion should be v2, got ${verdict.schemaVersion}`);
  assert(verdict.passedCount === 1, `passing verdict passedCount should be 1, got ${verdict.passedCount}`);
  assert(verdict.totalCount === 1, `passing verdict totalCount should be 1, got ${verdict.totalCount}`);
}

async function runEvaluatorFailing(): Promise<void> {
  const evaluator = makeMockEvaluator({ passedMatch: false });
  const verdict = await evaluator.grade({
    task: MOCK_TASK,
    solutionPayload: MOCK_SOLUTION_PAYLOAD,
  });
  assert(verdict.passed_match === false, `verdict.passed_match should be false, got ${verdict.passed_match}`);
  assert(verdict.score === 0, `failing verdict should have score=0, got ${verdict.score}`);
  // #1019: a failing grade still emits v2 with real counts (0 of N passed), so a
  // 0/N graded verdict is distinguishable from a v1/no-counts verdict on-chain.
  assert(verdict.schemaVersion === 'swe-rebench-v2-verdict.v2', `schemaVersion should be v2, got ${verdict.schemaVersion}`);
  assert(verdict.passedCount === 0, `failing verdict passedCount should be 0, got ${verdict.passedCount}`);
  assert(verdict.totalCount === 1, `failing verdict totalCount should be 1, got ${verdict.totalCount}`);
}

async function runSaturationPolicy(stateDir: string): Promise<void> {
  const pool = await buildHistoricalPool({
    months: ['2026_02'],
    fetchSplit: async () => FAKE_ROWS,
  });

  const store = new GeneratorStateStore({ stateDir });
  const counters = new Map<string, any>();

  // Record 5 successes for the first task (netcdf), hitting the saturation threshold.
  await store.recordSuccess('unidata__netcdf-c-1925');
  await store.recordSuccess('unidata__netcdf-c-1925');
  await store.recordSuccess('unidata__netcdf-c-1925');
  await store.recordSuccess('unidata__netcdf-c-1925');
  await store.recordSuccess('unidata__netcdf-c-1925');
  counters.set('unidata__netcdf-c-1925', await store.getCounters('unidata__netcdf-c-1925'));

  assert(
    counters.get('unidata__netcdf-c-1925').successful === 5,
    'state store should report 5 successes after 5 recordSuccess calls',
  );

  // Policy must not select the saturated task even when called far in the future.
  const next = selectNextPostingCandidate({
    pool,
    counters,
    config: DEFAULT_GENERATOR_CONFIG,
    now: Date.now() + 48 * 60 * 60 * 1000, // 48 h from now (past cooldown)
  });
  assert(next !== undefined, 'policy should return a non-saturated task');
  assert(
    next!.instance_id !== 'unidata__netcdf-c-1925',
    `saturated task must not be selected; got ${next?.instance_id}`,
  );
}

async function runFullLoop(stateDir: string): Promise<void> {
  // 1. Build pool from fake fetcher.
  const pool = await buildHistoricalPool({
    months: ['2026_02'],
    fetchSplit: async () => FAKE_ROWS,
  });

  const store = new GeneratorStateStore({ stateDir: join(stateDir, 'full-loop') });
  const counters = new Map<string, any>();

  // 2. Policy selects the first task (all counters zero).
  const selected = selectNextPostingCandidate({
    pool, counters, config: DEFAULT_GENERATOR_CONFIG, now: Date.now(),
  });
  assert(selected !== undefined, 'step 2: policy should select a task from fresh pool');

  // 3. Escrow calculator produces a sensible value for the selected task.
  const escrow = computeEscrowWei({
    loc: 80, files: 4, tests: 8,
    params: {
      base_escrow_wei: 500_000_000_000_000_000n, // 0.5 ETH
      alpha: 0.5, beta: 0.3, gamma: 0.2,
      loc_normalizer: 100, files_normalizer: 5, tests_normalizer: 10,
    },
  });
  assert(escrow >= 500_000_000_000_000_000n, `escrow should be >= base; got ${escrow}`);

  // 4. Evaluator grades the solution as passing.
  const evaluator = makeMockEvaluator({ passedMatch: true });
  const verdict = await evaluator.grade({
    task: MOCK_TASK,
    solutionPayload: MOCK_SOLUTION_PAYLOAD,
  });
  assert(verdict.score === 1, `full-loop: expected passing verdict, got score=${verdict.score}`);

  // 5. Record success in state store and update counters map.
  await store.recordSuccess(selected!.instance_id);
  counters.set(selected!.instance_id, await store.getCounters(selected!.instance_id));
  assert(
    counters.get(selected!.instance_id).successful === 1,
    'full-loop: state store should report 1 success after one recordSuccess',
  );

  // 6. After N_target_successes (5) successes on a task, the policy stops selecting it.
  await store.recordSuccess(selected!.instance_id);
  await store.recordSuccess(selected!.instance_id);
  await store.recordSuccess(selected!.instance_id);
  await store.recordSuccess(selected!.instance_id);
  counters.set(selected!.instance_id, await store.getCounters(selected!.instance_id));
  const saturated = counters.get(selected!.instance_id);
  assert(
    saturated.successful === 5,
    `full-loop: expected 5 successes, got ${saturated.successful}`,
  );

  const next = selectNextPostingCandidate({
    pool, counters, config: DEFAULT_GENERATOR_CONFIG,
    now: Date.now() + 48 * 60 * 60 * 1000,
  });
  assert(next !== undefined, 'full-loop: policy should return another task after saturation');
  assert(
    next!.instance_id !== selected!.instance_id,
    `full-loop: saturated task ${selected!.instance_id} must not be re-selected`,
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

const stateDir = await mkdtemp(join(tmpdir(), 'jinn-swe-rebench-e2e-'));
try {
  const results = await Promise.all([
    runPhase('pool-builder + policy', runPoolAndPolicy),
    runPhase('escrow calculator', runEscrowCalculator),
    runPhase('evaluator — passing verdict', runEvaluatorPassing),
    runPhase('evaluator — failing verdict', runEvaluatorFailing),
    runPhase('saturation policy via state store', () => runSaturationPolicy(stateDir)),
    runPhase('full loop (pool → policy → grade → state-update → re-select)', () =>
      runFullLoop(stateDir),
    ),
  ]);
  summarize(results);
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
