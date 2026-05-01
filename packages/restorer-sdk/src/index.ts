// @jinn-network/restorer-sdk
//
// Stable contract surface for Jinn external restorer / evaluator
// implementations. External impl authors depend on this package, NOT
// on @jinn-network/client directly.

export type {
  Address,
  Hex,
  IntentWindow,
  DesiredStateSpec,
  RestorationJob,
  OutputArtifact,
  RationaleEntry,
  RestorationOutput,
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
  RestorationJob,
  RestorationOutput,
  ReadyStatus,
  IntentEnableMetadata,
  EnableResult,
} from './types.js';
import type { ScopedSigner, ScopedRpc, ScopedSecrets } from './capabilities.js';

export interface RestorationContext {
  intent: RestorationJob;
  intentCid?: string;
  implStateDir: string;
  workingDir: string;
  log: (event: {
    level: 'info' | 'warn' | 'error';
    msg: string;
    data?: unknown;
  }) => void;
  abort: AbortSignal;
  msUntilEndTs: () => number;
  signer?: ScopedSigner;
  rpc?: ScopedRpc;
  secrets?: ScopedSecrets;
}

/**
 * Construction-time environment passed to the impl factory.
 * See spec/2026-05-external-restorer-impls.md §3.2.
 */
export interface ExternalRestorerEnv {
  readonly implName: string;
  readonly implVersion: string;
  readonly network: string;
  readonly implStateDir: string;
  readonly secrets: ScopedSecrets;
  readonly log: RestorationContext['log'];
  /** True for CLI introspection; impls should report stub readiness. */
  readonly stub: boolean;
}

export interface RestorerImpl {
  name: string;
  version: string;
  supports(ctx: { kind: string; type?: 'restoration' | 'evaluation' }): boolean;
  canAttempt?(
    intent: RestorationJob,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  run(ctx: RestorationContext): Promise<RestorationOutput>;
  isReady?(): Promise<ReadyStatus>;
  enableMetadata?(): IntentEnableMetadata;
  onEnable?(args: Record<string, string | undefined>): Promise<EnableResult>;
  onDisable?(): Promise<void>;
}

/**
 * External-impl factory: default-export shape per
 * spec/2026-05-external-restorer-impls.md §3.2.
 */
export type ExternalRestorerFactory = (env: ExternalRestorerEnv) => RestorerImpl;
