/**
 * Freeze-mode lifecycle integration test.
 *
 * Public command: `yarn e2e:freeze-mode`
 *
 * Option B (lightweight integration): exercises the daemon-config → engine →
 * freeze-fence → envelope path using `runHarnessOnce` directly, without
 * spawning Anvil or submitting on-chain. This is sufficient for v1 confidence:
 * the substantive freeze-mode contract (snapshot / hash / rollback) is verified
 * end-to-end at the daemon-engine boundary. Full Anvil-fork integration
 * (on-chain settlement under freeze-mode) is deferred to a later integration
 * sprint.
 *
 * Three cases:
 *   1. Train mode: codeDigest mutates between Tasks (harness may write).
 *   2. Frozen mode: codeDigest is stable across Tasks (harness reads only).
 *   3. Frozen mode: deliberate-violation harness is caught; envelope is NOT
 *      produced; implStateDir is rolled back to pre-run state.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6.3
 *
 * DONE_WITH_CONCERNS: Anvil-fork path (full on-chain settlement in freeze mode)
 * is not covered here. The unit coverage in
 * test/harnesses/engine/engine-mode.test.ts covers the same fence logic;
 * this file adds the e2e entry point and runPhase scaffolding. Full
 * Anvil-fork integration deferred to the Phase A integration sprint.
 */

import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarnessOnce } from '../../src/harnesses/engine/engine.js';
import { runHarnessWithFreezeFence } from '../../src/daemon/freeze-fence.js';
import { hashImplStateDir } from '../../src/harnesses/freeze.js';
import {
  runEval,
  FreezeFenceViolationError,
  type EvalOrchestratorDeps,
  type RunHarnessOnceForEval,
} from '../../src/eval/orchestrator.js';
import type { ResolvedSlateTask } from '../../src/eval/resolve-slate-tasks.js';
import type { LoadedHeldOutSlate } from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';
import type { HarnessCheckpointManifest } from '@jinn-network/sdk/checkpoint';
import type { HfRow } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { Store } from '../../src/store/store.js';
import type { Harness, HarnessContext, Solution } from '../../src/harnesses/types.js';
import { runPhase, summarize, assert } from './task-first-helpers.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function stubSolution(overrides: Partial<Solution> = {}): Solution {
  return { venueRef: { name: 'test' }, gating: {}, ...overrides };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'jinn-freeze-e2e-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── Test cases ────────────────────────────────────────────────────────────────

/**
 * Case 1: train mode — codeDigest mutates between Tasks.
 *
 * Each call to `runHarnessOnce` in train mode should return a different
 * `executor.codeDigest` because the harness writes a new file each time,
 * mutating `implStateDir`.
 */
async function runTrainModeMutatesDigest(): Promise<void> {
  await withTempDir(async (implStateDir) => {
    let callCount = 0;
    const harness: Harness = {
      name: 'writing-harness',
      version: '0.1.0',
      supports: () => true,
      async run(ctx) {
        callCount++;
        // Write a new file each time — legitimate in train mode.
        await writeFile(join(ctx.implStateDir, `run-${callCount}.txt`), `run ${callCount} data`);
        return stubSolution();
      },
    };

    const result1 = await runHarnessOnce({ harness, implStateDir, mode: 'train' });
    const result2 = await runHarnessOnce({ harness, implStateDir, mode: 'train' });

    assert(!result1.violation, 'train run 1: unexpected violation');
    assert(!result2.violation, 'train run 2: unexpected violation');
    assert(result1.envelope !== undefined, 'train run 1: envelope must be present');
    assert(result2.envelope !== undefined, 'train run 2: envelope must be present');

    assert(
      result1.envelope.executor.mode === 'train',
      `train run 1: executor.mode must be "train", got "${result1.envelope.executor.mode}"`,
    );
    assert(
      result2.envelope.executor.mode === 'train',
      `train run 2: executor.mode must be "train", got "${result2.envelope.executor.mode}"`,
    );

    assert(
      result1.envelope.executor.codeDigest !== result2.envelope.executor.codeDigest,
      `train mode: codeDigest must mutate between Tasks (both were ${result1.envelope.executor.codeDigest})`,
    );

    process.stdout.write(
      `  run1.codeDigest=${result1.envelope.executor.codeDigest.slice(0, 20)}… ` +
      `run2.codeDigest=${result2.envelope.executor.codeDigest.slice(0, 20)}… (differ, as expected)\n`,
    );
  });
}

