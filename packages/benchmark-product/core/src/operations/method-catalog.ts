/** Catalog presets and fail-loud method-operand resolution (DR-2026-08-18-f). */
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { refuse } from "../errors.js";
import { HARBOR_SELECTION_SCHEMA } from "../runtime/harbor/manifest.js";
import {
  INSPECT_MULTI_SCORER_SANDBOX_SELECTION_SCHEMA,
  INSPECT_MULTI_SCORER_SELECTION_SCHEMA,
  INSPECT_SANDBOX_SELECTION_SCHEMA,
  INSPECT_SELECTION_SCHEMA,
} from "../runtime/inspect/manifest.js";
import { APEX_AGENTS_SELECTION_SCHEMA } from "../runtime/apex-agents/manifest.js";
import { APEX_SWE_DEV_SELECTION_SCHEMA } from "../runtime/apex-swe-dev/manifest.js";
import { SWE_BENCH_VERIFIED_SELECTION_SCHEMA } from "../runtime/swe-bench-verified/manifest.js";
import { TERMINAL_BENCH_2_SELECTION_SCHEMA } from "../runtime/terminal-bench-2/manifest.js";
import { TERMINAL_BENCH_2_1_SELECTION_SCHEMA } from "../runtime/terminal-bench-2-1/manifest.js";
import { TERMINAL_BENCH_3_0_SELECTION_SCHEMA } from "../runtime/terminal-bench-3-0/manifest.js";
import type { SuiteCoverage, SuiteProtocolId } from "../runtime/suite-protocol/comparability.js";

export {
  APEX_AGENTS_SELECTION_SCHEMA,
  APEX_SWE_DEV_SELECTION_SCHEMA,
  HARBOR_SELECTION_SCHEMA,
  INSPECT_SELECTION_SCHEMA,
  SWE_BENCH_VERIFIED_SELECTION_SCHEMA,
  TERMINAL_BENCH_2_SELECTION_SCHEMA,
  TERMINAL_BENCH_2_1_SELECTION_SCHEMA,
  TERMINAL_BENCH_3_0_SELECTION_SCHEMA,
};

export type HumanSlice = "1" | "10" | "all";
export type MethodCatalogId = keyof typeof METHOD_CATALOG;
export type MethodDerivedExport = "harbor-hub" | "swebench-predictions" | "apex-inspection" | "apex-swe-package";
export type MethodFramework = "harbor" | "inspect" | "swebench-harness" | "archipelago" | "apex-swe-dev";
export type MethodDocumentKind =
  | "inspect"
  | "harbor"
  | "terminal-bench-2"
  | "terminal-bench-2.1"
  | "terminal-bench-3.0"
  | "swe-bench-verified"
  | "apex-agents"
  | "apex-swe-dev";

export interface MethodCatalogRow {
  readonly protocol: SuiteProtocolId;
  readonly framework: MethodFramework;
  readonly derivedExport: MethodDerivedExport;
}

export const METHOD_CATALOG = {
  "terminal-bench-2.1": {
    protocol: "terminal-bench-2.1",
    framework: "harbor",
    derivedExport: "harbor-hub",
  },
  "terminal-bench-3.0": {
    protocol: "terminal-bench-3.0",
    framework: "harbor",
    derivedExport: "harbor-hub",
  },
  "swe-bench-verified": {
    protocol: "swe-bench-verified",
    framework: "swebench-harness",
    derivedExport: "swebench-predictions",
  },
  "apex-agents": {
    protocol: "apex-agents",
    framework: "archipelago",
    derivedExport: "apex-inspection",
  },
  "apex-swe-dev": {
    protocol: "apex-swe-dev",
    framework: "apex-swe-dev",
    derivedExport: "apex-swe-package",
  },
} as const satisfies Record<string, MethodCatalogRow>;

const FILE_SCHEMA_KIND: Readonly<Record<string, { readonly documentKind: MethodDocumentKind; readonly official: boolean }>> = {
  [INSPECT_SELECTION_SCHEMA]: { documentKind: "inspect", official: false },
  [INSPECT_SANDBOX_SELECTION_SCHEMA]: { documentKind: "inspect", official: false },
  [INSPECT_MULTI_SCORER_SELECTION_SCHEMA]: { documentKind: "inspect", official: false },
  [INSPECT_MULTI_SCORER_SANDBOX_SELECTION_SCHEMA]: { documentKind: "inspect", official: false },
  [HARBOR_SELECTION_SCHEMA]: { documentKind: "harbor", official: false },
  [TERMINAL_BENCH_2_SELECTION_SCHEMA]: { documentKind: "terminal-bench-2", official: false },
  [TERMINAL_BENCH_2_1_SELECTION_SCHEMA]: { documentKind: "terminal-bench-2.1", official: true },
  [TERMINAL_BENCH_3_0_SELECTION_SCHEMA]: { documentKind: "terminal-bench-3.0", official: true },
  [SWE_BENCH_VERIFIED_SELECTION_SCHEMA]: { documentKind: "swe-bench-verified", official: true },
  [APEX_AGENTS_SELECTION_SCHEMA]: { documentKind: "apex-agents", official: true },
  [APEX_SWE_DEV_SELECTION_SCHEMA]: { documentKind: "apex-swe-dev", official: true },
};

