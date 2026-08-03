import { join } from 'node:path';
import {
  type SettlementGradeVerification,
} from '@jinn-network/marketplace-binding';
import {
  buildEvaluationTaskProfile,
  checkAdmissionReceipt,
  DsseEnvelopeSchema,
  sealTaskProfile,
} from '@jinn-network/task-execution-profiles';
import {
  SubmissionRecordSchema,
  documentDigest,
} from '@jinn-network/task-execution-protocol';
import {
  parseDsseEnvelope,
  verifyEnvelopeBinding,
} from '@jinn-network/trust-core';
import type { NativeEnvelopeAuthorityPort } from '../evaluator/native-verdict-verification.js';
import { createVerdictGate } from '../evaluator/verdict-gate.js';
import { Store } from '../store/store.js';
import {
  NativeCanonicalObservationRepository,
  NativeMarketplaceEventRepository,
  syncNativeMarketplaceEvents,
} from './native-canonical-observations.js';
import { buildNativeEvaluatorComposition } from './native-evaluator-composition.js';
import {
  buildNativeEvaluatorOpportunityReader,
  type NativeEvaluatorOpportunityReader,
} from './native-evaluator-opportunity-source.js';
import { NativeEvaluatorStateRepository, type NativeEvaluationRow } from './native-evaluator-state.js';
import type {
  NativeEvaluatorWritePrimitives,
  NativeInfrastructurePrimitives,
} from './native-infrastructure-bundle.js';
import { createNativeOperatorHost, type NativeOperatorHost } from './native-operator-host.js';
import type { NativeProductConfig } from './native-product-config.js';
import {
  buildNativeWorkspaceRuntime,
  buildPinnedNodeLauncherDeployment,
} from './native-solver-backend.js';
import { openOperatorEvidence } from './evidence-join.js';
import type { NativeTrustAuthority } from './native-trust-catalog.js';
import type { RoleIdentitySet } from './role-identities.js';
import { NativeConstructionScope } from './native-construction-scope.js';

const DELIVERY_PAYLOAD_TYPE = 'application/vnd.jinn.marketplace.executor-binding.v1+json';

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

function refusedSettlementGrade(detail: string): SettlementGradeVerification {
  return {
    executorBinding: { status: 'invalid', detail },
    dispatchBinding: { status: 'failed', detail },
    evaluationSpecification: { status: 'failed', detail },
  };
}

function oneArtifact(state: NativeEvaluatorStateRepository, evaluation: NativeEvaluationRow, role: string) {
  const values = state.listSubjectArtifacts(evaluation.evaluationId).filter((value) => value.role === role);
  if (values.length !== 1) throw new Error(`evaluation ${evaluation.evaluationId} has no unique ${role}`);
  return values[0]!;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`${label} is not exact UTF-8 JSON: ${String(cause)}`);
  }
}

