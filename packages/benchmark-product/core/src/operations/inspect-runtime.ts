import { isDraftMutable, transition, type LifecycleState } from "../domain/lifecycle.js";
import { parseDraftSpec, resolveAssurance, type DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import {
  INSPECT_ADAPTER_ID,
  INSPECT_ARM_REQUIREMENT_KEY,
  InspectScoringRequestSchema,
  assertNoSecretLikeConfiguration,
} from "../runtime/inspect/manifest.js";
import { buildInspectSelectionArtifacts } from "../runtime/inspect/artifacts.js";
import {
  describeInspectRuntimeMethod,
  type InspectRuntimeMethodDisclosure,
} from "../runtime/inspect/disclosure.js";
import { writeInspectHostBinding } from "../runtime/inspect/host.js";
import { InspectOciUnavailableError } from "../runtime/inspect/oci.js";
import {
  createDefaultBenchmarkRuntimeHost,
  type InspectRuntimeSelectionRequest,
} from "../runtime/host-port.js";
import { draftPath } from "../workspace/layout.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

interface SelectInspectEvaluationBaseInput {
  readonly draftId: string;
}

export type SelectInspectEvaluationInput = SelectInspectEvaluationBaseInput & InspectRuntimeSelectionRequest;

export interface SelectInspectEvaluationResult {
  readonly draft: DraftDocument;
  readonly selectionManifestSha256: string;
  readonly benchmarkSha256: string;
  readonly taskSha256: string;
  readonly evaluationSpecSha256: string;
  readonly runtimeMethod: InspectRuntimeMethodDisclosure;
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
      if ((input.scorer === undefined) === (input.scoring === undefined)) {
        refuse("validation", "inspect.selection", "select exactly one of scorer or scoring");
      }
      if (input.scoring !== undefined && !InspectScoringRequestSchema.safeParse(input.scoring).success) {
        refuse("validation", "inspect.selection.scoring", "Inspect scoring projections or verdictRule are invalid");
      }
      try {
        assertNoSecretLikeConfiguration({
          taskArgs: input.taskArgs ?? {},
          arms: input.arms,
          runOptions: input.runOptions ?? {},
          ...(input.scoring === undefined ? {} : { scoring: input.scoring }),
        });
      } catch (cause) {
        refuse("validation", "inspect.selection", cause instanceof Error ? cause.message : String(cause));
      }
      const runtimeHost = context.runtimeHost ?? createDefaultBenchmarkRuntimeHost();
      let resolution: Awaited<ReturnType<typeof runtimeHost.resolveInspectSelection>>;
      try {
        resolution = await runtimeHost.resolveInspectSelection(input);
      } catch (cause) {
        if (!(cause instanceof InspectOciUnavailableError)) throw cause;
        refuse(
          "venue-unavailable",
          "inspect.selection.runtime",
          cause instanceof Error ? cause.message : "The Inspect runtime could not be checked locally.",
        );
      }
      const { manifest } = resolution;
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
        ...resolution.binding,
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
          isolationPolicy: input.execution === "oci" ? "oci-container" : "unrestricted",
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
        runtimeMethod: describeInspectRuntimeMethod(
          manifest,
          artifacts.manifestSha256,
          resolveAssurance(current.spec.assurance),
        ),
      };
    },
  });
}
