/**
 * The composition root (cutover stage 1, Task 12): the only place in the repository that
 * assembles `LocalTaskExecutionBackendConfig`, `PipelineConfig`, and `PipelinePorts` from
 * operator config. See
 * `docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md` Task 12.
 *
 * KNOWN GAPS — two subsystems this composition root would need don't exist anywhere in the
 * repository yet. Both were confirmed with the stage-1b coordinator before implementation
 * (rather than fabricated); both are wired as clearly-labeled, safe (empty / fail-closed)
 * placeholders so every OTHER port is real and correctly typed:
 *
 *  1. `BaseVenueConfig.observations` — venue-base's observe port needs "every observation ever
 *     projected" (see `packages/marketplace/venue-base/src/observe/projector-observe.ts`).
 *     Producing that stream requires `ProjectorLoop`'s `enrich` function (resolving each decoded
 *     chain event's Submission identity, task digest, effective deadline, and dispatch context —
 *     see `client/src/daemon/projector-loop.ts`'s `ProjectorLoopConfig.enrich`), which is a
 *     REQUIRED host-injected dependency with no production implementation anywhere in
 *     `client/src` (only the Task 9 unit test's fake). Building a real one needs IPFS-backed
 *     submission/dispatch-context resolution — a genuine subsystem, not composition wiring, and
 *     out of this task's 4-file write scope. Stubbed to `async () => []`: the venue constructs
 *     cleanly and every other port (claim, settlement writer machinery, release, ipfs) is real,
 *     but `venue.observe` / `lifecycle` / `finality` will report "no Attempt" for every ref until
 *     a follow-up task builds the enrich/observation-accumulation subsystem. This composition is
 *     therefore NOT yet safe to run live settlement traffic through.
 *
 *  2. `verifySettlementGrade` — composed from `@jinn-network/trust-resolve`'s
 *     `createBindingResolver` + `createChainFactResolver` exactly as the plan directs, but their
 *     `BindingStore` / `AnchorReadClient` backing stores (the actual binding-registry index and
 *     anchor-observation surface) don't exist anywhere in the repo either. Per CLAUDE.md's phase
 *     rollout, "B.1 verifiability tier activation" is still forward-looking, not shipped. Wired
 *     against empty/fail-closed backing stores, so every check reports `"missing"` — never
 *     silently `"verified"`.
 *
 *  3. (Task 15, coordinator amendment 4 / D3 ratified.) `LocalTaskExecutionBackendConfig`'s
 *     `deliveryExtensions` hook is supplied (not a stub-shaped omission) but always returns `{}`
 *     today, for two independently blocking reasons, neither fabricatable from this task's
 *     4-file write scope: (a) the hook is synchronous (matches the backend's own synchronous
 *     `sealDelivery` call site at completion time), but the only signer `CompositionRootInput`
 *     carries is `input.walletClient`, whose signing methods are all async (remote-signer /
 *     hardware-wallet compatible) — there is no raw private key or synchronous secp256k1 signer
 *     anywhere on this input; (b) there is no reachable mapping from a sealed `TaskSpecification`
 *     back to the `ExecutionWiringEntry`/workKind that produced it — `workKind` is computed once,
 *     at claim time, by `mapAnnouncedSubmissionToFacts` from the announced card, and is not
 *     carried by the Task document itself (`TaskSpecificationSchema` has no such field) nor
 *     threaded through `runPipeline`/`backend.submit`/`completeAttempt`. The read path (mech
 *     adapter's `legacyRestorationResultFromDelivery` preference) and the write seam (this field,
 *     present and correctly spread into `sealDelivery`) are real; only the envelope content is
 *     not yet populated. A follow-up task needs a synchronous signer port plus a workKind-
 *     carrying seam from claim through to delivery to close this.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { Address, PublicClient, WalletClient } from 'viem';
import { createBaseVenue, type BaseVenue } from '@jinn-network/marketplace-venue-base';
import type {
  ClaimPorts,
  MarketplaceChainConfig,
  SettlementPorts,
} from '@jinn-network/marketplace-binding';
import { createRegistryPinPort } from '@jinn-network/marketplace-binding';
import {
  CLAIM_NOTHING,
  matchLegacyManifestDigest,
  takeEveryRunnable,
  type ClaimPredicate,
  type ExecutionWiringEntry,
  type OperatorCaps,
  type PipelineConfig,
  type PipelinePorts,
} from '@jinn-network/marketplace-pipeline';
import {
  createAnchorResolver,
  createBindingResolver,
  createChainFactResolver,
  type BindingStore,
} from '@jinn-network/trust-resolve';
import {
  LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
  type LocalProvisionerInput,
} from '@jinn-network/task-execution-backend-local';
import type { TaskExecutionBackend } from '@jinn-network/task-execution-backend';
import {
  claudeCodeLauncher,
  codexLauncher,
  cursorLauncher,
  hermesLauncher,
  EVALUATION_TASK_PROFILE,
  REPOSITORY_WORK_PROFILE,
  type LauncherContract,
} from '@jinn-network/task-execution-launchers';
import {
  makeDirProvisioner,
  type WorkspaceRuntimePorts,
} from '@jinn-network/task-execution-workspace';
// `ProfileStore` is defined by `@jinn-network/task-execution-profiles` (not, as the plan's
// Consumes block implies, by `@jinn-network/task-execution-workspace`, which does not export
// it at all).
import type { ProfileStore } from '@jinn-network/task-execution-profiles';
import type { ProtocolObservation } from '@jinn-network/task-execution-protocol';
import { buildInfo } from '../build-info.js';
import type { JinnConfig } from '../config.js';
import type { ClaimPolicyConfig } from '../config/shape-v2.js';
import { toPipelineWiring } from '../config/shape-v2.js';
import { setVenueBroadcaster, clearVenueBroadcaster } from '../adapters/mech/safe.js';
import { openOperatorEvidence, type OperatorEvidence } from './evidence-join.js';

export interface OperatorComposition {
  readonly backend: TaskExecutionBackend;
  readonly pipelineConfig: PipelineConfig;
  readonly pipelinePorts: PipelinePorts;
  readonly venue: BaseVenue;
  readonly evidence: OperatorEvidence;
  readonly chain: MarketplaceChainConfig;
  readonly safeAddress: `0x${string}`;
  readonly mechAddress: `0x${string}`;
  close(): Promise<void>;
}

export interface CompositionRootInput {
  readonly config: JinnConfig;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly safeAddress: `0x${string}`;
  readonly mechAddress: `0x${string}`;
  readonly chain: MarketplaceChainConfig;
  readonly stateRoot: string;
  readonly evidenceRoot: string;
  readonly venueStateDbPath: string;
  readonly profileStore: ProfileStore;
  readonly identityRegistryAddress?: string;
  readonly secretForwardResolver?: LocalTaskExecutionBackendConfig['secretForwardResolver'];
  readonly logger?: { info(m: string): void; warn(m: string): void };
}

/** Pure: operator claim policy config -> the pipeline's ClaimPredicate. */
export function buildClaimPredicate(
  policy: ClaimPolicyConfig | undefined,
  wiring: readonly ExecutionWiringEntry[],
): ClaimPredicate {
  if (policy === undefined || policy.mode === 'claim-nothing') return CLAIM_NOTHING;
  if (policy.mode === 'every-runnable') return takeEveryRunnable();
  const byWorkKind = new Map(wiring.map((entry) => [entry.workKind, entry]));
  const bridge = matchLegacyManifestDigest(byWorkKind);
  return (facts, capabilities, caps) => {
    if (!byWorkKind.has(facts.workKind)) return false;
    return facts.runnable && bridge!(facts, capabilities, caps);
  };
}

