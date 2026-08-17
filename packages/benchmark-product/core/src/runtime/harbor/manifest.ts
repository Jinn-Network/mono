/** Immutable, pre-dispatch selection for the managed direct Harbor adapter. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { sha256Hex } from "../../workspace/sealed-store.js";

export const HARBOR_ADAPTER_ID = "harbor" as const;
export const HARBOR_SELECTION_SCHEMA = "jinn.network/benchmark-product/harbor-selection/1" as const;
export const HARBOR_RUNTIME_EVIDENCE_PROFILE = "https://product.jinn.network/profiles/harbor-evidence/v1" as const;
export const HARBOR_RUNTIME_EXECUTABLE_ROLE = "https://product.jinn.network/artifact-roles/harbor/runtime-executable/v1" as const;
export const HARBOR_SOURCE_MATERIAL_ROLE = "https://product.jinn.network/artifact-roles/harbor/source-material/v1" as const;
export const SUPPORTED_HARBOR_VERSION_RANGE = "0.21.x" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const LogicalPath = z.string().min(1).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/u);
const Json: z.ZodType<unknown> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(Json), z.record(z.string(), Json)]));
const MaterialFile = z.object({ path: z.string().min(1), sha256: Sha256, bytes: z.number().int().nonnegative() }).strict();
const ResolvedMaterial = z.object({
  reference: z.string().min(1), revision: z.string().min(1), checksum: Sha256,
  files: z.array(MaterialFile).min(1),
}).strict();
const DatasetInput = z.union([
  z.object({ path: LogicalPath }).strict(),
  z.object({ name: z.string().min(1), version: z.string().min(1), ref: z.never().optional() }).strict(),
  z.object({ name: z.string().min(1), ref: z.string().min(1), version: z.never().optional() }).strict(),
]);
const TaskInput = z.union([
  z.object({ path: LogicalPath }).strict(),
  z.object({ name: z.string().regex(/^[^/]+\/[^/]+$/u), ref: z.string().min(1) }).strict(),
]);
export type HarborDatasetInput = z.infer<typeof DatasetInput>;
export type HarborTaskInput = z.infer<typeof TaskInput>;
const ArtifactConfig = z.object({
  source: z.string().min(1).refine((value) => !value.split("/").includes("..")),
  destination: z.string().min(1)
    .refine((value) => !value.includes("\\"), "must use forward-slash separators")
    .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/u)
    .refine((value) => !/^(?:\.\/?)+$/u.test(value), "must name a file or directory")
    .refine((value) => value.replace(/\/+$/u, "") !== "manifest.json", "manifest.json is reserved")
    .nullable().optional(),
  exclude: z.array(z.string()).optional(),
  service: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.service !== undefined && value.service !== null && value.service !== "main" && !value.source.startsWith("/") && !/^[A-Za-z]:[/\\]/u.test(value.source)) {
    context.addIssue({ code: "custom", path: ["source"], message: "sidecar artifact source must be absolute" });
  }
}).transform((value) => {
  const normalized = { ...value };
  if (normalized.destination === null) delete normalized.destination;
  if (normalized.exclude?.length === 0) delete normalized.exclude;
  if (normalized.service === null) delete normalized.service;
  return normalized;
});
const EnvironmentType = z.enum(["docker", "daytona", "e2b", "modal", "runloop", "langsmith", "ec2", "gke", "ack", "openshift", "novita", "apple-container", "singularity", "islo", "tensorlake", "cwsandbox", "wandb", "use-computer", "cua-cloud", "blaxel", "opensandbox", "beam", "skypilot", "hf-sandbox"]);
const ResourceMode = z.enum(["auto", "limit", "request", "guarantee", "ignore"]);
const ServiceVolume = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bind"), source: z.string().min(1), target: z.string().min(1), read_only: z.literal(true).optional(), bind: z.object({ create_host_path: z.literal(false).optional() }).strict().optional() }).strict(),
  z.object({ type: z.literal("volume"), source: z.string().min(1), target: z.string().min(1), read_only: z.literal(true).optional(), volume: z.object({ subpath: z.string().min(1).optional() }).strict().optional() }).strict(),
  z.object({ type: z.literal("image"), source: z.string().min(1), target: z.string().min(1), read_only: z.literal(true).optional(), image: z.object({ subpath: z.string().min(1).optional() }).strict().optional() }).strict(),
]);
/** Strict Harbor 0.21 EnvironmentConfig fields, excluding the separately-required `type`. */
const HarborEnvironmentConfigurationRawSchema = z.object({
  import_path: z.string().min(1).nullable().optional(), force_build: z.boolean().optional(), delete: z.boolean().optional(),
  cpu_enforcement_policy: ResourceMode.optional(), memory_enforcement_policy: ResourceMode.optional(),
  override_cpus: z.number().int().positive().nullable().optional(), override_memory_mb: z.number().int().positive().nullable().optional(),
  override_storage_mb: z.number().int().positive().nullable().optional(), override_gpus: z.number().int().nonnegative().nullable().optional(),
  override_tpu: z.object({ type: z.string().min(1), topology: z.string().regex(/^[1-9]\d*(?:x[1-9]\d*)+$/u) }).strict().nullable().optional(), mounts: z.array(ServiceVolume).nullable().optional(), extra_docker_compose: z.array(z.string().min(1)).optional(),
  env: z.record(z.string(), z.string()).optional(), kwargs: z.record(z.string(), Json).optional(),
}).strict();

