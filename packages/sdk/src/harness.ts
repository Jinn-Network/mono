export type {
  Address,
  Hex,
  IntentWindow,
  Task,
  OutputArtifact,
  RationaleEntry,
  Solution,
  TrajectoryCollector,
  TrajectorySpanInput,
  ReadyStatus,
  EnableArgDef,
  IntentEnableMetadata,
  EnableResult,
} from './types.js';
export { REQUIRES_LIVE_DAEMON_READINESS, SkippableError } from './types.js';

export type {
  SignTypedDataArgs,
  SendAllowedCallArgs,
  ScopedSigner,
  ScopedRpc,
  ScopedSecrets,
} from './capabilities.js';

export type {
  CapabilityAllowEntry,
  ManifestRpcAllow,
  ManifestSecretSpec,
  TypedDataAllowEntry,
  JinnManifest,
} from './manifest.js';

import type {
  Task,
  Solution,
  TrajectoryCollector,
  ReadyStatus,
  IntentEnableMetadata,
  EnableResult,
} from './types.js';
import type { ScopedSigner, ScopedRpc, ScopedSecrets } from './capabilities.js';

export interface HarnessContext {
  task: Task;
  taskCid?: string;
  implStateDir: string;
  workingDir: string;
  log: (event: {
    level: 'info' | 'warn' | 'error';
    msg: string;
    data?: unknown;
  }) => void;
  abort: AbortSignal;
  msUntilEndTs: () => number;
  trajectory: TrajectoryCollector;
  signer?: ScopedSigner;
  rpc?: ScopedRpc;
  secrets?: ScopedSecrets;
  /**
   * Harness execution mode.
   *
   * - `'train'` (default): learning mode. The harness's Improve / Memory
   *   phases (or equivalent writeback paths in a Path 2 harness) run;
   *   `implStateDir` mutates as the harness accumulates experience;
   *   `Executor.codeDigest` changes after each Task. Substrate-flow
   *   contributor.
   *
   * - `'frozen'`: evaluation mode. The harness MUST NOT write to
   *   `implStateDir`. State is read-only; `codeDigest` is stable across
   *   the entire frozen window. Verdicts on Solutions produced in this
   *   mode accumulate under a single `(implName, version, codeDigest)`
   *   identity, producing a clean benchmark score directly comparable to
   *   traditional harness leaderboards (OpenHands, SWE-Agent, Aider, etc).
   *
   * The protocol enforces the freeze contract via the daemon-side
   * hash-fence (the daemon hashes implStateDir before and after each Task
   * and rejects envelopes where the hash changed in frozen mode).
   * Path 2 harness implementations MUST gate writes on `mode === 'train'`;
   * the SDK provides `requireTrain(ctx, action)` as an opt-in helper at
   * write call sites.
   *
   * See docs/superpowers/specs/2026-05-06-agent-harness-solvernet-design.md §6
   * for the full design (trust stack, daemon enforcement, verified vs
   * unverified frozen credibility tier).
   */
  mode: 'train' | 'frozen';
}

/**
 * Construction-time environment passed to the impl factory.
 * Per-attempt Task inputs are provided through HarnessContext.
 */
export interface ExternalHarnessEnv {
  readonly implName: string;
  readonly implVersion: string;
  readonly network: string;
  readonly implStateDir: string;
  readonly secrets: ScopedSecrets;
  readonly log: HarnessContext['log'];
  /** True for CLI introspection; impls should report stub readiness. */
  readonly stub: boolean;
}

export interface Harness {
  name: string;
  version: string;
  supports(ctx: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean;
  canAttempt?(task: Task): Promise<{ ok: true } | { ok: false; reason: string }>;
  run(ctx: HarnessContext): Promise<Solution>;
  isReady?(spec?: { solverType: string; role?: 'restoration' | 'evaluation' }): Promise<ReadyStatus>;
  enableMetadata?(): IntentEnableMetadata;
  onEnable?(
    args: Record<string, string | undefined>,
    spec?: { solverType: string; role?: 'restoration' | 'evaluation' },
  ): Promise<EnableResult>;
  onDisable?(spec?: { solverType: string; role?: 'restoration' | 'evaluation' }): Promise<void>;
}

/**
 * External-impl factory: default-export shape for external Harness packages.
 */
export type ExternalHarnessFactory = (env: ExternalHarnessEnv) => Harness;

/**
 * Error thrown by SDK helpers when a harness violates an invariant.
 * Path 2 harness implementations may catch this to surface a typed error
 * to the daemon's task handler.
 */
export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

/**
 * Throws if the harness is in frozen mode. Use at write call sites in
 * Path 2 harness implementations to assert that a write to implStateDir
 * is only happening in train mode.
 *
 * @example
 *   requireTrain(ctx, 'update constitutional state');
 *   await fs.writeFile(constitutionPath, serialized);
 *
 * The daemon's hash-fence catches violations regardless of whether
 * `requireTrain` is used; this helper is purely for defensive ergonomics
 * at the harness implementation layer (fail fast at the call site rather
 * than after the Task completes).
 */
export function requireTrain(ctx: HarnessContext, action: string): void {
  if (ctx.mode === 'frozen') {
    throw new HarnessError(
      `Cannot ${action} in frozen mode. Gate this write on ctx.mode === 'train'.`,
    );
  }
}
