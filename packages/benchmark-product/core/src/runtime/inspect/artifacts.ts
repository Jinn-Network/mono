import { defineBenchmark } from "@jinn-network/benchmarking-interop";
import {
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  TASK_PROFILE_FORMAT_URI,
  sealEvaluationSpec,
  sealTaskProfile,
  type EvaluationSpec,
  type TaskProfileDocument,
} from "@jinn-network/task-execution-profiles";
import { sealTask, TASK_EXECUTION_PROTOCOL_URI } from "@jinn-network/task-execution-protocol";
import type { InspectSelectionManifest } from "./manifest.js";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { sha256Hex } from "../../workspace/sealed-store.js";
import { z } from "zod";

export const INSPECT_TASK_PROFILE_URI = "https://product.jinn.network/profiles/inspect-evaluation/1";
export const INSPECT_NATIVE_LOG_MEDIA_TYPE = "application/vnd.inspect-ai.eval";
export const INSPECT_SUMMARY_MEDIA_TYPE = "application/vnd.jinn.inspect-summary+json";
export const INSPECT_EMBEDDED_EVALUATOR_ID = "urn:jinn:benchmark-product:inspect-runtime:same-execution-scorer";

export const InspectCellSummarySchema = z.object({
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
});
export type InspectCellSummary = z.infer<typeof InspectCellSummarySchema>;

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
    grader: {
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
    measurements: [{ name: "inspect-score-pass", type: "boolean", required: true }],
    verdictRule: { threshold: { measurement: "inspect-score-pass", op: "eq", value: true } },
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
    instructions: "Execute the selected Inspect task exactly once (epochs=1), retain the complete native log, and project its configured scorer without replacing Inspect authoring or execution.",
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
