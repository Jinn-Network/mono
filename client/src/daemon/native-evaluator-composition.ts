import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EvidenceBindingPorts } from "@jinn-network/task-execution-backend-local";
import {
  makeLocalTaskExecutionBackend,
  type LocalProvisionerInput,
  type LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
} from "@jinn-network/task-execution-backend-local";
import {
  makeEvaluationLauncher,
  type EvaluationHarnessDeployment,
  type EvaluatorRegistration,
} from "@jinn-network/task-execution-evaluation-harness";
import { PREDICTION_REGISTRATION_ID } from "@jinn-network/task-execution-evaluator-adapters";
import {
  EVALUATION_SPEC_MEDIA_TYPE,
  EVALUATION_TASK_PROFILE_URI,
  buildEvaluationTaskProfile,
  sealTaskProfile,
  type ProfileStore,
} from "@jinn-network/task-execution-profiles";
import {
  SubmissionRecordSchema,
  documentDigest,
} from "@jinn-network/task-execution-protocol";
import {
  makeDirProvisioner,
  type WorkspaceRuntimePorts,
} from "@jinn-network/task-execution-workspace";
import type { VerdictPorts } from "@jinn-network/marketplace-venue-base";
import {
  mapFinalizedSolutionDeliveryObservation,
  type FinalizedSolutionDeliveryObservation,
} from "../evaluator/opportunities.js";
import type { OperatorIdentity } from "../evaluator/self-evaluation.js";
import {
  acquireSubjectMaterial,
  type FetchBytesByDigest,
  type SubjectMaterialReferences,
} from "../evaluator/subject-material.js";
import {
  buildNativeEvaluatorVerdictVerification,
  type NativeVerdictVerificationDependencies,
} from "../evaluator/native-verdict-verification.js";
import type {
  NativeSubjectAuthorityClaim,
  NativeSubjectAuthorityDependencies,
} from "../evaluator/native-subject-authority.js";
import {
  NativeEvaluatorCoordinator,
  type NativeEvaluatorChainReconciliationPort,
  type NativeEvaluatorCoordinatorResult,
} from "./native-evaluator-coordinator.js";
import {
  openNativeEvaluatorPublisher,
  type NativeEvaluatorPublisher,
} from "./native-evaluator-publisher.js";
import {
  NativeEvaluatorStateRepository,
  type NativeEvaluationRow,
} from "./native-evaluator-state.js";
import type { RoleIdentitySet } from "./role-identities.js";

type LauncherDeployment = NonNullable<LocalTaskExecutionBackendConfig["launcherDeployments"]>[string];

export type NativeEvaluatorSourceEvent =
  | {
      readonly kind: "solution-available";
      readonly observation: FinalizedSolutionDeliveryObservation;
      readonly references: SubjectMaterialReferences;
    }
  | {
      readonly kind: "solution-withdrawn";
      readonly source: string;
      readonly sourceSequence: string;
      readonly sourceEntryDigest: `sha256:${string}`;
      readonly canonicalEventIdentity: string;
      readonly reason: string;
    };

export interface NativeEvaluatorOpportunitySource {
  /** Exact signed discovery origin consumed by this role. */
  readonly sourceId: string;
  read(input: {
    readonly after?: { readonly sequence: string; readonly entryDigest: `sha256:${string}` };
  }): Promise<readonly NativeEvaluatorSourceEvent[]>;
}

export interface NativeEvaluatorComposition {
  readonly state: NativeEvaluatorStateRepository;
  readonly backend: LocalTaskExecutionBackend;
  readonly publisher: NativeEvaluatorPublisher;
  readonly coordinator: NativeEvaluatorCoordinator;
  tick(): Promise<{
    readonly sourceEvents: number;
    readonly coordinator: readonly NativeEvaluatorCoordinatorResult[];
  }>;
  close(): Promise<void>;
}

