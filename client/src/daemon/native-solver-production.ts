import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createHttpTransport } from '@jinn-network/record-discovery-transport-http';
import {
  NATIVE_REQUESTER_ASSOCIATION_FACT,
  decodeNativeRequesterAnnouncement,
  parseNativeAuthorityTimeAnchor,
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
import { NativeOperatorStateRepository } from './native-operator-state.js';
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
import { NativeConstructionScope } from './native-construction-scope.js';
import { publicationKey } from './native-operation-identity.js';
// One assembly, two callers (one-swap M2): these bodies were extracted verbatim from this file
// so the fleet daemon's native composition builds the same graph rather than a second copy.
import {
  address,
  buildNativeClaimPolicy,
  buildNativeEvaluationSpecResolver,
  buildNativeExactDocuments,
  chain,
  closeAll,
  countActiveNativeEngagements,
  digest,
  hash,
  object,
  roleKeyIds,
  uint,
} from './native-assembly.js';

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
    resolveEvaluationSpec: buildNativeEvaluationSpecResolver(input.infrastructure.records),
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
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS native_solution_discovery_corrections (
      event_key TEXT NOT NULL,
      action TEXT NOT NULL,
      delivery_digest TEXT NOT NULL,
      announcement_id TEXT NOT NULL,
      source_sequence TEXT NOT NULL,
      entry_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (event_key, action)
    );
  `);

  const deliveryPublicationFor = (event: ReturnType<NativeMarketplaceEventRepository['solutionCandidates']>[number]) => {
    const facts = event.facts as { readonly taskId: bigint; readonly attemptIndex: number };
    return store.db.prepare(
      `SELECT a.engagement_id, a.record_digest, a.media_type, a.family, a.name, a.exact_bytes,
              p.publication_key, p.source_id
         FROM native_engagements e
         JOIN native_solution_artifacts a ON a.engagement_id = e.engagement_id AND a.role = 'delivery'
         JOIN native_publication_outbox p ON p.engagement_id = e.engagement_id
           AND p.role = 'delivery' AND p.record_digest = a.record_digest AND p.status = 'published'
        WHERE e.task_id = ? AND e.attempt_index = ?`,
    ).get(facts.taskId.toString(10), facts.attemptIndex) as {
      engagement_id: `sha256:${string}`; record_digest: `sha256:${string}`; media_type: string;
      family: string; name: string | null; exact_bytes: Uint8Array;
      publication_key: `sha256:${string}`; source_id: string;
    } | undefined;
  };

  const reconcileSignedReorgCorrections = async (): Promise<void> => {
    for (const orphan of marketplaceEvents.orphanedSolutionCandidates()) {
      const exists = store.db.prepare(
        `SELECT 1 FROM native_solution_discovery_corrections WHERE event_key = ? AND action = 'withdrawn'`,
      ).get(orphan.eventKey);
      if (exists !== undefined) continue;
      const delivery = deliveryPublicationFor(orphan.event);
      if (delivery === undefined) continue;
      const latestAvailable = store.db.prepare(
        `SELECT announcement_id FROM native_solution_discovery_corrections
          WHERE delivery_digest = ? AND action = 'available' ORDER BY rowid DESC LIMIT 1`,
      ).get(delivery.record_digest) as { announcement_id: string } | undefined;
      const withdrawalKey = publicationKey({
        sourceId: delivery.source_id,
        role: 'delivery',
        recordDigest: delivery.record_digest,
        availabilityState: `withdrawn:${orphan.event.derivation.blockHash.toLowerCase()}`,
      });
      const receipt = await publisher.withdraw({
        withdrawalKey,
        targetAnnouncementId: latestAvailable?.announcement_id ?? delivery.publication_key,
        recordDigest: delivery.record_digest,
        bytes: delivery.exact_bytes,
        mediaType: delivery.media_type,
        timestamp: orphan.orphanedAt,
        reason: 'reorged',
      });
      store.db.prepare(
        `INSERT INTO native_solution_discovery_corrections
          (event_key, action, delivery_digest, announcement_id, source_sequence, entry_digest, created_at)
         VALUES (?, 'withdrawn', ?, ?, ?, ?, ?)`,
      ).run(orphan.eventKey, delivery.record_digest, withdrawalKey, receipt.sequence, receipt.entryDigest, orphan.orphanedAt);
    }
    for (const event of marketplaceEvents.solutionCandidates()) {
      const delivery = deliveryPublicationFor(event);
      if (delivery === undefined) continue;
      const hadWithdrawal = store.db.prepare(
        `SELECT 1 FROM native_solution_discovery_corrections
          WHERE delivery_digest = ? AND action = 'withdrawn' LIMIT 1`,
      ).get(delivery.record_digest);
      if (hadWithdrawal === undefined) continue;
      const key = [event.derivation.chainId, event.derivation.contract.toLowerCase(),
        event.derivation.blockHash.toLowerCase(), event.derivation.txHash.toLowerCase(),
        event.derivation.logIndex].join(':');
      const exists = store.db.prepare(
        `SELECT 1 FROM native_solution_discovery_corrections WHERE event_key = ? AND action = 'available'`,
      ).get(key);
      if (exists !== undefined) continue;
      const announcementId = publicationKey({
        sourceId: delivery.source_id,
        role: 'delivery',
        recordDigest: delivery.record_digest,
        availabilityState: `available:${event.derivation.blockHash.toLowerCase()}`,
      });
      const timestamp = new Date().toISOString();
      const receipt = await publisher.publish({
        publication: {
          publicationKey: announcementId,
          engagementId: delivery.engagement_id,
          sourceId: delivery.source_id,
          role: 'delivery',
          recordDigest: delivery.record_digest,
          availability: 'available',
          status: 'intent',
          detail: { canonicalBlockHash: event.derivation.blockHash },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        artifact: {
          engagementId: delivery.engagement_id,
          role: 'delivery',
          family: delivery.family,
          mediaType: delivery.media_type,
          name: delivery.name,
          digest: delivery.record_digest,
          bytes: delivery.exact_bytes,
          createdAt: timestamp,
        },
        bytes: delivery.exact_bytes,
      });
      store.db.prepare(
        `INSERT INTO native_solution_discovery_corrections
          (event_key, action, delivery_digest, announcement_id, source_sequence, entry_digest, created_at)
         VALUES (?, 'available', ?, ?, ?, ?, ?)`,
      ).run(key, delivery.record_digest, announcementId, receipt.sequence, receipt.entryDigest, timestamp);
    }
  };
  const requesterSources = config.sources.filter(({ role }) => role === 'requester');
  if (requesterSources.length !== 1) throw new Error('native solver requires exactly one requester source');
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
      await input.trust.assertFresh();
      const facts = object(discoveryInput.announcement.facts, 'requester facts');
      const association = object(facts[ASSOCIATION], 'requester association');
      const authorityTime = parseNativeAuthorityTimeAnchor(association['authorityTime']);
      if (!await input.infrastructure.authorityTime.verifyFinalized(authorityTime)) {
        throw new Error('native requester authority time is not canonical and finalized');
      }
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
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  let workFailure: unknown;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await input.lease.renew();
      claim.renewWorker();
      await syncVenue();
      await reconcileSignedReorgCorrections();
      await discovery.sync();
      for (const withdrawal of discovery.takePendingWithdrawals()) {
        const target = store.db.prepare(
          `SELECT id, card_json FROM native_discovery_cards
            WHERE source_agent = ? AND source_name = ? AND announcement_id = ?
            ORDER BY id DESC LIMIT 1`,
        ).get(withdrawal.source.agent, withdrawal.source.name, withdrawal.retracts) as {
          id: number; card_json: string;
        } | undefined;
        if (target === undefined) throw new Error('requester withdrawal target is absent from authenticated history');
        const card = JSON.parse(target.card_json) as {
          record?: { digest?: string };
          facts?: Record<string, unknown>;
        };
        const taskDigest = card.facts?.['taskDigest'];
        const submissionDigest = card.record?.digest;
        if (typeof taskDigest === 'string' && typeof submissionDigest === 'string') {
          store.db.prepare(
            `UPDATE native_engagements SET state = 'withdrawn', updated_at = ?
              WHERE task_digest = ? AND submission_digest = ?
                AND state IN ('discovered', 'eligible')`,
          ).run(new Date().toISOString(), taskDigest, submissionDigest);
        }
        store.db.prepare(
          `UPDATE native_discovery_cards SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL`,
        ).run(new Date().toISOString(), target.id);
        discovery.acknowledgeWithdrawal(withdrawal);
      }
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
          profileUri: 'https://spec.jinn.network/task-profiles/prediction-forecast/1.0',
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
        timer = setInterval(() => {
          void tick().catch((cause: unknown) => {
            workFailure = cause;
            stopped = true;
            if (timer !== undefined) clearInterval(timer);
          });
        }, 5_000);
        timer.unref();
      },
      stop: stopOwned,
      failure: () => workFailure,
    },
  });
  scope.release();
  return host;
  } catch (cause) {
    return scope.unwind(cause);
  }
}
