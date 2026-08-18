/** Product-owned APEX-Agents selection. Cousin Stirrup / Harbor / Code cannot claim this id. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import {
  APEX_AGENTS_DEFAULT_MAX_STEPS,
  APEX_AGENTS_DEFAULT_TIMEOUT_SECONDS,
  APEX_AGENTS_JUDGE_MODEL,
  APEX_AGENTS_JUDGE_THINKING,
  APEX_AGENTS_REACT_AGENT_ID,
  ARCHIPELAGO_ADAPTER_ID,
  ARCHIPELAGO_COMMIT_PIN,
  SUITE_COVERAGE,
} from "../suite-protocol/comparability.js";
import { ApexAgentsSuiteProtocolSelectionSchema } from "../suite-protocol/manifest.js";

export const APEX_AGENTS_DATASET_ID = "mercor/apex-agents" as const;
/** HuggingFace dataset git SHA for mercor/apex-agents (480 tasks / 33 worlds), re-read 2026-08-18. */
export const APEX_AGENTS_DATASET_REVISION = "92c86856cf1b11f9833a8a076b3a45a63afa3929" as const;
export const APEX_AGENTS_DATASET_TASK_COUNT = 480 as const;
export {
  ARCHIPELAGO_ADAPTER_ID,
  ARCHIPELAGO_COMMIT_PIN,
  APEX_AGENTS_DEFAULT_MAX_STEPS,
  APEX_AGENTS_DEFAULT_TIMEOUT_SECONDS,
};
export const APEX_AGENTS_SELECTION_ROLE = "https://product.jinn.network/artifact-roles/apex-agents/selection/v1" as const;
export const APEX_AGENTS_SELECTION_SCHEMA = "jinn.network/benchmark-product/apex-agents-selection/1" as const;
export const ARCHIPELAGO_RUNTIME_EVIDENCE_PROFILE = "https://product.jinn.network/profiles/archipelago-evidence/v1" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const HfRevision = z.string().regex(/^[a-f0-9]{40}$/u);
const TaskId = z.string().min(1).regex(/^[^/]+$/u);
const GitCommit = z.string().regex(/^[a-f0-9]{40}$/u);

export const ApexAgentsRegistryMetadataSchema = z.object({
  name: z.literal(APEX_AGENTS_DATASET_ID),
  revision: HfRevision,
  task_ids: z.array(TaskId).min(1),
}).passthrough();
export type ApexAgentsRegistryMetadata = z.infer<typeof ApexAgentsRegistryMetadataSchema>;

export const ApexAgentsSelectionManifestSchema = z.object({
  schema: z.literal(APEX_AGENTS_SELECTION_SCHEMA),
  dataset: z.object({
    id: z.literal(APEX_AGENTS_DATASET_ID),
    revision: HfRevision,
    registrySnapshotSha256: Sha256,
    registrySnapshotBytes: z.number().int().positive(),
    taskCount: z.number().int().positive(),
  }).strict(),
  coverage: z.enum(SUITE_COVERAGE),
  selectedTasks: z.array(z.object({
    taskId: TaskId,
  }).strict()).min(1),
  archipelago: z.object({
    adapterId: z.literal(ARCHIPELAGO_ADAPTER_ID),
    commit: GitCommit,
    executableSha256: Sha256,
    agentId: z.literal(APEX_AGENTS_REACT_AGENT_ID),
    maxSteps: z.literal(APEX_AGENTS_DEFAULT_MAX_STEPS),
    timeoutSeconds: z.literal(APEX_AGENTS_DEFAULT_TIMEOUT_SECONDS),
    judgeModel: z.literal(APEX_AGENTS_JUDGE_MODEL),
    judgeThinking: z.literal(APEX_AGENTS_JUDGE_THINKING),
    webSearch: z.literal(false),
    timeoutOverride: z.literal(false),
    resourceOverride: z.literal(false),
  }).strict(),
  suite: ApexAgentsSuiteProtocolSelectionSchema,
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
  if (value.archipelago.commit !== ARCHIPELAGO_COMMIT_PIN) {
    context.addIssue({ code: "custom", message: "Archipelago commit drifted from the sealed pin", path: ["archipelago", "commit"] });
  }
});
export type ApexAgentsSelectionManifest = z.infer<typeof ApexAgentsSelectionManifestSchema>;

export function apexAgentsSelectionBytes(value: ApexAgentsSelectionManifest): Uint8Array {
  return canonicalJsonBytes(ApexAgentsSelectionManifestSchema.parse(value) as never);
}

export function assertSupportedArchipelagoCommit(commit: string): string {
  if (commit !== ARCHIPELAGO_COMMIT_PIN) {
    throw new TypeError(`APEX-Agents requires Archipelago commit ${ARCHIPELAGO_COMMIT_PIN}, got ${commit}`);
  }
  return commit;
}
