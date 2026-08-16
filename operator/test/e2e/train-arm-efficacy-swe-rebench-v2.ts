/**
 * Train-arm EFFICACY harness on the held-out slate — swe-rebench-v2 (issue #822,
 * efficacy successor to the wiring-only `train-arm-slope-swe-rebench-v2.ts`).
 *
 * The sibling `train-arm-slope` e2e trains on a TRIVIAL fixture task ("append
 * e2e-ok to README" on a seeded local repo) — it proves the slope MACHINERY
 * runs end-to-end, but its training content is vacuous, so it can never show
 * learning EFFICACY: a frozen eval on real swe-rebench bugs cannot improve from
 * trivial-note training. This harness closes that gap: the training cycles run
 * the learner on REAL swe-rebench-v2 tasks (real repo clone + real
 * problem_statement) DISJOINT from the held-out slate, so accumulated knowledge
 * can plausibly transfer to the slate — i.e. it measures GENERALIZATION, not
 * memorization (DR-2026-05-28 §2; the goal of issue #822).
 *
 * Both arms run through the SAME daemon-faithful path:
 *   - TRAIN cycles → `runHarnessWithFreezeFence(harness, ctx{mode:'train'})`
 *     (mirrors `runHarnessForEval` but does NOT require a gradeable patch — the
 *     learner's 7-phase train loop persists to implStateDir whether or not it
 *     emits a typed patch). The agent clones the real repo per the
 *     swe-rebench-v2-runtime SKILL.
 *   - EVAL intervals → `runEval` (frozen) on the held-out slate, exactly as
 *     `jinn eval` / the sibling e2e.
 *
 * Determinism (DR-2026-05-28 §4.1): Wilson CI per interval, R=1. Only LARGE
 * deltas (disjoint Wilson intervals) are trustworthy. NOTE the measurement-power
 * floor: at slate N and R=1, a 'trustworthy' verdict requires a very large jump
 * (e.g. N=10 needs ~+60–70pp from a low baseline). A flat/within-noise result
 * at small N is NOT evidence the learner failed — it can be the exam being
 * underpowered. See log/decisions/2026-06-02-* (the finding this harness backs).
 *
 * Budget knobs (env):
 *   JINN_EFFICACY_SLATE_COUNT  held-out slate subset size (default: full slate)
 *   JINN_EFFICACY_N_TRAIN      number of real training cycles (default: 6)
 *   JINN_EFFICACY_K            eval every K training cycles (default: 2)
 *   JINN_EFFICACY_TRAIN_WIN_MIN per-train-cycle wall cap minutes (default: 30)
 *   JINN_E2E_LEARNER_HARNESS / _MODEL / _CLI_PATH  (claude-code/Haiku default)
 *   JINN_SWE_REBENCH_V2_STATE_DIR  pool cache + evaluator state root
 *
 * Usage: yarn e2e:train-arm-efficacy
 *
 * Gates/skips clean (like `jinn eval`): missing learner CLI, evaluator not
 * enabled, or HF/pool unavailable → SKIP.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../../src/types/task.js';
import type { Harness, HarnessContext, RuntimePlugin } from '../../src/harnesses/types.js';
import type { HarnessCheckpointManifest } from '@jinn-network/sdk/checkpoint';
import { loadConfig } from '../../src/config.js';
import { Store } from '../../src/store/store.js';
import { hashImplStateDir, harnessHashOptions } from '../../src/harnesses/freeze.js';
import { runHarnessWithFreezeFence } from '../../src/daemon/freeze-fence.js';
import { provisionWorkingDir } from '../../src/harnesses/engine/packaging.js';
import { TrajectoryCollector } from '../../src/trajectory/index.js';
import {
  loadHeldOutSlate,
  type LoadedHeldOutSlate,
} from '../../src/solver-types/_swe-rebench-v2-held-out-slate.js';
import { loadSweRebenchV2Pool, defaultStateDir } from '../../src/solver-types/swe-rebench-v2.js';
import {
  PoolCacheStore,
  loadPoolWithCacheFallback,
} from '../../src/solver-types/_swe-rebench-v2-pool-cache.js';
import { resolveSlateTasks, type ResolvedSlateTask } from '../../src/eval/resolve-slate-tasks.js';
import { runEval, type RunHarnessOnceForEval } from '../../src/eval/orchestrator.js';
import { resolveRuntimePluginsForSolverType, runHarnessForEval } from '../../src/eval/eval-harness-run.js';
import { leastSquaresSlope, type RatePoint } from '../../src/eval/slope.js';
import { buildTrainSequence, assertNoOverlap } from '../../src/eval/train-sequence.js';
import { wilsonInterval } from '../../src/eval/wilson.js';
import { comparePaired } from '../../src/eval/paired.js';
import { SweRebenchV2Evaluator } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { HttpHfFetcher } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PythonEvalRunner } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import { readEnabledState } from '../../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import { E2E_SWE_JOINED } from './fixtures/swe-rebench-v2-learner-e2e.js';
import { bootstrapLearnerFullCycleE2e, logLearnerHarnessBanner } from './learner-harness-config.js';

const SOLVER_TYPE = 'swe-rebench-v2';
const SLATE_VERSION = 'v1';
const SOLVER_NET_NAME = 'train-arm-efficacy-swe-rebench-v2-e2e';
const EVAL_RUN_BUDGET_MS = 3_600_000;

const N_TRAIN_CYCLES = Number(process.env['JINN_EFFICACY_N_TRAIN'] ?? '6');
const EVAL_EVERY_K = Number(process.env['JINN_EFFICACY_K'] ?? '2');
const TRAIN_WINDOW_MS = Number(process.env['JINN_EFFICACY_TRAIN_WIN_MIN'] ?? '30') * 60_000;

const HONESTY_CAVEAT =
  'Determinism: Wilson CI per interval, R=1 (no seed/temp knob on the adapter). ' +
  'Per DR-2026-05-28 §4.1 only LARGE deltas are trustworthy (disjoint Wilson ' +
  'intervals). At this slate N the exam is power-limited: a within-noise result ' +
  'is NOT proof the learner failed — see the power table in the finding DR.';

function synthesizeManifest(args: {
  implStateDir: string;
  codeDigest: string;
  parentCheckpointCid: string | null;
  implName: string;
}): HarnessCheckpointManifest {
  return {
    schemaVersion: 'harness.checkpoint.v1',
    name: 'train-arm-efficacy-e2e',
    version: '0.0.0',
    parentCheckpointCid: args.parentCheckpointCid,
    harnessPackage: { implName: args.implName, implVersion: '0', clientGitSha: '0', sourceBundleCid: 'e2e-local' },
    implStateDirCid: args.implStateDir,
    codeDigest: args.codeDigest,
    publisher: { agentId: 'e2e', signingKey: 'ed25519:' + '0'.repeat(64), safeAddress: '0x' + '0'.repeat(40) },
    publishedAt: '2026-06-02T00:00:00.000Z',
    registry: { anchor: 'IdentityRegistry.setMetadata', metadataKey: 'e2e', txHash: '0x' + '0'.repeat(64), blockNumber: 1 },
    signature: 'e2e',
  };
}

function makeEvalRunHarnessOnce(opts: {
  solverType: string;
  runtimePlugins: RuntimePlugin[];
  solverNetName: string;
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
      harness, task: resolvedTask, solverType: opts.solverType, runtimePlugins: opts.runtimePlugins,
      implStateDir, mode, solverNetName: opts.solverNetName, ...(opts.model ? { model: opts.model } : {}),
    });
  };
}

/** Build the eval-shaped Task the harness understands (mirrors orchestrator.ts). */
function buildSweTask(t: ResolvedSlateTask['task'], windowMs: number): Task {
  return {
    id: t.instance_id,
    description: t.problem_statement,
    role: 'restoration',
    solverType: 'swe-rebench-v2.v1',
    spec: t as unknown as Record<string, unknown>,
    window: { startTs: 0, endTs: Date.now() + windowMs },
  } as unknown as Task;
}

