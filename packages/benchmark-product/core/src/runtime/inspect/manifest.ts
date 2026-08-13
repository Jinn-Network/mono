import { z } from "zod";

export const INSPECT_ADAPTER_ID = "inspect" as const;
export const SUPPORTED_INSPECT_VERSION = "0.3.255" as const;
export const SUPPORTED_INSPECT_WHEEL_SHA256 = "958e773a8d0cc8873314e3f96d1143cbb4e0b9e4bacc2cbec6b4d5576ceecf2c" as const;
export const SUPPORTED_INSPECT_EVALS_VERSION = "0.16.0" as const;
export const SUPPORTED_OPENAI_SDK_VERSION = "2.53.0" as const;
export const SUPPORTED_OCI_PYTHON_VERSION = "3.11.9" as const;
export const SUPPORTED_OCI_PLATFORM = "linux/amd64" as const;
export const INSPECT_SELECTION_SCHEMA = "jinn.network/benchmark-product/inspect-selection/1" as const;
export const INSPECT_SANDBOX_SELECTION_SCHEMA = "jinn.network/benchmark-product/inspect-selection/2" as const;
export const INSPECT_SANDBOX_PROTOCOL = "jinn.network/inspect-sandbox-host/1" as const;
export const INSPECT_SANDBOX_PROVIDER = "jinn-oci" as const;
export const INSPECT_SANDBOX_PACKAGE_VERSION = "0.1.0" as const;
export const INSPECT_ARM_REQUIREMENT_KEY = "jinn.network/inspect-arm" as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const JsonScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const SafeJsonSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  JsonScalarSchema,
  z.array(SafeJsonSchema),
  z.record(z.string(), SafeJsonSchema),
]));

export const InspectArmConfigurationSchema = z.object({
  armId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  model: z.string().min(1),
  modelArgs: z.record(z.string(), SafeJsonSchema).optional(),
  modelRoles: z.record(z.string(), z.string().min(1)).optional(),
  provider: z.object({
    surface: z.literal("openai-responses"),
    upstreamModel: z.literal("gpt-5.6-luna"),
    reasoningEffort: z.enum(["none", "low"]),
    maxOutputTokens: z.literal(128),
    store: z.literal(false),
    background: z.literal(false),
    stream: z.literal(false),
    serviceTier: z.literal("default"),
    tools: z.tuple([]),
    fallbackModels: z.tuple([]),
    retries: z.literal(0),
    persistedConversation: z.literal(false),
    metadata: z.null(),
    promptCacheIdentifier: z.null(),
  }).strict().optional(),
}).superRefine((arm, context) => {
  if (arm.provider === undefined) return;
  if (arm.model !== "jinn-openai/gpt-5.6-luna") {
    context.addIssue({ code: "custom", path: ["model"], message: "provider-backed arms require jinn-openai/gpt-5.6-luna" });
  }
  if (arm.modelArgs !== undefined || arm.modelRoles !== undefined) {
    context.addIssue({ code: "custom", message: "provider-backed arms refuse modelArgs and modelRoles outside the sealed generation block" });
  }
});

export const InspectRunOptionsSchema = z.object({
  sampleId: z.union([z.string().min(1), z.number().int()]).optional(),
  maxSamples: z.number().int().positive().optional(),
  maxSubprocesses: z.number().int().positive().optional(),
  maxSandboxes: z.number().int().positive().optional(),
  retryOnError: z.number().int().nonnegative().optional(),
  failOnError: z.union([z.boolean(), z.number().int().nonnegative()]).optional(),
  messageLimit: z.number().int().positive().optional(),
  tokenLimit: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
  timeLimit: z.number().int().positive().optional(),
}).strict();

const InspectOciIsolationSchema = z.object({
  readOnlyRoot: z.literal(true),
  network: z.enum(["none", "broker-only"]),
  capabilities: z.tuple([]),
  noNewPrivileges: z.literal(true),
  cpuCount: z.number().positive(),
  memoryBytes: z.number().int().positive(),
  pidsLimit: z.number().int().positive(),
  scratchBytes: z.number().int().positive(),
  user: z.string().regex(/^[0-9]+:[0-9]+$/),
  mounts: z.union([
    z.tuple([
      z.literal("project:ro"),
      z.literal("dataset-cache:ro"),
      z.literal("attempt-input:ro"),
      z.literal("attempt-output:rw"),
    ]),
    z.tuple([
      z.literal("project:ro"),
      z.literal("dataset-cache:ro"),
      z.literal("attempt-input:ro"),
      z.literal("attempt-output:rw"),
      z.literal("broker-capability:ro"),
    ]),
  ]),
}).strict();

