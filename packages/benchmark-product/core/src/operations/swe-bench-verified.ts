/** Audited product operations for SWE-bench Verified official-suite selection. */
import { BENCHMARK_RECORD_KIND } from "@jinn-network/benchmarking-records";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import { buildPredictionForecastProfile, sealTaskProfile } from "@jinn-network/task-execution-profiles";
import { isDraftMutable } from "../domain/lifecycle.js";
import { parseDraftSpec, type DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { buildSwebenchVerifiedTasks } from "../intake/swe-bench-verified.js";
import { deriveWorkspaceAuthoredBenchmark, deriveWorkspaceAuthoredTask } from "../intake/workspace-authored.js";
import { attachBenchmarkToDraft } from "./attach.js";
import {
  SWE_BENCH_HARNESS_ADAPTER_ID,
  SWE_BENCH_VERIFIED_DATASET_ID,
  SWE_BENCH_VERIFIED_SELECTION_SCHEMA,
  SwebenchVerifiedSelectionManifestSchema,
  swebenchVerifiedSelectionBytes,
} from "../runtime/swe-bench-verified/manifest.js";
import {
  resolveSwebenchVerifiedSelection,
  sealSwebenchVerifiedSelectionDependencies,
  writeSwebenchVerifiedHostBinding,
  type SwebenchVerifiedSelectionRequest,
} from "../runtime/swe-bench-verified/host.js";
import { SuiteProtocolSelectionSchema, suiteProtocolSelectionBytes } from "../runtime/suite-protocol/manifest.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import { recordWorkspaceAuthorship } from "../run/publication-authority.js";
import { draftPath } from "../workspace/layout.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export type SelectSwebenchVerifiedRuntimeInput = { readonly draftId: string } & SwebenchVerifiedSelectionRequest;
export interface SelectSwebenchVerifiedRuntimeResult {
  readonly draft: DraftDocument;
  readonly selectionManifestSha256: string;
  readonly suiteProtocolSha256: string;
  readonly benchmarkSha256: string;
}

export function selectSwebenchVerifiedRuntime(
  context: OperationContext,
  input: SelectSwebenchVerifiedRuntimeInput,
): Promise<OperationResult<SelectSwebenchVerifiedRuntimeResult>> {
  const at = context.clock();
  const clocked = { ...context, clock: () => at };
  return operateAsync({
    context: clocked,
    action: "runtime.swe-bench-verified.select",
    subject: input.draftId,
    inputs: input,
    run: () => executeSelectSwebenchVerifiedRuntime(clocked, input),
  });
}

export async function executeSelectSwebenchVerifiedRuntime(
  context: OperationContext,
  input: SelectSwebenchVerifiedRuntimeInput,
): Promise<SelectSwebenchVerifiedRuntimeResult> {
  const at = context.clock();
  const current = readDraftDocument(context.workspaceDir, input.draftId);
      if (!isDraftMutable(current.state)) refuse("illegal-transition", `drafts.${input.draftId}.state`, "locked drafts refuse SWE-bench Verified selection");
      if (current.spec.analysis?.method === "jinn.benchmarking.method/binary-instrument") {
        refuse("validation", `drafts.${input.draftId}.spec.analysis`, "SWE-bench Verified official suite refuses binary-instrument majority-k; use wilson@1 over judged cells");
      }
      const selected = resolveSwebenchVerifiedSelection(context.workspaceDir, input);
      putSealedBytes(context.workspaceDir, sealTaskProfile(buildPredictionForecastProfile()).bytes);
      const built = await buildSwebenchVerifiedTasks(selected.selectedInstanceIds);
      void built.evaluationSpec.sha256;
      const author = loadOrCreateReportSigningKey(context.workspaceDir).keyId;
      const authoredTasks: Array<{ taskName: string; taskSha256: string; bytes: Uint8Array }> = [];
      for (const task of built.tasks) {
        const sourceReceiptSha256 = putSealedBytes(context.workspaceDir, task.receipt.envelopeBytes);
        putSealedBytes(context.workspaceDir, task.bytes);
        const authored = deriveWorkspaceAuthoredTask({
          sourceBytes: task.bytes,
          author,
          sourceKind: "swe-bench-verified",
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
        protocol: "swe-bench-verified",
        coverage: selected.coverage,
        datasetId: SWE_BENCH_VERIFIED_DATASET_ID,
        datasetRevision: selected.dataset.revision,
        selectedTaskNames: [...selected.selectedInstanceIds],
        datasetTaskCount: selected.dataset.instanceCount,
        replicates: 1,
        atifRequired: false,
        items: authoredTasks.map((task) => ({ taskName: task.taskName, taskSha256: task.taskSha256 })),
      });
      const suiteBytes = suiteProtocolSelectionBytes(suite);
      const suiteProtocolSha256 = putSealedBytes(context.workspaceDir, suiteBytes);
      const profile = SwebenchVerifiedSelectionManifestSchema.parse({
        schema: SWE_BENCH_VERIFIED_SELECTION_SCHEMA,
        dataset: selected.dataset,
        coverage: selected.coverage,
        selectedInstances: selected.selectedInstanceIds.map((instanceId) => ({ instanceId })),
        harness: selected.harness,
        suite,
      });
      const bytes = swebenchVerifiedSelectionBytes(profile);
      const selectionManifestSha256 = putSealedBytes(context.workspaceDir, bytes);
      sealSwebenchVerifiedSelectionDependencies(context.workspaceDir, selected);
      writeSwebenchVerifiedHostBinding(context.workspaceDir, selectionManifestSha256, selected.binding);
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
              refuse("validation", `spec.arms.${arm.armId}`, "SWE-bench Verified selection has no model mapping for this Run arm");
            }
            return {
              ...arm,
              pinning: {
                ...arm.pinning,
                harness: { id: SWE_BENCH_HARNESS_ADAPTER_ID, version: selected.harness.version },
                model: { id: mapped.modelNameOrPath },
              },
            };
          }),
          evaluationRuntime: {
            adapterId: SWE_BENCH_HARNESS_ADAPTER_ID,
            selectionManifestSha256,
            isolationPolicy: "unrestricted",
          },
        }),
      };
      atomicWriteFileSync(draftPath(context.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
      return { draft, selectionManifestSha256, suiteProtocolSha256, benchmarkSha256 };
}
