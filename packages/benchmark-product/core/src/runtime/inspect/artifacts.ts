import { defineBenchmark } from "@jinn-network/benchmarking-interop";
import {
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  TASK_PROFILE_FORMAT_URI,
  evaluateVerdictRule,
  sealEvaluationSpec,
  sealTaskProfile,
  type EvaluationSpec,
  type TaskProfileDocument,
} from "@jinn-network/task-execution-profiles";
import { sealTask, TASK_EXECUTION_PROTOCOL_URI } from "@jinn-network/task-execution-protocol";
import { isInspectMultiScorerSelection, type InspectSelectionManifest } from "./manifest.js";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { sha256Hex } from "../../workspace/sealed-store.js";
import { z } from "zod";

export const INSPECT_TASK_PROFILE_URI = "https://product.jinn.network/profiles/inspect-evaluation/1";
export const INSPECT_NATIVE_LOG_MEDIA_TYPE = "application/vnd.inspect-ai.eval";
export const INSPECT_SUMMARY_MEDIA_TYPE = "application/vnd.jinn.inspect-summary+json";
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

const InspectLogObservationCommonSchema = z.object({
  schema: z.literal("jinn.network/benchmark-product/inspect-log-observation/1"),
  terminal: z.enum(["scored", "unscorable"]),
  inspectStatus: z.enum(["started", "success", "cancelled", "error"]),
  expectedSamples: z.number().int().nonnegative().nullable(),
  observedSamples: z.number().int().nonnegative(),
  erroredSamples: z.number().int().nonnegative(),
  invalidated: z.boolean(),
  nativeLogSha256: z.string().regex(/^[a-f0-9]{64}$/),
  nativeLogBytes: z.number().int().nonnegative(),
});

export const InspectLogObservationV1Schema = InspectLogObservationCommonSchema.extend({
  summarySchema: z.literal("jinn.network/benchmark-product/inspect-cell-summary/1"),
  missingScoreSamples: z.number().int().nonnegative(),
  scorer: z.string().min(1),
  measurement: z.boolean().nullable(),
}).strict();

export const InspectLogObservationV2Schema = InspectLogObservationCommonSchema.extend({
  summarySchema: z.literal("jinn.network/benchmark-product/inspect-cell-summary/2"),
  scorers: InspectCellSummaryV2Schema.shape.scorers,
  measurements: InspectCellSummaryV2Schema.shape.measurements,
}).strict();

export const InspectLogObservationSchema = z.discriminatedUnion("summarySchema", [
  InspectLogObservationV1Schema,
  InspectLogObservationV2Schema,
]);
export type InspectLogObservation = z.infer<typeof InspectLogObservationSchema>;

export interface InspectVerifiedProjection {
  readonly verdict: "pass" | "fail" | "inconclusive" | null;
  readonly measurements: readonly { readonly name: string; readonly value: boolean }[];
}

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

function comparableSummary(summary: InspectCellSummary): Record<string, unknown> {
  const common = {
    terminal: summary.terminal,
    inspectStatus: summary.inspectStatus,
    expectedSamples: summary.expectedSamples,
    observedSamples: summary.observedSamples,
    erroredSamples: summary.erroredSamples,
    invalidated: summary.invalidated,
    nativeLogSha256: summary.nativeLogSha256,
    nativeLogBytes: summary.nativeLogBytes,
  };
  return summary.schema === "jinn.network/benchmark-product/inspect-cell-summary/1"
    ? {
      summarySchema: summary.schema,
      ...common,
      missingScoreSamples: summary.missingScoreSamples,
      scorer: summary.scorer,
      measurement: summary.measurement,
    }
    : {
      summarySchema: summary.schema,
      ...common,
      scorers: summary.scorers,
      measurements: summary.measurements,
    };
}

/**
 * Cross-check an execution summary against observations independently read from the native log,
 * then return the only projection authorized by the sealed EvaluationSpec inputs.
 */
