import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Harness, RuntimePlugin } from '../harnesses/types.js';
import type { Task } from '../types/task.js';
import type { PoolTask } from '../solver-types/_swe-rebench-v2-pool.js';
import { loadConfig } from '../config.js';
import { Store } from '../store/store.js';
import { hashImplStateDir } from '../harnesses/freeze.js';
import { LearnerHarness } from '../harnesses/impls/learner/harness.js';
import { ClaudeCodeHarnessAdapter } from '../harnesses/impls/learner/adapters/claude-code.js';
import { CodexCodeHarnessAdapter } from '../harnesses/impls/learner/adapters/codex-code.js';
import { CODEX_HARNESS } from '../harnesses/names.js';
import { runHarnessForEval, resolveRuntimePluginsForSolverType } from './eval-harness-run.js';
import { corpusEnvFromConfig } from '../cli/commands/eval.js';
import {
  loadSweRebenchV2Pool, defaultStateDir, getSweRebenchV2ValidatedPoolStore,
} from '../solver-types/swe-rebench-v2.js';
import { PoolCacheStore, loadPoolWithCacheFallback } from '../solver-types/_swe-rebench-v2-pool-cache.js';
import {
  validatePoolInstances, EVAL_SEMANTICS_VERSION,
} from '../solver-types/_swe-rebench-v2-validated-pool.js';
import { resolveSlateTasks } from './resolve-slate-tasks.js';
import { SweRebenchV2Evaluator } from '../harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { HttpHfFetcher } from '../harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PythonEvalRunner } from '../harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import { readEnabledState, defaultSweRebenchV2EvaluatorImplStateDir } from '../harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import {
  stratifyByRepo, screenBaseFailures, buildV2SlateFile,
  type ScreenDeps, type ScreenResult,
} from './screen.js';

const DISPATCH_SOLVER_TYPE = 'swe-rebench-v2.v1';
const SLATE_VERSION = 'v2';
const RUN_BUDGET_MS = 3_600_000;

export interface ScreenRunOptions {
  R: number;
  heldOutCount: number;
  maxCandidates: number;
  perRepoCap: number;
  /** Prover agent harness: `codex` (default) or `claude-code` (e.g. an Opus prover
   *  via the working Claude auth — useful when codex is rate-limited). */
  proverHarness?: 'codex' | 'claude-code';
  /** Prover model: `codexModel` for the codex harness, `claudeModel` for the
   *  claude-code harness (defaults to `opus` there). */
  proverModel?: string;
  /** Restrict candidates to these instance ids (else whole gradeable pool). */
  instanceIds?: string[];
  /** Restrict candidates to one repo (org prefix), e.g. `tobymao`. */
  repo?: string;
  configPath?: string;
  log?: (msg: string) => void;
}

export interface ScreenRunSummary {
  result: ScreenResult;
  baseCodeDigest: string;
  slatePath: string;
  reportPath: string;
  heldOutCount: number;
  /** Base-failing candidates whose prover run returned no gradeable result
   *  (excluded as no-headroom) — a signal the prover may be unavailable. */
  proverUnscorable: number;
}

/** dist/src parity: the shipped slate JSON lives next to the compiled module. */
function slatesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'solver-types', 'slates');
}

