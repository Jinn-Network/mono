/**
 * The composition root (cutover stage 1, Task 12; loop startup + real ports at close-out C8):
 * the only place in the repository that assembles `LocalTaskExecutionBackendConfig`,
 * `PipelineConfig`, `PipelinePorts`, and (C8) the projector loop + claim gate + engagement
 * ledger from operator config. See
 * `docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md` Task 12 and the close-out
 * addendum's C8.
 *
 * CLOSED AT C8 (previously KNOWN GAPS 1 and 2 below):
 *
 *  1. `BaseVenueConfig.observations` is backed by a real `ProjectorLoop` (C3 log source, C4
 *     enrich, C5 durable observations), rather than `async () => []`. The sole `BaseVenue`
 *     owns the venue state path and supplies its log source to the projector; components never
 *     open that state path independently.
 *
 *  2. `verifySettlementGrade` is now C6's real implementation (`./settlement-grade.js`), wired
 *     against this composition's own `EngagementLedger` and `ProfileStore`. The local fail-closed
 *     stub that always reported `"missing"` is deleted.
 *
 * NEW GAPS surfaced while closing 1 and 2 above — every one is REPORTED (loud-fail or documented
 * `undefined`), never silently fabricated:
 *
 *  a. `resolveSubmissionBytes` / `resolveDispatchContext` (the enrich ports `createProjectorEnrich`
 *     needs, `./projector-enrich.js`): for `BASE_SEPOLIA_TODAY` (today generation, the only real
 *     `MarketplaceChainConfig` per finding E22), there is no on-chain Submission anchor at all,
 *     and NO production path anywhere in `client/src` produces a TEP `SubmissionRecordSchema`
 *     document for a today-generation task (the legacy `CreatorLoop` posts the older
 *     `SignedTaskV1` shape, which fails TEP schema validation).
 *
 *     `resolveSubmissionBytes` half CLOSED (last-mile follow-up to commit 051bc63c6): the fix is
 *     not a new Submission format, it is fetching the legacy document at all -- the on-chain
 *     `TaskCoordinator.getTask(taskId).taskCidDigest` fact (read here via the SAME
 *     `getTaskCidDigest` helper `adapter.ts`'s `restorationAnnouncementForTaskId`/
 *     `recoverTaskPost` already use to read back the legacy creator's own posted tasks) names the
 *     IPFS content; `buildResolveSubmissionBytes` below fetches it through this composition's own
 *     `fetchIpfsBytes` port and hands the raw bytes to `createProjectorEnrich`, whose bridge-
 *     synthesis path (finding E32, `parseLegacySignedTaskV1` -> `synthesizeLegacyTaskProjection`)
 *     was already wired and waiting -- it simply never received real bytes to try. Fails closed on
 *     any on-chain read failure, missing/zero digest, or IPFS miss; the caller's own digest join
 *     against the on-chain anchor is an independent second check regardless of what this port
 *     returns.
 *
 *     `resolveDispatchContext` CLOSED (finding E35, ruled -- "seal at claim time; the engagement
 *     ledger is the home"): `pipeline.ts`'s `claim.dispatchContext` is still built entirely
 *     in-memory inside a single `runPipeline` call and never pinned/anchored anywhere by that
 *     package, and venue-base's own `submission_scopes` table is still keyed by revised-generation
 *     requester/idempotencyKey only -- but this composition's own `engagement_ledger` (the one
 *     durable per-claim store it owns) is the ruled home for it: `work-loop.ts`'s wrapped
 *     `claimTask` is the AUTHOR of that in-memory document (same taskDigest/submission/nonce, same
 *     deterministic attemptUri derivation), so it reconstructs it byte-identically and seals it
 *     exactly once, at claim time, into this same row (`dispatch_context_digest`/
 *     `dispatch_context_bytes`, `engagement-ledger.ts`'s schema). `buildEngagementLedgerDispatch
 *     ContextPort` below reads that sealed digest back rather than fabricating a
 *     `ResourceDescriptor` for a document nobody sealed -- still `undefined` (fail-closed,
 *     `createProjectorEnrich`'s documented "drop this event, retry next tick") for a task this
 *     operator never claimed, or a row claimed before this seal existed.
 *  b. `verifyVerdictObservation` and `resolveRecord` for the `"delivery"` / `"evaluation-delivery"`
 *     roles (the announcement ports `projectAnnouncements` needs, `./projector-ports.js`):
 *     `verifyVerdictObservation`'s real form needs the SAME Phase-B binding-resolver backing
 *     stores (`BindingStore`/`AnchorReadClient`/policy) already named absent by the old gap 2 --
 *     confirmed again independently via `VerdictObservationGatePorts`
 *     (`packages/marketplace/binding/src/named-checks.ts`). `resolveRecord` for delivery roles has
 *     no lookup mechanism anywhere (no local cache of this operator's own delivered bytes keyed
 *     by the claiming event). Both loudly throw a named error rather than returning empty/fake
 *     material; `projectAnnouncements` treats a `verifyVerdictObservation` throw as a refusal
 *     (fail-closed) and a `resolveRecord` throw as a failed (non-fatal, logged, retried) tick.
 *     Because of (a), `transition.events` is always empty in this composition today, so neither
 *     of these is actually reachable yet -- they exist so a FUTURE fix to (a) fails loud instead
 *     of silently fabricating discovery entries.
 *  c. Native role identities: the caller supplies the persistent, effective-time-trusted
 *     `RoleIdentitySet`. Its solver-delivery and solver-discovery identities are the only keys
 *     this native composition exposes to delivery verification and discovery signing. Omission
 *     fails native boot closed; no EOA-derived or boot-generated signing key is available here.
 *
 * CLOSED (cutover stage 1 close-out C7, finding E24). `LocalTaskExecutionBackendConfig`'s
 * `deliveryExtensions` hook now attaches the bridge-era legacy execution envelope for real,
 * given two things this composition root did not have before: (a) a synchronous signer --
 * `CompositionRootInput.legacyBridgeSigner`, a new OPTIONAL field, because the only signer
 * this input carried before (`input.walletClient`) is async-only (remote-signer / hardware-
 * wallet compatible) and there is still no raw private key anywhere on this input; (b) a
 * workKind-carrying seam -- `work-loop.ts` now calls the concrete
 * `LocalTaskExecutionBackend.noteAttemptWorkKind(attemptUri, workKind, requestId)` (exposed
 * here as `OperatorComposition.noteAttemptWorkKind`) at the SAME point it derives `attemptUri`
 * for the engagement ledger, strictly before `backend.submit()` -- `attemptUri` is
 * deterministic (`deriveMarketplaceAttemptUri`) so it is known ahead of submit and matches
 * exactly what `backend.ts`'s `completeAttempt` later keys its own note lookup by.
 * `legacyBridgeSigner` is consumed only by the explicit `mode: "legacy"` bridge path. Native
 * delivery and discovery signing are supplied by the persistent role set; native mode never
 * receives or derives an EOA-based Ed25519 key.
 */