function canonicalEnvironmentConfiguration(value: z.infer<typeof HarborEnvironmentConfigurationRawSchema>): z.infer<typeof HarborEnvironmentConfigurationRawSchema> {
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => {
    if (key === "force_build") return item !== false;
    if (key === "delete") return item !== true;
    if (key === "cpu_enforcement_policy" || key === "memory_enforcement_policy") return item !== "auto";
    if (["import_path", "override_cpus", "override_memory_mb", "override_storage_mb", "override_gpus", "override_tpu", "mounts"].includes(key)) return item !== null;
    if (key === "extra_docker_compose") return !Array.isArray(item) || item.length > 0;
    if (key === "env" || key === "kwargs") return typeof item !== "object" || item === null || Object.keys(item).length > 0;
    return true;
  })) as z.infer<typeof HarborEnvironmentConfigurationRawSchema>;
}

export const HarborEnvironmentConfigurationSchema = HarborEnvironmentConfigurationRawSchema.transform(canonicalEnvironmentConfiguration);
const JobEnvironmentConfig = HarborEnvironmentConfigurationRawSchema.extend({ type: EnvironmentType }).transform(({ type, ...configuration }) => ({ type, ...canonicalEnvironmentConfiguration(configuration) }));
const JobAgentConfigRawSchema = z.object({ name: z.string().min(1), model_name: z.string().min(1), kwargs: z.record(z.string(), Json).optional() }).strict();
const JobAgentConfig = JobAgentConfigRawSchema.transform((value): z.infer<typeof JobAgentConfigRawSchema> => {
  const { kwargs, ...rest } = value;
  return kwargs !== undefined && Object.keys(kwargs).length === 0 ? rest : value;
});
const ArmSelection = z.object({
  armId: z.string().min(1),
  agent: z.object({ id: z.string().min(1), configuration: z.record(z.string(), Json) }).strict(),
  model: z.object({ id: z.string().min(1), configuration: z.record(z.string(), Json) }).strict(),
  /** Exact official Harbor 0.21 AgentConfig subset emitted for this arm. */
  jobAgent: JobAgentConfig,
}).strict().superRefine((arm, context) => {
  if (arm.jobAgent.name !== arm.agent.id) context.addIssue({ code: "custom", path: ["jobAgent", "name"], message: "must equal resolved agent id" });
  if (arm.jobAgent.model_name !== arm.model.id) context.addIssue({ code: "custom", path: ["jobAgent", "model_name"], message: "must equal resolved model id" });
});

/** Harbor 0.21 JobConfig may cover planned trials (`n_attempts` = locked replicates). Inner retry stays off. */
export const HarborSelectionManifestSchema = z.object({
  schema: z.literal(HARBOR_SELECTION_SCHEMA),
  adapter: z.object({ id: z.literal(HARBOR_ADAPTER_ID), version: z.literal("1") }).strict(),
  harbor: z.object({ version: z.string().regex(/^0\.21\.\d+(?:[-+][0-9A-Za-z.-]+)?$/), executableSha256: Sha256 }).strict(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("task"), input: TaskInput, jobInput: z.object({ path: z.literal(".jinn-harbor/task") }).strict(), resolved: ResolvedMaterial }).strict(),
    z.object({
      kind: z.literal("dataset"), input: DatasetInput, jobInput: z.object({ path: z.literal(".jinn-harbor/dataset") }).strict(), resolved: ResolvedMaterial,
      taskName: z.string().min(1),
      /** When omitted, the Job filters to `taskName` only (TB 2.0 one-task path). */
      taskNames: z.array(z.string().min(1)).min(1).optional(),
    }).strict(),
  ]),
  arms: z.array(ArmSelection).min(1).superRefine((arms, context) => {
    const ids = arms.map((arm) => arm.armId);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Harbor arm mappings must be unique" });
  }),
  /** `image` is immutable task/environment material evidence, never EnvironmentConfig.type. */
  environment: z.object({ type: EnvironmentType, image: z.string().regex(/@sha256:[a-f0-9]{64}$/u), configuration: HarborEnvironmentConfigurationSchema }).strict(),
  outputs: z.array(z.object({ name: z.string().min(1), mediaType: z.string().min(1), artifact: ArtifactConfig, nativePath: z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/u) }).strict()).min(1),
  retryPolicy: z.object({ nAttempts: z.number().int().positive(), nConcurrent: z.number().int().positive(), maxRetries: z.literal(0) }).strict(),
  /** `per-dispatch` is the TB 2.0 one-trial Job. `per-arm` is one Job spanning that arm's planned trials. */
  jobGrain: z.enum(["per-dispatch", "per-arm"]).optional(),
  /** Product-tier selection profiles may bind extra immutable resolution evidence without
   * teaching this reusable Harbor seam any benchmark-specific policy. */
  profiles: z.record(z.string().url(), Json).optional(),
}).strict();

