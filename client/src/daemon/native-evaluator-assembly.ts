/**
 * Shared native-evaluator composition assembly (one-swap M4a, umbrella #2461, DR-2026-08-05).
 *
 * The evaluator's subject-authority claim, its DSSE delivery-authority ports, and the
 * `buildNativeEvaluatorComposition` call are identical whether the evaluator runs as the STANDALONE
 * production host (`native-evaluator-production.ts`, its own Store + `NativeInfrastructurePrimitives`
 * write session) or as one role of the ONE fleet daemon (`native-fleet-evaluator.ts`, the shared
 * Store + the fleet composition's own venue verdict ports). This is the M2 pattern applied to the
 * evaluator: one assembly, two callers, no drift — `native-base-sepolia-infrastructure.ts` already
 * exports `createSolverReads`/`createBaseSepoliaEvaluatorReads` for the same reason, and this module
 * does it for the product-authority half the readers cannot supply.
 *
 * What each caller still constructs itself and hands in: the `NativeEvaluatorStateRepository`, the
 * evidence ports, the pinned Node launcher deployment, the opportunity reader, the venue
 * `VerdictPorts`, and the evaluator chain reads. What is identical and therefore lives here: the
 * evaluation-task profile/profileStore, the workspace runtime, the subject authority, the authority
 * claim, and the verdict-verification dependency bundle.
 */
import {
  type SettlementGradeVerification,
} from '@jinn-network/marketplace-binding';
import {
  checkAdmissionReceipt,
  DsseEnvelopeSchema,
  buildEvaluationTaskProfile,
  sealTaskProfile,
} from '@jinn-network/task-execution-profiles';
import {
  SubmissionRecordSchema,
} from '@jinn-network/task-execution-protocol';
import {
  parseDsseEnvelope,
  verifyEnvelopeBinding,
} from '@jinn-network/trust-core';
import type { VerdictPorts } from '@jinn-network/marketplace-venue-base';
import type { EvidenceBindingPorts } from '@jinn-network/task-execution-backend-local';
import { buildInfo } from '../build-info.js';
import type { NativeEnvelopeAuthorityPort } from '../evaluator/native-verdict-verification.js';
import { createVerdictGate } from '../evaluator/verdict-gate.js';
import {
  buildNativeEvaluatorComposition,
  type NativeEvaluationMethodDigests,
  type NativeEvaluatorComposition,
  type NativeGraderReportBinding,
} from './native-evaluator-composition.js';
import type { NativeEvaluatorOpportunityReader } from './native-evaluator-opportunity-source.js';
import type { NativeEvaluatorReadPrimitives } from './native-infrastructure-bundle.js';
import { NativeEvaluatorStateRepository, type NativeEvaluationRow } from './native-evaluator-state.js';
import {
  buildNativeWorkspaceRuntime,
} from './native-solver-backend.js';
import { NativeTrustCatalogReadError, type NativeTrustAuthority } from './native-trust-catalog.js';
import type { RoleIdentitySet } from './role-identities.js';

const DELIVERY_PAYLOAD_TYPE = 'application/vnd.jinn.marketplace.executor-binding.v1+json';

/** A signed public record source as configured (`recordSources`, or the standalone `sources`). */
export interface NativeEvaluatorConfiguredSource {
  readonly role: 'requester' | 'solver' | 'evaluator';
  readonly agent: string;
  readonly name: string;
  readonly baseUrl: string;
}

/** The pinned Node launcher deployment `buildPinnedNodeLauncherDeployment` returns. */
export interface NativeEvaluatorLauncherDeployment {
  readonly executable: { readonly path: string; readonly digest: string };
  probe(): Promise<{ readonly ready: boolean; readonly executable: { readonly path: string; readonly digest: string } }>;
}

export function refusedSettlementGrade(detail: string): SettlementGradeVerification {
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

export function deliveryAuthority(input: {
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

/**
 * The evaluator's subject-authority claim builder. Identical for both callers: it reads the durable
 * evaluation's exact subject artifacts and the opportunity reader's signed requester association,
 * and asserts the subject Submission's requester equals the signed requester source Agent.
 */
export function buildNativeEvaluatorAuthorityClaim(input: {
  readonly state: NativeEvaluatorStateRepository;
  readonly opportunities: NativeEvaluatorOpportunityReader;
  readonly roles: RoleIdentitySet;
  readonly sources: readonly NativeEvaluatorConfiguredSource[];
  readonly safeAddress: string;
}) {
  const solverSources = input.sources.filter(({ role }) => role === 'solver');
  if (solverSources.length !== 1) throw new Error('native evaluator requires one solver authority source');
  return async (evaluation: NativeEvaluationRow) => {
    // #2533: keyed by the posting, which the durable evaluation row already carries. Keying by
    // `subjectTaskDigest` selected an arbitrary posting once a deterministic specification was
    // posted more than once.
    const association = input.opportunities.association(evaluation);
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
        address: input.safeAddress,
      },
    };
  };
}

/**
 * The evaluator's subject-authority dependency bundle. Identical for both callers: it pins the
 * evaluator declaration to this operator's own scoped custody and verifies on-chain authority.
 */
export function buildNativeEvaluatorSubjectAuthority(input: {
  readonly roles: RoleIdentitySet;
  readonly trust: NativeTrustAuthority;
  readonly safeAddress: string;
}) {
  return {
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
            || value.address.toLowerCase() !== input.safeAddress.toLowerCase())) {
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
          // A transient chain-read failure (the `Safe.isOwner` RPC could not complete) is flagged
          // so the evaluator retries it rather than terminalizing a passing subject; every other
          // failure here is a deterministic refusal and stays terminal.
          return { ok: false as const, reason: String(cause), transient: cause instanceof NativeTrustCatalogReadError };
        }
      },
    },
  };
}