import { createHash, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import {
  createBaseVenue,
  type BaseVenue,
  type BaseVenueSafeBroadcaster,
  type ChainLogSource,
} from '@jinn-network/marketplace-venue-base';
import type {
  ClaimPorts,
  MarketplaceChainConfig,
} from '@jinn-network/marketplace-binding';
import { createRegistryPinPort } from '@jinn-network/marketplace-binding';
import {
  CLAIM_NOTHING,
  matchLegacyManifestDigest,
  resolveWiringEntry,
  takeEveryRunnable,
  type ClaimPredicate,
  type ExecutionWiringEntry,
  type OperatorCaps,
  type PipelineConfig,
  type PipelinePorts,
} from '@jinn-network/marketplace-pipeline';
import {
  LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
  type LocalProvisionerInput,
} from '@jinn-network/task-execution-backend-local';
import type { AttemptUri, TaskExecutionBackend } from '@jinn-network/task-execution-backend';
import {
  claudeCodeLauncher,
  codexLauncher,
  cursorLauncher,
  hermesLauncher,
  predictionV1BaselineLauncher,
  EVALUATION_TASK_PROFILE,
  PREDICTION_FORECAST_PROFILE,
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
import {
  buildRepositoryWorkProfile,
  REPOSITORY_WORK_PROFILE_URI,
  sealTaskProfile,
} from '@jinn-network/task-execution-profiles';
import type { JsonValue, ProtocolObservation } from '@jinn-network/task-execution-protocol';
import { DISCOVERY_SIGNING_SCOPE, RECORD_KINDS } from '@jinn-network/record-discovery-protocol';
import type {
  AnnouncementRecordMaterial,
  AnnouncementRecordRole,
  ObservationMarketplaceEvent,
  ScopedDiscoverySigner,
} from '@jinn-network/marketplace-projector';
import { buildInfo } from '../build-info.js';
import type { JinnConfig } from '../config.js';
import type { ClaimPolicyConfig } from '../config/shape-v2.js';
import { toPipelineWiring } from '../config/shape-v2.js';
import type { VenueBroadcaster } from '../adapters/mech/safe.js';
import type { Store } from '../store/store.js';
import { fetchRawBytesFromIpfs } from '../adapters/mech/ipfs.js';
import { getTaskCidDigest } from '../adapters/mech/contracts.js';
import { openOperatorEvidence, type OperatorEvidence } from './evidence-join.js';
import { buildLegacyExecutionEnvelope, LEGACY_ENVELOPE_EXTENSION_KEY, synthesizeLegacyExecutionDocuments } from './bridge-legacy-delivery.js';
import { EngagementLedger } from './engagement-ledger.js';
import { buildVerifySettlementGrade as buildRealVerifySettlementGrade } from './settlement-grade.js';
import { createProjectorCatchUpGate, type ClaimGate } from './claim-gate.js';
import { createCanonicalBlockHashReader, createFinalizedHeadReader } from './projector-log-source.js';
import { createProjectorEnrich, type ProjectorEnrichPorts } from './projector-enrich.js';
import { ProjectorCursorStore } from './projector-cursor.js';
import { ProjectorLoop } from './projector-loop.js';
import type { ProjectorPortsInput } from './projector-ports.js';
import type { AnnouncedSubmissionCard, ArchiveSubscription, SealedDocuments } from './work-loop.js';
import { buildArchiveSubscription } from './archive-subscription.js';
import { parseSignedTaskV1 } from '../types/task-document.js';
import type { RoleIdentitySet } from './role-identities.js';
import {
  createNativeRequesterSubmissionResolver,
  type NativeRequesterSubmissionLookup,
  type NativeRequesterSubmissionVerifier,
} from '../native-requester/requester.js';

export interface OperatorComposition {
  /** Explicit composition path: legacy bridge or native effective-time-trusted operator. */
  readonly mode: 'legacy' | 'native';
  readonly backend: TaskExecutionBackend;
  readonly pipelineConfig: PipelineConfig;
  readonly pipelinePorts: PipelinePorts;
  readonly venue: BaseVenue;
  /** Narrow Safe port for the work loop's deliver leg; it never receives the full venue. */
  readonly deliveryBroadcaster: BaseVenueSafeBroadcaster;
  /** Complete persistent role set, present only in native mode after effective-time validation. */
  readonly identities?: RoleIdentitySet;
  readonly evidence: OperatorEvidence;
  readonly chain: MarketplaceChainConfig;
  readonly safeAddress: `0x${string}`;
  readonly mechAddress: `0x${string}`;
  /**
   * This composition's single Safe broadcaster (finding E16 / the C2 ruling: per-daemon state,
   * not a process-global). Every legacy `executeSafeTransaction` call site the host wants routed
   * through this Safe (`MechAdapter`, `DeliveryDeps`, `ReputationRegistryClient`, ...) must be
   * threaded this SAME instance — two broadcasters against one Safe reopens the #525/#562/#897
   * nonce-race class the single-broadcaster rule exists to close.
   */
  readonly broadcaster: VenueBroadcaster;
  /**
   * The C7 workKind seam (finding E24): notes the workKind (and, for today-generation claims, the
   * requestId) that will produce an attempt, so the legacy-bridge `deliveryExtensions` hook can
   * read it back when it seals that attempt's Delivery. A no-op when `legacyBridgeSigner` was
   * never supplied to this composition -- still safe to call unconditionally.
   */
  readonly noteAttemptWorkKind: (attempt: AttemptUri, workKind: string, requestId?: `0x${string}`) => void;
  /**
   * C8: the projector loop, fully constructed against real ports (C3 log source, C4 enrich, C5
   * durable observations). The host (`daemon.ts`) owns starting/stopping it and registering it
   * with the watchdog. `hasCaughtUp()` is contract 3's claim-gate signal — see `claimGate` below,
   * which already wraps it.
   */
  readonly projector: ProjectorLoop;
  /** Contract 3: opens once the projector's durable cursor reaches the finalized chain head. */
  readonly claimGate: ClaimGate;
  /** The engagement ledger this composition's `verifySettlementGrade` (C6) reads from — the same
   * instance the work loop's `WorkLoopConfig.ledger` must be threaded, per contract 2. */
  readonly engagementLedger: EngagementLedger;
  /**
   * Fetches the sealed Task/Submission document bytes for a discovered card
   * (`WorkLoopConfig.readSealedDocuments`), via the same IPFS ports this composition already
   * holds for the projector's enrich step.
   */
  readonly readSealedDocuments: (card: AnnouncedSubmissionCard) => Promise<SealedDocuments>;
  /**
   * Finding E36 (ruled "build it"): `WorkLoopConfig.archive` — turns this composition's own
   * durable observation stream (C5's `ProjectorCursorStore.readObservations()`, the same store
   * `venue`'s `observations` port above already reads) into `AnnouncedSubmissionCard`s. See
   * `./archive-subscription.js` for the mapping (today-generation observations are, per the file
   * header's gap (a), always legacy-derived — reuses `bridge-legacy-delivery.ts`'s
   * `synthesizeLegacyFactsCard` rather than re-deriving that shape).
   */
  readonly archive: ArchiveSubscription;
  close(): Promise<void>;
}

/**
 * Compatibility-only executor signer for the explicit legacy composition. Native composition
 * instead takes its delivery identity exclusively from `RoleIdentitySet`.
 */
export interface LegacyDeliverySigningKey {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  sign(payload: Uint8Array): Uint8Array;
}

export interface CompositionRootInput {
  /**
   * Explicitly selects the bridge-compatible legacy path or the native role-identity path.
   * There is intentionally no default: callers cannot silently downgrade native boot.
   */
  readonly mode: 'legacy' | 'native';
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
  /**
   * Synchronous secp256k1 signer for the bridge-era legacy execution envelope (C7 / finding E24).
   * No raw private key or synchronous signer exists anywhere else on this input (the only signer
   * is the async viem `WalletClient`, incompatible with `deliveryExtensions`'s synchronous call
   * site) -- a host that wants the legacy bridge active supplies this separately. Absent (the
   * default; `main.ts` does not supply one today): `deliveryExtensions` stays the safe no-op it
   * always was.
   */
  readonly legacyBridgeSigner?: (hash: `0x${string}`) => `0x${string}`;
  /**
   * Compatibility-only Ed25519 delivery signer for `mode: 'legacy'`. Production startup does not
   * supply it; hermetic legacy loop tests use it to retain their historical settlement coverage.
   */
  readonly legacyDeliverySigningKey?: LegacyDeliverySigningKey;
  /**
   * Persistent identities created by `RoleIdentitySet.open`, which requires a real
   * effective-time BindingResolver. Omission remains structurally possible only so legacy
   * callers get a deliberate native boot refusal rather than an accidental fallback.
   */
  readonly nativeRoleIdentities?: RoleIdentitySet;
  /**
   * Durable requester association directory for native projection. Omitted uses the operator
   * state root's `native-requester` child; it is read-only from projector composition.
   */
  readonly nativeRequesterStateDir?: string;
  /**
   * C8: the daemon's shared SQLite `Store` — backs the projector's durable cursor/observations
   * (C5, `ProjectorCursorStore`) and the engagement ledger (C6). Required so this composition can
   * assemble a real `ProjectorLoop`/`ClaimGate`/`EngagementLedger` rather than stubs.
   */
  readonly store: Store;
  /** Projector poll interval (ms). Defaults to 5000, matching `LOOP_REGISTRY`'s entry. */
  readonly projectorPollIntervalMs?: number;
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
  predictionV1BaselineLauncher,
];

/**
 * Wiring `harness` values that are legacy HarnessImpl names (or aliases) mapped onto the
 * LauncherContract `id` they correspond to. `hermes-agent` is the registered harness name in
 * `client/src/harnesses/names.ts`; the launcher package id is simply `hermes`.
 */
const HARNESS_TO_LAUNCHER_ID: Readonly<Record<string, string>> = {
  'hermes-agent': 'hermes',
};

/**
 * Executable path sources per launcher id. `cursor` has no dedicated `JinnConfig` field or
 * documented env var anywhere in the codebase (the plan's field-map table names only
 * `config.claudePath` / `JINN_CODEX_PATH` / `JINN_HERMES_PATH`) — `JINN_CURSOR_PATH` is this
 * composition root's own reasonable inference, following the same naming convention.
 * `prediction-v1-baseline` is in-process Node (no separate binary); `process.execPath` is the
 * deployment executable the supervisor will spawn via the launcher's `plan().argv`.
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
    case 'prediction-v1-baseline':
      return process.execPath;
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
  const wanted = new Set(
    wiring.map((entry) => HARNESS_TO_LAUNCHER_ID[entry.harness] ?? entry.harness),
  );
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

// ── Settlement-grade verification (CLOSED at C8 — see file header items 2, c) ───────────────
//
// `createBindingResolver`/`createChainFactResolver` (Phase-B binding-registry machinery) are
// deliberately NOT composed here: their `BindingStore`/`AnchorReadClient` backing stores don't
// exist anywhere in the repo (file header, new gap b), and C6's real `verifySettlementGrade`
// (`./settlement-grade.js`) does not consume them either — its `executorBinding` check is a
// genuine DSSE/Ed25519 verification that needs only a keyid + public key, not a binding resolver.

// ── Legacy bridge delivery extension (gap 3, closed — see file header) ──────

/**
 * Builds the `deliveryExtensions` hook that attaches the bridge-era legacy execution envelope
 * (C7 / finding E24), given a synchronous signer. The attempt's workKind (and, for today-
 * generation claims, requestId) must have been noted ahead of time via the `noteAttemptWorkKind`
 * seam -- when it wasn't (no wiring entry resolves for the noted workKind, or nothing was ever
 * noted for this attempt), the hook returns no extension rather than guessing.
 *
 * Exported so `client/test/bridge/*` can drive the exact hook production wires against a REAL
 * `LocalTaskExecutionBackend`, proving the bridge fixtures against a delivery this backend
 * actually produced rather than a hand-built one.
 */
export function buildLegacyDeliveryExtensions(input: {
  readonly stateRoot: string;
  readonly participant: `0x${string}`;
  readonly wiring: readonly ExecutionWiringEntry[];
  readonly sign: (hash: `0x${string}`) => `0x${string}`;
}): NonNullable<LocalTaskExecutionBackendConfig['deliveryExtensions']> {
  return ({ attempt, harvest, workKind, requestId }): Readonly<Record<string, JsonValue>> => {
    if (workKind === undefined) return {};
    const entry = resolveWiringEntry(workKind, input.wiring);
    if (entry === undefined) return {};
    // Matches `LocalTaskExecutionBackend`'s own `attemptRoot`/`paths.out` derivation exactly
    // (`<stateRoot>/attempts/<attemptUuid>/out`) -- the backend does not expose `paths` to this
    // hook, but the derivation is a pure function of `stateRoot` + `attempt`, both already held
    // here.
    const outputsRoot = join(input.stateRoot, 'attempts', attempt.slice('urn:uuid:'.length), 'out');
    // Bridge-era stand-in: neither `deliveryExtensions` nor this composition root's claim-time
    // state carries the harness's real start/end timestamps (see bridge-legacy-delivery.ts's
    // function doc for the fields that remain placeholders and why).
    const now = new Date().toISOString();
    const { json } = buildLegacyExecutionEnvelope({
      solverType: workKind,
      participant: input.participant,
      harness: entry.harness,
      harvest,
      outputsRoot,
      startedAt: now,
      endedAt: now,
      sign: input.sign,
      requestId,
    });
    return { [LEGACY_ENVELOPE_EXTENSION_KEY]: json };
  };
}

// ── Projector wiring (CLOSED at C8 — see file header items 1, a, b, c, d) ────────────────────
//
// `TaskCoordinator.getRequestRef` / `getAttempt` — mirrors
// `packages/marketplace/venue-base/src/writers/settlement.ts`'s (non-exported)
// `readRouterDeliveryFacts` today-generation read exactly, per that module's own doc comment
// directing a host-injected port to do this read rather than duplicate it inside the enrich
// module itself.
const REQUEST_REF_VIEW_ABI = [{
  name: 'getRequestRef', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'requestId', type: 'bytes32' }],
  outputs: [
    { name: 'taskId', type: 'uint256' },
    { name: 'attemptIndex', type: 'uint32' },
    { name: 'exists', type: 'bool' },
  ],
}] as const;

