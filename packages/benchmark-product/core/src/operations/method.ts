/** One method bind and one derived export (DR-2026-08-18-f). */
import type { DraftDocument } from "../domain/draft.js";
import { isDraftMutable } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { INSPECT_ADAPTER_ID } from "../runtime/inspect/manifest.js";
import { HARBOR_ADAPTER_ID } from "../runtime/harbor/manifest.js";
import { SWE_BENCH_HARNESS_ADAPTER_ID } from "../runtime/swe-bench-verified/manifest.js";
import { ARCHIPELAGO_ADAPTER_ID } from "../runtime/apex-agents/manifest.js";
import { APEX_SWE_DEV_ADAPTER_ID } from "../runtime/apex-swe-dev/manifest.js";
import type { HarborRuntimeSelectionRequest } from "../runtime/harbor/host.js";
import type { InspectRuntimeSelectionRequest } from "../runtime/host-port.js";
import {
  INSPECT_BINARY_JUDGE_ADAPTER_ID,
  INSPECT_BINARY_JUDGE_BINDING_REQUEST_SCHEMA,
  type InspectBinaryJudgeBindingRequest,
} from "../runtime/inspect/binary-judge-manifest.js";
import type { SuiteCoverage } from "../runtime/suite-protocol/comparability.js";
import type { OperationContext } from "./context.js";
import { operate } from "./operate.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";
import { executeSelectInspectEvaluation } from "./inspect-runtime.js";
import { executeBindInspectBinaryJudge } from "./inspect-binary-judge.js";
import { executeSelectHarborRuntime } from "./harbor-runtime.js";
import { attachBenchmarkToDraft } from "./attach.js";
import { buildTerminalBench21Tasks } from "../intake/terminal-bench-2-1.js";
import { putSealedBytes } from "../workspace/sealed-store.js";
import {
  executeExportHarborHubPackage,
  type ExportHarborHubPackageResult,
} from "./hub-export.js";
import {
  executeExportSwebenchPredictions,
  type ExportSwebenchPredictionsResult,
} from "./swebench-export.js";
import {
  executeExportApexAgentsInspection,
  type ExportApexAgentsResult,
} from "./apex-agents-export.js";
import {
  executeExportApexSwePackage,
  type ExportApexSwePackageResult,
} from "./apex-swe-export.js";
import {
  executeExportInspectViewBundle,
  type ExportInspectViewBundleResult,
} from "./inspect-view-export.js";
import { readDraftDocument } from "./drafts.js";
import {
  isMethodCatalogId,
  resolveMethodOperand,
  type MethodCatalogId,
  type MethodDocumentKind,
  type ResolveMethodOperandInput,
  type ResolvedMethod,
} from "./method-catalog.js";

export interface SelectMethodInput extends ResolveMethodOperandInput {
  readonly draftId: string;
}

export interface SelectMethodResult {
  readonly draft: DraftDocument;
  readonly selectionManifestSha256?: string;
  readonly benchmarkSha256?: string;
  readonly documentKind: MethodDocumentKind;
  readonly official: boolean;
  readonly catalogId?: MethodCatalogId;
  readonly suiteProtocolSha256?: string;
}

export interface ExportDerivedBundleInput {
  readonly draftId: string;
  readonly armId: string;
}

export type ExportDerivedBundleResult =
  | (ExportHarborHubPackageResult & { readonly shape: "harbor-hub" })
  | (ExportSwebenchPredictionsResult & { readonly shape: "swebench-predictions" })
  | (ExportApexAgentsResult & { readonly shape: "apex-inspection" })
  | (ExportApexSwePackageResult & { readonly shape: "apex-swe-package" })
  | (ExportInspectViewBundleResult & { readonly shape: "inspect-view" });

function namedCoverage(coverage: SuiteCoverage): Exclude<SuiteCoverage, "custom"> | undefined {
  return coverage === "custom" ? undefined : coverage;
}

function finish(
  inner: {
    readonly draft: DraftDocument;
    readonly selectionManifestSha256?: string;
    readonly suiteProtocolSha256?: string;
    readonly benchmarkSha256?: string;
  },
  documentKind: MethodDocumentKind,
  official: boolean,
): SelectMethodResult {
  return {
    draft: inner.draft,
    documentKind,
    official,
    ...(inner.selectionManifestSha256 === undefined ? {} : { selectionManifestSha256: inner.selectionManifestSha256 }),
    ...(inner.benchmarkSha256 === undefined ? {} : { benchmarkSha256: inner.benchmarkSha256 }),
    ...(official && isMethodCatalogId(documentKind) ? { catalogId: documentKind } : {}),
    ...(inner.suiteProtocolSha256 === undefined ? {} : { suiteProtocolSha256: inner.suiteProtocolSha256 }),
  };
}

function slateInputFromTerminalBench21File(document: Record<string, unknown>): {
  readonly coverage?: Exclude<SuiteCoverage, "custom">;
  readonly taskNames?: readonly string[];
} {
  const taskNames = document.taskNames;
  const coverage = document.coverage;
  const named = coverage === "one_task" || coverage === "ten_task" || coverage === "full" ? coverage : undefined;
  if (Array.isArray(taskNames) && taskNames.every((name) => typeof name === "string")) {
    return {
      taskNames: taskNames as string[],
      ...(named === undefined ? {} : { coverage: named }),
    };
  }
  return { coverage: named ?? "full" };
}

