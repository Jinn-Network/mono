/**
 * Runtime-neutral boundary for evaluation authoring/execution stacks.
 *
 * The Benchmark Product lifecycle sees only a digest-bound selection and the generic Run
 * requirements it contributes. Runtime-specific task, scorer, sandbox, and log semantics stay
 * behind adapters. The native implementation remains the compatibility/reference adapter.
 */

import { createHash } from "node:crypto";
import { parseCellKey, type BenchmarkAccountingDispatch, type DigestBearingResourceDescriptor } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import type {
  PublicationCheck,
  ReferenceBytesResolver,
  RuntimeEvidenceContributor,
  RuntimeEvidenceVerifier,
} from "@jinn-network/benchmarking-publication";
import type { EvaluationRuntimeBinding } from "../domain/draft.js";
import { refuse } from "../errors.js";
import {
  VENUE_ISOLATION_POLICY,
  type LocalVenue,
  type LocalVenueOptions,
} from "../venue/venue.js";
import { createDefaultBenchmarkRuntimeHost, type BenchmarkRuntimeHost } from "./host-port.js";
import { INSPECT_ADAPTER_ID } from "./inspect/manifest.js";
import {
  HARBOR_ADAPTER_ID,
  HARBOR_RUNTIME_EVIDENCE_PROFILE,
} from "./harbor/manifest.js";
import {
  HARBOR_ARTIFACT_MANIFEST_ROLE,
  HARBOR_COLLECTED_ARTIFACTS_ROLE,
  HARBOR_ATIF_ROLE,
  HARBOR_CORRELATION_ROLE,
  HARBOR_CTRF_ROLE,
  HARBOR_JOB_CONFIG_ROLE,
  HARBOR_INVOCATION_CONFIG_ROLE,
  HARBOR_JOB_RESULT_ROLE,
  HARBOR_LOGS_ROLE,
  HARBOR_NATIVE_PATH_ROLE_PREFIX,
  HARBOR_REWARD_ROLE,
  HARBOR_SELECTION_ROLE,
  HARBOR_TRIAL_CONFIG_ROLE,
  HARBOR_TRIAL_RESULT_ROLE,
} from "./harbor/venue.js";
import { HarborSelectionManifestSchema, harborJobSource, normalizeHarborSavedJobConfig } from "./harbor/manifest.js";

export const NATIVE_RUNTIME_ADAPTER_ID = "jinn-native";
export const NATIVE_RUNTIME_EVIDENCE_PROFILE = "https://runtime.jinn.network/profiles/native-evidence/v1";
export const INSPECT_RUNTIME_EVIDENCE_PROFILE = "https://product.jinn.network/profiles/inspect-evidence/v1";
export { HARBOR_ADAPTER_ID, HARBOR_RUNTIME_EVIDENCE_PROFILE } from "./harbor/manifest.js";
export const INSPECT_EVAL_LOG_ARTIFACT_ROLE = "https://product.jinn.network/artifact-roles/inspect/eval-log/v1";
export const INSPECT_SELECTION_CORRELATION_ROLE = "https://product.jinn.network/artifact-roles/inspect/selection-manifest/v1";
export const INSPECT_RUNTIME_PROVENANCE_ROLE = "https://product.jinn.network/artifact-roles/inspect/runtime-provenance/v1";

type RuntimeRegistrationArtifact = Awaited<ReturnType<RuntimeEvidenceContributor["registration"]>>[number];
type RuntimeNativeArtifact = BenchmarkAccountingDispatch["nativeArtifacts"][number];
type RuntimeCorrelation = BenchmarkAccountingDispatch["correlations"][number];

/** Exact bytes are retained by the caller's artifact store; the adapter only carries their descriptors. */
export interface RuntimeEvidenceAdapterOptions {
  readonly registrationArtifacts?: readonly RuntimeRegistrationArtifact[];
}
/**
 * This deliberately extends the reusable dispatch input only with opaque captured evidence.
 * Publication policy (consent, scrubbing, and object-store placement) remains outside the adapter.
 */
export type RuntimeEvidenceDispatchInput = Parameters<RuntimeEvidenceContributor["dispatch"]>[0] & {
  readonly correlations?: BenchmarkAccountingDispatch["correlations"];
  readonly nativeArtifacts?: BenchmarkAccountingDispatch["nativeArtifacts"];
};

