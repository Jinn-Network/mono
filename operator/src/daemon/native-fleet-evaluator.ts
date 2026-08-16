/**
 * The ONE fleet daemon's native evaluator composition + loop mount (one-swap M4a, umbrella #2461,
 * DR-2026-08-05).
 *
 * M2 assembled the solver/requester composition; M3 gave the WorkLoop its verified discovery
 * consumer; M5 the posting loop. This is the evaluator leg: it ports the STANDALONE evaluator's
 * infrastructure (`native-evaluator-production.ts`) onto the fleet's Safe/wallet and the SHARED
 * `Store`, reusing the composition's own venue verdict ports rather than opening a second venue on
 * the same Safe. The product-authority half — subject authority, authority claim, verdict
 * verification, the `buildNativeEvaluatorComposition` call — is the SHARED
 * `assembleNativeEvaluatorComposition`, so this path cannot drift from the standalone one.
 *
 * Three load-bearing differences from `buildNativeEvaluatorProductionHost`, all inherited from the
 * fleet posture:
 *
 * 1. **Venue reuse, not a second venue.** The standalone activates its own `BaseVenue` (evaluator
 *    role, refused-settlement authority) through `NativeInfrastructurePrimitives`. The fleet daemon
 *    already owns exactly one `BaseVenue` bound to this operator's Safe (the composition's), and
 *    `composition-root.ts` explicitly warns that a SECOND venue on the same Safe reopens the
 *    #525/#562/#897 nonce-race class unless it shares the one broadcast lock. So the fleet evaluator
 *    reuses `composition.venue.verdict` — the same Safe, the same broadcaster, the same lock. The
 *    verdict ports are independent of the venue's `verifySettlementGrade` (that gates the SOLVER
 *    settlement path), so reusing the solver-authority venue for verdict delivery is exact.
 * 2. **Shared Store for evaluator STATE, a DISTINCT store for the discovery QUEUE.** The evaluator
 *    aggregate (`native_evaluations`) lives in `Store(config.dbPath)` so the API read plane sees it,
 *    exactly as the task requires. But the opportunity reader's two discovery consumers CANNOT
 *    share `native_discovery_*` with the WorkLoop's requester consumer (M3) on that same Store — the
 *    WorkLoop's checkpoint advancement / acknowledgement would starve the evaluator, and the
 *    decode-that-wrote-first would win the shared `card_json` row (M3 review N6). The reader takes a
 *    DISTINCT `discoveryStore` for its queue; keying the evaluator's discovery distinctly is the
 *    separation.
 * 3. **Self-computed Node pin.** The standalone pins the launcher Node executable to
 *    `config.runtime.nodeExecutableDigest`; the fleet `config.json` carries no such field, so this
 *    pins to the running executable's own digest — functional, but an integrity-against-drift guard
 *    only, not an external pin. Recorded as an M4a finding; a real external pin is a config-surface
 *    change for a later milestone.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import type { VerdictPorts } from '@jinn-network/marketplace-venue-base';
import type { PublicClient } from 'viem';
import type { JinnConfig } from '../config.js';
import { openOperatorEvidence, type OperatorEvidence } from './evidence-join.js';
import {
  NativeMarketplaceEventRepository,
} from './native-canonical-observations.js';
import {
  createBaseSepoliaAuthorityTime,
  createBaseSepoliaEvaluatorReads,
} from './native-base-sepolia-infrastructure.js';
import { assembleNativeEvaluatorComposition } from './native-evaluator-assembly.js';
import type { NativeEvaluatorComposition } from './native-evaluator-composition.js';
import { buildNativeEvaluatorOpportunityReader } from './native-evaluator-opportunity-source.js';
import { NativeEvaluatorStateRepository } from './native-evaluator-state.js';
import { buildPinnedNodeLauncherDeployment } from './native-solver-backend.js';
import type { NativePublicRecordTransport } from './native-infrastructure-bundle.js';
import { openRoleIdentitySet, type NativeRoleIdentityRole } from './role-identities.js';
import type { NativeTrustAuthority } from './native-trust-catalog.js';
import { Store } from '../store/store.js';

export class NativeFleetEvaluatorError extends Error {
  override readonly name = 'NativeFleetEvaluatorError';
}

const EVALUATOR_ROLES: readonly NativeRoleIdentityRole[] = [
  'evaluator-verdict',
  'evaluator-settlement',
  'evaluator-discovery',
];

function required<T>(value: T | undefined, key: string): T {
  if (value === undefined) {
    throw new NativeFleetEvaluatorError(
      `compositionMode "native" evaluator loop requires config.${key}; refuses rather than mounting a half-configured evaluator`,
    );
  }
  return value;
}

/**
 * Is the fleet evaluator loop configured? A native operator that runs only the solver leg carries
 * no `evaluator` deployment and no `identityStores.evaluator`; this returns false and no evaluator
 * composition is constructed (boot-inertness for the native-solver-only shape, mirroring the
 * legacy/default boot which never reaches this module at all).
 */
