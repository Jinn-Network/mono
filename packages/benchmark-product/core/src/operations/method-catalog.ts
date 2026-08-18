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
import { APEX_AGENTS_SELECTION_SCHEMA, ApexAgentsRegistryMetadataSchema } from "../runtime/apex-agents/manifest.js";
import { APEX_SWE_DEV_SELECTION_SCHEMA, ApexSweDevRegistryMetadataSchema } from "../runtime/apex-swe-dev/manifest.js";
import { SWE_BENCH_VERIFIED_SELECTION_SCHEMA, SwebenchVerifiedRegistryMetadataSchema } from "../runtime/swe-bench-verified/manifest.js";
import { TERMINAL_BENCH_2_SELECTION_SCHEMA } from "../runtime/terminal-bench-2/manifest.js";
import { TERMINAL_BENCH_2_1_SELECTION_SCHEMA, TerminalBench21RegistryMetadataSchema } from "../runtime/terminal-bench-2-1/manifest.js";
import { TERMINAL_BENCH_3_0_SELECTION_SCHEMA, TerminalBench30RegistryMetadataSchema } from "../runtime/terminal-bench-3-0/manifest.js";
import type { SuiteCoverage, SuiteProtocolId } from "../runtime/suite-protocol/comparability.js";
import { coverageFromSelectedNames, namedSliceTaskNames } from "../runtime/suite-protocol/manifest.js";

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
  readonly hostKeys: readonly string[];
}