export interface RuntimeAdapterSummary {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly selectionRequired: boolean;
}

/**
 * The legacy runtime registry shape is intentionally closed. Existing hosts can provide this
 * object without knowing anything about publication, and PUB-08 must not turn that compatibility
 * boundary into a wider implementation requirement.
 */
export interface EvaluationRuntimeAdapter {
  readonly summary: RuntimeAdapterSummary;
  readonly nativeArtifactPublication: "not-applicable" | "explicit-consent";
  submissionBaseline(binding: EvaluationRuntimeBinding | undefined): Readonly<Record<string, unknown>>;
}

/** Publication is an opt-in tier-3 view over a selected legacy runtime adapter. */
export interface RuntimePublicationAdapter extends RuntimeEvidenceContributor, RuntimeEvidenceVerifier {
  readonly adapterId: string;
  dispatch(input: RuntimeEvidenceDispatchInput): Promise<{
    readonly correlations: BenchmarkAccountingDispatch["correlations"];
    readonly nativeArtifacts: BenchmarkAccountingDispatch["nativeArtifacts"];
  }>;
}

interface AdapterDefinition {
  readonly summary: RuntimeAdapterSummary;
  readonly nativeArtifactPublication: "not-applicable" | "explicit-consent";
  readonly profile: string;
}

const nativeDefinition: AdapterDefinition = {
  summary: {
    id: NATIVE_RUNTIME_ADAPTER_ID,
    label: "Built-in native",
    available: true,
    selectionRequired: false,
  },
  nativeArtifactPublication: "not-applicable",
  profile: NATIVE_RUNTIME_EVIDENCE_PROFILE,
};

const inspectDefinition: AdapterDefinition = {
  summary: {
    id: INSPECT_ADAPTER_ID,
    label: "Inspect",
    available: true,
    selectionRequired: true,
  },
  nativeArtifactPublication: "explicit-consent",
  profile: INSPECT_RUNTIME_EVIDENCE_PROFILE,
};

const harborDefinition: AdapterDefinition = {
  summary: {
    id: HARBOR_ADAPTER_ID,
    label: "Harbor 0.21 (managed direct)",
    available: true,
    selectionRequired: true,
  },
  nativeArtifactPublication: "explicit-consent",
  profile: HARBOR_RUNTIME_EVIDENCE_PROFILE,
};

function digestMatches(bytes: Uint8Array, descriptor: DigestBearingResourceDescriptor): boolean {
  return createHash("sha256").update(bytes).digest("hex") === descriptor.digest.sha256;
}

function uniqueRoles(values: readonly { readonly role: string }[]): boolean {
  return new Set(values.map((value) => value.role)).size === values.length;
}

function disclosureCheck(artifacts: readonly RuntimeNativeArtifact[]): PublicationCheck {
  const valid = artifacts.every((artifact) => artifact.availability === "public"
    ? artifact.artifact !== undefined
    : artifact.reason !== undefined && artifact.reason.trim() !== "");
  return valid
    ? { name: "runtime-native-artifact-disclosure", status: "pass" }
    : { name: "runtime-native-artifact-disclosure", status: "fail", detail: "a public artifact needs a descriptor and every withheld artifact needs a non-blank reason" };
}

function roleCheck(correlations: readonly RuntimeCorrelation[], artifacts: readonly RuntimeNativeArtifact[], nativeRoleGroups: boolean): PublicationCheck {
  return uniqueRoles(correlations) && (nativeRoleGroups || uniqueRoles(artifacts))
    ? { name: "runtime-evidence-unique-roles", status: "pass" }
    : { name: "runtime-evidence-unique-roles", status: "fail", detail: "correlation roles must be unique; this runtime profile does not permit repeated native-artifact roles" };
}