/**
 * Pure: operator claim policy config -> the pipeline's `OperatorCaps` (coordinator amendment 1
 * / binding override — no-claim-nothing migration: an unconfigured cap is permissive, not zero,
 * because the host's USD rolling-window gates remain the operative spend bound).
 */
export function buildOperatorCaps(policy: ClaimPolicyConfig | undefined): OperatorCaps {
  return {
    spendCapWei: policy?.spendCapWei === undefined ? 2n ** 256n - 1n : BigInt(policy.spendCapWei),
    aiUnitCap: policy?.aiUnitCap ?? Number.MAX_SAFE_INTEGER,
  };
}

// ── Launcher executables ─────────────────────────────────────────────────────

const ALL_LAUNCHERS: readonly LauncherContract[] = [
  claudeCodeLauncher,
  codexLauncher,
  hermesLauncher,
  cursorLauncher,
];

/**
 * Executable path sources per launcher id. `cursor` has no dedicated `JinnConfig` field or
 * documented env var anywhere in the codebase (the plan's field-map table names only
 * `config.claudePath` / `JINN_CODEX_PATH` / `JINN_HERMES_PATH`) — `JINN_CURSOR_PATH` is this
 * composition root's own reasonable inference, following the same naming convention.
 */
function resolveLauncherCommand(id: string, config: JinnConfig): string | undefined {
  switch (id) {
    case 'claude-code':
      return config.claudePath;
    case 'codex':
      return config.codexPath;
    case 'hermes':
      return config.hermesPath;
    case 'cursor':
      return process.env['JINN_CURSOR_PATH'];
    default:
      return undefined;
  }
}

