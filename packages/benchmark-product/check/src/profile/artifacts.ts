import { evaluateVerdictRule } from "@jinn-network/task-execution-profiles";
import { z } from "zod";
import { isInspectMultiScorerSelection, type InspectSelectionManifest } from "./inspect-manifest.js";

export const INSPECT_TASK_PROFILE_URI = "https://product.jinn.network/profiles/inspect-evaluation/1";
export const INSPECT_EMBEDDED_EVALUATOR_ID = "urn:jinn:benchmark-product:inspect-runtime:same-execution-scorer";

const InspectProviderEvidenceSchema = z.object({
  surface: z.literal("openai-responses"),
  resolvedModel: z.string().nullable(),
  callCount: z.number().int().nonnegative(),
  usage: z.record(z.string(), z.unknown()).nullable(),
  terminalStatus: z.enum([
    "completed",
    "authentication-failure",
    "rate-limited",
    "timeout",
    "broker-loss",
    "provider-5xx",
    "provider-failure",
    "budget-rejected",
    "method-conflict",
    "capability-rejected",
    "malformed-request",
    "no-call",
  ]),
  eventDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  brokerProtocol: z.literal("jinn.network/model-broker/1"),
  brokerSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const InspectCellSummaryV1Schema = z.object({
  schema: z.literal("jinn.network/benchmark-product/inspect-cell-summary/1"),
  terminal: z.enum(["scored", "unscorable"]),
  inspectStatus: z.enum(["started", "success", "cancelled", "error"]),
  expectedSamples: z.number().int().nonnegative().nullable(),
  observedSamples: z.number().int().nonnegative(),
  erroredSamples: z.number().int().nonnegative(),
  missingScoreSamples: z.number().int().nonnegative(),
  invalidated: z.boolean(),
  scorer: z.string().min(1),
  verdict: z.enum(["pass", "fail"]).nullable(),
  measurement: z.boolean().nullable(),
  evaluatedAt: z.string().datetime({ offset: true }),
  nativeLogSha256: z.string().regex(/^[a-f0-9]{64}$/),
  nativeLogBytes: z.number().int().nonnegative(),
  provider: InspectProviderEvidenceSchema.optional(),
});

export const InspectCellSummaryV2Schema = z.object({
  schema: z.literal("jinn.network/benchmark-product/inspect-cell-summary/2"),
  terminal: z.enum(["scored", "unscorable"]),
  inspectStatus: z.enum(["started", "success", "cancelled", "error"]),
  expectedSamples: z.number().int().nonnegative().nullable(),
  observedSamples: z.number().int().nonnegative(),
  erroredSamples: z.number().int().nonnegative(),
  invalidated: z.boolean(),
  scorers: z.array(z.object({
    name: z.string().min(1),
    presentSamples: z.number().int().nonnegative(),
    missingSamples: z.number().int().nonnegative(),
    valueShapes: z.array(z.enum(["null", "boolean", "number", "string", "list", "object"])),
  }).strict()).min(1),
  measurements: z.array(z.object({
    measurementName: z.string().min(1),
    scorerName: z.string().min(1),
    subScoreKey: z.string().min(1).optional(),
    missingSamples: z.number().int().nonnegative(),
    invalidValueSamples: z.number().int().nonnegative(),
    value: z.boolean().nullable(),
  }).strict()).min(1),
  verdict: z.enum(["pass", "fail", "inconclusive"]).nullable(),
  evaluatedAt: z.string().datetime({ offset: true }),
  nativeLogSha256: z.string().regex(/^[a-f0-9]{64}$/),
  nativeLogBytes: z.number().int().nonnegative(),
  provider: InspectProviderEvidenceSchema.optional(),
  sandbox: z.object({
    provider: z.literal("jinn-oci"),
    protocol: z.literal("jinn.network/inspect-sandbox-host/1"),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    environmentCount: z.number().int().nonnegative(),
    operationCount: z.number().int().nonnegative(),
    eventDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
}).strict();

export const InspectCellSummarySchema = z.union([InspectCellSummaryV1Schema, InspectCellSummaryV2Schema]);
export type InspectCellSummary = z.infer<typeof InspectCellSummarySchema>;
export type InspectCellSummaryV2 = z.infer<typeof InspectCellSummaryV2Schema>;

const SCORE_SHAPE_ORDER = ["null", "boolean", "number", "string", "list", "object"] as const;

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
/** Validate the product projection and return the only verdict authorized by its sealed rule. */
export function projectInspectCellVerdict(
  summary: InspectCellSummaryV2,
  manifest: InspectSelectionManifest,
): "pass" | "fail" | "inconclusive" | null {
  if (!isInspectMultiScorerSelection(manifest)) {
    throw new TypeError("Inspect summary v2 requires a multi-scorer selection manifest");
  }
  const scorerNames = summary.scorers.map((scorer) => scorer.name);
  if (!equalStrings(scorerNames, manifest.scorers.map((scorer) => scorer.name))) {
    throw new TypeError("Inspect scorer inventory differs from the sealed ordered scorer set");
  }
  for (const scorer of summary.scorers) {
    if (scorer.presentSamples + scorer.missingSamples !== summary.observedSamples) {
      throw new TypeError("Inspect scorer inventory does not account for every observed sample");
    }
    const canonicalShapes = SCORE_SHAPE_ORDER.filter((shape) => scorer.valueShapes.includes(shape));
    if (!equalStrings(scorer.valueShapes, canonicalShapes)) {
      throw new TypeError("Inspect scorer value shapes are duplicated or non-canonical");
    }
  }
  if (summary.measurements.length !== manifest.scoring.projections.length) {
    throw new TypeError("Inspect summary measurement count differs from the sealed projections");
  }
  const values: Record<string, boolean> = {};
  summary.measurements.forEach((measurement, index) => {
    const projection = manifest.scoring.projections[index]!;
    if (
      measurement.measurementName !== projection.measurementName
      || measurement.scorerName !== projection.scorerName
      || measurement.subScoreKey !== projection.subScoreKey
      || measurement.missingSamples + measurement.invalidValueSamples > summary.observedSamples
    ) {
      throw new TypeError("Inspect summary measurement differs from its sealed projection");
    }
    if (summary.terminal === "scored") {
      if (
        measurement.value === null
        || measurement.missingSamples !== 0
        || measurement.invalidValueSamples !== 0
      ) {
        throw new TypeError("scored Inspect summary carries an incomplete projected measurement");
      }
      values[measurement.measurementName] = measurement.value;
    } else if (measurement.value !== null) {
      throw new TypeError("unscorable Inspect summary carries a projected measurement value");
    }
  });
  if (summary.terminal === "unscorable") return null;
  if (
    summary.inspectStatus !== "success"
    || summary.invalidated
    || summary.erroredSamples !== 0
    || summary.expectedSamples === null
    || summary.expectedSamples !== summary.observedSamples
  ) {
    throw new TypeError("scored Inspect summary contradicts its run/sample accounting");
  }
  return evaluateVerdictRule(manifest.scoring.verdictRule, values).verdict;
}
