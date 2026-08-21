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
  PAIRED_MAJORITY_DELTA_ALPHA,
  PAIRED_MAJORITY_DELTA_RESAMPLES,
  PAIRED_MAJORITY_DELTA_SEED,
  validateBinaryInstrumentParameters,
  validatePairedMajorityDeltaParameters,
  validatePairwiseDisagreementParameters,
  type BinaryInstrumentParameters,
  type PairedMajorityDeltaParameters,
  type PairwiseDisagreementParameters,
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
  binaryJudgmentInstrumentDeclaresEvidence,
  parseBinaryJudgmentInstrument,
  parseEvaluationSpec,
  sealBinaryJudgmentInstrument,
  sealEvaluationSpec,
  type AcceptedJudgeModelId,
  type BinaryJudgmentInstrument,
  type BinaryJudgmentTemplateSegment,
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
import { resolveAssurance, type Analysis, type DraftDocument, type DraftSpec } from "../domain/draft.js";
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
      refuse("conflict", `tasks.${taskDigest}`, "Benchmark item is not an arm-neutral binary-judgment/2.0 Task");
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
}): Pick<BinaryInstrumentParameters, "candidateClasses" | "strata" | "truthAdmission"> & {
  readonly screeningInstrumentSha256?: `sha256:${string}`;
} {
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

  // No coverage gate here (spec §3.1 rule 2): the declared vocabulary is derived from
  // `verified.strata`, not compared against a registered pair, so there is nothing left to
  // "cover". Its non-empty / sorted / unique / grammar properties are enforced exactly once,
  // downstream at `validateBinaryInstrumentParameters` (spec §0.5). `candidateClasses`, the
  // sibling axis two lines below, has never had a gate like this.
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
    strata: verified.strata,
    truthAdmission: verified.manifest.truthAdmission,
    ...(verified.screening === undefined ? {} : {
      screeningInstrumentSha256: verified.screening.instrumentSha256,
    }),
  };
}

function refuseScreeningInstrumentRunReuse(
  screeningInstrumentSha256: string | undefined,
  spec: DraftSpec,
): void {
  if (screeningInstrumentSha256 === undefined) return;
  const reusedAt = spec.arms.findIndex((arm) => (
    arm.pinning[BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY] === screeningInstrumentSha256
  ));
  if (reusedAt !== -1) {
    refuse(
      "conflict",
      `spec.arms.${reusedAt}.instrument`,
      "the screening instrument cannot also be a run judge arm",
    );
  }
}

// A Task this function cannot read is not an evidence-free Task, it is a malformed one, and
// `validateTaskClosure` already refuses it accurately moments later. Answering `true` here keeps
// the evidence refusal from claiming "the bound bank carries none" about bytes it never parsed.
function taskPayloadCarriesEvidence(taskBytes: Uint8Array): boolean {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(taskBytes));
  } catch {
    return true;
  }
  const payload = object(json)?.["payload"];
  const parsed = BinaryJudgmentPayloadSchema.safeParse(payload);
  return !parsed.success || parsed.data.evidence !== undefined;
}