/**
 * Case 2: frozen mode — codeDigest is stable across Tasks.
 *
 * When the harness is read-only (frozen-compliant), consecutive calls in
 * frozen mode must return the same `executor.codeDigest` — the state hash
 * does not change.
 */
async function runFrozenModeStableDigest(): Promise<void> {
  await withTempDir(async (implStateDir) => {
    // Pre-populate so the hash is over real content.
    await writeFile(join(implStateDir, 'knowledge.json'), JSON.stringify({ version: 1 }));

    const harness: Harness = {
      name: 'readonly-harness',
      version: '0.1.0',
      supports: () => true,
      async run() {
        // Frozen-compliant: no writes to implStateDir.
        return stubSolution();
      },
    };

    const result1 = await runHarnessOnce({ harness, implStateDir, mode: 'frozen' });
    const result2 = await runHarnessOnce({ harness, implStateDir, mode: 'frozen' });

    assert(!result1.violation, 'frozen run 1: unexpected violation');
    assert(!result2.violation, 'frozen run 2: unexpected violation');
    assert(result1.envelope !== undefined, 'frozen run 1: envelope must be present');
    assert(result2.envelope !== undefined, 'frozen run 2: envelope must be present');

    assert(
      result1.envelope.executor.mode === 'frozen',
      `frozen run 1: executor.mode must be "frozen", got "${result1.envelope.executor.mode}"`,
    );
    assert(
      result2.envelope.executor.mode === 'frozen',
      `frozen run 2: executor.mode must be "frozen", got "${result2.envelope.executor.mode}"`,
    );

    assert(
      result1.envelope.executor.codeDigest === result2.envelope.executor.codeDigest,
      `frozen mode: codeDigest must be stable across Tasks ` +
      `(got ${result1.envelope.executor.codeDigest} vs ${result2.envelope.executor.codeDigest})`,
    );

    process.stdout.write(
      `  codeDigest=${result1.envelope.executor.codeDigest.slice(0, 20)}… (stable across 2 runs)\n`,
    );
  });
}

/**
 * Case 3: frozen mode — deliberate-violation harness detected; envelope
 * rejected; implStateDir rolled back.
 *
 * A harness that writes to `implStateDir` in frozen mode violates the
 * contract. The fence must:
 *   a) return `{ violation }` (no `envelope`),
 *   b) roll back implStateDir to its pre-run state.
 */