function uniqueSigner(bytes: Uint8Array, label: string): string {
  const envelope = parseDsseEnvelope(bytes);
  const signers = [...new Set(envelope.signatures.map(({ keyid }) => keyid).filter(
    (keyid): keyid is string => typeof keyid === 'string' && keyid.length > 0,
  ))];
  if (signers.length !== 1) throw new Error(`${label} does not have exactly one signer identity`);
  return signers[0]!;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function deliveryAuthority(input: {
  readonly trust: NativeTrustAuthority;
  readonly policyPurpose: string;
}): NativeEnvelopeAuthorityPort {
  return {
    async verify(value) {
      try {
        const envelope = parseDsseEnvelope(value.envelopeBytes);
        if (envelope.payloadType !== DELIVERY_PAYLOAD_TYPE) {
          return { ok: false, reason: 'delivery-envelope-payload-type-mismatch' };
        }
        if (!sameBytes(envelope.payloadBytes, value.payloadBytes)) {
          return { ok: false, reason: 'delivery-envelope-payload-mismatch' };
        }
        const result = await verifyEnvelopeBinding({
          envelopeBytes: value.envelopeBytes,
          key: value.signerKey,
          agent: value.agent,
          family: value.family,
          atTime: value.atTime,
        }, {
          bindingResolver: input.trust.bindingResolver,
          witnessVerifier: input.trust.witnessVerifier,
          dsseVerifier: input.trust.dsseVerifier,
          policy: input.trust.policy(input.policyPurpose),
        });
        return result.ok
          ? { ok: true }
          : { ok: false, reason: `${result.reason ?? 'binding-refused'}${result.detail === undefined ? '' : `:${result.detail}`}` };
      } catch (cause) {
        return { ok: false, reason: `delivery-authority-dependency:${String(cause)}` };
      }
    },
  };
}

function authorityClaim(input: {
  readonly state: NativeEvaluatorStateRepository;
  readonly opportunities: NativeEvaluatorOpportunityReader;
  readonly config: NativeProductConfig['operator']['native'];
  readonly roles: RoleIdentitySet;
}) {
  const solverSources = input.config.sources.filter(({ role }) => role === 'solver');
  if (solverSources.length !== 1) throw new Error('native evaluator requires one solver authority source');
  return async (evaluation: NativeEvaluationRow) => {
    const association = input.opportunities.association(evaluation.subjectTaskDigest);
    if (association === undefined) throw new Error('signed requester authority metadata is unavailable');
    const submission = SubmissionRecordSchema.parse(parseJson(
      oneArtifact(input.state, evaluation, 'submission').bytes,
      'subject Submission',
    ));
    if (submission.requester !== association.requesterAgent) {
      throw new Error('subject requester does not equal the signed requester source Agent');
    }
    const task = oneArtifact(input.state, evaluation, 'task');
    const evaluationSpec = oneArtifact(input.state, evaluation, 'evaluation-spec');
    const receiptArtifact = oneArtifact(input.state, evaluation, 'admission-receipt');
    const receiptEnvelope = DsseEnvelopeSchema.parse(parseJson(receiptArtifact.bytes, 'admission receipt'));
    const receipt = checkAdmissionReceipt({
      envelope: receiptEnvelope,
      expectedTaskDigest: task.digest,
      expectedEvaluationSpecDigest: evaluationSpec.digest,
    });
    if (!receipt.ok) throw new Error(`admission receipt is not authoritative: ${receipt.reason}`);
    const requesterEnvelope = oneArtifact(input.state, evaluation, 'requester-envelope');
    const solutionEnvelope = oneArtifact(input.state, evaluation, 'solution-delivery-envelope');
    const evaluator = input.roles.get('evaluator-verdict');
    return {
      requester: {
        signerKey: uniqueSigner(requesterEnvelope.bytes, 'requester envelope'),
        sealingTime: association.sealedAt,
      },
      admission: {
        signerKey: uniqueSigner(receiptArtifact.bytes, 'admission receipt'),
        effectiveTime: association.sealedAt,
      },
      executor: {
        signerKey: uniqueSigner(solutionEnvelope.bytes, 'solution Delivery envelope'),
        agent: solverSources[0]!.agent,
        declarationKey: input.opportunities.settlementDeclarationKey(evaluation.advertisedDeliveryDigest),
        address: evaluation.solutionOperator,
      },
      evaluator: {
        signerKey: evaluator.keyId,
        agent: input.roles.agent,
        declarationKey: input.roles.get('evaluator-settlement').keyId,
        address: input.config.safeAddress,
      },
    };
  };
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
  const opportunities = await buildNativeEvaluatorOpportunityReader({
    config,
    store,
    trust: input.trust,
    infrastructure: input.infrastructure,
    events: marketplaceEvents,
    syncVenue,
  });
  const evaluationProfile = buildEvaluationTaskProfile();
  const evaluationProfileDigest = sealTaskProfile(evaluationProfile).digest;
  const deployment = await buildPinnedNodeLauncherDeployment(
    config.runtime.nodeExecutableDigest as `sha256:${string}`,
  );
  if (!(await deployment.probe()).ready) throw new Error('pinned evaluator Node launcher is not ready');
  const subjectAuthority = {
    bindingResolver: input.trust.bindingResolver,
    witnessVerifier: input.trust.witnessVerifier,
    dsseVerifier: input.trust.dsseVerifier,
    requesterPolicy: input.trust.policy('native:requester-submission'),
    admissionAgentPolicy: input.trust.policy('admission-agent'),
    executorPolicy: input.trust.policy('native:solver-delivery'),
    evaluatorAuthority: {
      async resolve(value: {
        readonly signerKey: string;
        readonly declarationKey: string;
        readonly agent: string;
        readonly address: string;
        readonly atTime: string;
        readonly purpose: 'native:solver-settlement' | 'native:evaluator-settlement';
      }) {
        if (value.purpose === 'native:evaluator-settlement'
          && (value.signerKey !== input.roles.get('evaluator-verdict').keyId
            || value.declarationKey !== input.roles.get('evaluator-settlement').keyId
            || value.agent !== input.roles.agent
            || value.address.toLowerCase() !== config.safeAddress.toLowerCase())) {
          return { ok: false as const, reason: 'evaluator declaration does not equal scoped custody/configuration' };
        }
        try {
          await input.trust.verifyOnchainAuthority({
            key: value.declarationKey,
            agent: value.agent,
            address: value.address as `0x${string}`,
            atTime: value.atTime,
            purpose: value.purpose,
          });
          return { ok: true as const };
        } catch (cause) {
          return { ok: false as const, reason: String(cause) };
        }
      },
    },
  };
  const evaluatorRead = input.infrastructure.evaluator;
  const composition = await buildNativeEvaluatorComposition({
    roles: input.roles,
    state,
    coordinatorAddress: config.contracts.taskCoordinator as `0x${string}`,
    evaluatorAddress: config.safeAddress as `0x${string}`,
    operatorIdentity: {
      safeAddress: config.safeAddress,
      agentEoa: config.marketplaceAgentAddress,
      agentIri: config.agent,
    },
    deployment: {
      module: config.evaluator.deploymentModule,
      moduleDigest: config.evaluator.moduleDigest as `sha256:${string}`,
      signerHandle: config.evaluator.signerHandle,
      evaluationMethodDigest: config.evaluator.evaluationMethodDigest as `sha256:${string}`,
    },
    backend: {
      stateRoot: join(config.stateDir, 'evaluator-backend'),
      source: config.agent,
      executor: config.agent,
      profileStore: { get: (candidate) => candidate === evaluationProfileDigest ? evaluationProfile : undefined },
      launcherDeployment: deployment,
      workspaceRuntime: buildNativeWorkspaceRuntime(),
      evidence: evidence.ports,
      maxConcurrentAttempts: 1,
    },
    publisher: {
      rootDir: join(config.stateDir, 'public', 'evaluator'),
      publicBaseUrl: config.publicBaseUrl,
    },
    opportunities: opportunities.source,
    subject: { fetcher: opportunities.fetcher },
    authority: {
      claim: authorityClaim({ state, opportunities, config, roles: input.roles }),
      dependencies: subjectAuthority,
    },
    deadline: (evaluation) => opportunities.deadline(evaluation.subjectTaskDigest, evaluation.createdAt),
    verdictPorts: writes.verdict,
    chain: evaluatorRead.chain,
    verification: {
      gate: createVerdictGate({
        bindingResolver: input.trust.bindingResolver,
        witnessVerifier: input.trust.witnessVerifier,
        dsseVerifier: input.trust.dsseVerifier,
        admissionAgentPolicy: input.trust.policy('admission-agent'),
        evaluatorPolicy: input.trust.policy('evaluator-eligibility'),
        requesterPolicy: input.trust.policy('native:requester-submission'),
      }),
      solutionDeliveryAuthority: deliveryAuthority({
        trust: input.trust,
        policyPurpose: 'native:solver-delivery',
      }),
      evaluationDeliveryAuthority: deliveryAuthority({
        trust: input.trust,
        policyPurpose: 'native:evaluator-verdict',
      }),
      preSettlementClaimTime: evaluatorRead.preSettlementClaimTime,
      blockTime: evaluatorRead.blockTime,
    },
  });
  scope.defer(composition.close);
  const endpoint = await input.infrastructure.mountPublicSource(composition.publisher.handler);
  scope.defer(endpoint.close);
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  let workFailure: unknown;
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
  const stopOwned = closeAll([
    async () => { stopped = true; if (timer !== undefined) clearInterval(timer); },
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
          && capabilities.taskProfiles.includes('https://jinn.network/task-profiles/evaluation-task/1.0');
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

function sourceId(source: NativeProductConfig['operator']['native']['sources'][number]): string {
  return `${source.agent}/${source.name}`;
}