async function exactEvidenceCheck(
  name: string,
  correlations: readonly RuntimeCorrelation[],
  artifacts: readonly RuntimeNativeArtifact[],
  references: ReferenceBytesResolver | undefined,
): Promise<PublicationCheck> {
  const descriptors = [
    ...correlations.map((correlation) => correlation.artifact),
    ...artifacts.flatMap((artifact) => artifact.artifact === undefined ? [] : [artifact.artifact]),
  ];
  if (descriptors.length === 0) return { name, status: "pass" };
  if (references === undefined) return { name, status: "indeterminate", detail: "no exact-byte resolver was supplied" };
  let unavailable = false;
  for (const descriptor of descriptors) {
    const bytes = await references.getExact({ digest: `sha256:${descriptor.digest.sha256}` as Parameters<ReferenceBytesResolver["getExact"]>[0]["digest"] });
    if (bytes === undefined) {
      unavailable = true;
      continue;
    }
    if (!digestMatches(bytes, descriptor)) return { name, status: "fail", detail: `exact bytes do not match ${descriptor.digest.sha256}` };
  }
  return unavailable ? { name, status: "indeterminate", detail: "one or more exact artifacts are unavailable" } : { name, status: "pass" };
}

function legacyAdapter(definition: AdapterDefinition): EvaluationRuntimeAdapter {
  return {
    summary: definition.summary,
    nativeArtifactPublication: definition.nativeArtifactPublication,
    submissionBaseline: (binding) => ({ isolationPolicy: binding?.isolationPolicy ?? VENUE_ISOLATION_POLICY }),
  };
}

function selectionCorrelation(
  correlations: readonly RuntimeCorrelation[],
): RuntimeCorrelation | undefined {
  return correlations.find((correlation) => correlation.role === INSPECT_SELECTION_CORRELATION_ROLE);
}

function inspectRoleChecks(
  expectedSelectionManifestSha256: string,
  correlations: readonly RuntimeCorrelation[],
  artifacts: readonly RuntimeNativeArtifact[],
): PublicationCheck[] {
  const selection = selectionCorrelation(correlations);
  const selectionCheck = selection !== undefined && selection.artifact.digest.sha256 === expectedSelectionManifestSha256
    ? { name: "inspect-selection-manifest-binding", status: "pass" as const }
    : { name: "inspect-selection-manifest-binding", status: "fail" as const, detail: "Inspect evidence must carry the exact sealed selection-manifest descriptor" };
  const allowedCorrelations = correlations.every((correlation) => !correlation.role.startsWith("https://product.jinn.network/artifact-roles/inspect/")
    || correlation.role === INSPECT_SELECTION_CORRELATION_ROLE || correlation.role === INSPECT_RUNTIME_PROVENANCE_ROLE);
  const allowedNativeArtifacts = artifacts.every((artifact) => !artifact.role.startsWith("https://product.jinn.network/artifact-roles/inspect/")
    || artifact.role === INSPECT_EVAL_LOG_ARTIFACT_ROLE);
  const evalLogs = artifacts.filter((artifact) => artifact.role === INSPECT_EVAL_LOG_ARTIFACT_ROLE);
  const validEvalLog = evalLogs.length === 1 && ["public", "digest-only", "source-absent", "collection-failed"].includes(evalLogs[0]!.availability);
  return [
    selectionCheck,
    allowedCorrelations
      ? { name: "inspect-allowed-correlation-roles", status: "pass" }
      : { name: "inspect-allowed-correlation-roles", status: "fail", detail: "unrecognised Inspect correlation role" },
    allowedNativeArtifacts
      ? { name: "inspect-allowed-native-artifact-roles", status: "pass" }
      : { name: "inspect-allowed-native-artifact-roles", status: "fail", detail: "unrecognised Inspect native-artifact role" },
    validEvalLog
      ? { name: "inspect-eval-log-disclosure", status: "pass" }
      : { name: "inspect-eval-log-disclosure", status: "fail", detail: "Inspect evidence requires exactly one explicitly disclosed EvalLog role" },
  ];
}

function assertInspectRegistration(
  expectedSelectionManifestSha256: string,
  artifacts: readonly RuntimeRegistrationArtifact[],
): void {
  const selection = artifacts.filter((artifact) => artifact.role === INSPECT_SELECTION_CORRELATION_ROLE);
  if (selection.length !== 1 || selection[0]!.digest !== `sha256:${expectedSelectionManifestSha256}`) {
    throw new TypeError("Inspect registration requires exactly one selection-manifest artifact matching the sealed evaluationRuntime.selectionManifestSha256");
  }
  if (!digestMatches(selection[0]!.bytes, { name: selection[0]!.id, mediaType: selection[0]!.mediaType, digest: { sha256: expectedSelectionManifestSha256 } })) {
    throw new TypeError("Inspect selection-manifest registration bytes do not match their sealed digest");
  }
}

