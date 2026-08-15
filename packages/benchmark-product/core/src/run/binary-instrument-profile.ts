/**
 * Product composition for the one registered binary-instrument qualification profile.
 *
 * This module does not own any of the component contracts. It joins their already-sealed
 * identities before quote/lock: F1's Benchmark extension points to F2's admission manifest;
 * that manifest points to the evaluator-only analysis contexts and label resolutions; each
 * Benchmark item points to an arm-neutral F0 Task/EvaluationSpec; and F3's runtime selection
 * binds four exact F0 judge instruments. The returned method parameters are therefore derived
 * from sealed evidence, never repeated as mutable draft side metadata.
 */

import { Buffer } from "node:buffer";
import {
  BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
  validateBinaryInstrumentParameters,
  type BinaryInstrumentParameters,
} from "@jinn-network/benchmarking-aggregate";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  compareCodeUnitStrings,
  itemTaskDigest,
  type BenchmarkRecord,
} from "@jinn-network/benchmarking-records";
import {
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_MEDIA_TYPE,
  BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_PROFILE_DIGEST,
  BINARY_JUDGMENT_PROFILE_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
  BinaryJudgmentPayloadSchema,
  EVAL_SEMANTICS_VERSION,
  parseBinaryJudgmentAnalysisContext,
  parseBinaryJudgmentInstrument,
  parseBinaryJudgmentLabelResolution,
  parseEvaluationSpec,
  sealBinaryJudgmentAnalysisContext,
  sealBinaryJudgmentInstrument,
  sealBinaryJudgmentLabelResolution,
  sealEvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  TaskSpecificationSchema,
  documentDigest,
  sealTask,
  type TaskSpecification,
} from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import {
  BinaryJudgmentAdmissionManifestSchema,
  parseCanonicalHumanReviewBytes,
} from "../human-review/contracts.js";
import { resolveAssurance, type DraftDocument, type DraftSpec } from "../domain/draft.js";
import { refuse } from "../errors.js";
import {
  BINARY_ITEM_BANK_INTAKE_EXTENSION,
  parseBinaryItemBankIntakeExtension,
} from "../intake/binary-item-bank.js";
import {
  INSPECT_BINARY_JUDGE_ADAPTER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_VERSION,
  INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
  InspectBinaryJudgeSelectionManifestSchema,
} from "../runtime/inspect/binary-judge-manifest.js";
import { getSealedBytes } from "../workspace/sealed-store.js";

export {
  BINARY_ITEM_BANK_INTAKE_EXTENSION,
  INSPECT_BINARY_JUDGE_ADAPTER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_VERSION,
  INSPECT_BINARY_JUDGE_SELECTION_SCHEMA,
};

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const BARE_DIGEST = /^[0-9a-f]{64}$/u;
const ITEM_COMMITMENT_KEY = "network.jinn.binary-judgment.item-sha256";

const EXPECTED_OUTPUTS = [
  { name: "judge-response", mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE, required: true },
  { name: "judge-observation", mediaType: BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE, required: true },
  { name: "inspect-log", mediaType: BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE, required: false },
] as const;

const EXPECTED_MEASUREMENTS = [
  { name: "judgeDecision", type: "string", required: true },
  { name: "truthLabel", type: "string", required: true },
  { name: "agreement", type: "boolean", required: true },
  { name: "parseValid", type: "boolean", required: true },
  { name: "candidateClass", type: "string", required: true },
  { name: "stratum", type: "string", required: true },
  { name: "labelResolutionSha256", type: "string", required: true },
  { name: "instrumentSha256", type: "string", required: true },
] as const;

export const BINARY_INSTRUMENT_REPORT_LIMITATIONS = {
  mutableModelAlias:
    "The gpt-5.6-luna identifier is a mutable provider alias; this evidence does not prove invariant model weights across calls.",
  reviewerKeyPerson:
    "Distinct reviewer signing keys prove key control, not that the controllers are distinct people.",
  cognitiveBlinding:
    "Signed visibility and reveal receipts attest the review protocol; they do not technically prove cognitive blinding.",
  operatorOnly:
    "Truth uses operator-only admission and is not publication-grade two-human unanimous truth.",
} as const;

