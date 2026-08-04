/**
 * Wire response types mirrored from the daemon (spec/2026-08-04-headless-operator-rederivation-design.md
 * §8 artifact 2). Relocated verbatim from the former
 * `client/src/dashboard/spa/src/api/types.ts` (deleted — see that PR's body for the drift
 * list found while cutting the SPA over to this module). `StatusV1Response`, the
 * `LifecycleKind` vocabulary, and the lifecycle/activity event shapes live in sibling
 * modules (`status.ts`, `lifecycle-kind.ts`) instead of here.
 *
 * These are plain mirrored types, not Zod schemas — the daemon routes that serve them
 * don't validate their own output against a runtime schema today, so restating them as
 * Zod here would assert a rigor that doesn't exist yet. Promoting one to a real schema
 * (and generating its OpenAPI entry) is a route-at-a-time follow-up, per §8's "structure
 * so routes are added cheaply."
 *
 * `BootstrapState.steps`/`currentStep`/`services[].step` are typed off
 * `FleetBootstrapPhase` (`fleet-bootstrap-phases.const.ts`, zero-import) rather than plain
 * `string` — the 15-member unified fleet bootstrap phase list `bootstrap-endpoint.ts`
 * actually serves (issue #2407), not a re-declared copy.
 */
import type { FleetBootstrapPhase } from './fleet-bootstrap-phases.const.js';

// ── OLAS reward read state ────────────────────────────────────────────────────
//
// Read state for the operator's OLAS (stOLAS) earned figures, consumed by the
// Wallet card.
export type StakingRewardReadState = 'pending' | 'ready' | 'error';

export interface RewardsServiceEntry {
  index: number;
  pending: string;
  claimed: string;
  asset: 'OLAS';
  lastClaimAt: string | null;
  lastClaimTxHash: string | null;
}

export interface RewardsResponse {
  schemaVersion: 1;
  generatedAt: string;
  readState: 'ready' | 'error';
  totalPending: string;
  totalClaimed: string;
  lastClaimAt: string | null;
  lastClaimTickAt: string | null;
  nextCheckpointAt: string | null;
  error?: string;
  services: RewardsServiceEntry[];
}

export interface ClaimRewardsResponse {
  ok: boolean;
  result?: {
    submitted?: number;
    skippedNoPending?: number;
    claims?: Array<{ txHash?: string; amountWei?: string; serviceId?: number }>;
  };
  exitCode?: number | null;
  error?: string;
}

export type DaemonMode = 'setup' | 'running' | 'uninitialized';

export interface BootstrapErrorEnvelope {
  schemaVersion: 1;
  generatedAt: string;
  code: 'funding_required' | 'invalid_invocation' | 'bootstrap_incomplete' | 'reconcile_needed' | 'transient_error' | 'fatal';
  exitCode: number;
  message: string;
  hint?: string;
  exampleCli?: string;
  details?: Record<string, unknown>;
}

/** Per-slot boot-probe health for one RPC fallback slot (#913). Host masked. */
export interface RpcSlotHealth {
  ok: boolean;
  host: string;
  expectedChainId?: number;
  actualChainId?: number;
  latencyMs?: number;
  /** HTTP status when the slot failed with one (e.g. 429, 503). */
  code?: number;
  /** Structured failure reason when no HTTP status is present. */
  reason?: 'chain_mismatch' | 'unreachable' | 'unknown';
  localDev?: true;
}