const InspectBrokerPolicySchema = z.object({
  protocol: z.literal("jinn.network/model-broker/1"),
  requestEndpoint: z.literal("https://api.openai.com/v1/responses"),
  network: z.literal("bridge-plus-private-internal"),
  secretMount: z.literal("credential-volume:/run/secrets:ro"),
  capabilityMount: z.literal("capability-volume:/run/jinn:ro"),
  readOnlyRoot: z.literal(true),
  capabilities: z.tuple([]),
  noNewPrivileges: z.literal(true),
  cpuCount: z.literal(1),
  memoryBytes: z.literal(268_435_456),
  pidsLimit: z.literal(32),
  scratchBytes: z.literal(67_108_864),
}).strict();

export const InspectSandboxPolicySchema = z.object({
  provider: z.literal(INSPECT_SANDBOX_PROVIDER),
  platform: z.literal(SUPPORTED_OCI_PLATFORM),
  user: z.literal("65532:65532"),
  readOnlyRoot: z.literal(true),
  network: z.literal("none"),
  capabilities: z.tuple([]),
  noNewPrivileges: z.literal(true),
  cpuCount: z.literal(1),
  memoryBytes: z.literal(536_870_912),
  pidsLimit: z.literal(32),
  scratchBytes: z.literal(268_435_456),
  maxEnvironments: z.literal(1),
  maxOperations: z.literal(64),
  commandTimeoutSeconds: z.literal(30),
  totalTimeoutSeconds: z.literal(120),
  maxInputBytes: z.literal(16 * 1024 * 1024),
  maxOutputBytes: z.literal(20 * 1024 * 1024),
  maxReadFileBytes: z.literal(100 * 1024 * 1024),
}).strict();

const InspectSandboxRuntimeSchema = z.object({
  protocol: z.literal(INSPECT_SANDBOX_PROTOCOL),
  provider: z.literal(INSPECT_SANDBOX_PROVIDER),
  packageVersion: z.literal(INSPECT_SANDBOX_PACKAGE_VERSION),
  providerSourceSha256: Sha256Schema,
  controllerSourceSha256: Sha256Schema,
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  platform: z.literal(SUPPORTED_OCI_PLATFORM),
  policySha256: Sha256Schema,
  policy: InspectSandboxPolicySchema,
}).strict();

export const InspectOciRuntimeIdentitySchema = z.object({
  kind: z.literal("oci"),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  platform: z.literal(SUPPORTED_OCI_PLATFORM),
  inspectEvalsVersion: z.literal(SUPPORTED_INSPECT_EVALS_VERSION),
  openaiSdkVersion: z.literal(SUPPORTED_OPENAI_SDK_VERSION),
  workerSourceSha256: Sha256Schema,
  runtimeHostSourceSha256: Sha256Schema,
  brokerSourceSha256: Sha256Schema,
  modelProviderSourceSha256: Sha256Schema,
  dockerExecutableSha256: Sha256Schema,
  dockerEngineVersion: z.string().min(1),
  dockerApiVersion: z.string().min(1),
  datasetCacheSha256: Sha256Schema,
  isolation: InspectOciIsolationSchema,
  broker: InspectBrokerPolicySchema.optional(),
  sandbox: InspectSandboxRuntimeSchema.optional(),
}).strict();

const InspectResolvedSandboxSchema = z.object({
  type: z.literal(INSPECT_SANDBOX_PROVIDER),
  config: z.object({
    schema: z.literal("jinn.network/benchmark-product/inspect-sandbox/1"),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    platform: z.literal(SUPPORTED_OCI_PLATFORM),
    policySha256: Sha256Schema,
  }).strict(),
}).strict();