async function runFrozenModeViolationRejectedAndRolledBack(): Promise<void> {
  await withTempDir(async (implStateDir) => {
    // Pre-populate one file so we can verify rollback.
    await writeFile(join(implStateDir, 'baseline.json'), JSON.stringify({ stable: true }));

    const harness: Harness = {
      name: 'bad-actor-harness',
      version: '0.1.0',
      supports: () => true,
      async run(ctx) {
        // Deliberate violation: write a forbidden file.
        await writeFile(join(ctx.implStateDir, 'forbidden.txt'), 'should not persist');
        return stubSolution();
      },
    };

    const result = await runHarnessOnce({ harness, implStateDir, mode: 'frozen' });

    // Envelope must be absent.
    assert(result.envelope === undefined, 'violation: envelope must NOT be produced');

    // Violation metadata must be present and correct.
    assert(result.violation !== undefined, 'violation: violation object must be present');
    assert(
      result.violation.harnessName === 'bad-actor-harness',
      `violation: harnessName must be "bad-actor-harness", got "${result.violation.harnessName}"`,
    );
    assert(
      result.violation.stateHashBefore !== result.violation.stateHashAfter,
      'violation: stateHashBefore and stateHashAfter must differ',
    );

    // implStateDir must be rolled back: only baseline.json survives.
    const remaining = await readdir(implStateDir);
    assert(
      remaining.length === 1 && remaining[0] === 'baseline.json',
      `violation: rollback must restore only baseline.json; found [${remaining.join(', ')}]`,
    );

    process.stdout.write(
      `  violation detected: harnessName=${result.violation.harnessName} ` +
      `hashBefore=${result.violation.stateHashBefore.slice(0, 12)}… ` +
      `hashAfter=${result.violation.stateHashAfter.slice(0, 12)}…\n` +
      `  implStateDir rolled back: [${remaining.join(', ')}]\n`,
    );
  });
}

// ── Tier-1 eval-orchestrator CI smoke (issue #819) ──────────────────────────────
//
// DR-2026-05-28 §4 Tier 1: drive `runEval` end-to-end against a tiny mocked
// slate (1–2 tasks) through the REAL freeze machinery
// (`runHarnessWithFreezeFence` + a real temp implStateDir) with a MOCKED harness
// + MOCKED evaluator. No Docker, no IPFS, no network. This protects the exam
// machinery from silently rotting — it does NOT measure learning. Distinct from
// the unit tests in test/eval/orchestrator.test.ts, which mock the fence itself;
// here the fence is real.

const SLATE: LoadedHeldOutSlate = {
  version: 'v1',
  hash: 'sha256:slate',
  instanceIds: new Set(['smoke-1', 'smoke-2']),
};

function smokeRow(instance_id: string): HfRow {
  return {
    instance_id,
    repo: 'org/repo',
    image_name: `img-${instance_id}`,
    FAIL_TO_PASS: ['t1'],
    PASS_TO_PASS: ['t2'],
    test_patch: 'diff',
    install_config: { test_cmd: 'pytest', log_parser: 'pytest' },
  };
}

function smokeTask(instance_id: string): ResolvedSlateTask {
  return {
    task: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id,
      repo: 'org/repo',
      base_commit: '0'.repeat(40),
      language: 'python',
      problem_statement: '',
      interface: '',
      hf_dataset: 'nebius/SWE-rebench',
      hf_split: '2026_02',
      deadline_unix: 1,
      round_month: '2026-02',
    },
    row: smokeRow(instance_id),
  };
}

/**
 * Adapter that wires the orchestrator's injected `runHarnessOnce` seam to the
 * REAL `runHarnessWithFreezeFence`, surfacing the harness `solution` (the
 * production engine `runHarnessOnce` does not). This is the real frozen-mode
 * snapshot/hash/rollback path the orchestrator depends on.
 */
function realFenceRunHarnessOnce(): RunHarnessOnceForEval {
  return async ({ harness, implStateDir, mode, task }) => {
    const ctx: HarnessContext = {
      task: task ?? { id: 'smoke', description: '', role: 'restoration', window: { startTs: 0, endTs: Date.now() + 3_600_000 } },
      implStateDir,
      workingDir: implStateDir,
      log: () => {},
      abort: new AbortController().signal,
      msUntilEndTs: () => 3_600_000,
      mode,
    } as unknown as HarnessContext;

    const fence = await runHarnessWithFreezeFence(harness, ctx);
    if (!fence.ok) {
      return { violation: { taskId: fence.violation.taskId } };
    }
    const patch = (fence.output as { solutionPayload?: { patch?: string } }).solutionPayload?.patch ?? '';
    return {
      envelope: { executor: { mode, codeDigest: `sha256:${fence.codeDigest}` } },
      solution: { patch },
    };
  };
}