export interface BootstrapState {
  schemaVersion: 1;
  mode: DaemonMode;
  steps: FleetBootstrapPhase[];
  currentStep: FleetBootstrapPhase;
  services: Array<{
    index: number;
    step: FleetBootstrapPhase;
    safe_address?: string;
    service_id?: number;
    /** Raw error string set when a bootstrap step fails non-fatally (e.g. safe_binding_failed). */
    error?: string | null;
    /**
     * Decoded contract revert reason when `error` starts with `safe_binding_failed`.
     * Null when the revert had no reason string; absent on older state files.
     */
    error_revert_reason?: string | null;
  }>;
  master_address?: string;
  chain?: string;
  /** Operator-configured RPC URL (absent when the default is in use). */
  rpcUrl?: string;
  /** Chain default RPC URL — the shared, rate-limited trial endpoint. */
  defaultRpcUrl?: string;
  /** #913: the live ordered RPC fallback chain (slot 0 = head/primary). */
  rpcUrls?: string[];
  /** #913: the bundled public RPC chain for the current network. */
  publicDefaults?: string[];
  /** #913: boot-probe health per slot, index-aligned to `rpcUrls`. */
  rpcSlotHealth?: RpcSlotHealth[];
  fleet_agent_id?: string;
  fleet_safe_address?: string;
  funding?: {
    master_address?: string;
    eth_required?: string;
    eth_balance?: string;
    targetWei?: string;
    /**
     * True only when master balance has met or exceeded the bootstrap target
     * AND `currentStep` has advanced past `awaiting_funding`. Present only
     * when the funding block is included (i.e. when the gate was recently
     * active). When the gate clears the funding block is omitted entirely,
     * so consumers should treat absent funding as "not blocking" and present
     * funding with targetMet===false as "still blocking".
     */
    targetMet?: boolean;
  };
  joinedSolverNets?: Record<string, {
    name?: string;
    manifestCid?: string;
    contract?: { id: string; version: string };
    roles?: string[];
    harness?: string;
    model?: string;
    plugins?: string[];
    disabledDefaultPlugins?: string[];
  }>;
  /**
   * #983: true once the operator clicked "Enter dashboard" at the end of the
   * guided onboarding takeover. App.tsx gates the bootstrap→dashboard hand-off
   * on `mode==='running' && onboardingComplete` so the first SolverNet join no
   * longer ejects the operator before the harness/model step. Sourced from the
   * daemon's in-memory config (POST /v1/operator/onboarding-complete writes it).
   */
  onboardingComplete?: boolean;
  /** Persisted from the last fatal bootstrap exit. Absent on healthy state. */
  error?: BootstrapErrorEnvelope;
  // Issue #367: the embedded-agent feature flag is no longer carried in this
  // response. The operator app reads it (and every other feature flag) via the
  // injected `window.__JINN_FEATURES__` — see `lib/features.ts` `getFeatures()`.
}

export interface ClaudeAuthState {
  schemaVersion: 1;
  authenticated: boolean;
  context: 'bare' | 'docker-compose' | 'container';
  detail: string;
  binary: {
    ok: boolean;
    detail: string;
    resolvedPath?: string;
  };
  email?: string;
}

export interface SolverNetCatalogEntry {
  name: string;
  description: string;
  state: 'live' | 'available' | 'coming_soon';
  /**
   * Canonical contract identity post-SDK-migration. Replaces the legacy
   * `intrinsicSolverType: string` (concatenated `id.version`) with the
   * `{id, version}` pair carried by the manifest's contract block. SPA
   * consumers match a joined manifest's `contract` field directly against
   * this — no string concat on either side.
   */
  contract: { id: string; version: string };
  supportedRoles: ('solving' | 'evaluating')[];
  compatibleHarnesses: Array<{
    name: string;
    version: string;
    supportsRoles: ('solving' | 'evaluating')[];
  }>;
  compatiblePlugins: Array<{ name: string; version: string; source: string }>;
}

export interface SolverNetsCatalogResponse {
  schemaVersion: 1;
  generatedAt: string;
  nets: SolverNetCatalogEntry[];
}

/**
 * Mirror of the daemon-side `LauncherStatusResponse`
 * (client/src/api/launcher-status.ts). Surfaces per-SolverNet generator state,
 * open-Task counts, and Safe-budget runway for SolverNets whose `roles`
 * includes `'launching'`. Operator mode never reads this — the launcher state
 * lives exclusively here (spec/2026-05-05-launcher-role-and-mode.md §6.3).
 */
export interface LauncherStatusGeneratorView {
  state: 'active' | 'paused' | 'errored';
  lastPollAt?: string;
  lastPollSummary?:
    | {
    evaluated: number;
    posted: number;
    skipped: number;
    }
    | {
      poolSize: number;
      posted: number;
      unposted: number;
      live: number;
      repostable: number;
      saturated: number;
    };
  lastError?: { message: string; at: string };
  cadenceMs?: number;
  stale: boolean;
}

export interface LauncherStatusBudgetView {
  safeAddress: string;
  safeBalanceWei: string;
  reservedBudgetWei: string;
  runwayDays?: number;
}