export interface ResolveMethodOperandInput {
  readonly ref: string;
  readonly cwd: string;
  readonly slice?: string;
  readonly ids?: string;
  readonly hostPath?: string;
}

export type ResolvedMethod =
  | {
      readonly kind: "catalog";
      readonly catalogId: MethodCatalogId;
      readonly protocol: SuiteProtocolId;
      readonly coverage: SuiteCoverage;
      readonly selectedIds?: readonly string[];
      readonly host: Record<string, unknown>;
    }
  | {
      readonly kind: "file";
      readonly documentKind: MethodDocumentKind;
      readonly official: boolean;
      readonly document: Record<string, unknown>;
    };

export function isMethodCatalogId(value: string): value is MethodCatalogId {
  return Object.hasOwn(METHOD_CATALOG, value);
}

export function coverageFromSlice(slice: HumanSlice): Exclude<SuiteCoverage, "custom"> {
  if (slice === "1") return "one_task";
  if (slice === "10") return "ten_task";
  return "full";
}

function isExistingFile(cwd: string, ref: string): boolean {
  const path = isAbsolute(ref) ? ref : resolve(cwd, ref);
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function resolvePath(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function readJsonObject(path: string, issuePath: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    refuse("validation", issuePath, `cannot read ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse("validation", issuePath, `${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    refuse("validation", issuePath, "JSON must be an object");
  }
  return parsed as Record<string, unknown>;
}

function documentKindFrom(document: Record<string, unknown>): { readonly documentKind: MethodDocumentKind; readonly official: boolean } {
  const schema = document.schema;
  if (typeof schema === "string" && Object.hasOwn(FILE_SCHEMA_KIND, schema)) {
    return FILE_SCHEMA_KIND[schema]!;
  }
  if (typeof document.taskReference === "string" && document.taskReference.length > 0) {
    return { documentKind: "inspect", official: false };
  }
  refuse("invalid-invocation", "method.ref", "method document is not a known selection schema and not an Inspect-shaped file");
}

function parseHumanSlice(slice: string): HumanSlice {
  if (slice === "1" || slice === "10" || slice === "all") return slice;
  refuse("invalid-invocation", "--slice", "--slice must be 1, 10, or all");
}

function parseIds(ids: string): readonly string[] {
  const selected = ids.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (selected.length === 0) refuse("invalid-invocation", "--ids", "--ids must be a non-empty comma-separated list");
  return selected;
}

export function resolveMethodOperand(input: ResolveMethodOperandInput): ResolvedMethod {
  const catalog = isMethodCatalogId(input.ref);
  const file = isExistingFile(input.cwd, input.ref);
  if (catalog && file) {
    refuse("invalid-invocation", "method.ref", `"${input.ref}" is both a catalog id and a file`);
  }
  if (!catalog && !file) {
    refuse("invalid-invocation", "method.ref", `"${input.ref}" is not a suite and not a file`);
  }
  if (file) {
    if (input.slice !== undefined) refuse("invalid-invocation", "--slice", "--slice is only valid with a catalog id");
    if (input.ids !== undefined) refuse("invalid-invocation", "--ids", "--ids is only valid with a catalog id");
    if (input.hostPath !== undefined) refuse("invalid-invocation", "--host", "--host is only valid with a catalog id");
    const path = resolvePath(input.cwd, input.ref);
    const raw = readJsonObject(path, "method.ref");
    const { documentKind, official } = documentKindFrom(raw);
    const { schema: _schema, ...document } = raw;
    return { kind: "file", documentKind, official, document };
  }
  const catalogId = input.ref;
  if (!isMethodCatalogId(catalogId)) {
    refuse("invalid-invocation", "method.ref", `"${input.ref}" is not a suite and not a file`);
  }
  if (input.hostPath === undefined || input.hostPath === "") {
    refuse("invalid-invocation", "--host", "--host is required for a catalog id");
  }
  if (input.slice !== undefined && input.ids !== undefined) {
    refuse("invalid-invocation", "--ids", "pass --slice or --ids, not both");
  }
  if (input.slice === undefined && input.ids === undefined) {
    refuse("invalid-invocation", "--slice", "--slice or --ids is required for a catalog id");
  }
  const row = METHOD_CATALOG[catalogId];
  const host = readJsonObject(resolvePath(input.cwd, input.hostPath), "--host");
  if (input.ids !== undefined) {
    return {
      kind: "catalog",
      catalogId,
      protocol: row.protocol,
      coverage: "custom",
      selectedIds: parseIds(input.ids),
      host,
    };
  }
  return {
    kind: "catalog",
    catalogId,
    protocol: row.protocol,
    coverage: coverageFromSlice(parseHumanSlice(input.slice!)),
    host,
  };
}
