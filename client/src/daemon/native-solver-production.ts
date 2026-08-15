import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createHttpTransport } from '@jinn-network/record-discovery-transport-http';
import { Store } from '../store/store.js';
import { NativeClaimCoordinator } from './native-claim-coordinator.js';
import { evaluateNativeClaim } from './native-claim-policy.js';
import {
  NativeCanonicalObservationRepository,
  NativeMarketplaceEventRepository,
  syncNativeMarketplaceEvents,
} from './native-canonical-observations.js';
import { buildNativeDiscoverySources } from './native-discovery-trust.js';
import { drainNativeDiscoveryWithdrawals } from './native-discovery-withdrawals.js';
import { createNativeDiscoveryConsumer } from './native-discovery.js';
import { buildNativeRequesterAnnouncementDecode } from './native-requester-decode.js';
import type {
  NativeInfrastructurePrimitives,
  NativeSolverWritePrimitives,
} from './native-infrastructure-bundle.js';
import { PREDICTION_FORECAST_PROFILE_URI } from '@jinn-network/task-execution-profiles';
import { createNativeWorkLoop } from './native-work-loop.js';
import { createNativeOperatorHost, type NativeOperatorHost } from './native-operator-host.js';
import { NativeOperatorStateRepository } from './native-operator-state.js';
import type { NativeProductConfig } from './native-product-config.js';
import { buildNativeSolutionCorrections } from './native-solution-corrections.js';
import { openNativeSolutionPublisher } from './native-solution-publisher.js';
import { NativeSolutionCoordinator } from './native-solution-coordinator.js';
import { buildNativeSolutionSettlementPort } from './native-solution-settlement.js';
import { buildNativeSolutionVerification } from './native-solution-verification.js';
import { buildNativeSettlementGrade } from './native-settlement-grade.js';
import { buildNativeSolverBackend } from './native-solver-backend.js';
import { openOperatorEvidence } from './evidence-join.js';
import type { NativeTrustAuthority } from './native-trust-catalog.js';
import type { RoleIdentitySet } from './role-identities.js';
import { NativeConstructionScope } from './native-construction-scope.js';
// One assembly, two callers (one-swap M2): these bodies were extracted verbatim from this file
// so the fleet daemon's native composition builds the same graph rather than a second copy.
import {
  buildNativeClaimPolicy,
  buildNativeEvaluationSpecResolver,
  buildNativeExactDocuments,
  chain,
  closeAll,
  countActiveNativeEngagements,
  digest,
  roleKeyIds,
} from './native-assembly.js';

interface SolverProductionInput {
  readonly config: NativeProductConfig;
  readonly infrastructure: NativeInfrastructurePrimitives;
  readonly trust: NativeTrustAuthority;
  readonly password: string;
  readonly lease: {
    acquire(): Promise<void>;
    owned(): Promise<boolean>;
    renew(): Promise<void>;
    release(): Promise<void>;
  };
  readonly roles: RoleIdentitySet;
}

