import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createHttpTransport } from '@jinn-network/record-discovery-transport-http';
import { documentDigest } from '@jinn-network/task-execution-protocol';
import {
  NATIVE_REQUESTER_ASSOCIATION_FACT,
  decodeNativeRequesterAnnouncement,
} from '../native-requester/requester.js';
import { Store } from '../store/store.js';
import { NativeClaimCoordinator } from './native-claim-coordinator.js';
import { evaluateNativeClaim } from './native-claim-policy.js';
import {
  NativeCanonicalObservationRepository,
  NativeMarketplaceEventRepository,
  syncNativeMarketplaceEvents,
} from './native-canonical-observations.js';
import { buildNativeDiscoverySources } from './native-discovery-trust.js';
import { createNativeDiscoveryConsumer } from './native-discovery.js';
import type {
  NativeInfrastructurePrimitives,
  NativeSolverWritePrimitives,
} from './native-infrastructure-bundle.js';
import { createNativeOperatorHost, type NativeOperatorHost } from './native-operator-host.js';
import { NativeOperatorStateRepository, type NativeEngagementRow } from './native-operator-state.js';
import type { NativeProductConfig } from './native-product-config.js';
import { openNativeSolutionPublisher } from './native-solution-publisher.js';
import { NativeSolutionCoordinator } from './native-solution-coordinator.js';
import { buildNativeSolutionSettlementPort } from './native-solution-settlement.js';
import { buildNativeSolutionVerification } from './native-solution-verification.js';
import { buildNativeSettlementGrade } from './native-settlement-grade.js';
import { buildNativeSolverBackend } from './native-solver-backend.js';
import { openOperatorEvidence } from './evidence-join.js';
import type { NativeTrustAuthority } from './native-trust-catalog.js';
import type { RoleIdentitySet } from './role-identities.js';

const ASSOCIATION = NATIVE_REQUESTER_ASSOCIATION_FACT;

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

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function digest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} is not a canonical sha256 digest`);
  }
  return value as `sha256:${string}`;
}

function address(value: unknown, label: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(value)) {
    throw new Error(`${label} is not an EVM address`);
  }
  return value as `0x${string}`;
}

function hash(value: unknown, label: string): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(`${label} is not a 32-byte hash`);
  }
  return value as `0x${string}`;
}

function uint(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} is not a canonical unsigned integer`);
  }
  return BigInt(value);
}

function chain(config: NativeProductConfig['operator']['native']) {
  return {
    chainId: config.chainId,
    generation: config.generation,
    taskCoordinator: config.contracts.taskCoordinator as `0x${string}`,
    jinnRouter: config.contracts.jinnRouter as `0x${string}`,
    mechMarketplace: config.contracts.mechMarketplace as `0x${string}`,
    activityChecker: config.contracts.activityChecker as `0x${string}`,
  } as const;
}

function roleKeyIds(roles: RoleIdentitySet): Readonly<Record<string, string>> {
  return {
    'solver-delivery': roles.get('solver-delivery').keyId,
    'solver-discovery': roles.get('solver-discovery').keyId,
  };
}

function nonterminal(state: string): boolean {
  return !['solution-settled', 'lost', 'failed'].includes(state);
}

function closeAll(actions: readonly (() => void | Promise<void>)[]): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const action of actions) {
      try { await action(); } catch (cause) { failures.push(cause); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'native solver cleanup failed');
  };
}

