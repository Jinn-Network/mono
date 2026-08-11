import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EvidenceBindingPorts } from "@jinn-network/task-execution-backend-local";
import {
  ResultEvaluationStatementSchema,
} from "@jinn-network/evidence-protocol";
import {
  makeLocalTaskExecutionBackend,
  type LocalProvisionerInput,
  type LocalTaskExecutionBackend,
  type LocalTaskExecutionBackendConfig,
} from "@jinn-network/task-execution-backend-local";
import {
  defineEvaluatorRegistration,
  makeEvaluationLauncher,
  type EvaluationHarnessDeployment,
  type EvaluatorAdapter,
  type EvaluatorRegistration,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  PREDICTION_REGISTRATION_ID,
  SWE_REBENCH_REGISTRATION_ID,
  createSweRebenchEvaluatorAdapter,
  type GraderReportSource,
} from "@jinn-network/task-execution-evaluator-adapters";
import {
  EVALUATION_SPEC_MEDIA_TYPE,
  EVALUATION_TASK_PROFILE_URI,
  VERDICT_DSSE_PAYLOAD_TYPE,
  buildEvaluationTaskProfile,
  parseEvaluationSpec,
  sealTaskProfile,
  type EvaluationSpec,
  type ProfileStore,
} from "@jinn-network/task-execution-profiles";
import {
  SubmissionRecordSchema,
  documentDigest,
} from "@jinn-network/task-execution-protocol";
import { sealSignedRecord } from "@jinn-network/trust-core";
import {
  makeDirProvisioner,
  type TaskView,
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
  type NativeEvaluatorVerdictVerificationPort,
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

/**
 * The evaluation methods this host recognizes. A deployment module may register any non-empty
 * subset of them; a registrationId outside this table is refused at composition time, before a
 * backend or a launcher exists.
 *
 * A `graderAdapter` marks a container-graded method — one whose adapter cannot produce a grader
 * report from the harness-supplied evaluation context alone — and is the exact factory the host
 * rebuilds that registration's adapter with when it owns the grader source. A method with no
 * `graderAdapter` takes no grader binding at all.
 */
const HOST_EVALUATION_METHODS: ReadonlyMap<string, {
  readonly graderAdapter?: (graderReportSource: GraderReportSource) => EvaluatorAdapter;
}> = new Map([
  [PREDICTION_REGISTRATION_ID, {}],
  [SWE_REBENCH_REGISTRATION_ID, {
    graderAdapter: (graderReportSource: GraderReportSource) =>
      createSweRebenchEvaluatorAdapter({ graderReportSource }),
  }],
]);

/**
 * How a container-graded registration's grader execution is owned.
 *
 * - a `GraderReportSource` — the host owns it. This is the parent-process registration set the
 *   launcher plans from, and the in-process evaluation path; tests inject a fake runtime here.
 * - `"deployment-owned"` — the digest-pinned deployment module constructs its own grader source
 *   (the production path: the module is imported identically by the daemon and by the spawned
 *   harness child, so only a module-constructed source reaches the process that actually grades
 *   — see `docs/operator/native-evaluator-deployment.md`).
 *
 * There is no third, implicit state: a container-graded registration with no entry at all is
 * refused at composition rather than failing on its first evaluation.
 */
export type NativeGraderReportBinding = GraderReportSource | "deployment-owned";

/**
 * One digest every configured registration's evaluation-method descriptor must declare, or an
 * exact per-`registrationId` map for a deployment that serves more than one method.
 */
export type NativeEvaluationMethodDigests =
  | `sha256:${string}`
  | Readonly<Record<string, `sha256:${string}`>>;

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
  /**
   * The SAME decision-grade verdict verification port the coordinator drives. Surfaced (one-swap
   * M4b, #2461) so the projector's `verifyVerdictObservation` adapter re-checks the operator's own
   * announced verdicts through this exact gate instance — never a second construction that could
   * drift from the settlement path.
   */
  readonly verification: NativeEvaluatorVerdictVerificationPort;
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
    readonly evaluationMethodDigest: NativeEvaluationMethodDigests;
  };
  /**
   * Host-owned grader execution binding for every container-graded registration the deployment
   * declares, keyed by `registrationId` or by the registration's evaluation-method URI. Omitted
   * entirely for a deployment with no container-graded registration (today's prediction-only
   * shape); an entry naming a registration this deployment does not declare is refused, and so
   * is an entry for a registration that is not container-graded.
   */
  readonly graderReportSources?: Readonly<Record<string, NativeGraderReportBinding>>;
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
    throw new NativeEvaluatorCompositionError(
      `${registration.registrationId} evaluator method descriptor has no canonical sha256 digest`,
    );
  }
  return `sha256:${sha256}`;
}

