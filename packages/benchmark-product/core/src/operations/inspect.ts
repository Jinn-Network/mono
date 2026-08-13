/**
 * Resolves and displays a draft: pinning per arm plus the assurance preset's
 * mapping onto the underlying primitives (spec §6: every surface shows the
 * primitives, never the label alone).
 *
 * Reads `readDraftDocument` directly rather than calling `getDraft` — going
 * through `getDraft` would run its own `operate` boundary and append its own
 * audit entry, giving this operation two entries instead of the one every
 * operation owes the journal (spec §4.4).
 *
 * When `taskSet.kind === "benchmark"`, the inspection also resolves the sealed
 * Benchmark: item count, and per-item task-digest / stored / evaluation-digest
 * status (spec §4.5 — product state references sealed records by digest only,
 * so "is the referenced content actually present" is itself worth surfacing).
 * `getSealedBytes`'s typed `not-found` / `record-integrity` refusals are left
 * to propagate here, deliberately: a draft referencing benchmark bytes the
 * workspace no longer has is a real error, not something to paper over.
 * A `pendingSample` draft carries no `benchmark` axis at all — task sampling
 * fills that in a later packet.
 */

import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  itemTaskDigest,
  parseBenchmark,
} from "@jinn-network/benchmarking-records";
import { resolveAssurance, type DraftSpec, type ResolvedAssurance } from "../domain/draft.js";
import type { LifecycleState } from "../domain/lifecycle.js";
import { getSealedBytes, hasSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";
import {
  inspectRuntimeMethodForBinding,
  type InspectRuntimeMethodDisclosure,
} from "../runtime/inspect/disclosure.js";

export interface ArmInspection {
  readonly armId: string;
  readonly pinning: Readonly<Record<string, unknown>>;
  readonly notes?: string;
}

export interface BenchmarkInspectionItem {
  readonly taskSha256: string;
  readonly stored: boolean;
  readonly evaluationSha256?: string;
}

export interface BenchmarkInspection {
  readonly benchmarkSha256: string;
  readonly name: string;
  readonly version: string;
  readonly itemCount: number;
  readonly items: readonly BenchmarkInspectionItem[];
}

export interface DraftInspection {
  readonly draftId: string;
  readonly state: LifecycleState;
  readonly name: string;
  readonly description?: string;
  readonly venue: "self-run";
  readonly replicates: number;
  readonly taskSet: DraftSpec["taskSet"];
  readonly policy: DraftSpec["policy"];
  readonly budget?: DraftSpec["budget"];
  readonly arms: readonly ArmInspection[];
  readonly assurance: { readonly preset: string; readonly overrides?: unknown; readonly resolved: ResolvedAssurance };
  /** Present only when `taskSet.kind === "benchmark"` — absent for a still-`pendingSample` draft. */
  readonly benchmark?: BenchmarkInspection;
  /**
   * The §9.2 method that will produce this draft's Report (P4b Task 7), mirroring
   * `run/compile.ts`'s `buildAnalysisPlan` selection: an absent `spec.analysis` block means
   * `wilson@1`, exactly today's implicit default, so this field is always present even when the
   * draft names nothing explicit. Echoed verbatim from `spec.analysis` when set — not
   * registry-validated here, since that refusal belongs to compile time (Task 2), not inspection.
   */
  readonly analysis: { readonly method: string; readonly version: string };
  readonly runtimeMethod?: InspectRuntimeMethodDisclosure;
}

function resolveBenchmarkInspection(workspaceDir: string, benchmarkSha256: string): BenchmarkInspection {
  const bytes = getSealedBytes(workspaceDir, benchmarkSha256);
  const record = parseBenchmark(bytes);

  const items: BenchmarkInspectionItem[] = record.items.map((item) => {
    const taskSha256 = itemTaskDigest(item);
    const stored = hasSealedBytes(workspaceDir, taskSha256);
    if (!stored) return { taskSha256, stored };

    const taskBytes = getSealedBytes(workspaceDir, taskSha256);
    const task = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(taskBytes)) as {
      readonly evaluation?: { readonly digest?: { readonly sha256?: string } };
    };
    const evaluationSha256 = task.evaluation?.digest?.sha256;
    return evaluationSha256 === undefined ? { taskSha256, stored } : { taskSha256, stored, evaluationSha256 };
  });

  return {
    benchmarkSha256,
    name: record.name,
    version: record.version,
    itemCount: record.items.length,
    items,
  };
}

export function inspectDraft(
  context: OperationContext,
  input: { readonly draftId: string },
): OperationResult<{ inspection: DraftInspection }> {
  return operate({
    context,
    action: "draft.inspect",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      const spec = document.spec;

      const arms: ArmInspection[] = spec.arms.map((arm) => ({
        armId: arm.armId,
        pinning: arm.pinning,
        notes: arm.notes,
      }));

      const benchmark =
        spec.taskSet.kind === "benchmark"
          ? resolveBenchmarkInspection(context.workspaceDir, spec.taskSet.benchmarkSha256)
          : undefined;
      const runtimeMethod = inspectRuntimeMethodForBinding(
        context.workspaceDir,
        spec.evaluationRuntime,
        resolveAssurance(spec.assurance),
      );

      const inspection: DraftInspection = {
        draftId: document.draftId,
        state: document.state,
        name: spec.name,
        description: spec.description,
        venue: spec.venue,
        replicates: spec.replicates,
        taskSet: spec.taskSet,
        policy: spec.policy,
        budget: spec.budget,
        arms,
        assurance: {
          preset: spec.assurance.preset,
          overrides: spec.assurance.overrides,
          resolved: resolveAssurance(spec.assurance),
        },
        analysis: spec.analysis === undefined
          ? { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION }
          : { method: spec.analysis.method, version: spec.analysis.version },
        ...(runtimeMethod === undefined ? {} : { runtimeMethod }),
        ...(benchmark !== undefined ? { benchmark } : {}),
      };
      return { inspection };
    },
  });
}
