/** Binds a mutable draft to a sealed managed-Harbor selection; no task is run here. */
import { isDraftMutable } from "../domain/lifecycle.js";
import { parseDraftSpec, type DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { harborSelectionManifestBytes, harborSelectionManifestSha256 } from "../runtime/harbor/manifest.js";
import { writeHarborHostBinding, type HarborRuntimeSelectionRequest } from "../runtime/harbor/host.js";
import { createDefaultBenchmarkRuntimeHost } from "../runtime/host-port.js";
import { draftPath } from "../workspace/layout.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export type SelectHarborRuntimeInput = { readonly draftId: string } & HarborRuntimeSelectionRequest;
export interface SelectHarborRuntimeResult { readonly draft: DraftDocument; readonly selectionManifestSha256: string; }

export function selectHarborRuntime(context: OperationContext, input: SelectHarborRuntimeInput): Promise<OperationResult<SelectHarborRuntimeResult>> {
  const at = context.clock(); const clocked = { ...context, clock: () => at };
  return operateAsync({ context: clocked, action: "runtime.harbor.select", subject: input.draftId, inputs: input, run: async () => {
    const current = readDraftDocument(context.workspaceDir, input.draftId);
    if (!isDraftMutable(current.state)) refuse("illegal-transition", `drafts.${input.draftId}.state`, "locked drafts refuse runtime selection");
    const resolution = await (context.runtimeHost ?? createDefaultBenchmarkRuntimeHost()).resolveHarborSelection(input);
    const bytes = harborSelectionManifestBytes(resolution.manifest);
    const selectionManifestSha256 = harborSelectionManifestSha256(resolution.manifest);
    if (putSealedBytes(context.workspaceDir, bytes) !== selectionManifestSha256) refuse("record-integrity", "harbor.selection", "selection bytes changed while storing");
    writeHarborHostBinding(context.workspaceDir, selectionManifestSha256, resolution.binding);
    const draft: DraftDocument = { ...current, updatedAt: at, spec: parseDraftSpec({
      ...current.spec,
      arms: current.spec.arms.map((arm) => ({ ...arm, pinning: { ...arm.pinning, harness: { id: "harbor", version: resolution.manifest.harbor.version }, model: { id: resolution.manifest.model.id } } })),
      evaluationRuntime: { adapterId: "harbor", selectionManifestSha256, isolationPolicy: "unrestricted" },
    }) };
    atomicWriteFileSync(draftPath(context.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
    return { draft, selectionManifestSha256 };
  } });
}
