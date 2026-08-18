/** Product-owned APEX-SWE-dev selection. The 200-task APEX-SWE leaderboard cannot wear this id. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import {
  APEX_SWE_DEV_ADAPTER_ID,
  APEX_SWE_DEV_DEFAULT_TIMEOUT_SECONDS,
  SUITE_COVERAGE,
} from "../suite-protocol/comparability.js";
import { ApexSweDevSuiteProtocolSelectionSchema } from "../suite-protocol/manifest.js";

export { APEX_SWE_DEV_ADAPTER_ID, APEX_SWE_DEV_DEFAULT_TIMEOUT_SECONDS };

export const APEX_SWE_DEV_DATASET_ID = "mercor/APEX-SWE" as const;
/** HuggingFace dataset git SHA for mercor/APEX-SWE (50 public tasks), re-read 2026-08-18. */
export const APEX_SWE_DEV_DATASET_REVISION = "4d7aeb2b829ca348c224992da803bca6502235f4" as const;
export const APEX_SWE_DEV_DATASET_TASK_COUNT = 50 as const;
export const APEX_SWE_DEV_INTEGRATION_COUNT = 25 as const;
export const APEX_SWE_DEV_OBSERVABILITY_COUNT = 25 as const;
/** Mercor-Intelligence/apex-swe git SHA, re-read 2026-08-18. Dataset commit is newer; layout still matches. */
export const APEX_SWE_HARNESS_REVISION = "7cfa580dd59704ff15cf558bda80257c23b6cb04" as const;
export const APEX_SWE_DEV_N_TRIALS = 1 as const;
export const APEX_SWE_DEV_MESSAGE_LIMIT = 250 as const;
export const APEX_SWE_DEV_SELECTION_ROLE = "https://product.jinn.network/artifact-roles/apex-swe-dev/selection/v1" as const;
export const APEX_SWE_DEV_SELECTION_SCHEMA = "jinn.network/benchmark-product/apex-swe-dev-selection/1" as const;
export const APEX_SWE_DEV_RUNTIME_EVIDENCE_PROFILE = "https://product.jinn.network/profiles/apex-swe-dev-evidence/v1" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const HfRevision = z.string().regex(/^[a-f0-9]{40}$/u);
const TaskId = z.string().min(1).regex(/^[^/]+$/u);

export const ApexSweDevTaskTypeSchema = z.enum(["integration", "observability"]);
export type ApexSweDevTaskType = z.infer<typeof ApexSweDevTaskTypeSchema>;

export const ApexSweDevRegistryMetadataSchema = z.object({
  name: z.literal(APEX_SWE_DEV_DATASET_ID),
  revision: HfRevision,
  tasks: z.array(z.object({
    taskId: TaskId,
    taskType: ApexSweDevTaskTypeSchema,
  }).strict()).min(1),
}).passthrough();
export type ApexSweDevRegistryMetadata = z.infer<typeof ApexSweDevRegistryMetadataSchema>;

export const ApexSweDevSelectionManifestSchema = z.object({
  schema: z.literal(APEX_SWE_DEV_SELECTION_SCHEMA),
  dataset: z.object({
    id: z.literal(APEX_SWE_DEV_DATASET_ID),
    revision: HfRevision,
    registrySnapshotSha256: Sha256,
    registrySnapshotBytes: z.number().int().positive(),
    taskCount: z.number().int().positive(),
  }).strict(),
  coverage: z.enum(SUITE_COVERAGE),
  selectedTasks: z.array(z.object({
    taskId: TaskId,
    taskType: ApexSweDevTaskTypeSchema,
  }).strict()).min(1),
  harness: z.object({
    adapterId: z.literal(APEX_SWE_DEV_ADAPTER_ID),
    revision: z.literal(APEX_SWE_HARNESS_REVISION),
    apxVersion: z.string().min(1),
    apxExecutableSha256: Sha256,
    inspectAiVersion: z.string().min(1),
    pythonExecutableSha256: Sha256,
    timeoutSeconds: z.literal(APEX_SWE_DEV_DEFAULT_TIMEOUT_SECONDS),
    timeoutOverride: z.literal(false),
    resourceOverride: z.literal(false),
    nTrials: z.literal(APEX_SWE_DEV_N_TRIALS),
    messageLimit: z.literal(APEX_SWE_DEV_MESSAGE_LIMIT),
  }).strict(),
  suite: ApexSweDevSuiteProtocolSelectionSchema,
}).strict().superRefine((value, context) => {
  if (value.selectedTasks.length !== value.suite.selectedTaskNames.length) {
    context.addIssue({ code: "custom", message: "selectedTasks must match suite selectedTaskNames", path: ["selectedTasks"] });
  }
  const names = value.selectedTasks.map((item) => item.taskId);
  if (names.join("\0") !== value.suite.selectedTaskNames.join("\0")) {
    context.addIssue({ code: "custom", message: "selectedTasks must equal suite selectedTaskNames in order", path: ["selectedTasks"] });
  }
  if (value.dataset.revision !== value.suite.datasetRevision) {
    context.addIssue({ code: "custom", message: "dataset revision must equal suite datasetRevision", path: ["dataset", "revision"] });
  }
});
export type ApexSweDevSelectionManifest = z.infer<typeof ApexSweDevSelectionManifestSchema>;

export function apexSweDevSelectionBytes(value: ApexSweDevSelectionManifest): Uint8Array {
  return canonicalJsonBytes(ApexSweDevSelectionManifestSchema.parse(value) as never);
}

export function assertOfficialApexSweDevRegistry(parsed: ApexSweDevRegistryMetadata): void {
  if (parsed.revision !== APEX_SWE_DEV_DATASET_REVISION) {
    throw new TypeError("APEX-SWE-dev registry revision drifted from the sealed HuggingFace pin");
  }
  const integration = parsed.tasks.filter((task) => task.taskType === "integration");
  const observability = parsed.tasks.filter((task) => task.taskType === "observability");
  if (parsed.tasks.length !== APEX_SWE_DEV_DATASET_TASK_COUNT
    || integration.length !== APEX_SWE_DEV_INTEGRATION_COUNT
    || observability.length !== APEX_SWE_DEV_OBSERVABILITY_COUNT) {
    throw new TypeError("APEX-SWE-dev official pin requires exactly 25 integration and 25 observability tasks");
  }
}
