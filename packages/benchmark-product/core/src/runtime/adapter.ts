/**
 * Runtime-neutral boundary for evaluation authoring/execution stacks.
 *
 * The Benchmark Product lifecycle sees only a digest-bound selection and the generic Run
 * requirements it contributes. Runtime-specific task, scorer, sandbox, and log semantics stay
 * behind adapters. The native implementation remains the compatibility/reference adapter.
 */

import { createHash } from "node:crypto";
import { parseCellKey, type BenchmarkAccountingDispatch, type DigestBearingResourceDescriptor, type RegistrationArtifact } from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import type {
  PublicationCheck,
  ReferenceBytesResolver,
  RuntimeEvidenceContributor,
  RuntimeEvidenceVerifier,
} from "@jinn-network/benchmarking-publication";
import type { EvaluationRuntimeBinding } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { getSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import {
  VENUE_ISOLATION_POLICY,
  type LocalVenue,
  type LocalVenueOptions,
} from "../venue/venue.js";
import { createDefaultBenchmarkRuntimeHost, type BenchmarkRuntimeHost } from "./host-port.js";
import { INSPECT_ADAPTER_ID } from "./inspect/manifest.js";
import {
  HARBOR_ADAPTER_ID,
  HARBOR_RUNTIME_EXECUTABLE_ROLE,
  HARBOR_RUNTIME_EVIDENCE_PROFILE,
  HARBOR_SOURCE_MATERIAL_ROLE,
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
import { HarborSelectionManifestSchema, harborJobSource, harborSelectionManifestBytes, normalizeHarborSavedJobConfig } from "./harbor/manifest.js";
import {
  TERMINAL_BENCH_2_REGISTRY_ROLE,
  TERMINAL_BENCH_2_PROFILE,
  TERMINAL_BENCH_2_SELECTION_ROLE,
  TERMINAL_BENCH_2_TASK_MATERIAL_ROLE,
  TERMINAL_BENCH_MIGRATION_EXECUTABLE_ROLE,
  TERMINAL_BENCH_MIGRATION_ROLE,
  TERMINAL_BENCH_MIGRATION_RUNNABLE_ROLE,
  TERMINAL_BENCH_MIGRATION_SOURCE_ROLE,
  TERMINAL_BENCH_MIGRATION_STDERR_ROLE,
  TERMINAL_BENCH_MIGRATION_STDOUT_ROLE,
  TERMINAL_BENCH_MIGRATION_TRANSFORMED_ROLE,
  TerminalBench2SelectionManifestSchema,
  TerminalBenchRegistryMetadataSchema,
  TerminalBenchMigrationManifestSchema,
  terminalBench2SelectionBytes,
  terminalBenchMigrationBytes,
  type TerminalBenchMaterial,
} from "./terminal-bench-2/manifest.js";

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
  /** Exact sealed selection bytes. The contributor, not a lifecycle caller, assigns its role. */
  readonly selectionManifest?: {
    readonly id?: string;
    readonly digest: `sha256:${string}`;
    readonly bytes: Uint8Array;
    readonly mediaType?: string;
  };
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
  /**
   * The sealed registration closure is available without contacting a runtime.  Keeping this
   * synchronous is intentional: `lock` must seal the Run before any execution can start, and
   * must not invent a runtime-specific role itself.
   */
  registrationArtifacts(): readonly RuntimeRegistrationArtifact[];
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
  const manifest = HarborSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(selection[0]!.bytes)));
  if (!Buffer.from(selection[0]!.bytes).equals(Buffer.from(harborSelectionManifestBytes(manifest)))) {
    throw new TypeError("Harbor selection registration must use its exact canonical manifest encoding");
  }
  const terminalBenchProfileValue = manifest.profiles?.[TERMINAL_BENCH_2_PROFILE];
  const terminalBenchArtifacts = artifacts.filter((artifact) => artifact.role === TERMINAL_BENCH_2_SELECTION_ROLE);
  const migrationArtifacts = artifacts.filter((artifact) => artifact.role === TERMINAL_BENCH_MIGRATION_ROLE);
  if (terminalBenchProfileValue === undefined) {
    if (terminalBenchArtifacts.length !== 0 || migrationArtifacts.length !== 0) throw new TypeError("non-TB2 Harbor registration must not claim Terminal-Bench roles");
    return;
  }
  const profile = TerminalBench2SelectionManifestSchema.parse(terminalBenchProfileValue);
  const profileBytes = terminalBench2SelectionBytes(profile);
  const profileSha256 = sha256Hex(profileBytes);
  if (terminalBenchArtifacts.length !== 1 || terminalBenchArtifacts[0]!.digest !== `sha256:${profileSha256}`
    || !Buffer.from(terminalBenchArtifacts[0]!.bytes).equals(Buffer.from(profileBytes))) {
    throw new TypeError("Terminal-Bench 2 registration requires its exact profile bytes under the declared role");
  }
  if (profile.migrationManifestSha256 === undefined) {
    if (migrationArtifacts.length !== 0) throw new TypeError("Terminal-Bench migration role is unbound by the selected profile");
    return;
  }
  if (migrationArtifacts.length !== 1 || migrationArtifacts[0]!.digest !== `sha256:${profile.migrationManifestSha256}`
    || sha256Hex(migrationArtifacts[0]!.bytes) !== profile.migrationManifestSha256) throw new TypeError("Terminal-Bench migration registration does not match the selected profile");
  const migration = TerminalBenchMigrationManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(migrationArtifacts[0]!.bytes)));
  if (!Buffer.from(migrationArtifacts[0]!.bytes).equals(Buffer.from(terminalBenchMigrationBytes(migration)))) throw new TypeError("Terminal-Bench migration registration must use its exact canonical manifest encoding");
  if (!Buffer.from(canonicalJsonBytes(migration.runnable as never)).equals(Buffer.from(canonicalJsonBytes(profile.selectedTask.material as never)))) throw new TypeError("Terminal-Bench registered migration runnable bytes differ from selected task material");
}

