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
  isBinaryJudgmentEvaluationSpecification,
} from "@jinn-network/task-execution-evaluator-adapters";
import {
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_PROFILE_DIGEST,
  BINARY_JUDGMENT_PROFILE_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
  BinaryJudgmentPayloadSchema,
  JUDGE_MODEL_PROFILES,
  parseBinaryJudgmentInstrument,
  parseEvaluationSpec,
  sealBinaryJudgmentInstrument,
  sealEvaluationSpec,
  type AcceptedJudgeModelId,
} from "@jinn-network/task-execution-profiles";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  TaskSpecificationSchema,
  documentDigest,
  sealTask,
  type TaskSpecification,
} from "@jinn-network/task-execution-protocol";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import { verifyBinaryJudgmentAdmissionClosureInWorkspace } from "../human-review/verification-workspace.js";
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
import {
  BINARY_INSTRUMENT_REPORT_LIMITATIONS,
  binaryInstrumentReportLimitations,
} from "@colophon-claims/verify";
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

export { BINARY_INSTRUMENT_REPORT_LIMITATIONS, binaryInstrumentReportLimitations };

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

  const familyBlock = object(spec.familyBlock);
  const testMaterial = familyBlock?.["testMaterial"];
  if (
    !Array.isArray(testMaterial)
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
    || !isBinaryJudgmentEvaluationSpecification(spec)
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
  let verified: ReturnType<typeof verifyBinaryJudgmentAdmissionClosureInWorkspace>;
  try {
    verified = verifyBinaryJudgmentAdmissionClosureInWorkspace({
      workspaceDir: input.workspaceDir,
      admissionManifestSha256: extension.admissionManifestSha256,
      expectedDraftId: input.draft.draftId,
    });
  } catch (cause) {
    refuse(
      "record-integrity",
      "binary.admissionManifest",
      `binary admission closure is not authenticated: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (verified.manifest.replacementLedgerSha256 !== extension.replacementLedgerSha256) {
    refuse("conflict", "binary.admissionManifest", "Benchmark intake and admission manifest digest joins do not match this draft");
  }

  if (!sameJson(verified.strata, ["core", "stress"])) {
    refuse("conflict", "binary.admissionManifest", "admitted analysis contexts must exactly cover the registered core and stress strata");
  }
  const contextsByItem = new Map(verified.accepted.map((entry) => [
    entry.itemSha256,
    { digest: entry.analysisContextSha256, itemId: entry.itemId },
  ] as const));
  const manifestContexts = new Set(verified.accepted.map((entry) => entry.analysisContextSha256));
  validateTaskClosure({
    workspaceDir: input.workspaceDir,
    benchmark: input.benchmark,
    contextsByItem,
    manifestContexts,
  });
  return {
    candidateClasses: verified.classes,
    strata: ["core", "stress"],
    truthAdmission: verified.manifest.truthAdmission,
  };
}

function validateRuntimeAndArms(input: {
  readonly workspaceDir: string;
  readonly spec: DraftSpec;
}): { readonly judgeModel: AcceptedJudgeModelId } {
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

  // The sealed selection manifest's own schema already supplies the floor of two and the sorted,
  // unique, distinct-instrument constraints (spec §1.6 rule 1), so the Run's arm count is checked
  // against the selection's own arm count rather than against a literal.
  if (input.spec.arms.length !== selection.arms.length) {
    refuse("validation", "spec.arms", "binary-instrument@1 requires one Run arm per sealed judge selection arm");
  }

  const sortedArmIds = selection.arms.map((arm) => arm.armId).sort(compareCodeUnitStrings);
  const firstGeneration = selection.arms[0]!.generation;
  const firstModel = selection.arms[0]!.model;
  if (
    new Set(sortedArmIds).size !== selection.arms.length
    || selection.arms.some((arm, index) => arm.armId !== sortedArmIds[index])
    || selection.arms.some((arm) => !sameJson(arm.generation, firstGeneration))
    || new Set(selection.arms.map((arm) => arm.instrumentSha256)).size !== selection.arms.length
  ) {
    refuse("conflict", "spec.evaluationRuntime.selectionManifestSha256", "binary judge selection arms must be sorted, distinct, and share one generation block");
  }
  // §1.4's profile derivation is a total function of one shared model.requested. The manifest's
  // own cross-arm rule already pins one shared generation block, which pins one shared profile,
  // but not literally one shared model id (a profile could in principle admit more than one
  // accepted model). Enforced here, and nowhere else (§0.5): this is the first point where the
  // selection is sealed and in scope.
  if (selection.arms.some((arm) => arm.model !== firstModel)) {
    refuse("conflict", "spec.evaluationRuntime.selectionManifestSha256", "binary judge selection arms must share one model");
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
      || !sameJson(arm.pinning["model"], { id: selected.model })
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
      || instrument.model.requested !== selected.model
      || !sameJson(instrument.model.generation, selected.generation)
    ) {
      refuse("conflict", `spec.arms.${index}.instrument`, "instrument identity, jinn-openai model, or generation settings drifted from the runtime selection");
    }
  }

  return { judgeModel: firstModel };
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
  const { judgeModel } = validateRuntimeAndArms({ workspaceDir: input.workspaceDir, spec });
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
    // DERIVED from the arms' shared model.requested (validateRuntimeAndArms), never declared as
    // an instrument field: declaring it would add a required key to
    // BinaryJudgmentInstrumentSchema and move every existing instrument's bytes and therefore its
    // digest (spec §1.2). Optional on the parameter schema, so its presence here is a compatible
    // widening (§0.4/§10 row 11).
    judgeModelProfile: JUDGE_MODEL_PROFILES[judgeModel],
  };
  const validation = validateBinaryInstrumentParameters(
    parameters as unknown as Readonly<Record<string, unknown>>,
  );
  if (!validation.ok) {
    refuse("validation", "spec.analysis", `derived binary-instrument parameters are invalid: ${validation.issues.join("; ")}`);
  }
  return parameters;
}