function validateRuntimeAndArms(input: {
  readonly workspaceDir: string;
  readonly spec: DraftSpec;
  readonly benchmark: BenchmarkRecord;
}): {
  readonly judgeModel: AcceptedJudgeModelId;
  /** Index of the FIRST arm whose instrument declares evidence, or `undefined` if none do.
   * Unchanged in meaning from before this field was named (P5, packet #2837): the §2.3 leak
   * refusal below only ever needed presence, so it always tracked the first match. Exposed now so
   * `compilePairedMajorityDeltaProfile` can name the evidence-declaring arm as `candidate`. */
  readonly declaringArmIndex: number | undefined;
  /** How many arms declare evidence -- ADDED (P5, packet #2837) alongside `declaringArmIndex`
   * rather than folding into it, because the §2.3 leak check only ever needed "at least one", so
   * widening `declaringArmIndex` itself to a list would have touched that check's condition for no
   * reason. `paired-majority-delta@1`'s derivation needs the exact count to refuse an ambiguous
   * pairing (more than one declaring arm) rather than silently pairing against the first. */
  readonly declaringArmCount: number;
  /** Every arm's parsed instrument, in Run-arm order -- ADDED (P5, packet #2837, RULING C2) so
   * `compilePairedMajorityDeltaProfile` can DERIVE the evidence-declaring arm's twin structurally
   * instead of assuming a two-arm roster. Already parsed and reseal-checked in the loop below, so
   * returning them costs nothing and avoids a second parse of the same sealed bytes. */
  readonly armInstruments: readonly BinaryJudgmentInstrument[];
} {
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

  let declaringArmIndex: number | undefined;
  let declaringArmCount = 0;
  const armInstruments: BinaryJudgmentInstrument[] = [];
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
    armInstruments.push(instrument);
    if (binaryJudgmentInstrumentDeclaresEvidence(instrument)) {
      declaringArmCount += 1;
      if (declaringArmIndex === undefined) declaringArmIndex = index;
    }
  }

  // §2.3 lock-time leak refusal (frozen) -- the ONE enforcement point for the direction rule "arms
  // constrain items; items never constrain arms": an instrument that interpolates `evidence`
  // requires every bound item's payload to carry it. The converse -- bank items carry evidence, no
  // arm declares it -- is allowed and required by the design: the declaring arm's evidence-free
  // twin must still be able to ignore evidence that happens to be present. Lock is the enforcement
  // point (and nowhere else) because it is the first moment the arm set and the item set are both
  // frozen and both in scope; binding is not, because a bind may precede benchmark attachment. The
  // scan below is lazy -- it only runs when some arm actually declares evidence -- so a
  // non-declaring run pays nothing for it.
  if (declaringArmIndex !== undefined) {
    for (const item of input.benchmark.items) {
      const taskDigest = itemTaskDigest(item);
      const taskBytes = getSealedBytes(input.workspaceDir, taskDigest);
      if (!taskPayloadCarriesEvidence(taskBytes)) {
        refuse(
          "conflict",
          `spec.arms.${declaringArmIndex}.instrument`,
          "instrument interpolates evidence but the bound bank carries none",
        );
      }
    }
  }

  return { judgeModel: firstModel, declaringArmIndex, declaringArmCount, armInstruments };
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
  const { judgeModel } = validateRuntimeAndArms({
    workspaceDir: input.workspaceDir,
    spec,
    benchmark: input.benchmark,
  });
  const admission = deriveAdmissionProfile(input);
  refuseScreeningInstrumentRunReuse(admission.screeningInstrumentSha256, spec);
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

/**
 * The shared front half of `pairwise-disagreement@1`'s and `paired-majority-delta@1`'s
 * derivations (spec §7.1/§7.2a/§7.5): "siblings of `compileBinaryInstrumentProfile`: same joins,
 * same derivation, minus the arm-cardinality branch. They share their whole front half and are
 * written as one function with two callers, not two functions." `compileBinaryInstrumentProfile`
 * above is left untouched -- this is a NEW function for the two NEW methods, not a refactor of the
 * existing one, and it takes the analysis ENTRY as a parameter (never reads `spec.analysis`
 * itself) because both new methods are typically `additionalAnalyses` entries, not the primary.
 *
 * Reuses `validateRuntimeAndArms` and `deriveAdmissionProfile` verbatim -- both already
 * arm-cardinality-agnostic and already shared with `compileBinaryInstrumentProfile`.
 *
 * Deliberately excludes two of `compileBinaryInstrumentProfile`'s own spec-shape checks (P5
 * coordinator ruling, packet #2837):
 *  - the odd-`k` check on `spec.replicates`: both new methods' own tail-end validators
 *    (`validatePairwiseDisagreementParameters` / `validatePairedMajorityDeltaParameters`) already
 *    refuse a non-odd derived `k`, so repeating the check here would be purely redundant with the
 *    check every caller below already runs.
 *  - the caller-must-not-supply-baseline/candidate refusal: unlike binary-instrument's fixed
 *    message ("is a non-comparative...and does not accept baseline or candidate arms"), each new
 *    method's own reason for refusing caller-supplied roles differs by comparative shape, so that
 *    refusal is written once per caller instead (see `compilePairwiseDisagreementProfile` /
 *    `compilePairedMajorityDeltaProfile` below) rather than folded in here with one shared message
 *    that would be accurate for neither.
 */
