/**
 * THROWAWAY probe (not committed to the e2e suite): run a small subset of the
 * held-out slate through the PRODUCTION `runEval` orchestrator at BASELINE
 * (empty impl-state), with real claude-code/Haiku inference + real Docker
 * grading. Measures Haiku's real baseline pass rate and per-instance wall-clock
 * before committing to a full real efficacy run.
 *
 * Env:
 *   JINN_PROBE_INSTANCES   comma-separated instance_ids (default: first 1 sorted)
 *   JINN_PROBE_COUNT       number of first-sorted slate instances (default: 1)
 *   JINN_E2E_LEARNER_MODEL claude model (default: claude-haiku-4-5-20251001)
 *   JINN_SWE_REBENCH_V2_STATE_DIR  pool cache + evaluator state root
 *
 *   tsx scripts/efficacy-probe.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../src/types/task.js';
import type { Harness, RuntimePlugin } from '../src/harnesses/types.js';
import type { HarnessCheckpointManifest } from '@jinn-network/sdk/checkpoint';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { hashImplStateDir, harnessHashOptions } from '../src/harnesses/freeze.js';
import {
  loadHeldOutSlate,
  type LoadedHeldOutSlate,
} from '../src/solver-types/_swe-rebench-v2-held-out-slate.js';
import { loadSweRebenchV2Pool, defaultStateDir } from '../src/solver-types/swe-rebench-v2.js';
import {
  PoolCacheStore,
  loadPoolWithCacheFallback,
} from '../src/solver-types/_swe-rebench-v2-pool-cache.js';
import { resolveSlateTasks, type ResolvedSlateTask } from '../src/eval/resolve-slate-tasks.js';
import { runEval, type RunHarnessOnceForEval } from '../src/eval/orchestrator.js';
import { resolveRuntimePluginsForSolverType, runHarnessForEval } from '../src/eval/eval-harness-run.js';
import { SweRebenchV2Evaluator } from '../src/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { HttpHfFetcher } from '../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PythonEvalRunner } from '../src/harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import { readEnabledState } from '../src/harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import { E2E_SWE_JOINED } from '../test/e2e/fixtures/swe-rebench-v2-learner-e2e.js';
import { bootstrapLearnerFullCycleE2e, logLearnerHarnessBanner } from '../test/e2e/learner-harness-config.js';

const SOLVER_TYPE = 'swe-rebench-v2';
const SLATE_VERSION = 'v1';
const EVAL_RUN_BUDGET_MS = 3_600_000;

function synthesizeManifest(implStateDir: string, codeDigest: string, implName: string): HarnessCheckpointManifest {
  return {
    schemaVersion: 'harness.checkpoint.v1',
    name: 'efficacy-probe',
    version: '0.0.0',
    parentCheckpointCid: null,
    harnessPackage: { implName, implVersion: '0', clientGitSha: '0', sourceBundleCid: 'probe' },
    implStateDirCid: implStateDir,
    codeDigest,
    publisher: { agentId: 'probe', signingKey: 'ed25519:' + '0'.repeat(64), safeAddress: '0x' + '0'.repeat(40) },
    publishedAt: '2026-06-02T00:00:00.000Z',
    registry: { anchor: 'IdentityRegistry.setMetadata', metadataKey: 'probe', txHash: '0x' + '0'.repeat(64), blockNumber: 1 },
    signature: 'probe',
  };
}

function makeRunHarnessOnce(opts: { solverType: string; runtimePlugins: RuntimePlugin[]; solverNetName: string; model?: string }): RunHarnessOnceForEval {
  return async ({ harness, implStateDir, mode, task }) => {
    const resolvedTask = (task ?? { id: 'probe', description: '', role: 'restoration' as const, window: { startTs: 0, endTs: Date.now() + EVAL_RUN_BUDGET_MS } }) as Task;
    return runHarnessForEval({
      harness, task: resolvedTask, solverType: opts.solverType, runtimePlugins: opts.runtimePlugins,
      implStateDir, mode, solverNetName: opts.solverNetName, ...(opts.model ? { model: opts.model } : {}),
    });
  };
}

async function resolveSubset(slateIds: string[], fetcher: HttpHfFetcher, stateDir: string): Promise<ResolvedSlateTask[]> {
  const cacheResult = await loadPoolWithCacheFallback({ loadPool: loadSweRebenchV2Pool, cache: new PoolCacheStore({ stateDir }), currentPool: [] });
  const pool = cacheResult.pool;
  if (pool.length === 0) throw new Error('pool empty');
  const byId = new Map(pool.map((t) => [t.instance_id, t]));
  const groups = new Map<string, { hf_dataset: string; hf_split: string; poolTasks: typeof pool }>();
  for (const id of slateIds) {
    const pt = byId.get(id);
    if (!pt) throw new Error(`slate instance ${id} not in pool`);
    const key = `${pt.hf_dataset} ${pt.hf_split}`;
    const g = groups.get(key) ?? { hf_dataset: pt.hf_dataset, hf_split: pt.hf_split, poolTasks: [] };
    g.poolTasks.push(pt);
    groups.set(key, g);
  }
  const out: ResolvedSlateTask[] = [];
  for (const g of groups.values()) out.push(...(await resolveSlateTasks({ poolTasks: g.poolTasks, hf_dataset: g.hf_dataset, hf_split: g.hf_split, fetcher })));
  return out;
}

async function main(): Promise<void> {
  const boot = bootstrapLearnerFullCycleE2e();
  if (boot.kind !== 'ready') { console.log(`${boot.kind.toUpperCase()}: ${boot.reason}`); process.exit(boot.kind === 'skip' ? 0 : 1); }
  const { config: harnessCfg, harness, cliVersion } = boot;
  logLearnerHarnessBanner(harnessCfg, cliVersion);

  const config = loadConfig();
  const implStateDirRoot = config.engine?.implStateDirRoot ?? join(homedir(), '.jinn-client', 'engine', 'impl-state');
  const enabled = readEnabledState(join(implStateDirRoot, 'swe-rebench-v2-evaluator'));
  if (!enabled) { console.log('SKIP: evaluator not enabled'); process.exit(0); }

  const stateDir = process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] ?? defaultStateDir();
  const fetcher = new HttpHfFetcher();
  const evaluator = new SweRebenchV2Evaluator({ fetcher, runner: new PythonEvalRunner({ upstreamRepoDir: enabled.upstreamRepoDir }) });

  const fullSlate = loadHeldOutSlate(`${SOLVER_TYPE}.v1`, SLATE_VERSION);
  const sorted = [...fullSlate.instanceIds].sort((a, b) => a.localeCompare(b));
  const explicit = process.env['JINN_PROBE_INSTANCES']?.split(',').map((s) => s.trim()).filter(Boolean);
  const count = Number(process.env['JINN_PROBE_COUNT'] ?? '1');
  const chosen = explicit && explicit.length > 0 ? explicit : sorted.slice(0, count);
  console.log(`\nprobe instances (${chosen.length}): ${chosen.join(', ')}`);

  const tasksWithRows = await resolveSubset(chosen, fetcher, stateDir);
  // Probe-scoped slate object (distinct version/hash so no drift guard / no
  // collision with any real v1 rows in a shared DB).
  const probeSlate: LoadedHeldOutSlate = { version: 'v1-probe', hash: 'sha256:probe', instanceIds: new Set(chosen) };

  const evalRuntimePlugins = await resolveRuntimePluginsForSolverType(`${SOLVER_TYPE}.v1`, E2E_SWE_JOINED);
  const implName = harnessCfg.harnessName;
  const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-probe-state-'));
  const dbPath = join(mkdtempSync(join(tmpdir(), 'jinn-probe-db-')), 'probe.db');
  const store = new Store(dbPath);

  const hashOpts = harnessHashOptions(harness);
  const codeDigest = `sha256:${await hashImplStateDir(implStateDir, hashOpts)}`;
  console.log(`baseline implStateDir codeDigest: ${codeDigest}`);
  const manifest = synthesizeManifest(implStateDir, codeDigest, implName);

  const runHarnessOnce = makeRunHarnessOnce({
    solverType: `${SOLVER_TYPE}.v1`, runtimePlugins: evalRuntimePlugins, solverNetName: 'efficacy-probe', model: harnessCfg.model,
  });

  const t0 = Date.now();
  const result = await runEval({
    checkpointManifest: manifest, checkpointCid: codeDigest, slate: probeSlate, tasksWithRows,
    parentCheckpointCid: codeDigest, implStateDir,
    deps: { harness: harness as Harness, fetchImplStateDirToLocal: async (_cid, dir) => dir, evaluator, runHarnessOnce, store },
  });
  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);

  console.log(`\n=== PROBE RESULT (${elapsedMin} min wall) ===`);
  for (const t of result.perTask) console.log(`  ${t.instance_id}: passed=${t.passed} unscorable=${t.unscorable}`);
  const agg = store.getEvalAggregate(codeDigest, probeSlate.version);
  console.log(`  aggregate: passed=${agg.passed} scorable=${agg.scorable} unscorable=${agg.unscorable}`);
  console.log(`  per-instance avg: ${(Number(elapsedMin) / chosen.length).toFixed(1)} min`);
  store.close?.();
  process.exit(0);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