export interface NativeEvaluatorCompositionInput {
  readonly roles: RoleIdentitySet;
  readonly state: NativeEvaluatorStateRepository;
  readonly coordinatorAddress: `0x${string}`;
  readonly evaluatorAddress: `0x${string}`;
  readonly operatorIdentity: OperatorIdentity;
  readonly deployment: {
    /** Absolute path or file URL. There is no adapter-empty fallback in native mode. */
    readonly module: string;
    /** Digest of the exact module bytes; rechecked before every secret release. */
    readonly moduleDigest: `sha256:${string}`;
    readonly signerHandle: string;
    readonly evaluationMethodDigest: `sha256:${string}`;
  };
  readonly backend: {
    readonly stateRoot: string;
    readonly source: string;
    readonly executor: string;
    readonly profileStore: ProfileStore;
    readonly launcherDeployment: LauncherDeployment;
    readonly workspaceRuntime: WorkspaceRuntimePorts;
    readonly evidence: EvidenceBindingPorts;
    readonly maxConcurrentAttempts?: number;
    readonly maxArtifactBytes?: number;
    readonly quotaBytes?: number;
    readonly workTtlMs?: number;
    readonly diskFloorBytes?: number;
  };
  readonly publisher: {
    readonly rootDir: string;
    readonly publicBaseUrl: string;
  };
  readonly opportunities: NativeEvaluatorOpportunitySource;
  readonly subject: {
    readonly fetcher: FetchBytesByDigest;
  };
  readonly authority: {
    claim(evaluation: NativeEvaluationRow): Promise<NativeSubjectAuthorityClaim>;
    readonly dependencies: NativeSubjectAuthorityDependencies;
  };
  readonly deadline: (evaluation: NativeEvaluationRow) => string;
  readonly verdictPorts: VerdictPorts;
  readonly chain: NativeEvaluatorChainReconciliationPort;
  readonly verification: NativeVerdictVerificationDependencies;
  /** Construction seam used by composition tests; production omits it. */
  readonly constructBackend?: (config: LocalTaskExecutionBackendConfig) => LocalTaskExecutionBackend;
}

export class NativeEvaluatorCompositionError extends Error {
  override readonly name = "NativeEvaluatorCompositionError";
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new NativeEvaluatorCompositionError(`${label} is required`);
}

function moduleLocation(value: string): { readonly path: string; readonly specifier: string } {
  if (value.startsWith("file:")) {
    const path = fileURLToPath(value);
    if (!isAbsolute(path)) throw new NativeEvaluatorCompositionError("evaluator deployment module must be absolute");
    return { path, specifier: value };
  }
  if (!isAbsolute(value)) {
    throw new NativeEvaluatorCompositionError("evaluator deployment module must be an absolute path or file URL");
  }
  return { path: value, specifier: pathToFileURL(value).href };
}

async function requireModuleDigest(path: string, expected: `sha256:${string}`): Promise<void> {
  const observed = documentDigest(await readFile(path));
  if (observed !== expected) {
    throw new NativeEvaluatorCompositionError(
      `evaluator deployment module digest mismatch: expected ${expected}, got ${observed}`,
    );
  }
}

function methodDigest(registration: EvaluatorRegistration): `sha256:${string}` {
  const sha256 = registration.evaluationMethod.digest?.sha256;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new NativeEvaluatorCompositionError("prediction evaluator method has no canonical sha256 digest");
  }
  return `sha256:${sha256}`;
}

function requireDeployment(value: unknown): EvaluationHarnessDeployment {
  if (typeof value !== "object" || value === null) {
    throw new NativeEvaluatorCompositionError("evaluator deployment module exports no deployment object");
  }
  const deployment = value as Partial<EvaluationHarnessDeployment>;
  if (!Array.isArray(deployment.registrations)
    || !(deployment.parserAllowlist instanceof Set)
    || typeof deployment.evidenceWriter?.putClaimEvidence !== "function"
    || !Number.isSafeInteger(deployment.maxClaimEvidenceBytes)
    || deployment.maxClaimEvidenceBytes! <= 0) {
    throw new NativeEvaluatorCompositionError("evaluator deployment is incomplete or has no real evidence writer/cap");
  }
  return deployment as EvaluationHarnessDeployment;
}

function predictionRegistration(input: {
  readonly deployment: EvaluationHarnessDeployment;
  readonly evaluator: string;
  readonly signerHandle: string;
  readonly evaluationMethodDigest: `sha256:${string}`;
}): EvaluatorRegistration {
  const registrations = input.deployment.registrations.filter(
    ({ registrationId }) => registrationId === PREDICTION_REGISTRATION_ID,
  );
  if (registrations.length !== 1) {
    throw new NativeEvaluatorCompositionError("deployment must contain exactly one prediction evaluator registration");
  }
  const registration = registrations[0]!;
  if (registration.evaluatorIdentity.id !== input.evaluator) {
    throw new NativeEvaluatorCompositionError("prediction evaluator registration names a different persistent agent");
  }
  if (registration.signer.handle !== input.signerHandle) {
    throw new NativeEvaluatorCompositionError("prediction evaluator registration names a different host signer handle");
  }
  if (methodDigest(registration) !== input.evaluationMethodDigest) {
    throw new NativeEvaluatorCompositionError("prediction evaluator registration method digest changed");
  }
  return registration;
}