/**
 * One REAL training cycle: run the learner in TRAIN mode on a real swe-rebench
 * task. Mirrors `runHarnessForEval` (provision + freeze-fence + ephemeral
 * working dir) but in train mode and WITHOUT the gradeable-patch requirement —
 * a train cycle's value is the implStateDir mutation, not a typed patch. Returns
 * the post-run codeDigest (proves learning state changed) or a violation.
 */
async function runTrainingCycle(args: {
  harness: Harness;
  task: Task;
  solverType: string;
  runtimePlugins: RuntimePlugin[];
  implStateDir: string;
  solverNetName: string;
  model?: string;
}): Promise<{ codeDigest?: string; violation?: boolean }> {
  const workingDir = mkdtempSync(join(tmpdir(), 'jinn-efficacy-train-'));
  const windowEndTs = args.task.window?.endTs ?? Date.now() + TRAIN_WINDOW_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(0, windowEndTs - Date.now()));
  timer.unref?.();
  try {
    provisionWorkingDir(workingDir, args.task);
    const ctx: HarnessContext = {
      task: args.task,
      requestId: args.task.id ?? `train-${args.solverType}`,
      taskCid: '',
      solverNet: { name: args.solverNetName, solverType: args.solverType, ...(args.model ? { model: args.model } : {}) },
      runtimePlugins: args.runtimePlugins,
      solverPluginRoots: args.runtimePlugins.map((p) => p.root),
      implStateDir: args.implStateDir,
      workingDir,
      log: () => {},
      abort: abort.signal,
      msUntilEndTs: () => Math.max(0, windowEndTs - Date.now()),
      trajectory: new TrajectoryCollector({ taskCid: '', runId: `train-${args.task.id ?? args.solverType}` }),
      mode: 'train',
    };
    const fence = await runHarnessWithFreezeFence(args.harness, ctx);
    if (!fence.ok) return { violation: true };
    return { codeDigest: `sha256:${fence.codeDigest}` };
  } finally {
    clearTimeout(timer);
    rmSync(workingDir, { recursive: true, force: true });
  }
}

