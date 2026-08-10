/**
 * Native runtime assembly for the ONE multi-role fleet daemon (one-swap M2, umbrella #2461,
 * DR-2026-08-05).
 *
 * `main.ts` calls `resolveFleetCompositionMode` first and `buildFleetNativeRuntime` only when that
 * returns `'native'`. Everything here is dark until Wave 3's deploy PR sets `compositionMode`:
 * absent means legacy, and a legacy boot never imports this module.
 *
 * What this owns, and what it deliberately does not:
 *
 * - OWNS the inputs `composition-root.ts`'s `mode: 'native'` demands and cannot build itself —
 *   the merged `RoleIdentitySet`, the `NativeClaimRuntimeInput`, and `NativeProjectorExactPorts`.
 * - DOES NOT start a loop. M3 owns the WorkLoop port population, M4 the evaluator loop, M5 the
 *   posting path. Constructing the coordinators is `composition-root.ts`'s job; starting them is
 *   not M2's.
 * - DOES NOT open its own database. The load-bearing difference from `native-solver-production.ts`
 *   (which opens `stateDir/solver.sqlite`) is that native state here lives in the SHARED
 *   `Store(config.dbPath)` the legacy readers, the projector cursor and `task_runs` already use,
 *   because the R1 read-plane repoint needs the native tables where the API layer already looks.
 *   The caller passes that Store in; this module never constructs one.
 */
import { join } from 'node:path';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
// The LOCAL declaration, deliberately (M3 review note 7). The marketplace pipeline package exports
// a structurally identical `AnnouncedSubmissionCard`, but that package is confined to a frozen
// legacy-client inventory by `.github/scripts/phase-d-transition-deletion.test.mjs` — a plain
// source scan, so even naming it in a comment counts — and importing it here put this file outside
// that inventory, reddening the platform-architecture-control gate. The local declaration also
// carries `discovery?`, which is what `nativeDiscoveryDecodeProvedCanonical` reads, so it is the
// more exact type as well.
import type { AnnouncedSubmissionCard } from './native-submission-facts.js';
import {
  createNativeRequesterSubmissionResolver,
  type NativeAuthorityTimeAnchor,
  type NativeRequesterIdentity,
  type NativeRequesterRoles,
} from '../native-requester/requester.js';
import type { CanonicalTaskCreatedReader } from './native-fleet-requester-write.js';
import type { Store } from '../store/store.js';
import type { JinnConfig } from '../config.js';
import { buildNativeResolveRecord } from './composition-root.js';
import type { NativeClaimRuntimeInput } from './composition-root.js';
import {
  buildNativeClaimPolicy,
  buildNativeEvaluationSpecResolver,
  buildNativeExactDocuments,
  countActiveNativeEngagements,
  digest,
} from './native-assembly.js';
import {
  createBaseSepoliaAuthorityTime,
  createBaseSepoliaFinalizedAnchorClient,
  createBaseSepoliaRecordTransport,
  createSolverReads,
  createViemBaseSepoliaReadClients,
} from './native-base-sepolia-infrastructure.js';
import {
  buildFleetNativeDiscovery,
  nativeDiscoveryDecodeProvedCanonical,
} from './native-fleet-discovery.js';
import type { NativeDiscoveryConsumer } from './native-discovery.js';
import type { NativePublicRecordTransport } from './native-infrastructure-bundle.js';
import { NativeOperatorStateRepository } from './native-operator-state.js';
import type { NativeProjectorExactPorts } from './native-projector-ports.js';
import { openNativeTrustCatalog, type NativeTrustAuthority } from './native-trust-catalog.js';
import {
  RoleIdentitySet,
  openRoleIdentitySet,
  type NativeRoleIdentityRole,
} from './role-identities.js';

export class NativeFleetAssemblyError extends Error {
  override readonly name = 'NativeFleetAssemblyError';
}