function expectedMethodDigest(
  configured: NativeEvaluationMethodDigests,
  registrationId: string,
): `sha256:${string}` {
  if (typeof configured === "string") return configured;
  const digest = configured[registrationId];
  if (digest === undefined) {
    throw new NativeEvaluatorCompositionError(
      `trusted configuration declares no evaluation-method digest for registration "${registrationId}"`,
    );
  }
  return digest;
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

/**
 * Binds one declared registration's grader execution. A registration the host knows is not
 * container-graded takes no binding at all — supplying one is a configuration error, not an
 * ignorable extra, because it would silently do nothing.
 */
function bindGraderReportSource(
  registration: EvaluatorRegistration,
  graderAdapter: ((graderReportSource: GraderReportSource) => EvaluatorAdapter) | undefined,
  sources: Readonly<Record<string, NativeGraderReportBinding>>,
): EvaluatorRegistration {
  const id = registration.registrationId;
  const uri = registration.evaluationMethod.uri;
  const byId = sources[id];
  const byUri = typeof uri === "string" ? sources[uri] : undefined;
  // Both keys addressing the same registration is fine only when they name the same binding.
  // Silently preferring one would let a deployment run grader execution the operator did not
  // pick, with the losing key looking configured.
  if (byId !== undefined && byUri !== undefined && byId !== byUri) {
    throw new NativeEvaluatorCompositionError(
      `evaluator registration "${id}" has conflicting grader report sources keyed by "${id}" and "${uri}"`,
    );
  }
  const binding = byId ?? byUri;
  if (graderAdapter === undefined) {
    if (binding !== undefined) {
      throw new NativeEvaluatorCompositionError(
        `evaluator registration "${id}" is not container-graded and takes no host grader report source`,
      );
    }
    return registration;
  }
  if (binding === undefined) {
    throw new NativeEvaluatorCompositionError(
      `container-graded evaluator registration "${id}" has no host grader report source: `
      + `native evaluator composition requires a graderReportSources entry keyed by "${id}"`
      + `${typeof uri === "string" ? ` or "${uri}"` : ""}`,
    );
  }
  if (binding === "deployment-owned") return registration;
  return defineEvaluatorRegistration({ ...registration, adapter: graderAdapter(binding) });
}

/**
 * The host-recognized registration set this deployment may serve. Every declared registration is
 * identity-, signer- and method-digest-validated exactly as the single prediction registration
 * was; the set additionally has to be non-empty, duplicate-free, drawn only from
 * `HOST_EVALUATION_METHODS`, and unambiguous about interruption behavior. Every failure is
 * refusal at composition time — the host never boots an evaluator it cannot fully account for.
 */
function hostRegistrationSet(input: {
  readonly deployment: EvaluationHarnessDeployment;
  readonly evaluator: string;
  readonly signerHandle: string;
  readonly evaluationMethodDigest: NativeEvaluationMethodDigests;
  readonly graderReportSources: Readonly<Record<string, NativeGraderReportBinding>>;
}): readonly EvaluatorRegistration[] {
  const declared = input.deployment.registrations;
  if (declared.length === 0) {
    throw new NativeEvaluatorCompositionError("evaluator deployment declares no evaluator registration");
  }
  const seen = new Set<string>();
  const keys = new Set<string>();
  const resolved: EvaluatorRegistration[] = [];
  for (const registration of declared) {
    const id = registration.registrationId;
    if (seen.has(id)) {
      throw new NativeEvaluatorCompositionError(`evaluator deployment declares registration "${id}" more than once`);
    }
    seen.add(id);
    keys.add(id);
    if (typeof registration.evaluationMethod.uri === "string") keys.add(registration.evaluationMethod.uri);
    const method = HOST_EVALUATION_METHODS.get(id);
    if (method === undefined) {
      throw new NativeEvaluatorCompositionError(
        `evaluator deployment registration "${id}" is not a host-recognized evaluation method`,
      );
    }
    if (registration.evaluatorIdentity.id !== input.evaluator) {
      throw new NativeEvaluatorCompositionError(
        `${id} evaluator registration names a different persistent agent`,
      );
    }
    if (registration.signer.handle !== input.signerHandle) {
      throw new NativeEvaluatorCompositionError(
        `${id} evaluator registration names a different host signer handle`,
      );
    }
    if (methodDigest(registration) !== expectedMethodDigest(input.evaluationMethodDigest, id)) {
      throw new NativeEvaluatorCompositionError(`${id} evaluator registration method digest changed`);
    }
    resolved.push(bindGraderReportSource(registration, method.graderAdapter, input.graderReportSources));
  }
  for (const key of Object.keys(input.graderReportSources)) {
    if (!keys.has(key)) {
      throw new NativeEvaluatorCompositionError(
        `grader report source "${key}" names no registration this evaluator deployment declares`,
      );
    }
  }
  if (typeof input.evaluationMethodDigest !== "string") {
    for (const key of Object.keys(input.evaluationMethodDigest)) {
      if (!seen.has(key)) {
        throw new NativeEvaluatorCompositionError(
          `trusted configuration declares an evaluation-method digest for unregistered "${key}"`,
        );
      }
    }
  }
  if (new Set(resolved.map(({ interruptionBehavior }) => interruptionBehavior)).size > 1) {
    throw new NativeEvaluatorCompositionError(
      "evaluator deployment registrations have ambiguous interruption behavior",
    );
  }
  return Object.freeze(resolved);
}

/** The single configured registration serving this EvaluationSpec — never zero, never two. */
function compatibleRegistration(
  registrations: readonly EvaluatorRegistration[],
  specification: EvaluationSpec,
): EvaluatorRegistration {
  const compatible = registrations.filter(
    (registration) => registration.specificationCompatibility(specification),
  );
  if (compatible.length !== 1) {
    throw new NativeEvaluatorCompositionError(
      compatible.length === 0
        ? "no configured evaluator registration serves this evaluation's EvaluationSpec"
        : "more than one configured evaluator registration serves this evaluation's EvaluationSpec",
    );
  }
  return compatible[0]!;
}

/**
 * Resolves the EvaluationSpec the evaluation Task names from the evaluator's own durable
 * artifacts. The digest comes from the host-derived, host-sealed evaluation Task; the bytes come
 * from durable state, never from the workspace the attempt can write.
 */
function durableEvaluationSpec(
  state: NativeEvaluatorStateRepository,
  view: TaskView,
): EvaluationSpec {
  const payload = view.task.payload as { readonly evaluationSpec?: unknown } | null | undefined;
  const digest = payload?.evaluationSpec;
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new NativeEvaluatorCompositionError("evaluation Task names no canonical EvaluationSpec digest");
  }
  for (const evaluation of state.listEvaluations()) {
    for (const artifact of state.listSubjectArtifacts(evaluation.evaluationId)) {
      if (artifact.role === "evaluation-spec" && artifact.digest === digest) {
        return parseEvaluationSpec(artifact.bytes);
      }
    }
  }
  throw new NativeEvaluatorCompositionError(
    "evaluation Task names an EvaluationSpec with no durable evaluator artifact",
  );
}

