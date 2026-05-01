/**
 * Restorer-impl interface — §6.7 of the portfolio.v0 design spec.
 *
 * Pure type definitions; no runtime side effects.
 */

import type { RestorationJob } from '../types/desired-state.js';
import type { OutputArtifact, RationaleEntry, Snapshot } from '../types/portfolio.js';
import type { TrajectoryCollector } from '../trajectory/index.js';
import type { ScopedSigner, ScopedRpc, ScopedSecrets } from './capability/index.js';

// ── RestorationContext ────────────────────────────────────────────────────────

export interface RestorationContext {
  intent: RestorationJob;
  /**
   * IPFS CID of this job's desired state (from Marketplace / observe).
   * Restorers' submission manifests should reference the same CID; evaluators
   * compare it via integrity.intent_ref. May be an empty string when
   * provenance is missing (dev / legacy).
   */
  intentCid?: string;
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
}

// ── RestorationOutput ─────────────────────────────────────────────────────────

export interface RestorationOutput {
  venueRef: { name: string };

  /** Optional — evaluator impls that do not operate on a venue leave these undefined. */
  preSnapshot?: Snapshot;
  postSnapshot?: Snapshot;
  fills?: unknown[];

  /** Shape is per spec.kind convention. */
  gating: Record<string, unknown>;
  informational?: Record<string, unknown>;

  /**
   * Full restoration payload for impls whose kind has a non-portfolio payload
   * schema (e.g. prediction.v0, prediction.apy.v0).
   *
   * When set, engine.pack() uses this directly as the envelope payload
   * (validated against the kind's restoration schema) instead of building the
   * portfolio-shaped { preSnapshot, postSnapshot, fills, gating } wrapper.
   * Portfolio impls MUST leave this undefined (engine falls back to legacy shape).
   */
  restorationPayload?: Record<string, unknown>;

  /**
   * Full verdict payload for evaluator impls (intentType === 'evaluation').
   *
   * When set, engine.pack() uses role='verdict' and passes this as the
   * envelope payload directly (validated against the kind's verdict schema).
   * Restoration impls MUST leave this undefined.
   */
  verdictPayload?: Record<string, unknown>;

  artifacts?: OutputArtifact[];
  rationale?: RationaleEntry[];
}

// ── Enable / readiness types ──────────────────────────────────────────────────

/**
 * Kind/type slice for contextual impl probes (`isReady`, `enableMetadata`,
 * `onEnable` / `onDisable` delegation on wrappers). Mirrors the `supports()`
 * discriminant.
 */
export type ImplIntentPeek = {
  kind: string;
  type?: 'restoration' | 'evaluation';
};

/**
 * Context-free readiness probe. "Are this impl's external dependencies
 * satisfied right now, regardless of any specific intent?" Used by
 * `jinn intents list|status` and by the claim-policy gate that refuses
 * to spend gas claiming an intent whose impl cannot execute.
 */
export interface ReadyStatus {
  ready: boolean;
  reason?: string;
  /** Optional hint for the operator/agent on how to become ready. */
  nextStep?: { description: string; cli?: string; url?: string };
}

/** Use when an impl is built in CLI `stub` mode (no live fleet / signer). */
export const REQUIRES_LIVE_DAEMON_READINESS: ReadyStatus = {
  ready: false,
  reason: 'requires live daemon',
  nextStep: {
    description: 'Run the daemon with a configured fleet and wallet',
    cli: 'jinn run',
  },
};

/**
 * Argument a kind-specific enable flow wants from the operator, surfaced
 * via `enableMetadata()`. The generic `jinn intents enable <kind>` verb
 * parses these from `--key=value` flags without caring what they mean.
 */
export interface EnableArgDef {
  name: string;
  description: string;
  required: boolean;
}

/**
 * Metadata that `jinn intents list` uses to teach the operator (or agent)
 * what's needed to enable a kind. Returned without running the flow.
 */
export interface IntentEnableMetadata {
  /** Human-readable summary of what opting in to this kind entails. */
  description: string;
  requiredArgs?: EnableArgDef[];
  /** External URLs the operator/agent will need (e.g. exchange UI). */
  externalResources?: Array<{ name: string; url: string }>;
}

/**
 * Outcome of a single `jinn intents enable <kind>` invocation.
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

// ── Sentinel errors (impl → engine) ───────────────────────────────────────────

/**
 * Thrown by a {@link RestorerImpl} when the attempt should be recorded as a
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

// ── RestorerImpl ──────────────────────────────────────────────────────────────

export interface RestorerImpl {
  name: string;
  /** semver */
  version: string;
  /**
   * Return true if this impl should handle the given (kind, type) pair.
   *
   * `type` reflects RestorationJob.type:
   *   - 'restoration' (or undefined — legacy default): the impl runs a restoration attempt
   *   - 'evaluation': the impl runs as an evaluator producing a verdict
   *
   * A restorer impl for kind=X should return true for type !== 'evaluation'.
   * An evaluator impl for kind=X should return true for type === 'evaluation'.
   */
  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean;
  canAttempt?(intent: RestorationJob): Promise<{ ok: true } | { ok: false; reason: string }>;
  run(ctx: RestorationContext): Promise<RestorationOutput>;

  /**
   * Readiness probe. Zero-dep impls can omit this (treated as `{ ready: true }`).
   * When `spec` is provided (daemon pre-claim gate, `jinn intents`), wrappers
   * should delegate to the kind-matched specialist instead of aggregating all.
   */
  isReady?(spec?: ImplIntentPeek): Promise<ReadyStatus>;

  /**
   * Describes what `onEnable` wants from the caller. Consumed by
   * `jinn intents list` so the agent can tell the operator what a
   * specific kind's enable flow needs without triggering it first.
   * With `spec`, wrappers delegate to the specialist for that kind.
   */
  enableMetadata?(spec?: ImplIntentPeek): IntentEnableMetadata | undefined;

  /**
   * Idempotent enable-state machine. Called by `jinn intents enable <kind>`.
   *
   * Contract:
   *   - Zero-dep impls return `{ status: 'ready' }` on every call.
   *   - Impls with external deps advance as far as they can without
   *     blocking, then return a `waiting_for_external_action` envelope
   *     the agent surfaces to the operator.
   *   - Subsequent invocations pick up where the previous left off.
   *   - Calling after already-enabled is a no-op that returns `ready`.
   *
   * `args` is the raw `--key=value` map parsed from the CLI. Impls
   * validate and coerce as needed; missing required args should return
   * `{ status: 'missing_args', required: [...], example: {...} }`.
   *
   * Impls that omit this method cannot be enabled by the generic CLI;
   * they are either always-on (zero-dep) or require manual config.
   */
  onEnable?(args: Record<string, string | undefined>, spec?: ImplIntentPeek): Promise<EnableResult>;

  /**
   * Optional inverse of `onEnable`. Invoked when the operator runs
   * `jinn intents disable <kind>`. Should NOT destroy unrecoverable
   * state (generated key material, on-chain registrations); reserve
   * that for explicit `jinn intents purge` or similar (out of scope
   * for this interface).
   */
  onDisable?(spec?: ImplIntentPeek): Promise<void>;
}
