/**
 * Typed allowlist of env keys the learner may inject into the harness child
 * process. Adding a new key requires an explicit update here.
 */
export type KnownAdapterEnvKey =
  | 'LEARNER_PHASE_RANGE';

/**
 * Inputs the shim derives from HarnessContext and hands to the
 * harness adapter. The adapter then constructs a session prompt + env
 * for the underlying CLI / runtime.
 */
export interface TaskSessionInputs {
  /** Task id from ctx.task.id */
  taskId: string;
  /** On-chain / persisted request id for this run; may differ from taskId. */
  requestId?: string;
  /** IPFS CID of the full Task payload (if known) for provenance */
  taskCid?: string;
  /** SolverType (e.g. 'portfolio.v0', 'prediction.v1') */
  solverType?: string;
  /** Optional per-SolverNet model override. */
  model?: string;
  /**
   * Optional per-SolverNet provider route for {@link model} (issue #1243).
   * A named provider (string) or a custom OpenAI-compatible endpoint object.
   * The Hermes adapter prefers this over its daemon-global provider and over
   * legacy id-shape inference.
   */
  provider?: import('../../provider-ref.js').ProviderRef;
  /** Optional per-SolverNet Claude model override. Deprecated; use model. */
  claudeModel?: string;
  /** Operator-private impl-state directory; passed to the plugin via env IMPL_STATE_DIR */
  implStateDir: string;
  /** Ephemeral workingDir for this attempt */
  workingDir: string;
  /**
   * Optional absolute workspace containing the Task's authoritative mutable
   * files. Repository-shaped tasks use this to keep source mutations separate
   * from learner telemetry, which remains rooted at {@link workingDir}.
   */
  taskWorkspaceDir?: string;
  /** Additional SolverPlugin package roots to pass through host plugin loading. */
  pluginRoots?: string[];
  /** Window timestamps (ms since epoch) */
  windowStartTs: number;
  windowEndTs: number;
  /** Remaining ms in the window at adapter-invocation time */
  msUntilEndTs: number;
  /** Aborted when window.endTs fires */
  abort: AbortSignal;
  /**
   * Full Task body from ctx.task. Passed verbatim into the initial prompt
   * so the learn skill does not need to read workingDir/task.json.
   * Includes description, solverType, spec, role, eligibility, and window.
   */
  taskBody?: {
    id?: string;
    description?: string;
    solverType?: string;
    spec?: Record<string, unknown>;
    role?: string;
    restorationRequestId?: string;
    eligibility?: Record<string, unknown>;
    window?: { startTs: number; endTs: number };
    [key: string]: unknown;
  };
  /**
   * Optional env vars the adapter should propagate to the harness child
   * process IN ADDITION to its own ENV_ALLOWLIST. Used to thread
   * phase-range hints (e.g. LEARNER_PHASE_RANGE) to
   * the learn skill running inside the spawned harness.
   *
   * Restricted to the {@link KnownAdapterEnvKey} allowlist. Pass-through only;
   * adapters must not silently drop these.
   */
  adapterEnv?: Partial<Record<KnownAdapterEnvKey, string>>;
  /**
   * Harness execution mode forwarded from HarnessContext. The orchestrator
   * skill gates Improve and Memory phase invocations on mode === 'train'.
   */
  mode: 'train' | 'frozen';
}

/**
 * Adapter contract: launch the underlying agent harness with the
 * claude-code-learner plugin loaded and the task context set up. Block
 * until the harness exits cleanly or the abort signal fires.
 *
 * The adapter does NOT harvest outputs — that's the shim's job afterwards.
 */
export interface HarnessAdapter {
  /** Adapter name for logs / spans (e.g. 'claude-code', 'noop'). */
  readonly name: string;

  /**
   * Whether this adapter permits the plugin's Improve phase to patch
   * harness install code (e.g. Pi.dev). Always false for closed harnesses.
   */
  readonly allowsHarnessSelfModification: boolean;

  /**
   * Run one claude-code-learner session. The adapter is responsible for:
   * - Loading the plugin into the harness's skill/plugin directory (or
   *   pointing the harness at it via flags).
   * - Setting IMPL_STATE_DIR in the harness's env so the session-start
   *   hook fires.
   * - Constructing the initial prompt that invokes the `learn` skill
   *   with the task + paths.
   * - Blocking until the harness session exits or `inputs.abort` fires.
   */
  runTask(inputs: TaskSessionInputs, pluginRoot: string): Promise<void>;
}

/** Shim construction config. */
export interface LearnerHarnessConfig {
  /** Harness adapter (NoOp for tests; Claude Code adapter for production). */
  adapter: HarnessAdapter;
  /** Optional override for the impl name (defaults to CLAUDE_CODE_HARNESS = 'claude-code'). */
  name?: string;
  /** Semver string for envelope provenance (defaults to '0.1.0-shim'). */
  version?: string;
  /**
   * Optional override for plugin root resolution. When unset, resolved from
   * the impl directory via `plugin-path.ts`. Tests may override.
   */
  pluginRoot?: string;
  /** SolverPlugin roots loaded by the daemon. */
  solverPluginRoots?: string[];
  /**
   * Path to the `claude` executable. Passed to `probeClaudeAuth()` in
   * `isReady()`. Defaults to 'claude' (from PATH).
   */
  claudePath?: string;
  /**
   * Runtime mode for auth context detection. Passed to `probeClaudeAuth()`.
   * Defaults to 'bare'.
   */
  runtimeMode?: 'bare' | 'container' | 'docker-compose';
  /**
   * Path to the `codex` executable. Used by `isReady()` when this
   * `LearnerHarness` is the Codex variant (`name === CODEX_HARNESS`) — it is
   * passed to `probeCodexDoctor()`. Defaults to 'codex' (from PATH).
   */
  codexPath?: string;
  /**
   * Timeout (ms) for the `codex --version` probe in the Codex variant's
   * `isReady()`. Defaults to 30s.
   */
  codexDoctorTimeoutMs?: number;
}