/**
 * Escrow spend bound for an operator who configured no `claimPolicy.spendCapWei`.
 *
 * PERMISSIVE, not zero — the same convention `composition-root.ts`'s `buildOperatorCaps` states
 * for the legacy path (the F7-REVERSED no-claim-nothing ruling): "an unconfigured cap is
 * permissive, not zero, because the host's USD rolling-window gates remain the operative spend
 * bound." `'0'` is a DISTINCT, deliberate claim-nothing state that the operator app renders as
 * such, so translating absence into it would silently reclassify "I never set a cap" as "I refuse
 * every task".
 *
 * It matters here specifically: `evaluateNativeClaim` refuses on a zero `maxSpendWei` with reason
 * `spend-policy`, which would mask the `finality-policy` refusal M3's discovery decode is supposed
 * to surface — an operator debugging the swap would chase the wrong signal.
 *
 * `required()` is deliberately NOT used for this key either: demanding a cap from an operator who
 * never set one contradicts the same ruling.
 */
const PERMISSIVE_ESCROW_MAX_WEI = (2n ** 256n - 1n).toString();

/**
 * `claimPolicy.spendCapWei` -> the native claim policy's `escrowMaxWei`. Absent is permissive; a
 * configured value — INCLUDING `'0'` — flows through untouched. Exported so the distinction is
 * tested directly rather than only through a fully-assembled runtime.
 */
export function resolveFleetEscrowMaxWei(
  claimPolicy: JinnConfig['claimPolicy'],
): string {
  return claimPolicy?.spendCapWei ?? PERMISSIVE_ESCROW_MAX_WEI;
}

/**
 * The native composition needs role authority across two custody families: `solver-delivery` /
 * `solver-settlement` / `solver-discovery` for delivery signing, publication and settlement, and
 * `requester-submission` for the projector's requester-association resolver
 * (`composition-root.ts`, native branch of `buildProjector`). `identityStores` is keyed by family,
 * so this is two stores merged into one set — see `RoleIdentitySet.merge`.
 */
const FLEET_STORE_ROLES: Readonly<Record<'solver' | 'requester', readonly NativeRoleIdentityRole[]>> = {
  solver: ['solver-delivery', 'solver-settlement', 'solver-discovery'],
  // `requester-discovery` joins `requester-submission` (M5e): the requester WRITE path signs the
  // source announcement (discovery) as well as the Submission envelope. Provisioning both is a
  // deploy-time concern — the fleet is dark until Wave 3 sets `compositionMode`, so widening the
  // required requester roles now regresses no live operator.
  requester: ['requester-submission', 'requester-discovery'],
};

/**
 * The DEFAULT `verifyVerdictObservation`, and the fall-through the late-bound indirection keeps
 * until M4b's real adapter is installed.
 *
 * `projectorPorts.verifyVerdictObservation` is built here, BEFORE the evaluator composition exists
 * (`buildFleetNativeEvaluator` runs later in `main.ts`, and the durable evaluator `state` the real
 * adapter reads does not exist yet). So the runtime hands the projector a stable late-bound port
 * (`createLateBoundVerdictObservation`) whose slot defaults to this refuse and is REPLACED with the
 * real adapter once `state` exists. A verdict that reaches the projector before the evaluator is up
 * — or on a native-solver-only operator that runs no evaluator at all — still hits this default and
 * refuses loudly. `projectAnnouncements` turns the throw into a fail-CLOSED verdict refusal, so no
 * verdict is ever projected as "verified" on evidence this operator has not durably re-checked.
 */
export function refuseNativeVerdictObservation(): never {
  throw new NativeFleetAssemblyError(
    'verifyVerdictObservation has no production implementation on the native fleet path either: '
    + 'the real M4b adapter is not installed yet (a verdict reached the projector before the '
    + 'evaluator loop was up, or this operator runs no evaluator). Refusing fail-closed rather than '
    + 'projecting an unverified verdict (one-swap M2/M4b, #2461)',
  );
}

/**
 * A settable indirection for the projector's `verifyVerdictObservation` port (one-swap M4b, #2461).
 *
 * The projector captures `port` at composition-build time. `port` reads a mutable slot on every
 * call: until `install` runs it delegates to {@link refuseNativeVerdictObservation} (fail-closed);
 * after, it delegates to the real M4b adapter. Because the projector holds the stable `port`
 * closure and the slot is read per-call, a projector tick that fires between runtime-build and
 * evaluator-install refuses (the default) — it never crashes and never sees a half-built adapter.
 * `install` is one-shot: a second install throws, so a wiring bug that double-installs is loud.
 */
