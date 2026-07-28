/**
 * Harness-impl interface — §6.7 of the portfolio.v0 design spec.
 *
 * Pure type definitions; no runtime side effects.
 */

import type { Task } from '../types/task.js';
import type { OutputArtifact, RationaleEntry, Snapshot } from '../types/portfolio.js';
import type { TrajectoryCollector } from '../trajectory/index.js';
import type { ScopedSigner, ScopedRpc, ScopedSecrets } from './capability/index.js';

export interface RuntimePlugin {
  name: string;
  version: string;
  source: string;
  sourceKind?: string;
  solverType?: string;
  supports?: string[];
  root: string;
  manifestPath: string;
  sha256: string;
  cid?: string;
  provenance: 'default' | 'configured';
}

// ── HarnessContext ────────────────────────────────────────────────────────

export interface HarnessContext {
  task: Task;
  /** Canonical on-chain Task id for this attempt. */
  taskId?: string;
  /** Canonical zero-based marketplace attempt index. */
  attemptIndex?: number;
  /** On-chain / persisted request id for this run. May differ from task.id. */
  requestId?: string;
  solverNet?: { name: string; solverType: string; model?: string; provider?: import('./provider-ref.js').ProviderRef };
  runtimePlugins?: RuntimePlugin[];
  solverPluginRoots?: string[];
  /**
   * IPFS CID of this Task payload (from Marketplace / observe).
   * Harnesses' submission manifests should reference the same CID; evaluators
   * compare it via integrity.signedTask_ref. May be an empty string when
   * provenance is missing (dev / legacy).
   */
  taskCid?: string;
  /** Persistent directory for impl-specific state. */
  implStateDir: string;
  /** Ephemeral working directory (cleared between attempts). */
  workingDir: string;
  log: (event: { level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }) => void;
  /** Fires at window.endTs. */
  abort: AbortSignal;
  msUntilEndTs: () => number;
  /**
   * In-run trajectory collector. Impls call ctx.trajectory.addSpan(...)
   * (or use the traced wrappers) to emit spans. The engine emits the
   * collected trajectory to IPFS before envelope assembly and populates
   * envelope.trajectory with the resulting { cid, sha256 }.
   */
  trajectory: TrajectoryCollector;
  /**
   * Scoped signer capability. Present when the daemon is providing a
   * signing surface to this impl per its manifest allow-list. Absent
   * for stub-mode CLI introspection.
   * Spec: `spec/2026-05-executor-trust-boundary.md` §3.2.
   */
  signer?: ScopedSigner;
  /**
   * Scoped read-only RPC client. Method-filtered, rate-limited, and
   * chain-scoped per the impl's manifest.
   * Spec: `spec/2026-05-executor-trust-boundary.md` §3.3.
   */
  rpc?: ScopedRpc;
  /**
   * Per-impl secret bag, populated by `onEnable`.
   * Spec: `spec/2026-05-executor-trust-boundary.md` §3.4.
   */
  secrets?: ScopedSecrets;
  /**
   * Harness execution mode. See @jinn-network/sdk/harness HarnessContext.mode
   * for full documentation.
   */
  mode: 'train' | 'frozen';
}

// ── Solution ─────────────────────────────────────────────────────────

export interface Solution {
  venueRef: { name: string };

  /** Optional — evaluation Harnesses that do not operate on a venue leave these undefined. */
  preSnapshot?: Snapshot;
  postSnapshot?: Snapshot;
  fills?: unknown[];

  /** Shape is per solverType convention. */
  gating: Record<string, unknown>;
  informational?: Record<string, unknown>;

  /**
   * Full solution payload for Harnesses whose solverType has a non-portfolio payload
   * schema (e.g. prediction.v1, prediction.apy.v0).
   *
   * When set, engine.pack() uses this directly as the envelope payload
   * (validated against the solverType's solution schema) instead of building the
   * portfolio-shaped { preSnapshot, postSnapshot, fills, gating } wrapper.
   * Portfolio impls MUST leave this undefined (engine falls back to legacy shape).
   */
  solutionPayload?: Record<string, unknown>;