/** Deterministic mocked evaluator: 'smoke-1' passes, everything else fails. No Docker. */
function smokeEvaluator(): EvalOrchestratorDeps['evaluator'] {
  return {
    grade: async ({ task }: { task: { instance_id: string } }) => ({
      schemaVersion: 'swe-rebench-v2-verdict.v1' as const,
      score: task.instance_id === 'smoke-1' ? (1 as const) : (0 as const),
      passed_match: task.instance_id === 'smoke-1',
      evaluator_cost_usd: 0,
      test_log: `deterministic-log-${task.instance_id}`,
    }),
  } as unknown as EvalOrchestratorDeps['evaluator'];
}

/**
 * AC#1: drive the orchestrator deterministically over a 2-task slate through
 * the real freeze-fence with a read-only mocked harness; assert per-task
 * results are recorded in a real in-memory store.
 */
async function runOrchestratorSmokeRecordsResults(): Promise<void> {
  await withTempDir(async (implStateDir) => {
    // Pre-populate so the frozen hash is over real content, and pin the
    // checkpoint manifest's codeDigest to the real hash so the C1 guard passes.
    await writeFile(join(implStateDir, 'knowledge.json'), JSON.stringify({ version: 1 }));
    const codeDigest = `sha256:${await hashImplStateDir(implStateDir)}`;

    const harness: Harness = {
      name: 'smoke-readonly-harness',
      version: '0.1.0',
      supports: () => true,
      async run() {
        // Frozen-compliant: no writes. Emits a fixed patch to grade.
        return { venueRef: { name: 'smoke' }, gating: {}, solutionPayload: { patch: 'fixed-patch' } } as Solution;
      },
    };

    const store = new Store(':memory:');
    try {
      // Seed the parent checkpoint so the AC#2 comparison has a denominator.
      for (const id of ['smoke-1', 'smoke-2']) {
        store.recordEvalResult({
          checkpoint_cid: 'cid-parent', slate_hash: SLATE.hash, slate_version: SLATE.version,
          instance_id: id, passed: id === 'smoke-1', unscorable: false, code_digest: codeDigest, run_at_ms: 0,
        });
      }

      const manifest = {
        parentCheckpointCid: 'cid-parent',
        implStateDirCid: 'impl-cid',
        codeDigest,
      } as unknown as HarnessCheckpointManifest;

      const result = await runEval({
        checkpointManifest: manifest,
        checkpointCid: 'cid-child',
        slate: SLATE,
        tasksWithRows: [smokeTask('smoke-1'), smokeTask('smoke-2')],
        parentCheckpointCid: 'cid-parent',
        implStateDir,
        deps: {
          harness,
          // Impl-state is already on disk at `implStateDir`; fetch is a no-op.
          fetchImplStateDirToLocal: async (_cid, dir) => dir,
          evaluator: smokeEvaluator(),
          runHarnessOnce: realFenceRunHarnessOnce(),
          store,
        },
      });

      assert(result.perTask.length === 2, `expected 2 per-task results, got ${result.perTask.length}`);
      assert(
        result.perTask[0].instance_id === 'smoke-1' && result.perTask[0].passed === true,
        'smoke-1 must be recorded as passed',
      );
      assert(
        result.perTask[1].instance_id === 'smoke-2' && result.perTask[1].passed === false,
        'smoke-2 must be recorded as failed',
      );

      // Per-task results are durably recorded in the real store (AC#1).
      const persisted = store.getEvalResults('cid-child', SLATE.version);
      assert(persisted.length === 2, `store must hold 2 per-task rows, got ${persisted.length}`);
      assert(
        persisted.every((r) => r.code_digest === codeDigest),
        'persisted rows must carry the checkpoint codeDigest',
      );

      process.stdout.write(
        `  recorded ${persisted.length} per-task results: ` +
        persisted.map((r) => `${r.instance_id}=${r.passed}`).join(', ') + '\n',
      );
    } finally {
      store.close();
    }
  });
}

