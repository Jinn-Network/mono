/** Audited product operations for Terminal-Bench 2.1 official-suite selection. */
import { BENCHMARK_RECORD_KIND } from "@jinn-network/benchmarking-records";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import { buildPredictionForecastProfile, sealTaskProfile } from "@jinn-network/task-execution-profiles";
import { isDraftMutable } from "../domain/lifecycle.js";
import { parseDraftSpec, type DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { buildTerminalBench21Tasks } from "../intake/terminal-bench-2-1.js";
import { deriveWorkspaceAuthoredBenchmark, deriveWorkspaceAuthoredTask } from "../intake/workspace-authored.js";
import { attachBenchmarkToDraft } from "./attach.js";
import { createDefaultBenchmarkRuntimeHost } from "../runtime/host-port.js";
import { harborSelectionManifestBytes, harborSelectionManifestSha256 } from "../runtime/harbor/manifest.js";
import { sealHarborSelectionDependencies, writeHarborHostBinding } from "../runtime/harbor/host.js";
import {
  SUITE_PROTOCOL_PROFILE,
  SuiteProtocolSelectionSchema,
  suiteProtocolSelectionBytes,
} from "../runtime/suite-protocol/manifest.js";
import {
  resolveTerminalBench21Selection,
  type TerminalBench21SelectionRequest,
} from "../runtime/terminal-bench-2-1/host.js";
import {
  TERMINAL_BENCH_2_1_DATASET_ID,
  TERMINAL_BENCH_2_1_PROFILE,
  TerminalBench21SelectionManifestSchema,
  terminalBench21SelectionBytes,
} from "../runtime/terminal-bench-2-1/manifest.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import { recordWorkspaceAuthorship } from "../run/publication-authority.js";
import { draftPath } from "../workspace/layout.js";
import { putSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export type SelectTerminalBench21RuntimeInput = { readonly draftId: string } & TerminalBench21SelectionRequest;
export interface SelectTerminalBench21RuntimeResult {
  readonly draft: DraftDocument;
  readonly selectionManifestSha256: string;
  readonly terminalBench21ProfileSha256: string;
  readonly suiteProtocolSha256: string;
  readonly benchmarkSha256: string;
}

export function selectTerminalBench21Runtime(context: OperationContext, input: SelectTerminalBench21RuntimeInput): Promise<OperationResult<SelectTerminalBench21RuntimeResult>> {
  const at = context.clock();
  const clocked = { ...context, clock: () => at };
  return operateAsync({ context: clocked, action: "runtime.terminal-bench-2-1.select", subject: input.draftId, inputs: input, run: async () => {
    const current = readDraftDocument(context.workspaceDir, input.draftId);
    if (!isDraftMutable(current.state)) refuse("illegal-transition", `drafts.${input.draftId}.state`, "locked drafts refuse Terminal-Bench 2.1 selection");
    if (current.spec.analysis?.method === "jinn.benchmarking.method/binary-instrument") {
      refuse("validation", `drafts.${input.draftId}.spec.analysis`, "Terminal-Bench 2.1 official suite refuses binary-instrument majority-k; use wilson@1 over judged replicates");
    }
    const selected = resolveTerminalBench21Selection(context.workspaceDir, input);
    if (putSealedBytes(context.workspaceDir, terminalBench21SelectionBytes(selected.profile)) !== selected.profileSha256) {
      refuse("record-integrity", "terminalBench21.profile", "Terminal-Bench 2.1 profile bytes changed while storing");
    }
    const built = await buildTerminalBench21Tasks(selected.selectedTaskNames);
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
        sourceKind: "terminal-bench-2-1",
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
      protocol: "terminal-bench-2.1",
      coverage: selected.coverage,
      datasetId: TERMINAL_BENCH_2_1_DATASET_ID,
      datasetRevision: selected.profile.dataset.revision,
      selectedTaskNames: [...selected.selectedTaskNames],
      datasetTaskCount: selected.profile.dataset.taskCount,
      replicates: 5,
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
    const embedded = TerminalBench21SelectionManifestSchema.parse(resolution.manifest.profiles?.[TERMINAL_BENCH_2_1_PROFILE]);
    if (sha256Hex(terminalBench21SelectionBytes(embedded)) !== selected.profileSha256) {
      refuse("record-integrity", "terminalBench21.profile", "Harbor host changed the sealed Terminal-Bench 2.1 selection profile");
    }
    if (resolution.manifest.source.kind !== "dataset"
      || !("name" in resolution.manifest.source.input)
      || resolution.manifest.source.input.name !== TERMINAL_BENCH_2_1_DATASET_ID
      || !("ref" in resolution.manifest.source.input)
      || resolution.manifest.source.input.ref !== selected.profile.dataset.revision
      || resolution.manifest.source.taskName !== selected.selectedTaskNames[0]
      || JSON.stringify(resolution.manifest.source.taskNames ?? [resolution.manifest.source.taskName]) !== JSON.stringify(selected.selectedTaskNames)
      || resolution.manifest.source.resolved.checksum !== selected.profile.datasetProjectionChecksum) {
      refuse("record-integrity", "terminalBench21.harbor", "Harbor selection does not exactly bind the Terminal-Bench 2.1 dataset/task material");
    }
    const bytes = harborSelectionManifestBytes(resolution.manifest);
    const selectionManifestSha256 = harborSelectionManifestSha256(resolution.manifest);
    if (putSealedBytes(context.workspaceDir, bytes) !== selectionManifestSha256) refuse("record-integrity", "harbor.selection", "selection bytes changed while storing");
    writeHarborHostBinding(context.workspaceDir, selectionManifestSha256, resolution.binding);
    attachBenchmarkToDraft(context.workspaceDir, input.draftId, benchmarkSha256, at);
    const attached = readDraftDocument(context.workspaceDir, input.draftId);
    const draft: DraftDocument = { ...attached, updatedAt: at, spec: parseDraftSpec({
      ...attached.spec,
      replicates: 5,
      arms: attached.spec.arms.map((arm) => {
        const armSelection = resolution.manifest.arms.find((candidate) => candidate.armId === arm.armId);
        if (armSelection === undefined) refuse("validation", `spec.arms.${arm.armId}`, "Terminal-Bench 2.1 selection has no exact Harbor AgentConfig mapping for this Run arm");
        return { ...arm, pinning: { ...arm.pinning, harness: { id: "harbor", version: resolution.manifest.harbor.version }, agent: { id: armSelection.agent.id }, model: { id: armSelection.model.id } } };
      }),
      evaluationRuntime: { adapterId: "harbor", selectionManifestSha256, isolationPolicy: "unrestricted" },
    }) };
    atomicWriteFileSync(draftPath(context.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
    return { draft, selectionManifestSha256, terminalBench21ProfileSha256: selected.profileSha256, suiteProtocolSha256, benchmarkSha256 };
  } });
}