export function fleetEvaluatorConfigured(config: JinnConfig): boolean {
  return config.evaluator !== undefined && config.identityStores?.evaluator !== undefined;
}

export interface FleetNativeEvaluator {
  readonly composition: NativeEvaluatorComposition;
  /**
   * The durable evaluator state repository over the SHARED Store — the handle M4b's real
   * verdict-observation adapter binds to (`native_evaluation_authority` records which
   * `(task, solution, verdict)` this operator durably verified). See the M4b handoff in the PR body.
   */
  readonly state: NativeEvaluatorStateRepository;
  close(): Promise<void>;
}

export interface FleetNativeEvaluatorInput {
  readonly config: JinnConfig;
  /** The shared daemon Store; `native_evaluations` lives here for the API read plane. */
  readonly store: Store;
  readonly publicClient: PublicClient;
  /** This operator's service Safe — the verdict venue authority. */
  readonly safeAddress: `0x${string}`;
  /** The agent EOA that operates this operator's mech (self-evaluation EOA check). */
  readonly agentEoaAddress: `0x${string}`;
  /** The one trust catalog opened by `buildFleetNativeRuntime` (one `bindingResolver`). */
  readonly trust: NativeTrustAuthority;
  /** The record transport `buildFleetNativeRuntime` already owns. */
  readonly records: NativePublicRecordTransport;
  /** The single Agent IRI every role family in this fleet shares. */
  readonly agentIri: string;
  /**
   * The composition's own venue verdict ports (`composition.venue.verdict`). Reused rather than
   * opening a second venue on the same Safe — see this module's header, difference 1.
   */
  readonly verdictPorts: VerdictPorts;
  readonly password: string;
  /** Root the native evaluator directories hang off (`<earningDir>/../native`). */
  readonly stateRoot: string;
}

function chainReadIdentity(safeAddress: `0x${string}`) {
  return {
    safeAddress,
    chain: {
      chainId: BASE_SEPOLIA_TODAY.chainId as 84532,
      generation: BASE_SEPOLIA_TODAY.generation as 'today',
      contracts: {
        taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
        jinnRouter: BASE_SEPOLIA_TODAY.jinnRouter,
        mechMarketplace: BASE_SEPOLIA_TODAY.mechMarketplace,
        activityChecker: BASE_SEPOLIA_TODAY.activityChecker,
      },
    },
  } as const;
}