function resolveExecutablePath(command: string): string {
  if (command.includes('/')) return command;
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return command;
}

interface VerifiedExecutable {
  readonly path: string;
  readonly digest: string;
}

/**
 * Structural stand-in for the assembly package's own `LocalLauncherDeployment` (defined in
 * `pinning.ts` but, unlike the plan's Consumes block implies, NOT re-exported from
 * `@jinn-network/task-execution-backend-local`'s public `index.ts`). Kept structurally
 * identical so `LocalTaskExecutionBackendConfig.launcherDeployments` type-checks by shape.
 */
interface LauncherDeployment {
  readonly executable: VerifiedExecutable;
  probe(): Promise<{ readonly ready: boolean; readonly executable: VerifiedExecutable }>;
}

function buildVerifiedExecutable(command: string): VerifiedExecutable {
  const path = resolveExecutablePath(command);
  let digest = 'unresolved';
  try {
    digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    // The executable isn't on disk at boot (not installed / not on PATH yet). Leave the
    // sentinel digest — the launcher's own `probe()`, not this deployment record, is what
    // actually gates preflight readiness (see backend.ts `preflightLaunchers`).
  }
  return { path, digest };
}

function buildLaunchers(wiring: readonly ExecutionWiringEntry[]): readonly LauncherContract[] {
  const wanted = new Set(wiring.map((entry) => entry.harness));
  return ALL_LAUNCHERS.filter((launcher) => wanted.has(launcher.id));
}

function buildLauncherDeployments(
  launchers: readonly LauncherContract[],
  config: JinnConfig,
): Readonly<Record<string, LauncherDeployment>> {
  const deployments: Record<string, LauncherDeployment> = {};
  for (const launcher of launchers) {
    const command = resolveLauncherCommand(launcher.id, config);
    if (command === undefined) continue;
    const executable = buildVerifiedExecutable(command);
    deployments[launcher.id] = {
      executable,
      probe: async () => ({ ready: true, executable }),
    };
  }
  return deployments;
}

// ── Workspace provisioner ────────────────────────────────────────────────────
//
// Always a plain-directory provisioner. `selectProvisioner`'s git-worktree branch
// (`@jinn-network/task-execution-workspace`) needs a per-attempt `referenceRepository`/`oid`
// that no `JinnConfig` field carries anywhere in the codebase — genuinely out of scope for this
// composition root to invent. `provisionerCapabilities.workspaceKinds` is set to `['dir']`
// (the real `WorkspaceKind` union is `'dir' | 'worktree'`, not the plan's `'plain-dir'` /
// `'git-worktree'` strings) to match what is actually wired, not what is aspirationally declared.

const META_RESERVE_BYTES = 65_536;

function buildWorkspaceRuntimePorts(): WorkspaceRuntimePorts {
  return {
    async assertHarnessGroupEmpty(paths) {
      const entries = await readdir(paths.harnessState).catch(() => [] as string[]);
      if (entries.length > 0) {
        throw new Error(`harness-state directory ${paths.harnessState} is not empty`);
      }
    },
    async ensureMetaReserve(paths) {
      await mkdir(paths.meta, { recursive: true });
      await writeFile(join(paths.meta, '.reserve'), Buffer.alloc(META_RESERVE_BYTES)).catch(
        () => undefined,
      );
    },
  };
}