function assertInspectContribution(
  expectedSelectionManifestSha256: string,
  correlations: readonly RuntimeCorrelation[],
): void {
  const selection = selectionCorrelation(correlations);
  if (selection === undefined || selection.artifact.digest.sha256 !== expectedSelectionManifestSha256) {
    throw new TypeError("Inspect dispatch contribution requires the sealed selection-manifest correlation descriptor");
  }
}

const HARBOR_REQUIRED_NATIVE_ROLES = [
  HARBOR_INVOCATION_CONFIG_ROLE, HARBOR_JOB_CONFIG_ROLE, HARBOR_JOB_RESULT_ROLE, HARBOR_TRIAL_CONFIG_ROLE,
  HARBOR_TRIAL_RESULT_ROLE, HARBOR_REWARD_ROLE,
] as const;
const HARBOR_ALLOWED_NATIVE_ROLES = new Set<string>([
  ...HARBOR_REQUIRED_NATIVE_ROLES, HARBOR_ATIF_ROLE, HARBOR_CTRF_ROLE,
  HARBOR_LOGS_ROLE, HARBOR_ARTIFACT_MANIFEST_ROLE, HARBOR_COLLECTED_ARTIFACTS_ROLE,
]);

function assertHarborRegistration(expectedSelectionManifestSha256: string, artifacts: readonly RuntimeRegistrationArtifact[]): void {
  const selection = artifacts.filter((artifact) => artifact.role === HARBOR_SELECTION_ROLE);
  if (selection.length !== 1 || selection[0]!.digest !== `sha256:${expectedSelectionManifestSha256}` || !digestMatches(selection[0]!.bytes, { name: selection[0]!.id, mediaType: selection[0]!.mediaType, digest: { sha256: expectedSelectionManifestSha256 } })) {
    throw new TypeError("Harbor registration requires the exact sealed HarborSelectionManifest bytes");
  }
}

function assertHarborContribution(expectedSelectionManifestSha256: string, correlations: readonly RuntimeCorrelation[]): void {
  const selection = correlations.filter((correlation) => correlation.role === HARBOR_SELECTION_ROLE);
  const jobTrial = correlations.filter((correlation) => correlation.role === HARBOR_CORRELATION_ROLE);
  if (selection.length !== 1 || selection[0]!.artifact.digest.sha256 !== expectedSelectionManifestSha256 || jobTrial.length !== 1) {
    throw new TypeError("Harbor dispatch requires one selection correlation and one Job/Trial correlation");
  }
}

function harborRoleChecks(expectedSelectionManifestSha256: string, correlations: readonly RuntimeCorrelation[], artifacts: readonly RuntimeNativeArtifact[]): PublicationCheck[] {
  const selection = correlations.filter((value) => value.role === HARBOR_SELECTION_ROLE);
  const jobTrial = correlations.filter((value) => value.role === HARBOR_CORRELATION_ROLE);
  const availableRoles = new Set(artifacts.filter((value) => value.artifact !== undefined && (value.availability === "public" || value.availability === "digest-only")).map((value) => value.role));
  const allowed = artifacts.every((value) => HARBOR_ALLOWED_NATIVE_ROLES.has(value.role) || value.role.startsWith(HARBOR_NATIVE_PATH_ROLE_PREFIX));
  return [
    selection.length === 1 && selection[0]!.artifact.digest.sha256 === expectedSelectionManifestSha256
      ? { name: "harbor-selection-manifest-binding", status: "pass" }
      : { name: "harbor-selection-manifest-binding", status: "fail", detail: "Harbor dispatch must carry the sealed selection manifest" },
    jobTrial.length === 1
      ? { name: "harbor-job-trial-correlation", status: "pass" }
      : { name: "harbor-job-trial-correlation", status: "fail", detail: "Harbor dispatch must carry exactly one Job/Trial correlation" },
    HARBOR_REQUIRED_NATIVE_ROLES.every((role) => availableRoles.has(role))
      ? { name: "harbor-required-native-evidence", status: "pass" }
      : { name: "harbor-required-native-evidence", status: "fail", detail: "Harbor Job/Trial configuration, result, and reward evidence are required" },
    allowed
      ? { name: "harbor-allowed-native-artifact-roles", status: "pass" }
      : { name: "harbor-allowed-native-artifact-roles", status: "fail", detail: "unrecognised Harbor native-artifact role" },
  ];
}