export function binaryInstrumentReportLimitations(
  parameters: Readonly<Record<string, unknown>>,
): readonly string[] {
  const validation = validateBinaryInstrumentParameters(parameters);
  if (!validation.ok) {
    throw new TypeError(`invalid sealed binary-instrument parameters: ${validation.issues.join("; ")}`);
  }
  return [
    BINARY_INSTRUMENT_REPORT_LIMITATIONS.mutableModelAlias,
    BINARY_INSTRUMENT_REPORT_LIMITATIONS.reviewerKeyPerson,
    BINARY_INSTRUMENT_REPORT_LIMITATIONS.cognitiveBlinding,
    ...(parameters["truthAdmission"] === "operator-only"
      ? [BINARY_INSTRUMENT_REPORT_LIMITATIONS.operatorOnly]
      : []),
  ];
}

function sameJson(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJsonBytes(left as never)).equals(Buffer.from(canonicalJsonBytes(right as never)));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function bare(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCodeUnitStrings);
  const wanted = [...expected].sort(compareCodeUnitStrings);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireCanonicalReseal(input: {
  readonly bytes: Uint8Array;
  readonly expectedDigest: string;
  readonly sealed: { readonly bytes: Uint8Array; readonly digest: string };
  readonly path: string;
}): void {
  if (
    input.sealed.digest !== input.expectedDigest
    || !sameBytes(input.bytes, input.sealed.bytes)
  ) {
    refuse("record-integrity", input.path, `${input.path} is not the exact canonical sealed record`);
  }
}

function descriptorDigest(value: unknown, path: string): `sha256:${string}` {
  const descriptor = object(value);
  const digest = object(descriptor?.["digest"]);
  if (
    descriptor === undefined
    || !exactKeys(descriptor, ["digest"])
    || digest === undefined
    || !exactKeys(digest, ["sha256"])
    || typeof digest["sha256"] !== "string"
    || !BARE_DIGEST.test(digest["sha256"])
  ) {
    refuse("validation", path, `${path} must be one exact sha256 digest descriptor`);
  }
  return `sha256:${digest["sha256"]}`;
}

function parseTaskBytes(bytes: Uint8Array, digest: string): TaskSpecification {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("validation", `tasks.${digest}`, "binary Task is not UTF-8 JSON");
  }
  const parsed = TaskSpecificationSchema.safeParse(json);
  if (!parsed.success) refuse("validation", `tasks.${digest}`, "binary Task does not satisfy the Task schema");
  const sealed = sealTask(parsed.data);
  if (documentDigest(sealed) !== `sha256:${digest}` || !sameBytes(bytes, sealed)) {
    refuse("record-integrity", `tasks.${digest}`, "binary Task is not in exact canonical sealed form");
  }
  return parsed.data as TaskSpecification;
}