const TaskNameList = z.array(z.string().min(1)).min(1);
const DatasetTaskFilter = {
  task_names: TaskNameList,
  n_tasks: z.number().int().positive(),
} as const;
function refineTaskFilter(value: { task_names: readonly string[]; n_tasks: number }, context: z.RefinementCtx): void {
  if (value.n_tasks !== value.task_names.length) {
    context.addIssue({ code: "custom", message: "n_tasks must equal task_names length", path: ["n_tasks"] });
  }
}

/** The exact non-deprecated Harbor 0.21 JobConfig subset emitted by this adapter. */
const HarborJobConfigBase = z.object({
  job_name: z.string().min(1), jobs_dir: z.string().min(1), n_attempts: z.number().int().positive(), n_concurrent_trials: z.number().int().positive(),
  retry: z.object({ max_retries: z.literal(0) }).strict(),
  environment: JobEnvironmentConfig,
  agents: z.tuple([JobAgentConfig]), artifacts: z.array(ArtifactConfig).min(1),
});
const DatasetExecutionInput = z.union([
  z.object({ path: LogicalPath, ...DatasetTaskFilter }).strict().superRefine(refineTaskFilter),
  z.object({ name: z.string().min(1), version: z.string().min(1), ...DatasetTaskFilter }).strict().superRefine(refineTaskFilter),
  z.object({ name: z.string().min(1), ref: z.string().min(1), ...DatasetTaskFilter }).strict().superRefine(refineTaskFilter),
]);
export const HarborJobConfigSchema = z.union([
  HarborJobConfigBase.extend({ tasks: z.tuple([TaskInput]) }).strict(),
  HarborJobConfigBase.extend({ datasets: z.tuple([DatasetExecutionInput]) }).strict(),
]);
export type HarborJobConfig = z.infer<typeof HarborJobConfigSchema>;

/**
 * Harbor 0.21 persists JobConfig with Pydantic `exclude_defaults=True`. Restore only the
 * defaults that the submitted, strict JobConfig explicitly committed, then require the entire
 * effective saved config to equal that submitted config. Explicit contradictions are never
 * treated as omissions.
 */
export function normalizeHarborSavedJobConfig(saved: unknown, submitted: unknown): HarborJobConfig {
  const committed = HarborJobConfigSchema.parse(submitted);
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) throw new TypeError("saved Harbor JobConfig must be an object");
  const document = saved as Record<string, unknown>;
  const retry = document.retry;
  const environment = document.environment;
  const committedEnvironmentIsDefault = committed.environment.type === "docker" && Object.keys(committed.environment).length === 1;
  const normalized: Record<string, unknown> = {
    ...document,
    ...(document.n_attempts === undefined ? { n_attempts: committed.n_attempts } : {}),
    ...(document.n_concurrent_trials === undefined ? { n_concurrent_trials: committed.n_concurrent_trials } : {}),
    ...(retry === undefined && committed.retry.max_retries === 0
      ? { retry: { max_retries: 0 } }
      : typeof retry === "object" && retry !== null && !Array.isArray(retry) && (retry as Record<string, unknown>).max_retries === undefined && committed.retry.max_retries === 0
        ? { retry: { ...(retry as Record<string, unknown>), max_retries: 0 } }
        : {}),
    ...(environment === undefined && committedEnvironmentIsDefault
      ? { environment: { type: "docker" } }
      : typeof environment === "object" && environment !== null && !Array.isArray(environment)
      && (environment as Record<string, unknown>).type === undefined && committed.environment.type === "docker"
      ? { environment: { ...(environment as Record<string, unknown>), type: "docker" } }
      : {}),
  };
  const effective = HarborJobConfigSchema.parse(normalized);
  if (!Buffer.from(canonicalJsonBytes(effective as never)).equals(Buffer.from(canonicalJsonBytes(committed as never)))) {
    throw new TypeError("saved Harbor JobConfig contradicts the submitted JobConfig");
  }
  return effective;
}