function digestFromDescriptor(descriptor: { readonly digest?: Readonly<Record<string, string>> }): `sha256:${string}` {
  const sha256 = descriptor.digest?.sha256;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new NativeEvaluatorCompositionError("evaluation input descriptor has no canonical sha256 digest");
  }
  return `sha256:${sha256}`;
}

function stateBackedProvisioner(input: {
  readonly state: NativeEvaluatorStateRepository;
  readonly runtime: WorkspaceRuntimePorts;
  readonly quotaBytes?: number;
  readonly workTtlMs?: number;
  readonly diskFloorBytes?: number;
}): LocalTaskExecutionBackendConfig["provisioner"] {
  return (local: LocalProvisionerInput) => {
    const evaluation = input.state.listEvaluations().find(
      ({ evaluationAttemptUri }) => evaluationAttemptUri === local.attempt.attemptUri,
    );
    if (evaluation === undefined) {
      throw new NativeEvaluatorCompositionError("evaluation Attempt has no durable evaluator aggregate");
    }
    const derived = input.state.getDerivedEvaluation(evaluation.evaluationId);
    if (derived === undefined
      || derived.attemptUri !== local.attempt.attemptUri
      || documentDigest(local.sealedTaskBytes) !== derived.taskDigest
      || documentDigest(derived.submissionBytes) !== derived.submissionDigest
      || !Buffer.from(local.sealedTaskBytes).equals(Buffer.from(derived.taskBytes))) {
      throw new NativeEvaluatorCompositionError("backend input does not equal the durable sealed evaluation pair");
    }
    const artifacts = input.state.listSubjectArtifacts(evaluation.evaluationId);
    const specification = artifacts.filter(({ role }) => role === "evaluation-spec");
    if (specification.length !== 1) {
      throw new NativeEvaluatorCompositionError("durable evaluation has no unique EvaluationSpec");
    }
    const provisioner = makeDirProvisioner({
      sealedTaskBytes: local.sealedTaskBytes,
      dispatchContextBytes: local.dispatchContextBytes,
      runtime: input.runtime,
      ...(input.quotaBytes === undefined ? {} : { quotaBytes: input.quotaBytes }),
      ...(input.workTtlMs === undefined ? {} : { workTtlMs: input.workTtlMs }),
      ...(input.diskFloorBytes === undefined ? {} : { diskFloorBytes: input.diskFloorBytes }),
      async fetchInput(descriptor) {
        const digest = digestFromDescriptor(descriptor);
        const matches = artifacts.filter((artifact) => artifact.digest === digest);
        if (matches.length !== 1) {
          throw new NativeEvaluatorCompositionError(`evaluation input ${descriptor.name} has no unique exact artifact`);
        }
        return matches[0]!.bytes;
      },
    });
    return {
      id: "native-evaluation-dir-v1",
      contract: {
        workspaceKind: provisioner.workspaceKind,
        async setup(view, paths, grants) {
          if (grants.length !== 0) {
            throw new NativeEvaluatorCompositionError("evaluator-sealed Submission must remain grant-free");
          }
          const evaluationSpecInput = {
            name: "evaluation-spec.json",
            digest: { sha256: specification[0]!.digest.slice("sha256:".length) },
            mediaType: EVALUATION_SPEC_MEDIA_TYPE,
          } as NonNullable<typeof view.task.inputs>[number];
          await provisioner.setup({
            ...view,
            task: {
              ...view.task,
              inputs: [...(view.task.inputs ?? []), evaluationSpecInput],
            },
          }, paths, grants);
        },
        executionEnv: provisioner.executionEnv,
        harvest: provisioner.harvest,
      },
    };
  };
}

