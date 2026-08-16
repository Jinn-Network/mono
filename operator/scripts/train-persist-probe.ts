/**
 * THROWAWAY diagnosis probe: does a REAL training cycle persist to implStateDir
 * when the task EXPLICITLY invokes the learner's 7-phase pipeline?
 *
 * Background: the efficacy run showed `codeDigest UNCHANGED` after 2 real
 * training cycles (cyclopts-633/701) whose task carried only the raw
 * problem_statement — the production `buildInitialPrompt` shape, which relies on
 * the model SELECTING the `learn` skill. Hypothesis: without an explicit
 * "run the learn pipeline" directive, Haiku just attempts the bug and never runs
 * Improve/Memory → nothing persists. This probe re-runs ONE real training cycle
 * WITH the explicit directive and checks whether codeDigest mutates + what
 * implStateDir accumulates.
 *
 *   JINN_PERSIST_INSTANCE (default BrianPugh__cyclopts-633)
 *   tsx scripts/train-persist-probe.ts
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../src/types/task.js';
import type { Harness, HarnessContext } from '../src/harnesses/types.js';
import { hashImplStateDir, harnessHashOptions } from '../src/harnesses/freeze.js';
import { runHarnessWithFreezeFence } from '../src/daemon/freeze-fence.js';
import { provisionWorkingDir } from '../src/harnesses/engine/packaging.js';
import { TrajectoryCollector } from '../src/trajectory/index.js';
import { defaultStateDir, loadSweRebenchV2Pool } from '../src/solver-types/swe-rebench-v2.js';
import { PoolCacheStore, loadPoolWithCacheFallback } from '../src/solver-types/_swe-rebench-v2-pool-cache.js';
import { resolveSlateTasks } from '../src/eval/resolve-slate-tasks.js';
import { resolveRuntimePluginsForSolverType } from '../src/eval/eval-harness-run.js';
import { HttpHfFetcher } from '../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { E2E_SWE_JOINED } from '../test/e2e/fixtures/swe-rebench-v2-learner-e2e.js';
import { bootstrapLearnerFullCycleE2e, logLearnerHarnessBanner } from '../test/e2e/learner-harness-config.js';

const PIPELINE_DIRECTIVE = [
  'This is a TRAINING cycle. Run the learner\'s FULL seven-phase pipeline:',
  'Orient -> Strategize -> Plan -> Execute -> Debrief -> Improve -> Memory consolidation.',
  'The Improve and Memory-consolidation phases MUST run: reflect on this attempt and',
  'persist any durable, generalizable lessons to implStateDir (notes/skills), committing them.',
  'Persist genuine lessons only — do not fabricate a trivial change.',
].join('\n');

async function main(): Promise<void> {
  const boot = bootstrapLearnerFullCycleE2e();
  if (boot.kind !== 'ready') { console.log(`${boot.kind.toUpperCase()}: ${boot.reason}`); process.exit(boot.kind === 'skip' ? 0 : 1); }
  const { config: harnessCfg, harness, cliVersion } = boot;
  logLearnerHarnessBanner(harnessCfg, cliVersion);

  const instanceId = process.env['JINN_PERSIST_INSTANCE'] ?? 'BrianPugh__cyclopts-633';
  const stateDir = process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] ?? defaultStateDir();
  const fetcher = new HttpHfFetcher();
  const { pool } = await loadPoolWithCacheFallback({ loadPool: loadSweRebenchV2Pool, cache: new PoolCacheStore({ stateDir }), currentPool: [] });
  const pt = pool.find((t) => t.instance_id === instanceId);
  if (!pt) { console.log(`instance ${instanceId} not in pool`); process.exit(1); }
  const [resolved] = await resolveSlateTasks({ poolTasks: [pt], hf_dataset: pt.hf_dataset, hf_split: pt.hf_split, fetcher });
  const runtimePlugins = await resolveRuntimePluginsForSolverType('swe-rebench-v2.v1', E2E_SWE_JOINED);

  const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-persist-state-'));
  const workingDir = mkdtempSync(join(tmpdir(), 'jinn-persist-work-'));
  const hashOpts = harnessHashOptions(harness);
  const before = `sha256:${await hashImplStateDir(implStateDir, hashOpts)}`;
  console.log(`\ninstance: ${instanceId}\nimplStateDir before: ${before}`);

  const windowEndTs = Date.now() + 30 * 60_000;
  // JINN_PERSIST_NO_DIRECTIVE=1 → production-prompt ONLY (no manual pipeline
  // directive), so the ONLY thing that can trigger the learn loop is the
  // plugin's SessionStart steer hook. Used to test whether fbea4aad's hook
  // makes persistence reliable on its own.
  const noDirective = process.env['JINN_PERSIST_NO_DIRECTIVE'] === '1';
  console.log(`prompt mode: ${noDirective ? 'PRODUCTION (no manual directive — hook-only)' : 'EXPLICIT pipeline directive'}`);
  const task = {
    id: instanceId,
    description: noDirective ? resolved.task.problem_statement : `${resolved.task.problem_statement}\n\n${PIPELINE_DIRECTIVE}`,
    role: 'restoration',
    solverType: 'swe-rebench-v2.v1',
    spec: resolved.task as unknown as Record<string, unknown>,
    window: { startTs: 0, endTs: windowEndTs },
  } as unknown as Task;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30 * 60_000); timer.unref?.();
  provisionWorkingDir(workingDir, task);
  const ctx: HarnessContext = {
    task, requestId: instanceId, taskCid: '',
    solverNet: { name: 'persist-probe', solverType: 'swe-rebench-v2.v1', ...(harnessCfg.model ? { model: harnessCfg.model } : {}) },
    runtimePlugins, solverPluginRoots: runtimePlugins.map((p) => p.root),
    implStateDir, workingDir,
    log: (e) => console.log(`    [${e.level}] ${e.msg}`),
    abort: abort.signal, msUntilEndTs: () => Math.max(0, windowEndTs - Date.now()),
    trajectory: new TrajectoryCollector({ taskCid: '', runId: `persist-${instanceId}` }),
    mode: 'train',
  };

  const t0 = Date.now();
  const fence = await runHarnessWithFreezeFence(harness as Harness, ctx);
  clearTimeout(timer);
  const after = `sha256:${await hashImplStateDir(implStateDir, hashOpts)}`;
  const mins = ((Date.now() - t0) / 60000).toFixed(1);

  console.log(`\n=== TRAIN-PERSIST PROBE (${mins} min) ===`);
  console.log(`fence.ok=${fence.ok}`);
  console.log(`implStateDir after:  ${after}`);
  console.log(`codeDigest MUTATED?  ${before !== after}`);
  if (existsSync(join(implStateDir, '.git'))) {
    const log = execFileSync('git', ['-C', implStateDir, 'log', '--oneline'], { encoding: 'utf8' }).trim();
    console.log(`git log:\n${log || '(no commits)'}`);
  } else {
    console.log('implStateDir has no .git (session-start hook did not run git init)');
  }
  const top = existsSync(implStateDir) ? readdirSync(implStateDir).filter((f) => f !== '.git') : [];
  console.log(`implStateDir top-level (excl .git): [${top.join(', ')}]`);
  // workingDir phase artifacts (did Improve/Memory run?)
  const phases = ['.orient', '.strategize', '.plan', '.execute', '.debrief', '.improve', '.memory-consolidation'].filter((p) => existsSync(join(workingDir, p)));
  console.log(`workingDir phase dirs present: [${phases.join(', ')}]`);

  // INSTRUMENTATION: dump what Debrief proposed and what Improve/promoter did, to
  // pin WHY nothing persisted (no recommendation? promoter accepted nothing?).
  const dump = (rel: string) => {
    const p = join(workingDir, rel);
    if (!existsSync(p)) { console.log(`  [absent] ${rel}`); return; }
    try { console.log(`  [${rel}]\n${readFileSync(p, 'utf8').slice(0, 2500)}`); }
    catch (e) { console.log(`  [unreadable] ${rel}: ${e instanceof Error ? e.message : e}`); }
  };
  const listDir = (rel: string) => {
    const p = join(workingDir, rel);
    console.log(`  [${rel}/] ${existsSync(p) ? readdirSync(p).join(', ') : '(absent)'}`);
  };
  console.log('\n--- learning artifacts ---');
  listDir('.debrief'); dump('.debrief/analysis.json');
  listDir('.improve'); dump('.improve/summary.json');
  for (const f of (existsSync(join(workingDir, '.improve')) ? readdirSync(join(workingDir, '.improve')) : [])) {
    if (/promotion|record|reject/i.test(f)) dump(`.improve/${f}`);
  }
  listDir('.memory-consolidation'); dump('.memory-consolidation/consolidation_record.json');
  listDir('.operator-requests');

  rmSync(workingDir, { recursive: true, force: true });
  rmSync(implStateDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