const GET_ATTEMPT_VIEW_ABI = [{
  name: 'getAttempt', type: 'function', stateMutability: 'view',
  inputs: [
    { name: 'taskId', type: 'uint256' },
    { name: 'attemptIndex', type: 'uint32' },
  ],
  outputs: [{
    name: 'attempt', type: 'tuple',
    components: [
      { name: 'taskId', type: 'uint256' },
      { name: 'attemptIndex', type: 'uint32' },
      { name: 'operator', type: 'address' },
      { name: 'requestId', type: 'bytes32' },
      { name: 'solutionCidDigest', type: 'bytes32' },
      { name: 'solutionWeight', type: 'uint256' },
      { name: 'verdictCount', type: 'uint32' },
      { name: 'status', type: 'uint8' },
    ],
  }],
}] as const;

/** Real (gap 1 CLOSED): a raw sha256-digest IPFS fetch, reusing the existing gateway machinery
 * (`client/src/adapters/mech/ipfs.ts`) already proven for the rest of the daemon. */
function buildFetchIpfsBytes(gatewayUrl: string): (digest: `sha256:${string}`) => Promise<Uint8Array | undefined> {
  return async (digest) => {
    const hex = digest.slice('sha256:'.length);
    try {
      return await fetchRawBytesFromIpfs(gatewayUrl, `f01551220${hex}`);
    } catch {
      return undefined;
    }
  };
}