function deriveBinaryInstrumentFamilyClosure(input: {
  readonly workspaceDir: string;
  readonly draft: DraftDocument;
  readonly benchmark: BenchmarkRecord;
  readonly analysis: Analysis;
  /** Names the calling method in refusal messages only (mirrors `compile.ts`'s own `pathPrefix`
   * convention) -- the checks themselves are identical for both callers. */
  readonly methodLabel: string;
  /** Refusal PATH prefix, threaded from `compile.ts` (M2). The primary entry is `"spec.analysis"`;
   * an additional entry is `"spec.additionalAnalyses.<i>"`. Without it every refusal raised here
   * pointed a reader at `spec.analysis` even when the offending entry was an additional one.
   * Optional, defaulting to `"spec.analysis"`, so a direct caller that does not know its own index
   * is unaffected. */
  readonly pathPrefix?: string;
}): {
  readonly k: number;
  readonly candidateClasses: readonly string[];
  readonly strata: readonly string[];
  readonly truthAdmission: BinaryInstrumentParameters["truthAdmission"];
  readonly declaringArmIndex: number | undefined;
  readonly declaringArmCount: number;
  readonly armInstruments: readonly BinaryJudgmentInstrument[];
} {
  const { analysis, methodLabel } = input;
  const pathPrefix = input.pathPrefix ?? "spec.analysis";
  const spec = input.draft.spec;

  if (analysis.version !== BENCHMARKING_METHOD_VERSION) {
    refuse("validation", `${pathPrefix}.version`, `${methodLabel} requires version ${BENCHMARKING_METHOD_VERSION}`);
  }
  const supplied = analysis.parameters ?? {};
  if (Object.hasOwn(supplied, "k")) {
    refuse("validation", `${pathPrefix}.parameters.k`, "k is derived exactly from Draft.replicates and must not be caller-supplied");
  }
  if (Object.keys(supplied).length > 0) {
    refuse("validation", `${pathPrefix}.parameters`, `${methodLabel} parameters are derived from the draft and sealed evidence; callers must not supply them`);
  }
  const effectiveVerdictRule = resolveAssurance(spec.assurance).verdictRule;
  if (effectiveVerdictRule !== "sole") {
    refuse("validation", "spec.assurance", `${methodLabel} requires resolved verdictRule=sole`);
  }

  const { declaringArmIndex, declaringArmCount, armInstruments } = validateRuntimeAndArms({
    workspaceDir: input.workspaceDir,
    spec,
    benchmark: input.benchmark,
  });
  const admission = deriveAdmissionProfile({
    workspaceDir: input.workspaceDir,
    draft: input.draft,
    benchmark: input.benchmark,
  });
  refuseScreeningInstrumentRunReuse(admission.screeningInstrumentSha256, spec);

  return {
    k: spec.replicates,
    candidateClasses: admission.candidateClasses,
    strata: admission.strata,
    truthAdmission: admission.truthAdmission,
    declaringArmIndex,
    declaringArmCount,
    armInstruments,
  };
}

/**
 * Validate every sealed cross-layer join and derive `pairwise-disagreement@1`'s exact registered
 * parameters (spec §7.1). Non-comparative like `binary-instrument@1`: it computes all unordered
 * arm pairs in one pass, so it carries no `baseline`/`candidate` and refuses a caller who supplies
 * either -- same polarity as `binary-instrument@1`'s own refusal, different message because the
 * reason is "computes every pair" rather than "is non-comparative".
 */
export function compilePairwiseDisagreementProfile(input: {
  readonly workspaceDir: string;
  readonly draft: DraftDocument;
  readonly benchmark: BenchmarkRecord;
  readonly analysis: Analysis;
  /** See the closure's own `pathPrefix` (M2). Optional; defaults to `"spec.analysis"`. */
  readonly pathPrefix?: string;
}): PairwiseDisagreementParameters {
  const { analysis } = input;
  if (analysis.baseline !== undefined || analysis.candidate !== undefined) {
    refuse(
      "validation",
      input.pathPrefix ?? "spec.analysis",
      "pairwise-disagreement computes all unordered arm pairs in one pass and does not accept baseline or candidate arms",
    );
  }
  const closure = deriveBinaryInstrumentFamilyClosure({
    workspaceDir: input.workspaceDir,
    draft: input.draft,
    benchmark: input.benchmark,
    analysis,
    methodLabel: "pairwise-disagreement",
    pathPrefix: input.pathPrefix,
  });

  const parameters: PairwiseDisagreementParameters = {
    verdictRule: "sole",
    k: closure.k,
    reduction: "strict-majority",
    measurementProfile: BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
    candidateClasses: closure.candidateClasses,
    strata: closure.strata,
    parserInvalidPolicy: "reject",
    truthAdmission: closure.truthAdmission,
    intervalAlpha: "0.05",
  };
  const validation = validatePairwiseDisagreementParameters(
    parameters as unknown as Readonly<Record<string, unknown>>,
  );
  if (!validation.ok) {
    refuse("validation", input.pathPrefix ?? "spec.analysis", `derived pairwise-disagreement parameters are invalid: ${validation.issues.join("; ")}`);
  }
  return parameters;
}

