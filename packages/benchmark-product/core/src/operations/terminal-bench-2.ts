/** Audited product operations for Terminal-Bench 2 selection and legacy migration. */
import { isDraftMutable } from "../domain/lifecycle.js";
import { parseDraftSpec, type DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { createDefaultBenchmarkRuntimeHost } from "../runtime/host-port.js";
import { harborSelectionManifestBytes, harborSelectionManifestSha256 } from "../runtime/harbor/manifest.js";
import { sealHarborSelectionDependencies, writeHarborHostBinding } from "../runtime/harbor/host.js";
import {
  migrateTerminalBenchLegacyMaterial,
  resolveTerminalBench2Selection,
  type TerminalBench2SelectionRequest,
  type TerminalBenchMigrationRequest,
  type TerminalBenchMigrationResolution,
} from "../runtime/terminal-bench-2/host.js";
import { TERMINAL_BENCH_2_PROFILE, TerminalBench2SelectionManifestSchema, TerminalBenchMigrationManifestSchema, terminalBench2SelectionBytes } from "../runtime/terminal-bench-2/manifest.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export type SelectTerminalBench2RuntimeInput = { readonly draftId: string } & TerminalBench2SelectionRequest;
export interface SelectTerminalBench2RuntimeResult {
  readonly draft: DraftDocument;
  readonly selectionManifestSha256: string;
  readonly terminalBench2ProfileSha256: string;
}

export function selectTerminalBench2Runtime(context: OperationContext, input: SelectTerminalBench2RuntimeInput): Promise<OperationResult<SelectTerminalBench2RuntimeResult>> {
  const at = context.clock();
  const clocked = { ...context, clock: () => at };
  return operateAsync({ context: clocked, action: "runtime.terminal-bench-2.select", subject: input.draftId, inputs: input, run: async () => {
    const current = readDraftDocument(context.workspaceDir, input.draftId);
    if (!isDraftMutable(current.state)) refuse("illegal-transition", `drafts.${input.draftId}.state`, "locked drafts refuse Terminal-Bench 2 selection");
    const selected = resolveTerminalBench2Selection(context.workspaceDir, input);
    if (putSealedBytes(context.workspaceDir, terminalBench2SelectionBytes(selected.profile)) !== selected.profileSha256) {
      refuse("record-integrity", "terminalBench2.profile", "Terminal-Bench 2 profile bytes changed while storing");
    }
    const resolution = await (context.runtimeHost ?? createDefaultBenchmarkRuntimeHost()).resolveHarborSelection(selected.harbor);
    sealHarborSelectionDependencies(context.workspaceDir, resolution);
    const embedded = TerminalBench2SelectionManifestSchema.parse(resolution.manifest.profiles?.[TERMINAL_BENCH_2_PROFILE]);
    if (sha256Hex(terminalBench2SelectionBytes(embedded)) !== selected.profileSha256) {
      refuse("record-integrity", "terminalBench2.profile", "Harbor host changed the sealed Terminal-Bench 2 selection profile");
    }
    if (resolution.manifest.source.kind !== "dataset"
      || !("name" in resolution.manifest.source.input)
      || resolution.manifest.source.input.name !== "terminal-bench/terminal-bench-2"
      || !("ref" in resolution.manifest.source.input)
      || resolution.manifest.source.input.ref !== selected.profile.dataset.revision
      || resolution.manifest.source.taskName !== selected.profile.selectedTask.filter
      || resolution.manifest.source.resolved.checksum !== selected.profile.selectedTask.datasetProjectionChecksum) {
      refuse("record-integrity", "terminalBench2.harbor", "Harbor selection does not exactly bind the Terminal-Bench 2 dataset/task material");
    }
    if (embedded.migrationManifestSha256 !== undefined) {
      const migration = TerminalBenchMigrationManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(context.workspaceDir, embedded.migrationManifestSha256))));
      if (migration.harbor.version !== resolution.manifest.harbor.version || migration.harbor.executableSha256 !== resolution.manifest.harbor.executableSha256) {
        refuse("record-integrity", "terminalBench2.migration.harbor", "migration and execution must use the same byte-pinned Harbor release");
      }
    }
    const bytes = harborSelectionManifestBytes(resolution.manifest);
    const selectionManifestSha256 = harborSelectionManifestSha256(resolution.manifest);
    if (putSealedBytes(context.workspaceDir, bytes) !== selectionManifestSha256) refuse("record-integrity", "harbor.selection", "selection bytes changed while storing");
    writeHarborHostBinding(context.workspaceDir, selectionManifestSha256, resolution.binding);
    const draft: DraftDocument = { ...current, updatedAt: at, spec: parseDraftSpec({
      ...current.spec,
      arms: current.spec.arms.map((arm) => {
        const armSelection = resolution.manifest.arms.find((candidate) => candidate.armId === arm.armId);
        if (armSelection === undefined) refuse("validation", `spec.arms.${arm.armId}`, "Terminal-Bench 2 selection has no exact Harbor AgentConfig mapping for this Run arm");
        return { ...arm, pinning: { ...arm.pinning, harness: { id: "harbor", version: resolution.manifest.harbor.version }, agent: { id: armSelection.agent.id }, model: { id: armSelection.model.id } } };
      }),
      evaluationRuntime: { adapterId: "harbor", selectionManifestSha256, isolationPolicy: "unrestricted" },
    }) };
    atomicWriteFileSync(draftPath(context.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
    return { draft, selectionManifestSha256, terminalBench2ProfileSha256: selected.profileSha256 };
  } });
}

export type MigrateTerminalBenchLegacyTaskInput = TerminalBenchMigrationRequest;
export type MigrateTerminalBenchLegacyTaskResult = TerminalBenchMigrationResolution;

export function migrateTerminalBenchLegacyTask(context: OperationContext, input: MigrateTerminalBenchLegacyTaskInput): Promise<OperationResult<MigrateTerminalBenchLegacyTaskResult>> {
  const at = context.clock();
  return operateAsync({
    context: { ...context, clock: () => at },
    action: "runtime.terminal-bench.migrate",
    subject: "workspace",
    inputs: input,
    run: () => migrateTerminalBenchLegacyMaterial(context.workspaceDir, input),
  });
}