async function harborStructureCheck(
  expectedSelectionManifestSha256: string,
  correlations: readonly RuntimeCorrelation[],
  artifacts: readonly RuntimeNativeArtifact[],
  references: ReferenceBytesResolver | undefined,
): Promise<PublicationCheck> {
  if (references === undefined) return { name: "harbor-job-trial-structure", status: "indeterminate", detail: "no exact-byte resolver was supplied" };
  const selection = correlations.find((value) => value.role === HARBOR_SELECTION_ROLE);
  const correlation = correlations.find((value) => value.role === HARBOR_CORRELATION_ROLE);
  const find = (role: string) => artifacts.find((value) => value.role === role)?.artifact;
  if (selection === undefined || correlation === undefined || HARBOR_REQUIRED_NATIVE_ROLES.some((role) => find(role) === undefined)) {
    return { name: "harbor-job-trial-structure", status: "fail", detail: "required Harbor descriptors are absent" };
  }
  try {
    const exact = async (descriptor: DigestBearingResourceDescriptor) => {
      const bytes = await references.getExact({ digest: `sha256:${descriptor.digest.sha256}` as Parameters<ReferenceBytesResolver["getExact"]>[0]["digest"] });
      if (bytes === undefined || !digestMatches(bytes, descriptor)) throw new Error("missing or digest-mismatched Harbor bytes");
      return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    };
    const selected = HarborSelectionManifestSchema.parse(await exact(selection.artifact));
    const joined = await exact(correlation.artifact);
    const harbor = joined.harbor as { jobName?: unknown; jobId?: unknown; trialId?: unknown } | undefined;
    const lineage = joined.lineage as { submissionSha256?: unknown; attemptUri?: unknown; runSha256?: unknown; cellKey?: unknown; dispatchIndex?: unknown } | undefined;
    if (joined.selectionManifestSha256 !== expectedSelectionManifestSha256 || typeof harbor?.jobName !== "string" || typeof harbor.jobId !== "string" || typeof harbor.trialId !== "string" || typeof lineage?.submissionSha256 !== "string" || typeof lineage.attemptUri !== "string" || typeof lineage.runSha256 !== "string" || typeof lineage.cellKey !== "string" || !Number.isInteger(lineage.dispatchIndex)) throw new Error("correlation lacks complete Jinn/Harbor identity binding");
    const submittedJob = await exact(find(HARBOR_INVOCATION_CONFIG_ROLE)!);
    const job = normalizeHarborSavedJobConfig(await exact(find(HARBOR_JOB_CONFIG_ROLE)!), submittedJob);
    const trial = await exact(find(HARBOR_TRIAL_CONFIG_ROLE)!);
    const jobResult = await exact(find(HARBOR_JOB_RESULT_ROLE)!);
    const trialResult = await exact(find(HARBOR_TRIAL_RESULT_ROLE)!);
    const trialAttempt = trial.attempt_number ?? trial.attempt;
    if (job.n_attempts !== 1 || job.n_concurrent_trials !== 1 || job.retry.max_retries !== 0 || trialAttempt !== 1) throw new Error("effective Harbor Job/Trial permits hidden attempts or retries");
    const expectedJobName = `jinn-${lineage.submissionSha256.slice(0, 24)}-d${lineage.dispatchIndex}`;
    const effectiveJobId = jobResult.id ?? jobResult.job_id;
    const effectiveTrialId = trialResult.id ?? trialResult.trial_id;
    const selectedArm = selected.arms.find((arm) => arm.armId === parseCellKey(lineage.cellKey as string).armId);
    const sameJson = (left: unknown, right: unknown): boolean => Buffer.from(canonicalJsonBytes(left as never)).equals(Buffer.from(canonicalJsonBytes(right as never)));
    const expectedSource = harborJobSource(selected);
    if (job.job_name !== expectedJobName || harbor.jobName !== expectedJobName || effectiveJobId !== harbor.jobId || effectiveTrialId !== harbor.trialId
      || selectedArm === undefined || !sameJson(job.environment, { type: selected.environment.type, ...selected.environment.configuration })
      || !sameJson(job.agents, [selectedArm.jobAgent]) || !sameJson(job.artifacts, selected.outputs.map((output) => output.artifact))
      || (!("tasks" in expectedSource) ? "tasks" in job : !("tasks" in job) || !sameJson(job.tasks, expectedSource.tasks))
      || (!("datasets" in expectedSource) ? "datasets" in job : !("datasets" in job) || !sameJson(job.datasets, expectedSource.datasets))
      || selected.retryPolicy.nAttempts !== 1 || selected.retryPolicy.nConcurrent !== 1 || selected.retryPolicy.maxRetries !== 0) throw new Error("Harbor Job identity, lineage, or retry policy does not match sealed Jinn selection");
    return { name: "harbor-job-trial-structure", status: "pass" };
  } catch (cause) {
    return { name: "harbor-job-trial-structure", status: "fail", detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

function createPublicationAdapter(
  definition: AdapterDefinition,
  binding: EvaluationRuntimeBinding | undefined,
  options: RuntimeEvidenceAdapterOptions = {},
): RuntimePublicationAdapter {
  const adapterId = binding?.adapterId ?? NATIVE_RUNTIME_ADAPTER_ID;
  const selectedRuntime = adapterId === INSPECT_ADAPTER_ID || adapterId === HARBOR_ADAPTER_ID;
  const expectedSelectionManifestSha256 = selectedRuntime ? binding?.selectionManifestSha256 : undefined;
  const expectedProfile = adapterId === INSPECT_ADAPTER_ID ? INSPECT_RUNTIME_EVIDENCE_PROFILE : adapterId === HARBOR_ADAPTER_ID ? HARBOR_RUNTIME_EVIDENCE_PROFILE : NATIVE_RUNTIME_EVIDENCE_PROFILE;
  const adapter: RuntimePublicationAdapter = {
    adapterId,
    profile: definition.profile,
    async registration() {
      // No reserialization or descriptor synthesis: registration bytes are already sealed by the runtime.
      const artifacts = options.registrationArtifacts ?? [];
      if (adapterId === INSPECT_ADAPTER_ID && expectedSelectionManifestSha256 !== undefined) assertInspectRegistration(expectedSelectionManifestSha256, artifacts);
      if (adapterId === HARBOR_ADAPTER_ID && expectedSelectionManifestSha256 !== undefined) assertHarborRegistration(expectedSelectionManifestSha256, artifacts);
      return artifacts;
    },
    async dispatch(input: RuntimeEvidenceDispatchInput) {
      // A native source can be absent or collection can fail. Preserve those facts rather than inventing a blob.
      const correlations = input.correlations ?? [];
      if (adapterId === INSPECT_ADAPTER_ID && expectedSelectionManifestSha256 !== undefined) assertInspectContribution(expectedSelectionManifestSha256, correlations);
      if (adapterId === HARBOR_ADAPTER_ID && expectedSelectionManifestSha256 !== undefined) assertHarborContribution(expectedSelectionManifestSha256, correlations);
      return { correlations, nativeArtifacts: input.nativeArtifacts ?? [] };
    },
    async verify(input) {
      const prefix = adapterId === INSPECT_ADAPTER_ID ? "inspect" : adapterId === HARBOR_ADAPTER_ID ? "harbor" : "native";
      const correlations = input.dispatch.correlations;
      const nativeArtifacts = input.dispatch.nativeArtifacts;
      return [
        adapter.profile === expectedProfile && definition.summary.id === adapterId
          ? { name: `${prefix}-runtime-profile`, status: "pass" as const }
          : { name: `${prefix}-runtime-profile`, status: "fail" as const, detail: "publication adapter profile does not match its selected runtime identity" },
        // Correlations are identity joins and always singular by role. Native artifact role
        // cardinality belongs to the runtime profile: one Harbor Trial commonly has multiple
        // ATIF and log files under the same semantic role, each retained by exact descriptor.
        roleCheck(correlations, nativeArtifacts, adapterId === HARBOR_ADAPTER_ID),
        disclosureCheck(nativeArtifacts),
        ...(adapterId === INSPECT_ADAPTER_ID && expectedSelectionManifestSha256 !== undefined ? inspectRoleChecks(expectedSelectionManifestSha256, correlations, nativeArtifacts) : []),
        ...(adapterId === HARBOR_ADAPTER_ID && expectedSelectionManifestSha256 !== undefined ? harborRoleChecks(expectedSelectionManifestSha256, correlations, nativeArtifacts) : []),
        ...(adapterId === HARBOR_ADAPTER_ID && expectedSelectionManifestSha256 !== undefined ? [await harborStructureCheck(expectedSelectionManifestSha256, correlations, nativeArtifacts, input.references)] : []),
        await exactEvidenceCheck(`${prefix}-exact-native-evidence`, correlations, nativeArtifacts, input.references),
      ];
    },
  };
  return adapter;
}

const nativeAdapter = legacyAdapter(nativeDefinition);
const inspectAdapter = legacyAdapter(inspectDefinition);
const harborAdapter = legacyAdapter(harborDefinition);

/**
 * Creates the publication-facing adapter for a particular sealed runtime binding. The caller
 * supplies already-captured registration artifacts, so this tier never chooses disclosure policy
 * or turns native bytes into a product-specific format.
 */
export function createRuntimeEvidenceAdapter(
  binding?: EvaluationRuntimeBinding,
  options: RuntimeEvidenceAdapterOptions = {},
): RuntimePublicationAdapter {
  const adapter = adapterFor(binding);
  return createPublicationAdapter({
    summary: adapter.summary,
    nativeArtifactPublication: adapter.nativeArtifactPublication,
    profile: adapter.summary.id === INSPECT_ADAPTER_ID ? INSPECT_RUNTIME_EVIDENCE_PROFILE : adapter.summary.id === HARBOR_ADAPTER_ID ? HARBOR_RUNTIME_EVIDENCE_PROFILE : NATIVE_RUNTIME_EVIDENCE_PROFILE,
  }, binding, options);
}

const ADAPTERS = new Map<string, EvaluationRuntimeAdapter>([
  [nativeAdapter.summary.id, nativeAdapter],
  [inspectAdapter.summary.id, inspectAdapter],
  [harborAdapter.summary.id, harborAdapter],
]);

function adapterFor(binding: EvaluationRuntimeBinding | undefined): EvaluationRuntimeAdapter {
  const adapterId = binding?.adapterId ?? NATIVE_RUNTIME_ADAPTER_ID;
  const adapter = ADAPTERS.get(adapterId);
  if (adapter === undefined) {
    refuse("venue-unavailable", "spec.evaluationRuntime.adapterId", `evaluation runtime adapter \"${adapterId}\" is not installed`);
  }
  return adapter;
}

/*
 * Runtime identity is already transitively sealed by Benchmark -> Task -> selection manifest.
 * Isolation is still a visible submission fact: local Python is unrestricted while the OCI
 * host is container-isolated. Neither posture is allowed to disappear behind the adapter id.
 */

export function listRuntimeAdapters(): readonly RuntimeAdapterSummary[] {
  return [...ADAPTERS.values()].map((adapter) => adapter.summary);
}

export function runtimeSubmissionBaseline(
  binding?: EvaluationRuntimeBinding,
): Readonly<Record<string, unknown>> {
  return adapterFor(binding).submissionBaseline(binding);
}

export function runtimeNativeArtifactPublicationPolicy(
  binding?: EvaluationRuntimeBinding,
): EvaluationRuntimeAdapter["nativeArtifactPublication"] {
  return adapterFor(binding).nativeArtifactPublication;
}

/** Runtime-neutral venue construction used by preview, quote, launch, resume, and cancel. */
export function createRuntimeVenue(
  binding: EvaluationRuntimeBinding | undefined,
  options: Omit<LocalVenueOptions, "evaluationRuntime">,
  runtimeHost: BenchmarkRuntimeHost = createDefaultBenchmarkRuntimeHost(),
): LocalVenue {
  // Resolve first so unknown adapters fail at the shared operation boundary.
  adapterFor(binding);
  return runtimeHost.createVenue(binding, options);
}