export function harborSelectedTaskNames(source: HarborSelectionManifest["source"]): readonly string[] {
  if (source.kind !== "dataset") return [];
  return source.taskNames ?? [source.taskName];
}

function harborTrialTaskName(trial: Readonly<Record<string, unknown>>): string {
  const task = trial.task;
  if (typeof task === "object" && task !== null && "name" in task && typeof task.name === "string") return task.name;
  if (typeof trial.task_name === "string") return trial.task_name;
  return "";
}

function harborTrialAttempt(trial: Readonly<Record<string, unknown>>): number {
  const value = trial.attempt_number ?? trial.attempt;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

/** Inner Harbor retry stays off for every grain. Planned `n_attempts` is not a retry. */
export function assertHarborRetryPinnedOff(
  job: HarborJobConfig,
  trial: Readonly<Record<string, unknown>>,
  jobResult: Readonly<Record<string, unknown>>,
): void {
  const stats = jobResult.stats;
  if (
    job.retry.max_retries !== 0
    || (trial.source_trial !== undefined && trial.source_trial !== null)
    || typeof stats !== "object"
    || stats === null
    || Array.isArray(stats)
    || (stats as Record<string, unknown>).n_retries !== 0
  ) {
    throw new Error("effective Harbor Job/Trial permits hidden attempts or retries");
  }
}

/**
 * Harbor 0.21 does not persist an attempt number in TrialConfig. Prove the
 * effective one-Trial/no-retry execution from the committed JobConfig and
 * resolved JobResult instead. Older fixtures may carry an explicit attempt;
 * when present, it must still be exactly one.
 */
export function assertSingleHarborTrial(
  job: HarborJobConfig,
  trial: Readonly<Record<string, unknown>>,
  jobResult: Readonly<Record<string, unknown>>,
): void {
  assertHarborRetryPinnedOff(job, trial, jobResult);
  const trialAttempt = trial.attempt_number ?? trial.attempt;
  if (
    job.n_attempts !== 1
    || job.n_concurrent_trials !== 1
    || (trialAttempt !== undefined && trialAttempt !== 1)
    || jobResult.n_total_trials !== 1
  ) {
    throw new Error("effective Harbor Job/Trial permits hidden attempts or retries");
  }
}

export function assertHarborTrialMatchesCell(
  job: HarborJobConfig,
  trial: Readonly<Record<string, unknown>>,
  jobResult: Readonly<Record<string, unknown>>,
  expected: { readonly taskName: string; readonly attempt: number },
): void {
  assertHarborRetryPinnedOff(job, trial, jobResult);
  const names = "datasets" in job ? job.datasets[0]!.task_names : [];
  const expectedTrials = job.n_attempts * ("datasets" in job ? job.datasets[0]!.n_tasks : 1);
  if (
    job.n_attempts < expected.attempt
    || harborTrialAttempt(trial) !== expected.attempt
    || harborTrialTaskName(trial) !== expected.taskName
    || (names.length > 0 && !names.includes(expected.taskName))
    || (typeof jobResult.n_total_trials === "number" && jobResult.n_total_trials !== expectedTrials)
  ) {
    throw new Error("Harbor Trial does not match the locked cell");
  }
}

export function harborJobSource(manifest: HarborSelectionManifest): { readonly tasks: readonly [z.infer<typeof TaskInput>] } | { readonly datasets: readonly [z.infer<typeof DatasetExecutionInput>] } {
  if (manifest.source.kind === "task") return { tasks: [manifest.source.jobInput] };
  const task_names = [...harborSelectedTaskNames(manifest.source)];
  return { datasets: [{ ...manifest.source.jobInput, task_names, n_tasks: task_names.length }] as [z.infer<typeof DatasetExecutionInput>] };
}

export type HarborSelectionManifest = z.infer<typeof HarborSelectionManifestSchema>;

export function harborSelectionManifestBytes(manifest: HarborSelectionManifest): Uint8Array {
  return canonicalJsonBytes(HarborSelectionManifestSchema.parse(manifest) as never);
}

export function harborSelectionManifestSha256(manifest: HarborSelectionManifest): string {
  return sha256Hex(harborSelectionManifestBytes(manifest));
}

/** Rejects broad ranges and every Harbor release outside the supported 0.21 line. */
export function assertSupportedHarborVersion(version: string): void {
  if (!/^0\.21\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new TypeError(`managed Harbor adapter requires Harbor ${SUPPORTED_HARBOR_VERSION_RANGE}; received ${version}`);
  }
}