export interface RuntimeRegistrationPublicationArtifact {
  readonly id: string;
  readonly role: string;
  readonly digestHex: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly dependsOn: readonly string[];
}

export interface RuntimeRegistrationPublicationClosure {
  readonly artifacts: readonly RuntimeRegistrationPublicationArtifact[];
  /** Only sealed Run registration roots are direct Benchmark dependencies. */
  readonly rootIds: readonly string[];
}

type MutableRuntimeRegistrationPublicationArtifact = Omit<RuntimeRegistrationPublicationArtifact, "dependsOn"> & { dependsOn: string[] };

function runtimeRootId(role: string, digestHex: string): string {
  return `runtime:${role}:${digestHex}`;
}

function exactMaterialArtifacts(
  workspaceDir: string,
  namespace: string,
  role: string,
  material: Pick<TerminalBenchMaterial, "checksum" | "files">,
): RuntimeRegistrationPublicationArtifact[] {
  const paths = new Set<string>();
  const artifacts: RuntimeRegistrationPublicationArtifact[] = [];
  for (const file of material.files) {
    if (file.path.startsWith("/") || file.path.includes("\\") || file.path.includes("\0")
      || file.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new TypeError(`runtime registration material has unsafe path ${file.path}`);
    }
    if (paths.has(file.path)) throw new TypeError(`runtime registration material repeats path ${file.path}`);
    paths.add(file.path);
    const bytes = getSealedBytes(workspaceDir, file.sha256);
    if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256) throw new TypeError(`runtime registration material does not match ${file.path}`);
    artifacts.push({
      id: `runtime-material:${namespace}:${encodeURIComponent(file.path)}:${file.sha256}`,
      role, digestHex: file.sha256, bytes, mediaType: "application/octet-stream", dependsOn: [],
    });
  }
  if (sha256Hex(canonicalJsonBytes(material.files as never)) !== material.checksum) throw new TypeError("runtime registration material inventory checksum does not match its files");
  return artifacts;
}

/** Expand only product-owned runtime roles. Generic record publication receives an already
 * validated dependency graph and never needs to parse Harbor or Terminal-Bench manifests. */