export interface NativeEvaluatorAssemblyInput {
  readonly roles: RoleIdentitySet;
  readonly state: NativeEvaluatorStateRepository;
  readonly trust: NativeTrustAuthority;
  readonly evidence: EvidenceBindingPorts;
  readonly launcherDeployment: NativeEvaluatorLauncherDeployment;
  readonly opportunities: NativeEvaluatorOpportunityReader;
  readonly verdictPorts: VerdictPorts;
  readonly chainReads: Pick<NativeEvaluatorReadPrimitives, 'chain' | 'preSettlementClaimTime' | 'blockTime'>;
  readonly identity: {
    readonly safeAddress: string;
    readonly marketplaceAgentAddress: string;
    readonly agentIri: string;
    readonly taskCoordinator: `0x${string}`;
    readonly publicBaseUrl: string;
    /** Root the evaluator backend/publisher directories hang off. */
    readonly stateDir: string;
    readonly sources: readonly NativeEvaluatorConfiguredSource[];
  };
  readonly deployment: {
    readonly module: string;
    readonly moduleDigest: `sha256:${string}`;
    readonly signerHandle: string;
    readonly evaluationMethodDigest: NativeEvaluationMethodDigests;
  };
  /** Prediction-only (empty) for M4a; M4c wires container-graded registrations. */
  readonly graderReportSources?: Readonly<Record<string, NativeGraderReportBinding>>;
}

/**
 * Assembles the bridge-free evaluator composition over the caller-supplied durable state, evidence,
 * venue verdict ports and chain reads. This is the exact `buildNativeEvaluatorComposition(...)` call
 * the standalone production host ran inline, extracted verbatim so the fleet path cannot drift from
 * it.
 */
export async function assembleNativeEvaluatorComposition(
  input: NativeEvaluatorAssemblyInput,
): Promise<NativeEvaluatorComposition> {
  const { identity } = input;
  const evaluationProfile = buildEvaluationTaskProfile();
  const evaluationProfileDigest = sealTaskProfile(evaluationProfile).digest;
  const subjectAuthority = buildNativeEvaluatorSubjectAuthority({
    roles: input.roles,
    trust: input.trust,
    safeAddress: identity.safeAddress,
  });
  return buildNativeEvaluatorComposition({
    roles: input.roles,
    state: input.state,
    coordinatorAddress: identity.taskCoordinator,
    evaluatorAddress: identity.safeAddress as `0x${string}`,
    operatorIdentity: {
      safeAddress: identity.safeAddress,
      agentEoa: identity.marketplaceAgentAddress,
      agentIri: identity.agentIri,
    },
    deployment: {
      module: input.deployment.module,
      moduleDigest: input.deployment.moduleDigest,
      signerHandle: input.deployment.signerHandle,
      evaluationMethodDigest: input.deployment.evaluationMethodDigest,
    },
    ...(input.graderReportSources === undefined ? {} : { graderReportSources: input.graderReportSources }),
    backend: {
      stateRoot: `${identity.stateDir}/evaluator-backend`,
      // #36. `source` and `executor` are TWO separate `agent`-kind identities in the evidence
      // graph the backend records (the backend-local evidence join derives the recording's
      // `producer` descriptor from `source`, and gives it a different descriptor name than the
      // `executor` one), so passing one IRI for both makes the execution recorder refuse the
      // recording outright — which, under `recorderAvailability: "always"`, terminalized CP6
      // grading 122ms in, before the harness ever spawned. Same split the solver backend has
      // always used (`composition-root.ts`): `executor` is the runtime that ran the attempt,
      // `source` is the operator identity it ran as. `source` deliberately stays the persistent
      // agent IRI — it is also the protocol observation envelope source that an attempt log's
      // authoritative-source pin is keyed on, so changing it would orphan in-flight observations.
      source: identity.agentIri,
      executor: `urn:jinn:operator-runtime:${buildInfo.implVersion}`,
      profileStore: { get: (candidate) => candidate === evaluationProfileDigest ? evaluationProfile : undefined },
      launcherDeployment: input.launcherDeployment,
      workspaceRuntime: buildNativeWorkspaceRuntime(),
      evidence: input.evidence,
      maxConcurrentAttempts: 1,
    },
    publisher: {
      rootDir: `${identity.stateDir}/public/evaluator`,
      publicBaseUrl: identity.publicBaseUrl,
    },
    opportunities: input.opportunities.source,
    subject: { fetcher: input.opportunities.fetcher },
    authority: {
      claim: buildNativeEvaluatorAuthorityClaim({
        state: input.state,
        opportunities: input.opportunities,
        roles: input.roles,
        sources: identity.sources,
        safeAddress: identity.safeAddress,
      }),
      dependencies: subjectAuthority,
    },
    deadline: (evaluation) => input.opportunities.deadline(evaluation, evaluation.createdAt),
    verdictPorts: input.verdictPorts,
    chain: input.chainReads.chain,
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
      preSettlementClaimTime: input.chainReads.preSettlementClaimTime,
      blockTime: input.chainReads.blockTime,
    },
  });
}