  /**
   * Full verdict payload for evaluation Harnesses (taskRole === 'evaluation').
   *
   * When set, engine.pack() uses role='verdict' and passes this as the
   * envelope payload directly (validated against the solverType's verdict schema).
   * Restoration impls MUST leave this undefined.
   */
  verdictPayload?: Record<string, unknown>;

  artifacts?: OutputArtifact[];
  rationale?: RationaleEntry[];

  /**
   * Failed working-tree diffs captured at in-session verifier/test
   * attempt boundaries during this run (#1643 / spec §10 field 4).
   * Harnesses that cannot observe boundaries omit this (engine treats
   * as []). Reference: apps/jinn-agent/plugins/jinn `_on_post_tool_call`.
   * Empty strings must not appear; engine dedupes on persist.
   */
  intermediateFailureDiffs?: string[];
}

// ── Enable / readiness types ──────────────────────────────────────────────────

/**
 * Context-free readiness probe. "Are this Harness's external dependencies
 * satisfied right now, regardless of any specific Task?" Used by
 * `jinn solver-nets doctor` and by the claim-policy gate that refuses
 * to spend gas claiming a Task whose Harness cannot execute.
 */
export interface ReadyStatus {
  ready: boolean;
  reason?: string;
  /** Optional hint for the operator/agent on how to become ready. */
  nextStep?: { description: string; cli?: string; url?: string };
}

/** Use when a Harness is built in CLI `stub` mode (no live fleet / signer). */
export const REQUIRES_LIVE_DAEMON_READINESS: ReadyStatus = {
  ready: false,
  reason: 'requires live daemon',
  nextStep: {
    description: 'Run the daemon with a configured fleet and wallet',
    cli: 'jinn run',
  },
};

/**
 * Argument a SolverNet-specific enable flow wants from the operator, surfaced
 * via `enableMetadata()`.
 */
export interface EnableArgDef {
  name: string;
  description: string;
  required: boolean;
}

/**
 * Metadata that `jinn solver-nets doctor` uses to teach the operator (or agent)
 * what's needed to enable a SolverNet. Returned without running the flow.
 */
export interface HarnessEnableMetadata {
  /** Human-readable summary of what opting in to this SolverNet entails. */
  description: string;
  requiredArgs?: EnableArgDef[];
  /** External URLs the operator/agent will need (e.g. exchange UI). */
  externalResources?: Array<{ name: string; url: string }>;
}

/**
 * Outcome of a single Harness/SolverNet enable invocation.
 *
 * The flow is idempotent: the agent reruns the same command until
 * `status === 'ready'`. Each intermediate state carries enough info for
 * the agent to know what to do next (show a URL, collect more args,
 * surface an error).
 */
export type EnableResult =
  | {
      status: 'ready';
      /** Anything the impl wants to surface (e.g. master address, wallet address). */
      details?: Record<string, unknown>;
    }
  | {
      status: 'waiting_for_external_action';
      /** What the operator has to do out-of-band (e.g. approve an api-wallet). */
      action: { description: string; url?: string };
      details?: Record<string, unknown>;
      /** The exact CLI the agent should re-run once the action is done. */
      nextInvocation: { cli: string; purpose: string };
    }
  | {
      status: 'missing_args';
      required: EnableArgDef[];
      example: { cli: string };
    }
  | {
      status: 'error';
      message: string;
      details?: Record<string, unknown>;
    };

export interface HarnessEnableContext {
  solverNet?: { name: string; solverType: string };
  runtimePlugins: RuntimePlugin[];
  args: Record<string, string | undefined>;
}

// ── Sentinel errors (impl → engine) ───────────────────────────────────────────

/**
 * Thrown by a {@link Harness} when the attempt should be recorded as a
 * deliberate skip (no failure / no claim retry), e.g. Claude CLI unavailable.
 */
export class SkippableError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'SkippableError';
    this.reason = reason;
  }
}

// ── Harness ──────────────────────────────────────────────────────────────