export function runtimeRegistrationPublicationClosure(
  workspaceDir: string,
  registrationArtifacts: readonly RegistrationArtifact[],
): RuntimeRegistrationPublicationClosure {
  const roots = registrationArtifacts.map((entry, index): RuntimeRegistrationArtifact => {
    const digestHex = entry.artifact.digest.sha256;
    return {
      id: `run-registration-${index}`,
      role: entry.role,
      digest: `sha256:${digestHex}`,
      bytes: getSealedBytes(workspaceDir, digestHex),
      mediaType: entry.artifact.mediaType ?? "application/octet-stream",
      actions: ["store"],
    };
  });
  const rootIds = registrationArtifacts.map((entry) => runtimeRootId(entry.role, entry.artifact.digest.sha256));
  if (new Set(rootIds).size !== rootIds.length) throw new TypeError("runtime registration has duplicate role/digest roots");
  const rootMembers = registrationArtifacts.map((entry): MutableRuntimeRegistrationPublicationArtifact => ({
    id: runtimeRootId(entry.role, entry.artifact.digest.sha256), role: entry.role,
    digestHex: entry.artifact.digest.sha256, bytes: getSealedBytes(workspaceDir, entry.artifact.digest.sha256),
    mediaType: entry.artifact.mediaType ?? "application/octet-stream", dependsOn: [],
  }));
  const harborRootIndex = registrationArtifacts.findIndex((entry) => entry.role === HARBOR_SELECTION_ROLE);
  if (harborRootIndex < 0) return { artifacts: rootMembers, rootIds };
  if (registrationArtifacts.filter((entry) => entry.role === HARBOR_SELECTION_ROLE).length !== 1) throw new TypeError("runtime registration requires one Harbor selection root");
  const harborDigest = registrationArtifacts[harborRootIndex]!.artifact.digest.sha256;
  assertHarborRegistration(harborDigest, roots);
  const harbor = HarborSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(rootMembers[harborRootIndex]!.bytes)));
  const nested: MutableRuntimeRegistrationPublicationArtifact[] = [];
  const ids = new Set(rootIds);
  const addNested = (artifact: RuntimeRegistrationPublicationArtifact): string => {
    if (ids.has(artifact.id)) throw new TypeError(`runtime registration closure has duplicate artifact id ${artifact.id}`);
    ids.add(artifact.id); nested.push({ ...artifact, dependsOn: [...artifact.dependsOn] }); return artifact.id;
  };
  const addExact = (namespace: string, role: string, digestHex: string): string => {
    const bytes = getSealedBytes(workspaceDir, digestHex);
    return addNested({ id: `runtime-material:${namespace}:${digestHex}`, role, digestHex, bytes, mediaType: "application/octet-stream", dependsOn: [] });
  };
  const addMaterial = (namespace: string, role: string, material: Pick<TerminalBenchMaterial, "checksum" | "files">): string[] =>
    exactMaterialArtifacts(workspaceDir, namespace, role, material).map(addNested);

  const harborDependencies = [
    addExact("harbor-executable", HARBOR_RUNTIME_EXECUTABLE_ROLE, harbor.harbor.executableSha256),
    ...addMaterial("harbor-source", HARBOR_SOURCE_MATERIAL_ROLE, harbor.source.resolved),
  ];
  const profileValue = harbor.profiles?.[TERMINAL_BENCH_2_PROFILE];
  if (profileValue !== undefined) {
    const profile = TerminalBench2SelectionManifestSchema.parse(profileValue);
    const profileSha256 = sha256Hex(terminalBench2SelectionBytes(profile));
    const profileRoot = rootMembers.find((entry) => entry.role === TERMINAL_BENCH_2_SELECTION_ROLE && entry.digestHex === profileSha256);
    if (profileRoot === undefined) throw new TypeError("Terminal-Bench selection root is absent from runtime registration");
    harborDependencies.push(profileRoot.id);
    if (harbor.source.resolved.checksum !== profile.selectedTask.datasetProjectionChecksum) throw new TypeError("Harbor source material differs from the Terminal-Bench dataset projection");
    if (profile.selectedTask.package.name !== `terminal-bench/${profile.selectedTask.filter}`) throw new TypeError("Terminal-Bench selected package and filter disagree");
    const selectedFromHarbor = harbor.source.resolved.files
      .filter((file) => file.path.startsWith(`${profile.selectedTask.filter}/`))
      .map((file) => ({ ...file, path: file.path.slice(profile.selectedTask.filter.length + 1) }));
    if (!Buffer.from(canonicalJsonBytes(selectedFromHarbor as never)).equals(Buffer.from(canonicalJsonBytes(profile.selectedTask.material.files as never)))) {
      throw new TypeError("Terminal-Bench selected task inventory differs from Harbor source material");
    }
    const registryBytes = getSealedBytes(workspaceDir, profile.dataset.registrySnapshotSha256);
    if (registryBytes.byteLength !== profile.dataset.registrySnapshotBytes) throw new TypeError("Terminal-Bench registry snapshot byte count does not match its profile");
    const registry = TerminalBenchRegistryMetadataSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(registryBytes)));
    if (`sha256:${registry.dataset_version_content_hash.replace(/^sha256:/u, "")}` !== profile.dataset.revision) throw new TypeError("Terminal-Bench registry snapshot revision differs from the profile");
    const registryMatches = registry.task_ids.filter((task) => task.name === profile.selectedTask.filter && task.ref === profile.selectedTask.package.ref);
    if (registryMatches.length !== 1) throw new TypeError("Terminal-Bench registry snapshot must contain the selected task/ref exactly once");
    const profileDependencies = [
      addNested({ id: `runtime-material:tb2-registry:${profile.dataset.registrySnapshotSha256}`, role: TERMINAL_BENCH_2_REGISTRY_ROLE, digestHex: profile.dataset.registrySnapshotSha256, bytes: registryBytes, mediaType: "application/octet-stream", dependsOn: [] }),
      ...addMaterial("tb2-selected-task", TERMINAL_BENCH_2_TASK_MATERIAL_ROLE, profile.selectedTask.material),
    ];
    if (profile.migrationManifestSha256 !== undefined) {
      const migrationRoot = rootMembers.find((entry) => entry.role === TERMINAL_BENCH_MIGRATION_ROLE && entry.digestHex === profile.migrationManifestSha256);
      if (migrationRoot === undefined) throw new TypeError("Terminal-Bench migration root is absent from runtime registration");
      profileDependencies.push(migrationRoot.id);
      const migration = TerminalBenchMigrationManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(migrationRoot.bytes)));
      if (!Buffer.from(migrationRoot.bytes).equals(Buffer.from(terminalBenchMigrationBytes(migration)))) throw new TypeError("Terminal-Bench migration manifest is not canonical exact bytes");
      if (migration.harbor.version !== harbor.harbor.version || migration.harbor.executableSha256 !== harbor.harbor.executableSha256) throw new TypeError("Terminal-Bench migration and execution Harbor pins differ");
      if (!Buffer.from(canonicalJsonBytes(migration.runnable as never)).equals(Buffer.from(canonicalJsonBytes(profile.selectedTask.material as never)))) throw new TypeError("Terminal-Bench migration runnable inventory differs from selected task material");
      const migrationDependencies = [
        addExact("tb-migration-executable", TERMINAL_BENCH_MIGRATION_EXECUTABLE_ROLE, migration.harbor.executableSha256),
        addExact("tb-migration-stdout", TERMINAL_BENCH_MIGRATION_STDOUT_ROLE, migration.command.stdoutSha256),
        addExact("tb-migration-stderr", TERMINAL_BENCH_MIGRATION_STDERR_ROLE, migration.command.stderrSha256),
        ...addMaterial("tb-migration-source", TERMINAL_BENCH_MIGRATION_SOURCE_ROLE, migration.source),
        ...addMaterial("tb-migration-transformed", TERMINAL_BENCH_MIGRATION_TRANSFORMED_ROLE, migration.transformed),
        ...addMaterial("tb-migration-runnable", TERMINAL_BENCH_MIGRATION_RUNNABLE_ROLE, migration.runnable),
      ];
      migrationRoot.dependsOn = [...migrationDependencies].sort();
    }
    profileRoot.dependsOn = [...profileDependencies].sort();
  }
  rootMembers[harborRootIndex]!.dependsOn = [...harborDependencies].sort();
  const nestedMediaTypes = new Map<string, string>();
  for (const artifact of nested) {
    const previous = nestedMediaTypes.get(artifact.digestHex);
    if (previous !== undefined && previous !== artifact.mediaType) throw new TypeError(`runtime dependency ${artifact.digestHex} has conflicting media types`);
    nestedMediaTypes.set(artifact.digestHex, artifact.mediaType);
  }
  nested.sort((left, right) => left.id.localeCompare(right.id));
  return { artifacts: [...nested, ...rootMembers], rootIds };
}

