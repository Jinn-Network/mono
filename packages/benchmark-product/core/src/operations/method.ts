/** One method bind and one derived export (DR-2026-08-18-f). */
import type { DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { INSPECT_ADAPTER_ID } from "../runtime/inspect/manifest.js";
import { HARBOR_ADAPTER_ID } from "../runtime/harbor/manifest.js";
import { SWE_BENCH_HARNESS_ADAPTER_ID } from "../runtime/swe-bench-verified/manifest.js";
import { ARCHIPELAGO_ADAPTER_ID } from "../runtime/apex-agents/manifest.js";
import { APEX_SWE_DEV_ADAPTER_ID } from "../runtime/apex-swe-dev/manifest.js";
import type { HarborRuntimeSelectionRequest } from "../runtime/harbor/host.js";
import type { TerminalBench2SelectionRequest } from "../runtime/terminal-bench-2/host.js";
import type { TerminalBench21SelectionRequest } from "../runtime/terminal-bench-2-1/host.js";
import type { TerminalBench30SelectionRequest } from "../runtime/terminal-bench-3-0/host.js";
import type { SwebenchVerifiedSelectionRequest } from "../runtime/swe-bench-verified/host.js";
import type { ApexAgentsSelectionRequest } from "../runtime/apex-agents/host.js";
import type { ApexSweDevSelectionRequest } from "../runtime/apex-swe-dev/host.js";
import type { InspectRuntimeSelectionRequest } from "../runtime/host-port.js";
import type { SuiteCoverage } from "../runtime/suite-protocol/comparability.js";
import type { OperationContext } from "./context.js";
import { operate } from "./operate.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";
import { executeSelectInspectEvaluation } from "./inspect-runtime.js";
import { executeSelectHarborRuntime } from "./harbor-runtime.js";
import { executeSelectTerminalBench2Runtime } from "./terminal-bench-2.js";
import { executeSelectTerminalBench21Runtime } from "./terminal-bench-2-1.js";
import { executeSelectTerminalBench30Runtime } from "./terminal-bench-3-0.js";
import { executeSelectSwebenchVerifiedRuntime } from "./swe-bench-verified.js";
import { executeSelectApexAgentsRuntime } from "./apex-agents.js";
import { executeSelectApexSweDevRuntime } from "./apex-swe-dev.js";
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
  readonly selectionManifestSha256: string;
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
  | (ExportApexSwePackageResult & { readonly shape: "apex-swe-package" });

function namedCoverage(coverage: SuiteCoverage): Exclude<SuiteCoverage, "custom"> | undefined {
  return coverage === "custom" ? undefined : coverage;
}

function finish(
  inner: { readonly draft: DraftDocument; readonly selectionManifestSha256: string; readonly suiteProtocolSha256?: string },
  documentKind: MethodDocumentKind,
  official: boolean,
): SelectMethodResult {
  return {
    draft: inner.draft,
    selectionManifestSha256: inner.selectionManifestSha256,
    documentKind,
    official,
    ...(official && isMethodCatalogId(documentKind) ? { catalogId: documentKind } : {}),
    ...(inner.suiteProtocolSha256 === undefined ? {} : { suiteProtocolSha256: inner.suiteProtocolSha256 }),
  };
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
    case "harbor":
      return finish(
        await executeSelectHarborRuntime(context, { draftId, ...document } as { draftId: string } & HarborRuntimeSelectionRequest),
        "harbor",
        resolved.official,
      );
    case "terminal-bench-2":
      return finish(
        await executeSelectTerminalBench2Runtime(context, { draftId, ...document } as { draftId: string } & TerminalBench2SelectionRequest),
        "terminal-bench-2",
        resolved.official,
      );
    case "terminal-bench-2.1":
      return finish(
        await executeSelectTerminalBench21Runtime(context, { draftId, ...document } as { draftId: string } & TerminalBench21SelectionRequest),
        "terminal-bench-2.1",
        resolved.official,
      );
    case "terminal-bench-3.0":
      return finish(
        await executeSelectTerminalBench30Runtime(context, { draftId, ...document } as { draftId: string } & TerminalBench30SelectionRequest),
        "terminal-bench-3.0",
        resolved.official,
      );
    case "swe-bench-verified":
      return finish(
        await executeSelectSwebenchVerifiedRuntime(context, { draftId, ...document } as { draftId: string } & SwebenchVerifiedSelectionRequest),
        "swe-bench-verified",
        resolved.official,
      );
    case "apex-agents":
      return finish(
        await executeSelectApexAgentsRuntime(context, { draftId, ...document } as { draftId: string } & ApexAgentsSelectionRequest),
        "apex-agents",
        resolved.official,
      );
    case "apex-swe-dev":
      return finish(
        await executeSelectApexSweDevRuntime(context, { draftId, ...document } as { draftId: string } & ApexSweDevSelectionRequest),
        "apex-swe-dev",
        resolved.official,
      );
  }
}

async function bindCatalog(
  context: OperationContext,
  draftId: string,
  resolved: Extract<ResolvedMethod, { kind: "catalog" }>,
): Promise<SelectMethodResult> {
  const host = resolved.host;
  const coverage = namedCoverage(resolved.coverage);
  const ids = resolved.selectedIds;
  switch (resolved.catalogId) {
    case "terminal-bench-2.1":
      return finish(await executeSelectTerminalBench21Runtime(context, {
        draftId,
        ...host,
        ...(coverage === undefined ? {} : { coverage }),
        ...(ids === undefined ? {} : { taskNames: ids }),
      } as { draftId: string } & TerminalBench21SelectionRequest), "terminal-bench-2.1", true);
    case "terminal-bench-3.0":
      return finish(await executeSelectTerminalBench30Runtime(context, {
        draftId,
        ...host,
        ...(coverage === undefined ? {} : { coverage }),
        ...(ids === undefined ? {} : { taskNames: ids }),
      } as { draftId: string } & TerminalBench30SelectionRequest), "terminal-bench-3.0", true);
    case "swe-bench-verified":
      return finish(await executeSelectSwebenchVerifiedRuntime(context, {
        draftId,
        ...host,
        ...(coverage === undefined ? {} : { coverage }),
        ...(ids === undefined ? {} : { instanceIds: ids }),
      } as { draftId: string } & SwebenchVerifiedSelectionRequest), "swe-bench-verified", true);
    case "apex-agents":
      return finish(await executeSelectApexAgentsRuntime(context, {
        draftId,
        ...host,
        ...(coverage === undefined ? {} : { coverage }),
        ...(ids === undefined ? {} : { taskIds: ids }),
      } as { draftId: string } & ApexAgentsSelectionRequest), "apex-agents", true);
    case "apex-swe-dev":
      return finish(await executeSelectApexSweDevRuntime(context, {
        draftId,
        ...host,
        ...(coverage === undefined ? {} : { coverage }),
        ...(ids === undefined ? {} : { taskIds: ids }),
      } as { draftId: string } & ApexSweDevSelectionRequest), "apex-swe-dev", true);
  }
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
      refuse("conflict", `drafts.${input.draftId}.evaluationRuntime`, "derived export has no suite-named bundle for this method");
    },
  });
}