export interface LauncherStatusNetEntry {
  name: string;
  solverType?: string;
  generator: LauncherStatusGeneratorView;
  openTasks: number;
  budget: LauncherStatusBudgetView;
}

export interface LauncherStatusResponse {
  schemaVersion: 1;
  generatedAt: string;
  nets: LauncherStatusNetEntry[];
}

/**
 * Mirror of the daemon-side `LauncherTaskState` / `LauncherTaskEntry` /
 * `LauncherTasksResponse` (client/src/api/launcher-tasks.ts). Paginated by
 * `cursor.before` (ISO timestamp); the SPA passes the bare ISO back as the
 * next-page cursor.
 */
export type LauncherTaskState =
  | 'open'
  | 'claims-in-flight'
  | 'fully-claimed'
  | 'settled'
  | 'failed';

/**
 * Mirror of the daemon-side `TaskOnchainStatus` (client/src/discovery/types.ts).
 * On-chain finalization status for the Recent posted Tasks chip — DISTINCT from
 * the local generator-side `state`. `'unknown'` is the safe degraded default.
 */
export type TaskOnchainStatus = 'open' | 'finalized' | 'expired' | 'unknown';

export interface LauncherTaskEntry {
  taskId: string;
  taskCid: string;
  solverNet: string;
  solverType?: string;
  postedAt: string;
  state: LauncherTaskState;
  onchainStatus: TaskOnchainStatus;
  claims: { current: number; max: number };
  budget: { totalWei: string; remainingWei: string; reclaimableAt?: string };
  summary?: { title?: string; resolutionTime?: string };
}

export interface LauncherTasksResponse {
  schemaVersion: 1;
  generatedAt: string;
  cursor?: { before: string };
  tasks: LauncherTaskEntry[];
}

export interface LauncherTasksRequestOptions {
  cursor?: string;
  limit?: number;
  /** Launched-record manifest CID used to scope on-chain status lookup. */
  manifestCid?: string;
}

/**
 * Legacy body shape for `PATCH /v1/launcher/solvernets/:name`. The endpoint
 * was retired by Task 22 of spec/2026-05-05-solvernet-creation-and-launch.md
 * (the operator-config `'launching'` role + top-level `predictionV1*` keys
 * were dropped from the schema). The daemon now returns 410 Gone for any
 * call against this route. SPA callers should drive launcher-mode SolverNet
 * edits through the launched-record subsystem instead.
 */
export interface LauncherSolverNetPatch {
  launching?: boolean;
  generator?: {
    cadenceMs?: number;
    maxNewRoundsPerPoll?: number;
    maxNewRoundsPerDay?: number;
    maxOpenRounds?: number;
    allowlistConditionIds?: string[];
    blocklistConditionIds?: string[];
    windowMs?: number;
    resolveGapMs?: number;
  };
}

export interface LauncherSolverNetPatchResponse {
  ok: true;
  name: string;
  roles: string[];
  generator: Record<string, unknown>;
}

export type OperatorArtifactSource = 'served' | 'network';

export interface OperatorPricingConfig {
  publicEndpoint: string;
  defaultPriceUsdc: string;
  perArtifactTypePrice: Record<string, string>;
  donation: { enabled: boolean };
}

export interface OperatorArtifactTypeSummary {
  artifactType: string;
  count: number;
  totalBytes: number;
  gatedCount?: number;
}

export interface OperatorServedStorageSummary {
  totalCount: number;
  totalBytes: number;
  freeCount: number;
  gatedCount: number;
  latestCreatedAt: string | null;
  artifactTypes: OperatorArtifactTypeSummary[];
}

export interface OperatorNetworkStorageSummary {
  totalCount: number;
  totalBytes: number;
  latestFetchedAt: string | null;
  artifactTypes: OperatorArtifactTypeSummary[];
}

export type OperatorArtifactAccessOutcome =
  | 'free_served'
  | 'payment_required'
  | 'paid_served'
  | 'verification_failed'
  | 'settlement_failed'
  | 'payment_malformed'
  | 'not_found';

export interface OperatorArtifactAccessStats {
  accessCount: number;
  paidServeCount: number;
  freeServeCount: number;
  failedPaymentCount: number;
  paymentRequiredCount: number;
  revenueUsdc: string;
  lastAccessAt: string | null;
  lastPaidAt: string | null;
}