export async function runScreenHeldOut(opts: ScreenRunOptions): Promise<ScreenRunSummary> {
  const log = opts.log ?? (() => {});
  const config = loadConfig(opts.configPath);

  // Precondition: evaluator enabled (upstream repo cloned).
  const enabled = readEnabledState(defaultSweRebenchV2EvaluatorImplStateDir());
  if (!enabled) {
    throw new Error(
      'swe-rebench-v2 evaluator not enabled — run `jinn harnesses enable swe-rebench-v2-evaluator` first',
    );
  }
  const upstreamRepoDir = enabled.upstreamRepoDir;

  const stateDir = process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] ?? defaultStateDir();
  const fetcher = new HttpHfFetcher();
  const evaluator = new SweRebenchV2Evaluator({ fetcher, runner: new PythonEvalRunner({ upstreamRepoDir }) });
  const validatedStore = getSweRebenchV2ValidatedPoolStore();
  const runtimePlugins: RuntimePlugin[] = await resolveRuntimePluginsForSolverType(
    DISPATCH_SOLVER_TYPE, config.joinedSolverNets,
  );

  // Common adapter wiring (mirrors buildEvalHarness in cli/commands/eval.ts).
  const daemonApiToken = process.env['DAEMON_API_TOKEN']?.trim();
  const corpusEnv = corpusEnvFromConfig(config);
  const common = {
    claudePath: config.claudePath ?? 'claude',
    storePath: config.dbPath,
    daemonApiUrl: `http://127.0.0.1:${config.apiPort}`,
    ...(daemonApiToken ? { daemonApiToken } : {}),
    ...(corpusEnv ? { corpusEnv } : {}),
  };
  const baseHarness: Harness = new LearnerHarness({
    adapter: new ClaudeCodeHarnessAdapter({ ...common, claudeModel: config.claudeModel }),
    claudePath: common.claudePath,
  });
  // Prover harness: codex (default) or claude-code (e.g. an Opus prover via the
  // working Claude auth, sidestepping a codex rate limit; same-family Haiku→Opus
  // is a clean capability ladder for "proven headroom").
  const proverKind = opts.proverHarness ?? 'codex';
  const proverHarness: Harness = proverKind === 'claude-code'
    ? new LearnerHarness({
        adapter: new ClaudeCodeHarnessAdapter({ ...common, claudeModel: opts.proverModel ?? 'opus' }),
        claudePath: common.claudePath,
      })
    : new LearnerHarness({
        name: CODEX_HARNESS,
        adapter: new CodexCodeHarnessAdapter({ ...common, ...(opts.proverModel ? { codexModel: opts.proverModel } : {}) }),
        claudePath: common.claudePath,
        ...(config.codexPath !== undefined ? { codexPath: config.codexPath } : {}),
      });

  // Candidate pool (whole gradeable pool by default; scopeable).
  const cacheResult = await loadPoolWithCacheFallback({
    loadPool: loadSweRebenchV2Pool, cache: new PoolCacheStore({ stateDir }), currentPool: [],
  });
  let pool = cacheResult.pool;
  if (pool.length === 0) throw new Error(`SWE-rebench v2 pool empty${cacheResult.error ? ` (${cacheResult.error.message})` : ''}`);
  if (opts.instanceIds?.length) {
    const want = new Set(opts.instanceIds);
    pool = pool.filter((t) => want.has(t.instance_id));
  }
  if (opts.repo) pool = pool.filter((t) => t.instance_id.startsWith(`${opts.repo}__`));
  const candidates = stratifyByRepo(pool);
  log(`[screen] ${candidates.length} candidate(s) after stratification`);

  // Resolve a single instance to the {task,row} the harness + grader need.
  const byId = new Map(pool.map((t) => [t.instance_id, t]));
  async function runOnce(harness: Harness, poolTask: PoolTask): Promise<{ passed: boolean | null }> {
    const implStateDir = mkdtempSync(join(tmpdir(), 'jinn-screen-state-'));
    try {
      const [resolved] = await resolveSlateTasks({
        poolTasks: [poolTask], hf_dataset: poolTask.hf_dataset, hf_split: poolTask.hf_split, fetcher,
      });
      if (!resolved) return { passed: null };
      const task: Task = {
        id: poolTask.instance_id,
        description: resolved.task.problem_statement,
        role: 'restoration',
        solverType: DISPATCH_SOLVER_TYPE,
        spec: resolved.task as unknown as Record<string, unknown>,
        window: { startTs: 0, endTs: Date.now() + RUN_BUDGET_MS },
      };
      const run = await runHarnessForEval({
        harness, task, solverType: DISPATCH_SOLVER_TYPE, runtimePlugins, implStateDir, mode: 'frozen',
      });
      if (run.violation || !run.solution) return { passed: null };
      const verdict = await evaluator.grade({
        task: resolved.task,
        solutionPayload: { schemaVersion: 'swe-rebench-v2-solution.v1', patch: run.solution.patch },
        row: resolved.row,
      });
      return { passed: verdict.passed_match };
    } catch {
      return { passed: null }; // any harness/grader/infra failure ⇒ unscorable, never a fail (#476)
    } finally {
      rmSync(implStateDir, { recursive: true, force: true });
    }
  }

  const emptyBaseDir = mkdtempSync(join(tmpdir(), 'jinn-screen-base-'));
  const hashOpts = baseHarness.freezeStateHashIgnore?.length
    ? { ignoreRelPaths: [...baseHarness.freezeStateHashIgnore] } : undefined;
  const baseCodeDigest = `sha256:${await hashImplStateDir(emptyBaseDir, hashOpts)}`;
  rmSync(emptyBaseDir, { recursive: true, force: true });

  const deps: ScreenDeps = {
    log,
    ensureGradeable: async (task) => {
      await validatePoolInstances([task], {
        fetcher, runner: new PythonEvalRunner({ upstreamRepoDir }), store: validatedStore,
        semanticsVersion: EVAL_SEMANTICS_VERSION, upstreamRepoDir,
      }, {});
      return (await validatedStore.getEntry(task.instance_id, EVAL_SEMANTICS_VERSION))?.scorable === true;
    },
    runBaseFrozen: (task) => runOnce(baseHarness, byId.get(task.instance_id)!),
    runProverFrozen: (task) => runOnce(proverHarness, byId.get(task.instance_id)!),
  };

  const result = await screenBaseFailures(candidates, deps, {
    R: opts.R, heldOutCount: opts.heldOutCount, maxCandidates: opts.maxCandidates, perRepoCap: opts.perRepoCap,
  });

  // Diagnosability: a base-failing candidate routed to the prover that comes
  // back `proverPassed: null` means the prover produced NO gradeable result
  // (errored / no patch), not a clean "the prover can't solve it". That silently
  // routes to `no-headroom` and can yield a misleadingly empty slate when the
  // prover is simply unavailable (e.g. codex CLI < 0.133.0, or auth missing).
  // Surface it loudly rather than swallow it.
  const proverUnscorable = result.screened.filter(
    (s) => s.reason === 'no-headroom' && s.proverPassed === null,
  ).length;
  if (proverUnscorable > 0) {
    log(
      `[screen] WARNING: the prover returned no gradeable result on ${proverUnscorable} base-failing ` +
      `candidate(s) — excluded as no-headroom, but this likely means the prover is UNAVAILABLE rather than ` +
      `unable. Verify the codex CLI (>=0.133.0) + auth, then re-run. See proverPassed=null rows in the report.`,
    );
  }

  const generatedAt = new Date().toISOString();
  const slateFile = buildV2SlateFile(result.heldOut.map((h) => h.instance_id), generatedAt);
  mkdirSync(slatesDir(), { recursive: true });
  const slatePath = join(slatesDir(), 'held-out-slate.swe-rebench-v2.v2.json');
  writeFileSync(slatePath, `${JSON.stringify(slateFile, null, 2)}\n`);
  const reportPath = join(slatesDir(), 'held-out-slate.swe-rebench-v2.v2.screening-report.json');
  writeFileSync(reportPath, `${JSON.stringify({
    generatedAt, evalSemanticsVersion: EVAL_SEMANTICS_VERSION, baseCodeDigest,
    R: opts.R, proverHarness: proverKind,
    proverModel: opts.proverModel ?? (proverKind === 'claude-code' ? 'opus' : 'codex-default'),
    heldOut: result.heldOut, screened: result.screened,
  }, null, 2)}\n`);

  // Persist the base arm (all-fail) so `jinn eval v2 --parent <baseCodeDigest>` reports McNemar.
  const store = new Store(config.dbPath);
  try {
    const runAtMs = Date.now();
    for (const h of result.heldOut) {
      store.recordEvalResult({
        checkpoint_cid: baseCodeDigest, slate_hash: slateFile.hash, slate_version: SLATE_VERSION,
        instance_id: h.instance_id, passed: false, unscorable: false, code_digest: baseCodeDigest,
        run_at_ms: runAtMs, test_log_excerpt: 'base arm (screening): consistent fail 0/R',
      });
    }
  } finally {
    store.close?.();
  }

  return { result, baseCodeDigest, slatePath, reportPath, heldOutCount: result.heldOut.length, proverUnscorable };
}