/** Adapter-owned registration closure used by run-lock. Every byte descriptor is read back
 * from product CAS and interpreted under the selected adapter before entering the Run. */
export function runtimeRegistrationArtifacts(workspaceDir: string, binding: EvaluationRuntimeBinding | undefined): readonly RegistrationArtifact[] {
  if (binding === undefined) return [];
  const selectionBytes = getSealedBytes(workspaceDir, binding.selectionManifestSha256);
  if (binding.adapterId === INSPECT_ADAPTER_ID) return [{ role: INSPECT_SELECTION_CORRELATION_ROLE, artifact: { digest: { sha256: binding.selectionManifestSha256 }, mediaType: "application/json" } }];
  if (binding.adapterId !== HARBOR_ADAPTER_ID) refuse("venue-unavailable", "spec.evaluationRuntime.adapterId", `evaluation runtime adapter "${binding.adapterId}" is not installed`);
  const manifest = HarborSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(selectionBytes)));
  const result: RegistrationArtifact[] = [{ role: HARBOR_SELECTION_ROLE, artifact: { digest: { sha256: binding.selectionManifestSha256 }, mediaType: "application/json" } }];
  const profileValue = manifest.profiles?.[TERMINAL_BENCH_2_PROFILE];
  if (profileValue !== undefined) {
    const profile = TerminalBench2SelectionManifestSchema.parse(profileValue);
    const profileBytes = terminalBench2SelectionBytes(profile);
    const profileSha256 = sha256Hex(profileBytes);
    if (!Buffer.from(getSealedBytes(workspaceDir, profileSha256)).equals(Buffer.from(profileBytes))) throw new TypeError("Terminal-Bench 2 profile CAS bytes do not match the Harbor selection");
    result.push({ role: TERMINAL_BENCH_2_SELECTION_ROLE, artifact: { digest: { sha256: profileSha256 }, mediaType: "application/json" } });
    if (profile.migrationManifestSha256 !== undefined) {
      const migrationBytes = getSealedBytes(workspaceDir, profile.migrationManifestSha256);
      const migration = TerminalBenchMigrationManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(migrationBytes)));
      if (migration.runnable.checksum !== profile.selectedTask.material.checksum) throw new TypeError("Terminal-Bench migration runnable bytes differ from selected task material");
      result.push({ role: TERMINAL_BENCH_MIGRATION_ROLE, artifact: { digest: { sha256: profile.migrationManifestSha256 }, mediaType: "application/json" } });
    }
  }
  return result.sort((left, right) => {
    const leftKey = `${left.role}\u001f${left.artifact.digest.sha256}`;
    const rightKey = `${right.role}\u001f${right.artifact.digest.sha256}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
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
    if (joined.selectionManifestSha256 !== expectedSelectionManifestSha256 || typeof harbor?.jobName !== "string" || typeof harbor.jobId !== "string" || typeof harbor.trialId !== "string" || typeof lineage?.submissionSha256 !== "string" || typeof lineage.attemptUri !== "string" || typeof lineage.runSha256 !== "string" || typeof lineage.cellKey !== "string" || !Number.isInteger(lineage.dispatchIndex)) throw new Error("correlation lacks complete product/Harbor identity binding");
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
      || selected.retryPolicy.nAttempts !== 1 || selected.retryPolicy.nConcurrent !== 1 || selected.retryPolicy.maxRetries !== 0) throw new Error("Harbor Job identity, lineage, or retry policy does not match the sealed runtime selection");
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
    registrationArtifacts() {
      // No reserialization or descriptor synthesis: registration bytes are already sealed by the runtime.
      const artifacts = options.registrationArtifacts ?? (() => {
        const selection = options.selectionManifest;
        if (selection === undefined) return [];
        const role = adapterId === HARBOR_ADAPTER_ID
          ? HARBOR_SELECTION_ROLE
          : adapterId === INSPECT_ADAPTER_ID
            ? INSPECT_SELECTION_CORRELATION_ROLE
            : undefined;
        return role === undefined ? [] : [{
          id: selection.id ?? "runtime-selection-manifest.json",
          role,
          digest: selection.digest,
          bytes: selection.bytes,
          mediaType: selection.mediaType ?? "application/json",
          actions: ["store"] as const,
        }];
      })();
      if (adapterId === INSPECT_ADAPTER_ID && expectedSelectionManifestSha256 !== undefined) assertInspectRegistration(expectedSelectionManifestSha256, artifacts);
      if (adapterId === HARBOR_ADAPTER_ID && expectedSelectionManifestSha256 !== undefined) assertHarborRegistration(expectedSelectionManifestSha256, artifacts);
      return artifacts;
    },
    async registration() { return adapter.registrationArtifacts(); },
    async dispatch(input: RuntimeEvidenceDispatchInput) {
      // A native source can be absent or collection can fail. Preserve those facts rather than inventing a blob.
      const correlations = input.correlations ?? [];
      // Contribution is a lossless projection, including incomplete capture. Profile validity
      // belongs to `verify`, where it can remain tri-state instead of being collapsed into an
      // exception before the caller can preserve the named checks.
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