function validateEvaluationSpec(input: {
  readonly workspaceDir: string;
  readonly evaluationDigest: `sha256:${string}`;
  readonly manifestContexts: ReadonlySet<string>;
}): `sha256:${string}` {
  const bytes = getSealedBytes(input.workspaceDir, bare(input.evaluationDigest));
  let spec: ReturnType<typeof parseEvaluationSpec>;
  try {
    spec = parseEvaluationSpec(bytes);
  } catch (cause) {
    refuse("validation", "binary.evaluationSpec", cause instanceof Error ? cause.message : String(cause));
  }
  const sealed = sealEvaluationSpec(spec);
  requireCanonicalReseal({ bytes, expectedDigest: input.evaluationDigest, sealed, path: "binary.evaluationSpec" });

  const grader = object(spec.grader);
  const familyBlock = object(spec.familyBlock);
  const testMaterial = familyBlock?.["testMaterial"];
  if (
    spec.semanticsVersion !== EVAL_SEMANTICS_VERSION
    || spec.family !== "deterministic-process"
    || grader === undefined
    || !sameJson(grader, {
      name: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.id,
      digest: { sha256: bare(BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.digest) },
      accessClass: "public",
    })
    || !sameJson(spec.measurements, EXPECTED_MEASUREMENTS)
    || !sameJson(spec.verdictRule, { threshold: { measurement: "agreement", op: "eq", value: true } })
    || !sameJson(spec.unscorable, [])
    || !sameJson(spec.evidenceConventions, { requiredRefs: ["label-resolution.json"] })
    || !Array.isArray(testMaterial)
    || testMaterial.length !== 1
  ) {
    refuse("conflict", "binary.evaluationSpec", "binary evaluator or parser semantics drifted from the registered v1 contract");
  }
  const material = object(testMaterial[0]);
  const contextDigest = descriptorDigest(
    { digest: material?.["digest"] },
    "binary.evaluationSpec.analysisContext",
  );
  if (
    material === undefined
    || !sameJson(familyBlock, {
      image: {
        name: "binary-judgment-evaluation-parser-semantics.json",
        digest: { sha256: bare(BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.digest) },
      },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [{
        name: "analysis-context.json",
        digest: { sha256: bare(contextDigest) },
        mediaType: BINARY_JUDGMENT_ANALYSIS_CONTEXT_MEDIA_TYPE,
        accessClass: "private",
      }],
      parser: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
      transitions: { failToPass: [], passToPass: [] },
      timeout: 60,
    })
    || !input.manifestContexts.has(contextDigest)
  ) {
    refuse("conflict", "binary.evaluationSpec.analysisContext", "EvaluationSpec does not bind one admitted analysis context");
  }
  return contextDigest;
}

function validateTaskClosure(input: {
  readonly workspaceDir: string;
  readonly benchmark: BenchmarkRecord;
  readonly contextsByItem: ReadonlyMap<string, {
    readonly digest: `sha256:${string}`;
    readonly itemId: string;
  }>;
  readonly manifestContexts: ReadonlySet<string>;
}): void {
  const seenContexts = new Set<string>();
  const seenItems = new Set<string>();
  for (const item of input.benchmark.items) {
    const taskDigest = itemTaskDigest(item);
    const task = parseTaskBytes(getSealedBytes(input.workspaceDir, taskDigest), taskDigest);
    const profile = object(task.profile);
    const profileDigest = object(profile?.["digest"]);
    const taskRequirements = object(task.requirements);
    if (
      !exactKeys(task as unknown as Record<string, unknown>, [
        "protocol",
        "profile",
        "instructions",
        "payload",
        "outputs",
        "evaluation",
        "author",
        ITEM_COMMITMENT_KEY,
      ])
      || task.protocol !== TASK_EXECUTION_PROTOCOL_URI
      || task.instructions !== "Return exactly ACCEPT or REJECT."
      || typeof task.author !== "string"
      || profile === undefined
      || !sameJson(profile, {
        uri: BINARY_JUDGMENT_PROFILE_URI,
        digest: { sha256: bare(BINARY_JUDGMENT_PROFILE_DIGEST) },
      })
      || profileDigest?.["sha256"] !== bare(BINARY_JUDGMENT_PROFILE_DIGEST)
      || !sameJson(task.outputs, EXPECTED_OUTPUTS)
      || (taskRequirements !== undefined && Object.hasOwn(taskRequirements, BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY))
    ) {
      refuse("conflict", `tasks.${taskDigest}`, "Benchmark item is not an arm-neutral binary-judgment/1.0 Task");
    }
    const payloadResult = BinaryJudgmentPayloadSchema.safeParse(task.payload);
    if (!payloadResult.success) {
      refuse("validation", `tasks.${taskDigest}.payload`, "binary Task payload drifted from the closed item contract");
    }
    const itemSha256 = (task as unknown as Record<string, unknown>)[ITEM_COMMITMENT_KEY];
    if (
      typeof itemSha256 !== "string"
      || !DIGEST.test(itemSha256)
      || recordDigest(canonicalJsonBytes(payloadResult.data)) !== itemSha256
    ) {
      refuse("conflict", `tasks.${taskDigest}.${ITEM_COMMITMENT_KEY}`, "Task item commitment does not match its canonical payload");
    }
    const contextEntry = input.contextsByItem.get(itemSha256);
    if (contextEntry === undefined || contextEntry.itemId !== payloadResult.data.itemId || seenItems.has(itemSha256)) {
      refuse("conflict", `tasks.${taskDigest}`, "Task does not join one unique admitted item analysis context");
    }
    const evaluationDigest = descriptorDigest(task.evaluation, `tasks.${taskDigest}.evaluation`);
    const contextDigest = validateEvaluationSpec({
      workspaceDir: input.workspaceDir,
      evaluationDigest,
      manifestContexts: input.manifestContexts,
    });
    if (contextDigest !== contextEntry.digest || seenContexts.has(contextDigest)) {
      refuse("conflict", `tasks.${taskDigest}.evaluation`, "Task EvaluationSpec joins the wrong or a repeated analysis context");
    }
    seenItems.add(itemSha256);
    seenContexts.add(contextDigest);
  }
  if (
    seenContexts.size !== input.manifestContexts.size
    || [...input.manifestContexts].some((digest) => !seenContexts.has(digest))
  ) {
    refuse("conflict", "binary.admissionManifest", "Benchmark Tasks do not exactly cover the admitted analysis contexts");
  }
}