function attachOfficialTerminalBench21Slate(
  context: OperationContext,
  draftId: string,
  input: {
    readonly coverage?: Exclude<SuiteCoverage, "custom">;
    readonly taskNames?: readonly string[];
  },
): { readonly draft: DraftDocument; readonly benchmarkSha256: string } {
  const built = buildTerminalBench21Tasks(input);
  putSealedBytes(context.workspaceDir, built.profile.bytes);
  for (const task of built.tasks) {
    putSealedBytes(context.workspaceDir, task.bytes);
  }
  const stored = putSealedBytes(context.workspaceDir, built.benchmark.bytes);
  if (stored !== built.benchmark.sha256) {
    refuse(
      "record-integrity",
      "terminal-bench-2.1.benchmark",
      "official Terminal-Bench 2.1 Benchmark bytes changed while storing",
    );
  }
  return {
    draft: attachBenchmarkToDraft(context.workspaceDir, draftId, built.benchmark.sha256, context.clock()),
    benchmarkSha256: built.benchmark.sha256,
  };
}

function bindNamedSuiteIdentity(
  context: OperationContext,
  draftId: string,
  documentKind: MethodDocumentKind,
  official: boolean,
): SelectMethodResult {
  const current = readDraftDocument(context.workspaceDir, draftId);
  if (!isDraftMutable(current.state)) {
    refuse("illegal-transition", `drafts.${draftId}.state`, "locked drafts refuse method bind");
  }
  return finish({ draft: current }, documentKind, official);
}

function bindOfficialTerminalBench21(
  context: OperationContext,
  draftId: string,
  input: {
    readonly coverage?: Exclude<SuiteCoverage, "custom">;
    readonly taskNames?: readonly string[];
  },
): SelectMethodResult {
  return finish(attachOfficialTerminalBench21Slate(context, draftId, input), "terminal-bench-2.1", true);
}

async function bindFile(
  context: OperationContext,
  draftId: string,
  resolved: Extract<ResolvedMethod, { kind: "file" }>,
): Promise<SelectMethodResult> {
  const document = resolved.document;
  switch (resolved.documentKind) {
    case "inspect":
      return finish(
        await executeSelectInspectEvaluation(context, { draftId, ...document } as { draftId: string } & InspectRuntimeSelectionRequest),
        "inspect",
        resolved.official,
      );
    case "inspect-binary-judge":
      return finish(
        executeBindInspectBinaryJudge(context, {
          draftId,
          binding: { schema: INSPECT_BINARY_JUDGE_BINDING_REQUEST_SCHEMA, ...document } as InspectBinaryJudgeBindingRequest,
        }),
        "inspect-binary-judge",
        resolved.official,
      );
    case "harbor":
      return finish(
        await executeSelectHarborRuntime(context, { draftId, ...document } as { draftId: string } & HarborRuntimeSelectionRequest),
        "harbor",
        resolved.official,
      );
    case "terminal-bench-2.1":
      return bindOfficialTerminalBench21(context, draftId, slateInputFromTerminalBench21File(document));
    default:
      return bindNamedSuiteIdentity(context, draftId, resolved.documentKind, resolved.official);
  }
}

function bindCatalog(
  context: OperationContext,
  draftId: string,
  resolved: Extract<ResolvedMethod, { kind: "catalog" }>,
): SelectMethodResult {
  if (resolved.catalogId === "terminal-bench-2.1") {
    const coverage = namedCoverage(resolved.coverage);
    const ids = resolved.selectedIds;
    return bindOfficialTerminalBench21(context, draftId, {
      ...(coverage === undefined ? {} : { coverage }),
      ...(ids === undefined ? {} : { taskNames: ids }),
    });
  }
  return bindNamedSuiteIdentity(context, draftId, resolved.catalogId, true);
}

async function bindResolved(
  context: OperationContext,
  draftId: string,
  resolved: ResolvedMethod,
): Promise<SelectMethodResult> {
  return resolved.kind === "file"
    ? bindFile(context, draftId, resolved)
    : bindCatalog(context, draftId, resolved);
}

export function selectMethod(context: OperationContext, input: SelectMethodInput): Promise<OperationResult<SelectMethodResult>> {
  const at = context.clock();
  const clocked = { ...context, clock: () => at };
  return operateAsync({
    context: clocked,
    action: "method.bind",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const resolved = resolveMethodOperand(input);
      return bindResolved(clocked, input.draftId, resolved);
    },
  });
}

export function exportDerivedBundle(
  context: OperationContext,
  input: ExportDerivedBundleInput,
): OperationResult<ExportDerivedBundleResult> {
  return operate({
    context,
    action: "method.export",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      const adapterId = document.spec.evaluationRuntime?.adapterId;
      if (adapterId === HARBOR_ADAPTER_ID) {
        return { shape: "harbor-hub" as const, ...executeExportHarborHubPackage(context, input) };
      }
      if (adapterId === SWE_BENCH_HARNESS_ADAPTER_ID) {
        return { shape: "swebench-predictions" as const, ...executeExportSwebenchPredictions(context, input) };
      }
      if (adapterId === ARCHIPELAGO_ADAPTER_ID) {
        return { shape: "apex-inspection" as const, ...executeExportApexAgentsInspection(context, input) };
      }
      if (adapterId === APEX_SWE_DEV_ADAPTER_ID) {
        return { shape: "apex-swe-package" as const, ...executeExportApexSwePackage(context, input) };
      }
      if (adapterId === INSPECT_ADAPTER_ID) {
        refuse("conflict", `drafts.${input.draftId}.evaluationRuntime`, "Inspect methods have no suite-named derived bundle");
      }
      if (adapterId === INSPECT_BINARY_JUDGE_ADAPTER_ID) {
        return { shape: "inspect-view" as const, ...executeExportInspectViewBundle(context, input) };
      }
      refuse("conflict", `drafts.${input.draftId}.evaluationRuntime`, "derived export has no suite-named bundle for this method");
    },
  });
}
