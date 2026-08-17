/**
 * `jinn eval <slate-version> --checkpoint <cid>` — run a held-out slate against
 * a checkpoint in frozen mode and emit a resolved-rate comparison vs the parent
 * checkpoint with a Wilson confidence interval (issue #818).
 *
 * The command is a thin shell over `runEval` (orchestrator.ts): a pure
 * `createEvalCommand(deps)` factory tested directly, plus a default
 * `CommandModule` that wires production deps. The orchestration itself
 * (slate load -> resolve tasks -> runEval) is the injected `runPipeline` seam;
 * the live Docker/IPFS wiring is completed in #819's thin slice.
 *
 * Spec: docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { parseCommandArgs, COMMON_FLAGS } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  HarnessCheckpointManifestSchema,
  type HarnessCheckpointManifest,
} from '@jinn-network/sdk/checkpoint';
import {
  runEval,
  type EvalRunResult,
  type RunHarnessOnceForEval,
  type EvalSlateInstance,
  type SolutionEvaluator,
} from '../../eval/orchestrator.js';
import { resolveSlateTasks } from '../../eval/resolve-slate-tasks.js';
import type { RateComparison } from '../../eval/wilson.js';
import { loadConfig } from '../../config.js';
import { Store } from '../../store/store.js';
import { fetchFromIpfs } from '../../adapters/mech/ipfs.js';
import {
  resolveRuntimePluginsForSolverType,
  runHarnessForEval,
} from '../../eval/eval-harness-run.js';
import { DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK } from '../../corpus/onchain-query.js';
import type { RuntimePlugin } from '../../harnesses/types.js';
import { loadHeldOutSlate } from '../../solver-types/_swe-rebench-v2-held-out-slate.js';
import { loadSweRebenchV2Pool } from '../../solver-types/swe-rebench-v2.js';
import { PoolCacheStore, loadPoolWithCacheFallback } from '../../solver-types/_swe-rebench-v2-pool-cache.js';
import { LearnerHarness } from '../../harnesses/impls/learner/harness.js';
import {
  ClaudeCodeHarnessAdapter,
  type ClaudeCodeHarnessAdapterConfig,
} from '../../harnesses/impls/learner/adapters/claude-code.js';
import { CodexCodeHarnessAdapter } from '../../harnesses/impls/learner/adapters/codex-code.js';
import { CODEX_HARNESS, canonicalHarnessName, harnessStateDirName } from '../../harnesses/names.js';
import { SweRebenchV2Evaluator } from '../../harnesses/impls/swe-rebench-v2-evaluator/index.js';
import { HttpHfFetcher } from '../../harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';
import { PythonEvalRunner } from '../../harnesses/impls/swe-rebench-v2-evaluator/eval-runner.js';
import { readEnabledState } from '../../harnesses/impls/swe-rebench-v2-evaluator/harness.js';
import { JinnRepoEvaluator } from '../../harnesses/impls/jinn-repo-evaluator/evaluator.js';
import {
  loadJinnRepoPool,
  resolveJinnRepoSlate,
  solverView,
  type JinnRepoPoolItem,
} from '../../solver-types/_jinn-repo-pool.js';
import type { Task } from '../../types/task.js';
import type { Harness } from '../../harnesses/types.js';
import { resolveDefaultStateDir } from '../../state-dir.js';

/**
 * Which evaluation backend a solverType dispatches to. `jinn-repo` grades
 * candidate patches against real merged-PR fixtures in this repo (repo-native);
 * everything else uses the swe-rebench-v2 Docker grading path (production).
 */
export type EvalBackend =
  | { kind: 'swe-rebench-v2' }
  | { kind: 'jinn-repo' };

export function selectEvalBackend(solverType: string): EvalBackend {
  return solverType === 'jinn-repo' ? { kind: 'jinn-repo' } : { kind: 'swe-rebench-v2' };
}

export interface RunPipelineArgs {
  checkpointCid: string;
  checkpointManifest: HarnessCheckpointManifest;
  solverType: string;
  slateVersion: string;
  parentCheckpointCid: string;
  /** Config file path (`--config`); production wiring loads dbPath/engine from it. */
  configPath?: string;
  /**
   * Local impl-state directory to run the frozen slate against
   * (`--impl-state-dir`). Defaults to the daemon's
   * `engine.implStateDirRoot/<implName>`. See PRODUCTION_DEPS below.
   */
  implStateDir?: string;
}