function deriveAdmissionProfile(input: {
  readonly workspaceDir: string;
  readonly draft: DraftDocument;
  readonly benchmark: BenchmarkRecord;
}): Pick<BinaryInstrumentParameters, "candidateClasses" | "strata" | "truthAdmission"> {
  const extension = parseBinaryItemBankIntakeExtension(input.benchmark);
  // RECONCILIATION(F2/G6): once the independently hardened admission verifier lands, call its
  // workspace wrapper here with extension.admissionManifestSha256 and derive only from the
  // authenticated closure it returns. The digest remains the F1 Benchmark extension's sole
  // locator; do not add draft metadata or a second authority path. The structural replay below
  // deliberately remains isolated at this seam so that replacement is mechanical.
  const manifestBytes = getSealedBytes(input.workspaceDir, bare(extension.admissionManifestSha256));
  const manifest = parseCanonicalHumanReviewBytes(
    BinaryJudgmentAdmissionManifestSchema,
    manifestBytes,
    "binary admission manifest",
  );
  if (
    recordDigest(manifestBytes) !== extension.admissionManifestSha256
    || manifest.draftId !== input.draft.draftId
    || manifest.replacementLedgerSha256 !== extension.replacementLedgerSha256
  ) {
    refuse("conflict", "binary.admissionManifest", "Benchmark intake and admission manifest digest joins do not match this draft");
  }

  const candidateClasses = new Set<string>();
  const strata = new Set<string>();
  const labels = new Set<string>();
  const contextsByItem = new Map<string, { digest: `sha256:${string}`; itemId: string }>();
  const manifestContexts = new Set<string>(manifest.analysisContextSha256s);
  for (const contextDigestValue of manifest.analysisContextSha256s) {
    const contextDigest = contextDigestValue as `sha256:${string}`;
    const contextBytes = getSealedBytes(input.workspaceDir, bare(contextDigest));
    const context = parseBinaryJudgmentAnalysisContext(contextBytes);
    requireCanonicalReseal({
      bytes: contextBytes,
      expectedDigest: contextDigest,
      sealed: sealBinaryJudgmentAnalysisContext(context),
      path: "binary.analysisContext",
    });
    const labelBytes = getSealedBytes(input.workspaceDir, bare(context.labelResolutionSha256));
    const label = parseBinaryJudgmentLabelResolution(labelBytes) as unknown as {
      readonly itemSha256: string;
      readonly itemId: string;
      readonly truthLabel: string;
      readonly candidateClass: string;
      readonly stratum: string;
      readonly truthAdmission: string;
    };
    requireCanonicalReseal({
      bytes: labelBytes,
      expectedDigest: context.labelResolutionSha256,
      sealed: sealBinaryJudgmentLabelResolution(label as never),
      path: "binary.labelResolution",
    });
    if (
      label.itemSha256 !== context.itemSha256
      || label.itemId !== context.itemId
      || label.truthLabel !== context.truthLabel
      || label.candidateClass !== context.candidateClass
      || label.stratum !== context.stratum
      || label.truthAdmission !== manifest.truthAdmission
      || contextsByItem.has(context.itemSha256)
    ) {
      refuse("conflict", "binary.analysisContext", "analysis context and admitted label resolution joins disagree");
    }
    candidateClasses.add(context.candidateClass);
    strata.add(context.stratum);
    labels.add(context.labelResolutionSha256);
    contextsByItem.set(context.itemSha256, { digest: contextDigest, itemId: context.itemId });
  }
  if (
    labels.size !== manifest.labelResolutionSha256s.length
    || manifest.labelResolutionSha256s.some((digest) => !labels.has(digest))
  ) {
    refuse("conflict", "binary.admissionManifest", "admission manifest label and analysis-context inventories disagree");
  }
  const derivedStrata = [...strata].sort(compareCodeUnitStrings);
  if (!sameJson(derivedStrata, ["core", "stress"])) {
    refuse("conflict", "binary.admissionManifest", "admitted analysis contexts must exactly cover the registered core and stress strata");
  }
  validateTaskClosure({
    workspaceDir: input.workspaceDir,
    benchmark: input.benchmark,
    contextsByItem,
    manifestContexts,
  });
  return {
    candidateClasses: [...candidateClasses].sort(compareCodeUnitStrings),
    strata: ["core", "stress"],
    truthAdmission: manifest.truthAdmission,
  };
}