const InspectDeclaredSandboxSchema = z.object({
  type: z.literal("docker"),
  config: z.null(),
}).strict();

export const InspectSelectionManifestSchema = z.object({
  schema: z.union([z.literal(INSPECT_SELECTION_SCHEMA), z.literal(INSPECT_SANDBOX_SELECTION_SCHEMA)]),
  runtime: z.object({
    adapterVersion: z.literal("1"),
    workerSha256: Sha256Schema,
    inspectVersion: z.literal(SUPPORTED_INSPECT_VERSION),
    inspectWheelSha256: z.literal(SUPPORTED_INSPECT_WHEEL_SHA256),
    pythonVersion: z.string().regex(/^3\.1[1-9](?:\.|$)/),
    pythonExecutableSha256: Sha256Schema,
    pythonEnvironmentSha256: Sha256Schema,
    inspectDistributionSha256: Sha256Schema,
    execution: InspectOciRuntimeIdentitySchema.optional(),
  }).superRefine((runtime, context) => {
    if (runtime.execution === undefined) return;
    if (runtime.pythonVersion !== SUPPORTED_OCI_PYTHON_VERSION) {
      context.addIssue({ code: "custom", path: ["pythonVersion"], message: `OCI execution requires Python ${SUPPORTED_OCI_PYTHON_VERSION}` });
    }
    if (runtime.execution.workerSourceSha256 !== runtime.workerSha256) {
      context.addIssue({ code: "custom", path: ["execution", "workerSourceSha256"], message: "OCI worker source digest must match the executed worker" });
    }
  }),
  task: z.object({
    reference: z.string().min(1),
    args: z.record(z.string(), SafeJsonSchema),
    resolvedName: z.string().min(1),
    resolvedVersion: z.string().nullable(),
    declaredSandbox: InspectDeclaredSandboxSchema.optional(),
    resolvedSandbox: z.union([z.null(), InspectResolvedSandboxSchema]),
    source: z.object({
      kind: z.enum(["project-file", "installed-package"]),
      path: z.string().min(1),
      sha256: Sha256Schema,
      projectTreeSha256: Sha256Schema.optional(),
      distribution: z.object({
        name: z.string().min(1),
        version: z.string().min(1),
        sha256: Sha256Schema,
      }).optional(),
    }).superRefine((source, context) => {
      if (source.kind === "project-file" && source.projectTreeSha256 === undefined) {
        context.addIssue({ code: "custom", message: "project-file sources require a project tree digest" });
      }
      if (source.kind === "installed-package" && source.distribution === undefined) {
        context.addIssue({ code: "custom", message: "installed-package sources require distribution identity" });
      }
    }),
    dataset: z.object({
      name: z.string().nullable(),
      location: z.string().nullable(),
      samples: z.number().int().nonnegative().nullable(),
      selectedSampleId: z.union([z.string().min(1), z.number().int()]).optional(),
      orderedSampleSha256: Sha256Schema.optional(),
    }),
  }),
  arms: z.array(InspectArmConfigurationSchema).min(2),
  scorer: z.object({
    name: z.string().min(1),
    passValue: JsonScalarSchema,
    definition: SafeJsonSchema,
  }),
  runOptions: InspectRunOptionsSchema,
}).strict().superRefine((manifest, context) => {
  const providerBacked = manifest.arms.some((arm) => arm.provider !== undefined);
  const sandboxed = manifest.runtime.execution?.sandbox !== undefined;
  if (sandboxed !== (manifest.schema === INSPECT_SANDBOX_SELECTION_SCHEMA)) {
    context.addIssue({ code: "custom", path: ["schema"], message: "sandbox selections require selection schema v2" });
  }
  if (sandboxed !== (manifest.task.resolvedSandbox !== null) || sandboxed !== (manifest.task.declaredSandbox !== undefined)) {
    context.addIssue({ code: "custom", path: ["task", "resolvedSandbox"], message: "sandbox runtime, declared sandbox, and effective sandbox must be present together" });
  }
  if (sandboxed) {
    const selected = manifest.runtime.execution?.sandbox;
    const resolved = manifest.task.resolvedSandbox;
    if (
      selected === undefined
      || resolved === null
      || resolved.config.imageDigest !== selected.imageDigest
      || resolved.config.platform !== selected.platform
      || resolved.config.policySha256 !== selected.policySha256
    ) {
      context.addIssue({ code: "custom", path: ["task", "resolvedSandbox"], message: "effective sandbox must match the sealed sandbox runtime" });
    }
  }
  if (manifest.runtime.execution === undefined) {
    if (providerBacked) {
      context.addIssue({ code: "custom", path: ["runtime", "execution"], message: "provider-backed arms require OCI execution" });
    }
    return;
  }
  if (manifest.runOptions.sampleId === undefined) {
    context.addIssue({ code: "custom", path: ["runOptions", "sampleId"], message: "OCI execution requires one exact sampleId" });
  }
  if (manifest.task.dataset.selectedSampleId !== manifest.runOptions.sampleId) {
    context.addIssue({ code: "custom", path: ["task", "dataset", "selectedSampleId"], message: "selected dataset sample must match runOptions.sampleId" });
  }
  if (manifest.task.dataset.orderedSampleSha256 === undefined) {
    context.addIssue({ code: "custom", path: ["task", "dataset", "orderedSampleSha256"], message: "OCI execution requires an ordered selected-sample digest" });
  }
  if (providerBacked && manifest.runtime.execution.isolation.network !== "broker-only") {
    context.addIssue({ code: "custom", path: ["runtime", "execution", "isolation", "network"], message: "provider-backed arms require the broker-only OCI network" });
  }
  if (providerBacked && !(manifest.runtime.execution.isolation.mounts as readonly string[]).includes("broker-capability:ro")) {
    context.addIssue({ code: "custom", path: ["runtime", "execution", "isolation", "mounts"], message: "provider-backed arms require the per-attempt broker capability mount" });
  }
  if (providerBacked && manifest.runtime.execution.broker === undefined) {
    context.addIssue({ code: "custom", path: ["runtime", "execution", "broker"], message: "provider-backed arms require the sealed broker policy" });
  }
  if (!providerBacked && manifest.runtime.execution.broker !== undefined) {
    context.addIssue({ code: "custom", path: ["runtime", "execution", "broker"], message: "credential-free OCI selections cannot carry a broker policy" });
  }
  if (providerBacked && manifest.runOptions.retryOnError !== 0) {
    context.addIssue({ code: "custom", path: ["runOptions", "retryOnError"], message: "provider-backed arms require retryOnError: 0" });
  }
});