/** Product-owned native solver graph; the infrastructure object contributes I/O only. */
export async function buildNativeSolverProductionHost(
  input: SolverProductionInput,
): Promise<NativeOperatorHost> {
  const scope = new NativeConstructionScope();
  try {
  const config = input.config.operator.native;
  if (config.role !== 'solver' || config.identityStores.solver === undefined) {
    throw new Error('native solver production composition requires solver-only custody');
  }
  if (input.infrastructure.solver === undefined || config.marketplaceAgentAddress === undefined) {
    throw new Error('native solver chain reads or marketplace Agent are unavailable');
  }
  const store = new Store(join(config.stateDir, 'solver.sqlite'));
  scope.defer(() => store.close());
  const state = new NativeOperatorStateRepository(store);
  const observations = new NativeCanonicalObservationRepository(store);
  const marketplaceEvents = new NativeMarketplaceEventRepository(store);
  const evidence = await openOperatorEvidence({ rootDir: join(config.stateDir, 'evidence') });
  scope.defer(evidence.close);
  const solver = await buildNativeSolverBackend({
    roles: input.roles,
    stateRoot: join(config.stateDir, 'backend'),
    evidence: evidence.ports,
    nodeExecutableDigest: config.runtime.nodeExecutableDigest as `sha256:${string}`,
    maxConcurrentAttempts: 1,
  });
  scope.defer(solver.close);
  const verification = buildNativeSolutionVerification({
    identities: input.roles,
    resolveEvaluationSpec: buildNativeEvaluationSpecResolver(
      input.infrastructure.records,
      config.sources.filter(({ role }) => role === 'requester').map(({ baseUrl }) => baseUrl),
    ),
  });
  const writeSession = await input.infrastructure.activateWrites({
    role: 'solver',
    password: input.password,
    expectedOwnerAddress: config.evmCustody.expectedOwnerAddress as `0x${string}`,
    accountIndex: config.evmCustody.accountIndex,
    venueAuthority: {
      verifySettlementGrade: buildNativeSettlementGrade({ state, verification }),
      observations: async () => observations.read(),
      isAuthorizedMechOrigin: (candidate) =>
        candidate.toLowerCase() === config.marketplaceAgentAddress!.toLowerCase(),
    },
  });
  scope.defer(writeSession.close);
  if (writeSession.writes.role !== 'solver') {
    await writeSession.close();
    throw new Error('native solver write activation returned another role');
  }
  const writes = writeSession.writes as NativeSolverWritePrimitives;
  if (writes.claim.priorityMech.toLowerCase() !== config.marketplaceAgentAddress.toLowerCase()) {
    await writeSession.close();
    throw new Error('native solver priority Mech does not equal structured marketplace Agent');
  }
  const syncVenue = () => syncNativeMarketplaceEvents({
    venue: writeSession.venue,
    repository: marketplaceEvents,
    chain: chain(config),
    isAuthorizedMechOrigin: (candidate) =>
      candidate.toLowerCase() === config.marketplaceAgentAddress!.toLowerCase(),
  });

  const publisher = await openNativeSolutionPublisher({
    rootDir: join(config.stateDir, 'public', 'solver'),
    publicBaseUrl: config.publicBaseUrl,
    source: { agent: config.agent, name: 'solver-records' },
    signer: input.roles.get('solver-discovery'),
    settlementDeclarationKey: input.roles.get('solver-settlement').keyId,
  });
  scope.defer(publisher.close);
  const endpoint = await input.infrastructure.mountPublicSource(publisher.handler);
  scope.defer(endpoint.close);
  // The DDL this reconciler needs moved to `NATIVE_OPERATOR_STATE_SCHEMA` (one-swap M3, #2461):
  // `Store`'s constructor runs it, so this host and the fleet daemon both get the table from
  // `Store` instead of whichever one happened to `exec` it first.
  const corrections = buildNativeSolutionCorrections({ store, publisher, marketplaceEvents });
  const requesterSources = config.sources.filter(({ role }) => role === 'requester');
  if (requesterSources.length !== 1) throw new Error('native solver requires exactly one requester source');
  const transport = createHttpTransport('');
  const sources = buildNativeDiscoverySources({
    configured: requesterSources,
    store,
    transport,
    trust: input.trust,
  });
  const discovery = createNativeDiscoveryConsumer({
    store,
    sources,
    transport,
    // One decode, two callers (one-swap M3, #2461): extracted verbatim to
    // `native-requester-decode.ts` so the fleet daemon installs THE SAME canonical-and-finalized
    // gate rather than a second one that could drift.
    decode: buildNativeRequesterAnnouncementDecode({
      assertTrustFresh: () => input.trust.assertFresh(),
      verifyAuthorityTime: (anchor) => input.infrastructure.authorityTime.verifyFinalized(anchor),
      recordByLocation: (locator) => input.infrastructure.records.byLocation(locator),
      canonicalTaskCreated: (expected) => input.infrastructure.solver!.canonicalTaskCreated(expected),
    }),
  });

  const exactDocuments = buildNativeExactDocuments(input.infrastructure.records);
  const claim = new NativeClaimCoordinator({
    state,
    chain: chain(config),
    operatorAgent: config.agent,
    admission: {
      evaluate: async (queued, documents) => evaluateNativeClaim({
        card: queued.card,
        taskBytes: documents.taskBytes,
        submissionBytes: documents.submissionBytes,
        backend: solver.backend,
        launcher: solver.launcher,
        policy: buildNativeClaimPolicy(config),
        activeEngagements: countActiveNativeEngagements(state),
        canonicalFinalized: true,
        now: new Date(),
      }),
    },
    claim: writes.claim,
    canonical: input.infrastructure.solver.claimCanonical,
    worker: { ownerId: randomUUID(), ttlMs: 30_000 },
  });
  const solution = new NativeSolutionCoordinator({
    state,
    backend: solver.backend,
    documents: { resolve: exactDocuments },
    deliverySignature: { get: (candidate) => solver.backend.getDeliverySignature(candidate) },
    evidence: {
      awaitIndexed: evidence.ports.awaitIndexed,
      getRecord: (reference) => evidence.ports.repository.getRecord(reference),
    },
    verification,
    publisher,
    settlement: buildNativeSolutionSettlementPort({
      chain: chain(config),
      mechAddress: writes.claim.priorityMech,
      deliveryBroadcaster: writes.deliveryBroadcaster,
      settlement: writes.settlement,
      readObservations: () => observations.read(),
      readFinalizedBlockNumber: writeSession.venue.readFinalizedBlockNumber,
      readCanonicalBlockHash: writeSession.venue.readCanonicalBlockHash,
      canonicalReader: input.infrastructure.solver.solutionSettlementCanonical,
    }),
  });

  const lease = {
    async acquire() {
      await input.lease.acquire();
      claim.startWorker();
    },
    async owned() { return await input.lease.owned() && await claim.workerOwned(); },
    async release() {
      await claim.stopWorker();
      await input.lease.release();
    },
  };
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await input.lease.renew();
      claim.renewWorker();
      await syncVenue();
      await corrections.reconcile();
      await discovery.sync();
      await drainNativeDiscoveryWithdrawals({ store, discovery });
      for (const queued of discovery.takePending()) {
        const documents = await exactDocuments({
          taskDigest: digest(queued.card.facts['taskDigest'], 'taskDigest'),
          submissionDigest: queued.card.record.digest,
        });
        const result = await claim.process(queued, documents);
        if (result.kind !== 'deferred') discovery.acknowledge(queued);
      }
      await claim.reconcileStartup();
      await solution.reconcileStartup();
    } finally {
      running = false;
    }
  };
  const workLoop = createNativeWorkLoop({ label: 'native-solver', tick });
  const stopOwned = closeAll([
    async () => { stopped = true; workLoop.stop(); },
    endpoint.close,
    publisher.close,
    solver.close,
    evidence.close,
    () => store.close(),
  ]);
  const closeVenue = closeAll([writeSession.close, input.infrastructure.close]);

  const host = createNativeOperatorHost({
    role: 'solver',
    roleKeyIds: roleKeyIds(input.roles),
    lease,
    bindings: {
      async verify() {
        await input.trust.assertFresh();
        for (const role of ['solver-delivery', 'solver-settlement', 'solver-discovery'] as const) {
          const result = await input.roles.resolveEffective(role, new Date().toISOString());
          if (!result.ok) throw new Error(`native ${role} authority is not effective: ${result.reason}`);
        }
      },
    },
    venue: {
      rollbackToFinalized: async () => { await syncVenue(); },
      health: writeSession.venue.health,
      close: closeVenue,
    },
    operations: {
      async reconcileTransactions() { await claim.reconcileStartup(); await solution.reconcileStartup(); },
      async reconcilePublications() { await solution.reconcileStartup(); },
      uncertainCount() {
        return (store.db.prepare(
          `SELECT count(*) AS count FROM native_operations WHERE status = 'broadcast' AND tx_hash IS NULL`,
        ).get() as { count: number }).count;
      },
    },
    discovery: {
      async sync() {
        await discovery.sync();
        return { lag: 0, bySource: Object.fromEntries(requesterSources.map((source) => [`${source.agent}/${source.name}`, 0])) };
      },
    },
    recovery: { async recoverBackends() { await solution.reconcileStartup(); } },
    readiness: {
      backendRequired: true,
      evidenceRequired: true,
      executableDigest: solver.executable.digest,
      async backend() {
        const capabilities = await solver.backend.capabilities();
        const launcher = await solver.launcher.inspect({
          // #2534: the constant, not a transcribed copy — this readiness probe decides whether the
          // solver reports its backend ready at all.
          profileUri: PREDICTION_FORECAST_PROFILE_URI,
          requirements: {},
        });
        return capabilities.signedDeliveries && launcher.probe.ready;
      },
      async evidence() {
        await evidence.runtime.sync();
        const status = await evidence.runtime.getStatus();
        return status.state === 'ready' && status.terminalFailureCount === 0 && status.transientFailure === undefined;
      },
      publicSource: endpoint.ready,
    },
    // #2535: a rejected tick no longer kills the loop in silence. `createNativeWorkLoop` always
    // logs the cause, retries with backoff, and only latches `failure()` — which `health()` turns
    // into a throw — once the loop genuinely cannot continue.
    work: {
      start: workLoop.start,
      stop: stopOwned,
      failure: workLoop.failure,
    },
  });
  scope.release();
  return host;
  } catch (cause) {
    return scope.unwind(cause);
  }
}