export function verifyInspectLogProjection(
  summary: InspectCellSummary,
  observation: InspectLogObservation,
  manifest: InspectSelectionManifest,
): InspectVerifiedProjection {
  if (summary.schema !== observation.summarySchema) {
    throw new TypeError("Inspect log observation and execution summary use different schemas");
  }
  const observedComparable = { ...observation } as Record<string, unknown>;
  delete observedComparable.schema;
  if (
    sha256Hex(canonicalJsonBytes(comparableSummary(summary) as never))
    !== sha256Hex(canonicalJsonBytes(observedComparable as never))
  ) {
    throw new TypeError("Inspect execution summary differs from the independently read native log");
  }
  if (observation.summarySchema === "jinn.network/benchmark-product/inspect-cell-summary/1") {
    if (isInspectMultiScorerSelection(manifest)) {
      throw new TypeError("legacy Inspect observation cannot verify a multi-scorer selection");
    }
    if (observation.terminal === "scored" && observation.measurement === null) {
      throw new TypeError("scored Inspect log observation carries no measurement");
    }
    const verdict = observation.terminal === "unscorable"
      ? null
      : evaluateVerdictRule(
        { threshold: { measurement: "inspect-score-pass", op: "eq", value: true } },
        { "inspect-score-pass": observation.measurement! },
      ).verdict;
    if (summary.verdict !== verdict) {
      throw new TypeError("Inspect execution summary verdict differs from the sealed projection");
    }
    return {
      verdict,
      measurements: observation.measurement === null
        ? []
        : [{ name: "inspect-score-pass", value: observation.measurement }],
    };
  }
  const projectedSummary: InspectCellSummaryV2 = {
    schema: "jinn.network/benchmark-product/inspect-cell-summary/2",
    terminal: observation.terminal,
    inspectStatus: observation.inspectStatus,
    expectedSamples: observation.expectedSamples,
    observedSamples: observation.observedSamples,
    erroredSamples: observation.erroredSamples,
    invalidated: observation.invalidated,
    scorers: observation.scorers,
    measurements: observation.measurements,
    verdict: summary.verdict,
    evaluatedAt: summary.evaluatedAt,
    nativeLogSha256: observation.nativeLogSha256,
    nativeLogBytes: observation.nativeLogBytes,
  };
  const verdict = projectInspectCellVerdict(projectedSummary, manifest);
  if (summary.verdict !== verdict) {
    throw new TypeError("Inspect execution summary verdict differs from the sealed projection");
  }
  return {
    verdict,
    measurements: observation.measurements.flatMap((measurement) => measurement.value === null
      ? []
      : [{ name: measurement.measurementName, value: measurement.value }]),
  };
}

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function buildInspectTaskProfile(): TaskProfileDocument {
  return {
    protocol: TASK_PROFILE_FORMAT_URI,
    profile: INSPECT_TASK_PROFILE_URI,
    description: "Runs one digest-pinned Inspect evaluation and retains its native EvalLog plus a bounded product projection.",
    payloadSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        selectionManifestSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["selectionManifestSha256"],
    },
    inputConventions: { slots: [] },
    outputConventions: {
      slots: [
        { name: "inspect-log", required: true, mediaType: INSPECT_NATIVE_LOG_MEDIA_TYPE },
        { name: "inspect-summary", required: true, mediaType: INSPECT_SUMMARY_MEDIA_TYPE },
        { name: "verdict", required: false, mediaType: "application/vnd.in-toto+json" },
      ],
    },
    evaluationFamilies: ["deterministic-process"],
    requirementKeys: [],
  };
}

function inspectEvaluationSpec(manifest: InspectSelectionManifest): EvaluationSpec {
  const manifestBytes = canonicalJsonBytes(manifest as never);
  const manifestSha256 = sha256Hex(manifestBytes);
  return {
    protocol: EVALUATION_SPEC_FORMAT_URI,
    semanticsVersion: EVAL_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: isInspectMultiScorerSelection(manifest)
      ? manifest.scorers.map((scorer) => ({
        name: `inspect-ai:${scorer.name}`,
        digest: { sha256: manifestSha256 },
        accessClass: "public" as const,
      }))
      : {
        name: `inspect-ai:${manifest.scorer.name}`,
        digest: { sha256: manifestSha256 },
        accessClass: "public",
      },
    familyBlock: {
      image: {
        name: `inspect-ai-${manifest.runtime.inspectVersion}-installed-distribution`,
        digest: { sha256: manifest.runtime.inspectDistributionSha256 },
        mediaType: "application/vnd.jinn.python-distribution-tree+json",
      },
      platform: `python/${manifest.runtime.pythonVersion}`,
      workspace: {},
      testMaterial: [],
      parser: {
        id: "benchmark-product-inspect-score-projection",
        version: manifest.runtime.adapterVersion,
        digest: `sha256:${manifest.runtime.workerSha256}`,
      },
      transitions: { failToPass: [], passToPass: [] },
      timeout: manifest.runOptions.timeLimit ?? 86_400,
    },
    measurements: isInspectMultiScorerSelection(manifest)
      ? manifest.scoring.projections.map((projection) => ({
        name: projection.measurementName,
        type: "boolean" as const,
        required: true,
      }))
      : [{ name: "inspect-score-pass", type: "boolean", required: true }],
    verdictRule: isInspectMultiScorerSelection(manifest)
      ? manifest.scoring.verdictRule
      : { threshold: { measurement: "inspect-score-pass", op: "eq", value: true } },
    unscorable: [
      { name: "inspect-run-error", disposition: "retryable-infrastructure" },
      { name: "inspect-incomplete-samples", disposition: "recorded-inconclusive" },
      { name: "inspect-scorer-failure", disposition: "recorded-inconclusive" },
    ],
    evidenceConventions: { requiredRefs: ["inspect-native-log"] },
  };
}

