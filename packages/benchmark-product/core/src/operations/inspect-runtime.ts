import { resolve } from "node:path";
import { isDraftMutable, transition, type LifecycleState } from "../domain/lifecycle.js";
import { parseDraftSpec, type DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import {
  INSPECT_ADAPTER_ID,
  INSPECT_ARM_REQUIREMENT_KEY,
  assertNoSecretLikeConfiguration,
  type InspectArmConfiguration,
  type InspectRunOptions,
} from "../runtime/inspect/manifest.js";
import { buildInspectSelectionArtifacts } from "../runtime/inspect/artifacts.js";
import { probeInspectSelection, writeInspectHostBinding } from "../runtime/inspect/host.js";
import { draftPath } from "../workspace/layout.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface SelectInspectEvaluationInput {
  readonly draftId: string;
  readonly pythonPath: string;
  readonly projectDir: string;
  readonly taskReference: string;
  readonly taskArgs?: Readonly<Record<string, unknown>>;
  readonly arms: readonly InspectArmConfiguration[];
  readonly scorer: { readonly name: string; readonly passValue: string | number | boolean | null };
  readonly runOptions?: InspectRunOptions;
}

export interface SelectInspectEvaluationResult {
  readonly draft: DraftDocument;
  readonly selectionManifestSha256: string;
  readonly benchmarkSha256: string;
  readonly taskSha256: string;
  readonly evaluationSpecSha256: string;
}

export function selectInspectEvaluation(
  context: OperationContext,
  input: SelectInspectEvaluationInput,
): Promise<OperationResult<SelectInspectEvaluationResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };
  return operateAsync({
    context: clockedContext,
    action: "runtime.inspect.select",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const current = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      if (!isDraftMutable(current.state)) {
        refuse("illegal-transition", `drafts.${input.draftId}.state`, `draft ${input.draftId} is locked and refuses runtime selection`);
      }
      if (current.spec.taskSet.kind !== "pendingSample") {
        refuse("conflict", `drafts.${input.draftId}.taskSet`, "Inspect selection requires a draft with no benchmark attached");
      }
      if (current.spec.assurance.preset !== "direct-check" || current.spec.assurance.overrides !== undefined) {
        refuse("validation", `drafts.${input.draftId}.assurance`, "the first Inspect slice supports direct-check only; same-execution Inspect scoring is not independent evaluation");
      }
      try {
        assertNoSecretLikeConfiguration({ taskArgs: input.taskArgs ?? {}, arms: input.arms, runOptions: input.runOptions ?? {} });
      } catch (cause) {
        refuse("validation", "inspect.selection", cause instanceof Error ? cause.message : String(cause));
      }
      const host = { pythonPath: resolve(input.pythonPath), projectDir: resolve(input.projectDir) };
      const manifest = await probeInspectSelection({ ...input, ...host });
      const artifacts = buildInspectSelectionArtifacts(manifest);
      for (const [label, bytes, expected] of [
        ["selection manifest", artifacts.manifestBytes, artifacts.manifestSha256],
        ["evaluation spec", artifacts.evaluationSpecBytes, artifacts.evaluationSpecSha256],
        ["task", artifacts.taskBytes, artifacts.taskSha256],
        ["benchmark", artifacts.benchmarkBytes, artifacts.benchmarkSha256],
      ] as const) {
        const stored = putSealedBytes(clockedContext.workspaceDir, bytes);
        if (stored !== expected) refuse("record-integrity", "inspect.selection", `${label} digest changed while storing`);
      }
      writeInspectHostBinding(clockedContext.workspaceDir, artifacts.manifestSha256, {
        ...host,
      });
      let nextState: LifecycleState = current.state;
      if (current.state === "quoted") {
        const edited = transition("quoted", "edit");
        if (edited.ok) nextState = edited.state;
      }
      const spec = parseDraftSpec({
        ...current.spec,
        taskSet: { kind: "benchmark", benchmarkSha256: artifacts.benchmarkSha256 },
        arms: manifest.arms.map((arm) => ({
          armId: arm.armId,
          pinning: {
            harness: { id: "inspect-ai", version: manifest.runtime.inspectVersion },
            model: { id: arm.model },
            [INSPECT_ARM_REQUIREMENT_KEY]: arm.armId,
          },
        })),
        evaluationRuntime: {
          adapterId: INSPECT_ADAPTER_ID,
          selectionManifestSha256: artifacts.manifestSha256,
        },
      });
      const draft: DraftDocument = { ...current, state: nextState, updatedAt: at, spec };
      atomicWriteFileSync(draftPath(clockedContext.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
      return {
        draft,
        selectionManifestSha256: artifacts.manifestSha256,
        benchmarkSha256: artifacts.benchmarkSha256,
        taskSha256: artifacts.taskSha256,
        evaluationSpecSha256: artifacts.evaluationSpecSha256,
      };
    },
  });
}