/** Resolve a set of pool instance_ids → {task,row}, grouped by (dataset, split). */
async function resolveAgainstPool(args: {
  instanceIds: string[];
  fetcher: HttpHfFetcher;
  stateDir: string;
}): Promise<ResolvedSlateTask[]> {
  const cacheResult = await loadPoolWithCacheFallback({
    loadPool: loadSweRebenchV2Pool,
    cache: new PoolCacheStore({ stateDir: args.stateDir }),
    currentPool: [],
  });
  const pool = cacheResult.pool;
  if (pool.length === 0) throw new Error('SWE-rebench v2 pool is empty');
  const byId = new Map(pool.map((t) => [t.instance_id, t]));
  const groups = new Map<string, { hf_dataset: string; hf_split: string; poolTasks: typeof pool }>();
  for (const id of args.instanceIds) {
    const pt = byId.get(id);
    if (!pt) throw new Error(`instance ${id} not present in the current pool`);
    const key = `${pt.hf_dataset} ${pt.hf_split}`;
    const g = groups.get(key) ?? { hf_dataset: pt.hf_dataset, hf_split: pt.hf_split, poolTasks: [] };
    g.poolTasks.push(pt);
    groups.set(key, g);
  }
  const out: ResolvedSlateTask[] = [];
  for (const g of groups.values()) {
    out.push(...(await resolveSlateTasks({ poolTasks: g.poolTasks, hf_dataset: g.hf_dataset, hf_split: g.hf_split, fetcher: args.fetcher })));
  }
  return out;
}

interface IntervalRow {
  cycleIndex: number;
  resolved: number;
  scorable: number;
  unscorable: number;
  wilson: { p: number; lo: number; hi: number };
  checkpointCid: string;
}

