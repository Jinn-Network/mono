/** Product-owned suite protocol selection bound via Harbor/Pier profiles + registration artifacts. */
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { z } from "zod";
import { sha256Hex } from "../../workspace/sealed-store.js";
import { SUITE_COVERAGE, type SuiteCoverage } from "./comparability.js";

export type { SuiteCoverage };

export const SUITE_PROTOCOL_PROFILE = "https://product.jinn.network/profiles/suite-protocol-selection/v1" as const;
export const SUITE_PROTOCOL_SELECTION_ROLE = "https://product.jinn.network/artifact-roles/suite-protocol/selection/v1" as const;
export const SUITE_PROTOCOL_SELECTION_SCHEMA = "jinn.network/benchmark-product/suite-protocol-selection/1" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const GitSha = z.string().regex(/^[a-f0-9]{40}$/u);
const SelectedTaskNames = z.array(z.string().min(1).regex(/^[^/]+$/u)).min(1);
const SuiteItems = z.array(z.object({
  taskName: z.string().min(1),
  taskSha256: Sha256,
}).strict()).min(1);

function refineSuiteItems(
  value: { readonly selectedTaskNames: readonly string[]; readonly items: readonly { readonly taskName: string }[] },
  context: z.RefinementCtx,
): void {
  if (value.items.length !== value.selectedTaskNames.length) {
    context.addIssue({ code: "custom", message: "suite items must match selected task names", path: ["items"] });
  }
  const names = value.items.map((item) => item.taskName);
  if (names.join("\0") !== value.selectedTaskNames.join("\0")) {
    context.addIssue({ code: "custom", message: "suite item names must equal selectedTaskNames in order", path: ["items"] });
  }
}

const TerminalBench21SuiteSelectionSchema = z.object({
  schema: z.literal(SUITE_PROTOCOL_SELECTION_SCHEMA),
  protocol: z.literal("terminal-bench-2.1"),
  coverage: z.enum(SUITE_COVERAGE),
  datasetId: z.string().min(1),
  datasetRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  selectedTaskNames: SelectedTaskNames,
  datasetTaskCount: z.number().int().positive(),
  replicates: z.literal(5),
  atifRequired: z.literal(true),
  items: SuiteItems,
}).strict().superRefine(refineSuiteItems);

const DeepSweV11SuiteSelectionSchema = z.object({
  schema: z.literal(SUITE_PROTOCOL_SELECTION_SCHEMA),
  protocol: z.literal("deep-swe-v1.1"),
  coverage: z.enum(SUITE_COVERAGE),
  datasetId: z.string().min(1),
  datasetRevision: GitSha,
  tasksTreeSha: GitSha,
  selectedTaskNames: SelectedTaskNames,
  datasetTaskCount: z.number().int().positive(),
  replicates: z.number().int().min(4),
  atifRequired: z.literal(true),
  items: SuiteItems,
}).strict().superRefine(refineSuiteItems);

export const SuiteProtocolSelectionSchema = z.discriminatedUnion("protocol", [
  TerminalBench21SuiteSelectionSchema,
  DeepSweV11SuiteSelectionSchema,
]);
export type SuiteProtocolSelection = z.infer<typeof SuiteProtocolSelectionSchema>;

export function suiteProtocolSelectionBytes(value: SuiteProtocolSelection): Uint8Array {
  return canonicalJsonBytes(SuiteProtocolSelectionSchema.parse(value) as never);
}

export function suiteProtocolSelectionSha256(value: SuiteProtocolSelection): string {
  return sha256Hex(suiteProtocolSelectionBytes(value));
}

/** Lexicographic (Unicode code-point) first 1 / first 10 / all. Do not pick weekly. */
export function namedSliceTaskNames(taskNames: readonly string[], coverage: Exclude<SuiteCoverage, "custom">): string[] {
  const sorted = [...taskNames].sort(compareCodePoints);
  if (coverage === "one_task") return sorted.slice(0, 1);
  if (coverage === "ten_task") return sorted.slice(0, 10);
  return sorted;
}

export function coverageFromSelectedNames(datasetTaskNames: readonly string[], selected: readonly string[]): SuiteCoverage {
  const one = namedSliceTaskNames(datasetTaskNames, "one_task");
  const ten = namedSliceTaskNames(datasetTaskNames, "ten_task");
  const full = namedSliceTaskNames(datasetTaskNames, "full");
  if (sameNames(selected, one)) return "one_task";
  if (sameNames(selected, ten)) return "ten_task";
  if (sameNames(selected, full)) return "full";
  return "custom";
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}
