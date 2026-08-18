/** Audited product operations for DeepSWE v1.1 official-suite selection. */
import { BENCHMARK_RECORD_KIND } from "@jinn-network/benchmarking-records";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import { buildPredictionForecastProfile, sealTaskProfile } from "@jinn-network/task-execution-profiles";
import { isDraftMutable } from "../domain/lifecycle.js";
import { parseDraftSpec, type DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { buildDeepSweV11Tasks } from "../intake/deep-swe-v1.1.js";
import { deriveWorkspaceAuthoredBenchmark, deriveWorkspaceAuthoredTask } from "../intake/workspace-authored.js";
import { attachBenchmarkToDraft } from "./attach.js";
import { createDefaultBenchmarkRuntimeHost } from "../runtime/host-port.js";
import { harborSelectionManifestBytes, harborSelectionManifestSha256, PIER_ADAPTER_ID } from "../runtime/harbor/manifest.js";
import { sealHarborSelectionDependencies, writeHarborHostBinding } from "../runtime/harbor/host.js";
import {
  SUITE_PROTOCOL_PROFILE,
  SuiteProtocolSelectionSchema,
  suiteProtocolSelectionBytes,
} from "../runtime/suite-protocol/manifest.js";
import {
  resolveDeepSweV11Selection,
  type DeepSweV11SelectionRequest,
} from "../runtime/deep-swe-v1.1/host.js";
import {
  DEEP_SWE_V11_DATASET_ID,
  DEEP_SWE_V11_GIT_SHA,
  DEEP_SWE_V11_PROFILE,
  DeepSweV11SelectionManifestSchema,
  deepSweV11SelectionBytes,
} from "../runtime/deep-swe-v1.1/manifest.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import { recordWorkspaceAuthorship } from "../run/publication-authority.js";
import { draftPath } from "../workspace/layout.js";
import { putSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export type SelectDeepSweV11RuntimeInput = { readonly draftId: string } & DeepSweV11SelectionRequest;
export interface SelectDeepSweV11RuntimeResult {
  readonly draft: DraftDocument;
  readonly selectionManifestSha256: string;
  readonly deepSweV11ProfileSha256: string;
  readonly suiteProtocolSha256: string;
  readonly benchmarkSha256: string;
}

export function selectDeepSweV11Runtime(context: OperationContext, input: SelectDeepSweV11RuntimeInput): Promise<OperationResult<SelectDeepSweV11RuntimeResult>> {
  const at = context.clock();
  const clocked = { ...context, clock: () => at };
  return operateAsync({ context: clocked, action: "runtime.deep-swe-v1.1.select", subject: input.draftId, inputs: input, run: async () => {
    const current = readDraftDocument(context.workspaceDir, input.draftId);
    if (!isDraftMutable(current.state)) refuse("illegal-transition", `drafts.${input.draftId}.state`, "locked drafts refuse DeepSWE v1.1 selection");
    if (current.spec.analysis?.method === "jinn.benchmarking.method/binary-instrument") {
      refuse("validation", `drafts.${input.draftId}.spec.analysis`, "DeepSWE v1.1 official suite refuses binary-instrument majority-k; use wilson@1 over judged replicates");
    }
    const replacement = current.spec.policy.replacement;
    if (replacement.allowed && (replacement.maxPerCell ?? 1) < 3) {
      refuse("validation", `drafts.${input.draftId}.spec.policy.replacement`, "DeepSWE v1.1 official suite requires replacement.maxPerCell of at least 3");
    }
    const selected = resolveDeepSweV11Selection(context.workspaceDir, input);
    if (putSealedBytes(context.workspaceDir, deepSweV11SelectionBytes(selected.profile)) !== selected.profileSha256) {
      refuse("record-integrity", "deepSweV11.profile", "DeepSWE v1.1 profile bytes changed while storing");
    }
    const built = await buildDeepSweV11Tasks(selected.selectedTaskNames);
    putSealedBytes(context.workspaceDir, sealTaskProfile(buildPredictionForecastProfile()).bytes);
    const evaluationSpecSha256 = putSealedBytes(context.workspaceDir, built.evaluationSpec.bytes);
    void evaluationSpecSha256;
    const author = loadOrCreateReportSigningKey(context.workspaceDir).keyId;
    const authoredTasks: Array<{ taskName: string; taskSha256: string; bytes: Uint8Array }> = [];
    for (const task of built.tasks) {
      const sourceReceiptSha256 = putSealedBytes(context.workspaceDir, task.receipt.envelopeBytes);
      putSealedBytes(context.workspaceDir, task.bytes);
      const authored = deriveWorkspaceAuthoredTask({
        sourceBytes: task.bytes,
        author,
        sourceKind: "deep-swe-v1.1",
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
      protocol: "deep-swe-v1.1",
      coverage: selected.coverage,
      datasetId: DEEP_SWE_V11_DATASET_ID,
      datasetRevision: DEEP_SWE_V11_GIT_SHA,
      tasksTreeSha: selected.profile.dataset.tasksTreeSha,
      selectedTaskNames: [...selected.selectedTaskNames],
      datasetTaskCount: selected.profile.dataset.taskCount,
      replicates: selected.profile.execution.nAttempts,
      atifRequired: true,
      items: authoredTasks.map((task) => ({ taskName: task.taskName, taskSha256: task.taskSha256 })),
    });
    const suiteBytes = suiteProtocolSelectionBytes(suite);
    const suiteProtocolSha256 = putSealedBytes(context.workspaceDir, suiteBytes);
    const harborInput = {
      ...selected.harbor,
      profiles: {
        ...selected.harbor.profiles,
        [SUITE_PROTOCOL_PROFILE]: suite,
      },
    };
    const resolution = await (context.runtimeHost ?? createDefaultBenchmarkRuntimeHost()).resolveHarborSelection(harborInput);
    sealHarborSelectionDependencies(context.workspaceDir, resolution);
    const embedded = DeepSweV11SelectionManifestSchema.parse(resolution.manifest.profiles?.[DEEP_SWE_V11_PROFILE]);
    if (sha256Hex(deepSweV11SelectionBytes(embedded)) !== selected.profileSha256) {
      refuse("record-integrity", "deepSweV11.profile", "Pier host changed the sealed DeepSWE v1.1 selection profile");
    }
    if (resolution.manifest.adapter.id !== PIER_ADAPTER_ID
      || resolution.manifest.source.kind !== "dataset"
      || resolution.manifest.source.taskName !== selected.selectedTaskNames[0]
      || JSON.stringify(resolution.manifest.source.taskNames ?? [resolution.manifest.source.taskName]) !== JSON.stringify(selected.selectedTaskNames)
      || resolution.manifest.source.resolved.checksum !== selected.profile.datasetProjectionChecksum) {
      refuse("record-integrity", "deepSweV11.pier", "Pier selection does not exactly bind the DeepSWE v1.1 task material");
    }
    const bytes = harborSelectionManifestBytes(resolution.manifest);
    const selectionManifestSha256 = harborSelectionManifestSha256(resolution.manifest);
    if (putSealedBytes(context.workspaceDir, bytes) !== selectionManifestSha256) refuse("record-integrity", "harbor.selection", "selection bytes changed while storing");
    writeHarborHostBinding(context.workspaceDir, selectionManifestSha256, resolution.binding);
    attachBenchmarkToDraft(context.workspaceDir, input.draftId, benchmarkSha256, at);
    const attached = readDraftDocument(context.workspaceDir, input.draftId);
    const replicates = selected.profile.execution.nAttempts;
    const draft: DraftDocument = { ...attached, updatedAt: at, spec: parseDraftSpec({
      ...attached.spec,
      replicates,
      policy: {
        ...attached.spec.policy,
        replacement: replacement.allowed && (replacement.maxPerCell ?? 1) >= 3
          ? { allowed: true, maxPerCell: replacement.maxPerCell ?? 3 }
          : { allowed: true, maxPerCell: 3 },
      },
      arms: attached.spec.arms.map((arm) => {
        const armSelection = resolution.manifest.arms.find((candidate) => candidate.armId === arm.armId);
        if (armSelection === undefined) refuse("validation", `spec.arms.${arm.armId}`, "DeepSWE v1.1 selection has no exact Pier AgentConfig mapping for this Run arm");
        return { ...arm, pinning: { ...arm.pinning, harness: { id: PIER_ADAPTER_ID, version: resolution.manifest.harbor.version }, agent: { id: armSelection.agent.id }, model: { id: armSelection.model.id } } };
      }),
      evaluationRuntime: { adapterId: PIER_ADAPTER_ID, selectionManifestSha256, isolationPolicy: "unrestricted" },
    }) };
    atomicWriteFileSync(draftPath(context.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
    return { draft, selectionManifestSha256, deepSweV11ProfileSha256: selected.profileSha256, suiteProtocolSha256, benchmarkSha256 };
  } });
}