export interface LateBoundVerdictObservation {
  readonly port: NativeProjectorExactPorts['verifyVerdictObservation'];
  install(adapter: NativeProjectorExactPorts['verifyVerdictObservation']): void;
}

export function createLateBoundVerdictObservation(): LateBoundVerdictObservation {
  let installed: NativeProjectorExactPorts['verifyVerdictObservation'] | undefined;
  return {
    port: async (event, material) =>
      installed === undefined ? refuseNativeVerdictObservation() : installed(event, material),
    install(adapter) {
      if (installed !== undefined) {
        throw new NativeFleetAssemblyError(
          'native verdict-observation adapter is already installed; the late-bound gate is set exactly once',
        );
      }
      installed = adapter;
    },
  };
}

/**
 * Everything the fleet requester WRITE path (`buildFleetRequesterWrite`, one-swap M5e) needs that
 * this runtime can build BEFORE the composition venue exists — the role authority, the shared
 * authority-time and canonical reads, and the identity/location metadata. `main.ts` completes it
 * with the composition's ONE Safe broadcaster (`venue.safe`), the venue posting WAL/scope ports,
 * and the IPFS pin, then hands the assembled port to the posting loop.
 *
 * Present only when the operator provisioned requester admission custody
 * (`config.admissionAgent` + `config.identityStores.admission`); absent otherwise, in which case the
 * posting loop's `post` stays the M5d fail-closed seam.
 */
export interface FleetRequesterWriteAuthority {
  readonly requesterAgent: string;
  readonly admissionAgent: string;
  readonly publicBaseUrl: string;
  readonly requesterStateDir: string;
  readonly roles: NativeRequesterRoles;
  readonly authorityTime: () => Promise<NativeAuthorityTimeAnchor>;
  readonly canonicalTaskCreated: CanonicalTaskCreatedReader;
}

export interface FleetNativeRuntime {
  readonly identities: RoleIdentitySet;
  readonly claimRuntime: NativeClaimRuntimeInput;
  /**
   * The requester WRITE authority (one-swap M5e). `undefined` when the operator configured no
   * admission custody — the posting path then has no live write port and stays fail-closed.
   */
  readonly requesterWrite?: FleetRequesterWriteAuthority;
  readonly projectorPorts: NativeProjectorExactPorts;
  readonly nativeRequesterStateDir: string;
  /**
   * The verified, checkpointed source consumer the fleet WorkLoop polls (one-swap M3, #2461).
   * Built here rather than in `composition-root.ts` because it needs the trust catalog and the
   * record transport this module already owns, and because it is a LOOP input, not a composition
   * input — `buildOperatorComposition` never sees it.
   */
  readonly discovery: NativeDiscoveryConsumer;
  /**
   * The trust catalog and record transport this module already owns, exposed so the fleet evaluator
   * loop (one-swap M4a, #2461) reuses THIS operator's single trust catalog — one `bindingResolver`
   * instance — rather than re-opening a second one. `RoleIdentitySet.merge` and the evaluator
   * composition both require the same `bindingResolver` the solver/requester sets were opened with.
   */
  readonly trust: NativeTrustAuthority;
  readonly records: NativePublicRecordTransport;
  /** The single Agent IRI every role family in this fleet shares. */
  readonly agentIri: string;
  /**
   * Installs the real M4b verdict-observation adapter into the projector's late-bound port, once
   * `buildFleetNativeEvaluator` has produced the durable evaluator `state` the adapter reads. Called
   * exactly once by `main.ts`'s native branch; until then the port refuses fail-closed. See
   * {@link createLateBoundVerdictObservation}.
   */
  readonly installVerdictObservation: LateBoundVerdictObservation['install'];
}