export interface OperatorArtifactAccessEvent {
  id: number;
  sha256: string;
  artifactType: string | null;
  priceUsdc: string | null;
  outcome: OperatorArtifactAccessOutcome;
  httpStatus: number;
  payer: string | null;
  settlementTx: string | null;
  errorReason: string | null;
  remoteAddr: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface OperatorArtifactProjectionExecutor {
  implName: string | null;
  implVersion: string | null;
  runtimeBundleDigest: string | null;
  plugins: string[] | null;
}

export interface OperatorArtifactProjectionSolutionRef {
  envelopeCid: string;
  envelopeSha256: string | null;
  ref: string | null;
}

export interface OperatorArtifactProjection {
  envelopeId: string;
  signatureHash: string;
  solverType: string;
  role: string;
  taskCid: string | null;
  taskId: string | null;
  requestId: string | null;
  generatedAt: number;
  evidenceTier: 'self-signed' | 'committed' | 'attested';
  participantSafeAddress: string | null;
  participantAgentEoa: string | null;
  executor: OperatorArtifactProjectionExecutor;
  solutionRef?: OperatorArtifactProjectionSolutionRef;
  metadata: Record<string, string | number | boolean> | null;
}

export interface OperatorArtifactAnchor {
  contentKind: string;
  metadataKey: string;
  agentId: string;
  chainId: number;
  identityRegistryAddress: string;
  txHash: string;
  blockNumber: number | null;
  payloadHex: string;
  anchoredAt: number;
}

export interface OperatorServedArtifact {
  source: 'served';
  sha256: string;
  artifactType: string;
  requestId: string | null;
  envelopeCid: string | null;
  contentSize: number;
  priceUsdc: string;
  createdAt: string;
  endpoint: string | null;
  access: OperatorArtifactAccessStats;
  projection?: OperatorArtifactProjection;
  anchors: OperatorArtifactAnchor[];
}

export interface OperatorNetworkArtifact {
  source: 'network';
  sha256: string;
  artifactType: string;
  envelopeCid: string | null;
  contentSize: number;
  origin: 'origin' | 'route-resolver' | 'self-store-mirror';
  sourceOperator: string | null;
  sourceEndpoint: string | null;
  paidAmountUsdc: string;
  fetchedAt: string;
  lastUsedAt: string;
  peerCatalogId: string | null;
  projection?: OperatorArtifactProjection;
  anchors: OperatorArtifactAnchor[];
}

export type OperatorArtifact = OperatorServedArtifact | OperatorNetworkArtifact;

export interface OperatorArtifactsResponse {
  schemaVersion: 1 | 2;
  generatedAt: string;
  source: OperatorArtifactSource;
  pricing: OperatorPricingConfig;
  summary: {
    served: OperatorServedStorageSummary;
    network: OperatorNetworkStorageSummary;
    access: OperatorArtifactAccessStats;
  };
  recentAccesses: OperatorArtifactAccessEvent[];
  artifacts: OperatorArtifact[];
}

// ── SolverNet creation + launch (spec/2026-05-05-solvernet-creation-and-launch.md) ──
//
// These types mirror the daemon-side shapes:
//
//   `DraftSolverNetRecord`     — `client/src/solvernets/store.ts` (§6.1)
//   `LaunchedSolverNetRecord`  — `client/src/solvernets/store.ts` (§6.2)
//   `SolverNetManifestSummary` — `client/src/solvernets/registry-client.ts`
//   `SolverNetManifestV1`      — `@jinn-network/sdk/solvernets`
//   `GeneratorConfig`          — `PredictionV1GeneratorRuntimeConfig` from
//                                `client/src/solver-types/prediction-v1-auto.ts`
//
// Mirrored here (rather than imported) because the SPA's tsconfig only
// includes `src/dashboard/spa/src` — we keep the SPA build unconditional on
// the daemon-side / SDK type graph, matching the predecessor pattern for
// `LauncherStatusResponse` etc. Drift is checked by daemon-side tests that
// keep these shapes stable.

/** Hex string with `0x` prefix. */
export type HexString = `0x${string}`;

/** Loose 0x-prefixed 20-byte address; not validated past prefix on this side. */
export type Address = `0x${string}`;

/** ISO-8601 timestamp string. */
export type Iso8601 = string;

export type DraftWizardStep =
  | 'define'
  | 'reviewContract'
  | 'configureGenerator'
  | 'configurePricing';

/**
 * Draft Create-flow record (Task 13). Most fields are optional because drafts
 * are partial-by-construction — `completedSteps` tracks wizard progression.
 */
export interface DraftSolverNetRecord {
  schemaVersion: 'solvernet.draft.v1';
  draftId: string;