/** Product-owned native solver graph; the infrastructure object contributes I/O only. */
export async function buildNativeSolverProductionHost(
  input: SolverProductionInput,
): Promise<NativeOperatorHost> {
  const config = input.config.operator.native;
  if (config.role !== 'solver' || config.identityStores.solver === undefined) {
    throw new Error('native solver production composition requires solver-only custody');
  }
  if (input.infrastructure.solver === undefined || config.marketplaceAgentAddress === undefined) {
    throw new Error('native solver chain reads or marketplace Agent are unavailable');
  }
  const store = new Store(join(config.stateDir, 'solver.sqlite'));
  const state = new NativeOperatorStateRepository(store);
  const observations = new NativeCanonicalObservationRepository(store);
  const marketplaceEvents = new NativeMarketplaceEventRepository(store);
  const evidence = await openOperatorEvidence({ rootDir: join(config.stateDir, 'evidence') });
  const solver = await buildNativeSolverBackend({
    roles: input.roles,
    stateRoot: join(config.stateDir, 'backend'),
    evidence: evidence.ports,
    maxConcurrentAttempts: 1,
  });
  const verification = buildNativeSolutionVerification({
    identities: input.roles,
    resolveEvaluationSpec: async (expected) => {
      try {
        const bytes = await input.infrastructure.records.byDigest(expected);
        return documentDigest(bytes) === expected ? bytes : undefined;
      } catch {
        return undefined;
      }
    },
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
  });
  const endpoint = await input.infrastructure.mountPublicSource(publisher.handler);
  const requesterSources = config.sources.filter(({ role }) => role === 'requester');
  if (requesterSources.length === 0) throw new Error('native solver has no requester source');
  const transport = createHttpTransport('');
  const sources = await buildNativeDiscoverySources({
    configured: requesterSources,
    store,
    transport,
    trust: input.trust,
  });
  const discovery = createNativeDiscoveryConsumer({
    store,
    sources,
    transport,
    async decode(discoveryInput) {
      const facts = object(discoveryInput.announcement.facts, 'requester facts');
      const association = object(facts[ASSOCIATION], 'requester association');
      const submissionLocation = discoveryInput.announcement.locations ?? [];
      if (submissionLocation.length !== 1) throw new Error('native requester announcement must advertise one Submission location');
      const submissionBytes = await input.infrastructure.records.byLocation(submissionLocation[0]!.locator);
      const lookup = {
        chainId: Number(uint(association['chainId'], 'chainId')),
        coordinator: address(association['coordinator'], 'coordinator'),
        creator: address(association['creator'], 'creator'),
        taskId: uint(association['taskId'], 'taskId'),
        taskDigest: digest(association['taskDigest'], 'taskDigest'),
        txHash: hash(association['txHash'], 'txHash'),
        terms: (() => {
          const terms = object(association['postingTerms'], 'posting terms');
          if (terms['allowSolverSelfEvaluation'] !== false) {
            throw new Error('native requester permits solver self-evaluation');
          }
          return {
            solutionMaxDeliveryRateWei: uint(terms['solutionMaxDeliveryRateWei'], 'solution rate'),
            verdictMaxDeliveryRateWei: uint(terms['verdictMaxDeliveryRateWei'], 'verdict rate'),
            responseTimeoutSeconds: uint(terms['responseTimeoutSeconds'], 'response timeout'),
            allowSolverSelfEvaluation: false as const,
          };
        })(),
        maxClaims: 1 as const,
      };
      const canonical = await input.infrastructure.solver!.canonicalTaskCreated(lookup);
      if (canonical === null) throw new Error('native TaskCreated is not canonical and finalized');
      return decodeNativeRequesterAnnouncement({
        discovery: discoveryInput,
        canonicalTaskCreated: canonical,
        submissionBytes,
      });
    },
  });

  const exactDocuments = async (engagement: Pick<NativeEngagementRow, 'taskDigest' | 'submissionDigest'>) => {
    const [taskBytes, submissionBytes] = await Promise.all([
      input.infrastructure.records.byDigest(engagement.taskDigest),
      input.infrastructure.records.byDigest(engagement.submissionDigest),
    ]);
    if (documentDigest(taskBytes) !== engagement.taskDigest
      || documentDigest(submissionBytes) !== engagement.submissionDigest) {
      throw new Error('native exact Task/Submission retrieval changed digest');
    }
    return { taskBytes, submissionBytes };
  };
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
        policy: {
          chainId: config.chainId,
          coordinator: config.contracts.taskCoordinator,
          generation: config.generation,
          maxSpendWei: BigInt(config.transactionCaps.escrowMaxWei),
          minDeadlineLeadMs: 0,
          maxConcurrent: 1,
        },
        activeEngagements: state.listEngagements().filter(({ state }) => nonterminal(state)).length,
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
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await input.lease.renew();
      claim.renewWorker();
      await syncVenue();
      await discovery.sync();
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
  const stopOwned = closeAll([
    async () => { stopped = true; if (timer !== undefined) clearInterval(timer); },
    endpoint.close,
    publisher.close,
    solver.close,
    evidence.close,
    () => store.close(),
  ]);
  const closeVenue = closeAll([writeSession.close, input.infrastructure.close]);

  return createNativeOperatorHost({
    role: 'solver',
    roleKeyIds: roleKeyIds(input.roles),
    lease,
    bindings: {
      async verify() {
        for (const role of ['solver-delivery', 'solver-discovery'] as const) {
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
          profileUri: 'https://jinn.network/task-profiles/prediction-forecast/1.0',
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
    work: {
      async start() {
        await tick();
        timer = setInterval(() => { void tick().catch(() => undefined); }, 5_000);
        timer.unref();
      },
      stop: stopOwned,
    },
  });
}