export interface FleetNativeRuntimeInput {
  readonly config: JinnConfig;
  /** The shared daemon Store. Native tables already live in it (`store.ts`'s constructor). */
  readonly store: Store;
  readonly publicClient: Parameters<typeof createSolverReads>[0]['publicClient'];
  /** This operator's service Safe — the claims the canonical readers filter to. */
  readonly safeAddress: `0x${string}`;
  /** Root the native state directories hang off (publisher output, requester associations). */
  readonly stateRoot: string;
  readonly password: string;
  readonly workerOwnerId: string;
  readonly fetchImpl?: (request: string | URL, init?: RequestInit) => Promise<Response>;
}

function required<T>(value: T | undefined, key: string): T {
  if (value === undefined) {
    throw new NativeFleetAssemblyError(
      `compositionMode "native" requires config.${key}; native boot refuses rather than falling back to legacy`,
    );
  }
  return value;
}

/**
 * Assembles everything `buildOperatorComposition({ mode: 'native' })` requires and nothing more.
 *
 * Trust posture on the evaluator deployment (M1 review note 7): `evaluator.deploymentModule` and
 * `evaluator.moduleDigest` both live in `config.json`. The digest is therefore NOT an independent
 * pin — anyone who can write the config can write both. Its value is integrity-against-DRIFT (the
 * module bytes changed under a deployment that did not intend to change) and nothing else; it
 * authenticates no one. This function reads neither field: M4 owns the evaluator composition, and
 * that constraint is recorded here so the eventual reader states the same posture rather than
 * implying the digest is an authentication boundary.
 */
