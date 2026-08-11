import { z } from "zod";

export const INSPECT_ADAPTER_ID = "inspect" as const;
export const SUPPORTED_INSPECT_VERSION = "0.3.255" as const;
export const SUPPORTED_INSPECT_WHEEL_SHA256 = "958e773a8d0cc8873314e3f96d1143cbb4e0b9e4bacc2cbec6b4d5576ceecf2c" as const;
export const INSPECT_SELECTION_SCHEMA = "jinn.network/benchmark-product/inspect-selection/1" as const;
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
});

export const InspectRunOptionsSchema = z.object({
  maxSamples: z.number().int().positive().optional(),
  maxSubprocesses: z.number().int().positive().optional(),
  maxSandboxes: z.number().int().positive().optional(),
  retryOnError: z.number().int().nonnegative().optional(),
  failOnError: z.union([z.boolean(), z.number().int().nonnegative()]).optional(),
  messageLimit: z.number().int().positive().optional(),
  tokenLimit: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
  timeLimit: z.number().int().positive().optional(),
}).strict();

export const InspectSelectionManifestSchema = z.object({
  schema: z.literal(INSPECT_SELECTION_SCHEMA),
  runtime: z.object({
    adapterVersion: z.literal("1"),
    workerSha256: Sha256Schema,
    inspectVersion: z.literal(SUPPORTED_INSPECT_VERSION),
    inspectWheelSha256: z.literal(SUPPORTED_INSPECT_WHEEL_SHA256),
    pythonVersion: z.string().regex(/^3\.1[1-9](?:\.|$)/),
    pythonExecutableSha256: Sha256Schema,
    pythonEnvironmentSha256: Sha256Schema,
    inspectDistributionSha256: Sha256Schema,
  }),
  task: z.object({
    reference: z.string().min(1),
    args: z.record(z.string(), SafeJsonSchema),
    resolvedName: z.string().min(1),
    resolvedVersion: z.string().nullable(),
    resolvedSandbox: z.null(),
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
    }),
  }),
  arms: z.array(InspectArmConfigurationSchema).min(2),
  scorer: z.object({
    name: z.string().min(1),
    passValue: JsonScalarSchema,
    definition: SafeJsonSchema,
  }),
  runOptions: InspectRunOptionsSchema,
}).strict();

export type InspectArmConfiguration = z.infer<typeof InspectArmConfigurationSchema>;
export type InspectRunOptions = z.infer<typeof InspectRunOptionsSchema>;
export type InspectSelectionManifest = z.infer<typeof InspectSelectionManifestSchema>;

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
