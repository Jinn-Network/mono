/**
 * Train-arm slope on the held-out slate — swe-rebench-v2 (issue #822,
 * successor to #683).
 *
 * Trains the learner harness across a sequence of DISTINCT swe-rebench-v2
 * tasks and evaluates ON THE HELD-OUT SLATE (#817) at intervals via the
 * `jinn eval` orchestrator (#818), reporting the least-squares slope of the
 * resolved rate vs training-cycle index. This is the train-arm of the
 * held-out exam (DR-2026-05-28 §6): #683's named flaw was that it never
 * separated train from test — the held-out slate fixes that, and
 * `buildTrainSequence` (AC#2) guarantees no train/test overlap (the
 * learner-full-cycle path drives `runCycle` directly, bypassing the
 * generator's `excludeHeldOutSlate` train-stream chokepoint).
 *
 * ── Determinism strategy (AC#3) ───────────────────────────────────────────
 * MULTI-RUN AVERAGING with Wilson CIs per interval — NOT fixed-seed. The
 * claude-code / codex adapters expose no temperature/seed knob, so a
 * "fixed-seed deterministic" claim would be false; we accept stochasticity
 * and quantify it with a Wilson confidence interval per interval (same v1
 * methodology the `jinn eval` orchestrator uses). Per DR-2026-05-28 §4.1:
 * only LARGE deltas are trustworthy; a flat/negative slope at small N is
 * "within noise", not a regression — surfaced in the output caveat.
 *
 * IMPORTANT (store constraint, surfaced during impl): `eval_results` has a
 * UNIQUE(checkpoint_cid, slate_version, instance_id) with ON CONFLICT DO
 * UPDATE — so re-running the SAME checkpoint OVERWRITES the prior run rather
 * than summing. True multi-run averaging at R>1 therefore needs distinct
 * checkpoint CIDs per run (or a store-schema change to append runs); it is NOT
 * free with the current schema. The shipped budget runs R=1, so this does not
 * bite v1 — but the R=3 upgrade is gated on that change. See the report.
 *
 * ── Per-run budget (AC#3) ──────────────────────────────────────────────────
 * N = 6 training cycles, evals at cycles {0, 2, 4, 6} (baseline + every K=2),
 * R = 1 eval run per interval (accept a wide CI; only large deltas
 * trustworthy). N/K/R are named constants below.
 *
 * Gates like `jinn eval`: skips cleanly when the configured learner CLI, the
 * swe-rebench-v2 evaluator (Docker/HF), or the SWE-rebench pool is
 * unavailable — it is a real N×(slate) Docker eval workload.
 *
 * Configure with:
 *   JINN_E2E_LEARNER_HARNESS=claude-code | codex
 *   JINN_E2E_LEARNER_CLI_PATH=/path/to/claude-or-codex
 *   JINN_E2E_LEARNER_MODEL=...
 *   JINN_SWE_REBENCH_V2_STATE_DIR=...  (pool cache + evaluator state root)
 *
 * Usage:
 *   yarn e2e:train-arm-slope
 *
 * Issue #822.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../../src/types/task.js';
import type { Harness, RuntimePlugin } from '../../src/harnesses/types.js';
import type { HarnessCheckpointManifest } from '@jinn-network/sdk/checkpoint';
import { loadConfig } from '../../src/config.js';
import { Store } from '../../src/store/store.js';
import { hashImplStateDir, harnessHashOptions } from '../../src/harnesses/freeze.js';
import {
  loadHeldOutSlate,
  type LoadedHeldOutSlate,
} from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';
import { loadSweRebenchV2Pool, defaultStateDir } from '../../src/solver-types/swe-rebench-v2.js';
import {
  PoolCacheStore,
  loadPoolWithCacheFallback,
} from '../../src/solver-types/_swe-rebench-v2-pool-cache.js';
import { resolveSlateTasks } from '../../src/eval/resolve-slate-tasks.js';
import { runEval, type RunHarnessOnceForEval } from '../../src/eval/orchestrator.js';
import { resolveRuntimePluginsForSolverType, runHarnessForEval } from '../../src/eval/eval-harness-run.js';
import { leastSquaresSlope, type RatePoint } from '../../src/eval/slope.js';
import { buildTrainSequence } from '../../src/eval/train-sequence.js';
import { wilsonInterval } from '../../src/eval/wilson.js';
import { SweRebenchV2Evaluator } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { HttpHfFetcher } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PythonEvalRunner } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import { readEnabledState } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import {
  seedWorkingRepo,
  resolveSweLearnerPluginRoots,
  E2E_SWE_JOINED,
} from './fixtures/swe-rebench-v2-learner-e2e.js';
import { runCycle, LEARNER_SEVEN_PHASE_LINES, type CycleParams } from './learner-full-cycle-core.js';
import { bootstrapLearnerFullCycleE2e, logLearnerHarnessBanner } from './learner-harness-config.js';

// ── Per-run budget (AC#3) — named constants ────────────────────────────────
/** N training cycles over the training sequence. */
const N_TRAIN_CYCLES = 6;
/** Eval at cycle 0 (baseline) and every K cycles thereafter. */
const EVAL_EVERY_K = 2;
/** R eval runs per interval (multi-run averaging tightens the Wilson CI). */
const RUNS_PER_INTERVAL = 1;