export async function buildFleetNativeRuntime(
  input: FleetNativeRuntimeInput,
): Promise<FleetNativeRuntime> {
  const { config } = input;
  const chain = BASE_SEPOLIA_TODAY;
  const agentIri = required(config.agentIri, 'agentIri');
  const identityStores = required(config.identityStores, 'identityStores');
  const trustRootsPath = required(config.trustRootsPath, 'trustRootsPath');
  const trustPolicyGenesisDigest = required(config.trustPolicyGenesisDigest, 'trustPolicyGenesisDigest');
  const ipfsApiUrl = required(config.ipfs, 'ipfs.apiUrl').apiUrl;
  const publicBaseUrl = required(config.publicBaseUrl, 'publicBaseUrl');
  const solverStore = required(identityStores.solver, 'identityStores.solver');
  const requesterStore = required(identityStores.requester, 'identityStores.requester');
  // Schema-legal but never correct: `NativeIdentityStoresConfigSchema` only refuses a
  // requester/admission collapse, so one path under both `solver` and `requester` parses fine and
  // then fails deep inside `IdentityStore.loadOrCreate` with "identity store role set does not
  // equal the explicitly owned role set" — an opaque error about a config mistake. Refuse it here,
  // by name, before either store is opened.
  if (solverStore === requesterStore) {
    throw new NativeFleetAssemblyError(
      'config.identityStores.solver and config.identityStores.requester name the same file; each '
      + 'role family owns its own custody, and one store cannot hold both role sets',
    );
  }

  const records = createBaseSepoliaRecordTransport({
    ipfsApiUrl,
    fetchImpl: input.fetchImpl ?? globalThis.fetch,
  });
  // One `createViemBaseSepoliaReadClients` call supplies both trust-catalog chain reads: the
  // finalized-anchor reader and the §2.3c step-5 Safe-ownership reader.
  const trustReads = createViemBaseSepoliaReadClients(input.publicClient);
  const trust = await openNativeTrustCatalog({
    path: trustRootsPath,
    expectedPolicyGenesisDigest: trustPolicyGenesisDigest,
    anchorClient: createBaseSepoliaFinalizedAnchorClient(trustReads.anchor),
    settlementOwnershipClient: trustReads.settlementOwnership,
  });

  // Two stores, one Agent, one merged set — see RoleIdentitySet.merge. Every key still proved its
  // own effective-time binding inside its own `open`; merging widens no authority.
  const identities = RoleIdentitySet.merge(
    await Promise.all(([
      [solverStore, FLEET_STORE_ROLES.solver],
      [requesterStore, FLEET_STORE_ROLES.requester],
    ] as const).map(([storePath, roles]) => openRoleIdentitySet({
      agent: agentIri,
      requiredRoles: roles,
      storePath,
      password: input.password,
      bindingResolver: trust.bindingResolver,
      verifyRoleBinding: trust.verifyRoleBinding,
    }))),
  );

  const state = new NativeOperatorStateRepository(input.store);
  const solverReads = createSolverReads({
    config: {
      safeAddress: input.safeAddress,
      chain: {
        chainId: chain.chainId as 84532,
        generation: chain.generation as 'today',
        contracts: {
          taskCoordinator: chain.taskCoordinator,
          jinnRouter: chain.jinnRouter,
          mechMarketplace: chain.mechMarketplace,
          activityChecker: chain.activityChecker,
        },
      },
    },
    publicClient: input.publicClient,
    records,
  });

  const exactDocumentsByDigest = buildNativeExactDocuments(records);
  const nativeRequesterStateDir = join(input.stateRoot, 'native-requester');

  const claimRuntime: NativeClaimRuntimeInput = {
    operatorAgent: agentIri,
    state,
    exactDocuments: (card: AnnouncedSubmissionCard) => exactDocumentsByDigest({
      taskDigest: digest(card.facts['taskDigest'], 'taskDigest'),
      submissionDigest: card.record.digest,
    }),
    canonical: solverReads.claimCanonical,
    policy: buildNativeClaimPolicy({
      chainId: chain.chainId,
      generation: chain.generation,
      contracts: {
        taskCoordinator: chain.taskCoordinator,
        jinnRouter: chain.jinnRouter,
        mechMarketplace: chain.mechMarketplace,
        activityChecker: chain.activityChecker,
      },
      transactionCaps: { escrowMaxWei: resolveFleetEscrowMaxWei(config.claimPolicy) },
    }),
    // Honest as of M3, and only because the decode landed WITH it. M2 pinned this to `false`
    // because the fleet path had no discovery decode, so no card's TaskCreated had been proved
    // canonical and finalized and refusing every claim was the truthful answer. `discovery` below
    // now installs `buildNativeRequesterAnnouncementDecode` — the same gate
    // `native-solver-production.ts` runs — and `nativeDiscoveryDecodeProvedCanonical` answers the
    // structural question "did that gate admit THIS card?" rather than asserting a blanket `true`.
    // A card that reached the claim runtime by any other route still gets `false`.
    canonicalFinalized: async (card) => nativeDiscoveryDecodeProvedCanonical(card),
    activeEngagements: () => countActiveNativeEngagements(state),
    worker: { ownerId: input.workerOwnerId, ttlMs: 30_000 },
    solution: {
      publisherRootDir: join(input.stateRoot, 'native-public', 'solver'),
      publicBaseUrl,
      exactDocuments: exactDocumentsByDigest,
      resolveEvaluationSpec: buildNativeEvaluationSpecResolver(records),
    },
  };

  // The projector captures this port at composition-build time, BEFORE `buildFleetNativeEvaluator`
  // produces the durable evaluator state the real M4b adapter reads. `main.ts` installs the real
  // adapter through `installVerdictObservation` once that state exists; until then the stable port
  // refuses fail-closed. See `createLateBoundVerdictObservation`.
  const lateBoundVerdict = createLateBoundVerdictObservation();
  const projectorPorts: NativeProjectorExactPorts = {
    resolveRecord: buildNativeResolveRecord(
      chain,
      createNativeRequesterSubmissionResolver({
        stateDir: nativeRequesterStateDir,
        requesterSubmission: identities.get('requester-submission'),
      }),
    ),
    verifyVerdictObservation: lateBoundVerdict.port,
  };

  const discovery = await buildFleetNativeDiscovery({
    store: input.store,
    trust,
    recordSources: config.recordSources,
    // #2547: this operator's own archive origin, so a self-hosted requester source's idle-lapsed
    // head degrades rather than deadlocking the solver loop's boot `sync()`.
    selfBaseUrl: publicBaseUrl,
    verifyAuthorityTime: createBaseSepoliaAuthorityTime(input.publicClient).verifyFinalized,
    recordByLocation: (locator) => records.byLocation(locator),
    canonicalTaskCreated: (expected) => solverReads.canonicalTaskCreated(expected),
  });

  // One-swap M5e: the requester WRITE authority, built only when the operator provisioned admission
  // custody. The admission signer is a DISTINCT Agent from the requester (design: admission is a
  // separate authority), so it is a SEPARATE role set — `RoleIdentitySet.merge` refuses two agents,
  // and rightly. The dispatch port routes `admission` to that set and every other requester role to
  // the merged fleet identities (which now own `requester-submission` + `requester-discovery`).
  const requesterWrite = await buildFleetRequesterWriteAuthority({
    config,
    agentIri,
    publicBaseUrl,
    password: input.password,
    trust,
    identities,
    nativeRequesterStateDir,
    authorityTime: createBaseSepoliaAuthorityTime(input.publicClient).latestFinalized,
    canonicalTaskCreated: (expected) => solverReads.canonicalTaskCreated(expected),
  });

  return {
    identities,
    ...(requesterWrite === undefined ? {} : { requesterWrite }),
    claimRuntime,
    projectorPorts,
    nativeRequesterStateDir,
    discovery,
    trust,
    records,
    agentIri,
    installVerdictObservation: lateBoundVerdict.install,
  };
}

