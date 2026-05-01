import type { RestorationContext } from '../../types.js';

/**
 * Typed allowlist of env keys the wrapper may inject into the harness child
 * process. Adding a new key requires an explicit update here.
 */
export type KnownAdapterEnvKey =
  | 'JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE'
  | 'JINN_SLOT_REGISTRY_JSON';

/**
 * Inputs the shim derives from RestorationContext and hands to the
 * harness adapter. The adapter then constructs a session prompt + env
 * for the underlying CLI / runtime.
 */
export interface IntentSessionInputs {
  /** Intent id from ctx.intent.id */
  intentId: string;
  /** IPFS CID of the intent (if known) for provenance */
  intentCid?: string;
  /** Intent kind (e.g. 'portfolio.v0', 'prediction.v0') */
  intentKind?: string;
  /** Operator-private impl-state directory; passed to the plugin via env IMPL_STATE_DIR */
  implStateDir: string;
  /** Ephemeral workingDir for this attempt */
  workingDir: string;
  /** Window timestamps (ms since epoch) */
  windowStartTs: number;
  windowEndTs: number;
  /** Remaining ms in the window at adapter-invocation time */
  msUntilEndTs: number;
  /** Aborted when window.endTs fires */
  abort: AbortSignal;
  /**
   * Full intent body from ctx.intent. Passed verbatim into the initial prompt
   * so the coordinator skill does not need to read workingDir/intent.json.
   * Includes description, spec, type, eligibility, and window.
   */
  intentBody?: {
    id?: string;
    description?: string;
    spec?: { kind: string } & Record<string, unknown>;
    type?: string;
    eligibility?: Record<string, unknown>;
    window?: { startTs: number; endTs: number };
    [key: string]: unknown;
  };
  /**
   * Optional env vars the adapter should propagate to the harness child
   * process IN ADDITION to its own ENV_ALLOWLIST. Used by the wrapper to
   * thread phase-range hints (e.g. JINN_CLAUDE_CODE_LEARNER_PHASE_RANGE) to
   * the coordinator skill running inside the spawned harness.
   *
   * Restricted to the {@link KnownAdapterEnvKey} allowlist. Pass-through only;
   * adapters must not silently drop these.
   */
  adapterEnv?: Partial<Record<KnownAdapterEnvKey, string>>;
}

/**
 * Adapter contract: launch the underlying agent harness with the
 * claude-code-learner plugin loaded and the intent context set up. Block
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
   * - Constructing the initial prompt that invokes the `coordinator` skill
   *   with the intent + paths.
   * - Blocking until the harness session exits or `inputs.abort` fires.
   */
  runIntent(inputs: IntentSessionInputs, pluginRoot: string): Promise<void>;
}

/** Shim construction config. */
export interface ClaudeCodeLearnerConfig {
  /** Harness adapter (NoOp for tests; Claude Code adapter for production). */
  adapter: HarnessAdapter;
  /** Optional override for the impl name (defaults to 'claude-code-learner'). */
  name?: string;
  /** Semver string for envelope provenance (defaults to '0.1.0-shim'). */
  version?: string;
  /**
   * Optional override for plugin root resolution. When unset, resolved from
   * the impl directory via `plugin-path.ts`. Tests may override.
   */
  pluginRoot?: string;
}