/**
 * The evidence-declaring arm's message templates with its evidence interpolation removed, in a
 * canonical comparable form (packet #2837, RULING C2). This is the structural definition of "the
 * evidence-free twin": the twin is the arm whose instrument renders the SAME prompt the declaring
 * arm would render if evidence were not interpolated at all.
 *
 * Two normalizations, both deliberate:
 *
 * 1. **A literal immediately preceding an `evidence` field is dropped with it.** That literal is
 *    the interpolation's introducer (the shipped convention writes the pair as
 *    `[{literal: "\nEvidence: "}, {field: "evidence"}]`), and it carries no meaning once the field
 *    is gone. Dropping the field alone would leave a dangling "Evidence: " label in the stripped
 *    form, so no real twin would ever match and the derivation would refuse every roster.
 * 2. **Consecutive literals are merged and empty literals dropped.** The comparison is over the
 *    rendered template, not over how its author happened to split the literal runs, so a twin
 *    written as one literal matches a declaring arm whose literals bracket the removed evidence.
 *
 * Every other segment must match exactly, in order: this is a structural equality test, not a
 * fuzzy one.
 */
function evidenceStrippedMessages(instrument: BinaryJudgmentInstrument): unknown {
  return instrument.messages.map((message) => {
    const kept: BinaryJudgmentTemplateSegment[] = [];
    for (const segment of message.segments) {
      if ("field" in segment && segment.field === "evidence") {
        const last = kept[kept.length - 1];
        if (last !== undefined && "literal" in last) kept.pop();
        continue;
      }
      kept.push(segment);
    }
    const merged: BinaryJudgmentTemplateSegment[] = [];
    for (const segment of kept) {
      const last = merged[merged.length - 1];
      if ("literal" in segment && last !== undefined && "literal" in last) {
        merged[merged.length - 1] = { literal: last.literal + segment.literal };
      } else {
        merged.push(segment);
      }
    }
    return {
      role: message.role,
      segments: merged.filter((segment) => !("literal" in segment) || segment.literal !== ""),
    };
  });
}

/**
 * Is `candidate` the evidence-free twin of `declaring` (packet #2837, RULING C2)? True iff the two
 * instruments are identical on every axis once the evidence interpolation is stripped from both.
 *
 * `instrumentId` and `promptTemplateSha256` are excluded by construction, not by leniency:
 * `instrumentId` is pinned to the arm id (so a twin's necessarily differs), and
 * `promptTemplateSha256` is a digest OF the messages (so it necessarily differs whenever the
 * evidence segments do). Everything else -- model, generation, promptSource, license, attribution,
 * response contract, protocol -- must match exactly, which is what makes this a twin rather than
 * merely another arm that happens not to declare evidence.
 */
function isEvidenceFreeTwin(declaring: BinaryJudgmentInstrument, candidate: BinaryJudgmentInstrument): boolean {
  const withoutDerivedIdentity = (instrument: BinaryJudgmentInstrument) => {
    const { instrumentId: _id, promptTemplateSha256: _digest, messages: _messages, ...rest } = instrument;
    return rest;
  };
  return sameJson(withoutDerivedIdentity(declaring), withoutDerivedIdentity(candidate))
    && sameJson(evidenceStrippedMessages(declaring), evidenceStrippedMessages(candidate));
}

/**
 * Validate every sealed cross-layer join and derive `paired-majority-delta@1`'s exact registered
 * parameters (spec §7.2a). Comparative, unlike its sibling above: it needs exactly ONE named pair.
 *
 * **Baseline/candidate derivation (coordinator ruling, packet #2837, overriding a literal reading
 * of spec §7.2a):** §7.2a's text -- "`baseline` and `candidate` name the evidence-declaring arm and
 * its evidence-free twin" -- names a PAIR but assigns no role to either name. The estimator computes
 * `pB - pA` with `pB` as `candidate` (spec §7.2a, mirroring `paired-delta@1`'s own `pB - pA`
 * convention), so the assignment is load-bearing: **`candidate` is the evidence-declaring arm,
 * `baseline` is its evidence-free twin**, and a positive `delta` means declaring evidence increased
 * agreement.
 *
 * **Pair derivation is STRUCTURAL, never a literal arm count (packet #2837, RULING C2; spec §1.6's
 * no-literal-counts rule is frozen for this family).** The pair is derived in two steps, each
 * refusing by name rather than guessing:
 *
 * 1. Exactly one arm's instrument must declare evidence. Zero declaring arms and two-or-more
 *    declaring arms both refuse -- with neither, there is no contrast to measure; with several,
 *    "the" declaring arm is not well defined.
 * 2. That arm's twin is the UNIQUE other arm whose instrument is identical once the evidence
 *    interpolation is stripped from both (`isEvidenceFreeTwin`). No match refuses; more than one
 *    match refuses.
 *
 * This works for the two-arm rehearsal roster and the ratified six-arm flagship panel alike: the
 * four unrelated arms of a six-arm panel simply fail the twin test, leaving one match. The
 * ambiguity the old literal `arms.length !== 2` ban was protecting against is now a typed refusal
 * on genuinely ambiguous rosters, instead of a ban on the flagship shape itself.
 */