/**
 * AC#2: a mocked harness that MUTATES implStateDir during a frozen-mode run is
 * caught by the real freeze-fence; the orchestrator throws
 * FreezeFenceViolationError and records nothing.
 */
async function runOrchestratorSmokeFreezeFenceCatchesMutation(): Promise<void> {
  await withTempDir(async (implStateDir) => {
    await writeFile(join(implStateDir, 'baseline.json'), JSON.stringify({ stable: true }));
    const codeDigest = `sha256:${await hashImplStateDir(implStateDir)}`;

    const mutatingHarness: Harness = {
      name: 'smoke-bad-actor-harness',
      version: '0.1.0',
      supports: () => true,
      async run(ctx) {
        // Deliberate frozen-mode violation: write a forbidden file.
        await writeFile(join(ctx.implStateDir, 'forbidden.txt'), 'should not persist');
        return { venueRef: { name: 'smoke' }, gating: {}, solutionPayload: { patch: 'tainted' } } as Solution;
      },
    };

    const store = new Store(':memory:');
    try {
      const manifest = {
        parentCheckpointCid: 'cid-parent',
        implStateDirCid: 'impl-cid',
        codeDigest,
      } as unknown as HarnessCheckpointManifest;

      let threw: unknown;
      try {
        await runEval({
          checkpointManifest: manifest,
          checkpointCid: 'cid-child',
          slate: SLATE,
          tasksWithRows: [smokeTask('smoke-1')],
          parentCheckpointCid: 'cid-parent',
          implStateDir,
          deps: {
            harness: mutatingHarness,
            fetchImplStateDirToLocal: async (_cid, dir) => dir,
            evaluator: smokeEvaluator(),
            runHarnessOnce: realFenceRunHarnessOnce(),
            store,
          },
        });
      } catch (err) {
        threw = err;
      }

      assert(
        threw instanceof FreezeFenceViolationError,
        `expected FreezeFenceViolationError, got ${threw instanceof Error ? threw.constructor.name : String(threw)}`,
      );

      // Nothing recorded: the tainted instance never reaches the store (AC#2).
      const persisted = store.getEvalResults('cid-child', SLATE.version);
      assert(persisted.length === 0, `freeze violation must record nothing, found ${persisted.length} rows`);

      // The real fence rolled implStateDir back: only baseline.json survives.
      const remaining = await readdir(implStateDir);
      assert(
        remaining.length === 1 && remaining[0] === 'baseline.json',
        `fence must roll back implStateDir; found [${remaining.join(', ')}]`,
      );

      process.stdout.write(
        `  freeze-fence caught frozen-mode mutation: FreezeFenceViolationError thrown, ` +
        `0 rows recorded, implStateDir rolled back to [${remaining.join(', ')}]\n`,
      );
    } finally {
      store.close();
    }
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const results = [];

  results.push(await runPhase(
    'freeze-mode / train mode: codeDigest mutates between Tasks',
    runTrainModeMutatesDigest,
  ));

  results.push(await runPhase(
    'freeze-mode / frozen mode: codeDigest stable across Tasks',
    runFrozenModeStableDigest,
  ));

  results.push(await runPhase(
    'freeze-mode / frozen mode: violation harness rejected + implStateDir rolled back',
    runFrozenModeViolationRejectedAndRolledBack,
  ));

  // Tier-1 eval-orchestrator CI smoke (issue #819).
  results.push(await runPhase(
    'eval-orchestrator smoke / records per-task results over a tiny mocked slate (real fence)',
    runOrchestratorSmokeRecordsResults,
  ));

  results.push(await runPhase(
    'eval-orchestrator smoke / freeze-fence catches a frozen-mode mutation, records nothing',
    runOrchestratorSmokeFreezeFenceCatchesMutation,
  ));

  summarize(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
