/** Audited product operations for APEX-SWE-dev official-suite selection. */
import { BENCHMARK_RECORD_KIND } from "@jinn-network/benchmarking-records";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import { buildPredictionForecastProfile, sealTaskProfile } from "@jinn-network/task-execution-profiles";
import { isDraftMutable } from "../domain/lifecycle.js";
import { parseDraftSpec, type DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { buildApexSweDevTasks } from "../intake/apex-swe-dev.js";
import { deriveWorkspaceAuthoredBenchmark, deriveWorkspaceAuthoredTask } from "../intake/workspace-authored.js";
import { attachBenchmarkToDraft } from "./attach.js";
import {
  APEX_SWE_DEV_ADAPTER_ID,
  APEX_SWE_DEV_DATASET_ID,
  APEX_SWE_DEV_SELECTION_SCHEMA,
  ApexSweDevSelectionManifestSchema,
  apexSweDevSelectionBytes,
} from "../runtime/apex-swe-dev/manifest.js";
import {
  resolveApexSweDevSelection,
  sealApexSweDevSelectionDependencies,
  writeApexSweDevHostBinding,
  type ApexSweDevSelectionRequest,
} from "../runtime/apex-swe-dev/host.js";
import { SuiteProtocolSelectionSchema, suiteProtocolSelectionBytes } from "../runtime/suite-protocol/manifest.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import { recordWorkspaceAuthorship } from "../run/publication-authority.js";
import { draftPath } from "../workspace/layout.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export type SelectApexSweDevRuntimeInput = { readonly draftId: string } & ApexSweDevSelectionRequest;
export interface SelectApexSweDevRuntimeResult {
  readonly draft: DraftDocument;
  readonly selectionManifestSha256: string;
  readonly suiteProtocolSha256: string;
  readonly benchmarkSha256: string;
}

export function selectApexSweDevRuntime(
  context: OperationContext,
  input: SelectApexSweDevRuntimeInput,
): Promise<OperationResult<SelectApexSweDevRuntimeResult>> {
  const at = context.clock();
  const clocked = { ...context, clock: () => at };
  return operateAsync({
    context: clocked,
    action: "runtime.apex-swe-dev.select",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const current = readDraftDocument(context.workspaceDir, input.draftId);
      if (!isDraftMutable(current.state)) refuse("illegal-transition", `drafts.${input.draftId}.state`, "locked drafts refuse APEX-SWE-dev selection");
      if (current.spec.analysis?.method === "jinn.benchmarking.method/binary-instrument") {
        refuse("validation", `drafts.${input.draftId}.spec.analysis`, "APEX-SWE-dev official suite refuses binary-instrument majority-k; use wilson@1 over judged cells");
      }
      const selected = resolveApexSweDevSelection(context.workspaceDir, input);
      putSealedBytes(context.workspaceDir, sealTaskProfile(buildPredictionForecastProfile()).bytes);
      const built = await buildApexSweDevTasks(selected.selectedTasks.map((task) => task.taskId));
      const author = loadOrCreateReportSigningKey(context.workspaceDir).keyId;
      const authoredTasks: Array<{ taskName: string; taskSha256: string; bytes: Uint8Array }> = [];
      for (const task of built.tasks) {
        const sourceReceiptSha256 = putSealedBytes(context.workspaceDir, task.receipt.envelopeBytes);
        putSealedBytes(context.workspaceDir, task.bytes);
        const authored = deriveWorkspaceAuthoredTask({
          sourceBytes: task.bytes,
          author,
          sourceKind: "apex-swe-dev",
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
        protocol: "apex-swe-dev",
        coverage: selected.coverage,
        datasetId: APEX_SWE_DEV_DATASET_ID,
        datasetRevision: selected.dataset.revision,
        selectedTaskNames: selected.selectedTasks.map((task) => task.taskId),
        datasetTaskCount: selected.dataset.taskCount,
        replicates: 1,
        atifRequired: false,
        items: authoredTasks.map((task) => {
          const typed = selected.selectedTasks.find((candidate) => candidate.taskId === task.taskName);
          if (typed === undefined) refuse("record-integrity", "apex-swe-dev.items", "authored task is missing from the selected APEX-SWE-dev slice");
          return { taskName: task.taskName, taskSha256: task.taskSha256, taskType: typed.taskType };
        }),
      });
      const suiteBytes = suiteProtocolSelectionBytes(suite);
      const suiteProtocolSha256 = putSealedBytes(context.workspaceDir, suiteBytes);
      const profile = ApexSweDevSelectionManifestSchema.parse({
        schema: APEX_SWE_DEV_SELECTION_SCHEMA,
        dataset: selected.dataset,
        coverage: selected.coverage,
        selectedTasks: selected.selectedTasks,
        harness: selected.harness,
        suite,
      });
      const bytes = apexSweDevSelectionBytes(profile);
      const selectionManifestSha256 = putSealedBytes(context.workspaceDir, bytes);
      sealApexSweDevSelectionDependencies(context.workspaceDir, selected);
      writeApexSweDevHostBinding(context.workspaceDir, selectionManifestSha256, selected.binding);
      attachBenchmarkToDraft(context.workspaceDir, input.draftId, benchmarkSha256, at);
      const attached = readDraftDocument(context.workspaceDir, input.draftId);
      const draft: DraftDocument = {
        ...attached,
        updatedAt: at,
        spec: parseDraftSpec({
          ...attached.spec,
          replicates: 1,
          // Pass@1 is the protocol: each task maps onto exactly one cell (DR-2026-08-18-c §4), so a
          // replaced cell would be a second attempt wearing the same k=1 conformance claim.
          policy: { ...attached.spec.policy, replacement: { allowed: false } },
          arms: attached.spec.arms.map((arm) => {
            const mapped = input.arms.find((candidate) => candidate.armId === arm.armId);
            if (mapped === undefined) {
              refuse("validation", `spec.arms.${arm.armId}`, "APEX-SWE-dev selection has no model mapping for this Run arm");
            }
            return {
              ...arm,
              pinning: {
                ...arm.pinning,
                harness: { id: APEX_SWE_DEV_ADAPTER_ID, version: selected.harness.apxVersion },
                model: { id: mapped.modelNameOrPath },
              },
            };
          }),
          evaluationRuntime: {
            adapterId: APEX_SWE_DEV_ADAPTER_ID,
            selectionManifestSha256,
            isolationPolicy: "unrestricted",
          },
        }),
      };
      atomicWriteFileSync(draftPath(context.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
      return { draft, selectionManifestSha256, suiteProtocolSha256, benchmarkSha256 };
    },
  });
}
