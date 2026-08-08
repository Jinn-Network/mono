import { join } from 'node:path';
import { Store } from '../store/store.js';
import {
  NativeCanonicalObservationRepository,
  NativeMarketplaceEventRepository,
  syncNativeMarketplaceEvents,
} from './native-canonical-observations.js';
import {
  assembleNativeEvaluatorComposition,
  refusedSettlementGrade,
} from './native-evaluator-assembly.js';
import {
  buildNativeEvaluatorOpportunityReader,
} from './native-evaluator-opportunity-source.js';
import { NativeEvaluatorStateRepository } from './native-evaluator-state.js';
import type {
  NativeEvaluatorWritePrimitives,
  NativeInfrastructurePrimitives,
} from './native-infrastructure-bundle.js';
import { createNativeWorkLoop } from './native-work-loop.js';
import { createNativeOperatorHost, type NativeOperatorHost } from './native-operator-host.js';
import type { NativeProductConfig } from './native-product-config.js';
import {
  buildPinnedNodeLauncherDeployment,
} from './native-solver-backend.js';
import { openOperatorEvidence } from './evidence-join.js';
import type { NativeTrustAuthority } from './native-trust-catalog.js';
import type { RoleIdentitySet } from './role-identities.js';
import { NativeConstructionScope } from './native-construction-scope.js';

interface EvaluatorProductionInput {
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

function closeAll(actions: readonly (() => void | Promise<void>)[]): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const action of actions) {
      try { await action(); } catch (cause) { failures.push(cause); }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'native evaluator cleanup failed');
  };
}

