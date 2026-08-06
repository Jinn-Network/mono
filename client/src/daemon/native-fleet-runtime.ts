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
import type { AnnouncedSubmissionCard } from '@jinn-network/marketplace-pipeline';
import { createNativeRequesterSubmissionResolver } from '../native-requester/requester.js';
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
  createBaseSepoliaFinalizedAnchorClient,
  createBaseSepoliaRecordTransport,
  createSolverReads,
  createViemBaseSepoliaReadClients,
} from './native-base-sepolia-infrastructure.js';
import { NativeOperatorStateRepository } from './native-operator-state.js';
import type { NativeProjectorExactPorts } from './native-projector-ports.js';
import { openNativeTrustCatalog } from './native-trust-catalog.js';
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
  requester: ['requester-submission'],
};

/**
 * `verifyVerdictObservation` still has NO production implementation anywhere in the repo — the
 * Phase-B binding-resolver backing stores (`BindingStore` / `AnchorReadClient` / policy) that
 * `VerdictObservationGatePorts` needs do not exist yet. `composition-root.ts` ships the legacy
 * counterpart (`refuseLegacyVerdictObservation`) for exactly this reason.
 *
 * The native path gets the same posture, not a weaker one: a loud, named throw.
 * `projectAnnouncements` turns it into a fail-CLOSED refusal, so no verdict is ever projected as
 * "verified" on evidence this operator cannot check. M4 (the native evaluator loop) is where the
 * real gate lands; until then a native boot that reaches a VerdictDeliveryClaimed refuses it,
 * which is the correct answer, not a degraded one.
 */
export function refuseNativeVerdictObservation(): never {
  throw new NativeFleetAssemblyError(
    'verifyVerdictObservation has no production implementation on the native fleet path either: '
    + 'the Phase-B binding-resolver backing stores (BindingStore/AnchorReadClient/policy) do not '
    + 'exist in the repo. M4 (native evaluator loop) owns the decision-grade gate; until then this '
    + 'refuses fail-closed rather than projecting an unverified verdict (one-swap M2, #2461)',
  );
}

export interface FleetNativeRuntime {
  readonly identities: RoleIdentitySet;
  readonly claimRuntime: NativeClaimRuntimeInput;
  readonly projectorPorts: NativeProjectorExactPorts;
  readonly nativeRequesterStateDir: string;
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
  const trust = await openNativeTrustCatalog({
    path: trustRootsPath,
    expectedPolicyGenesisDigest: trustPolicyGenesisDigest,
    anchorClient: createBaseSepoliaFinalizedAnchorClient(
      createViemBaseSepoliaReadClients(input.publicClient).anchor,
    ),
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
    // Fail-CLOSED, deliberately. `native-solver-production.ts` can pass `true` here because its
    // discovery consumer's decode already refused any card whose TaskCreated was not canonical and
    // finalized; the fleet path has no such decode yet — M3 wires the native discovery consumer.
    // Returning `false` makes `evaluateNativeClaim` refuse the claim, which is the honest answer
    // until the decode exists. It must NOT become `true` without that decode landing.
    canonicalFinalized: async () => false,
    activeEngagements: () => countActiveNativeEngagements(state),
    worker: { ownerId: input.workerOwnerId, ttlMs: 30_000 },
    solution: {
      publisherRootDir: join(input.stateRoot, 'native-public', 'solver'),
      publicBaseUrl,
      exactDocuments: exactDocumentsByDigest,
      resolveEvaluationSpec: buildNativeEvaluationSpecResolver(records),
    },
  };

  const projectorPorts: NativeProjectorExactPorts = {
    resolveRecord: buildNativeResolveRecord(
      chain,
      createNativeRequesterSubmissionResolver({
        stateDir: nativeRequesterStateDir,
        requesterSubmission: identities.get('requester-submission'),
      }),
    ),
    verifyVerdictObservation: refuseNativeVerdictObservation,
  };

  return { identities, claimRuntime, projectorPorts, nativeRequesterStateDir };
}