// `SelectedProvisioner` (`{id, contract}`), like `LocalLauncherDeployment`, is not re-exported
// from `@jinn-network/task-execution-backend-local`'s public `index.ts` despite the plan's
// Consumes block naming it — the object literal below type-checks structurally against
// `LocalTaskExecutionBackendConfig['provisioner']`'s return type without importing the name.
function buildProvisioner(runtime: WorkspaceRuntimePorts) {
  return (input: LocalProvisionerInput) => ({
    id: 'dir',
    contract: makeDirProvisioner({
      sealedTaskBytes: input.sealedTaskBytes,
      dispatchContextBytes: input.dispatchContextBytes,
      runtime,
    }),
  });
}

// ── Settlement-grade verification (gap 2 — see file header) ─────────────────

function buildVerifySettlementGrade(input: {
  readonly rpcUrl: string;
  readonly identityRegistryAddress: string | undefined;
}): SettlementPorts['verifySettlementGrade'] {
  const emptyBindingStore: BindingStore = {
    listBindingsForAgent: async () => [],
    listRevocationsForTargets: async () => [],
  };
  const emptyAnchorResolver = createAnchorResolver({ client: { lookupAnchor: async () => null } });
  const chainFacts =
    input.identityRegistryAddress === undefined
      ? undefined
      : createChainFactResolver({
          rpcUrl: input.rpcUrl,
          identityRegistry: input.identityRegistryAddress,
        });
  // Composed per the plan's instruction so the wiring is real, not just typed — not yet
  // load-bearing until a real BindingStore/AnchorReadClient exists (gap 2, file header).
  const bindingResolver = createBindingResolver({
    bindings: emptyBindingStore,
    anchors: emptyAnchorResolver,
    ...(chainFacts === undefined ? {} : { chainFacts }),
  });
  void bindingResolver;

  const GAP_DETAIL = 'binding-registry infra not yet wired (composition-root gap 2)';
  return async (verificationInput) => ({
    executorBinding: { status: 'missing', detail: GAP_DETAIL },
    dispatchBinding: { status: 'missing', detail: GAP_DETAIL },
    evaluationSpecification:
      verificationInput.attempt.taskEvaluationDigest === undefined
        ? { status: 'not-applicable' }
        : { status: 'missing', detail: GAP_DETAIL },
  });
}

// ── Observation feed (gap 1 — see file header) ───────────────────────────────

function buildObservations(): () => Promise<readonly ProtocolObservation[]> {
  return async () => [];
}

// ── Capability grants ────────────────────────────────────────────────────────
//
// The plan names a `resolveCapabilityGrants(grants, config)` helper that does not exist
// anywhere in the codebase. Stage 1 config carries no capability-grant policy of its own, so
// this is the minimal, generic mapping from the raw declared-grant record to the backend's
// `CapabilityGrant[]` shape (`{key, descriptor}` — see
// `packages/task-execution/backend-local/workspace/src/contract.ts`).
function buildCapabilityGrants(
  grants: Readonly<Record<string, unknown>>,
): readonly { readonly key: string; readonly descriptor: unknown }[] {
  return Object.entries(grants).map(([key, descriptor]) => ({ key, descriptor }));
}