  templateContractId?: string;
  templateContractVersion?: string;

  name?: string;
  description?: string;

  generatorConfig?: Record<string, unknown>;

  solutionPriceWei?: string;
  verdictPriceWei?: string;

  openRoles?: Array<'solver' | 'evaluator'>;

  completedSteps: DraftWizardStep[];

  createdAt: Iso8601;
  updatedAt: Iso8601;
}

/** Editable subset of a draft — what `createDraft` and `updateDraft` accept. */
export type DraftSolverNetRecordPatch = Partial<
  Pick<
    DraftSolverNetRecord,
    | 'templateContractId'
    | 'templateContractVersion'
    | 'name'
    | 'description'
    | 'generatorConfig'
    | 'solutionPriceWei'
    | 'verdictPriceWei'
    | 'openRoles'
    | 'completedSteps'
  >
>;

/** Phase the launch state machine is in (`launchProgress.phase`). */
export type LaunchActionPhase =
  | 'pinning'
  | 'recording'
  | 'broadcasting'
  | 'confirming'
  | 'spawning';

/** Phase a lifecycle transition (pause / resume / retire) is in. */
export type LifecycleTransitionPhase = 'broadcasting' | 'confirming';

export type LifecycleTarget = 'paused' | 'launched' | 'retired';

export type LaunchedStatus =
  | 'launching'
  | 'launched'
  | 'paused'
  | 'retired'
  | 'failed';

export interface TimestampedError {
  message: string;
  at: Iso8601;
}

export interface LaunchProgress {
  phase: LaunchActionPhase;
  txHash?: HexString;
  txError?: TimestampedError;
  attemptCount: number;
}

export interface LifecycleProgress {
  phase: LifecycleTransitionPhase;
  target: LifecycleTarget;
  txHash?: HexString;
  txError?: TimestampedError;
  attemptCount: number;
}

export interface LaunchedGeneratorState {
  lastPollAt?: Iso8601;
  lastPollSummary?: LauncherStatusGeneratorView['lastPollSummary'];
  lastError?: TimestampedError;
  poolPublicationUpdatedAt?: Iso8601;
  poolPublicationPriorSize?: number;
  poolPublicationCurrentSize?: number;
  poolPublicationStale?: boolean;
  totalPosted?: number;
  lastPostedInstanceId?: string;
}

export interface LaunchedRegistryRefs {
  metadataTxHash?: HexString;
  metadataBlockNumber?: number;
}

/**
 * Local persistent record for a SolverNet this daemon has launched. The SPA
 * polls this for launch progress and post-launch state.
 *
 * `summary` is enriched server-side from the daemon's in-process manifest
 * cache (`SolverNetRegistryClient.getManifestFromCache`). Present for every
 * SolverNet this daemon launched once the cache is warm; `undefined`
 * during the brief pre-cache window of a launch in flight, or when the
 * registry client is not wired. SPA list/detail surfaces should treat
 * `summary` as the source of catalog identity (name, contract, prices,
 * openRoles) and fall back to the bare record fields when it is absent.
 */
export interface LaunchedSolverNetRecord {
  schemaVersion: 'solvernet.launched.v1';
  solverNetId: string;
  manifestCid: string;
  manifestPath?: string;
  manifestHash: HexString;

  launcherAgentId: string;
  launcherSafeAddress: Address;
  launchedAt: Iso8601;

  status: LaunchedStatus;
  statusUpdatedAt: Iso8601;

  generatorEnabled: boolean;
  generatorState?: LaunchedGeneratorState;
  generatorConfig?: Record<string, unknown>;

  launchProgress?: LaunchProgress;
  lifecycleProgress?: LifecycleProgress;

  registry: LaunchedRegistryRefs;