function effectiveDeadline(state: NativeEvaluatorStateRepository, attemptUri: string): string | undefined {
  const evaluation = state.listEvaluations().find(({ evaluationAttemptUri }) => evaluationAttemptUri === attemptUri);
  if (evaluation === undefined || !["evaluation-finalized", "evaluating"].includes(evaluation.state)) return undefined;
  const derived = state.getDerivedEvaluation(evaluation.evaluationId);
  if (derived === undefined || derived.attemptUri !== attemptUri) return undefined;
  try {
    return SubmissionRecordSchema.parse(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(derived.submissionBytes),
    )).deadline;
  } catch {
    return undefined;
  }
}

/**
 * Production-startable evaluator role. It owns no solver claim runtime and opens no second venue;
 * the caller injects the sole venue owner's scoped verdict ports.
 */
export async function buildNativeEvaluatorComposition(
  input: NativeEvaluatorCompositionInput,
): Promise<NativeEvaluatorComposition> {
  requireNonEmpty(input.backend.source, "evaluator backend source");
  requireNonEmpty(input.backend.executor, "evaluator backend executor");
  requireNonEmpty(input.deployment.signerHandle, "evaluator signer handle");
  if (input.operatorIdentity.agentIri !== input.roles.agent) {
    throw new NativeEvaluatorCompositionError("evaluator operator identity does not equal persistent role authority");
  }
  if (input.operatorIdentity.safeAddress.toLowerCase() !== input.evaluatorAddress.toLowerCase()) {
    throw new NativeEvaluatorCompositionError("evaluator Safe identity does not equal verdict venue authority");
  }
  const evaluationProfile = buildEvaluationTaskProfile();
  const evaluationProfileDigest = sealTaskProfile(evaluationProfile).digest;
  if (input.backend.profileStore.get(evaluationProfileDigest) === undefined) {
    throw new NativeEvaluatorCompositionError("evaluation-task/1.0 profile is not resolvable by the evaluator backend");
  }

  const location = moduleLocation(input.deployment.module);
  await requireModuleDigest(location.path, input.deployment.moduleDigest);
  const loaded = await import(location.specifier) as { readonly evaluationHarnessDeployment?: unknown };
  const deployment = requireDeployment(loaded.evaluationHarnessDeployment);
  const registration = predictionRegistration({
    deployment,
    evaluator: input.roles.agent,
    signerHandle: input.deployment.signerHandle,
    evaluationMethodDigest: input.deployment.evaluationMethodDigest,
  });
  const launcher = makeEvaluationLauncher({
    deploymentModule: location.specifier,
    registrations: [registration],
    selectRegistration: () => registration,
  });

  const hostSecretResolver = input.roles.createEvaluatorHostSecretResolver({
    handle: input.deployment.signerHandle,
    evaluator: input.roles.agent,
    registrationId: PREDICTION_REGISTRATION_ID,
    evaluationMethodDigest: input.deployment.evaluationMethodDigest,
    async authorize(request) {
      await requireModuleDigest(location.path, input.deployment.moduleDigest);
      const evaluation = input.state.listEvaluations().find(
        ({ evaluationAttemptUri }) => evaluationAttemptUri === request.attemptUri,
      );
      if (evaluation === undefined || evaluation.evaluatorAgent !== input.roles.agent) return false;
      const derived = input.state.getDerivedEvaluation(evaluation.evaluationId);
      return derived !== undefined
        && derived.attemptUri === request.attemptUri
        && derived.taskDigest === request.taskDigest
        && derived.submissionUri === request.submission
        && derived.submissionDigest === request.submissionDigest
        && effectiveDeadline(input.state, request.attemptUri) === request.deadline;
    },
  });

  const backendConfig: LocalTaskExecutionBackendConfig = {
    stateRoot: input.backend.stateRoot,
    source: input.backend.source,
    executor: input.backend.executor,
    profileStore: input.backend.profileStore,
    launchers: [launcher],
    launcherDeployments: { [launcher.id]: input.backend.launcherDeployment },
    provisioner: stateBackedProvisioner({
      state: input.state,
      runtime: input.backend.workspaceRuntime,
      ...(input.backend.quotaBytes === undefined ? {} : { quotaBytes: input.backend.quotaBytes }),
      ...(input.backend.workTtlMs === undefined ? {} : { workTtlMs: input.backend.workTtlMs }),
      ...(input.backend.diskFloorBytes === undefined ? {} : { diskFloorBytes: input.backend.diskFloorBytes }),
    }),
    provisionerCapabilities: {
      taskProfiles: [EVALUATION_TASK_PROFILE_URI],
      workspaceKinds: ["dir"],
      inputMediaTypes: ["application/json", EVALUATION_SPEC_MEDIA_TYPE],
      outputMediaTypes: ["application/vnd.in-toto+json"],
      isolation: ["process"],
      ...(input.backend.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: input.backend.maxArtifactBytes }),
    },
    ...(input.backend.maxConcurrentAttempts === undefined
      ? {}
      : { maxConcurrentAttempts: input.backend.maxConcurrentAttempts }),
    recorderAvailability: "always",
    trustKeys: {
      observationSigningKeyConfigured: true,
      deliverySigningKey: input.roles.get("evaluator-verdict"),
    },
    evidence: input.backend.evidence,
    hostSecretResolver,
  };
  const backend = (input.constructBackend ?? makeLocalTaskExecutionBackend)(backendConfig);
  let publisher: NativeEvaluatorPublisher | undefined;
  try {
    publisher = await openNativeEvaluatorPublisher({
      rootDir: input.publisher.rootDir,
      publicBaseUrl: input.publisher.publicBaseUrl,
      source: { agent: input.roles.agent, name: "evaluator-records" },
      signer: input.roles.get("evaluator-discovery"),
    });
    const coordinator = new NativeEvaluatorCoordinator({
      state: input.state,
      backend,
      authority: input.authority,
      deadline: input.deadline,
      evaluatorAddress: input.evaluatorAddress,
      verdictPorts: input.verdictPorts,
      chain: input.chain,
      deliverySignature: { get: (digest) => backend.getDeliverySignature(digest) },
      evidence: {
        awaitIndexed: input.backend.evidence.awaitIndexed,
        getRecord: (reference) => input.backend.evidence.repository.getRecord(reference),
      },
      publisher,
      verification: buildNativeEvaluatorVerdictVerification(input.verification),
    });

    return {
      state: input.state,
      backend,
      publisher,
      coordinator,
      async tick() {
        // Recover durable claim/backend/publication/settlement work before touching the network
        // source. A source outage or a newly tampered entry must not strand work already owned.
        const recovered = await coordinator.reconcileStartup();
        const checkpoint = input.state.sourceCheckpoint(input.opportunities.sourceId);
        const events = await input.opportunities.read({
          ...(checkpoint === undefined ? {} : { after: checkpoint }),
        });
        for (const event of events) {
          if (event.kind === "solution-withdrawn") {
            if (event.source !== input.opportunities.sourceId) {
              throw new NativeEvaluatorCompositionError("withdrawal came from an unexpected signed source");
            }
            input.state.retractOpportunity(event);
            continue;
          }
          if (event.observation.source !== input.opportunities.sourceId) {
            throw new NativeEvaluatorCompositionError("evaluation opportunity came from an unexpected signed source");
          }
          const mapped = mapFinalizedSolutionDeliveryObservation(event.observation, input.operatorIdentity);
          if (mapped.kind !== "opportunity") {
            input.state.advanceSourceCheckpoint({
              source: event.observation.source,
              sequence: event.observation.sourceSequence,
              entryDigest: event.observation.sourceEntryDigest,
              reason: mapped.kind === "skipped" ? mapped.reason : mapped.reason,
            });
            continue;
          }
          const material = await acquireSubjectMaterial(
            mapped.opportunity,
            event.references,
            input.subject.fetcher,
          );
          input.state.admitOpportunity({
            opportunity: mapped.opportunity,
            evaluatorAgent: input.roles.agent,
            coordinator: input.coordinatorAddress,
            material,
          });
        }
        return {
          sourceEvents: events.length,
          coordinator: events.length === 0
            ? recovered
            : [...recovered, ...await coordinator.reconcileStartup()],
        };
      },
      async close() {
        // The backend owns live children and ephemeral host-secret material. Drain it before the
        // public source disappears so a terminal Delivery can never be produced after shutdown
        // has made publication impossible.
        let backendFailure: unknown;
        try {
          await backend.shutdown();
        } catch (cause) {
          backendFailure = cause;
        }
        await publisher!.close();
        if (backendFailure !== undefined) throw backendFailure;
      },
    };
  } catch (cause) {
    await backend.shutdown().catch(() => undefined);
    await publisher?.close().catch(() => undefined);
    throw cause;
  }
}