/** Complete, bridge-free evaluator product graph using the B7 durable coordinator. */
export async function buildNativeEvaluatorProductionHost(
  input: EvaluatorProductionInput,
): Promise<NativeOperatorHost> {
  const scope = new NativeConstructionScope();
  try {
  const config = input.config.operator.native;
  if (config.role !== 'evaluator'
    || config.evaluator === undefined
    || config.identityStores.evaluator === undefined
    || config.marketplaceAgentAddress === undefined
    || input.infrastructure.evaluator === undefined) {
    throw new Error('native evaluator structured deployment/custody/chain reads are incomplete');
  }
  const store = new Store(join(config.stateDir, 'evaluator.sqlite'));
  scope.defer(() => store.close());
  const state = new NativeEvaluatorStateRepository(store);
  const observations = new NativeCanonicalObservationRepository(store);
  const marketplaceEvents = new NativeMarketplaceEventRepository(store);
  const evidence = await openOperatorEvidence({ rootDir: join(config.stateDir, 'evaluator-evidence') });
  scope.defer(evidence.close);
  const writeSession = await input.infrastructure.activateWrites({
    role: 'evaluator',
    password: input.password,
    expectedOwnerAddress: config.evmCustody.expectedOwnerAddress as `0x${string}`,
    accountIndex: config.evmCustody.accountIndex,
    venueAuthority: {
      verifySettlementGrade: async () => refusedSettlementGrade(
        'evaluator role never owns solution-settlement authority',
      ),
      observations: async () => observations.read(),
      isAuthorizedMechOrigin: (candidate) =>
        candidate.toLowerCase() === config.marketplaceAgentAddress!.toLowerCase(),
    },
  });
  scope.defer(writeSession.close);
  if (writeSession.writes.role !== 'evaluator') {
    await writeSession.close();
    throw new Error('native evaluator write activation returned another role');
  }
  const writes = writeSession.writes as NativeEvaluatorWritePrimitives;
  const syncVenue = async () => {
    await syncNativeMarketplaceEvents({
      venue: writeSession.venue,
      repository: marketplaceEvents,
      chain: chain(config),
      isAuthorizedMechOrigin: (candidate) =>
        candidate.toLowerCase() === config.marketplaceAgentAddress!.toLowerCase(),
    });
  };
  const evaluatorRead = input.infrastructure.evaluator;
  const opportunities = await buildNativeEvaluatorOpportunityReader({
    sources: config.sources,
    jinnRouter: config.contracts.jinnRouter as `0x${string}`,
    store,
    trust: input.trust,
    infrastructure: {
      records: input.infrastructure.records,
      authorityTime: input.infrastructure.authorityTime,
      evaluator: evaluatorRead,
    },
    events: marketplaceEvents,
    syncVenue,
  });
  const deployment = await buildPinnedNodeLauncherDeployment(
    config.runtime.nodeExecutableDigest as `sha256:${string}`,
  );
  if (!(await deployment.probe()).ready) throw new Error('pinned evaluator Node launcher is not ready');
  const composition = await assembleNativeEvaluatorComposition({
    roles: input.roles,
    state,
    trust: input.trust,
    evidence: evidence.ports,
    launcherDeployment: deployment,
    opportunities,
    verdictPorts: writes.verdict,
    chainReads: evaluatorRead,
    identity: {
      safeAddress: config.safeAddress,
      marketplaceAgentAddress: config.marketplaceAgentAddress,
      agentIri: config.agent,
      taskCoordinator: config.contracts.taskCoordinator as `0x${string}`,
      publicBaseUrl: config.publicBaseUrl,
      stateDir: config.stateDir,
      sources: config.sources,
    },
    deployment: {
      module: config.evaluator.deploymentModule,
      moduleDigest: config.evaluator.moduleDigest as `sha256:${string}`,
      signerHandle: config.evaluator.signerHandle,
      // Branded `NativeEvaluationMethodDigests` (single digest or per-registration map) straight
      // from the config — no cast (native-product-config.ts brands it).
      evaluationMethodDigest: config.evaluator.evaluationMethodDigest,
    },
    // Container-graded registrations (swe-rebench-v2) declare their binding here; a missing binding
    // for a container-graded registration is refused at composition (one-swap M4c, #2467). Omitted
    // for a prediction-only deployment, leaving today's boot path unchanged.
    ...(config.evaluator.graderReportSources === undefined
      ? {}
      : { graderReportSources: config.evaluator.graderReportSources }),
  });
  scope.defer(composition.close);
  const endpoint = await input.infrastructure.mountPublicSource(composition.publisher.handler);
  scope.defer(endpoint.close);
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await input.lease.renew();
      await composition.tick();
    } finally {
      running = false;
    }
  };
  const workLoop = createNativeWorkLoop({ label: 'native-evaluator', tick });
  const stopOwned = closeAll([
    async () => { stopped = true; workLoop.stop(); },
    endpoint.close,
    composition.close,
    evidence.close,
    () => store.close(),
  ]);
  const closeVenue = closeAll([writeSession.close, input.infrastructure.close]);
  const host = createNativeOperatorHost({
    role: 'evaluator',
    roleKeyIds: {
      'evaluator-verdict': input.roles.get('evaluator-verdict').keyId,
      'evaluator-settlement': input.roles.get('evaluator-settlement').keyId,
      'evaluator-discovery': input.roles.get('evaluator-discovery').keyId,
    },
    lease: input.lease,
    bindings: {
      async verify() {
        await input.trust.assertFresh();
        for (const role of ['evaluator-verdict', 'evaluator-settlement', 'evaluator-discovery'] as const) {
          const decision = await input.roles.resolveEffective(role, new Date().toISOString());
          if (!decision.ok) throw new Error(`native ${role} authority is not effective: ${decision.reason}`);
        }
      },
    },
    venue: {
      rollbackToFinalized: async () => { await syncVenue(); },
      health: writeSession.venue.health,
      close: closeVenue,
    },
    operations: {
      reconcileTransactions: async () => { await composition.coordinator.reconcileStartup(); },
      reconcilePublications: async () => { await composition.coordinator.reconcileStartup(); },
      uncertainCount() {
        return (store.db.prepare(
          `SELECT count(*) AS count FROM native_evaluation_operations
            WHERE status = 'broadcast' AND tx_hash IS NULL`,
        ).get() as { count: number }).count;
      },
    },
    discovery: {
      async sync() {
        await opportunities.syncSignedSources();
        return { lag: 0, bySource: Object.fromEntries(config.sources.map((source) => [sourceId(source), 0])) };
      },
    },
    recovery: { recoverBackends: async () => { await composition.coordinator.reconcileStartup(); } },
    readiness: {
      backendRequired: true,
      evidenceRequired: true,
      executableDigest: `sha256:${deployment.executable.digest}`,
      async backend() {
        const capabilities = await composition.backend.capabilities();
        return capabilities.signedDeliveries
          && capabilities.taskProfiles.includes('https://spec.jinn.network/task-profiles/evaluation-task/1.0');
      },
      async evidence() {
        await evidence.runtime.sync();
        const status = await evidence.runtime.getStatus();
        return status.state === 'ready'
          && status.terminalFailureCount === 0
          && status.transientFailure === undefined;
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

function sourceId(source: NativeProductConfig['operator']['native']['sources'][number]): string {
  return `${source.agent}/${source.name}`;
}