function validateRuntimeAndArms(input: {
  readonly workspaceDir: string;
  readonly spec: DraftSpec;
}): void {
  if (input.spec.arms.length !== 4) {
    refuse("validation", "spec.arms", "binary-instrument@1 requires exactly four instrument arms");
  }
  const runtime = input.spec.evaluationRuntime;
  if (
    runtime?.adapterId !== INSPECT_BINARY_JUDGE_ADAPTER_ID
    || runtime.isolationPolicy !== "oci-container"
  ) {
    refuse("validation", "spec.evaluationRuntime", "binary-instrument@1 requires the inspect-binary-judge OCI runtime binding");
  }
  const selectionBytes = getSealedBytes(input.workspaceDir, runtime.selectionManifestSha256);
  let selectionJson: unknown;
  try {
    selectionJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(selectionBytes));
  } catch {
    refuse("validation", "spec.evaluationRuntime.selectionManifestSha256", "binary judge selection is not UTF-8 JSON");
  }
  const parsed = InspectBinaryJudgeSelectionManifestSchema.safeParse(selectionJson);
  if (!parsed.success || !sameBytes(selectionBytes, canonicalJsonBytes(parsed.success ? parsed.data : {}))) {
    refuse("conflict", "spec.evaluationRuntime.selectionManifestSha256", "binary judge selection drifted from the frozen v1 runtime contract");
  }
  const selection = parsed.data;
  const sortedArmIds = selection.arms.map((arm) => arm.armId).sort(compareCodeUnitStrings);
  const firstGeneration = selection.arms[0]!.generation;
  if (
    new Set(sortedArmIds).size !== 4
    || selection.arms.some((arm, index) => arm.armId !== sortedArmIds[index])
    || selection.arms.some((arm) => !sameJson(arm.generation, firstGeneration))
    || new Set(selection.arms.map((arm) => arm.instrumentSha256)).size !== 4
  ) {
    refuse("conflict", "spec.evaluationRuntime.selectionManifestSha256", "binary judge selection arms must be sorted, distinct, and share one generation block");
  }

  for (const [index, arm] of input.spec.arms.entries()) {
    const selected = selection.arms[index]!;
    if (
      arm.armId !== selected.armId
      || !exactKeys(arm.pinning, ["harness", "model", BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY])
      || !sameJson(arm.pinning["harness"], {
        id: INSPECT_BINARY_JUDGE_LAUNCHER_ID,
        version: INSPECT_BINARY_JUDGE_LAUNCHER_VERSION,
      })
      || !sameJson(arm.pinning["model"], { id: "gpt-5.6-luna" })
      || arm.pinning[BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY] !== selected.instrumentSha256
    ) {
      refuse("conflict", `spec.arms.${index}`, "Run arm does not exactly match the sealed Inspect binary-judge selection");
    }
    const instrumentBytes = getSealedBytes(input.workspaceDir, bare(selected.instrumentSha256));
    const instrument = parseBinaryJudgmentInstrument(instrumentBytes);
    requireCanonicalReseal({
      bytes: instrumentBytes,
      expectedDigest: selected.instrumentSha256,
      sealed: sealBinaryJudgmentInstrument(instrument),
      path: `spec.arms.${index}.instrument`,
    });
    if (
      instrument.instrumentId !== arm.armId
      || instrument.model.adapter !== "jinn-openai"
      || instrument.model.requested !== "gpt-5.6-luna"
      || !sameJson(instrument.model.generation, selected.generation)
    ) {
      refuse("conflict", `spec.arms.${index}.instrument`, "instrument identity, jinn-openai Luna model, or generation settings drifted from the runtime selection");
    }
  }
}

