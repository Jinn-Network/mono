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
 *     (`packages/marketplace/binding/src/named-checks.ts`). It still loudly throws on the LEGACY
 *     path (`refuseLegacyVerdictObservation`); the NATIVE path supplies the real M4b adapter
 *     through `installVerdictObservation` (`native-fleet-runtime.ts`'s late-bound port).
 *
 *     `resolveRecord` for the `"delivery"` / `"evaluation-delivery"` roles CLOSED on the NATIVE
 *     path (defect #45). The premise above -- "no lookup mechanism anywhere" -- stopped being
 *     true once the native serving plane landed: `native-fleet-serving-plane.ts` serves every
 *     record this operator publishes under `config.publicBaseUrl`, and peers' records resolve
 *     over `config.recordSources` through the digest-verifying record transport.
 *
 *     Two lookup keys, because the two contract generations name the record differently, and the
 *     one the native fleet actually runs against is `BASE_SEPOLIA_TODAY` (JinnRouterV3):
 *       - REVISED (V4): the ON-CHAIN anchor (`SolutionDeliveryClaimed.deliveryDigest`,
 *         `VerdictDeliveryClaimed.evaluationDeliveryDigest`) keys a content-addressed fetch off
 *         the serving plane. Strictly the stronger path -- the chain names the bytes -- and it is
 *         taken whenever those facts are present.
 *       - TODAY (V3): those fields DO NOT EXIST on either event (`events.ts`'s `todayEvent`), so
 *         there is no digest to key off. The lookup key is the ENGAGEMENT instead, and the bytes
 *         come from this operator's own durable record store. Anchoring is NOT weakened, it just
 *         lives one layer downstream: for `"delivery"`, `announce.ts`'s `expectedMaterialDigest`
 *         reads the `delivery-recorded.v1` OBSERVATION digest (`observe.ts`, the today-mode
 *         sha256<->keccak mech correspondence) and `anchorCheckedMaterial` refuses on mismatch;
 *         for `"evaluation-delivery"`, the M4b gate (`native-verdict-observation.ts`) binds
 *         `documentDigest(material.bytes)` to exactly one durable evaluation-delivery artifact row
 *         and throws otherwise. Neither is a self-attestation: both re-derive the digest from the
 *         returned bytes and join it against something this resolver does not author.
 *
 *     `buildNativeResolveRecord` below implements both roles across both generations; the LEGACY
 *     path still refuses every delivery role by construction (`buildResolveRecord`, submission
 *     only).
 *
 *     This was gate-critical while it stood: the ratified DR-2026-08-05 G-loop criterion is a
 *     verdict announcement with `decisionGrade: true` plus a requester-side adopted delivery, and
 *     the announce leg asks for `"evaluation-delivery"` BEFORE it ever runs the verdict gate. A
 *     refusal there meant no native operator could publish any verdict announcement at all.
 *
 *     One correction to what this note used to claim: a `resolveRecord` throw is NOT a "retried"
 *     tick. `projector-loop.ts` catches it, publishes nothing for the whole tick, and still
 *     advances the cursor; `hasCanonicalEvent` then filters those events out of every later
 *     tick's `publicationEvents`. The announcements are dropped for good, so the throw is now a
 *     named `NativeAnnouncementRecordError` (role + anchor digest + cause) and the loop's warn
 *     names the loss.
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
import { constants, existsSync, readFileSync } from 'node:fs';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import {
  createBaseVenue,
  type BaseVenue,
  type BaseVenueSafeBroadcaster,
  type ChainLogSource,
  type ChainLogSourceOptions,
} from '@jinn-network/marketplace-venue-base';
import type {
  ClaimPorts,
  ContractGeneration,
  MarketplaceChainConfig,
} from '@jinn-network/marketplace-binding';
import {
  createRegistryPinPort,
  deriveMarketplaceAttemptUri,
  keccakEvidenceHash,
} from '@jinn-network/marketplace-binding';
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
import {
  DeliveryRecordSchema,
  documentDigest,
  serializeCanonicalJson,
  SubmissionRecordSchema,
} from '@jinn-network/task-execution-protocol';
import { DISCOVERY_SIGNING_SCOPE, RECORD_KINDS } from '@jinn-network/record-discovery-protocol';
import { legacyPredictionV1BaselineLauncher } from './legacy-prediction-v1-launcher.js';
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
import { setDefaultEoaBroadcastLock } from '../tx-retry.js';
import type { Store } from '../store/store.js';
import { fetchRawBytesFromIpfs } from '../adapters/mech/ipfs.js';
import { getTaskCidDigest } from '../adapters/mech/contracts.js';
import { openOperatorEvidence, type OperatorEvidence } from './evidence-join.js';
import { buildLegacyExecutionEnvelope, LEGACY_ENVELOPE_EXTENSION_KEY, synthesizeLegacyExecutionDocuments } from './bridge-legacy-delivery.js';
import { EngagementLedger } from './engagement-ledger.js';
import { buildVerifySettlementGrade as buildRealVerifySettlementGrade } from './settlement-grade.js';
import { createProjectorCatchUpGate, type ClaimGate } from './claim-gate.js';
import { createCanonicalBlockHashReader, createFinalizedHeadReader } from './projector-log-source.js';
import {
  createProjectorEnrich,
  type ProjectorEnrichPorts,
  type RecordPlaneDeliveryResolution,
} from './projector-enrich.js';
import { ProjectorCursorStore } from './projector-cursor.js';
import { ProjectorLoop } from './projector-loop.js';
import type { ProjectorPortsInput } from './projector-ports.js';
import type { AnnouncedSubmissionCard, ArchiveSubscription, SealedDocuments } from './work-loop.js';
import { buildArchiveSubscription } from './archive-subscription.js';
import { parseSignedTaskV1 } from '../types/task-document.js';
import type { RoleIdentitySet } from './role-identities.js';
import {
  assertNativeProjectorExactPorts,
  type NativeProjectorExactPorts,
} from './native-projector-ports.js';
import {
  evaluateNativeClaim,
  type NativeLauncherCapabilityPort,
  type NativeTier4ClaimPolicy,
} from './native-claim-policy.js';
import {
  NativeClaimCoordinator,
  type NativeClaimCanonicalReader,
} from './native-claim-coordinator.js';
import type { NativeEngagementRow, NativeOperatorStateRepository } from './native-operator-state.js';
import { NativeSolutionCoordinator, type NativeSolutionSettlementPort } from './native-solution-coordinator.js';
import {
  openNativeSolutionPublisher,
  type NativeSolutionPublisher,
} from './native-solution-publisher.js';
import { buildNativeSolutionVerification } from './native-solution-verification.js';
import {
  buildNativeSolutionCorrections,
  teeNativeMarketplaceEvents,
  type NativeSolutionCorrections,
} from './native-solution-corrections.js';
import { NativeMarketplaceEventRepository } from './native-canonical-observations.js';
import { buildNativeSolutionSettlementPort } from './native-solution-settlement.js';
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
  readonly archive?: ArchiveSubscription;
  /** Present only in native mode. Owns B5 admission/claim/reconciliation; never executes work. */
  readonly nativeClaimCoordinator?: NativeClaimCoordinator;
  /** Present only in native mode; resumes execution/publication/solution settlement at startup. */
  readonly nativeSolutionCoordinator?: NativeSolutionCoordinator;
  /** Dedicated `solver-records` source; never shares the ProjectorLoop source tuple or root. */
  readonly nativeSolutionPublisher?: NativeSolutionPublisher;
  /** Present only in native mode; the WorkLoop's per-tick signed reorg-correction reconciler. */
  readonly nativeSolutionCorrections?: NativeSolutionCorrections;
  readonly nativeOperatorState?: NativeOperatorStateRepository;
  readonly nativeLauncherInspector?: NativeLauncherCapabilityPort;
  close(): Promise<void>;
}

export interface NativeClaimRuntimeInput {
  /** Exact agent IRI used when B2 resolved every role binding. */
  readonly operatorAgent: string;
  readonly state: NativeOperatorStateRepository;
  readonly exactDocuments: (card: AnnouncedSubmissionCard) => Promise<SealedDocuments>;
  readonly canonical: NativeClaimCanonicalReader;
  readonly policy: NativeTier4ClaimPolicy;
  readonly canonicalFinalized: (card: AnnouncedSubmissionCard) => Promise<boolean>;
  readonly activeEngagements: () => number;
  readonly worker: { readonly ownerId: string; readonly ttlMs: number };
  readonly now?: () => Date;
  readonly solution: {
    /** Dedicated lifecycle-owned directory, distinct from the projector archive root. */
    readonly publisherRootDir: string;
    readonly publicBaseUrl: string;
    /** Re-resolves original exact requester bytes during startup recovery. */
    readonly exactDocuments: (engagement: NativeEngagementRow) => Promise<SealedDocuments>;
    /** Resolves the Task's advertised public EvaluationSpec by exact digest. */
    readonly resolveEvaluationSpec: (digest: `sha256:${string}`) => Promise<Uint8Array | undefined>;
    /**
     * Chain-direct canonical settlement reader (the `createSolverReads` primitive, with the #2565
     * HTTP-locator payload re-fetch). The single-host solver (`native-solver-production.ts`) wires
     * the equivalent `input.infrastructure.solver.solutionSettlementCanonical` as the settlement
     * port's `canonicalReader`; the fleet composition threads it here so a below-projector-window
     * finalized delivery settles chain-direct instead of hanging on the projector observation
     * stream forever (#29). Absent → the settlement port falls back to the projector-only reader.
     */
    readonly solutionSettlementCanonical: NativeSolutionSettlementPort['readCanonical'];
  };
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
  /** Host-owned scan floor/finality policy for bounded-history deployments and fixtures. */
  readonly venueLogSource?: ChainLogSourceOptions;
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
  /** Required native B5 product-owned state/chain/document ports. Legacy mode must omit it. */
  readonly nativeClaimRuntime?: NativeClaimRuntimeInput;
  /** Required B6/B7 exact-byte/public-verdict ports. Native mode has no gap fallback. */
  readonly nativeProjectorPorts?: NativeProjectorExactPorts;
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
  /**
   * D0a round-2 critical fix: whether this call installs its venue lock as the process-wide
   * default for `client/src/tx-retry.ts`'s `withEoaBroadcastLock`/`withNonceLedger` (see the
   * `setDefaultEoaBroadcastLock` call below). Defaults to `true`, unchanged for the ordinary
   * one-composition-per-process host.
   *
   * A process that legitimately composes MORE THAN ONE venue (the e2e harness's two-daemon
   * scripts, any future multi-Safe host) must pass `false` for every composition after the
   * first: `setDefaultEoaBroadcastLock` throws on a second, DIFFERENT key rather than silently
   * clobbering the first composition's lock (D0a round-1), so an unconditional install here made
   * that legitimate topology impossible to compose at all. Passing `false` opts a composition out
   * of the shared default explicitly — its own `venue.safe.execute` broadcasts remain fully
   * correct (they always go through this composition's OWN `venue.safe`, never the global), but
   * any EOA-DIRECT write this composition's host makes outside the venue (setMetadata, eviction
   * recovery, `executeSafeTxDirect`/`executeSafeTxBatch` off the earning module) will serialize
   * against the in-process queue (or whichever OTHER composition's lock is installed) rather than
   * THIS composition's own durable, cross-process Safe lock. That is a real, accepted reduction in
   * the #525/#562/#897 cross-domain guarantee for every composition after the first — acceptable
   * for the test/harness hosts this exists for today, not a general N-venue production posture.
   */
  readonly installDefaultEoaBroadcastLock?: boolean;
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
  legacyPredictionV1BaselineLauncher,
];

/**
 * Wiring `harness` values that are legacy HarnessImpl names (or aliases) mapped onto the
 * LauncherContract `id` they correspond to. `hermes-agent` is the registered harness name in
 * `client/src/harnesses/names.ts`; the launcher package id is simply `hermes`.
 */
const HARNESS_TO_LAUNCHER_ID: Readonly<Record<string, string>> = {
  'hermes-agent': 'hermes',
};

const LEGACY_HARNESS_TO_LAUNCHER_ID: Readonly<Record<string, string>> = {
  ...HARNESS_TO_LAUNCHER_ID,
  'prediction-v1-baseline': legacyPredictionV1BaselineLauncher.id,
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
export interface LauncherDeployment {
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

function buildLaunchers(
  wiring: readonly ExecutionWiringEntry[],
  mode: CompositionRootInput['mode'],
): readonly LauncherContract[] {
  const aliases = mode === 'legacy' ? LEGACY_HARNESS_TO_LAUNCHER_ID : HARNESS_TO_LAUNCHER_ID;
  const wanted = new Set(
    wiring.map((entry) => aliases[entry.harness] ?? entry.harness),
  );
  return ALL_LAUNCHERS.filter((launcher) => wanted.has(launcher.id));
}

export function buildLauncherDeployments(
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
      probe: async () => {
        try {
          await access(executable.path, constants.X_OK);
          const currentDigest = createHash('sha256').update(await readFile(executable.path)).digest('hex');
          if (executable.digest === 'unresolved' || currentDigest !== executable.digest) {
            return { ready: false, executable };
          }
          return { ready: true, executable };
        } catch {
          return { ready: false, executable };
        }
      },
    };
  }
  return deployments;
}

export function buildNativeLauncherCapabilityPort(
  launchers: readonly LauncherContract[],
  deployments: Readonly<Record<string, LauncherDeployment>>,
): NativeLauncherCapabilityPort {
  return {
    async inspect({ profileUri, requirements }) {
      const harness = requirements['harness'];
      const requestedId = typeof harness === 'string'
        ? harness
        : typeof harness === 'object' && harness !== null && typeof (harness as { id?: unknown }).id === 'string'
          ? (harness as { id: string }).id
          : undefined;
      const launcher = launchers.find((candidate) =>
        (requestedId === undefined || candidate.id === requestedId)
        && candidate.capabilities().taskProfiles.includes(profileUri));
      if (launcher === undefined) throw new Error(`no launcher advertises ${profileUri}`);
      const deployment = deployments[launcher.id];
      if (deployment === undefined) throw new Error(`launcher ${launcher.id} has no configured executable deployment`);
      const [deploymentProbe, launcherProbe] = await Promise.all([
        deployment.probe(),
        launcher.probe === undefined
          ? Promise.resolve({ ready: false, detail: 'launcher has no readiness probe' })
          : launcher.probe().catch((error) => ({
              ready: false,
              detail: error instanceof Error ? error.message : String(error),
            })),
      ]);
      return {
        launcherId: launcher.id,
        taskProfiles: launcher.capabilities().taskProfiles,
        executable: deployment.executable,
        probe: {
          ready: deploymentProbe.ready && launcherProbe.ready,
          ...(!deploymentProbe.ready
            ? { detail: 'deployment executable is missing, non-executable, or changed since boot' }
            : launcherProbe.detail === undefined ? {} : { detail: launcherProbe.detail }),
          executable: deploymentProbe.executable,
        },
      };
    },
  };
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
//
// PRODUCER/VERIFIER PARITY (defect #47): the producing side registers a SOLUTION request and a
// VERDICT request in two disjoint on-chain maps — `TaskCoordinator._requestRefs` (written by
// `registerRequest`, read by `getRequestRef`) and `TaskCoordinator._verdictRequestRefs` (written
// by `registerVerdictRequest`, read by `getVerdictRequestRef`, `TaskCoordinator.sol:359/458`).
// A verifier that consults only `getRequestRef` therefore reports "no on-chain request reference"
// for every verdict delivery that ever settled, and enrich drops the Mech `Deliver` that carries
// the evaluator's verdict — the reason the round-28 verdict announcement never projected. The
// verdict maps' own anchor is `VerdictRecord.verdictCidDigest` (`getVerdict`), the exact analogue
// of `AttemptRecord.solutionCidDigest` for the solution leg.
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

const VERDICT_REQUEST_REF_VIEW_ABI = [{
  name: 'getVerdictRequestRef', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'requestId', type: 'bytes32' }],
  outputs: [
    { name: 'taskId', type: 'uint256' },
    { name: 'attemptIndex', type: 'uint32' },
    { name: 'verdictIndex', type: 'uint32' },
    { name: 'exists', type: 'bool' },
  ],
}] as const;

/**
 * `TaskCoordinator.getVerdict` — `verdictCidDigest` is the exact digest argument the evaluator's
 * `claimVerdictDelivery(verdictRequestId, verdictDigest, verdictCode)` wrote through
 * `recordVerdict` (`TaskCoordinator.sol:403`), the verdict-leg counterpart of the solution leg's
 * `AttemptRecord.solutionCidDigest`.
 */
const GET_VERDICT_VIEW_ABI = [{
  name: 'getVerdict', type: 'function', stateMutability: 'view',
  inputs: [
    { name: 'taskId', type: 'uint256' },
    { name: 'attemptIndex', type: 'uint32' },
    { name: 'verdictIndex', type: 'uint32' },
  ],
  outputs: [{
    name: 'verdict', type: 'tuple',
    components: [
      { name: 'taskId', type: 'uint256' },
      { name: 'attemptIndex', type: 'uint32' },
      { name: 'verdictIndex', type: 'uint32' },
      { name: 'evaluator', type: 'address' },
      { name: 'requestId', type: 'bytes32' },
      { name: 'verdictCidDigest', type: 'bytes32' },
      { name: 'verdictCode', type: 'uint8' },
      { name: 'status', type: 'uint8' },
    ],
  }],
}] as const;

/**
 * `TaskCoordinator.getTask` — read directly off the coordinator this composition already holds,
 * not through `getTaskCidDigest`'s router→`taskCoordinator()`→`getTask` two-hop (that indirection
 * exists only for the legacy adapter, which is handed a router address).
 */
const GET_TASK_VIEW_ABI = [{
  name: 'getTask', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'taskId', type: 'uint256' }],
  outputs: [{
    name: 'task', type: 'tuple',
    components: [
      { name: 'creator', type: 'address' },
      { name: 'taskCidDigest', type: 'bytes32' },
      { name: 'manifestDigest', type: 'bytes32' },
      { name: 'status', type: 'uint8' },
      { name: 'policy', type: 'uint8' },
      { name: 'claimCount', type: 'uint32' },
      { name: 'submittedCount', type: 'uint32' },
      { name: 'finalizedAttemptCount', type: 'uint32' },
      { name: 'creatorCredited', type: 'bool' },
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

/**
 * Real (gap 1 CLOSED): today-generation on-chain delivery-fact read via `TaskCoordinator`.
 *
 * FAILURE IS NOT ABSENCE (#2647). Both legs used to collapse into one `undefined`, which the
 * requester-side resolver then could not tell apart from the genuine "this requestId is not on
 * this chain's books" answer — so one 503 on `getRequestRef` read as "not the requester" and
 * produced a permanent false rejection. The two are decidable, not a judgment call: every view
 * read here is a plain mapping read (`TaskCoordinator.sol:437-465`) returning `exists: false` or a
 * zero record for an unknown key, and none of them can revert. A THROW is therefore always
 * transport, never absence.
 *
 *   - `{ taskId, attemptIndex, onChainKeccak }` — the reference resolved.
 *   - `undefined` — genuine absence: the requestId is in NEITHER map, both reads answered.
 *   - `'unavailable'` — a read failed; nothing was learned about this requestId.
 *
 * Exported so `client/test/daemon/*` can drive this exact production resolver against the deployed
 * contract's real two-map shape, matching the `buildResolveSubmissionBytes` precedent below.
 */
export function buildReadTodayDeliveryFacts(
  publicClient: PublicClient,
  taskCoordinator: Address,
): ProjectorEnrichPorts['readTodayDeliveryFacts'] {
  return async (requestId) => {
    let solutionLegFailed = false;
    try {
      const [taskId, attemptIndex, exists] = await publicClient.readContract({
        address: taskCoordinator,
        abi: REQUEST_REF_VIEW_ABI,
        functionName: 'getRequestRef',
        args: [requestId],
      });
      if (exists) {
        const attempt = await publicClient.readContract({
          address: taskCoordinator,
          abi: GET_ATTEMPT_VIEW_ABI,
          functionName: 'getAttempt',
          args: [taskId, attemptIndex],
        });
        return { taskId, attemptIndex, onChainKeccak: attempt.solutionCidDigest };
      }
    } catch {
      // A solution-leg read failure must not hide the verdict leg: the two maps are disjoint and
      // a requestId absent from one is expected, not an error. Fall through and ask the other --
      // but REMEMBER the failure, because a later verdict-leg `exists: false` then answers only
      // half the question and must not be reported as the whole-chain absence.
      solutionLegFailed = true;
    }
    try {
      const [taskId, attemptIndex, verdictIndex, exists] = await publicClient.readContract({
        address: taskCoordinator,
        abi: VERDICT_REQUEST_REF_VIEW_ABI,
        functionName: 'getVerdictRequestRef',
        args: [requestId],
      });
      if (!exists) return solutionLegFailed ? 'unavailable' : undefined;
      const verdict = await publicClient.readContract({
        address: taskCoordinator,
        abi: GET_VERDICT_VIEW_ABI,
        functionName: 'getVerdict',
        args: [taskId, attemptIndex, verdictIndex],
      });
      return { taskId, attemptIndex, onChainKeccak: verdict.verdictCidDigest };
    } catch {
      return 'unavailable';
    }
  };
}

/**
 * The canonical on-chain Task anchor (`TaskCoordinator.getTask(taskId).taskCidDigest`) — the exact
 * value `TaskCreated` carries in its `taskCidDigest` field, written once by `createTask`
 * (`TaskCoordinator.sol:227`) and never mutated afterwards, which is why the per-process memo below
 * is sound.
 *
 * The native Submission resolver keys its association on `(chainId, coordinator, taskId,
 * taskDigest)`, but `eventIdentity` only surfaces a `taskDigest` for `TaskCreated` — every other
 * event class reaches `resolveTaskProjection` with the anchor absent (defect #47). Reading it back
 * off the coordinator restores the key for those classes without weakening anything: the
 * association resolver re-checks the digest against its stored Task bytes, and `resolveTaskProjection`
 * independently re-derives it from the fetched content, so a wrong anchor here can only ever fail
 * closed.
 *
 * Three answers, for the reason spelled out on {@link buildReadTodayDeliveryFacts} (#2647):
 * `getTask` is a plain mapping read that returns an all-zero record for an unknown task and cannot
 * revert, so `undefined` is reserved for the anchor genuinely not being there (unknown task, or the
 * all-zero record of a creation not yet included) and `'unavailable'` says the read failed. Neither
 * is ever memoized — a task created, or an RPC recovered, after this read must resolve later.
 *
 * Exported so `client/test/daemon/*` can drive this exact production resolver.
 */
export function buildReadOnChainTaskDigest(
  publicClient: PublicClient,
  taskCoordinator: Address,
): (taskId: bigint) => Promise<`sha256:${string}` | 'unavailable' | undefined> {
  const memo = new Map<string, `sha256:${string}`>();
  return async (taskId) => {
    const key = taskId.toString();
    const memoized = memo.get(key);
    if (memoized !== undefined) return memoized;
    let digest: `sha256:${string}` | undefined;
    try {
      const task = await publicClient.readContract({
        address: taskCoordinator,
        abi: GET_TASK_VIEW_ABI,
        functionName: 'getTask',
        args: [taskId],
      });
      const anchor = task.taskCidDigest;
      if (/^0x[0-9a-fA-F]{64}$/.test(anchor) && !/^0x0{64}$/i.test(anchor)) {
        digest = `sha256:${anchor.slice(2).toLowerCase()}`;
      }
    } catch {
      return 'unavailable';
    }
    if (digest !== undefined) memo.set(key, digest);
    return digest;
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
 * A native `resolveRecord` refusal, named so the projector loop's catch can report the ROLE, the
 * anchor DIGEST and the CAUSE rather than an anonymous message (defect #45, the #33/#36/#43
 * opacity class at the projector layer). Never carries bytes: a refusal is a refusal.
 */
export class NativeAnnouncementRecordError extends Error {
  override readonly name = 'NativeAnnouncementRecordError';

  constructor(
    readonly role: AnnouncementRecordRole,
    readonly reason: string,
    readonly digest?: `sha256:${string}`,
  ) {
    super(
      `native resolveRecord refused the "${role}" record`
      + `${digest === undefined ? '' : ` (anchor ${digest})`}: ${reason}`,
    );
  }
}

/**
 * The on-chain anchor a delivery-family record must equal, read from the revised-generation event
 * facts `SolutionDeliveryClaimed.deliveryDigest` / `VerdictDeliveryClaimed.
 * evaluationDeliveryDigest`. Deriving it here (rather than fetching by some other key and letting
 * the announce plane's check catch a mismatch) is what makes THIS leg content-addressed: the chain
 * names the bytes, and only bytes that re-derive to that name are ever returned.
 *
 * Precisely on what `announce.ts` then re-checks, because the two roles differ:
 *   - `"evaluation-delivery"`: `expectedMaterialDigest` reads `evaluationDeliveryDigest` off the
 *     event, so it is literally the same fact.
 *   - `"delivery"`: `expectedMaterialDigest` reads the `delivery-recorded.v1` OBSERVATION's digest,
 *     never the event fact. On a revised claim `observe.ts` emits that observation as
 *     `digestFromBytes32(event.facts.deliveryDigest)`, so the two coincide — but the announce
 *     plane's anchor is the observation, and on a today claim that observation carries the mech
 *     correspondence digest instead. Same check, different provenance.
 *
 * `undefined` on a today-generation event, whose facts carry no such field at all — see
 * {@link todayDeliveryMaterial}, which keys off the engagement instead and leaves the anchoring to
 * that observation join / the M4b gate.
 */
function deliveryAnchorDigest(
  event: ObservationMarketplaceEvent,
  role: 'delivery' | 'evaluation-delivery',
): `sha256:${string}` | undefined {
  const anchor = role === 'delivery'
    ? (event.event === 'SolutionDeliveryClaimed' && 'deliveryDigest' in event.facts
      ? event.facts.deliveryDigest
      : undefined)
    : (event.event === 'VerdictDeliveryClaimed' && 'evaluationDeliveryDigest' in event.facts
      ? event.facts.evaluationDeliveryDigest
      : undefined);
  if (typeof anchor !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(anchor) || /^0x0{64}$/iu.test(anchor)) {
    return undefined;
  }
  return `sha256:${anchor.slice(2).toLowerCase()}`;
}

/**
 * Digest-keyed retrieval over this operator's own native serving plane and its configured peers.
 * Contract (mirroring `buildFleetDeliveryBytesResolver`, `native-fleet-runtime.ts`): returns bytes
 * ONLY when they re-derive to the requested digest, and `undefined` on any miss, transport failure
 * or mismatch. Never throws for a miss.
 */
export type NativeRecordBytesResolver =
  (digest: `sha256:${string}`) => Promise<Uint8Array | undefined>;

/**
 * The ENGAGEMENT this operator's own solution-delivery record hangs off. Today-generation
 * `SolutionDeliveryClaimed` carries no `deliveryDigest`, so `(taskId, attemptIndex)` on the
 * canonical coordinator is the only key the chain gives — and it is enough, because the record is
 * one this operator itself produced and durably stored.
 */
export interface NativeOwnSolutionDeliveryLookup {
  readonly chainId: number;
  readonly coordinator: Address;
  readonly taskId: bigint;
  readonly attemptIndex: number;
}

/**
 * The ENGAGEMENT this operator's own evaluation-delivery record hangs off. Deliberately the SAME
 * narrowing the M4b gate (`native-verdict-observation.ts`) applies before it binds on the artifact
 * digest — task, solution attempt, verdict code, evaluation request id — so a row this resolver
 * returns is a row that gate can then bind, and a row it cannot bind is refused there.
 */
export interface NativeOwnEvaluationDeliveryLookup {
  readonly chainId: number;
  readonly coordinator: Address;
  readonly taskId: bigint;
  readonly solutionAttemptIndex: number;
  readonly verdictCode: number;
  readonly evaluationRequestId: string;
}

/**
 * Engagement-keyed retrieval over this operator's OWN durable record stores, for the
 * today-generation legs where the chain names no digest. Each returns `undefined` on a miss and on
 * an ambiguous match (more than one durable row for one on-chain engagement is a derivation defect,
 * not a record to guess between) — never throws for a miss.
 */
export interface NativeOwnDeliveryRecords {
  readonly solutionDelivery:
    (lookup: NativeOwnSolutionDeliveryLookup) => Promise<Uint8Array | undefined>;
  readonly evaluationDelivery:
    (lookup: NativeOwnEvaluationDeliveryLookup) => Promise<Uint8Array | undefined>;
}

/**
 * A solution-delivery record ANOTHER operator produced, resolved off the record plane and bound to
 * the coordinator's own anchor. Deliberately a separate port from {@link NativeOwnDeliveryRecords}:
 * that one is named "own" because its bytes come from this operator's durable stores and need no
 * network, and wiring a counterparty lookup behind that name would make both the type and its
 * refusal message lie. Carries `requestId` and `taskDigest` because the anchor and the record's
 * self-description are what make a counterparty's bytes admissible at all.
 *
 * `undefined` for "no admissible record", never a throw — the caller owns the refusal.
 */
export type NativeCounterpartySolutionDeliveryResolver = (lookup: {
  readonly chainId: number;
  readonly coordinator: Address;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly requestId: Hex;
  readonly taskDigest: `sha256:${string}`;
}) => Promise<Uint8Array | undefined>;

/**
 * The TODAY-generation (JinnRouterV3) delivery legs — the generation the native fleet actually
 * pins (`main.ts`'s `BASE_SEPOLIA_TODAY`, `native-fleet-runtime.ts`'s `chain`). Neither
 * `SolutionDeliveryClaimed` nor `VerdictDeliveryClaimed` carries a delivery digest in this
 * generation (`packages/marketplace/projector/src/events.ts`'s `todayEvent`), so the ENGAGEMENT is
 * the lookup key and the bytes come from this operator's own durable stores.
 *
 * That is a lookup key, not a trust boundary. The anchor check for each role lives downstream and
 * is unchanged in strength:
 *   - `"delivery"`: `announce.ts`'s `expectedMaterialDigest` reads the `delivery-recorded.v1`
 *     observation digest — which `observe.ts` emits ONLY after the today-mode sha256<->keccak mech
 *     correspondence check passes — and `anchorCheckedMaterial` refuses on mismatch. The announce
 *     leg is itself gated on that same observation existing, so the check is never skipped.
 *   - `"evaluation-delivery"`: the M4b gate binds `documentDigest(material.bytes)` to exactly one
 *     durable evaluation-delivery artifact row and re-verifies the whole graph through the
 *     coordinator's verdict gate, refusing on any other count.
 */
async function todayDeliveryMaterial(
  event: ObservationMarketplaceEvent,
  role: 'delivery' | 'evaluation-delivery',
  ownRecords: NativeOwnDeliveryRecords | undefined,
  chain: MarketplaceChainConfig,
  resolveCounterpartyDelivery?: NativeCounterpartySolutionDeliveryResolver,
): Promise<AnnouncementRecordMaterial> {
  // A composition with NO way at all to reach a delivery record is a wiring fault, and saying so
  // outranks any refusal about the event's own shape — the operator has to fix the composition
  // before the event matters. Ahead of every other check for exactly that reason.
  if (ownRecords === undefined && resolveCounterpartyDelivery === undefined) {
    throw new NativeAnnouncementRecordError(
      role,
      'no native durable record store is wired into this composition',
    );
  }
  if (role === 'delivery') {
    if (event.event !== 'SolutionDeliveryClaimed') {
      throw new NativeAnnouncementRecordError(
        role,
        `${event.event} is not a solution-delivery claim`,
      );
    }
    const { taskId, attemptIndex, requestId } = event.facts;
    // This operator's OWN durable record first. It needs no network and no chain read, and it is
    // the answer for the overwhelmingly common case: the solver announcing its own delivery.
    const own = await ownRecords?.solutionDelivery({
      chainId: chain.chainId,
      coordinator: chain.taskCoordinator,
      taskId,
      attemptIndex,
    });
    if (own !== undefined) return { kind: RECORD_KINDS.delivery, bytes: own };
    // Then the counterparty leg (#2644 parity): a requester announcing a delivery ANOTHER operator
    // produced holds no such record and never will, but can anchor the published one against the
    // coordinator. Strictly additive — every check the own-record path relies on downstream is
    // unchanged, and this leg adds the on-chain keccak anchor on top.
    const counterparty = await resolveCounterpartyDelivery?.({
      chainId: chain.chainId,
      coordinator: chain.taskCoordinator,
      taskId,
      attemptIndex,
      requestId,
      taskDigest: event.projection.taskDigest,
    });
    if (counterparty !== undefined) return { kind: RECORD_KINDS.delivery, bytes: counterparty };
    throw new NativeAnnouncementRecordError(
      role,
      'this operator holds no single durable solution-delivery record for '
      + `task=${taskId} attempt=${attemptIndex}`
      + (resolveCounterpartyDelivery === undefined
        ? ''
        : ', and no record-plane candidate re-derives to the coordinator\'s solution anchor'),
    );
  }
  if (ownRecords === undefined) {
    throw new NativeAnnouncementRecordError(
      role,
      'no native durable record store is wired into this composition',
    );
  }
  if (event.event !== 'VerdictDeliveryClaimed') {
    throw new NativeAnnouncementRecordError(role, `${event.event} is not a verdict-delivery claim`);
  }
  const { taskId, attemptIndex, verdictCode, requestId } = event.facts;
  const bytes = await ownRecords.evaluationDelivery({
    chainId: chain.chainId,
    coordinator: chain.taskCoordinator,
    taskId,
    solutionAttemptIndex: attemptIndex,
    verdictCode,
    evaluationRequestId: requestId,
  });
  if (bytes === undefined) {
    throw new NativeAnnouncementRecordError(
      role,
      'this operator holds no single durable evaluation-delivery record for '
      + `task=${taskId} attempt=${attemptIndex} verdictCode=${verdictCode} requestId=${requestId}`,
    );
  }
  return { kind: RECORD_KINDS.delivery, bytes };
}

/**
 * Native-only `projectAnnouncements.resolveRecord` path. Its submission leg reads a local,
 * requester-signed canonical association; there is deliberately no IPFS retrieval, CreatorLoop
 * document, SignedTaskV1 parser, or synthesized projection on this path.
 *
 * Its DELIVERY legs (`"delivery"`, `"evaluation-delivery"` — defect #45, previously the file
 * header's gap b) resolve by GENERATION. On a revised (V4) claim the on-chain anchor names the
 * bytes and `resolveRecordBytes` fetches them content-addressed off the native serving plane (this
 * operator's own published records and its configured peers'). On a today (V3) claim — the
 * generation this fleet actually pins — no such fact exists, so the engagement keys
 * `ownRecords` (see {@link todayDeliveryMaterial} for where each anchor check then lives). Both are real
 * announce-plane requests on the native path — `announce.ts` asks for `"delivery"` on
 * `SolutionDeliveryClaimed` and `"evaluation-delivery"` on `VerdictDeliveryClaimed` — and while
 * this refused them BOTH, no verdict announcement could ever be published, which is exactly the
 * `decisionGrade: true` announcement the ratified DR-2026-08-05 G-loop criterion requires
 * (`log/decisions/2026-08-05-cutover-one-swap-collapse.md`).
 *
 * Fail-closed is unchanged in strength and only more legible: an unresolvable or non-matching
 * record still yields NO announcement. The refusal is now a named
 * `NativeAnnouncementRecordError` carrying the role, the on-chain anchor digest and the cause, so
 * the projector loop's non-fatal catch logs something an operator can act on instead of a bare
 * "no production implementation".
 */
export function buildNativeResolveRecord(
  chain: MarketplaceChainConfig,
  resolveAssociation: (lookup: NativeRequesterSubmissionLookup) => Promise<Uint8Array | undefined>,
  resolveRecordBytes?: NativeRecordBytesResolver,
  ownRecords?: NativeOwnDeliveryRecords,
  resolveCounterpartyDelivery?: NativeCounterpartySolutionDeliveryResolver,
): (event: ObservationMarketplaceEvent, role: AnnouncementRecordRole) => Promise<AnnouncementRecordMaterial> {
  // Named like every other refusal on this path (defect #45 fix-round item 5): a projection from
  // the wrong chain or coordinator is a refusal, and the loop's warn should say which ROLE was
  // refused, not just that "something" was outside the coordinator.
  const assertCanonical = (event: ObservationMarketplaceEvent, role: AnnouncementRecordRole): void => {
    if (
      event.derivation.chainId !== chain.chainId
      || event.projection.taskCoordinator.toLowerCase() !== chain.taskCoordinator.toLowerCase()
    ) {
      throw new NativeAnnouncementRecordError(
        role,
        'native resolveRecord refuses a projection outside the canonical Base Sepolia coordinator '
        + `(chain ${event.derivation.chainId}, coordinator ${event.projection.taskCoordinator})`,
      );
    }
  };

  return async (event, role) => {
    if (role === 'submission' && 'taskId' in event.facts) {
      assertCanonical(event, role);
      const bytes = await resolveAssociation({
        chainId: chain.chainId,
        coordinator: chain.taskCoordinator,
        taskId: event.facts.taskId,
        taskDigest: event.projection.taskDigest,
      });
      if (bytes !== undefined) return { kind: RECORD_KINDS.submission, bytes };
      throw new NativeAnnouncementRecordError(
        role,
        'no canonical requester association is held for this task',
      );
    }
    if (role === 'delivery' || role === 'evaluation-delivery') {
      assertCanonical(event, role);
      const anchorDigest = deliveryAnchorDigest(event, role);
      if (anchorDigest !== undefined) {
        // REVISED (V4): the chain names the bytes. Content-addressed fetch off the serving plane.
        if (resolveRecordBytes === undefined) {
          throw new NativeAnnouncementRecordError(
            role,
            'no native record serving plane is wired into this composition',
            anchorDigest,
          );
        }
        const bytes = await resolveRecordBytes(anchorDigest);
        if (bytes === undefined) {
          throw new NativeAnnouncementRecordError(
            role,
            'no digest-verified bytes on this operator\'s serving plane or its configured peers',
            anchorDigest,
          );
        }
        // Second, independent check. `resolveRecordBytes` verifies too, but this resolver is the
        // party that names the anchor, so it does not delegate the last line of defense.
        if (documentDigest(bytes) !== anchorDigest) {
          throw new NativeAnnouncementRecordError(
            role,
            'resolved bytes do not re-derive to the on-chain anchor',
            anchorDigest,
          );
        }
        return { kind: RECORD_KINDS.delivery, bytes };
      }
      if (event.derivation.contractGeneration === 'revised') {
        // A revised claim MUST carry its anchor; `deliveryAnchorDigest` also rejects a zero or
        // malformed one. Falling through to the engagement-keyed leg here would silently weaken
        // the stronger generation, so this refuses instead.
        throw new NativeAnnouncementRecordError(
          role,
          `${event.event} is a revised-generation claim with no usable delivery anchor`,
        );
      }
      return todayDeliveryMaterial(event, role, ownRecords, chain, resolveCounterpartyDelivery);
    }
    throw new NativeAnnouncementRecordError(
      role,
      'no production implementation for this role on the native path',
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

/**
 * Defect #48, Gate A: the REQUESTER's half of `resolveDispatchContext`.
 *
 * The engagement-ledger resolver above is a CLAIMANT's resolver — its row exists because
 * `work-loop.ts` claimed, and only a claiming operator ever writes one. A requester holds no such
 * row for a task another operator claimed, so `TaskAttemptCreated` dropped for want of a document
 * the requester can never have sealed, `attempt-engaged` was never emitted, and every
 * `adoptPostedTask` on that task threw `attempt-not-found` (`projector-observe.ts`'s precondition,
 * which the ruling deliberately keeps).
 *
 * This does not fabricate the missing seal, and it does not relax the precondition. The
 * dispatch-context document is `{ taskDigest, submission, nonce, attempt }`
 * (`packages/marketplace/binding/src/claim.ts`), and a requester holds a verified provenance for
 * every one of those four fields:
 *
 *   - `taskDigest` — the coordinator's own `getTask(taskId).taskCidDigest` anchor, read back here
 *     (the #2638 pattern) and independently re-derived from the fetched Task bytes downstream.
 *   - `submission` / `nonce` — the SIGNED Submission this requester posted, resolved through the
 *     same native association resolver `resolveSubmissionBytes` already uses. That resolver admits
 *     bytes only when the local association matches `(chainId, coordinator, taskId, taskDigest)`
 *     exactly, every stored record digest re-derives, and the requester DSSE envelope verifies.
 *   - `attempt` — `deriveMarketplaceAttemptUri` over the on-chain `(chainId, coordinator, taskId,
 *     attemptIndex)` tuple carried by the event being enriched.
 *
 * Because the document and its canonicalization are identical to the claimant's, the digest this
 * DERIVES is bit-for-bit the digest the solver SEALED. It is a re-derivation of a known document,
 * not a new assertion — which is exactly why it is admissible where a fabrication would not be.
 *
 * THE ROLE DISCRIMINATOR IS POSITIVE, NEVER "no seal found". A ledger row is consulted first and
 * always wins, so a claiming operator keeps the sealed descriptor. This leg then requires the
 * native association to resolve, which is possible only for a task THIS operator posted and holds
 * the sealed Submission for. An operator that is neither claimant nor poster resolves neither leg
 * and the event still drops, exactly as before.
 *
 * Exported so `client/test/daemon/*` can drive this exact production resolver.
 */
export function buildDerivedRequesterDispatchContextPort(input: {
  readonly resolveSubmissionBytes: ProjectorEnrichPorts['resolveSubmissionBytes'];
  readonly readOnChainTaskDigest: OnChainTaskDigestReader;
  readonly generation: ContractGeneration;
}): ProjectorEnrichPorts['resolveDispatchContext'] {
  return async ({ chainId, taskCoordinator, taskId, attemptIndex }) => {
    // A task-level event (`TaskCreated`, `TaskClosed`, …) precedes any attempt, so there is no
    // attempt to name. `createProjectorEnrich` gives those an explicitly unengaged descriptor.
    if (attemptIndex === undefined) return undefined;
    const taskDigest = await input.readOnChainTaskDigest(taskId);
    // No descriptor without an anchor, whichever way the read came back — the caller's own
    // fallback is a drop either way, so #2647's failure/absence split changes nothing here.
    if (taskDigest === undefined || taskDigest === 'unavailable') return undefined;
    const submissionBytes = await input.resolveSubmissionBytes({
      chainId,
      taskCoordinator,
      taskId,
      generation: input.generation,
      taskDigest,
    });
    if (submissionBytes === undefined) return undefined;
    let submission: { readonly submission: string; readonly nonce: string };
    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(submissionBytes));
      const candidate = SubmissionRecordSchema.safeParse(parsed);
      if (!candidate.success) return undefined;
      submission = { submission: candidate.data.submission, nonce: candidate.data.nonce };
    } catch {
      return undefined;
    }
    const attempt = deriveMarketplaceAttemptUri({
      chainId,
      coordinator: taskCoordinator,
      taskId,
      attemptIndex,
    });
    const dispatchContext = {
      taskDigest,
      submission: submission.submission,
      nonce: submission.nonce,
      attempt,
    };
    const digest = documentDigest(
      serializeCanonicalJson(dispatchContext as unknown as JsonValue),
    );
    return {
      uri: `urn:jinn:marketplace:dispatch-context:${attempt}`,
      digest: { sha256: digest.slice('sha256:'.length) },
    };
  };
}

/**
 * The canonical Task-anchor read, as {@link buildReadOnChainTaskDigest} produces it: the digest,
 * `undefined` for a genuine absence, or `'unavailable'` when the read itself failed (#2647).
 */
export type OnChainTaskDigestReader = (taskId: bigint) => Promise<`sha256:${string}` | 'unavailable' | undefined>;

/**
 * How many record-plane content addresses one requester-side delivery resolution will try before
 * giving up. Bounded because the catalog grows without limit while the answer is almost always the
 * newest entry; an exhausted scan leaves the requester without a witness, which `enrich` turns into
 * a drop so the next replay can try again.
 */
const RECORD_PLANE_CANDIDATE_LIMIT = 256;

/** Facts derived from one record-plane candidate's exact bytes. Permanent for its content address. */
type InspectedCandidate = { readonly keccak: Hex; readonly attempt: string; readonly task: string };

/**
 * Fetch-and-derive over one record-plane content address, shared by the two resolvers that scan the
 * catalog: {@link buildRecordPlaneSolutionDeliveryPort} (the ENRICH/adoption side, defect #48) and
 * {@link buildRecordPlaneCounterpartyDeliveryResolver} (the ANNOUNCE side). One implementation
 * because the rule it encodes is subtle and belongs in exactly one place:
 *
 * ONLY PERMANENT facts are memoized. A content address is immutable, so "these exact bytes are not
 * a canonical `DeliveryRecord`" holds for the life of the process and is safe to cache. A fetch
 * that threw or missed is a NETWORK fact wearing a content fact's clothes: caching it would freeze
 * one momentary serving-plane outage into a permanent verdict for this digest, and every later
 * replay inside the same process — the very rewind that recovers from a drop — would re-read the
 * cached miss instead of the record that is now being served.
 *
 * Each built inspector owns its own cache, so the two resolvers never share a verdict.
 */
function buildRecordPlaneCandidateInspector(input: {
  readonly fetchDeliveryBytes: (digest: `sha256:${string}`) => Promise<Uint8Array | undefined>;
  readonly logger?: { warn(message: string): void };
}): (digest: `sha256:${string}`) => Promise<InspectedCandidate | 'not-a-delivery' | 'unavailable'> {
  const inspected = new Map<string, InspectedCandidate | 'not-a-delivery'>();
  return async (digest) => {
    const cached = inspected.get(digest);
    if (cached !== undefined) return cached;
    let bytes: Uint8Array | undefined;
    try {
      bytes = await input.fetchDeliveryBytes(digest);
    } catch (error) {
      input.logger?.warn(
        `[record-plane-delivery] fetch failed for candidate ${digest} `
          + `(${error instanceof Error ? error.message : String(error)}) -- transient, not memoized`,
      );
      return 'unavailable';
    }
    if (bytes === undefined) return 'unavailable';
    let derived: InspectedCandidate | 'not-a-delivery' = 'not-a-delivery';
    try {
      const document: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const parsed = DeliveryRecordSchema.safeParse(document);
      if (parsed.success) {
        derived = {
          keccak: keccakEvidenceHash(bytes),
          attempt: parsed.data.attempt,
          task: parsed.data.task,
        };
      }
    } catch {
      derived = 'not-a-delivery';
    }
    inspected.set(digest, derived);
    return derived;
  };
}

/**
 * The requester's ANNOUNCE-side counterparty solution-delivery resolver — the #2644 parity gap.
 *
 * PR #2644 gave the enrich/observe path and the adoption port the ability to resolve a Delivery
 * another operator produced: read the coordinator's own anchor, enumerate the record-plane catalog,
 * and keep only the candidate whose bytes re-derive to that anchor. The announce path never got it.
 * Its today leg keys `ownRecords` — this operator's OWN durable solver store — so a requester
 * publishing announcements for a counterparty's settled delivery threw
 * `…holds no single durable solution-delivery record`, and (before the per-record isolation in
 * `announce.ts`) took every other announcement in the tick down with it.
 *
 * The gates are the CONTENT half of {@link buildRecordPlaneSolutionDeliveryPort}'s four, and no
 * weaker. The ROLE half is deliberately absent: reaching here already means this operator's own
 * durable store held nothing for the engagement, and bytes that hash to the coordinator's anchor
 * for this exact attempt are the right bytes whoever produced them. Concretely:
 *
 *   1. `readTodayDeliveryFacts(requestId)` must resolve to exactly this `(taskId, attemptIndex)`
 *      with a non-zero anchor — binding the requestId the event carries to the attempt.
 *   2. A candidate's bytes must re-derive to its content address (the transport enforces this),
 *      keccak-hash to that anchor, parse as a canonical `DeliveryRecord`, and name this exact
 *      Attempt URI and Task digest.
 *
 * `undefined` on every failure, never a throw: the caller ({@link todayDeliveryMaterial}) owns the
 * refusal, so one named `NativeAnnouncementRecordError` covers both the own-store miss and this.
 * Fail-closed is unchanged — an unresolvable record still yields NO announcement.
 *
 * Exported so `client/test/daemon/*` can drive this exact production resolver.
 */
export function buildRecordPlaneCounterpartyDeliveryResolver(input: {
  readonly readTodayDeliveryFacts: ProjectorEnrichPorts['readTodayDeliveryFacts'];
  readonly fetchDeliveryBytes: (digest: `sha256:${string}`) => Promise<Uint8Array | undefined>;
  readonly listRecordPlaneDigests: (limit: number) => readonly `sha256:${string}`[];
  readonly candidateLimit?: number;
  readonly logger?: { warn(message: string): void };
}): NativeCounterpartySolutionDeliveryResolver {
  const limit = input.candidateLimit ?? RECORD_PLANE_CANDIDATE_LIMIT;
  const inspect = buildRecordPlaneCandidateInspector({
    fetchDeliveryBytes: input.fetchDeliveryBytes,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });

  return async ({ chainId, coordinator, taskId, attemptIndex, requestId, taskDigest }) => {
    // Gate 1 — the on-chain request reference, and the anchor it points at.
    const facts = await input.readTodayDeliveryFacts(requestId);
    if (facts === 'unavailable') {
      // #2647's split reaches here too, but the announce leg has no role to protect and no drop to
      // reclassify: `todayDeliveryMaterial` turns every miss into the same bounded refusal either
      // way. What it CAN do is stop the operator debugging the wrong plane — the refusal message
      // downstream says "no record-plane candidate re-derives to the anchor", which is not what
      // happened when the anchor was never read.
      input.logger?.warn(
        `[record-plane-delivery] on-chain delivery facts for requestId ${requestId} unavailable `
          + `(the request-reference read failed) -- refusing the counterparty announce leg for `
          + `task ${taskId} attempt ${attemptIndex}; the record plane was never consulted`,
      );
      return undefined;
    }
    if (
      facts === undefined
      || facts.taskId !== taskId
      || facts.attemptIndex !== attemptIndex
      || !/^0x[0-9a-fA-F]{64}$/.test(facts.onChainKeccak)
      || /^0x0{64}$/iu.test(facts.onChainKeccak)
    ) return undefined;

    const attempt = deriveMarketplaceAttemptUri({ chainId, coordinator, taskId, attemptIndex });

    // Gate 2 — the record plane, newest first. Candidates are hints; the anchor decides.
    for (const digest of input.listRecordPlaneDigests(limit)) {
      // eslint-disable-next-line no-await-in-loop -- deliberately sequential: the common case
      // terminates on the first candidate, and a parallel fan-out would fetch the whole catalog.
      const candidate = await inspect(digest);
      if (candidate === 'unavailable' || candidate === 'not-a-delivery') continue;
      if (candidate.keccak.toLowerCase() !== facts.onChainKeccak.toLowerCase()) continue;
      if (candidate.attempt !== attempt || candidate.task !== taskDigest) {
        // Hashes to this attempt's on-chain anchor but describes a different Attempt/Task — a
        // contradiction the chain itself asserts against, never something to admit.
        input.logger?.warn(
          `[record-plane-delivery] ${digest} matches the on-chain anchor for attempt ${attempt} but `
            + `names attempt ${candidate.attempt} / task ${candidate.task} -- refusing`,
        );
        // Deliberately `continue` rather than `buildRecordPlaneSolutionDeliveryPort`'s (enrich's)
        // immediate `unwitnessed` return on the same collision: this resolver never settles a role
        // the way that leg's gate 3 does, so there is no "answer" to commit to yet. Either way is
        // inert under keccak collision resistance — no other candidate will hash to this exact
        // anchor for a genuinely different attempt.
        continue;
      }
      // Re-fetch the bytes the inspector deliberately did not retain (caching them would hold the
      // whole scanned catalog in memory). Content-addressed, so this returns the same bytes the
      // checks above passed or nothing at all — and both checks are re-run on the exact bytes
      // being returned, against the ON-CHAIN anchor rather than the cached derivation of it, so
      // this leg never trusts its own memo for the value that decides admission.
      // eslint-disable-next-line no-await-in-loop -- reached at most once, on the match.
      const bytes = await input.fetchDeliveryBytes(digest).catch(() => undefined);
      if (bytes === undefined) return undefined;
      if (
        documentDigest(bytes) !== digest
        || keccakEvidenceHash(bytes).toLowerCase() !== facts.onChainKeccak.toLowerCase()
      ) {
        return undefined;
      }
      return bytes;
    }
    return undefined;
  };
}

/**
 * Defect #48, Gate C: the REQUESTER's replacement for a Mech `Deliver` fact it can never hold.
 *
 * Today generation puts the delivered content's sha256 anchor in exactly one place — the Mech
 * `Deliver` event's `data`. The projector's log filter scans the router, the coordinator, and this
 * operator's OWN mech(es) (`projector-log-source.ts`), so a requester observing another operator's
 * `SolutionDeliveryClaimed` has no sha256 and no `pendingMechDeliveries` entry. The reducer read
 * that absence as `rejected`/`invalid-reference` — a false terminal for a delivery the coordinator
 * itself settled, which then folded the Attempt `contradictory` beside the verdict's terminal.
 *
 * What the requester DOES hold is the coordinator's own anchor:
 * `getAttempt(taskId, attemptIndex).solutionCidDigest` is keccak256 over the exact sealed Delivery
 * bytes (`packages/marketplace/venue-base/src/writers/settlement.ts` documents the misleading
 * field name), written by `TaskCoordinator.recordSubmission` from the digest the solver passed to
 * `JinnRouterV3.claimSolutionDelivery`. That anchor binds the bytes as tightly as the sha256 one
 * does — it just is not a content address, so it cannot be used to FETCH. This resolver therefore
 * enumerates the record-plane catalog for candidate content addresses and keeps the one whose
 * bytes hash to that anchor. Every candidate is untrusted: the catalog only decides what to try.
 *
 * FOUR GATES, split into a ROLE half and a CONTENT half — and the split is load-bearing:
 *
 * ROLE (gates 3, the anchor read, and 2 — in that order, see below). Failing any of them returns
 * `undefined`, meaning "this operator is not the requester for this attempt": the reducer's
 * mech-fact logic decides, exactly as it did before #48.
 *   3. Not the claimant — an engagement-ledger row naming this exact attempt means this operator
 *      claimed it, i.e. it is the SOLVER and does subscribe to the delivering mech. The
 *      mech-fact requirement is preserved untouched for that case; this resolver refuses. FIRST,
 *      because it is free and because everything after it reads the chain.
 *   2. Requester role — the native association resolver must produce this operator's own signed
 *      Submission for `(chainId, coordinator, taskId, on-chain taskDigest)`. Positive evidence
 *      that this operator POSTED the task, not an inference from a missing seal. Purely local: the
 *      association and its records are on this operator's own disk, so this is a durable fact about
 *      role, never a network outcome. THE ROLE SETTLES HERE.
 *
 * CONTENT (gates 1 and 4). Reached only once the role is settled as REQUESTER, so their failures
 * are reported as `{ role: 'requester', witness: undefined }`, never as the same `undefined` the
 * role gates return.
 *   1. On-chain identity — `readTodayDeliveryFacts(requestId)` must resolve to exactly this
 *      `(taskId, attemptIndex)`, and its anchor must be non-zero. This binds the requestId the
 *      event carries to the attempt the record will be recorded against.
 *   4. The fetched bytes must re-derive to the candidate digest (the transport already enforces
 *      this), hash to the on-chain keccak anchor, parse as a canonical `DeliveryRecord`, and name
 *      this exact Attempt URI and Task digest.
 *
 * GATE 1 IS DELIBERATELY LAST AMONG THE FOUR (#2647), and that ordering is the fix, not a
 * micro-optimization. It is a chain read; the #48 fix ran it first, so a 503 on `getRequestRef`
 * came back as the not-the-requester `undefined` before this operator had established it WAS the
 * requester. `readOnChainTaskDigest` memoizes its successes for the process, so once an earlier
 * event in the same replay warmed the anchor the Submission still resolved locally, the event
 * still reached the reducer, and the reducer still emitted the permanent false rejection — the one
 * path #2644's split did not cover. With the role settled first, the same 503 is a drop.
 *
 * The anchor read that gate 2 depends on runs BEFORE the role is known and can fail the same way.
 * It cannot claim a role it has not established, so it answers `{ role: 'undetermined', witness:
 * undefined }` — a drop for the same reason, and safe because gate 3 has already ruled this
 * operator out as the solver by then. A genuine absence there (unknown task, all-zero record)
 * stays the plain `undefined` miss it always was.
 *
 * Collapsing role and content into one `undefined` was the #48 fix's own defect: a momentary
 * serving-plane outage during gate 4 read as "not the requester", the reducer emitted
 * `rejected`/`invalid-reference`, and that terminal — permanent, and `contradictory` beside the
 * verdict's — wedged `adoptPostedTask` forever. A requester that cannot witness must not emit a
 * rejection; `enrich` drops the event instead, and a later replay re-offers it.
 *
 * The reducer re-checks gate 4's keccak leg itself, so a bug here cannot admit a wrong record.
 *
 * Exported so `client/test/daemon/*` can drive this exact production resolver.
 */
export function buildRecordPlaneSolutionDeliveryPort(input: {
  readonly resolveSubmissionBytes: ProjectorEnrichPorts['resolveSubmissionBytes'];
  readonly readOnChainTaskDigest: OnChainTaskDigestReader;
  readonly readTodayDeliveryFacts: ProjectorEnrichPorts['readTodayDeliveryFacts'];
  readonly fetchDeliveryBytes: (digest: `sha256:${string}`) => Promise<Uint8Array | undefined>;
  readonly listRecordPlaneDigests: (limit: number) => readonly `sha256:${string}`[];
  readonly engagementLedger: Pick<EngagementLedger, 'get'>;
  readonly candidateLimit?: number;
  readonly logger?: { warn(message: string): void };
}): NonNullable<ProjectorEnrichPorts['resolveRecordPlaneDelivery']> {
  const limit = input.candidateLimit ?? RECORD_PLANE_CANDIDATE_LIMIT;
  // Shared with the announce-side resolver; see `buildRecordPlaneCandidateInspector` for the
  // permanent-vs-transient memoization rule this leg depends on.
  const inspect = buildRecordPlaneCandidateInspector({
    fetchDeliveryBytes: input.fetchDeliveryBytes,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });

  return async ({ chainId, taskCoordinator, taskId, attemptIndex, requestId }) => {
    const attempt = deriveMarketplaceAttemptUri({
      chainId,
      coordinator: taskCoordinator,
      taskId,
      attemptIndex,
    });

    // ---- ROLE half. Every exit below is `undefined` = "not the requester", EXCEPT the one read
    // failure that leaves the role genuinely unknown. ----

    // Gate 3 — this operator claimed the attempt, so it IS the solver and does witness the mech.
    // First because it is the only gate that costs nothing: a solver settling its own delivery
    // (the overwhelmingly common reason this resolver is reached at all) must not pay a chain read
    // per settlement to be told it is not the requester — and, since #2647, must never be exposed
    // to a chain read whose failure would drop its own settlement.
    const row = input.engagementLedger.get(`${chainId}:${taskCoordinator}:${taskId.toString()}`);
    if (row?.attemptUri === attempt) return undefined;

    // The anchor gate 2 keys its association on. Reached only for a non-claimant, so the role is
    // still open: a failed read here is `undetermined`, not "not the requester" (#2647). A genuine
    // absence stays the miss it always was — an unknown task is not this operator's to witness.
    const taskDigest = await input.readOnChainTaskDigest(taskId);
    if (taskDigest === 'unavailable') {
      input.logger?.warn(
        `[record-plane-delivery] on-chain Task anchor for task ${taskId} unavailable -- role `
          + `undetermined for attempt ${attempt}, dropping rather than reporting not-the-requester`,
      );
      return {
        role: 'undetermined',
        witness: undefined,
        reason: `the on-chain Task anchor read for task ${taskId} is unavailable, so this `
          + 'operator cannot establish whether it is the requester',
      };
    }
    if (taskDigest === undefined) return undefined;

    // Gate 2 — positive proof this operator posted the task. `generation` is pinned to `today`
    // rather than threaded: `enrich` reaches this resolver only for a `SolutionDeliveryClaimed`
    // with no `deliveryDigest` on its facts, which is today generation by definition.
    const submissionBytes = await input.resolveSubmissionBytes({
      chainId,
      taskCoordinator,
      taskId,
      generation: 'today',
      taskDigest,
    });
    if (submissionBytes === undefined) return undefined;

    // ---- The role is now settled: this operator IS the requester for this attempt. Every exit
    // below therefore says so, whatever happens to the content or to the chain. It never returns
    // `undefined` again, because `undefined` means "not the requester" and would send the reducer
    // down the mech-fact path this operator can never satisfy. ----
    const unwitnessed = (reason: string, onChainKeccak?: Hex): RecordPlaneDeliveryResolution => ({
      role: 'requester',
      witness: undefined,
      ...(onChainKeccak === undefined ? {} : { onChainKeccak }),
      reason,
    });

    // Gate 1 — the on-chain request reference, and the anchor it points at. LAST among the role/
    // identity reads, because it is the chain read whose failure used to masquerade as
    // not-the-requester (#2647). Three distinct answers, all of them drops now that the role is
    // known, and none of them ever a rejection.
    const facts = await input.readTodayDeliveryFacts(requestId);
    if (facts === 'unavailable') {
      // Transport. Says nothing about the attempt; the next replay asks again.
      return unwitnessed(
        `the on-chain delivery facts for requestId ${requestId} are unavailable (the `
          + 'request-reference read failed)',
      );
    }
    if (facts === undefined) {
      // Absence, and a surprising one: gate 2 just proved this operator posted the task, yet the
      // coordinator has no reference for the requestId its own event carried. A read racing ahead
      // of a reorged-out block is the benign explanation and resolves itself on the next replay;
      // a persistent one means the wrong coordinator address. Either way there is no witness to
      // find and no basis to reject.
      return unwitnessed(
        `the coordinator holds no solution OR verdict request reference for requestId ${requestId}`,
      );
    }
    if (
      facts.taskId !== taskId
      || facts.attemptIndex !== attemptIndex
      || !/^0x[0-9a-fA-F]{64}$/.test(facts.onChainKeccak)
      || /^0x0{64}$/i.test(facts.onChainKeccak)
    ) {
      // The reference resolved but does not bind to this attempt, or carries no anchor yet. A
      // contradiction with the event, not a role signal.
      return unwitnessed(
        `requestId ${requestId} references task ${facts.taskId} attempt ${facts.attemptIndex} `
          + `anchor ${facts.onChainKeccak}, not task ${taskId} attempt ${attemptIndex}`,
      );
    }

    // Gate 4 — the record plane, newest first.
    let scanned = 0;
    let unavailable = 0;
    for (const digest of input.listRecordPlaneDigests(limit)) {
      scanned += 1;
      // eslint-disable-next-line no-await-in-loop -- deliberately sequential: the common case
      // terminates on the first candidate, and a parallel fan-out would fetch the whole catalog.
      const candidate = await inspect(digest);
      if (candidate === 'unavailable') {
        // The catalog names it but the plane would not serve it. Transient by construction — the
        // one shape that USED to read as "not the requester" and produce the permanent false
        // rejection this split exists to prevent.
        unavailable += 1;
        continue;
      }
      if (candidate === 'not-a-delivery') continue;
      if (candidate.keccak.toLowerCase() !== facts.onChainKeccak.toLowerCase()) continue;
      if (candidate.attempt !== attempt || candidate.task !== taskDigest) {
        // The bytes hash to this attempt's on-chain anchor but describe a different Attempt/Task.
        // That is a contradiction the chain itself asserts against, never something to admit. Still
        // reported as the requester with no witness: this operator is no more able to witness the
        // mech here than anywhere else, so the answer is a drop, not a rejection.
        input.logger?.warn(
          `[record-plane-delivery] ${digest} matches the on-chain anchor for attempt ${attempt} but `
            + `names attempt ${candidate.attempt} / task ${candidate.task} -- refusing`,
        );
        return unwitnessed(
          `candidate ${digest} hashes to the anchor but names attempt ${candidate.attempt} / `
            + `task ${candidate.task}`,
          facts.onChainKeccak,
        );
      }
      return {
        role: 'requester',
        witness: {
          sha256Digest: digest,
          keccakEvidenceHash: candidate.keccak,
          onChainKeccak: facts.onChainKeccak,
        },
      };
    }
    return unwitnessed(
      `no record-plane candidate hashes to the anchor (scanned ${scanned} of at most ${limit}, `
        + `${unavailable} unfetchable)`,
      facts.onChainKeccak,
    );
  };
}

/** New gap (b, file header): no Phase-B binding-resolver backing stores exist to verify a
 * Result Evaluation Statement's decision-grade gate for real. Loudly refuses rather than
 * fabricating a "verified" (or silently empty) result — `projectAnnouncements` turns this throw
 * into a fail-closed refusal, never a silent pass. */
function refuseLegacyVerdictObservation(): never {
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
  readonly nativeProjectorPorts?: NativeProjectorExactPorts;
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
  /** Canonical settlement/evaluation readers consume the same projector-owned checkpoint. */
  readonly readFinalizedBlockNumber: () => bigint;
  readonly readCanonicalBlockHash: (blockNumber: bigint) => Promise<Hex | undefined>;
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
  const readOnChainTaskDigest = buildReadOnChainTaskDigest(input.publicClient, input.chain.taskCoordinator);
  const resolveSubmissionBytes: ProjectorEnrichPorts['resolveSubmissionBytes'] = input.mode === 'native'
    ? async ({ chainId, taskCoordinator, taskId, taskDigest }) => {
      if (resolveAssociation === undefined) return undefined;
      // `taskDigest` is present only for `TaskCreated`, which carries the anchor in its own facts.
      // Every other class (`Deliver`, `SolutionDeliveryClaimed`, `VerdictDeliveryClaimed`, the
      // attempt events) arrives without it, and refusing on absence dropped 100% of them — the
      // reason `projector_observations` stayed empty through the whole of round 28 and the verdict
      // announcement never projected (defect #47). Read the same anchor back off the coordinator.
      const anchor = taskDigest ?? await readOnChainTaskDigest(taskId);
      if (anchor === undefined || anchor === 'unavailable') return undefined;
      return resolveAssociation({ chainId, coordinator: taskCoordinator, taskId, taskDigest: anchor });
    }
    : buildResolveSubmissionBytes({
      publicClient: input.publicClient,
      jinnRouter: input.chain.jinnRouter,
      fetchIpfsBytes,
    });
  const sealedDispatchContext = buildEngagementLedgerDispatchContextPort(input.engagementLedger);
  // Defect #48, Gate A. The claim-time SEAL is always preferred; the requester derivation is a
  // strict fallback for the case it cannot cover — a task this operator posted and another
  // operator claimed. Native only: the legacy composition has no association store to prove
  // authorship with, so it keeps exactly its prior behavior (seal or drop).
  const derivedRequesterDispatchContext = input.mode === 'native'
    ? buildDerivedRequesterDispatchContextPort({
      resolveSubmissionBytes,
      readOnChainTaskDigest,
      generation: input.chain.generation,
    })
    : undefined;
  const resolveDispatchContext: ProjectorEnrichPorts['resolveDispatchContext'] = async (lookup) => {
    const sealed = await sealedDispatchContext(lookup);
    if (sealed !== undefined) return sealed;
    return derivedRequesterDispatchContext?.(lookup);
  };
  // HTTP-first delivery resolution for native mode (the record-source serving plane), IPFS gateway
  // after it. Native deliveries are HTTP-served and may never reach the gateway, so an IPFS-only
  // resolver leaves the today-mode delivery correspondence CP7 adopt reads permanently null. Legacy
  // mode has no record source, so it stays on the IPFS-only path.
  const resolveDeliveryBytes = input.nativeProjectorPorts?.resolveDeliveryBytes;
  const fetchDeliveryBytes: ProjectorEnrichPorts['fetchDeliveryBytes'] = resolveDeliveryBytes === undefined
    ? undefined
    : async (digest) => (await resolveDeliveryBytes(digest)) ?? fetchIpfsBytes(digest);
  // The Task document is on exactly the same serving plane as the delivery records (the requester
  // publishes it there), and equally may never reach the IPFS gateway. Without this the digest
  // join's second leg — `resolveTaskProjection`'s fetch of the Task content — misses for every
  // native task and drops the event even after its Submission resolves (defect #47, the
  // #23/#2559/#2561 class). Same resolver, same origins, same digest re-derivation by the caller.
  const fetchTaskBytes: ProjectorEnrichPorts['fetchTaskBytes'] = resolveDeliveryBytes === undefined
    ? undefined
    : async (digest) => (await resolveDeliveryBytes(digest)) ?? fetchIpfsBytes(digest);
  const readTodayDeliveryFacts = buildReadTodayDeliveryFacts(input.publicClient, input.chain.taskCoordinator);
  // Defect #48, Gate C. Native only, and only when the fleet supplied a record-plane catalog:
  // without one there is nothing to key a content-addressed fetch off, and the reducer's
  // mech-fact requirement remains the whole behavior.
  const listRecordPlaneDigests = input.nativeProjectorPorts?.listRecordPlaneDigests;
  const resolveRecordPlaneDelivery: ProjectorEnrichPorts['resolveRecordPlaneDelivery'] | undefined =
    input.mode === 'native' && listRecordPlaneDigests !== undefined && fetchDeliveryBytes !== undefined
      ? buildRecordPlaneSolutionDeliveryPort({
        resolveSubmissionBytes,
        readOnChainTaskDigest,
        readTodayDeliveryFacts,
        fetchDeliveryBytes,
        listRecordPlaneDigests,
        engagementLedger: input.engagementLedger,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      })
      : undefined;
  const enrich = createProjectorEnrich({
    chain: input.chain,
    publicClient: input.publicClient,
    fetchIpfsBytes,
    resolveSubmissionBytes,
    resolveDispatchContext,
    readTodayDeliveryFacts,
    allowLegacySignedTaskV1: input.mode === 'legacy',
    ...(fetchDeliveryBytes === undefined ? {} : { fetchDeliveryBytes }),
    ...(fetchTaskBytes === undefined ? {} : { fetchTaskBytes }),
    ...(resolveRecordPlaneDelivery === undefined ? {} : { resolveRecordPlaneDelivery }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });

  const pageCountKey = `projector-page-count:${cursorKey}`;
  const ports: ProjectorPortsInput = {
    source: { agent: `urn:jinn:operator:${input.mechAddress.toLowerCase()}`, name: 'operator-projector' },
    signer: input.discoverySigner,
    archiveRoot: input.archiveRoot,
    resolveRecord: input.mode === 'native'
      ? input.nativeProjectorPorts!.resolveRecord
      : buildResolveRecord(resolveSubmissionBytes, input.chain),
    verifyVerdictObservation: input.mode === 'native'
      ? input.nativeProjectorPorts!.verifyVerdictObservation
      : refuseLegacyVerdictObservation,
    referencedBytes: { fetch: fetchIpfsBytes },
    readPageCount: () => Number.parseInt(input.store.getConfigValue(pageCountKey) ?? '0', 10),
    writePageCount: (count) => input.store.setConfigValue(pageCountKey, String(count)),
  };

  const readCanonicalBlockHash = createCanonicalBlockHashReader(input.publicClient);
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
    readCanonicalBlockHash,
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
    readFinalizedBlockNumber: () => cursorStore.read()?.finalizedBlockNumber ?? 0n,
    readCanonicalBlockHash,
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
  if (input.mode === 'legacy' && input.nativeClaimRuntime !== undefined) {
    throw new Error('legacy operator composition must not receive native claim runtime ports');
  }
  if (input.mode === 'native' && input.legacyBridgeSigner !== undefined) {
    throw new Error('native operator composition must not receive a legacy bridge signer');
  }
  if (input.mode === 'native' && input.legacyDeliverySigningKey !== undefined) {
    throw new Error('native operator composition must not receive a legacy delivery signing key');
  }
  if (input.mode === 'native' && input.nativeClaimRuntime === undefined) {
    throw new Error('native operator boot requires durable claim state, exact-document, canonical-reader, policy, and lease ports');
  }
  if (input.mode === 'legacy' && input.nativeProjectorPorts !== undefined) {
    throw new Error('legacy operator composition must not receive native projector ports');
  }
  if (input.mode === 'native' && identities!.agent !== input.nativeClaimRuntime!.operatorAgent) {
    throw new Error('native claim operator agent must equal the agent used for role trust bindings');
  }
  if (
    input.mode === 'native'
    && (
      input.nativeClaimRuntime!.policy.chainId !== input.chain.chainId
      || input.nativeClaimRuntime!.policy.coordinator.toLowerCase() !== input.chain.taskCoordinator.toLowerCase()
      || input.nativeClaimRuntime!.policy.generation !== input.chain.generation
    )
  ) throw new Error('native claim policy network identity must equal the composed venue identity');
  if (input.mode === 'native') assertNativeProjectorExactPorts(input.nativeProjectorPorts);
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
    ...(input.venueLogSource === undefined ? {} : { logSource: input.venueLogSource }),
  });

  // Issue #525/#562/#897 (funds-correctness): install this composition's venue lock as the
  // process-wide default for `client/src/tx-retry.ts`'s `withEoaBroadcastLock` /
  // `withNonceLedger` — the EOA-direct broadcast path (IdentityPublisher.setMetadata,
  // eviction-recovery reStake, ValidationRegistry/ReputationRegistry writes, `executeSafeTxBatch`
  // /`executeSafeTxDirect`). Without this, that path only ever serialized against ITSELF (an
  // in-process `Map`), never against `venue.safe`'s own durable, cross-process SQLite lock — so a
  // venue-base Safe broadcast and a same-EOA `setMetadata` could still both read the same
  // `pending` nonce and collide. Bound to this composition's one `chainId`; a daemon process
  // only ever composes one chain, so this closure is exact, not an approximation.
  //
  // D0a round-1 review: keyed by chainId + state path so a SECOND composition in the same
  // process (e2e harness, multi-daemon tests) cannot silently steal this global out from under
  // this one — `setDefaultEoaBroadcastLock` throws on a conflicting key instead.
  //
  // D0a round-2 critical fix: that throw made the legitimate "two venues in one process" topology
  // (the exact one round-1 named) impossible to compose at all — see `installDefaultEoaBroadcastLock`'s
  // doc above. A host that already knows it is composing more than one venue in this process opts
  // subsequent compositions out explicitly instead of hitting the throw.
  if (input.installDefaultEoaBroadcastLock ?? true) {
    setDefaultEoaBroadcastLock(
      { withSender: (sender, fn) => venue.broadcastLock.withSender(input.chain.chainId, sender, fn) },
      `${input.chain.chainId}:${input.venueStateDbPath}`,
    );
  }

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
  // One-swap M3 (#2461): the fleet path's marketplace-event read model, fed off the projector's
  // own batches rather than a second poller on the same single-consumer cursor. See
  // `teeNativeMarketplaceEvents`.
  const nativeMarketplaceEvents = input.mode === 'native'
    ? new NativeMarketplaceEventRepository(input.store)
    : undefined;
  projectorParts = buildProjector({
    mode: input.mode,
    chain: input.chain,
    publicClient: input.publicClient,
    mechAddress: input.mechAddress,
    logSource: nativeMarketplaceEvents === undefined ? venue.logSource : teeNativeMarketplaceEvents({
      source: venue.logSource,
      repository: nativeMarketplaceEvents,
      chain: input.chain,
      isAuthorizedMechOrigin: (address: Address) =>
        address.toLowerCase() === input.mechAddress.toLowerCase(),
      // The tee never rethrows into the projector; without a logger here its named failure event
      // would go to `console.warn` instead of this composition's own log stream.
      ...(input.logger === undefined ? {} : { logger: input.logger }),
    }),
    archiveRoot: join(dirname(input.venueStateDbPath), 'discovery-archive'),
    discoverySigner,
    ipfsGatewayUrl: config.ipfsGatewayUrl,
    store: input.store,
    pollIntervalMs: input.projectorPollIntervalMs ?? 5000,
    engagementLedger,
    ...(input.mode === 'native' ? { nativeProjectorPorts: input.nativeProjectorPorts } : {}),
    ...(input.mode === 'native' ? {
      nativeRequester: {
        stateDir: input.nativeRequesterStateDir ?? join(input.stateRoot, 'native-requester'),
        requesterSubmission: identities!.get('requester-submission'),
      },
    } : {}),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
  const {
    projector,
    claimGate,
    readObservations,
    readFinalizedBlockNumber,
    readCanonicalBlockHash,
  } = projectorParts;

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
  const launchers = buildLaunchers(wiring, input.mode);
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
  const readLegacySealedDocuments = async (card: AnnouncedSubmissionCard): Promise<SealedDocuments> => {
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
    throw new Error('legacy composition refuses a native card; use the required native exact-document resolver');
  };
  const readSealedDocuments = input.mode === 'native'
    ? input.nativeClaimRuntime!.exactDocuments
    : readLegacySealedDocuments;

  const nativeLauncherInspector = input.mode === 'native'
    ? buildNativeLauncherCapabilityPort(launchers, launcherDeployments)
    : undefined;
  const nativeClaimCoordinator = input.mode === 'native'
    ? new NativeClaimCoordinator({
        state: input.nativeClaimRuntime!.state,
        chain: input.chain,
        operatorAgent: input.nativeClaimRuntime!.operatorAgent,
        admission: {
          evaluate: async (queued, documents) => evaluateNativeClaim({
            card: queued.card,
            taskBytes: documents.taskBytes,
            submissionBytes: documents.submissionBytes,
            backend,
            launcher: nativeLauncherInspector!,
            policy: input.nativeClaimRuntime!.policy,
            activeEngagements: input.nativeClaimRuntime!.activeEngagements(),
            canonicalFinalized: await input.nativeClaimRuntime!.canonicalFinalized(queued.card),
            now: input.nativeClaimRuntime!.now?.() ?? new Date(),
          }),
        },
        claim: {
          priorityMech: venue.claim.priorityMech,
          broadcast: (claim) => venue.claim.claimTask({
            taskId: claim.taskId,
            priorityMech: claim.priorityMech,
            operationId: claim.operationId,
          }),
        },
        canonical: input.nativeClaimRuntime!.canonical,
        worker: input.nativeClaimRuntime!.worker,
      })
    : undefined;

  const nativeSolutionPublisher = input.mode === 'native'
    ? await openNativeSolutionPublisher({
        rootDir: input.nativeClaimRuntime!.solution.publisherRootDir,
        publicBaseUrl: input.nativeClaimRuntime!.solution.publicBaseUrl,
        source: { agent: identities!.agent, name: 'solver-records' },
        signer: identities!.get('solver-discovery'),
        settlementDeclarationKey: identities!.get('solver-settlement').keyId,
      })
    : undefined;
  const nativeSolutionCoordinator = input.mode === 'native'
    ? new NativeSolutionCoordinator({
        state: input.nativeClaimRuntime!.state,
        backend,
        documents: { resolve: input.nativeClaimRuntime!.solution.exactDocuments },
        deliverySignature: { get: (digest) => backend.getDeliverySignature(digest) },
        evidence: {
          awaitIndexed: evidence.ports.awaitIndexed,
          getRecord: (reference) => evidence.ports.repository.getRecord(reference),
        },
        verification: buildNativeSolutionVerification({
          identities: identities!,
          resolveEvaluationSpec: input.nativeClaimRuntime!.solution.resolveEvaluationSpec,
        }),
        publisher: nativeSolutionPublisher!,
        settlement: buildNativeSolutionSettlementPort({
          chain: input.chain,
          mechAddress: input.mechAddress,
          deliveryBroadcaster,
          settlement: venue.settlement,
          readObservations,
          readFinalizedBlockNumber,
          readCanonicalBlockHash,
          // #29: mirror `native-solver-production.ts` so the fleet settlement port resolves finality
          // chain-direct (projector as fallback). Without this a finalized delivery below this
          // operator's clean-break projector window settles as `broadcast` forever, holds its
          // `maxConcurrent` slot, and blocks every fresh claim with `capacity-policy`.
          canonicalReader: input.nativeClaimRuntime!.solution.solutionSettlementCanonical,
        }),
      })
    : undefined;

  // Finding E36 (ruled "build it"): the `ArchiveSubscription` `work-loop.ts`'s `WorkLoopConfig`
  // needs, fed from this SAME `readObservations` accessor `venue`'s `observations` port above
  // already reads (one `ProjectorCursorStore`, two consumers) — see `./archive-subscription.js`.
  const archive = input.mode === 'legacy'
    ? buildArchiveSubscription({
        readObservations,
        publicClient: input.publicClient,
        fetchIpfsBytes,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      })
    : undefined;

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
    ...(archive === undefined ? {} : { archive }),
    ...(nativeClaimCoordinator === undefined ? {} : {
      nativeClaimCoordinator,
      nativeSolutionCoordinator: nativeSolutionCoordinator!,
      nativeSolutionPublisher: nativeSolutionPublisher!,
      nativeSolutionCorrections: buildNativeSolutionCorrections({
        store: input.store,
        publisher: nativeSolutionPublisher!,
        marketplaceEvents: nativeMarketplaceEvents!,
      }),
      nativeOperatorState: input.nativeClaimRuntime!.state,
      nativeLauncherInspector: nativeLauncherInspector!,
    }),
    async close(): Promise<void> {
      try {
        await nativeSolutionPublisher?.close();
      } finally {
        try {
          await evidence.close();
        } finally {
          venue.close();
        }
      }
    },
  };
}