const SLATE_VERSION = 'v1';
const SOLVER_TYPE = 'swe-rebench-v2';
const SOLVER_NET_NAME = 'train-arm-slope-swe-rebench-v2-e2e';
const EVAL_RUN_BUDGET_MS = 3_600_000;

/** The §4.1 honesty caveat — printed verbatim in the output. */
const HONESTY_CAVEAT =
  'Determinism: Wilson CI per interval (multi-run-averaging methodology, R=' +
  RUNS_PER_INTERVAL +
  '/interval), NOT fixed-seed (the adapters expose no seed/temp knob). ' +
  'Per DR-2026-05-28 §4.1: agent runs are stochastic; only LARGE deltas are ' +
  'trustworthy. A flat or negative slope at this N is WITHIN NOISE, not a ' +
  'regression — this exam confirms large improvements, it is not a microscope ' +
  'for 1pp changes.';

const beforeSweHarnessRun = ({ workingDir }: Pick<CycleParams, 'workingDir'>) => seedWorkingRepo(workingDir);

/** Build a training task for one cycle, keyed to a DISTINCT pool instance_id. */
function buildTrainTaskForCycle(instanceId: string) {
  return (
    params: CycleParams,
    goal: { id: string; description: string; kind: string; deadline: number; spec: Record<string, unknown> },
    startTs: number,
    endTs: number,
  ): Task => {
    const baseCommit = goal.spec.base_commit as string;
    return {
      id: params.goalId,
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
      description: [
        goal.description,
        '',
        'IMPORTANT: The repository is ALREADY checked out at workingDir/repo at base_commit.',
        'Do NOT clone from GitHub or Hugging Face. Do NOT use Docker or the eval runner.',
        'All SWE edits belong under workingDir/repo only.',
        '',
        LEARNER_SEVEN_PHASE_LINES,
        'For Improve: write at least one trivial change under implStateDir/notes/ so learning state mutates.',
        'Exit cleanly when all phases are done.',
      ].join('\n'),
      window: { startTs, endTs },
      spec: {
        schemaVersion: 'swe-rebench-v2.v1',
        instance_id: instanceId,
        repo: 'jinn/e2e-local-fixture',
        base_commit: baseCommit,
        language: 'text',
        problem_statement:
          'Append a line "e2e-ok" to README.md under workingDir/repo. No external network.',
        interface: '',
        hf_dataset: 'nebius/SWE-rebench-leaderboard',
        hf_split: '2026_02',
        deadline_unix: Math.floor(endTs / 1000),
        round_month: '2026-05',
        goal,
      },
    } as unknown as Task;
  };
}

/** Synthesize a per-checkpoint manifest from the freeze-fence codeDigest. */
function synthesizeManifest(args: {
  implStateDir: string;
  codeDigest: string;
  parentCheckpointCid: string | null;
  implName: string;
}): HarnessCheckpointManifest {
  return {
    schemaVersion: 'harness.checkpoint.v1',
    name: 'train-arm-slope-e2e',
    version: '0.0.0',
    parentCheckpointCid: args.parentCheckpointCid,
    harnessPackage: {
      implName: args.implName,
      implVersion: '0',
      clientGitSha: '0',
      sourceBundleCid: 'e2e-local',
    },
    // No IPFS publish in e2e: the local trick is fetchImplStateDirToLocal:
    // (_cid, dir) => dir, so implStateDirCid carries the on-disk path.
    implStateDirCid: args.implStateDir,
    codeDigest: args.codeDigest,
    publisher: {
      agentId: 'e2e',
      signingKey: 'ed25519:' + '0'.repeat(64),
      safeAddress: '0x' + '0'.repeat(40),
    },
    publishedAt: '2026-05-28T00:00:00.000Z',
    registry: {
      anchor: 'IdentityRegistry.setMetadata',
      metadataKey: 'e2e',
      txHash: '0x' + '0'.repeat(64),
      blockNumber: 1,
    },
    signature: 'e2e',
  };
}

