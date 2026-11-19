// SPDX-License-Identifier: Apache-2.0

/**
 * The suite-protocol selection object: the sealed statement of which official suite a run is
 * bound to, which of its tasks were selected, and how many replicates the protocol asks for.
 *
 * Terminal-Bench 2.1, Terminal-Bench 3.0 and DeepSWE v1.1 nest it in their Harbor or Pier
 * selection manifest as a profile; SWE-bench Verified, APEX-Agents, APEX-SWE-dev and Inspect eval
 * nest it in their own selection manifest. The schemas live in the checker because a bundle that
 * declares `suite-comparability` carries the object, and the checker parses the exact bytes the
 * Run registered. The product core re-exports them from `runtime/suite-protocol/manifest.ts`, so
 * every producer and the checker read one grammar.
 */

import { z } from "zod";
import { SUITE_COVERAGE } from "./suite-coverage.js";

export const SUITE_PROTOCOL_PROFILE = "https://product.jinn.network/profiles/suite-protocol-selection/v1" as const;
export const SUITE_PROTOCOL_SELECTION_ROLE = "https://product.jinn.network/artifact-roles/suite-protocol/selection/v1" as const;
export const SUITE_PROTOCOL_SELECTION_SCHEMA = "jinn.network/benchmark-product/suite-protocol-selection/1" as const;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const GitSha = z.string().regex(/^[a-f0-9]{40}$/u);
const SelectedTaskNames = z.array(z.string().min(1).regex(/^[^/]+$/u)).min(1);

const SuiteItemSchema = z.object({
  taskName: z.string().min(1),
  taskSha256: Sha256,
}).strict();

const SuiteItems = z.array(SuiteItemSchema).min(1);

const ApexSweDevSuiteItemSchema = z.object({
  taskName: z.string().min(1),
  taskSha256: Sha256,
  taskType: z.enum(["integration", "observability"]),
}).strict();


function refineSuiteItems(
  value: { readonly items: readonly { readonly taskName: string }[]; readonly selectedTaskNames: readonly string[] },
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

const SuiteProtocolSelectionShared = {
  schema: z.literal(SUITE_PROTOCOL_SELECTION_SCHEMA),
  coverage: z.enum(SUITE_COVERAGE),
  datasetId: z.string().min(1),
  selectedTaskNames: SelectedTaskNames,
  datasetTaskCount: z.number().int().positive(),
  items: SuiteItems,
};

export const TerminalBench21SuiteProtocolSelectionSchema = z.object({
  ...SuiteProtocolSelectionShared,
  protocol: z.literal("terminal-bench-2.1"),
  datasetId: z.literal("terminal-bench/terminal-bench-2-1"),
  datasetRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  replicates: z.literal(5),
  atifRequired: z.literal(true),
}).strict().superRefine(refineSuiteItems);

export const TerminalBench30SuiteProtocolSelectionSchema = z.object({
  ...SuiteProtocolSelectionShared,
  protocol: z.literal("terminal-bench-3.0"),
  datasetId: z.literal("terminal-bench/terminal-bench"),
  datasetRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  replicates: z.literal(5),
  atifRequired: z.literal(true),
}).strict().superRefine(refineSuiteItems);

export const SwebenchVerifiedSuiteProtocolSelectionSchema = z.object({
  ...SuiteProtocolSelectionShared,
  protocol: z.literal("swe-bench-verified"),
  datasetRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  replicates: z.literal(1),
  atifRequired: z.literal(false),
}).strict().superRefine(refineSuiteItems);

export const ApexAgentsSuiteProtocolSelectionSchema = z.object({
  ...SuiteProtocolSelectionShared,
  protocol: z.literal("apex-agents"),
  datasetRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  replicates: z.literal(1),
  atifRequired: z.literal(false),
}).strict().superRefine(refineSuiteItems);

export const ApexSweDevSuiteProtocolSelectionSchema = z.object({
  ...SuiteProtocolSelectionShared,
  protocol: z.literal("apex-swe-dev"),
  datasetRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  replicates: z.literal(1),
  atifRequired: z.literal(false),
  items: z.array(ApexSweDevSuiteItemSchema).min(1),
}).strict().superRefine(refineSuiteItems);

export const DeepSweV11SuiteProtocolSelectionSchema = z.object({
  ...SuiteProtocolSelectionShared,
  protocol: z.literal("deep-swe-v1.1"),
  datasetRevision: GitSha,
  tasksTreeSha: GitSha,
  replicates: z.number().int().min(4),
  atifRequired: z.literal(true),
}).strict().superRefine(refineSuiteItems);

// Inspect sample ids are not Terminal-Bench task directory names, so this member keeps the
// shared shape but relaxes the `/`-free name constraint the Harbor-family protocols impose.
export const InspectEvalSuiteProtocolSelectionSchema = z.object({
  ...SuiteProtocolSelectionShared,
  protocol: z.literal("inspect-eval"),
  datasetRevision: Sha256,
  selectedTaskNames: z.array(z.string().min(1)).min(1),
  replicates: z.number().int().positive(),
  atifRequired: z.literal(false),
}).strict().superRefine(refineSuiteItems);

export const SuiteProtocolSelectionSchema = z.discriminatedUnion("protocol", [
  TerminalBench21SuiteProtocolSelectionSchema,
  TerminalBench30SuiteProtocolSelectionSchema,
  SwebenchVerifiedSuiteProtocolSelectionSchema,
  ApexAgentsSuiteProtocolSelectionSchema,
  ApexSweDevSuiteProtocolSelectionSchema,
  DeepSweV11SuiteProtocolSelectionSchema,
  InspectEvalSuiteProtocolSelectionSchema,
]);
export type SuiteProtocolSelection = z.infer<typeof SuiteProtocolSelectionSchema>;
export type TerminalBench21SuiteProtocolSelection = z.infer<typeof TerminalBench21SuiteProtocolSelectionSchema>;
export type TerminalBench30SuiteProtocolSelection = z.infer<typeof TerminalBench30SuiteProtocolSelectionSchema>;
export type SwebenchVerifiedSuiteProtocolSelection = z.infer<typeof SwebenchVerifiedSuiteProtocolSelectionSchema>;
export type ApexAgentsSuiteProtocolSelection = z.infer<typeof ApexAgentsSuiteProtocolSelectionSchema>;
export type ApexSweDevSuiteProtocolSelection = z.infer<typeof ApexSweDevSuiteProtocolSelectionSchema>;
export type DeepSweV11SuiteProtocolSelection = z.infer<typeof DeepSweV11SuiteProtocolSelectionSchema>;
export type InspectEvalSuiteProtocolSelection = z.infer<typeof InspectEvalSuiteProtocolSelectionSchema>;