/** Real (gap 1 CLOSED): today-generation on-chain delivery-fact read via `TaskCoordinator`. */
function buildReadTodayDeliveryFacts(
  publicClient: PublicClient,
  taskCoordinator: Address,
): ProjectorEnrichPorts['readTodayDeliveryFacts'] {
  return async (requestId) => {
    try {
      const [taskId, attemptIndex, exists] = await publicClient.readContract({
        address: taskCoordinator,
        abi: REQUEST_REF_VIEW_ABI,
        functionName: 'getRequestRef',
        args: [requestId],
      });
      if (!exists) return undefined;
      const attempt = await publicClient.readContract({
        address: taskCoordinator,
        abi: GET_ATTEMPT_VIEW_ABI,
        functionName: 'getAttempt',
        args: [taskId, attemptIndex],
      });
      return { taskId, attemptIndex, onChainKeccak: attempt.solutionCidDigest };
    } catch {
      return undefined;
    }
  };
}

/**
 * Real (gap a, file header — first half CLOSED): resolves a today-generation Submission by
 * fetching the legacy `SignedTaskV1` document the legacy `CreatorLoop` actually posted, keyed off
 * the ON-CHAIN `taskCidDigest` fact. Reuses the EXACT retrieval path the legacy `MechAdapter`
 * already uses to read its own posted tasks back (`adapter.ts`'s
 * `restorationAnnouncementForTaskId` / `recoverTaskPost`): `getTaskCidDigest` takes the ROUTER
 * address (not the coordinator) and internally resolves `taskCoordinator()` from it before
 * reading `getTask(taskId).taskCidDigest` — the same two-hop read `adapter.ts` performs, not a
 * new one. The resulting bytes32 is converted to the raw-codec `sha256:` digest form and fetched
 * through this composition's own `fetchIpfsBytes` port (same IPFS gateway machinery as
 * `buildFetchIpfsBytes` above — the caller passes that exact port instance in).
 *
 * Fails closed (`undefined`) on ANY failure — no on-chain record for this taskId (`getTask`
 * reverts), a malformed/zero digest, or an IPFS miss — exactly `createProjectorEnrich`'s
 * documented "drop, retry next tick" contract. `createProjectorEnrich`'s own digest join
 * (`resolveTaskProjection` re-derives the digest from the fetched bytes and compares it against
 * the on-chain `TaskCreated.taskCidDigest` anchor) is an independent second check regardless of
 * what this port returns, so a wrong fetch here still cannot slip a corrupted document past the
 * join — this port only needs to be honest about failure, not the last line of defense.
 *
 * Exported so `client/test/daemon/*` can drive this exact production resolver against a fixture
 * `publicClient`/`fetchIpfsBytes`, proving the bridge synthesis path end to end rather than
 * against a hand-built test double.
 */
