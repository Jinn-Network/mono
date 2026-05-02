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