/**
 * Builds the requester WRITE authority, or `undefined` when the operator provisioned no admission
 * custody. Refuses loudly (never silently degrades to no-post) when admission custody is present but
 * malformed: an admission Agent equal to the requester Agent, or an admission store equal to the
 * requester store, is a custody fault the schema does not catch across the two config sections.
 *
 * The admission role set is opened SEPARATELY from the merged fleet identities because it is bound
 * to a distinct Agent IRI (`RoleIdentitySet.merge` refuses two agents). The returned `roles` port
 * dispatches `admission` to that set and every other requester role to the merged identities, which
 * — after the M5e widening of `FLEET_STORE_ROLES.requester` — own both `requester-submission` and
 * `requester-discovery`.
 */
async function buildFleetRequesterWriteAuthority(input: {
  readonly config: JinnConfig;
  readonly agentIri: string;
  readonly publicBaseUrl: string;
  readonly password: string;
  readonly trust: NativeTrustAuthority;
  readonly identities: RoleIdentitySet;
  readonly nativeRequesterStateDir: string;
  readonly authorityTime: () => Promise<NativeAuthorityTimeAnchor>;
  readonly canonicalTaskCreated: CanonicalTaskCreatedReader;
}): Promise<FleetRequesterWriteAuthority | undefined> {
  const admissionAgent = input.config.admissionAgent;
  const admissionStore = input.config.identityStores?.admission;
  if (admissionAgent === undefined || admissionStore === undefined) return undefined;

  const requesterStore = input.config.identityStores?.requester;
  if (admissionAgent === input.agentIri) {
    throw new NativeFleetAssemblyError(
      'config.admissionAgent equals config.agentIri; the requester admission authority must be a '
      + 'distinct Agent from the requester it admits for',
    );
  }
  if (requesterStore !== undefined && admissionStore === requesterStore) {
    throw new NativeFleetAssemblyError(
      'config.identityStores.admission equals config.identityStores.requester; admission custody '
      + 'must be a distinct store from the requester custody',
    );
  }

  const admissionSet = await openRoleIdentitySet({
    agent: admissionAgent,
    requiredRoles: ['admission'],
    storePath: admissionStore,
    password: input.password,
    bindingResolver: input.trust.bindingResolver,
    verifyRoleBinding: input.trust.verifyRoleBinding,
  });

  const roles: NativeRequesterRoles = {
    get(role): NativeRequesterIdentity {
      return role === 'admission' ? admissionSet.get('admission') : input.identities.get(role);
    },
  };

  return {
    requesterAgent: input.agentIri,
    admissionAgent,
    publicBaseUrl: input.publicBaseUrl,
    requesterStateDir: input.nativeRequesterStateDir,
    roles,
    authorityTime: input.authorityTime,
    canonicalTaskCreated: input.canonicalTaskCreated,
  };
}