export interface Harness {
  name: string;
  /** semver */
  version: string;
  /**
   * Optional implStateDir paths that are runtime-only and should not contribute
   * to the frozen-mode state digest. Use this for generated credentials,
   * binaries, or per-task config that a harness needs in ctx.implStateDir but
   * that is not part of its learning/code surface.
   */
  freezeStateHashIgnore?: readonly string[];
  /**
   * Optional self-attribution: runtime plugins this harness bundles and runs
   * itself (not provided by the SolverNet's `runtimePlugins`), so they appear
   * in the solution envelope's `executor.plugins` like any other plugin.
   *
   * Only `LearnerHarness` implements this — it returns a descriptor for the
   * `claude-code-learner` plugin it loads from its own plugin root. Every other
   * harness omits the method and is unaffected (#1035).
   *
   * Called synchronously by the engine at the RUNNING transition; the digest is
   * stable per run, so implementers should compute it once (e.g. in their
   * constructor) and return the cached array.
   */
  attributionPlugins?(): RuntimePlugin[];
  /**
   * Optional self-declaration of WHERE this harness's credential lives, so the
   * operator dashboard can surface auth-source + a masked last-4 suffix + the
   * credential file's mtime + a loaded/missing/unknown badge — never the full
   * key (#564). Harnesses with no credential (e.g. prediction baselines) omit
   * this method; the endpoint reports them as "no auth required".
   *
   * The returned descriptor names the file/env/session; the daemon's shared
   * `resolveHarnessAuthStatus` helper owns the unsafe read (stat + slice(-4) +
   * discard). Implementers MUST NOT read or return the full credential here.
   */
  getAuthSource?(): Promise<import('./auth-source.js').HarnessAuthSource>;
  /**
   * Return true if this Harness should handle the given (solverType, role) pair.
   *
   * `role` reflects Task.role:
   *   - 'restoration' (or undefined — legacy default): the impl runs a restoration attempt
   *   - 'evaluation': the impl runs as an evaluator producing a verdict
   *
   * A Harness for solverType=X should return true for role !== 'evaluation'.
   * An evaluator Harness for solverType=X should return true for role === 'evaluation'.
   */
  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean;
  canAttempt?(task: Task): Promise<{ ok: true } | { ok: false; reason: string }>;
  run(ctx: HarnessContext): Promise<Solution>;

  /**
   * Readiness probe. Zero-dep impls can omit this (treated as `{ ready: true }`).
   * The optional context lets Harnesses report readiness for a specific
   * SolverType/role pair without reintroducing global plugin or wrapper state.
   */
  isReady?(ctx?: { solverType: string; role?: 'restoration' | 'evaluation' }): Promise<ReadyStatus>;

  /**
   * Describes what `onEnable` wants from the caller.
   */
  enableMetadata?(): HarnessEnableMetadata;

  /**
   * Idempotent enable-state machine. Called by `jinn harnesses enable <name>`
   * for direct Harness setup, or by SolverNet-specific enable flows when a
   * SolverNet's selected Harness also needs setup.
   *
   * Contract:
   *   - Zero-dep impls return `{ status: 'ready' }` on every call.
   *   - Impls with external deps advance as far as they can without
   *     blocking, then return a `waiting_for_external_action` envelope
   *     the agent surfaces to the operator.
   *   - Subsequent invocations pick up where the previous left off.
   *   - Calling after already-enabled is a no-op that returns `ready`.
   *
   * `ctx.args` is the raw `--key=value` map parsed from the CLI. Harnesses
   * validate and coerce as needed; missing required args should return
   * `{ status: 'missing_args', required: [...], example: {...} }`.
   *
   * Impls that omit this method cannot be enabled by the generic CLI;
   * they are either always-on (zero-dep) or require manual config.
   */
  onEnable?(
    ctx: HarnessEnableContext,
  ): Promise<EnableResult>;

  /**
   * Optional inverse of `onEnable`. Invoked when the operator runs
   * `jinn solver-nets disable <name>`. Should NOT destroy unrecoverable
   * state (generated key material, on-chain registrations); reserve
   * that for explicit `jinn solver-nets purge` or similar (out of scope
   * for this interface).
   */
  onDisable?(): Promise<void>;
}