export interface EvalCommandDeps {
  /** Resolve a checkpoint manifest from its CID (production: IPFS fetch + schema parse). */
  fetchManifest(cid: string): Promise<HarnessCheckpointManifest>;
  /** Load the slate, resolve its tasks, and run the frozen-mode orchestrator. */
  runPipeline(args: RunPipelineArgs): Promise<EvalRunResult>;
}

const EXAMPLE = 'jinn eval v1 --checkpoint <cid> [--parent <cid>] [--solver-type swe-rebench-v2] [--json|--human]';

export function createEvalCommand(deps: EvalCommandDeps): CommandModule {
  return {
    name: 'eval',
    summary: 'Run a held-out slate against a checkpoint and compare its resolved rate vs the parent (#818)',
    helpText: `Usage:
  ${EXAMPLE}

Runs the held-out task slate for <slate-version> against the checkpoint in
FROZEN mode (the freeze-fence holds — no implStateDir mutation), writes per-task
pass/fail, and emits a resolved-rate comparison vs the parent checkpoint with a
Wilson confidence interval.

Arguments:
  <slate-version>        Held-out slate version, e.g. v1

Options:
  --checkpoint <cid>     Checkpoint to evaluate (required)
  --parent <cid>         Parent checkpoint to compare against
                         (default: manifest.parentCheckpointCid)
  --solver-type <type>   SolverType (default: swe-rebench-v2)
  --impl-state-dir <dir> Local frozen impl-state to evaluate
                         (default: engine.implStateDirRoot/<implName> from config)
  --config <path>        Config file (default: ~/.jinn-client/config.json)
  --json                 Emit JSON (perTask[] + comparison{child,parent,delta,verdict})
  --human                Emit a human-readable summary line

Scores are only comparable WITHIN a slate version. The parent must already have
been evaluated against the same slate version, else the command fails loud.`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseCommandArgs(ctx.argv, {
          ...COMMON_FLAGS,
          checkpoint: { type: 'string' },
          parent: { type: 'string' },
          'solver-type': { type: 'string', default: 'swe-rebench-v2' },
          'impl-state-dir': { type: 'string' },
        });
      } catch (err) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: err instanceof Error ? err.message : String(err),
            exampleCli: EXAMPLE,
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const slateVersion = parsed.positionals[0];
      const checkpointCid = parsed.values.checkpoint;
      if (!slateVersion) {
        emitEnvelope(
          { code: 'invalid_invocation', message: '<slate-version> positional is required', exampleCli: EXAMPLE, details: { field: 'slate-version' } },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }
      if (!checkpointCid) {
        emitEnvelope(
          { code: 'invalid_invocation', message: '--checkpoint <cid> is required', exampleCli: EXAMPLE, details: { field: 'checkpoint' } },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const manifest = await deps.fetchManifest(checkpointCid);
      const parentCheckpointCid = parsed.values.parent ?? manifest.parentCheckpointCid;
      if (!parentCheckpointCid) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: 'no parent checkpoint: manifest.parentCheckpointCid is null and --parent was not given',
            exampleCli: EXAMPLE,
            details: { field: 'parent' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const result = await deps.runPipeline({
        checkpointCid,
        checkpointManifest: manifest,
        solverType: parsed.values['solver-type'] ?? 'swe-rebench-v2',
        slateVersion,
        parentCheckpointCid,
        ...(parsed.values.config ? { configPath: parsed.values.config } : {}),
        ...(parsed.values['impl-state-dir'] ? { implStateDir: parsed.values['impl-state-dir'] } : {}),
      });

      if (parsed.values.human) {
        ctx.writer.write(renderHuman(result) + '\n');
      } else {
        ctx.writer.write(JSON.stringify(result) + '\n');
      }
    },
  };
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function ci(c: RateComparison['child']): string {
  return `[${(c.lo * 100).toFixed(1)}, ${(c.hi * 100).toFixed(1)}]`;
}

function renderHuman(result: EvalRunResult): string {
  const { comparison: c } = result;
  const passed = result.perTask.filter((t) => t.passed === true).length;
  const scorable = result.perTask.filter((t) => !t.unscorable).length;
  const unscorable = result.perTask.filter((t) => t.unscorable).length;
  const deltaPp = (c.delta * 100).toFixed(1);
  const sign = c.delta >= 0 ? '+' : '';
  const verdict = c.verdict === 'trustworthy' ? 'trustworthy' : 'within noise';
  const tail = unscorable > 0 ? ` (${unscorable} unscorable, excluded)` : '';
  // Provenance (Legibility): the graded artifact is the operator's LOCAL frozen
  // impl-state, verified == the named checkpoint — not a re-fetched checkpoint state.
  const provenance = `evaluated local impl-state at ${result.evaluated.codeDigest}, verified == checkpoint`;
  // Paired (matched-design) verdict — the correct, higher-power test for the
  // same-slate before/after design; reported alongside the conservative marginal
  // verdict above (DR-2026-06-02-b §2a).
  const p = result.paired;
  const pairedLine = p
    ? `\npaired (McNemar): ${p.improved}↑ ${p.regressed}↓ of ${p.pairs} matched pairs · ` +
      `p=${p.pValue.toFixed(3)} (${p.verdict === 'trustworthy' ? 'trustworthy' : 'within noise'})`
    : '';
  return (
    `resolved ${passed}/${scorable} = ${pct(c.child.p)} ${ci(c.child)} ` +
    `vs parent ${pct(c.parent.p)} ${ci(c.parent)} · Δ ${sign}${deltaPp}pp (${verdict})${tail}` +
    pairedLine +
    '\n' +
    provenance
  );
}

const DEFAULT_CONFIG_PATH = join(resolveDefaultStateDir(), 'config.json');

/** Default impl-state root when config does not set `engine.implStateDirRoot`. */
function implStateDirRoot(config: ReturnType<typeof loadConfig>): string {
  return config.engine?.implStateDirRoot ?? join(resolveDefaultStateDir(), 'engine', 'impl-state');
}

/**
 * Keyless corpus endpoints for the learner adapter's bundled MCP server (record
 * search / artifact inspection). Mirrors `main.ts`'s `corpusEnv` assembly so the
 * eval agent runtime matches the daemon's. Sources every field from
 * `loadConfig()` — there is no bootstrap state in the CLI path, so the identity
 * registry falls back to the chain default for the resolved network.
 */
export function corpusEnvFromConfig(
  config: ReturnType<typeof loadConfig>,
): NonNullable<ClaudeCodeHarnessAdapterConfig['corpusEnv']> | undefined {
  const chainId = config.network === 'testnet' ? 84532 : 8453;
  const fromBlock = Number(DEFAULT_EXECUTION_DISCOVERY_FROM_BLOCK[chainId] ?? 0n);
  const discoveryUrl = config.discovery?.url?.trim() || '';
  const identityRegistryAddress = config.identityRegistryAddress;
  if (!discoveryUrl && !identityRegistryAddress) return undefined;
  return {
    ...(discoveryUrl ? { discoveryUrl } : {}),
    ipfsGatewayUrl: config.ipfsGatewayUrl,
    rpcUrl: config.rpcUrl,
    chainId,
    ...(identityRegistryAddress ? { identityRegistryAddress } : {}),
    ...(fromBlock > 0 ? { fromBlock } : {}),
  };
}

/**
 * Build the production `Harness` for a checkpoint. swe-rebench-v2 checkpoints
 * are produced by the learner harness (claude-code or codex variant); the
 * manifest's `harnessPackage.implName` selects which. Constructed standalone
 * (no funded wallet) — a frozen-mode eval run never touches the chain; it only
 * runs the agent against the local impl-state and harvests the diff.
 *
 * Mirrors `buildHarnesses` (harnesses/impls/index.ts): the adapter MUST receive
 * `corpusEnv` and `daemonApiToken` (alongside storePath/daemonApiUrl) so the
 * agent runtime matches the daemon's — otherwise the bundled MCP surface
 * degrades and the agent cannot produce a gradeable patch.
 */
function buildEvalHarness(implName: string, config: ReturnType<typeof loadConfig>): Harness {
  const canonical = canonicalHarnessName(implName);
  const daemonApiToken = process.env['DAEMON_API_TOKEN']?.trim();
  const corpusEnv = corpusEnvFromConfig(config);
  const common = {
    claudePath: config.claudePath ?? 'claude',
    claudeModel: config.claudeModel,
    storePath: config.dbPath,
    daemonApiUrl: `http://127.0.0.1:${config.apiPort}`,
    ...(daemonApiToken ? { daemonApiToken } : {}),
    ...(corpusEnv ? { corpusEnv } : {}),
  };
  if (canonical === CODEX_HARNESS) {
    return new LearnerHarness({
      name: CODEX_HARNESS,
      adapter: new CodexCodeHarnessAdapter({
        ...common,
        ...(config.codexPath !== undefined ? { codexPath: config.codexPath } : {}),
      }),
      claudePath: common.claudePath,
      ...(config.codexPath !== undefined ? { codexPath: config.codexPath } : {}),
    });
  }
  // Default: claude-code learner (LearnerHarness's own default name).
  return new LearnerHarness({
    adapter: new ClaudeCodeHarnessAdapter(common),
    claudePath: common.claudePath,
  });
}

/**
 * Resolve the local frozen impl-state directory for the checkpoint. There is
 * no production IPFS round-trip for a checkpoint's `implStateDir` (the
 * checkpoint publish/install verbs are factory-only; the pin/fetch format is a
 * future verification layer — spec §6.4, "Layer 4"). The realistic operator
 * workflow (#824) evaluates the operator's OWN frozen state, which already
 * lives on disk. The `--impl-state-dir` shape was set by the since-retired
 * `codedigest-revert-check` verb (one-swap R3b, issue #2494); `jinn eval` is
 * now its only user.
 */
export function resolveLocalImplStateDir(
  explicit: string | undefined,
  implName: string,
  config: ReturnType<typeof loadConfig>,
): string {
  if (explicit) return explicit;
  // `implName` comes from the remote IPFS manifest (only `z.string().min(1)`),
  // so constrain it before the path join — an unconstrained value like
  // "../../.." would traverse out of engine.implStateDirRoot.
  if (!/^[a-z0-9-]+$/.test(implName)) {
    throw new Error(
      `invalid harness implName ${JSON.stringify(implName)} in checkpoint manifest: ` +
        `expected /^[a-z0-9-]+$/ (refusing to derive an impl-state path that could ` +
        `traverse outside engine.implStateDirRoot)`,
    );
  }
  return join(implStateDirRoot(config), harnessStateDirName(implName));
}

/**
 * Production `runHarnessOnce` for the eval orchestrator. Delegates to the
 * shared {@link runHarnessForEval} helper, which builds the FULL
 * daemon-equivalent HarnessContext — including `solverPluginRoots` from the
 * SolverNet's `runtimePlugins` — so the agent gets the bundled MCP server
 * (`submit_typed_payload`) and can produce a gradeable patch. The legacy
 * hand-rolled body ran the agent WITHOUT plugins, leaving every task
 * unscorable; this factory closes over the resolved `solverType` +
 * `runtimePlugins` and surfaces the seam the orchestrator already drives.
 */
export function makeEvalRunHarnessOnce(opts: {
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
      window: { startTs: 0, endTs: Date.now() + 3_600_000 },
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

/**
 * Resolve slate `instance_id`s to `{ task, row }` pairs. The slate stores only
 * ids; the HF dataset+split per instance comes from the pool (cached, with a
 * HF fallback — mirrors the evaluator harness's pool path). Instances are
 * grouped by `(hf_dataset, hf_split)` so each group's row scan hits the right
 * partition.
 */
async function resolveSlateAgainstPool(args: {
  instanceIds: Set<string>;
  fetcher: HttpHfFetcher;
  stateDir: string;
}) {
  const cacheResult = await loadPoolWithCacheFallback({
    loadPool: loadSweRebenchV2Pool,
    cache: new PoolCacheStore({ stateDir: args.stateDir }),
    currentPool: [],
  });
  const pool = cacheResult.pool;
  if (pool.length === 0) {
    throw new Error(
      `cannot resolve held-out slate: SWE-rebench v2 pool is empty` +
        (cacheResult.error ? ` (${cacheResult.error.message})` : ''),
    );
  }
  const byId = new Map(pool.map((t) => [t.instance_id, t]));
  // Group requested ids by (dataset, split), carrying the real pool task so the
  // agent run gets the true problem_statement/base_commit (H1).
  const groups = new Map<
    string,
    { hf_dataset: string; hf_split: string; poolTasks: typeof pool }
  >();
  for (const id of args.instanceIds) {
    const poolTask = byId.get(id);
    if (!poolTask) {
      throw new Error(`held-out slate instance ${id} not present in the current pool`);
    }
    const key = `${poolTask.hf_dataset} ${poolTask.hf_split}`;
    const group =
      groups.get(key) ?? { hf_dataset: poolTask.hf_dataset, hf_split: poolTask.hf_split, poolTasks: [] };
    group.poolTasks.push(poolTask);
    groups.set(key, group);
  }
  const out = [];
  for (const group of groups.values()) {
    const resolved = await resolveSlateTasks({
      poolTasks: group.poolTasks,
      hf_dataset: group.hf_dataset,
      hf_split: group.hf_split,
      fetcher: args.fetcher,
    });
    out.push(...resolved);
  }
  return out;
}

/**
 * Adapt {@link JinnRepoEvaluator} onto the orchestrator's {@link SolutionEvaluator}.
 * The orchestrator calls `grade({ task, solutionPayload, row })` and consumes a
 * `{ passed_match, test_log }` verdict, signalling unscorable by THROWING (its
 * catch records `unscorable`). The repo-native evaluator instead RETURNS
 * `{ passed, unscorable, logExcerpt }`, so this adapter:
 *   - feeds the full pool item (`task`, which carries `gold_tests`) + the patch,
 *   - throws when the run is unscorable (preserving the orchestrator's contract:
 *     unscorable is never a graded FAIL — #476),
 *   - otherwise maps `passed` → `passed_match` and `logExcerpt` → `test_log`.
 * `row` is unused (repo-native grading has no HF row).
 */
function jinnRepoEvaluatorAdapter(evaluator: JinnRepoEvaluator): SolutionEvaluator {
  return {
    async grade({ task, solutionPayload }): Promise<{ passed_match: boolean; test_log: string }> {
      const verdict = await evaluator.grade({
        task: task as unknown as JinnRepoPoolItem,
        solution: { patch: solutionPayload.patch },
      });
      if (verdict.unscorable || verdict.passed === null) {
        // Unscorable: the orchestrator records this instance as excluded, never
        // as a graded fail. Throwing routes it through the orchestrator's
        // unscorable catch (matches the swe-rebench evaluator's throw contract).
        throw new Error(`jinn-repo eval unscorable: ${verdict.logExcerpt}`);
      }
      return { passed_match: verdict.passed, test_log: verdict.logExcerpt };
    },
  };
}

/**
 * Build the jinn-repo `slateInstances` for the orchestrator. LEAK-CONTROL: the
 * solver harness receives ONLY `solverView(item)` (no `gold_tests`, no
 * `solution_patch`); the evaluator receives the full pool item via `gradeTask`.
 */
function jinnRepoSlateInstances(items: JinnRepoPoolItem[]): EvalSlateInstance[] {
  return items.map((item) => {
    const view = solverView(item);
    return {
      instance_id: item.instance_id,
      // Solver-visible task: solverView ONLY — gold tests + reference solution
      // never cross this boundary.
      harnessTask: {
        id: item.instance_id,
        description: item.problem_statement,
        role: 'restoration',
        solverType: 'jinn-repo.v1',
        spec: view as unknown as Record<string, unknown>,
        window: { startTs: 0, endTs: Date.now() + 3_600_000 },
      },
      // Grade-side: the FULL pool item (the evaluator needs gold_tests).
      gradeTask: item,
      solutionSchemaVersion: 'jinn-repo-solution.v1',
    };
  });
}

const PRODUCTION_DEPS: EvalCommandDeps = {
  async fetchManifest(cid: string): Promise<HarnessCheckpointManifest> {
    const config = loadConfig(DEFAULT_CONFIG_PATH);
    const raw = await fetchFromIpfs(config.ipfsGatewayUrl, cid);
    return HarnessCheckpointManifestSchema.parse(raw);
  },
  async runPipeline(args): Promise<EvalRunResult> {
    const config = loadConfig(args.configPath ?? DEFAULT_CONFIG_PATH);
    const manifest = args.checkpointManifest;
    const implName = manifest.harnessPackage.implName;

    // Frozen impl-state to evaluate (local; see resolveLocalImplStateDir).
    const implStateDir = resolveLocalImplStateDir(args.implStateDir, implName, config);
    if (!existsSync(implStateDir)) {
      throw new Error(
        `impl-state directory not found: ${implStateDir} — ` +
          `pass --impl-state-dir <dir> or set engine.implStateDirRoot in config`,
      );
    }

    // Slate (instance ids) is backend-agnostic; how those ids resolve to
    // run/grade payloads and which evaluator grades them is backend-specific.
    const slate = loadHeldOutSlate(`${args.solverType}.v1`, args.slateVersion);
    const backend = selectEvalBackend(args.solverType);

    // Resolve the per-backend run/grade inputs:
    //   - tasksWithRows  → swe-rebench-v2 default mapping (HF rows, Docker grade)
    //   - slateInstances → repo-native leak-controlled instances (solverView only)
    let tasksWithRows: Awaited<ReturnType<typeof resolveSlateAgainstPool>> | undefined;
    let slateInstances: EvalSlateInstance[] | undefined;
    let evaluator: SolutionEvaluator;

    if (backend.kind === 'jinn-repo') {
      // Repo-native: resolve the slate ids against the LOCAL jinn-repo pool. The
      // evaluator (JinnRepoEvaluator) clones this repo @ base_commit, applies the
      // candidate patch, overwrites gold tests, and runs the PR's own test.
      const items = resolveJinnRepoSlate(loadJinnRepoPool(), slate.instanceIds);
      slateInstances = jinnRepoSlateInstances(items);
      evaluator = jinnRepoEvaluatorAdapter(new JinnRepoEvaluator());
    } else {
      // swe-rebench-v2 (production): real HF fetcher; per-instance dataset/split
      // from the pool.
      const stateDir = config.sweRebenchV2StateDir;
      const fetcher = new HttpHfFetcher();
      tasksWithRows = await resolveSlateAgainstPool({
        instanceIds: slate.instanceIds,
        fetcher,
        stateDir,
      });

      // Evaluator: the SWE-rebench v2 grading library — same construction the
      // evaluator harness uses internally (HttpHfFetcher + PythonEvalRunner over
      // the cloned upstream repo). Requires `jinn harnesses enable
      // swe-rebench-v2-evaluator` to have cloned upstream + validated Docker.
      const evaluatorImplStateDir = join(implStateDirRoot(config), 'swe-rebench-v2-evaluator');
      const enabled = readEnabledState(evaluatorImplStateDir);
      if (!enabled) {
        throw new Error(
          `swe-rebench-v2 evaluator not enabled (no state at ${evaluatorImplStateDir}). ` +
            `Run \`jinn harnesses enable swe-rebench-v2-evaluator\` first.`,
        );
      }
      evaluator = new SweRebenchV2Evaluator({
        fetcher,
        runner: new PythonEvalRunner({ upstreamRepoDir: enabled.upstreamRepoDir }),
      });
    }

    // The orchestrator runs each slate task under the full dispatch solverType
    // (`<solver-type>.v1`). Resolve the SAME SolverNet runtime plugins the
    // daemon would (fails LOUD if the operator hasn't joined the SolverNet /
    // installed its plugins) — these carry the bundled MCP server the agent
    // needs to emit a gradeable patch.
    const dispatchSolverType = `${args.solverType}.v1`;
    const runtimePlugins = await resolveRuntimePluginsForSolverType(
      dispatchSolverType,
      config.executionWiring,
    );
    const joinedNet = (config.executionWiring ?? []).find(
      (entry) => entry.workKind === dispatchSolverType,
    );

    const harness = buildEvalHarness(implName, config);
    const store = new Store(config.dbPath);
    try {
      return await runEval({
        checkpointManifest: manifest,
        checkpointCid: args.checkpointCid,
        slate,
        ...(slateInstances ? { slateInstances } : { tasksWithRows: tasksWithRows ?? [] }),
        parentCheckpointCid: args.parentCheckpointCid,
        implStateDir,
        deps: {
          harness,
          fetchImplStateDirToLocal: async (_cid, targetDir) => targetDir,
          evaluator,
          runHarnessOnce: makeEvalRunHarnessOnce({
            solverType: dispatchSolverType,
            runtimePlugins,
            ...(joinedNet?.workKind ? { solverNetName: joinedNet.workKind } : {}),
            ...(config.claudeModel ? { model: config.claudeModel } : {}),
          }),
          store,
        },
      });
    } finally {
      store.close?.();
    }
  },
};

const command: CommandModule = createEvalCommand(PRODUCTION_DEPS);
export default command;
