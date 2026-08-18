/** Audited product operation for Inspect eval official-suite selection. */
import { isDraftMutable, transition, type LifecycleState } from "../domain/lifecycle.js";
import { parseDraftSpec, resolveAssurance, type DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { buildInspectEvalTasks } from "../intake/inspect-eval.js";
import {
  INSPECT_ADAPTER_ID,
  INSPECT_ARM_REQUIREMENT_KEY,
  InspectScoringRequestSchema,
  assertNoSecretLikeConfiguration,
} from "../runtime/inspect/manifest.js";
import { inspectCatalogSnapshotSha256 } from "../runtime/inspect-eval/catalog.js";
import {
  InspectEvalSelectionManifestSchema,
  inspectEvalSelectionBytes,
  type InspectEvalSelectionManifest,
} from "../runtime/inspect-eval/manifest.js";
import { stripInspectTemplateSampleId } from "../runtime/inspect-eval/overlay.js";
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
import {
  coverageFromSelectedNames,
  namedSliceTaskNames,
  SuiteProtocolSelectionSchema,
  suiteProtocolSelectionBytes,
  type SuiteCoverage,
} from "../runtime/suite-protocol/manifest.js";
import { draftPath } from "../workspace/layout.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

interface SelectInspectEvalBase {
  readonly draftId: string;
  readonly coverage?: Exclude<SuiteCoverage, "custom">;
  readonly sampleIds?: readonly (string | number)[];
  readonly specifiedEpochs?: number;
  readonly solver?: string;
  readonly sampleLimit?: number | null;
}

export type SelectInspectEvalRuntimeInput = SelectInspectEvalBase & InspectRuntimeSelectionRequest;

export interface SelectInspectEvalRuntimeResult {
  readonly draft: DraftDocument;
  readonly selectionManifestSha256: string;
  readonly suiteProtocolSha256: string;
  readonly benchmarkSha256: string;
  readonly runtimeMethod: InspectRuntimeMethodDisclosure;
}

function selectedCatalogSamples(
  catalogIds: readonly (string | number)[],
  input: SelectInspectEvalRuntimeInput,
): { readonly coverage: SuiteCoverage; readonly selected: readonly (string | number)[] } {
  const names = catalogIds.map((id) => String(id));
  const byKey = new Map(catalogIds.map((id) => [String(id), id] as const));
  if (input.sampleIds !== undefined) {
    if (input.sampleIds.length === 0) {
      refuse("validation", "inspect-eval.sampleIds", "custom sample list must not be empty");
    }
    const selected = input.sampleIds.map((id) => {
      const found = byKey.get(String(id));
      if (found === undefined) {
        refuse("validation", "inspect-eval.sampleIds", `sample ${String(id)} is not in the sealed catalog`);
      }
      return found;
    });
    const coverage = coverageFromSelectedNames(names, selected.map((id) => String(id)));
    if (input.coverage !== undefined && coverage !== input.coverage) {
      refuse("validation", "inspect-eval.coverage", "sample list does not match the named coverage slice");
    }
    return { coverage, selected };
  }
  if (input.coverage === undefined) {
    refuse("validation", "inspect-eval.coverage", "Inspect eval selection requires coverage or an explicit sample list");
  }
  const selectedNames = namedSliceTaskNames(names, input.coverage);
  return {
    coverage: input.coverage,
    selected: selectedNames.map((name) => byKey.get(name)!),
  };
}

export function parseInspectEvalSelection(value: unknown): InspectEvalSelectionManifest | undefined {
  const parsed = InspectEvalSelectionManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function selectInspectEvalRuntime(
  context: OperationContext,
  input: SelectInspectEvalRuntimeInput,
): Promise<OperationResult<SelectInspectEvalRuntimeResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };
  return operateAsync({
    context: clockedContext,
    action: "runtime.inspect.eval.select",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const current = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      if (!isDraftMutable(current.state)) {
        refuse("illegal-transition", `drafts.${input.draftId}.state`, `draft ${input.draftId} is locked and refuses runtime selection`);
      }
      if (current.spec.taskSet.kind !== "pendingSample") {
        refuse("conflict", `drafts.${input.draftId}.taskSet`, "Inspect eval selection requires a draft with no benchmark attached");
      }
      if ((input.scorer === undefined) === (input.scoring === undefined)) {
        refuse("validation", "inspect-eval.selection", "select exactly one of scorer or scoring");
      }
      if (input.scoring !== undefined && !InspectScoringRequestSchema.safeParse(input.scoring).success) {
        refuse("validation", "inspect-eval.selection.scoring", "Inspect scoring projections or verdictRule are invalid");
      }
      try {
        assertNoSecretLikeConfiguration({
          taskArgs: input.taskArgs ?? {},
          arms: input.arms,
          runOptions: input.runOptions ?? {},
          ...(input.scoring === undefined ? {} : { scoring: input.scoring }),
        });
      } catch (cause) {
        refuse("validation", "inspect-eval.selection", cause instanceof Error ? cause.message : String(cause));
      }
      const runtimeHost = context.runtimeHost ?? createDefaultBenchmarkRuntimeHost();
      let catalog;
      try {
        catalog = await runtimeHost.catalogInspectTask(input);
      } catch (cause) {
        if (!(cause instanceof InspectOciUnavailableError)) throw cause;
        refuse(
          "venue-unavailable",
          "inspect-eval.catalog",
          cause instanceof Error ? cause.message : "The Inspect runtime could not be checked locally.",
        );
      }
      const { coverage, selected } = selectedCatalogSamples(catalog.sampleIds, input);
      const specifiedEpochs = input.specifiedEpochs ?? catalog.specifiedEpochs;
      if (!Number.isInteger(specifiedEpochs) || specifiedEpochs < 1) {
        refuse("validation", "inspect-eval.specifiedEpochs", "specified epochs must be a positive integer");
      }
      const inspectRequest: InspectRuntimeSelectionRequest = input.execution === "oci"
        ? {
          ...input,
          runOptions: {
            ...input.runOptions,
            sampleId: selected[0]!,
            maxSamples: 1,
          },
        }
        : input;
      let resolution: Awaited<ReturnType<typeof runtimeHost.resolveInspectSelection>>;
      try {
        resolution = await runtimeHost.resolveInspectSelection(inspectRequest);
      } catch (cause) {
        if (!(cause instanceof InspectOciUnavailableError)) throw cause;
        refuse(
          "venue-unavailable",
          "inspect-eval.selection.runtime",
          cause instanceof Error ? cause.message : "The Inspect runtime could not be checked locally.",
        );
      }
      const inspectTemplate = stripInspectTemplateSampleId(resolution.manifest);
      const sourceDigest = inspectTemplate.task.source.sha256;
      // Every field here is the value the eval itself declared, never the operator's
      // `input.specifiedEpochs` override: `assertInspectSelectionUndrifted` recomputes this
      // digest from a fresh catalog probe, where no override exists. Sealing the override
      // would make the re-probe mismatch on every overridden run and refuse it as drift.
      const snapshotSha256 = inspectCatalogSnapshotSha256({
        sampleIds: catalog.sampleIds,
        taskSourceDigest: sourceDigest,
        specifiedEpochs: catalog.specifiedEpochs,
        epochsReducer: catalog.epochsReducer ?? null,
        taskVersion: catalog.taskVersion ?? null,
        datasetName: catalog.datasetName,
        datasetLocation: catalog.datasetLocation,
        datasetSampleCount: catalog.datasetSampleCount,
      });
      const built = buildInspectEvalTasks({
        inspect: inspectTemplate,
        sampleIds: selected,
        resolvedName: inspectTemplate.task.resolvedName,
      });
      if (putSealedBytes(clockedContext.workspaceDir, built.evaluationSpec.bytes) !== built.evaluationSpec.sha256) {
        refuse("record-integrity", "inspect-eval.evaluationSpec", "evaluation spec digest changed while storing");
      }
      for (const task of built.tasks) {
        if (putSealedBytes(clockedContext.workspaceDir, task.bytes) !== task.sha256) {
          refuse("record-integrity", "inspect-eval.task", "task digest changed while storing");
        }
      }
      if (putSealedBytes(clockedContext.workspaceDir, built.benchmark.bytes) !== built.benchmark.sha256) {
        refuse("record-integrity", "inspect-eval.benchmark", "benchmark digest changed while storing");
      }
      const suite = SuiteProtocolSelectionSchema.parse({
        schema: "jinn.network/benchmark-product/suite-protocol-selection/1",
        protocol: "inspect-eval",
        coverage,
        datasetId: inspectTemplate.task.resolvedName,
        datasetRevision: snapshotSha256,
        selectedTaskNames: built.tasks.map((task) => task.taskName),
        datasetTaskCount: catalog.sampleIds.length,
        replicates: specifiedEpochs,
        atifRequired: false,
        items: built.tasks.map((task) => ({ taskName: task.taskName, taskSha256: task.sha256 })),
      });
      const suiteBytes = suiteProtocolSelectionBytes(suite);
      // Stored for content addressability only — unlike Terminal-Bench 2.1 this digest gets no
      // registration-artifact row of its own. `runtimeRegistrationArtifacts` returns early for
      // every Inspect adapter with one selection-manifest correlation, and `suite` is embedded
      // in that selection manifest, so these bytes are bound transitively through its digest.
      const suiteProtocolSha256 = putSealedBytes(clockedContext.workspaceDir, suiteBytes);
      const selection = InspectEvalSelectionManifestSchema.parse({
        schema: "jinn.network/benchmark-product/inspect-eval-selection/1",
        inspect: inspectTemplate,
        catalog: {
          sampleIds: [...catalog.sampleIds],
          snapshotSha256,
          specifiedEpochs,
          ...(catalog.epochsReducer === undefined || catalog.epochsReducer === null
            ? {}
            : { epochsReducer: catalog.epochsReducer }),
          ...(catalog.taskVersion === undefined || catalog.taskVersion === null
            ? {}
            : { taskVersion: catalog.taskVersion }),
          datasetName: catalog.datasetName,
          datasetLocation: catalog.datasetLocation,
          datasetSampleCount: catalog.datasetSampleCount,
        },
        coverage,
        selectedSamples: selected.map((sampleId) => ({ sampleId })),
        // A `--solver` override is allowed to select; quote then declines to mark
        // executionConformance for it (`officialInspectEvalConformance`).
        solver: input.solver ?? "task-default",
        sampleLimit: input.sampleLimit ?? null,
        suite,
      });
      const selectionBytes = inspectEvalSelectionBytes(selection);
      const selectionManifestSha256 = putSealedBytes(clockedContext.workspaceDir, selectionBytes);
      writeInspectHostBinding(clockedContext.workspaceDir, selectionManifestSha256, resolution.binding);
      let nextState: LifecycleState = current.state;
      if (current.state === "quoted") {
        const edited = transition("quoted", "edit");
        if (edited.ok) nextState = edited.state;
      }
      const spec = parseDraftSpec({
        ...current.spec,
        taskSet: { kind: "benchmark", benchmarkSha256: built.benchmark.sha256 },
        replicates: specifiedEpochs,
        arms: inspectTemplate.arms.map((arm) => ({
          armId: arm.armId,
          pinning: {
            harness: { id: "inspect-ai", version: inspectTemplate.runtime.inspectVersion },
            model: { id: arm.model },
            [INSPECT_ARM_REQUIREMENT_KEY]: arm.armId,
          },
        })),
        evaluationRuntime: {
          adapterId: INSPECT_ADAPTER_ID,
          selectionManifestSha256,
          isolationPolicy: input.execution === "oci" ? "oci-container" : "unrestricted",
        },
      });
      const draft: DraftDocument = { ...current, state: nextState, updatedAt: at, spec };
      atomicWriteFileSync(draftPath(clockedContext.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
      return {
        draft,
        selectionManifestSha256,
        suiteProtocolSha256,
        benchmarkSha256: built.benchmark.sha256,
        runtimeMethod: describeInspectRuntimeMethod(
          inspectTemplate as never,
          selectionManifestSha256,
          resolveAssurance(current.spec.assurance),
        ),
      };
    },
  });
}