  summary?: SolverNetManifestSummary;
}

/** Hot-applyable subset of the prediction-v1 generator runtime config. */
export interface GeneratorConfig {
  cadenceMs?: number;
  maxNewRoundsPerPoll?: number;
  maxNewRoundsPerDay?: number;
  maxOpenRounds?: number;
  submissionWindowMs?: number;
  allowlistConditionIds?: string[];
  blocklistConditionIds?: string[];
  minTimeToResolutionHours?: number;
  maxTimeToResolutionHours?: number;
  minLiquidityUsd?: string;
  minVolume24hUsd?: string;
  maxYesSpread?: string;
  maxOrderbookAgeSeconds?: number;
  N_target_successes?: number;
  /** @deprecated #802 — abandon cap removed; tolerated on read, no longer edited. */
  N_max_postings_per_task?: number;
  posting_window_ms?: number;
  post_batch_size?: number;
  maxClaimsPerOperator?: number;
  claimLeaseTtlSeconds?: number;
  admissionMode?: 'required' | 'python-floor';
  cooldown_ms?: number;
  claimPolicy?: {
    maxClaims?: number;
    maxClaimsPerOperator?: number;
    claimLeaseTtlSeconds?: number;
  };
}

/**
 * Catalog-row projection of a launched SolverNet. Returned by the global
 * registry endpoint (`/v1/solvernets/registry`); mirrors
 * `SolverNetManifestSummary` in `client/src/solvernets/registry-client.ts`.
 */
export interface SolverNetManifestSummary {
  manifestCid: string;
  solverNetId: string;
  name: string;
  network: string;
  launcherAgentId: string;
  launcherSafeAddress: Address;
  status: 'launched' | 'paused' | 'retired';
  statusUpdatedAt: Iso8601;
  contractId: string;
  contractVersion: string;
  solutionPriceWei: string;
  verdictPriceWei: string;
  openRoles: Array<'solver' | 'evaluator'>;
  anchorBlock: number;
}

/**
 * Compact summary used by the owned-SolverNets list page (`/launcher`). The
 * SPA derives this from `LaunchedSolverNetRecord` for now; once the daemon
 * grows a server-side projection, this becomes the wire shape.
 */
export interface SolverNetSummary {
  solverNetId: string;
  name?: string;
  status: LaunchedStatus;
  statusUpdatedAt: Iso8601;
  manifestCid: string;
  launchedAt: Iso8601;
}

/**
 * Manifest body shape — mirror of `SolverNetManifestV1` from
 * `@jinn-network/sdk/solvernets`. Mirrored here to keep the SPA build free of
 * the SDK type graph; the daemon validates manifests against the canonical
 * Zod schema before they ever reach the SPA.
 */
export interface SolverNetManifestV1 {
  schemaVersion: 'solvernet.manifest.v1';
  solverNetId: string;
  network: 'base-sepolia' | 'base';
  name: string;
  description: string;
  launcher: {
    safeAddress: HexString;
    agentEoa: HexString;
    agentId: string;
  };
  contract: {
    id: string;
    version: string;
    schemas: {
      task: Record<string, unknown>;
      solution: Record<string, unknown>;
      verdict: Record<string, unknown>;
    };
    claimPolicyDefaults: {
      mode: 'parallel' | 'serial';
      maxClaims: number;
      maxClaimsPerOperator: number;
      claimLeaseTtlSeconds: number;
    };
    credentialRequirements: {
      creator: SolverNetCredentialRequirement[];
      solver: SolverNetCredentialRequirement[];
      evaluator: SolverNetCredentialRequirement[];
    };
    evaluationFunction: {
      id: string;
      deterministic: boolean;
      inputs: string[];
      output: string;
      implementation: string;
    };
    aggregationFunction: {
      id: string;
      deterministic: boolean;
      inputs: string[];
      output: string;
      windowDays?: number;
    };
  };
  solutionPriceWei: string;
  verdictPriceWei: string;
  openRoles: Array<'solver' | 'evaluator'>;
  generatorConfig?: Record<string, unknown>;
  registry?: {
    manifestCid?: string;
    registryUrl?: string;
  };
  createdAt: Iso8601;
  launchedAt: Iso8601;
  signature: {
    alg: 'eip-191';
    signer: HexString;
    value: HexString;
  };
}

export interface SolverNetCredentialRequirement {
  id: string;
  kind: string;
  required: boolean;
  description: string;
}

/** Wire shape for an entry in the global registry catalog. */
export type RegistryEntry = SolverNetManifestSummary;

/** Response shape for `POST /v1/solvernets/drafts/:id/launch`. */
export interface LaunchAction {
  solverNetId: string;
  status: LaunchedStatus;
  pollUrl: string;
}

/** Response shape for `PATCH /v1/solvernets/launched/:id/lifecycle`. */
export type LifecycleTransition = LaunchedSolverNetRecord;

/**
 * Typed reason a registry catalog refresh failed. Currently only
 * `rpc_rate_limited` — the configured RPC endpoint returned a 429. The SPA
 * branches on this to show an operator-actionable message ("add your own RPC
 * key") instead of a generic failure string. See jinn-mono #325.
 */
export type RegistryErrorCode = 'rpc_rate_limited';

export interface RegistryListResponse {
  summaries: SolverNetManifestSummary[];
  lastRefreshedAt: Iso8601 | null;
  lastError: { message: string; at: Iso8601; code?: RegistryErrorCode } | null;
}

export interface RegistryManifestResponse {
  manifest: SolverNetManifestV1;
  lifecycle: {
    status: 'launched' | 'paused' | 'retired';
    statusUpdatedAt: Iso8601;
    sourceBlock: number;
  };
}

export interface OwnedLaunchedListResponse {
  records: LaunchedSolverNetRecord[];
}

export interface DraftListResponse {
  drafts: DraftSolverNetRecord[];
}

export interface CaptureSummary {
  sessionId: string;
  capturedAt: Iso8601;
  originatingTool: { name: string; version?: string };
  capturePath: 'A' | 'B' | 'C' | 'D';
  status: 'pending' | 'approved' | 'skipped';
  spanCount: number;
  durationMs: number;
  redactedSpanCount: number;
  repoRemoteUrl?: string;
  repoCommitHash?: string;
  envelopeCid?: string;
  publishedAt?: Iso8601;
  skippedAt?: Iso8601;
}

export interface CaptureSpan {
  sessionId: string;
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, unknown>;
  redactedKeys: string[];
}

export interface CapturesListResponse {
  captures: CaptureSummary[];
}

export interface CaptureDetailResponse {
  capture: CaptureSummary;
  spans: CaptureSpan[];
}

// ── Discovery types (hfmf) ────────────────────────────────────────────────────

export interface PluginPublicationDto {
  builderAgentId: string;
  cid: string;
  name: string;
  version: string;
  supports: string[];
  publishedAt: number;
  artifactType: 'plugin';
  revoked: boolean;
  revokedReason?: string;
  pluginSha256: string;
}

export interface PublishedArtifactDto {
  builderAgentId: string;
  cid: string;
  name: string;
  version: string;
  supports: string[];
  publishedAt: number;
  artifactType: 'plugin' | 'harness';
  revoked: boolean;
  revokedReason?: string;
}

export interface PluginScoreHistoryRowDto {
  pluginCid: string;
  taskId: string;
  operatorAgentId: string;
  verdict: string;
  score?: number;
  ts: number;
  forkSuspected: boolean;
}

export interface DiscoveryPluginPublicationsResponse {
  publications: PluginPublicationDto[];
}

export interface DiscoveryBuilderArtifactsResponse {
  artifacts: PublishedArtifactDto[];
}

export interface DiscoveryPluginScoresResponse {
  scores: PluginScoreHistoryRowDto[];
}

/**
 * Response from `GET /v1/discovery/solvernet-operator-count?cid=<manifestCid>`.
 * `operatorCount` is the number of distinct operators with on-chain activity
 * (claimed tasks) on the SolverNet — see the daemon's
 * `DiscoveryAPI.getSolverNetOperatorCount` for why this counts participating
 * operators rather than config-level joins. Issue #351.
 */
export interface DiscoverySolverNetOperatorCountResponse {
  manifestCid: string;
  operatorCount: number;
}

/**
 * Windowed on-chain task-post counts (last 1h / 6h / 24h) for one scope. Source
 * is `TaskCreated` events on the active chain's TaskCoordinator / JinnRouter,
 * computed as a block-window approximation backend-side. Issue #918.
 */
export interface TaskPostCountsDto {
  h1: number;
  h6: number;
  h24: number;
  windowEndBlock: number;
  windowEndTs: number;
}

/**
 * Response from `GET /v1/discovery/task-post-counts`. `chain` is always present
 * (chain-wide totals); `byCid` is keyed by manifest CID and only populated when
 * `cid` params were supplied. Issue #918.
 */
export interface DiscoveryTaskPostCountsResponse {
  windowEndBlock: number;
  windowEndTs: number;
  chain: TaskPostCountsDto;
  byCid: Record<string, TaskPostCountsDto>;
}

// ── Per-harness readiness (vh74.2 Stage A — #248 / #332) ─────────────────────
// Mirrors the daemon's `HarnessReadinessSnapshot` entry shape exposed at
// `GET /v1/harnesses/:name/readiness`. The join form consults this to disable
// harness options whose external dependencies (CLI install, provider key)
// are unsatisfied.

export interface HarnessReadinessNextStep {
  description: string;
  cli?: string;
  url?: string;
}

export interface HarnessReadinessEntry {
  harnessName: string;
  manifestCids: string[];
  ready: boolean;
  reason?: string;
  nextStep?: HarnessReadinessNextStep;
}

// ── Harness auth status (`/v1/harnesses/auth-status`) — #564 ─────────────────
export type HarnessAuthSourceKind = 'file' | 'env' | 'session' | 'none';
export type HarnessAuthState = 'loaded' | 'missing' | 'unknown';

export interface HarnessAuthStatusEntry {
  harnessName: string;
  sourceKind: HarnessAuthSourceKind;
  sourcePath?: string;
  envKey?: string;
  keySuffix: string | null;
  lastModified: string | null;
  state: HarnessAuthState;
  docAnchor?: string;
}

export interface HarnessAuthStatusResponse {
  harnesses: HarnessAuthStatusEntry[];
}

// ── Codex CLI doctor (`/api/codex/doctor`) ───────────────────────────────────
// Mirrors the daemon's `CodexDoctorResponse` so the SPA can render a yellow
// untested-version hint without re-running the version comparison client-side
// (#675).

export type CodexAuthStatus = 'ok' | 'expired' | 'not_configured';
export type CodexVersionStatus = 'ok' | 'unknown' | 'untested';

export interface CodexDoctorResponse {
  installed: boolean;
  authenticated: boolean;
  authStatus: CodexAuthStatus;
  cliVersion: string | null;
  versionStatus: CodexVersionStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// ── One-click operator debug report (issue #420) ─────────────────────────────
// Mirrors the daemon's `GET /v1/debug-report/manifest` response — what the
// downloadable support bundle will contain, shown to the operator before they
// download so they can see exactly what is included and what is redacted.

export interface DebugReportRedactionSummary {
  version: string;
  redacted: string[];
  kept: string[];
  /** Items included but NOT redacted (e.g. the screenshot). Optional. */
  notRedacted?: string[];
}

export interface DebugReportManifest {
  files: string[];
  redaction: DebugReportRedactionSummary;
}

// ── Claim policy & wiring (OPERATOR-APP-SPEC §2.15) ──────────────────────────
// Mirrors the daemon's `ClaimPolicyConfig` / `ExecutionWiringConfigEntry`
// (client/src/config/shape-v2.ts) by hand — the dashboard SPA does not import
// daemon-side modules.

export type ClaimPolicyMode = 'claim-nothing' | 'every-runnable' | 'match-legacy-manifest-digest';

export interface ClaimPolicyConfig {
  mode: ClaimPolicyMode;
  /** Decimal wei string. Optional — absent means the host's USD spend gates remain the bound. */
  spendCapWei?: string;
  /** Optional — absent means the host's USD spend gates remain the bound. */
  aiUnitCap?: number;
}

export interface ExecutionWiringConfigEntry {
  workKind: string;
  harness: string;
  model: string;
  plugins: string[];
  credentialRef: string;
  isolationPolicy: string;
  /** Set only for entries the shape-v2 boot migration derived from a legacy SolverNet membership. */
  legacyManifestDigest?: string;
}

export interface ClaimPolicyResponse {
  claimPolicy?: ClaimPolicyConfig;
  executionWiring: ExecutionWiringConfigEntry[];
  restartRequired: boolean;
}