export function compilePairedMajorityDeltaProfile(input: {
  readonly workspaceDir: string;
  readonly draft: DraftDocument;
  readonly benchmark: BenchmarkRecord;
  readonly analysis: Analysis;
  /** See the closure's own `pathPrefix` (M2). Optional; defaults to `"spec.analysis"`. */
  readonly pathPrefix?: string;
}): PairedMajorityDeltaParameters {
  const { analysis } = input;
  if (analysis.baseline !== undefined || analysis.candidate !== undefined) {
    refuse(
      "validation",
      input.pathPrefix ?? "spec.analysis",
      "paired-majority-delta derives its own baseline/candidate from the evidence-declaring arm and does not accept caller-supplied baseline or candidate arms",
    );
  }
  const closure = deriveBinaryInstrumentFamilyClosure({
    workspaceDir: input.workspaceDir,
    draft: input.draft,
    benchmark: input.benchmark,
    analysis,
    methodLabel: "paired-majority-delta",
    pathPrefix: input.pathPrefix,
  });

  const spec = input.draft.spec;
  if (closure.declaringArmCount !== 1) {
    refuse(
      "conflict",
      "spec.evaluationRuntime.selectionManifestSha256",
      `paired-majority-delta@1 requires exactly one arm whose instrument declares evidence to name candidate/baseline; found ${closure.declaringArmCount}`,
    );
  }
  const declaringArmIndex = closure.declaringArmIndex!;
  const declaringInstrument = closure.armInstruments[declaringArmIndex]!;
  const twinIndexes = closure.armInstruments.flatMap((instrument, index) => (
    index !== declaringArmIndex && isEvidenceFreeTwin(declaringInstrument, instrument) ? [index] : []
  ));
  if (twinIndexes.length === 0) {
    refuse(
      "conflict",
      "spec.arms",
      `paired-majority-delta@1 found no evidence-free twin for declaring arm "${spec.arms[declaringArmIndex]!.armId}": no other arm's instrument is identical to it once the evidence interpolation is stripped`,
    );
  }
  if (twinIndexes.length > 1) {
    refuse(
      "conflict",
      "spec.arms",
      `paired-majority-delta@1 found ${twinIndexes.length} evidence-free twins for declaring arm "${spec.arms[declaringArmIndex]!.armId}" (${twinIndexes.map((index) => `"${spec.arms[index]!.armId}"`).join(", ")}); the twin must be unique`,
    );
  }
  const candidate = spec.arms[declaringArmIndex]!.armId;
  const baseline = spec.arms[twinIndexes[0]!]!.armId;

  const parameters: PairedMajorityDeltaParameters = {
    verdictRule: "sole",
    k: closure.k,
    reduction: "strict-majority",
    measurementProfile: BINARY_INSTRUMENT_MEASUREMENT_PROFILE,
    candidateClasses: closure.candidateClasses,
    strata: closure.strata,
    parserInvalidPolicy: "reject",
    truthAdmission: closure.truthAdmission,
    baseline,
    candidate,
    // Frozen derivation constants (spec §7.2a): sealed FROM the aggregate package's own exported
    // names, never retyped, so this module can never drift from what the method itself compares
    // against at compute time.
    seed: PAIRED_MAJORITY_DELTA_SEED,
    resamples: PAIRED_MAJORITY_DELTA_RESAMPLES,
    alpha: PAIRED_MAJORITY_DELTA_ALPHA,
  };
  const validation = validatePairedMajorityDeltaParameters(
    parameters as unknown as Readonly<Record<string, unknown>>,
  );
  if (!validation.ok) {
    refuse("validation", input.pathPrefix ?? "spec.analysis", `derived paired-majority-delta parameters are invalid: ${validation.issues.join("; ")}`);
  }
  return parameters;
}
