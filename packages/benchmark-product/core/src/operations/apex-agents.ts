/** Audited product operations for APEX-Agents official-suite selection. */
import { BENCHMARK_RECORD_KIND } from "@jinn-network/benchmarking-records";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import { buildPredictionForecastProfile, sealTaskProfile } from "@jinn-network/task-execution-profiles";
import { isDraftMutable } from "../domain/lifecycle.js";
import { parseDraftSpec, type DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { buildApexAgentsTasks } from "../intake/apex-agents.js";
import { deriveWorkspaceAuthoredBenchmark, deriveWorkspaceAuthoredTask } from "../intake/workspace-authored.js";
import { attachBenchmarkToDraft } from "./attach.js";
import {
  APEX_AGENTS_DATASET_ID,
  APEX_AGENTS_SELECTION_SCHEMA,
  ARCHIPELAGO_ADAPTER_ID,
  ApexAgentsSelectionManifestSchema,
  apexAgentsSelectionBytes,
} from "../runtime/apex-agents/manifest.js";
import {
  resolveApexAgentsSelection,
  sealApexAgentsSelectionDependencies,
  writeApexAgentsHostBinding,
  type ApexAgentsSelectionRequest,
} from "../runtime/apex-agents/host.js";
import { SuiteProtocolSelectionSchema, suiteProtocolSelectionBytes } from "../runtime/suite-protocol/manifest.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import { recordWorkspaceAuthorship } from "../run/publication-authority.js";
import { draftPath } from "../workspace/layout.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export type SelectApexAgentsRuntimeInput = { readonly draftId: string } & ApexAgentsSelectionRequest;
export interface SelectApexAgentsRuntimeResult {
  readonly draft: DraftDocument;
  readonly selectionManifestSha256: string;
  readonly suiteProtocolSha256: string;
  readonly benchmarkSha256: string;
}

export function selectApexAgentsRuntime(
  context: OperationContext,
  input: SelectApexAgentsRuntimeInput,
): Promise<OperationResult<SelectApexAgentsRuntimeResult>> {
  const at = context.clock();
  const clocked = { ...context, clock: () => at };
  return operateAsync({
    context: clocked,
    action: "runtime.apex-agents.select",
    subject: input.draftId,
    inputs: input,
    run: () => executeSelectApexAgentsRuntime(clocked, input),
  });
}

export async function executeSelectApexAgentsRuntime(
  context: OperationContext,
  input: SelectApexAgentsRuntimeInput,
): Promise<SelectApexAgentsRuntimeResult> {
  const at = context.clock();
  const current = readDraftDocument(context.workspaceDir, input.draftId);
      if (!isDraftMutable(current.state)) refuse("illegal-transition", `drafts.${input.draftId}.state`, "locked drafts refuse APEX-Agents selection");
      if (current.spec.analysis?.method === "jinn.benchmarking.method/binary-instrument") {
        refuse("validation", `drafts.${input.draftId}.spec.analysis`, "APEX-Agents official suite refuses binary-instrument majority-k; use wilson@1 over judged cells");
      }
      const selected = resolveApexAgentsSelection(context.workspaceDir, input);
      putSealedBytes(context.workspaceDir, sealTaskProfile(buildPredictionForecastProfile()).bytes);
      const built = await buildApexAgentsTasks(selected.selectedTaskIds);
      void built.evaluationSpec.sha256;
      const author = loadOrCreateReportSigningKey(context.workspaceDir).keyId;
      const authoredTasks: Array<{ taskName: string; taskSha256: string; bytes: Uint8Array }> = [];
      for (const task of built.tasks) {
        const sourceReceiptSha256 = putSealedBytes(context.workspaceDir, task.receipt.envelopeBytes);
        putSealedBytes(context.workspaceDir, task.bytes);
        const authored = deriveWorkspaceAuthoredTask({
          sourceBytes: task.bytes,
          author,
          sourceKind: "apex-agents",
          sourceReceiptSha256,
        });
        const taskSha256 = putSealedBytes(context.workspaceDir, authored.bytes);
        recordWorkspaceAuthorship({
          workspaceDir: context.workspaceDir,
          recordSha256: taskSha256,
          recordKind: RECORD_KINDS.task,
          authoredAt: at,
        });
        authoredTasks.push({ taskName: task.taskName, taskSha256, bytes: authored.bytes });
      }
      putSealedBytes(context.workspaceDir, built.benchmark.bytes);
      const authoredBenchmark = deriveWorkspaceAuthoredBenchmark({
        sourceBytes: built.benchmark.bytes,
        taskSha256s: authoredTasks.map((task) => task.taskSha256),
        author,
      });
      const benchmarkSha256 = putSealedBytes(context.workspaceDir, authoredBenchmark.bytes);
      recordWorkspaceAuthorship({
        workspaceDir: context.workspaceDir,
        recordSha256: benchmarkSha256,
        recordKind: BENCHMARK_RECORD_KIND,
        authoredAt: at,
      });
      const suite = SuiteProtocolSelectionSchema.parse({
        schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
        protocol: "apex-agents",
        coverage: selected.coverage,
        datasetId: APEX_AGENTS_DATASET_ID,
        datasetRevision: selected.dataset.revision,
        selectedTaskNames: [...selected.selectedTaskIds],
        datasetTaskCount: selected.dataset.taskCount,
        replicates: 1,
        atifRequired: false,
        items: authoredTasks.map((task) => ({ taskName: task.taskName, taskSha256: task.taskSha256 })),
      });
      const suiteBytes = suiteProtocolSelectionBytes(suite);
      const suiteProtocolSha256 = putSealedBytes(context.workspaceDir, suiteBytes);
      const profile = ApexAgentsSelectionManifestSchema.parse({
        schema: APEX_AGENTS_SELECTION_SCHEMA,
        dataset: selected.dataset,
        coverage: selected.coverage,
        selectedTasks: selected.selectedTaskIds.map((taskId) => ({ taskId })),
        archipelago: selected.archipelago,
        suite,
      });
      const bytes = apexAgentsSelectionBytes(profile);
      const selectionManifestSha256 = putSealedBytes(context.workspaceDir, bytes);
      sealApexAgentsSelectionDependencies(context.workspaceDir, selected);
      writeApexAgentsHostBinding(context.workspaceDir, selectionManifestSha256, selected.binding);
      attachBenchmarkToDraft(context.workspaceDir, input.draftId, benchmarkSha256, at);
      const attached = readDraftDocument(context.workspaceDir, input.draftId);
      const draft: DraftDocument = {
        ...attached,
        updatedAt: at,
        spec: parseDraftSpec({
          ...attached.spec,
          replicates: 1,
          arms: attached.spec.arms.map((arm) => {
            const mapped = input.arms.find((candidate) => candidate.armId === arm.armId);
            if (mapped === undefined) {
              refuse("validation", `spec.arms.${arm.armId}`, "APEX-Agents selection has no model mapping for this Run arm");
            }
            return {
              ...arm,
              pinning: {
                ...arm.pinning,
                harness: { id: ARCHIPELAGO_ADAPTER_ID, version: selected.archipelago.commit },
                model: { id: mapped.modelId },
              },
            };
          }),
          evaluationRuntime: {
            adapterId: ARCHIPELAGO_ADAPTER_ID,
            selectionManifestSha256,
            isolationPolicy: "unrestricted",
          },
        }),
      };
      atomicWriteFileSync(draftPath(context.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
      return { draft, selectionManifestSha256, suiteProtocolSha256, benchmarkSha256 };
}