export const METHOD_CATALOG = {
  "terminal-bench-2.1": {
    protocol: "terminal-bench-2.1",
    framework: "harbor",
    derivedExport: "harbor-hub",
    hostKeys: ["executable", "registryMetadataPath", "datasetRevision", "taskMaterialPath", "arms", "environment", "outputs"],
  },
  "terminal-bench-3.0": {
    protocol: "terminal-bench-3.0",
    framework: "harbor",
    derivedExport: "harbor-hub",
    hostKeys: ["executable", "registryMetadataPath", "datasetRevision", "taskMaterialPath", "arms", "environment", "outputs"],
  },
  "swe-bench-verified": {
    protocol: "swe-bench-verified",
    framework: "swebench-harness",
    derivedExport: "swebench-predictions",
    hostKeys: ["executable", "registryMetadataPath", "arms"],
  },
  "apex-agents": {
    protocol: "apex-agents",
    framework: "archipelago",
    derivedExport: "apex-inspection",
    hostKeys: ["executable", "registryMetadataPath", "arms"],
  },
  "apex-swe-dev": {
    protocol: "apex-swe-dev",
    framework: "apex-swe-dev",
    derivedExport: "apex-swe-package",
    hostKeys: ["apxExecutable", "pythonExecutable", "registryMetadataPath", "integrationTasksDir", "observabilityProjectDir", "arms"],
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
  readonly n?: string;
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

export function listMethodCatalog(): ReadonlyArray<{ id: MethodCatalogId } & MethodCatalogRow> {
  return (Object.keys(METHOD_CATALOG) as MethodCatalogId[]).map((id) => ({ id, ...METHOD_CATALOG[id] }));
}

export function knownCatalogIds(): string {
  return (Object.keys(METHOD_CATALOG) as MethodCatalogId[]).join(", ");
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

function parseN(n: string): number {
  if (!/^[1-9][0-9]*$/u.test(n)) refuse("invalid-invocation", "--n", "--n must be a positive integer");
  return Number.parseInt(n, 10);
}

function unknownMethodRef(ref: string): never {
  refuse("invalid-invocation", "method.ref", `"${ref}" is not a suite and not a file; known catalog ids: ${knownCatalogIds()}`);
}

function registryIds(catalogId: MethodCatalogId, metadata: Record<string, unknown>): readonly string[] {
  try {
    switch (catalogId) {
      case "terminal-bench-2.1":
        return TerminalBench21RegistryMetadataSchema.parse(metadata).task_ids.map((task) => task.name);
      case "terminal-bench-3.0":
        return TerminalBench30RegistryMetadataSchema.parse(metadata).task_ids.map((task) => task.name);
      case "swe-bench-verified":
        return SwebenchVerifiedRegistryMetadataSchema.parse(metadata).instance_ids;
      case "apex-agents":
        return ApexAgentsRegistryMetadataSchema.parse(metadata).task_ids;
      case "apex-swe-dev":
        return ApexSweDevRegistryMetadataSchema.parse(metadata).tasks.map((task) => task.taskId);
    }
  } catch {
    refuse("validation", "--host", "host.registryMetadataPath is not valid registry metadata for this suite");
  }
}

function selectedFromRegistry(
  catalogId: MethodCatalogId,
  host: Record<string, unknown>,
  cwd: string,
  n: number,
): { readonly coverage: SuiteCoverage; readonly selectedIds: readonly string[] } {
  const registryMetadataPath = host.registryMetadataPath;
  if (typeof registryMetadataPath !== "string" || registryMetadataPath.length === 0) {
    refuse("invalid-invocation", "--host", "host.registryMetadataPath must be a string path");
  }
  const inventory = registryIds(catalogId, readJsonObject(resolvePath(cwd, registryMetadataPath), "--host"));
  if (n > inventory.length) {
    refuse("invalid-invocation", "--n", `--n ${n} is larger than the registry inventory (${inventory.length})`);
  }
  const selectedIds = namedSliceTaskNames(inventory, "full").slice(0, n);
  return { coverage: coverageFromSelectedNames(inventory, selectedIds), selectedIds };
}

export function resolveMethodOperand(input: ResolveMethodOperandInput): ResolvedMethod {
  const catalog = isMethodCatalogId(input.ref);
  const file = isExistingFile(input.cwd, input.ref);
  if (catalog && file) {
    refuse("invalid-invocation", "method.ref", `"${input.ref}" is both a catalog id and a file`);
  }
  if (!catalog && !file) unknownMethodRef(input.ref);
  if (file) {
    if (input.slice !== undefined) refuse("invalid-invocation", "--slice", "--slice is only valid with a catalog id");
    if (input.ids !== undefined) refuse("invalid-invocation", "--ids", "--ids is only valid with a catalog id");
    if (input.n !== undefined) refuse("invalid-invocation", "--n", "--n is only valid with a catalog id");
    if (input.hostPath !== undefined) refuse("invalid-invocation", "--host", "--host is only valid with a catalog id");
    const path = resolvePath(input.cwd, input.ref);
    const raw = readJsonObject(path, "method.ref");
    const { documentKind, official } = documentKindFrom(raw);
    const { schema: _schema, ...document } = raw;
    return { kind: "file", documentKind, official, document };
  }
  const catalogId = input.ref;
  if (!isMethodCatalogId(catalogId)) unknownMethodRef(input.ref);
  if (input.hostPath === undefined || input.hostPath === "") {
    refuse("invalid-invocation", "--host", "--host is required for a catalog id");
  }
  if (input.n !== undefined && (input.slice !== undefined || input.ids !== undefined)) {
    refuse("invalid-invocation", "--n", "pass --slice, --ids, or --n, not more than one");
  }
  if (input.slice !== undefined && input.ids !== undefined) {
    refuse("invalid-invocation", "--ids", "pass --slice or --ids, not both");
  }
  if (input.slice === undefined && input.ids === undefined && input.n === undefined) {
    refuse("invalid-invocation", "--slice", "--slice, --ids, or --n is required for a catalog id");
  }
  const n = input.n === undefined ? undefined : parseN(input.n);
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
  if (input.slice !== undefined) {
    return {
      kind: "catalog",
      catalogId,
      protocol: row.protocol,
      coverage: coverageFromSlice(parseHumanSlice(input.slice)),
      host,
    };
  }
  if (n === undefined) {
    refuse("invalid-invocation", "--slice", "--slice, --ids, or --n is required for a catalog id");
  }
  const sliced = selectedFromRegistry(catalogId, host, input.cwd, n);
  if (sliced.coverage === "custom") {
    return {
      kind: "catalog",
      catalogId,
      protocol: row.protocol,
      coverage: "custom",
      selectedIds: sliced.selectedIds,
      host,
    };
  }
  return {
    kind: "catalog",
    catalogId,
    protocol: row.protocol,
    coverage: sliced.coverage,
    host,
  };
}