export interface InspectSelectionArtifacts {
  readonly manifestBytes: Uint8Array;
  readonly manifestSha256: string;
  readonly evaluationSpecBytes: Uint8Array;
  readonly evaluationSpecSha256: string;
  readonly taskBytes: Uint8Array;
  readonly taskSha256: string;
  readonly benchmarkBytes: Uint8Array;
  readonly benchmarkSha256: string;
}

export function buildInspectSelectionArtifacts(manifest: InspectSelectionManifest): InspectSelectionArtifacts {
  const manifestBytes = canonicalJsonBytes(manifest as never);
  const manifestSha256 = sha256Hex(manifestBytes);
  const sealedEvaluation = sealEvaluationSpec(inspectEvaluationSpec(manifest));
  const evaluationSpecSha256 = sealedEvaluation.digest.slice("sha256:".length);
  const sealedProfile = sealTaskProfile(buildInspectTaskProfile());
  const taskDocument = {
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: INSPECT_TASK_PROFILE_URI,
      digest: { sha256: sealedProfile.digest.slice("sha256:".length) },
    },
    instructions: isInspectMultiScorerSelection(manifest)
      ? "Execute the selected Inspect task exactly once (epochs=1), retain the complete native log, and project its configured scorer outputs without replacing Inspect authoring, scoring, reduction, or execution."
      : "Execute the selected Inspect task exactly once (epochs=1), retain the complete native log, and project its configured scorer without replacing Inspect authoring or execution.",
    payload: { selectionManifestSha256: manifestSha256 },
    outputs: [
      { name: "inspect-log", mediaType: INSPECT_NATIVE_LOG_MEDIA_TYPE, required: true },
      { name: "inspect-summary", mediaType: INSPECT_SUMMARY_MEDIA_TYPE, required: true },
      { name: "verdict", mediaType: "application/vnd.in-toto+json", required: false },
    ],
    evaluation: {
      name: "inspect-score-evaluation-spec.json",
      digest: { sha256: evaluationSpecSha256 },
      mediaType: "application/json",
    },
    author: "urn:jinn:benchmark-product:inspect-runtime",
  };
  let taskBytes: Uint8Array;
  try {
    taskBytes = sealTask(taskDocument);
  } catch (cause) {
    const issues = cause !== null && typeof cause === "object" && "errors" in cause
      ? JSON.stringify((cause as { errors: unknown }).errors)
      : cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Inspect adapter could not seal its platform Task projection: ${issues}`);
  }
  const taskSha256 = sha256Hex(taskBytes);
  const benchmark = defineBenchmark([{ bytes: taskBytes, digest: `sha256:${taskSha256}` }], {
    name: `inspect:${manifest.task.resolvedName}`,
    description: "One unmodified Inspect task invocation per benchmark cell; Inspect retains ownership of its dataset, solver, scorer, sandbox, samples, and native log.",
    // Inspect task versions are arbitrary strings (the fixture uses "1.0"); Benchmark.version
    // is SemVer. The exact Inspect value remains sealed in the selection manifest, while this
    // record uses it only when it is already valid SemVer.
    version: manifest.task.resolvedVersion !== null && SEMVER.test(manifest.task.resolvedVersion)
      ? manifest.task.resolvedVersion
      : "0.0.0+inspect",
  });
  return {
    manifestBytes,
    manifestSha256,
    evaluationSpecBytes: sealedEvaluation.bytes,
    evaluationSpecSha256,
    taskBytes,
    taskSha256,
    benchmarkBytes: benchmark.bytes,
    benchmarkSha256: sha256Hex(benchmark.bytes),
  };
}