export function buildResolveSubmissionBytes(input: {
  readonly publicClient: PublicClient;
  readonly jinnRouter: Address;
  readonly fetchIpfsBytes: (digest: `sha256:${string}`) => Promise<Uint8Array | undefined>;
}): ProjectorEnrichPorts['resolveSubmissionBytes'] {
  return async ({ taskId }) => {
    let taskCidDigest: Hex;
    try {
      taskCidDigest = await getTaskCidDigest(input.publicClient, input.jinnRouter, taskId);
    } catch {
      return undefined;
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(taskCidDigest) || /^0x0{64}$/i.test(taskCidDigest)) {
      // Malformed or all-zero digest: no task was ever posted under this id, or `getTask`
      // returned a default-initialized record. Either way there is nothing honest to fetch.
      return undefined;
    }
    return input.fetchIpfsBytes(`sha256:${taskCidDigest.slice(2).toLowerCase()}`);
  };
}

/**
 * Native-only `projectAnnouncements.resolveRecord` path. Its resolver reads a local, requester-
 * signed canonical association; there is deliberately no IPFS retrieval, CreatorLoop document,
 * SignedTaskV1 parser, or synthesized projection on this path.
 */
export function buildNativeResolveRecord(
  chain: MarketplaceChainConfig,
  resolveAssociation: (lookup: NativeRequesterSubmissionLookup) => Promise<Uint8Array | undefined>,
): (event: ObservationMarketplaceEvent, role: AnnouncementRecordRole) => Promise<AnnouncementRecordMaterial> {
  return async (event, role) => {
    if (role === 'submission' && 'taskId' in event.facts) {
      if (
        event.derivation.chainId !== chain.chainId
        || event.projection.taskCoordinator.toLowerCase() !== chain.taskCoordinator.toLowerCase()
      ) {
        throw new Error('native resolveRecord refuses a projection outside the canonical Base Sepolia coordinator');
      }
      const bytes = await resolveAssociation({
        chainId: chain.chainId,
        coordinator: chain.taskCoordinator,
        taskId: event.facts.taskId,
        taskDigest: event.projection.taskDigest,
      });
      if (bytes !== undefined) return { kind: RECORD_KINDS.submission, bytes };
    }
    throw new Error(
      `resolveRecord has no production implementation for role "${role}" (composition-root.ts `
      + 'file header gap b)',
    );
  };
}

/**
 * Gap (a, file header — second half CLOSED, finding E35 ruled): `work-loop.ts`'s wrapped
 * `claimTask` now seals the dispatch-context document (TEP §9.3) exactly once, at claim time —
 * I-JSON, JCS, sha256 (TEP §9.1; `docs/superpowers/specs/2026-07-30-stack-design-principles.md`
 * §5 "Sealed once, forever") — into the engagement ledger row it already owns (spec §4: the
 * ledger holds "which wiring entry served a claim; operator-local decisions"; the dispatch
 * context is exactly such a document, authored by this same work-loop side of the two-party
 * engagement). This reads that sealed digest back rather than fabricating a `ResourceDescriptor`
 * for a document nobody sealed — the URI names the sealed digest, matching the shape
 * `observe-store.ts`'s stub already uses (`urn:jinn:marketplace:dispatch-context:<attempt>`).
 * Still fails closed (`undefined`) when no row exists for this task identity, or the row predates
 * the seal (claimed before this column existed, or never claimed at all) — `createProjectorEnrich`
 * already treats `undefined` as "drop this event, retry next tick", and a later tick's `get()`
 * will see the row once `work-loop.ts` claims it.
 *
 * Exported so `client/test/daemon/*` can drive this exact production resolver against a real
 * `EngagementLedger`, matching the `buildResolveSubmissionBytes` precedent above.
 */