/** Installs the single broadcaster as its first observable side effect. */
export async function buildOperatorComposition(
  input: CompositionRootInput,
): Promise<OperatorComposition> {
  const { config } = input;

  const observations = buildObservations();
  const fetchImpl = globalThis.fetch;
  const ipfsPin = createRegistryPinPort({ registryUrl: config.ipfsRegistryUrl, fetchImpl });
  const verifySettlementGrade = buildVerifySettlementGrade({
    rpcUrl: config.rpcUrl,
    identityRegistryAddress: input.identityRegistryAddress,
  });

  // `viem` is a direct `dependencies` entry of venue-base / binding / projector, and each
  // `packages/` tree is its own yarn project, so every one installs a physically separate copy.
  // TypeScript compares those declarations by identity, not shape, for viem's deeply recursive
  // generic types (`Client`, `Account`, `NonceManager.consume`), and reports "two different types
  // with this name exist, but they are unrelated" for byte-identical shapes. Pinning both sides to
  // the same version (done) does not help, and a `paths` redirect does not reach the portal
  // packages' own `.d.ts` resolution (tested). The real fix is making viem a required peer of
  // those packages so the consumer's copy is used — a dependency-topology change outside this
  // leg's scope. Recorded as finding E26. The cast names the exact expected type rather than
  // `as never`, so it documents what is being asserted instead of erasing it.
  type VenueClients = Parameters<typeof createBaseVenue>[0];
  const venue = createBaseVenue({
    chain: input.chain,
    publicClient: input.publicClient as unknown as VenueClients['publicClient'],
    walletClient: input.walletClient as unknown as VenueClients['walletClient'],
    safeAddress: input.safeAddress,
    stateDbPath: input.venueStateDbPath,
    priorityMech: input.mechAddress,
    pin: ipfsPin.pin,
    verifySettlementGrade,
    isAuthorizedMechOrigin: (address: Address) =>
      address.toLowerCase() === input.mechAddress.toLowerCase(),
    observations,
  });

  // Contract 1: install before any loop can send a transaction through executeSafeTransaction.
  setVenueBroadcaster({
    safeAddress: input.safeAddress,
    execute: (request) => venue.safe.execute(request),
  });

  const evidence = await openOperatorEvidence({ rootDir: input.evidenceRoot });

  const wiring = toPipelineWiring(config.executionWiring ?? []);
  const launchers = buildLaunchers(wiring);
  const launcherDeployments = buildLauncherDeployments(launchers, config);
  const workspaceRuntime = buildWorkspaceRuntimePorts();

  const backendConfig: LocalTaskExecutionBackendConfig = {
    stateRoot: input.stateRoot,
    source: `urn:jinn:operator:${input.safeAddress.toLowerCase()}`,
    executor: `urn:jinn:operator-runtime:${buildInfo.implVersion}`,
    profileStore: input.profileStore,
    launchers,
    launcherDeployments,
    provisioner: buildProvisioner(workspaceRuntime),
    provisionerCapabilities: {
      taskProfiles: [REPOSITORY_WORK_PROFILE, EVALUATION_TASK_PROFILE],
      workspaceKinds: ['dir'],
      inputMediaTypes: ['application/json'],
      outputMediaTypes: ['application/json', 'application/octet-stream'],
      isolation: ['process'],
    },
    // `config.maxConcurrentAttempts` does not exist anywhere on `JinnConfig` (the plan assumes
    // a field that was never added) — always the backend's own default.
    maxConcurrentAttempts: 4,
    recorderAvailability: 'always',
    trustKeys: { observationSigningKeyConfigured: true, deliverySigningKeyConfigured: true },
    evidence: evidence.ports,
    capabilityGrants: buildCapabilityGrants,
    ...(input.secretForwardResolver === undefined
      ? {}
      : { secretForwardResolver: input.secretForwardResolver }),
    cancellationGraceMs: 30_000,
    heartbeatIntervalMs: 10_000,
    // Bridge era only (Task 15, coordinator amendment 4 / D3 ratified; gap 3, file header): the
    // hook is genuinely wired, but always returns no extension until a synchronous signer port
    // and a claim-to-delivery workKind seam exist — see gap 3 above for why neither is
    // fabricatable from this composition root today.
    deliveryExtensions: () => ({}),
  };
  const backend = new LocalTaskExecutionBackend(backendConfig);

  const pipelineConfig: PipelineConfig = {
    chain: input.chain,
    predicate: buildClaimPredicate(config.claimPolicy, wiring),
    caps: buildOperatorCaps(config.claimPolicy),
    wiring,
    priorityMech: input.mechAddress as ClaimPorts['priorityMech'],
  };

  const pipelinePorts: PipelinePorts = {
    claim: venue.claim,
    finality: venue.finality,
    deliveryWait: venue.deliveryWait,
    settlement: { ...venue.settlement, pin: ipfsPin.pin, verifySettlementGrade },
    ipfs: ipfsPin,
    release: venue.release,
  };

  return {
    backend,
    pipelineConfig,
    pipelinePorts,
    venue,
    evidence,
    chain: input.chain,
    safeAddress: input.safeAddress,
    mechAddress: input.mechAddress,
    async close(): Promise<void> {
      await evidence.close();
      venue.close();
      clearVenueBroadcaster();
    },
  };
}