function runningNodeDigest(): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(readFileSync(process.execPath)).digest('hex')}`;
}

/**
 * Builds the fleet evaluator composition. The caller (`main.ts`, native branch) has already built
 * the fleet composition and passes its `venue.verdict`; this opens the evaluator custody, the
 * evaluator chain reads, evidence, the pinned launcher and the opportunity reader (over a distinct
 * discovery store), then hands them to the SHARED assembly.
 */
export async function buildFleetNativeEvaluator(
  input: FleetNativeEvaluatorInput,
): Promise<FleetNativeEvaluator> {
  const { config } = input;
  const evaluatorDeployment = required(config.evaluator, 'evaluator');
  const identityStores = required(config.identityStores, 'identityStores');
  const evaluatorStorePath = required(identityStores.evaluator, 'identityStores.evaluator');
  const recordSources = required(config.recordSources, 'recordSources');
  const publicBaseUrl = required(config.publicBaseUrl, 'publicBaseUrl');

  // The evaluator role set is opened against the SAME trust catalog (one `bindingResolver`) the
  // fleet's solver/requester sets were opened with, and shares the one Agent IRI — the invariants
  // `RoleIdentitySet.merge` and the evaluator composition both enforce. It is a STANDALONE set (the
  // evaluator composition reads only `evaluator-*` roles and `.agent`); it never needs to merge
  // with the solver set.
  const roles = await openRoleIdentitySet({
    agent: input.agentIri,
    requiredRoles: EVALUATOR_ROLES,
    storePath: evaluatorStorePath,
    password: input.password,
    bindingResolver: input.trust.bindingResolver,
    verifyRoleBinding: input.trust.verifyRoleBinding,
  });

  const readIdentity = chainReadIdentity(input.safeAddress);
  const evaluatorReads = createBaseSepoliaEvaluatorReads({
    config: readIdentity,
    publicClient: input.publicClient,
    records: input.records,
  });
  const authorityTime = createBaseSepoliaAuthorityTime(input.publicClient);

  const stateDir = join(input.stateRoot, 'evaluator');
  const evidence: OperatorEvidence = await openOperatorEvidence({
    rootDir: join(stateDir, 'evidence'),
  });

  const deployment = await buildPinnedNodeLauncherDeployment(runningNodeDigest());
  if (!(await deployment.probe()).ready) {
    await evidence.close();
    throw new NativeFleetEvaluatorError('pinned evaluator Node launcher is not ready');
  }

  const state = new NativeEvaluatorStateRepository(input.store);
  // Projector-fed on the fleet path (`composition-root.ts` tees marketplace events into the shared
  // Store), so `syncVenue` is a no-op — a second poller on the single-consumer venue cursor is
  // exactly what M3 avoided. A fresh reader instance over the same rows is safe (idempotent schema).
  const marketplaceEvents = new NativeMarketplaceEventRepository(input.store);

  // Distinct discovery queue — see this module's header, difference 2. Closed on shutdown.
  const discoveryStore = new Store(join(stateDir, 'discovery.sqlite'));

  let composition: NativeEvaluatorComposition | undefined;
  try {
    const opportunities = await buildNativeEvaluatorOpportunityReader({
      sources: recordSources,
      jinnRouter: BASE_SEPOLIA_TODAY.jinnRouter,
      store: input.store,
      discoveryStore,
      trust: input.trust,
      infrastructure: {
        records: input.records,
        authorityTime,
        evaluator: evaluatorReads,
      },
      events: marketplaceEvents,
      // Marketplace events arrive via the projector's tee; the evaluator never polls the venue.
      syncVenue: async () => undefined,
      // #2547: on the ONE fleet daemon the evaluator consumes THIS operator's own requester source,
      // served from `publicBaseUrl`. Passing it lets that self-hosted source's idle-lapsed head
      // degrade rather than deadlock the evaluator's boot `sync()` after >24h idle.
      selfBaseUrl: publicBaseUrl,
    });

    composition = await assembleNativeEvaluatorComposition({
      roles,
      state,
      trust: input.trust,
      evidence: evidence.ports,
      launcherDeployment: deployment,
      opportunities,
      verdictPorts: input.verdictPorts,
      chainReads: evaluatorReads,
      identity: {
        safeAddress: input.safeAddress,
        marketplaceAgentAddress: input.agentEoaAddress,
        agentIri: input.agentIri,
        taskCoordinator: BASE_SEPOLIA_TODAY.taskCoordinator,
        publicBaseUrl,
        stateDir,
        sources: recordSources,
      },
      deployment: {
        module: evaluatorDeployment.deploymentModule,
        moduleDigest: evaluatorDeployment.moduleDigest as `sha256:${string}`,
        signerHandle: evaluatorDeployment.signerHandle,
        // Branded `NativeEvaluationMethodDigests` (single digest or per-registration map) — no cast
        // (native-sections.ts brands it). The map form lets one deployment serve prediction AND
        // swe-rebench with per-registration digests.
        evaluationMethodDigest: evaluatorDeployment.evaluationMethodDigest,
      },
      // Container-graded registrations (swe-rebench-v2) declare their `deployment-owned` binding
      // here (one-swap M4c, #2467). A container-graded registration with no binding is refused at
      // composition; omitted for a prediction-only deployment, leaving the M4a boot path unchanged.
      ...(evaluatorDeployment.graderReportSources === undefined
        ? {}
        : { graderReportSources: evaluatorDeployment.graderReportSources }),
    });
  } catch (cause) {
    await evidence.close().catch(() => undefined);
    discoveryStore.close();
    throw cause;
  }

  const built = composition;
  return {
    composition: built,
    state,
    async close() {
      let failure: unknown;
      try {
        await built.close();
      } catch (cause) {
        failure = cause;
      }
      await evidence.close().catch((cause: unknown) => { failure ??= cause; });
      try { discoveryStore.close(); } catch (cause) { failure ??= cause; }
      if (failure !== undefined) throw failure;
    },
  };
}