/**
 * The eval `runHarnessOnce` seam — delegates to the shared, daemon-faithful
 * {@link runHarnessForEval} helper (mirrors `cli/commands/eval.ts`). Closing
 * over the resolved `runtimePlugins` + `solverType` is the load-bearing fix:
 * the prior hand-rolled body ran the agent WITHOUT plugins, so it diverged from
 * the CLI/daemon and left every task unscorable (#845 drift). The seam's
 * external shape is unchanged so `runEval` is unaffected.
 */
function makeEvalRunHarnessOnce(opts: {
  solverType: string;
  runtimePlugins: RuntimePlugin[];
  solverNetName?: string;
  model?: string;
}): RunHarnessOnceForEval {
  return async ({ harness, implStateDir, mode, task }) => {
    const resolvedTask = (task ?? {
      id: 'eval-task',
      description: '',
      role: 'restoration' as const,
      window: { startTs: 0, endTs: Date.now() + EVAL_RUN_BUDGET_MS },
    }) as Task;
    return runHarnessForEval({
      harness,
      task: resolvedTask,
      solverType: opts.solverType,
      runtimePlugins: opts.runtimePlugins,
      implStateDir,
      mode,
      ...(opts.solverNetName ? { solverNetName: opts.solverNetName } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    });
  };
}

/** Resolve slate ids → {task,row}, grouped by (dataset, split) (mirrors eval.ts). */
async function resolveSlateAgainstPool(args: {
  slate: LoadedHeldOutSlate;
  fetcher: HttpHfFetcher;
  stateDir: string;
}) {
  const cacheResult = await loadPoolWithCacheFallback({
    loadPool: loadSweRebenchV2Pool,
    cache: new PoolCacheStore({ stateDir: args.stateDir }),
    currentPool: [],
  });
  const pool = cacheResult.pool;
  if (pool.length === 0) throw new Error('SWE-rebench v2 pool is empty');
  const byId = new Map(pool.map((t) => [t.instance_id, t]));
  const groups = new Map<string, { hf_dataset: string; hf_split: string; poolTasks: typeof pool }>();
  for (const id of args.slate.instanceIds) {
    const poolTask = byId.get(id);
    if (!poolTask) throw new Error(`held-out slate instance ${id} not present in the current pool`);
    const key = `${poolTask.hf_dataset} ${poolTask.hf_split}`;
    const group = groups.get(key) ?? { hf_dataset: poolTask.hf_dataset, hf_split: poolTask.hf_split, poolTasks: [] };
    group.poolTasks.push(poolTask);
    groups.set(key, group);
  }
  const out = [];
  for (const group of groups.values()) {
    out.push(
      ...(await resolveSlateTasks({
        poolTasks: group.poolTasks,
        hf_dataset: group.hf_dataset,
        hf_split: group.hf_split,
        fetcher: args.fetcher,
      })),
    );
  }
  return out;
}

interface IntervalRow {
  cycleIndex: number;
  resolved: number;
  scorable: number;
  unscorable: number;
  wilsonInterval: { p: number; lo: number; hi: number };
  checkpointCid: string;
}

async function main(): Promise<void> {
  const boot = bootstrapLearnerFullCycleE2e();
  if (boot.kind === 'skip') {
    console.log(`SKIP: ${boot.reason}`);
    process.exit(0);
  }
  if (boot.kind === 'fail') {
    console.error(`FAIL: ${boot.reason}`);
    process.exit(1);
  }
  const { config: harnessCfg, harness, cliVersion } = boot;
  logLearnerHarnessBanner(harnessCfg, cliVersion);

  // Gate on the swe-rebench-v2 evaluator (Docker/HF). Skip clean — this is a
  // real Docker eval workload, exactly like `jinn eval`.
  const config = loadConfig();
  const implStateDirRoot =
    config.engine?.implStateDirRoot ?? join(homedir(), '.jinn-client', 'engine', 'impl-state');
  const evaluatorImplStateDir = join(implStateDirRoot, 'swe-rebench-v2-evaluator');
  const enabled = readEnabledState(evaluatorImplStateDir);
  if (!enabled) {
    console.log(
      `SKIP: swe-rebench-v2 evaluator not enabled (no state at ${evaluatorImplStateDir}). ` +
        `Run \`jinn harnesses enable swe-rebench-v2-evaluator\` first.`,
    );
    process.exit(0);
  }

  const stateDir = process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] ?? defaultStateDir();
  const fetcher = new HttpHfFetcher();
  const evaluator = new SweRebenchV2Evaluator({
    fetcher,
    runner: new PythonEvalRunner({ upstreamRepoDir: enabled.upstreamRepoDir }),
  });

  // Training cycles consume the plugin `roots`; the eval seam consumes the full
  // `RuntimePlugin[]`. Resolve both from the SAME joined-SolverNet config so the
  // e2e and the CLI share one resolution path (`resolveRuntimePluginsForSolverType`).
  const { roots, names } = await resolveSweLearnerPluginRoots();
  const evalRuntimePlugins = await resolveRuntimePluginsForSolverType(`${SOLVER_TYPE}.v1`, E2E_SWE_JOINED);
  console.log(`runtime plugins: ${names.join(', ')}`);
  console.log('=== train-arm slope swe-rebench-v2 e2e ===\n');

  // Load slate + build a no-overlap training sequence (AC#2).
  const slate = loadHeldOutSlate(`${SOLVER_TYPE}.v1`, SLATE_VERSION);
  let tasksWithRows;
  let trainSequence;
  try {
    tasksWithRows = await resolveSlateAgainstPool({ slate, fetcher, stateDir });
    const poolResult = await loadPoolWithCacheFallback({
      loadPool: loadSweRebenchV2Pool,
      cache: new PoolCacheStore({ stateDir }),
      currentPool: [],
    });
    trainSequence = buildTrainSequence({
      pool: poolResult.pool,
      slateIds: slate.instanceIds,
      count: N_TRAIN_CYCLES,
    });
  } catch (err) {
    console.log(`SKIP: cannot resolve slate/pool (HF unavailable?): ${err instanceof Error ? err.message : err}`);
    process.exit(0);
  }
  console.log(`held-out slate: ${slate.version} (${slate.instanceIds.size} instances)`);
  console.log(`training sequence: ${trainSequence.map((t) => t.instance_id).join(', ')}`);

  const implName = harnessCfg.harnessName;
  const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-trainarm-state-'));
  const dbPath = join(mkdtempSync(join(tmpdir(), 'jinn-trainarm-db-')), 'eval.db');
  const store = new Store(dbPath);
  const runHarnessOnce = makeEvalRunHarnessOnce({
    solverType: `${SOLVER_TYPE}.v1`,
    runtimePlugins: evalRuntimePlugins,
    solverNetName: SOLVER_NET_NAME,
    model: harnessCfg.model,
  });
  const evalDeps = {
    harness: harness as Harness,
    fetchImplStateDirToLocal: async (_cid: string, dir: string) => dir,
    evaluator,
    runHarnessOnce,
    store,
  };

  const rows: IntervalRow[] = [];
  let exitCode = 0;
  try {
    // Run one eval interval at the CURRENT implStateDir, R runs to tighten the
    // Wilson CI. Returns the checkpoint CID (= codeDigest) for the next parent.
    const runInterval = async (cycleIndex: number, parentCheckpointCid: string): Promise<string> => {
      // The checkpoint CID is the freeze-fence codeDigest of the CURRENT frozen
      // impl-state — computed directly (no wasteful probe run); it matches the
      // digest runEval's C1 check derives from the harness envelope. At R=1
      // there is exactly one run per checkpoint. NOTE: re-running the same
      // checkpoint does NOT sum into the aggregate (eval_results ON CONFLICT DO
      // UPDATE overwrites the row) — see the header; R>1 is gated on that.
      const hashOpts = harnessHashOptions(harness);
      const codeDigest = `sha256:${await hashImplStateDir(implStateDir, hashOpts)}`;
      const checkpointCid = codeDigest;
      const manifest = synthesizeManifest({
        implStateDir,
        codeDigest,
        parentCheckpointCid: cycleIndex === 0 ? null : parentCheckpointCid,
        implName,
      });
      for (let r = 0; r < RUNS_PER_INTERVAL; r++) {
        // Cycle 0 is its own parent: by the time runEval reads the parent
        // aggregate it has already recorded this run's per-task rows under the
        // same CID, so ParentNotEvaluatedError does not fire (baseline, delta 0).
        const parent = cycleIndex === 0 ? checkpointCid : parentCheckpointCid;
        const result = await runEval({
          checkpointManifest: manifest,
          checkpointCid,
          slate,
          tasksWithRows,
          parentCheckpointCid: parent,
          deps: evalDeps,
          implStateDir,
        });
        if (r === RUNS_PER_INTERVAL - 1) {
          const agg = store.getEvalAggregate(checkpointCid, slate.version);
          const w = wilsonInterval(agg.passed, agg.scorable);
          rows.push({
            cycleIndex,
            resolved: agg.passed,
            scorable: agg.scorable,
            unscorable: agg.unscorable,
            wilsonInterval: w,
            checkpointCid,
          });
          console.log(
            `  [cycle ${cycleIndex}] resolved ${agg.passed}/${agg.scorable} = ` +
              `${(w.p * 100).toFixed(1)}% [${(w.lo * 100).toFixed(1)}, ${(w.hi * 100).toFixed(1)}] ` +
              `(verdict vs parent: ${result.comparison.verdict})`,
          );
        }
      }
      return checkpointCid;
    };

    // Cycle 0 — BASELINE eval BEFORE any training (seeds the parent aggregate).
    console.log('--- BASELINE (cycle 0) ---');
    let parentCid = await runInterval(0, '');

    // N training cycles; eval at every K.
    for (let cycle = 1; cycle <= N_TRAIN_CYCLES; cycle++) {
      const instanceId = trainSequence[cycle - 1].instance_id;
      console.log(`--- TRAIN CYCLE ${cycle}/${N_TRAIN_CYCLES} (${instanceId}) ---`);
      const workingDir = mkdtempSync(join(tmpdir(), `jinn-trainarm-c${cycle}-`));
      await runCycle({
        cycleLabel: `train-${cycle}`,
        goalId: `train-arm-c${cycle}`,
        goalDescription: `Train-arm cycle ${cycle} on ${instanceId}. Use the pre-seeded repo at workingDir/repo.`,
        workingDir,
        implStateDir,
        harness: harness as Harness,
        config: harnessCfg,
        solverNetName: SOLVER_NET_NAME,
        solverPluginRoots: roots,
        beforeHarnessRun: beforeSweHarnessRun,
        buildTask: buildTrainTaskForCycle(instanceId),
      });

      if (cycle % EVAL_EVERY_K === 0) {
        console.log(`--- EVAL @ cycle ${cycle} ---`);
        parentCid = await runInterval(cycle, parentCid);
      }
    }

    // Compute the slope of resolved-rate vs cycle index.
    const points: RatePoint[] = rows.map((r) => ({ cycleIndex: r.cycleIndex, rate: r.wilsonInterval.p }));
    const slope = leastSquaresSlope(points);

    const summary = {
      issue: 822,
      solverType: `${SOLVER_TYPE}.v1`,
      slateVersion: slate.version,
      slateHash: slate.hash,
      budget: { N: N_TRAIN_CYCLES, K: EVAL_EVERY_K, R: RUNS_PER_INTERVAL },
      determinismStrategy: 'multi-run-averaging-wilson-ci',
      intervals: rows,
      resolvedRateSlopePerCycle: slope,
      caveat: HONESTY_CAVEAT,
    };

    console.log('\n=== JSON ===');
    console.log(JSON.stringify(summary));
    console.log('\n=== SUMMARY ===');
    for (const r of rows) {
      console.log(
        `  cycle ${r.cycleIndex}: ${r.resolved}/${r.scorable} = ${(r.wilsonInterval.p * 100).toFixed(1)}% ` +
          `[${(r.wilsonInterval.lo * 100).toFixed(1)}, ${(r.wilsonInterval.hi * 100).toFixed(1)}]` +
          (r.unscorable ? ` (${r.unscorable} unscorable)` : ''),
      );
    }
    console.log(`  resolved-rate slope: ${slope >= 0 ? '+' : ''}${slope.toFixed(4)} / cycle`);
    console.log(`\n  ${HONESTY_CAVEAT}`);

    if (rows.length < 2) {
      throw new Error('train-arm slope needs >=2 eval intervals; only collected ' + rows.length);
    }
    console.log('\n=== e2e PASSED ===');
  } catch (err) {
    console.error(`\ne2e FAILED: ${err instanceof Error ? err.message : err}`);
    exitCode = 1;
  } finally {
    store.close?.();
    if (exitCode === 0) {
      // implStateDir + dbs are tmp; leave OS tmp cleanup to the host.
    } else {
      console.log(`\nFailure artifacts preserved at implStateDir: ${implStateDir}, db: ${dbPath}`);
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