/**
 * The launcher's `selectRegistration` seam. A one-registration deployment resolves to that exact
 * registration without reading anything — byte-for-byte the pre-registration-set behavior. A
 * larger set selects per evaluation method, by matching each registration's own specification
 * compatibility (exact parser identity for the shipped adapters) against the durable
 * EvaluationSpec.
 */
function registrationSelector(input: {
  readonly registrations: readonly EvaluatorRegistration[];
  readonly state: NativeEvaluatorStateRepository;
}): (view: TaskView) => EvaluatorRegistration {
  if (input.registrations.length === 1) {
    const only = input.registrations[0]!;
    return () => only;
  }
  return (view) => compatibleRegistration(input.registrations, durableEvaluationSpec(input.state, view));
}

/**
 * The evaluation-method digest a harvested verdict statement must declare. One registration
 * pins its own digest unconditionally; a larger set pins the digest of the registration that
 * serves the evaluation's own EvaluationSpec, so a second configured method can never launder a
 * verdict under the wrong method identity.
 */
function methodDigestResolver(
  registrations: readonly EvaluatorRegistration[],
): (specificationBytes: Uint8Array) => `sha256:${string}` {
  if (registrations.length === 1) {
    const digest = methodDigest(registrations[0]!);
    return () => digest;
  }
  return (specificationBytes) =>
    methodDigest(compatibleRegistration(registrations, parseEvaluationSpec(specificationBytes)));
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
  readonly roles: RoleIdentitySet;
  readonly expectedMethodDigest: (specificationBytes: Uint8Array) => `sha256:${string}`;
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
        async harvest(paths, outputs) {
          const verdictPath = join(paths.out, "verdict");
          const payloadBytes = new Uint8Array(await readFile(verdictPath));
          const statement = ResultEvaluationStatementSchema.parse(JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes),
          ));
          const one = (role: string) => {
            const values = artifacts.filter((artifact) => artifact.role === role);
            if (values.length !== 1) throw new NativeEvaluatorCompositionError(`evaluation has no unique ${role}`);
            return values[0]!;
          };
          const task = one("task");
          const specification = one("evaluation-spec");
          const results = artifacts.filter((artifact) => artifact.role === "solution-result");
          const statementSubjects = statement.subject.map((subject) => ({
            name: subject.name,
            digest: `sha256:${subject.digest.sha256}`,
          }));
          const expectedSubjects = [task, ...results].map(({ name, digest }) => ({ name, digest }));
          const predicate = statement.predicate;
          if (predicate.evaluator.id !== input.roles.agent
            || JSON.stringify(statementSubjects) !== JSON.stringify(expectedSubjects)
            || predicate.taskSubject !== task.name
            || JSON.stringify(predicate.resultSubjects) !== JSON.stringify(results.map(({ name }) => name))
            || predicate.evaluationSpecification?.digest.sha256 !== specification.digest.slice("sha256:".length)
            || predicate.evaluationMethod?.digest.sha256
              !== input.expectedMethodDigest(specification.bytes).slice("sha256:".length)
            || Date.parse(predicate.evaluatedAt) > Date.parse(effectiveDeadline(input.state, local.attempt.attemptUri) ?? "")) {
            throw new NativeEvaluatorCompositionError("unsigned evaluator statement is outside its exact Attempt authority");
          }
          const identity = input.roles.get("evaluator-verdict");
          const sealed = await sealSignedRecord({
            record: statement,
            payloadType: VERDICT_DSSE_PAYLOAD_TYPE,
            signer: async ({ preAuthEncoding }) => [{ keyid: identity.keyId, signature: identity.sign(preAuthEncoding) }],
          });
          if (!Buffer.from(sealed.payloadBytes).equals(Buffer.from(payloadBytes))) {
            throw new NativeEvaluatorCompositionError("unsigned evaluator statement is not canonical exact bytes");
          }
          const temporary = `${verdictPath}.sealed`;
          await writeFile(temporary, sealed.envelopeBytes, { mode: 0o600, flag: "wx" });
          await rename(temporary, verdictPath);
          return provisioner.harvest(paths, outputs);
        },
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
  const registrations = hostRegistrationSet({
    deployment,
    evaluator: input.roles.agent,
    signerHandle: input.deployment.signerHandle,
    evaluationMethodDigest: input.deployment.evaluationMethodDigest,
    graderReportSources: input.graderReportSources ?? {},
  });
  const launcher = makeEvaluationLauncher({
    deploymentModule: location.specifier,
    registrations,
    selectRegistration: registrationSelector({ registrations, state: input.state }),
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
      roles: input.roles,
      expectedMethodDigest: methodDigestResolver(registrations),
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
  };
  const backend = (input.constructBackend ?? makeLocalTaskExecutionBackend)(backendConfig);
  const verification = buildNativeEvaluatorVerdictVerification(input.verification);
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
      verification,
      // No `maxAttempts`: a live evaluation lives 25+ minutes across multiple finality waits, polled
      // every ~5s, and deliberately marks normal projector-lag conditions retryable. A fixed cumulative
      // budget terminal-failed verdicts on ordinary lag; the 4h admission deadline is the real cap
      // (retry-until-deadline), with the counter reset on each phase advance. Capped exponential backoff
      // keeps a sustained dependency outage from hammering RPC.
      retry: { delayMs: 5_000, maxDelayMs: 300_000 },
    });

    return {
      state: input.state,
      backend,
      publisher,
      coordinator,
      verification,
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
            reopenWithdrawn: true,
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
