/** Product-owned DeepSWE v1.1 selection. Cousin methods cannot claim this id. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { sha256Hex } from "../../workspace/sealed-store.js";
import { SUITE_COVERAGE } from "../suite-protocol/comparability.js";

export const DEEP_SWE_V11_DATASET_ID = "datacurve-ai/deep-swe" as const;
/** Git commit of datacurve-ai/deep-swe at implementation (not @latest). */
export const DEEP_SWE_V11_GIT_SHA = "435ee89ec2f2e2289f33b0da4f992f0b7b7266b9" as const;
/** Git tree SHA of `tasks/` at DEEP_SWE_V11_GIT_SHA. Recomputed from the operator's bytes at select. */
export const DEEP_SWE_V11_TASKS_TREE_SHA = "66df25a1b382017d0ae014d94cadb2698baaed48" as const;
/** Task directories in `tasks/` at DEEP_SWE_V11_TASKS_TREE_SHA. `full` coverage means exactly these. */
export const DEEP_SWE_V11_TASK_COUNT = 113 as const;
export const DEEP_SWE_V11_AGENT_ID = "mini-swe-agent" as const;
export const DEEP_SWE_V11_DEFAULT_REPLICATES = 4 as const;
export const DEEP_SWE_V11_TRIAL_TIMEOUT_SECONDS = 9_000 as const;
export const DEEP_SWE_V11_PROFILE = "https://product.jinn.network/profiles/deep-swe-v1.1-selection/v1" as const;
export const DEEP_SWE_V11_SELECTION_ROLE = "https://product.jinn.network/artifact-roles/deep-swe-v1.1/selection/v1" as const;
export const DEEP_SWE_V11_SELECTION_SCHEMA = "jinn.network/benchmark-product/deep-swe-v1.1-selection/1" as const;
export const SUPPORTED_PIER_VERSION_RANGE = "0.3.1.x" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const GitSha = z.string().regex(/^[a-f0-9]{40}$/u);

export const DeepSweV11SelectionManifestSchema = z.object({
  schema: z.literal(DEEP_SWE_V11_SELECTION_SCHEMA),
  dataset: z.object({
    id: z.literal(DEEP_SWE_V11_DATASET_ID),
    gitSha: z.literal(DEEP_SWE_V11_GIT_SHA),
    /** Computed over the sealed material, so a subtree seals its own SHA rather than wearing the official pin. */
    tasksTreeSha: GitSha,
    taskCount: z.number().int().positive(),
  }).strict(),
  coverage: z.enum(SUITE_COVERAGE),
  selectedTaskNames: z.array(z.string().min(1).regex(/^[^/]+$/u)).min(1),
  datasetProjectionChecksum: Sha256,
  execution: z.object({
    source: z.literal("dataset"),
    nTasks: z.number().int().positive(),
    nAttempts: z.number().int().min(4),
    nConcurrent: z.number().int().positive(),
    maxRetries: z.literal(3),
    jobGrain: z.literal("per-arm"),
    agent: z.literal(DEEP_SWE_V11_AGENT_ID),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.execution.nTasks !== value.selectedTaskNames.length) {
    context.addIssue({ code: "custom", message: "nTasks must equal selectedTaskNames length", path: ["execution", "nTasks"] });
  }
});
export type DeepSweV11SelectionManifest = z.infer<typeof DeepSweV11SelectionManifestSchema>;

export function deepSweV11SelectionBytes(value: DeepSweV11SelectionManifest): Uint8Array {
  return canonicalJsonBytes(DeepSweV11SelectionManifestSchema.parse(value) as never);
}

export function deepSweV11SelectionSha256(value: DeepSweV11SelectionManifest): string {
  return sha256Hex(deepSweV11SelectionBytes(value));
}

export function assertSupportedPierVersion(version: string): void {
  if (!/^0\.3\.1(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new TypeError(`DeepSWE v1.1 requires Pier ${SUPPORTED_PIER_VERSION_RANGE}; received ${version}`);
  }
}

export function isDeepSweGitSha(value: string): value is typeof DEEP_SWE_V11_GIT_SHA {
  return GitSha.safeParse(value).success && value === DEEP_SWE_V11_GIT_SHA;
}