async function main(): Promise<void> {
  const boot = bootstrapLearnerFullCycleE2e();
  if (boot.kind === 'skip') { console.log(`SKIP: ${boot.reason}`); process.exit(0); }
  if (boot.kind === 'fail') { console.error(`FAIL: ${boot.reason}`); process.exit(1); }
  const { config: harnessCfg, harness, cliVersion } = boot;
  logLearnerHarnessBanner(harnessCfg, cliVersion);

  const config = loadConfig();
  const implStateDirRoot = config.engine?.implStateDirRoot ?? join(homedir(), '.jinn-client', 'engine', 'impl-state');
  const enabled = readEnabledState(join(implStateDirRoot, 'swe-rebench-v2-evaluator'));
  if (!enabled) {
    console.log(`SKIP: swe-rebench-v2 evaluator not enabled. Run \`jinn harnesses enable swe-rebench-v2-evaluator\` first.`);
    process.exit(0);
  }

  const stateDir = process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] ?? defaultStateDir();
  const fetcher = new HttpHfFetcher();
  const evaluator = new SweRebenchV2Evaluator({ fetcher, runner: new PythonEvalRunner({ upstreamRepoDir: enabled.upstreamRepoDir }) });

  const fullSlate = loadHeldOutSlate(`${SOLVER_TYPE}.v1`, SLATE_VERSION);
  // Explicit slate ids (JINN_EFFICACY_SLATE_IDS) override first-N-sorted — lets a
  // disk-bounded run pick SMALL repos instead of the sorted prefix (which
  // includes the large All-Hands-AI/OpenHands instance at position 4). Each must
  // be a member of the canonical v1 slate (held-out provenance).
  const explicitSlate = process.env['JINN_EFFICACY_SLATE_IDS']?.split(',').map((s) => s.trim()).filter(Boolean);
  const slateCount = Number(process.env['JINN_EFFICACY_SLATE_COUNT'] ?? String(fullSlate.instanceIds.size));
  const slateIdsSorted = [...fullSlate.instanceIds].sort((a, b) => a.localeCompare(b));
  let slateSubsetIds: string[];
  if (explicitSlate && explicitSlate.length > 0) {
    const notInSlate = explicitSlate.filter((id) => !fullSlate.instanceIds.has(id));
    if (notInSlate.length > 0) throw new Error(`JINN_EFFICACY_SLATE_IDS not in v1 slate: ${notInSlate.join(', ')}`);
    slateSubsetIds = explicitSlate;
  } else {
    slateSubsetIds = slateIdsSorted.slice(0, slateCount);
  }
  // Subset slate object (distinct version so a partial run never collides with
  // or is compared against the canonical full-slate v1 rows; honest provenance).
  const usingSubset = slateSubsetIds.length < fullSlate.instanceIds.size;
  const slate: LoadedHeldOutSlate = usingSubset
    ? { version: `v1-sub${slateSubsetIds.length}`, hash: `sha256:subset-${slateSubsetIds.length}`, instanceIds: new Set(slateSubsetIds) }
    : fullSlate;

  const evalRuntimePlugins = await resolveRuntimePluginsForSolverType(`${SOLVER_TYPE}.v1`, E2E_SWE_JOINED);

  let tasksWithRows: ResolvedSlateTask[];
  let trainResolved: ResolvedSlateTask[];
  try {
    tasksWithRows = await resolveAgainstPool({ instanceIds: slateSubsetIds, fetcher, stateDir });
    // Explicit training ids (JINN_EFFICACY_TRAIN_IDS) override sorted-first
    // buildTrainSequence — lets a disk-bounded run train on SMALL disjoint repos.
    // Still fail-loud on any overlap with the FULL v1 slate (the AC#2 guard).
    const explicitTrain = process.env['JINN_EFFICACY_TRAIN_IDS']?.split(',').map((s) => s.trim()).filter(Boolean);
    let trainIds: string[];
    if (explicitTrain && explicitTrain.length > 0) {
      assertNoOverlap(explicitTrain, fullSlate.instanceIds);
      trainIds = explicitTrain;
    } else {
      const poolResult = await loadPoolWithCacheFallback({ loadPool: loadSweRebenchV2Pool, cache: new PoolCacheStore({ stateDir }), currentPool: [] });
      trainIds = buildTrainSequence({ pool: poolResult.pool, slateIds: fullSlate.instanceIds, count: N_TRAIN_CYCLES }).map((t) => t.instance_id);
    }
    trainResolved = await resolveAgainstPool({ instanceIds: trainIds, fetcher, stateDir });
  } catch (err) {
    console.log(`SKIP: cannot resolve slate/pool (HF unavailable?): ${err instanceof Error ? err.message : err}`);
    process.exit(0);
  }

  console.log(`\n=== train-arm EFFICACY swe-rebench-v2 e2e ===`);
  console.log(`held-out slate: ${slate.version} hash=${slate.hash} (${slate.instanceIds.size} instances)`);
  console.log(`  slate ids: ${[...slate.instanceIds].join(', ')}`);
  const nTrain = trainResolved.length;
  console.log(`training sequence (REAL, disjoint, ${nTrain}): ${trainResolved.map((t) => t.task.instance_id).join(', ')}`);
  console.log(`budget: N=${nTrain} K=${EVAL_EVERY_K} R=1 trainWin=${Math.round(TRAIN_WINDOW_MS / 60000)}min\n`);

  const implName = harnessCfg.harnessName;
  const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-efficacy-state-'));
  const dbPath = join(mkdtempSync(join(tmpdir(), 'jinn-efficacy-db-')), 'eval.db');
  const store = new Store(dbPath);
  const runHarnessOnce = makeEvalRunHarnessOnce({ solverType: `${SOLVER_TYPE}.v1`, runtimePlugins: evalRuntimePlugins, solverNetName: SOLVER_NET_NAME, model: harnessCfg.model });
  const evalDeps = { harness: harness as Harness, fetchImplStateDirToLocal: async (_cid: string, dir: string) => dir, evaluator, runHarnessOnce, store };

  const rows: IntervalRow[] = [];
  let exitCode = 0;
  try {
    const hashOpts = harnessHashOptions(harness);
    const runInterval = async (cycleIndex: number, parentCheckpointCid: string): Promise<string> => {
      const codeDigest = `sha256:${await hashImplStateDir(implStateDir, hashOpts)}`;
      const checkpointCid = codeDigest;
      const manifest = synthesizeManifest({ implStateDir, codeDigest, parentCheckpointCid: cycleIndex === 0 ? null : parentCheckpointCid, implName });
      const parent = cycleIndex === 0 ? checkpointCid : parentCheckpointCid;
      const result = await runEval({ checkpointManifest: manifest, checkpointCid, slate, tasksWithRows, parentCheckpointCid: parent, deps: evalDeps, implStateDir });
      const agg = store.getEvalAggregate(checkpointCid, slate.version);
      const w = wilsonInterval(agg.passed, agg.scorable);
      rows.push({ cycleIndex, resolved: agg.passed, scorable: agg.scorable, unscorable: agg.unscorable, wilson: w, checkpointCid });
      const pd = result.paired;
      const pairedStr = pd ? `${pd.improved}↑/${pd.regressed}↓ p=${pd.pValue.toFixed(3)} ${pd.verdict}` : 'n/a';
      console.log(`  [cycle ${cycleIndex}] codeDigest=${checkpointCid.slice(0, 20)}… resolved ${agg.passed}/${agg.scorable} = ${(w.p * 100).toFixed(1)}% [${(w.lo * 100).toFixed(1)}, ${(w.hi * 100).toFixed(1)}] (${agg.unscorable} unscorable) · marginal-vs-parent=${result.comparison.verdict} · paired-vs-parent=${pairedStr}`);
      return checkpointCid;
    };

    console.log('--- BASELINE (cycle 0) ---');
    let parentCid = await runInterval(0, '');

    for (let cycle = 1; cycle <= nTrain; cycle++) {
      const t = trainResolved[cycle - 1];
      console.log(`--- TRAIN CYCLE ${cycle}/${nTrain} (REAL: ${t.task.instance_id}) ---`);
      const before = `sha256:${await hashImplStateDir(implStateDir, hashOpts)}`;
      const r = await runTrainingCycle({
        harness: harness as Harness,
        task: buildSweTask(t.task, TRAIN_WINDOW_MS),
        solverType: `${SOLVER_TYPE}.v1`,
        runtimePlugins: evalRuntimePlugins,
        implStateDir,
        solverNetName: SOLVER_NET_NAME,
        ...(harnessCfg.model ? { model: harnessCfg.model } : {}),
      });
      const after = `sha256:${await hashImplStateDir(implStateDir, hashOpts)}`;
      const mutated = before !== after;
      console.log(`    train ${t.task.instance_id}: ${r.violation ? 'VIOLATION' : 'ran'} · codeDigest ${mutated ? `MUTATED ${before.slice(7, 15)}→${after.slice(7, 15)}` : 'UNCHANGED'}`);

      // Eval every K cycles AND always after the final training cycle (so a run
      // whose N is not a multiple of K still produces an after-training interval).
      if (cycle % EVAL_EVERY_K === 0 || cycle === nTrain) {
        console.log(`--- EVAL @ cycle ${cycle} ---`);
        parentCid = await runInterval(cycle, parentCid);
      }
    }

    const points: RatePoint[] = rows.map((r) => ({ cycleIndex: r.cycleIndex, rate: r.wilson.p }));
    const slope = leastSquaresSlope(points);
    const first = rows[0];
    const last = rows[rows.length - 1];
    const disjoint = last.wilson.lo > first.wilson.hi || first.wilson.lo > last.wilson.hi;
    // Baseline↔final PAIRED (matched-design) verdict — the correct, higher-power
    // test (DR-2026-06-02-b §2a). Same slate scored at baseline and final, so
    // compare the two checkpoints' per-instance results directly.
    const baselinePaired = comparePaired(
      store.getEvalResults(first.checkpointCid, slate.version),
      store.getEvalResults(last.checkpointCid, slate.version),
    );

    const summary = {
      issue: 822,
      kind: 'efficacy',
      solverType: `${SOLVER_TYPE}.v1`,
      slateVersion: slate.version,
      slateHash: slate.hash,
      trainingInstances: trainResolved.map((t) => t.task.instance_id),
      budget: { N: nTrain, K: EVAL_EVERY_K, R: 1 },
      intervals: rows,
      resolvedRateSlopePerCycle: slope,
      baselineVsFinalDisjoint: disjoint,
      baselineVsFinalPaired: baselinePaired,
      caveat: HONESTY_CAVEAT,
    };
    console.log('\n=== JSON ===');
    console.log(JSON.stringify(summary));
    console.log('\n=== SUMMARY ===');
    for (const r of rows) {
      console.log(`  cycle ${r.cycleIndex}: ${r.resolved}/${r.scorable} = ${(r.wilson.p * 100).toFixed(1)}% [${(r.wilson.lo * 100).toFixed(1)}, ${(r.wilson.hi * 100).toFixed(1)}]${r.unscorable ? ` (${r.unscorable} unscorable)` : ''}`);
    }
    console.log(`  resolved-rate slope: ${slope >= 0 ? '+' : ''}${slope.toFixed(4)} / cycle`);
    console.log(`  baseline↔final marginal (Wilson disjoint) trustworthy? ${disjoint}`);
    console.log(
      `  baseline↔final PAIRED (McNemar): ${baselinePaired.improved}↑ ${baselinePaired.regressed}↓ of ` +
        `${baselinePaired.pairs} pairs · p=${baselinePaired.pValue.toFixed(3)} → ${baselinePaired.verdict}`,
    );
    console.log(`\n  ${HONESTY_CAVEAT}`);
    if (rows.length < 2) throw new Error('need >=2 eval intervals; collected ' + rows.length);
    console.log('\n=== e2e PASSED (ran to completion; see disjoint flag for efficacy verdict) ===');
  } catch (err) {
    console.error(`\ne2e FAILED: ${err instanceof Error ? err.message : err}`);
    exitCode = 1;
  } finally {
    store.close?.();
    if (exitCode !== 0) console.log(`\nArtifacts preserved: implStateDir=${implStateDir} db=${dbPath}`);
  }
  process.exit(exitCode);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