export function buildEngagementLedgerDispatchContextPort(
  engagementLedger: EngagementLedger,
): ProjectorEnrichPorts['resolveDispatchContext'] {
  return async ({ chainId, taskCoordinator, taskId }) => {
    // Mirrors `work-loop.ts`'s private `idempotencyKeyFor` (and `settlement-grade.ts`'s own copy
    // of the same key shape) -- `${chainId}:${taskCoordinator}:${taskId}`.
    const idempotencyKey = `${chainId}:${taskCoordinator}:${taskId.toString()}`;
    const row = engagementLedger.get(idempotencyKey);
    if (row === undefined || row.dispatchContextDigest === null || row.attemptUri === null) {
      return undefined;
    }
    return {
      uri: `urn:jinn:marketplace:dispatch-context:${row.attemptUri}`,
      digest: { sha256: row.dispatchContextDigest.slice('sha256:'.length) },
    };
  };
}

/** New gap (b, file header): no Phase-B binding-resolver backing stores exist to verify a
 * Result Evaluation Statement's decision-grade gate for real. Loudly refuses rather than
 * fabricating a "verified" (or silently empty) result — `projectAnnouncements` turns this throw
 * into a fail-closed refusal, never a silent pass. */
function verifyVerdictObservationGap(): never {
  throw new Error(
    'verifyVerdictObservation has no production implementation: the Phase-B binding-resolver '
    + 'backing stores (BindingStore/AnchorReadClient/policy) do not exist anywhere in the repo '
    + '(composition-root.ts file header gap b)',
  );
}

/** Real for "submission" (reuses `resolveSubmissionBytes`, gap a above); new gap (b) for
 * "delivery"/"evaluation-delivery" — no lookup mechanism exists to resolve a Delivery's bytes
 * from an on-chain-observed event alone. Both cases are STILL unreachable in this composition
 * today: `resolveSubmissionBytes` is real now, but gap (a)'s still-open `resolveDispatchContext`
 * half drops every event inside `enrich()` before it ever reaches `resolveRecord` — kept honest
 * (throwing, not fabricating) so a future fix to that half fails loud instead of silent. */
function buildResolveRecord(
  resolveSubmissionBytes: ProjectorEnrichPorts['resolveSubmissionBytes'],
  chain: MarketplaceChainConfig,
): (event: ObservationMarketplaceEvent, role: AnnouncementRecordRole) => Promise<AnnouncementRecordMaterial> {
  return async (event, role) => {
    if (role === 'submission' && 'taskId' in event.facts) {
      const bytes = await resolveSubmissionBytes({
        chainId: event.derivation.chainId,
        taskCoordinator: chain.taskCoordinator,
        taskId: event.facts.taskId,
        generation: event.derivation.contractGeneration,
      });
      if (bytes !== undefined) return { kind: RECORD_KINDS.submission, bytes };
    }
    throw new Error(
      `resolveRecord has no production implementation for role "${role}" (composition-root.ts `
      + 'file header gap b)',
    );
  };
}

/**
 * Assembles a fully-real `ProjectorLoop` (C3 log source, C4 enrich, C5 durable observations) plus
 * the `ClaimGate` (contract 3) that wraps its `hasCaughtUp()`. It consumes the sole BaseVenue's
 * `logSource`; it never independently opens the venue state path.
 */