export function isBinaryInstrumentSpec(spec: DraftSpec): boolean {
  return spec.analysis?.method === BENCHMARKING_METHOD_IDS.binaryInstrument;
}

/** Validate every sealed cross-layer join and derive the exact registered method parameters. */
export function compileBinaryInstrumentProfile(input: {
  readonly workspaceDir: string;
  readonly draft: DraftDocument;
  readonly benchmark: BenchmarkRecord;
}): BinaryInstrumentParameters {
  const { spec } = input.draft;
  const analysis = spec.analysis;
  if (analysis?.method !== BENCHMARKING_METHOD_IDS.binaryInstrument) {
    throw new TypeError("compileBinaryInstrumentProfile requires a binary-instrument analysis");
  }
  if (analysis.version !== BENCHMARKING_METHOD_VERSION) {
    refuse("validation", "spec.analysis.version", `binary-instrument requires version ${BENCHMARKING_METHOD_VERSION}`);
  }
  if (analysis.baseline !== undefined || analysis.candidate !== undefined) {
    refuse("validation", "spec.analysis", "binary-instrument is a non-comparative per-instrument method and does not accept baseline or candidate arms");
  }
  const supplied = analysis.parameters ?? {};
  if (Object.hasOwn(supplied, "k")) {
    refuse("validation", "spec.analysis.parameters.k", "k is derived exactly from Draft.replicates and must not be caller-supplied");
  }
  if (Object.keys(supplied).length > 0) {
    refuse("validation", "spec.analysis.parameters", "binary-instrument parameters are derived from the draft and sealed evidence; callers must not supply them");
  }
  if (spec.replicates <= 0 || spec.replicates % 2 === 0 || !Number.isSafeInteger(spec.replicates)) {
    refuse("validation", "spec.replicates", "binary-instrument scientific replicate k must be an odd positive safe integer");
  }
  const effectiveVerdictRule = resolveAssurance(spec.assurance).verdictRule;
  if (effectiveVerdictRule !== "sole") {
    refuse("validation", "spec.assurance", "binary-instrument@1 requires resolved verdictRule=sole");
  }
  validateRuntimeAndArms({ workspaceDir: input.workspaceDir, spec });
  const admission = deriveAdmissionProfile(input);
  const parameters: BinaryInstrumentParameters = {
    verdictRule: "sole",
    k: spec.replicates,
    reduction: "strict-majority",
    measurementProfile: BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
    candidateClasses: admission.candidateClasses,
    strata: admission.strata,
    parserInvalidPolicy: "reject",
    truthAdmission: admission.truthAdmission,
    intervalAlpha: "0.05",
  };
  const validation = validateBinaryInstrumentParameters(
    parameters as unknown as Readonly<Record<string, unknown>>,
  );
  if (!validation.ok) {
    refuse("validation", "spec.analysis", `derived binary-instrument parameters are invalid: ${validation.issues.join("; ")}`);
  }
  return parameters;
}