export type InspectArmConfiguration = z.infer<typeof InspectArmConfigurationSchema>;
export type InspectRunOptions = z.infer<typeof InspectRunOptionsSchema>;
export type InspectSelectionManifest = z.infer<typeof InspectSelectionManifestSchema>;
export type InspectSandboxPolicy = z.infer<typeof InspectSandboxPolicySchema>;

const SECRETISH_KEY = /(?:^|[_-])(api[_-]?key|authorization|credential|password|private[_-]?key|secret|token)(?:$|[_-])/iu;
const SECRETISH_VALUES = [
  /(?:^|\s)sk-(?:proj-)?[A-Za-z0-9_-]{16,}(?:$|\s)/u,
  /(?:^|\s)(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})(?:$|\s)/u,
  /(?:^|\s)AKIA[A-Z0-9]{16}(?:$|\s)/u,
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /(?:^|\s)Bearer\s+[A-Za-z0-9._~-]{16,}(?:$|\s)/u,
  /(?:^|\s)eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|\s)/u,
] as const;

/** Sealed runtime configuration is public-safe metadata, never a credential carrier. */
export function assertNoSecretLikeConfiguration(value: unknown, path = "selection"): void {
  if (typeof value === "string") {
    if (SECRETISH_VALUES.some((pattern) => pattern.test(value))) {
      throw new TypeError(`${path} contains a credential-shaped value and cannot be sealed into an Inspect selection`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretLikeConfiguration(entry, `${path}.${index}`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRETISH_KEY.test(key)) {
      throw new TypeError(`${path}.${key} looks credential-bearing and cannot be sealed into an Inspect selection`);
    }
    assertNoSecretLikeConfiguration(entry, `${path}.${key}`);
  }
}