function buildProjector(input: {
  readonly mode: 'legacy' | 'native';
  readonly chain: MarketplaceChainConfig;
  readonly publicClient: PublicClient;
  readonly mechAddress: Address;
  readonly logSource: ChainLogSource;
  readonly archiveRoot: string;
  readonly discoverySigner: ScopedDiscoverySigner;
  readonly ipfsGatewayUrl: string;
  readonly store: Store;
  readonly pollIntervalMs: number;
  /** Same instance `buildOperatorComposition` later wires into `verifySettlementGrade` — the
   * dispatch-context resolver (finding E35) reads the exact rows `work-loop.ts` seals into. */
  readonly engagementLedger: EngagementLedger;
  /** Present only after native composition proved B2's requester-submission binding. */
  readonly nativeRequester?: {
    readonly stateDir: string;
    readonly requesterSubmission: NativeRequesterSubmissionVerifier;
  };
  readonly logger?: { info(m: string): void; warn(m: string): void };
}): {
  readonly projector: ProjectorLoop;
  readonly claimGate: ClaimGate;
  readonly observations: () => Promise<readonly ProtocolObservation[]>;
  /** Same underlying `cursorStore.readObservations()` as `observations` above, exposed as a
   *  plain sync accessor with its real `MarketplaceProtocolObservation[]` type (not the venue
   *  port's async, loosely-typed `ProtocolObservation[]`) — `buildArchiveSubscription` (finding
   *  E36) reads this directly rather than opening a second `ProjectorCursorStore`. */
  readonly readObservations: () => readonly import('@jinn-network/marketplace-projector').MarketplaceProtocolObservation[];
} {
  const cursorKey = `${input.chain.chainId}:${input.chain.taskCoordinator.toLowerCase()}`;
  const cursorStore = new ProjectorCursorStore(input.store, cursorKey);

  const isAuthorizedMechOrigin = (address: Address): boolean =>
    address.toLowerCase() === input.mechAddress.toLowerCase();

  const fetchIpfsBytes = buildFetchIpfsBytes(input.ipfsGatewayUrl);
  const resolveAssociation = input.mode === 'native'
    ? createNativeRequesterSubmissionResolver(input.nativeRequester ?? (() => {
      throw new Error('native projector requires a requester association directory and B2 requester-submission identity');
    })())
    : undefined;
  const resolveSubmissionBytes: ProjectorEnrichPorts['resolveSubmissionBytes'] = input.mode === 'native'
    ? async ({ chainId, taskCoordinator, taskId, taskDigest }) => {
      if (taskDigest === undefined || resolveAssociation === undefined) return undefined;
      return resolveAssociation({ chainId, coordinator: taskCoordinator, taskId, taskDigest });
    }
    : buildResolveSubmissionBytes({
      publicClient: input.publicClient,
      jinnRouter: input.chain.jinnRouter,
      fetchIpfsBytes,
    });
  const resolveDispatchContext = buildEngagementLedgerDispatchContextPort(input.engagementLedger);
  const enrich = createProjectorEnrich({
    chain: input.chain,
    publicClient: input.publicClient,
    fetchIpfsBytes,
    resolveSubmissionBytes,
    resolveDispatchContext,
    readTodayDeliveryFacts: buildReadTodayDeliveryFacts(input.publicClient, input.chain.taskCoordinator),
    allowLegacySignedTaskV1: input.mode === 'legacy',
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });

  const pageCountKey = `projector-page-count:${cursorKey}`;
  const ports: ProjectorPortsInput = {
    source: { agent: `urn:jinn:operator:${input.mechAddress.toLowerCase()}`, name: 'operator-projector' },
    signer: input.discoverySigner,
    archiveRoot: input.archiveRoot,
    resolveRecord: input.mode === 'native'
      ? buildNativeResolveRecord(input.chain, resolveAssociation!)
      : buildResolveRecord(resolveSubmissionBytes, input.chain),
    verifyVerdictObservation: verifyVerdictObservationGap,
    referencedBytes: { fetch: fetchIpfsBytes },
    readPageCount: () => Number.parseInt(input.store.getConfigValue(pageCountKey) ?? '0', 10),
    writePageCount: (count) => input.store.setConfigValue(pageCountKey, String(count)),
  };

  const projector = new ProjectorLoop({
    chain: input.chain,
    logSource: input.logSource,
    cursorStore,
    ports,
    enrich,
    pollIntervalMs: input.pollIntervalMs,
    store: input.store,
    isAuthorizedMechOrigin,
    readFinalizedBlockNumber: createFinalizedHeadReader(input.publicClient),
    readCanonicalBlockHash: createCanonicalBlockHashReader(input.publicClient),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });

  const claimGate = createProjectorCatchUpGate({
    hasCaughtUp: () => projector.hasCaughtUp(),
    pollIntervalMs: input.pollIntervalMs,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });

  return {
    projector,
    claimGate,
    observations: async () => cursorStore.readObservations(),
    readObservations: () => cursorStore.readObservations(),
  };
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
  const identities = input.nativeRoleIdentities;
  if (input.mode === 'native' && identities === undefined) {
    throw new Error('native operator boot requires persistent role identities with effective bindings');
  }
  if (input.mode === 'legacy' && identities !== undefined) {
    throw new Error('legacy operator composition must not receive native role identities');
  }
  if (input.mode === 'native' && input.legacyBridgeSigner !== undefined) {
    throw new Error('native operator composition must not receive a legacy bridge signer');
  }
  if (input.mode === 'native' && input.legacyDeliverySigningKey !== undefined) {
    throw new Error('native operator composition must not receive a legacy delivery signing key');
  }
  const solverDeliveryIdentity = input.mode === 'native'
    ? identities!.get('solver-delivery')
    : undefined;
  const solverDiscoveryIdentity = input.mode === 'native'
    ? identities!.get('solver-discovery')
    : undefined;
  const deliverySigningIdentity = solverDeliveryIdentity ?? input.legacyDeliverySigningKey;

  const fetchImpl = globalThis.fetch;
  const ipfsPin = createRegistryPinPort({ registryUrl: config.ipfsRegistryUrl, fetchImpl });

  // C6: the real `verifySettlementGrade`, wired against this composition's own engagement ledger
  // and profile store — replaces the deleted fail-closed stub (file header items 2, c). Built
  // before `buildProjector` (finding E35): the projector's dispatch-context resolver reads back
  // through this SAME ledger instance.
  const engagementLedger = new EngagementLedger(input.store);

  // C2: venue-base refuses ambient filesystem authority; tier-4 composition prepares the path.
  await mkdir(dirname(input.venueStateDbPath), { recursive: true });

  // `getDeliverySignature` is bound to `backend` via this mutable slot: `verifySettlementGrade`
  // is only ever CALLED later, at settlement time, well after `backend` is constructed below --
  // but it must be BUILT here, before `backend` exists, because `venue` (constructed next) needs
  // it. Assigned exactly once, immediately after `backend`'s construction, before any loop that
  // could call `verifySettlementGrade` starts.
  let backendForDeliverySignatures: LocalTaskExecutionBackend | undefined;
  const verifySettlementGrade = buildRealVerifySettlementGrade({
    profileStore: input.profileStore,
    engagementLedger,
    ...(deliverySigningIdentity === undefined ? {} : {
      executorKeyId: deliverySigningIdentity.keyId,
      executorPublicKey: deliverySigningIdentity.publicKey,
    }),
    getDeliverySignature: (digest) => backendForDeliverySignatures?.getDeliverySignature(digest),
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
  // BaseVenue captures (but does not invoke) observations during construction. Bind it to the
  // projector only after the venue supplies its single shared logSource; any premature use is a
  // boot ordering fault and rejects rather than returning an empty observation set.
  let projectorParts: ReturnType<typeof buildProjector> | undefined;
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
    observations: () => {
      if (projectorParts === undefined) {
        return Promise.reject(new Error('projector observation source is unavailable during venue boot'));
      }
      return projectorParts.observations();
    },
  });

  const discoverySigner: ScopedDiscoverySigner = solverDiscoveryIdentity === undefined
    ? {
        scope: DISCOVERY_SIGNING_SCOPE,
        sign: async () => {
          throw new Error('legacy composition cannot sign native discovery announcements');
        },
      }
    : {
        scope: DISCOVERY_SIGNING_SCOPE,
        sign: async (pae) => [{
          keyid: solverDiscoveryIdentity.keyId,
          sig: solverDiscoveryIdentity.sign(pae),
        }],
      };
  projectorParts = buildProjector({
    mode: input.mode,
    chain: input.chain,
    publicClient: input.publicClient,
    mechAddress: input.mechAddress,
    logSource: venue.logSource,
    archiveRoot: join(dirname(input.venueStateDbPath), 'discovery-archive'),
    discoverySigner,
    ipfsGatewayUrl: config.ipfsGatewayUrl,
    store: input.store,
    pollIntervalMs: input.projectorPollIntervalMs ?? 5000,
    engagementLedger,
    ...(input.mode === 'native' ? {
      nativeRequester: {
        stateDir: input.nativeRequesterStateDir ?? join(input.stateRoot, 'native-requester'),
        requesterSubmission: identities!.get('requester-submission'),
      },
    } : {}),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
  const { projector, claimGate, readObservations } = projectorParts;

  // Contract 1 (finding E16 / C2 ruling: per-daemon state, not a process-global install). Built
  // once per composition and returned on `OperatorComposition.broadcaster` — the host threads
  // this SAME instance to every legacy `executeSafeTransaction` call site it wants routed through
  // this Safe, before starting any loop that can write.
  const broadcaster: VenueBroadcaster = {
    safeAddress: input.safeAddress,
    execute: (request) => venue.safe.execute(request),
  };
  const deliveryBroadcaster = venue.safe;

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
      taskProfiles: [REPOSITORY_WORK_PROFILE, EVALUATION_TASK_PROFILE, PREDICTION_FORECAST_PROFILE],
      workspaceKinds: ['dir'],
      inputMediaTypes: ['application/json'],
      outputMediaTypes: ['application/json', 'application/octet-stream'],
      isolation: ['process'],
    },
    // `config.maxConcurrentAttempts` does not exist anywhere on `JinnConfig` (the plan assumes
    // a field that was never added) — always the backend's own default.
    maxConcurrentAttempts: 4,
    recorderAvailability: 'always',
    trustKeys: {
      observationSigningKeyConfigured: true,
      ...(deliverySigningIdentity === undefined ? {} : { deliverySigningKey: deliverySigningIdentity }),
    },
    evidence: evidence.ports,
    capabilityGrants: buildCapabilityGrants,
    ...(input.secretForwardResolver === undefined
      ? {}
      : { secretForwardResolver: input.secretForwardResolver }),
    cancellationGraceMs: 30_000,
    heartbeatIntervalMs: 10_000,
    // Bridge era only: this extension can be installed only by the explicit legacy path.
    deliveryExtensions:
      input.mode !== 'legacy' || input.legacyBridgeSigner === undefined
        ? () => ({})
        : buildLegacyDeliveryExtensions({
            stateRoot: input.stateRoot,
            participant: input.safeAddress,
            wiring,
            sign: input.legacyBridgeSigner,
          }),
  };
  const backend = new LocalTaskExecutionBackend(backendConfig);
  // Finding E31: completes the mutable slot `verifySettlementGrade` (built above, before
  // `backend` existed) closes over.
  backendForDeliverySignatures = backend;

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

  const fetchIpfsBytes = buildFetchIpfsBytes(config.ipfsGatewayUrl);
  const readSealedDocuments = async (card: AnnouncedSubmissionCard): Promise<SealedDocuments> => {
    const taskDigest = card.facts['taskDigest'];
    if (typeof taskDigest !== 'string' || !taskDigest.startsWith('sha256:')) {
      throw new Error(`readSealedDocuments: card carries no valid taskDigest fact (${card.chain.submission})`);
    }

    if (card.derivationKind === 'legacy') {
      const legacyBytes = await fetchIpfsBytes(taskDigest as `sha256:${string}`);
      if (legacyBytes === undefined) {
        throw new Error(`readSealedDocuments: could not resolve legacy SignedTaskV1 for ${card.chain.submission}`);
      }
      let legacyTask;
      try {
        legacyTask = parseSignedTaskV1(JSON.parse(new TextDecoder().decode(legacyBytes)));
      } catch {
        throw new Error(`readSealedDocuments: legacy bytes are not a valid SignedTaskV1 (${card.chain.submission})`);
      }
      const sealedRepoProfile = sealTaskProfile(buildRepositoryWorkProfile());
      if (input.profileStore.get(sealedRepoProfile.digest) === undefined) {
        throw new Error(
          `readSealedDocuments: repository-work profile not resolvable in profileStore (${card.chain.submission})`,
        );
      }
      const profileUri = card.facts['taskProfileUri'];
      if (typeof profileUri !== 'string' || profileUri !== REPOSITORY_WORK_PROFILE_URI) {
        throw new Error(
          `readSealedDocuments: legacy card carries unsupported taskProfileUri (${String(profileUri)})`,
        );
      }
      return synthesizeLegacyExecutionDocuments({
        task: legacyTask,
        taskBytes: legacyBytes,
        submissionUri: card.chain.submission,
        nonce: card.chain.nonce,
        profile: { uri: REPOSITORY_WORK_PROFILE_URI, digest: sealedRepoProfile.digest },
      });
    }

    const [taskBytes, submissionBytes] = await Promise.all([
      fetchIpfsBytes(taskDigest as `sha256:${string}`),
      fetchIpfsBytes(card.record.digest),
    ]);
    if (taskBytes === undefined || submissionBytes === undefined) {
      throw new Error(`readSealedDocuments: could not resolve sealed documents for ${card.chain.submission}`);
    }
    return { taskBytes, submissionBytes };
  };

  // Finding E36 (ruled "build it"): the `ArchiveSubscription` `work-loop.ts`'s `WorkLoopConfig`
  // needs, fed from this SAME `readObservations` accessor `venue`'s `observations` port above
  // already reads (one `ProjectorCursorStore`, two consumers) — see `./archive-subscription.js`.
  const archive = buildArchiveSubscription({
    readObservations,
    publicClient: input.publicClient,
    fetchIpfsBytes,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });

  return {
    mode: input.mode,
    backend,
    pipelineConfig,
    pipelinePorts,
    venue,
    deliveryBroadcaster,
    ...(identities === undefined ? {} : { identities }),
    evidence,
    chain: input.chain,
    safeAddress: input.safeAddress,
    mechAddress: input.mechAddress,
    broadcaster,
    noteAttemptWorkKind: (attempt, workKind, requestId) =>
      backend.noteAttemptWorkKind(attempt, workKind, requestId),
    projector,
    claimGate,
    engagementLedger,
    readSealedDocuments,
    archive,
    async close(): Promise<void> {
      try {
        await evidence.close();
      } finally {
        venue.close();
      }
    },
  };
}
