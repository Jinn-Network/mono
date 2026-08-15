import {
  compareCodeUnitStrings,
  isCalendarStrictRfc3339,
  type MatrixRecord,
} from "@jinn-network/benchmarking-records";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import {
  reduceBinaryInstrumentReplicates,
  type BinaryInstrumentExcludedItem,
  type BinaryInstrumentItemContext,
  type BinaryInstrumentItemDecision,
  type BinaryInstrumentParsedCellInput,
  type BinaryInstrumentReducedCall,
} from "./binary-instrument.js";
import type { Method, MethodComputeInput } from "./method.js";
import {
  MethodInputError,
  matrixRunDigest,
  resolveResultEvaluationStatement,
  resolveRun,
} from "./resolved-inputs.js";
import { wilsonInterval } from "./stats/wilson.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_URI = /^sha256:[a-f0-9]{64}$/;
const CANDIDATE_CLASS = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

const INSTRUMENT_REQUIREMENT_KEY = "network.jinn.binary-judgment.instrument";
const ITEM_COMMITMENT_KEY = "network.jinn.binary-judgment.item-sha256";
const TASK_PROFILE_URI = "https://spec.jinn.network/task-profiles/binary-judgment/1.0";
const TASK_PROFILE_SHA256 = "40f43e4ab9942f310da716e28ba2c1b8731fdf3c3837bb821573d4d8a0ec259d";
const INSTRUMENT_PROTOCOL = "https://spec.jinn.network/binary-judgment/judge-instrument/v1";
const ANALYSIS_CONTEXT_PROTOCOL = "https://spec.jinn.network/binary-judgment/analysis-context/v1";
const LABEL_RESOLUTION_PROTOCOL = "https://spec.jinn.network/binary-judgment/label-resolution/v1";
const EVALUATION_SPEC_PROTOCOL = "https://spec.jinn.network/profiles/evaluation-spec/v1";
const EVALUATION_PARSER_ID = "network.jinn.parser.binary-judgment-evaluation";
const EVALUATION_PARSER_VERSION = "1.0.0";
const EVALUATION_PARSER_SHA256 = "41b36eaffbac8c78133afd2075ec32fd73ed324395fe281dee525db17653937f";
const RESPONSE_PARSER_ID = "network.jinn.parser.binary-accept-reject";
const RESPONSE_PARSER_VERSION = "1.0.0";
const RESPONSE_PARSER_DIGEST = "sha256:02aa652770de9e74415cd206c8741b6148e3ea82c21773983a6d8c66030d0073";

export const BINARY_INSTRUMENT_MEASUREMENT_PROFILE = "binary-instrument@1" as const;
export const BINARY_INSTRUMENT_MEASUREMENTS = {
  judgeDecision: "judgeDecision",
  truthLabel: "truthLabel",
  agreement: "agreement",
  parseValid: "parseValid",
  candidateClass: "candidateClass",
  stratum: "stratum",
  labelResolutionSha256: "labelResolutionSha256",
  instrumentSha256: "instrumentSha256",
} as const;

const MEASUREMENT_TYPES = new Map<string, "string" | "boolean">([
  [BINARY_INSTRUMENT_MEASUREMENTS.judgeDecision, "string"],
  [BINARY_INSTRUMENT_MEASUREMENTS.truthLabel, "string"],
  [BINARY_INSTRUMENT_MEASUREMENTS.agreement, "boolean"],
  [BINARY_INSTRUMENT_MEASUREMENTS.parseValid, "boolean"],
  [BINARY_INSTRUMENT_MEASUREMENTS.candidateClass, "string"],
  [BINARY_INSTRUMENT_MEASUREMENTS.stratum, "string"],
  [BINARY_INSTRUMENT_MEASUREMENTS.labelResolutionSha256, "string"],
  [BINARY_INSTRUMENT_MEASUREMENTS.instrumentSha256, "string"],
]);
const MEASUREMENT_NAMES = [...MEASUREMENT_TYPES.keys()].sort(compareCodeUnitStrings);

export const BINARY_INSTRUMENT_PARAMETER_SCHEMA: Method["parameterSchema"] = {
  type: "object",
  required: [
    "verdictRule",
    "k",
    "reduction",
    "measurementProfile",
    "candidateClasses",
    "strata",
    "parserInvalidPolicy",
    "truthAdmission",
    "intervalAlpha",
  ],
  properties: {
    verdictRule: { enum: ["sole"] },
    k: { type: "integer", minimum: 1 },
    reduction: { enum: ["strict-majority"] },
    measurementProfile: { enum: [BINARY_INSTRUMENT_MEASUREMENT_PROFILE] },
    candidateClasses: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", pattern: CANDIDATE_CLASS.source },
    },
    strata: {
      type: "array",
      prefixItems: [{ const: "core" }, { const: "stress" }],
      minItems: 2,
      maxItems: 2,
    },
    parserInvalidPolicy: { enum: ["reject"] },
    truthAdmission: { enum: ["two-human-unanimous", "operator-only"] },
    intervalAlpha: { enum: ["0.05"] },
  },
  additionalProperties: false,
};

export interface BinaryInstrumentParameters {
  readonly verdictRule: "sole";
  readonly k: number;
  readonly reduction: "strict-majority";
  readonly measurementProfile: typeof BINARY_INSTRUMENT_MEASUREMENT_PROFILE;
  readonly candidateClasses: readonly string[];
  readonly strata: readonly ["core", "stress"];
  readonly parserInvalidPolicy: "reject";
  readonly truthAdmission: "two-human-unanimous" | "operator-only";
  readonly intervalAlpha: "0.05";
}

export function validateBinaryInstrumentParameters(
  parameters: Readonly<Record<string, unknown>>,
): { readonly ok: true } | { readonly ok: false; readonly issues: readonly string[] } {
  const issues: string[] = [];
  const required = new Set(BINARY_INSTRUMENT_PARAMETER_SCHEMA.required);
  for (const key of required) {
    if (!Object.hasOwn(parameters, key)) issues.push(`missing required parameter "${key}"`);
  }
  for (const key of Object.keys(parameters)) {
    if (!required.has(key)) issues.push(`unknown parameter "${key}"`);
  }
  if (parameters["verdictRule"] !== "sole") issues.push('parameter "verdictRule" must be "sole"');
  const k = parameters["k"];
  if (!Number.isSafeInteger(k) || typeof k !== "number" || k < 1 || k % 2 === 0) {
    issues.push('parameter "k" must be an odd positive safe integer');
  }
  if (parameters["reduction"] !== "strict-majority") {
    issues.push('parameter "reduction" must be "strict-majority"');
  }
  if (parameters["measurementProfile"] !== BINARY_INSTRUMENT_MEASUREMENT_PROFILE) {
    issues.push(`parameter "measurementProfile" must be "${BINARY_INSTRUMENT_MEASUREMENT_PROFILE}"`);
  }
  const candidateClasses = parameters["candidateClasses"];
  if (
    !Array.isArray(candidateClasses)
    || candidateClasses.length === 0
    || candidateClasses.some((value) => typeof value !== "string" || !CANDIDATE_CLASS.test(value))
  ) {
    issues.push('parameter "candidateClasses" must be a non-empty array of closed class names');
  } else {
    const sorted = [...candidateClasses].sort(compareCodeUnitStrings);
    if (
      new Set(candidateClasses).size !== candidateClasses.length
      || sorted.some((value, index) => value !== candidateClasses[index])
    ) {
      issues.push('parameter "candidateClasses" must be unique and code-unit sorted');
    }
  }
  const strata = parameters["strata"];
  if (!Array.isArray(strata) || strata.length !== 2 || strata[0] !== "core" || strata[1] !== "stress") {
    issues.push('parameter "strata" must be exactly ["core","stress"]');
  }
  if (parameters["parserInvalidPolicy"] !== "reject") {
    issues.push('parameter "parserInvalidPolicy" must be "reject"');
  }
  if (
    parameters["truthAdmission"] !== "two-human-unanimous"
    && parameters["truthAdmission"] !== "operator-only"
  ) {
    issues.push('parameter "truthAdmission" is outside its enum');
  }
  if (parameters["intervalAlpha"] !== "0.05") {
    issues.push('parameter "intervalAlpha" must be "0.05"');
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function parametersFrom(input: Readonly<Record<string, unknown>>): BinaryInstrumentParameters {
  const validation = validateBinaryInstrumentParameters(input);
  if (!validation.ok) throw new Error(`invalid binary-instrument@1 parameters: ${validation.issues.join("; ")}`);
  return input as unknown as BinaryInstrumentParameters;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function wireSha256(value: unknown, digest: string, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !SHA256_URI.test(value)) {
    throw new MethodInputError("binary-record-malformed", digest, `${label} must be sha256:<64 lowercase hex>`);
  }
  return value as `sha256:${string}`;
}

/** Explicit normalization point between profile wire values and F5's internal bare-hex types. */
function bareSha256(value: unknown, digest: string, label: string): string {
  return wireSha256(value, digest, label).slice("sha256:".length);
}

function digestObjectSha256(value: unknown, digest: string, label: string): string {
  if (!isObject(value) || typeof value["sha256"] !== "string" || !SHA256.test(value["sha256"])) {
    throw new MethodInputError("binary-record-malformed", digest, `${label} must carry one lowercase sha256 digest`);
  }
  return value["sha256"];
}

function resolveExactJson(
  digest: `sha256:${string}`,
  resolve: ((digest: string) => Uint8Array | undefined) | undefined,
  label: string,
): Record<string, unknown> {
  if (resolve === undefined) {
    throw new MethodInputError("binary-record-unavailable", digest, `${label} requires resolveRecordBytes`);
  }
  const bytes = resolve(digest);
  if (bytes === undefined) {
    throw new MethodInputError("binary-record-unavailable", digest, `${label} bytes are unavailable`);
  }
  const actual = recordDigest(bytes);
  if (actual !== digest) {
    throw new MethodInputError("binary-record-digest-mismatch", digest, `${label} bytes hash to ${actual}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new MethodInputError("binary-record-malformed", digest, `${label} is not UTF-8 JSON: ${String(cause)}`);
  }
  if (!isObject(document)) {
    throw new MethodInputError("binary-record-malformed", digest, `${label} must be a JSON object`);
  }
  let canonical: Uint8Array;
  try {
    canonical = canonicalJsonBytes(document);
  } catch (cause) {
    throw new MethodInputError("binary-record-malformed", digest, `${label} is outside canonical I-JSON: ${String(cause)}`);
  }
  if (!bytesEqual(bytes, canonical)) {
    throw new MethodInputError("binary-record-malformed", digest, `${label} bytes are not canonical JSON`);
  }
  return document;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  digest: string,
  label: string,
): void {
  const actual = Object.keys(value).sort(compareCodeUnitStrings);
  const sortedExpected = [...expected].sort(compareCodeUnitStrings);
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new MethodInputError("binary-record-malformed", digest, `${label} has an unsupported field set`);
  }
}

function requireSortedUniqueDigestPair(
  value: unknown,
  digest: string,
  label: string,
): void {
  if (
    !Array.isArray(value)
    || value.length !== 2
    || value.some((entry) => typeof entry !== "string" || !SHA256_URI.test(entry))
    || !(value[0] < value[1])
  ) {
    throw new MethodInputError(
      "binary-record-malformed",
      digest,
      `${label} must be a strictly sorted unique pair of sha256 digests`,
    );
  }
}

function validateLabelResolution(
  resolution: Record<string, unknown>,
  digest: `sha256:${string}`,
  expected: {
    readonly itemSha256: `sha256:${string}`;
    readonly itemId: string;
    readonly truthLabel: "CORRECT" | "WRONG";
    readonly candidateClass: string;
    readonly stratum: "core" | "stress";
    readonly truthAdmission: BinaryInstrumentParameters["truthAdmission"];
  },
): void {
  const common = [
    "protocol",
    "itemSha256",
    "itemId",
    "humanReviewEvaluationSpecSha256",
    "truthLabel",
    "candidateClass",
    "stratum",
    "resolvedAt",
    "truthAdmission",
  ];
  const truthAdmission = resolution["truthAdmission"];
  if (truthAdmission !== "two-human-unanimous" && truthAdmission !== "operator-only") {
    throw new MethodInputError("binary-record-malformed", digest, "label resolution truthAdmission is unsupported");
  }
  const variant = truthAdmission === "two-human-unanimous"
    ? ["reviewVerdictSha256s", "reviewerRosterSha256", "visibilityReceiptSha256s", "revealReceiptSha256"]
    : ["operatorAssertionSha256"];
  requireExactKeys(resolution, [...common, ...variant], digest, "label resolution");
  if (resolution["protocol"] !== LABEL_RESOLUTION_PROTOCOL) {
    throw new MethodInputError("binary-binding-mismatch", digest, "label resolution protocol is unsupported");
  }
  const itemSha256 = wireSha256(resolution["itemSha256"], digest, "labelResolution.itemSha256");
  if (
    typeof resolution["itemId"] !== "string"
    || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(resolution["itemId"])
  ) {
    throw new MethodInputError("binary-record-malformed", digest, "labelResolution.itemId is not an opaque UUID URN");
  }
  wireSha256(
    resolution["humanReviewEvaluationSpecSha256"],
    digest,
    "labelResolution.humanReviewEvaluationSpecSha256",
  );
  if (!isCalendarStrictRfc3339(resolution["resolvedAt"])) {
    throw new MethodInputError("binary-record-malformed", digest, "labelResolution.resolvedAt must be an RFC 3339 date-time");
  }
  if (resolution["truthLabel"] !== "CORRECT" && resolution["truthLabel"] !== "WRONG") {
    throw new MethodInputError("binary-record-malformed", digest, "labelResolution.truthLabel is unsupported");
  }
  if (typeof resolution["candidateClass"] !== "string" || !CANDIDATE_CLASS.test(resolution["candidateClass"])) {
    throw new MethodInputError("binary-record-malformed", digest, "labelResolution.candidateClass is unsupported");
  }
  if (resolution["stratum"] !== "core" && resolution["stratum"] !== "stress") {
    throw new MethodInputError("binary-record-malformed", digest, "labelResolution.stratum is unsupported");
  }
  if (truthAdmission === "two-human-unanimous") {
    requireSortedUniqueDigestPair(resolution["reviewVerdictSha256s"], digest, "reviewVerdictSha256s");
    wireSha256(resolution["reviewerRosterSha256"], digest, "reviewerRosterSha256");
    requireSortedUniqueDigestPair(resolution["visibilityReceiptSha256s"], digest, "visibilityReceiptSha256s");
    wireSha256(resolution["revealReceiptSha256"], digest, "revealReceiptSha256");
  } else {
    wireSha256(resolution["operatorAssertionSha256"], digest, "operatorAssertionSha256");
  }
  if (truthAdmission !== expected.truthAdmission) {
    throw new MethodInputError("binary-binding-mismatch", digest, "label resolution truthAdmission drifts from the registered method");
  }
  if (
    itemSha256 !== expected.itemSha256
    || resolution["itemId"] !== expected.itemId
    || resolution["truthLabel"] !== expected.truthLabel
    || resolution["candidateClass"] !== expected.candidateClass
    || resolution["stratum"] !== expected.stratum
  ) {
    throw new MethodInputError("binary-binding-mismatch", digest, "label resolution drifts from the admitted analysis context");
  }
}

interface ExpectedTaskBinding {
  readonly taskDigest: string;
  readonly evaluationSpecSha256: string;
  readonly evaluationMethodSha256: string;
  readonly context: BinaryInstrumentItemContext;
}

function measurementDeclarations(spec: Record<string, unknown>, digest: string): void {
  const measurements = spec["measurements"];
  if (!Array.isArray(measurements) || measurements.length !== MEASUREMENT_NAMES.length) {
    throw new MethodInputError("binary-binding-mismatch", digest, "EvaluationSpec must declare exactly the binary-instrument@1 measurements");
  }
  const seen = new Set<string>();
  for (const [index, measurement] of measurements.entries()) {
    if (!isObject(measurement) || typeof measurement["name"] !== "string") {
      throw new MethodInputError("binary-record-malformed", digest, `measurements[${index}] is invalid`);
    }
    const name = measurement["name"];
    const expectedType = MEASUREMENT_TYPES.get(name);
    if (expectedType === undefined || seen.has(name)) {
      throw new MethodInputError("binary-binding-mismatch", digest, `unsupported or duplicate measurement ${name}`);
    }
    seen.add(name);
    if (measurement["type"] !== expectedType || measurement["required"] !== true) {
      throw new MethodInputError("binary-binding-mismatch", digest, `measurement ${name} has the wrong required type`);
    }
  }
  if (MEASUREMENT_NAMES.some((name) => !seen.has(name))) {
    throw new MethodInputError("binary-binding-mismatch", digest, "EvaluationSpec measurement profile is incomplete");
  }
}

function resolveTaskBinding(
  taskDigest: string,
  input: Pick<MethodComputeInput, "resolveTaskBytes" | "resolveRecordBytes">,
  candidateClasses: readonly string[],
  truthAdmission: BinaryInstrumentParameters["truthAdmission"],
): ExpectedTaskBinding {
  const taskWire = `sha256:${taskDigest}` as const;
  const task = resolveExactJson(taskWire, input.resolveTaskBytes, "Task");
  const profile = task["profile"];
  if (
    !isObject(profile)
    || digestObjectSha256(profile["digest"], taskWire, "Task.profile.digest") !== TASK_PROFILE_SHA256
    || (profile["uri"] !== undefined && profile["uri"] !== TASK_PROFILE_URI)
  ) {
    throw new MethodInputError("binary-binding-mismatch", taskWire, "Task does not pin the binary-judgment/1.0 profile");
  }
  const taskItemSha256 = wireSha256(task[ITEM_COMMITMENT_KEY], taskWire, `Task.${ITEM_COMMITMENT_KEY}`);
  const taskRequirements = task["requirements"];
  if (
    Object.hasOwn(task, INSTRUMENT_REQUIREMENT_KEY)
    || (isObject(taskRequirements) && Object.hasOwn(taskRequirements, INSTRUMENT_REQUIREMENT_KEY))
  ) {
    throw new MethodInputError("binary-binding-mismatch", taskWire, "Task must remain arm-neutral and cannot pin an instrument");
  }
  const evaluation = task["evaluation"];
  if (!isObject(evaluation)) {
    throw new MethodInputError("binary-binding-mismatch", taskWire, "Task has no EvaluationSpec descriptor");
  }
  const evaluationSpecSha256 = digestObjectSha256(
    evaluation["digest"],
    taskWire,
    "Task.evaluation.digest",
  );
  const specWire = `sha256:${evaluationSpecSha256}` as const;
  const spec = resolveExactJson(specWire, input.resolveRecordBytes, "EvaluationSpec");
  if (spec["protocol"] !== EVALUATION_SPEC_PROTOCOL || spec["family"] !== "deterministic-process") {
    throw new MethodInputError("binary-binding-mismatch", specWire, "EvaluationSpec is not the deterministic binary-instrument profile");
  }
  measurementDeclarations(spec, specWire);
  const verdictRule = spec["verdictRule"];
  if (
    !isObject(verdictRule)
    || !isObject(verdictRule["threshold"])
    || verdictRule["threshold"]["measurement"] !== BINARY_INSTRUMENT_MEASUREMENTS.agreement
    || verdictRule["threshold"]["op"] !== "eq"
    || verdictRule["threshold"]["value"] !== true
  ) {
    throw new MethodInputError("binary-binding-mismatch", specWire, "EvaluationSpec verdictRule must pass exactly on agreement=true");
  }
  const grader = spec["grader"];
  if (!isObject(grader) || grader["name"] !== EVALUATION_PARSER_ID) {
    throw new MethodInputError("binary-binding-mismatch", specWire, `EvaluationSpec grader must be ${EVALUATION_PARSER_ID}`);
  }
  const evaluationMethodSha256 = digestObjectSha256(grader["digest"], specWire, "EvaluationSpec.grader.digest");
  if (evaluationMethodSha256 !== EVALUATION_PARSER_SHA256) {
    throw new MethodInputError("binary-binding-mismatch", specWire, "EvaluationSpec grader digest is not the frozen binary evaluator semantics");
  }
  const familyBlock = spec["familyBlock"];
  if (!isObject(familyBlock)) {
    throw new MethodInputError("binary-record-malformed", specWire, "EvaluationSpec.familyBlock must be an object");
  }
  const parser = familyBlock["parser"];
  if (
    !isObject(parser)
    || parser["id"] !== EVALUATION_PARSER_ID
    || parser["version"] !== EVALUATION_PARSER_VERSION
    || parser["digest"] !== `sha256:${EVALUATION_PARSER_SHA256}`
    || bareSha256(parser["digest"], specWire, "EvaluationSpec.familyBlock.parser.digest") !== evaluationMethodSha256
  ) {
    throw new MethodInputError("binary-binding-mismatch", specWire, "EvaluationSpec parser identity drifts from its grader");
  }
  const testMaterial = familyBlock["testMaterial"];
  if (!Array.isArray(testMaterial)) {
    throw new MethodInputError("binary-record-malformed", specWire, "EvaluationSpec testMaterial must be an array");
  }
  const contexts = testMaterial.filter((value) => isObject(value) && value["name"] === "analysis-context.json");
  if (contexts.length !== 1 || !isObject(contexts[0])) {
    throw new MethodInputError("binary-binding-mismatch", specWire, "EvaluationSpec must name one analysis-context.json");
  }
  const analysisSha256 = digestObjectSha256(contexts[0]["digest"], specWire, "analysis-context.json digest");
  const analysisWire = `sha256:${analysisSha256}` as const;
  const analysis = resolveExactJson(analysisWire, input.resolveRecordBytes, "analysis context");
  requireExactKeys(
    analysis,
    ["protocol", "itemSha256", "itemId", "labelResolutionSha256", "truthLabel", "candidateClass", "stratum"],
    analysisWire,
    "analysis context",
  );
  if (analysis["protocol"] !== ANALYSIS_CONTEXT_PROTOCOL) {
    throw new MethodInputError("binary-binding-mismatch", analysisWire, "analysis context protocol is unsupported");
  }
  const itemSha256 = wireSha256(analysis["itemSha256"], analysisWire, "analysisContext.itemSha256");
  if (itemSha256 !== taskItemSha256) {
    throw new MethodInputError("binary-binding-mismatch", analysisWire, "analysis context item commitment drifts from the Task");
  }
  const itemId = analysis["itemId"];
  if (
    typeof itemId !== "string"
    || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(itemId)
  ) {
    throw new MethodInputError("binary-record-malformed", analysisWire, "analysisContext.itemId is not an opaque UUID URN");
  }
  const labelResolutionWire = wireSha256(
    analysis["labelResolutionSha256"],
    analysisWire,
    "analysisContext.labelResolutionSha256",
  );
  const truthLabel = analysis["truthLabel"];
  if (truthLabel !== "CORRECT" && truthLabel !== "WRONG") {
    throw new MethodInputError("binary-record-malformed", analysisWire, "analysisContext.truthLabel is unsupported");
  }
  const candidateClass = analysis["candidateClass"];
  if (
    typeof candidateClass !== "string"
    || !CANDIDATE_CLASS.test(candidateClass)
    || !candidateClasses.includes(candidateClass)
  ) {
    throw new MethodInputError("binary-binding-mismatch", analysisWire, "analysisContext.candidateClass is outside the registered vocabulary");
  }
  const stratum = analysis["stratum"];
  if (stratum !== "core" && stratum !== "stress") {
    throw new MethodInputError("binary-record-malformed", analysisWire, "analysisContext.stratum is unsupported");
  }
  const labelResolution = resolveExactJson(labelResolutionWire, input.resolveRecordBytes, "label resolution");
  validateLabelResolution(labelResolution, labelResolutionWire, {
    itemSha256,
    itemId,
    truthLabel,
    candidateClass,
    stratum,
    truthAdmission,
  });
  return {
    taskDigest,
    evaluationSpecSha256,
    evaluationMethodSha256,
    context: {
      analysisContextSha256: analysisSha256,
      truthLabel,
      candidateClass,
      stratum,
      labelResolutionSha256: labelResolutionWire.slice("sha256:".length),
    },
  };
}

function resolveArmInstruments(
  matrix: MatrixRecord,
  input: Pick<MethodComputeInput, "resolveRunBytes" | "resolveRecordBytes">,
  k: number,
): Map<string, string> {
  const run = resolveRun(matrixRunDigest(matrix), input);
  if (run.replicates !== k) {
    throw new MethodInputError(
      "incompatible-run-replicates",
      matrixRunDigest(matrix),
      `binary-instrument@1 parameter k=${k} does not match Run.replicates=${run.replicates}`,
    );
  }
  const matrixArms = [...new Set(matrix.cells.map((cell) => cell.armId))].sort(compareCodeUnitStrings);
  const instruments = new Map<string, string>();
  for (const arm of run.arms) {
    if (!matrixArms.includes(arm.armId)) continue;
    const instrumentWire = wireSha256(
      arm.pinning[INSTRUMENT_REQUIREMENT_KEY],
      matrixRunDigest(matrix),
      `Run arm ${arm.armId} instrument pin`,
    );
    const instrument = resolveExactJson(instrumentWire, input.resolveRecordBytes, `arm ${arm.armId} instrument`);
    if (instrument["protocol"] !== INSTRUMENT_PROTOCOL) {
      throw new MethodInputError("binary-binding-mismatch", instrumentWire, "instrument protocol is unsupported");
    }
    const response = instrument["response"];
    if (!isObject(response) || response["invalidOutputDecision"] !== "REJECT") {
      throw new MethodInputError("binary-binding-mismatch", instrumentWire, "instrument must map invalid output to REJECT");
    }
    const parser = response["parser"];
    if (
      !isObject(parser)
      || parser["id"] !== RESPONSE_PARSER_ID
      || parser["version"] !== RESPONSE_PARSER_VERSION
      || parser["digest"] !== RESPONSE_PARSER_DIGEST
    ) {
      throw new MethodInputError("binary-binding-mismatch", instrumentWire, "instrument parser is not the frozen ACCEPT/REJECT semantics");
    }
    instruments.set(arm.armId, instrumentWire.slice("sha256:".length));
  }
  if (
    instruments.size !== matrixArms.length
    || matrixArms.some((armId) => !instruments.has(armId))
  ) {
    throw new MethodInputError("binary-binding-mismatch", matrixRunDigest(matrix), "Run arms do not exactly cover Matrix arms");
  }
  return instruments;
}

function measurementMap(
  predicate: Readonly<Record<string, unknown>>,
  verdictDigest: string,
): ReadonlyMap<string, string | boolean> {
  const delivered = predicate["measurements"];
  if (!Array.isArray(delivered) || delivered.length !== MEASUREMENT_NAMES.length) {
    throw new MethodInputError("verdict-record-malformed", verdictDigest, "Result Evaluation must deliver exactly eight binary-instrument measurements");
  }
  const measurements = new Map<string, string | boolean>();
  for (const [index, measurement] of delivered.entries()) {
    if (!isObject(measurement)) {
      throw new MethodInputError("verdict-record-malformed", verdictDigest, `measurements[${index}] must be an object`);
    }
    requireExactKeys(measurement, ["name", "value"], verdictDigest, `measurements[${index}]`);
    const name = measurement["name"];
    if (typeof name !== "string" || !MEASUREMENT_TYPES.has(name) || measurements.has(name)) {
      throw new MethodInputError("verdict-record-malformed", verdictDigest, `unsupported or duplicate measurement ${String(name)}`);
    }
    const value = measurement["value"];
    if (typeof value !== MEASUREMENT_TYPES.get(name)) {
      throw new MethodInputError("verdict-record-malformed", verdictDigest, `measurement ${name} has the wrong value type`);
    }
    measurements.set(name, value as string | boolean);
  }
  if (MEASUREMENT_NAMES.some((name) => !measurements.has(name))) {
    throw new MethodInputError("verdict-record-malformed", verdictDigest, "Result Evaluation measurement profile is incomplete");
  }
  return measurements;
}

function descriptorDigest(
  descriptor: unknown,
  verdictDigest: string,
  label: string,
): string {
  if (!isObject(descriptor)) {
    throw new MethodInputError("verdict-record-malformed", verdictDigest, `${label} descriptor is required`);
  }
  return digestObjectSha256(descriptor["digest"], verdictDigest, `${label}.digest`);
}

function resolveCellInput(
  verdictDigest: string,
  cell: MatrixRecord["cells"][number],
  binding: ExpectedTaskBinding,
  expectedInstrument: string,
  input: Pick<MethodComputeInput, "resolveVerdictBytes">,
): BinaryInstrumentParsedCellInput {
  const { statement, predicate } = resolveResultEvaluationStatement(verdictDigest, input);
  if (
    descriptorDigest(predicate["evaluationSpecification"], verdictDigest, "evaluationSpecification")
    !== binding.evaluationSpecSha256
  ) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "Result Evaluation names the wrong EvaluationSpec");
  }
  if (
    descriptorDigest(predicate["evaluationMethod"], verdictDigest, "evaluationMethod")
    !== binding.evaluationMethodSha256
  ) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "Result Evaluation names the wrong evaluation method");
  }
  const taskSubject = predicate["taskSubject"];
  const subjects = statement["subject"];
  if (typeof taskSubject !== "string" || !Array.isArray(subjects)) {
    throw new MethodInputError("verdict-record-malformed", verdictDigest, "Result Evaluation Task subject binding is invalid");
  }
  const taskDescriptors = subjects.filter((subject) => isObject(subject) && subject["name"] === taskSubject);
  if (
    taskDescriptors.length !== 1
    || !isObject(taskDescriptors[0])
    || digestObjectSha256(taskDescriptors[0]["digest"], verdictDigest, "Task subject digest") !== cell.taskDigest
  ) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "Result Evaluation does not bind the exact Matrix Task");
  }
  const measurements = measurementMap(predicate, verdictDigest);
  const judgeDecision = measurements.get(BINARY_INSTRUMENT_MEASUREMENTS.judgeDecision);
  const truthLabel = measurements.get(BINARY_INSTRUMENT_MEASUREMENTS.truthLabel);
  const agreement = measurements.get(BINARY_INSTRUMENT_MEASUREMENTS.agreement);
  const parseValid = measurements.get(BINARY_INSTRUMENT_MEASUREMENTS.parseValid);
  const candidateClass = measurements.get(BINARY_INSTRUMENT_MEASUREMENTS.candidateClass);
  const stratum = measurements.get(BINARY_INSTRUMENT_MEASUREMENTS.stratum);
  const labelResolutionSha256 = bareSha256(
    measurements.get(BINARY_INSTRUMENT_MEASUREMENTS.labelResolutionSha256),
    verdictDigest,
    "measurement labelResolutionSha256",
  );
  const instrumentSha256 = bareSha256(
    measurements.get(BINARY_INSTRUMENT_MEASUREMENTS.instrumentSha256),
    verdictDigest,
    "measurement instrumentSha256",
  );
  if (judgeDecision !== "ACCEPT" && judgeDecision !== "REJECT") {
    throw new MethodInputError("verdict-record-malformed", verdictDigest, "judgeDecision is unsupported");
  }
  if (truthLabel !== "CORRECT" && truthLabel !== "WRONG") {
    throw new MethodInputError("verdict-record-malformed", verdictDigest, "truthLabel is unsupported");
  }
  if (typeof agreement !== "boolean" || typeof parseValid !== "boolean") {
    throw new MethodInputError("verdict-record-malformed", verdictDigest, "agreement and parseValid must be boolean");
  }
  if (parseValid === false && judgeDecision !== "REJECT") {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "parser-invalid output must deterministically map to REJECT");
  }
  const expectedAgreement = (judgeDecision === "ACCEPT" && truthLabel === "CORRECT")
    || (judgeDecision === "REJECT" && truthLabel === "WRONG");
  if (agreement !== expectedAgreement) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "signed agreement contradicts decision and truth");
  }
  const verdict = agreement ? "pass" as const : "fail" as const;
  if (predicate["verdict"] !== verdict) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "Result Evaluation verdict contradicts signed agreement");
  }
  const context = binding.context;
  if (
    truthLabel !== context.truthLabel
    || candidateClass !== context.candidateClass
    || stratum !== context.stratum
    || labelResolutionSha256 !== context.labelResolutionSha256
  ) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "signed measurements drift from the admitted analysis context");
  }
  if (instrumentSha256 !== expectedInstrument) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "signed instrument drifts from the Run arm pin");
  }
  return {
    cellKey: cell.cellKey,
    verdictDigest,
    verdict,
    judgeDecision,
    parseValid,
    instrumentSha256,
    context: { ...context },
  };
}

interface RateProjection {
  readonly numerator: number;
  readonly denominator: number;
  readonly estimate: string | null;
  readonly wilsonInterval: { readonly low: string; readonly high: string } | null;
  readonly withheldReason?: "zero-denominator";
}

function fixed4(value: number): string {
  return value.toFixed(4);
}

function rateProjection(numerator: number, denominator: number): RateProjection {
  if (denominator === 0) {
    return {
      numerator,
      denominator,
      estimate: null,
      wilsonInterval: null,
      withheldReason: "zero-denominator",
    };
  }
  const interval = wilsonInterval(numerator, denominator);
  return {
    numerator,
    denominator,
    estimate: fixed4(interval.p),
    wilsonInterval: { low: fixed4(interval.lo), high: fixed4(interval.hi) },
  };
}

function projection(
  items: readonly BinaryInstrumentItemDecision[],
  excluded: readonly BinaryInstrumentExcludedItem[],
  calls: readonly BinaryInstrumentReducedCall[],
  k: number,
) {
  let correctAccepted = 0;
  let correctRejected = 0;
  let wrongAccepted = 0;
  let wrongRejected = 0;
  for (const item of items) {
    if (item.context.truthLabel === "CORRECT" && item.decision === "ACCEPT") correctAccepted += 1;
    else if (item.context.truthLabel === "CORRECT") correctRejected += 1;
    else if (item.decision === "ACCEPT") wrongAccepted += 1;
    else wrongRejected += 1;
  }
  const correct = correctAccepted + correctRejected;
  const wrong = wrongAccepted + wrongRejected;
  const expectedItems = items.length + excluded.length;
  const unstable = items.filter((item) => item.unstable).length;
  const parseInvalid = calls.filter((call) => !call.parseValid).length;
  return {
    item: {
      expected: expectedItems,
      complete: items.length,
      excluded: excluded.length,
      unstable,
    },
    call: {
      expected: expectedItems * k,
      evaluated: calls.length,
      parseInvalid,
    },
    confusion: { correctAccepted, correctRejected, wrongAccepted, wrongRejected },
    agreement: rateProjection(correctAccepted + wrongRejected, items.length),
    falseAccept: rateProjection(wrongAccepted, wrong),
    falseReject: rateProjection(correctRejected, correct),
    instability: rateProjection(unstable, items.length),
    parserInvalid: rateProjection(parseInvalid, calls.length),
  };
}

function wireContext(context: BinaryInstrumentItemContext) {
  return {
    analysisContextSha256: `sha256:${context.analysisContextSha256}`,
    truthLabel: context.truthLabel,
    candidateClass: context.candidateClass,
    stratum: context.stratum,
    labelResolutionSha256: `sha256:${context.labelResolutionSha256}`,
  };
}

export type BinaryInstrumentQualificationComputeInput = Omit<MethodComputeInput, "subjects"> & {
  readonly subjectSha256: string;
  readonly matrices: readonly [MatrixRecord];
};

/** Pure registered-method core. All external bytes enter only through digest-bound resolver ports. */
export function computeBinaryInstrumentQualification(
  input: BinaryInstrumentQualificationComputeInput,
): unknown {
  const parameters = parametersFrom(input.parameters);
  if (input.verdictRule !== "sole") {
    throw new Error(`binary-instrument@1 requires MethodComputeInput.verdictRule=sole; got ${input.verdictRule}`);
  }
  if (input.resolveRecordBytes === undefined) {
    throw new MethodInputError(
      "binary-record-unavailable",
      `sha256:${input.subjectSha256}`,
      "binary-instrument@1 requires resolveRecordBytes",
    );
  }
  const matrix = input.matrices[0];
  const instruments = resolveArmInstruments(matrix, input, parameters.k);
  const taskDigests = [...new Set(matrix.cells.map((cell) => cell.taskDigest))]
    .sort(compareCodeUnitStrings);
  const bindings = new Map(taskDigests.map((taskDigest) => [
    taskDigest,
    resolveTaskBinding(
      taskDigest,
      input,
      parameters.candidateClasses,
      parameters.truthAdmission,
    ),
  ]));
  const cells: BinaryInstrumentParsedCellInput[] = [];
  const verdictCells = new Map<string, string>();
  for (const cell of matrix.cells) {
    if (cell.outcome !== "judged" || cell.validVerdicts.length !== 1) continue;
    const verdictDigest = cell.validVerdicts[0]!;
    const firstCell = verdictCells.get(verdictDigest);
    if (firstCell !== undefined) {
      throw new MethodInputError(
        "binary-binding-mismatch",
        verdictDigest,
        `sole Result Evaluation is reused across Matrix cells ${firstCell} and ${cell.cellKey}`,
      );
    }
    verdictCells.set(verdictDigest, cell.cellKey);
    cells.push(resolveCellInput(
      verdictDigest,
      cell,
      bindings.get(cell.taskDigest)!,
      instruments.get(cell.armId)!,
      input,
    ));
  }
  const reduction = reduceBinaryInstrumentReplicates({
    subjectSha256: input.subjectSha256,
    matrix,
    k: parameters.k,
    contexts: taskDigests.map((taskDigest) => ({
      taskDigest,
      context: bindings.get(taskDigest)!.context,
    })),
    instruments: [...instruments.entries()]
      .map(([armId, instrumentSha256]) => ({ armId, instrumentSha256 }))
      .sort((left, right) => compareCodeUnitStrings(left.armId, right.armId)),
    cells,
  });

  const arms: Record<string, unknown> = Object.create(null);
  for (const armId of [...instruments.keys()].sort(compareCodeUnitStrings)) {
    const armItems = reduction.items.filter((item) => item.armId === armId);
    const armExcluded = reduction.excluded.filter((item) => item.armId === armId);
    const armCalls = reduction.evaluatedCalls.filter((call) => call.armId === armId);
    const byCandidateClass: Record<string, unknown> = Object.create(null);
    for (const candidateClass of parameters.candidateClasses) {
      byCandidateClass[candidateClass] = projection(
        armItems.filter((item) => item.context.candidateClass === candidateClass),
        armExcluded.filter((item) => item.context.candidateClass === candidateClass),
        armCalls.filter((call) => call.context.candidateClass === candidateClass),
        parameters.k,
      );
    }
    const byStratum: Record<string, unknown> = Object.create(null);
    for (const stratum of parameters.strata) {
      byStratum[stratum] = projection(
        armItems.filter((item) => item.context.stratum === stratum),
        armExcluded.filter((item) => item.context.stratum === stratum),
        armCalls.filter((call) => call.context.stratum === stratum),
        parameters.k,
      );
    }
    arms[armId] = {
      instrumentSha256: `sha256:${instruments.get(armId)!}`,
      ...projection(armItems, armExcluded, armCalls, parameters.k),
      byCandidateClass,
      byStratum,
    };
  }

  return {
    configuration: {
      verdictRule: parameters.verdictRule,
      k: parameters.k,
      reduction: parameters.reduction,
      measurementProfile: parameters.measurementProfile,
      candidateClasses: [...parameters.candidateClasses],
      strata: [...parameters.strata],
      parserInvalidPolicy: parameters.parserInvalidPolicy,
      truthAdmission: parameters.truthAdmission,
      intervalAlpha: parameters.intervalAlpha,
    },
    arms,
    itemDecisions: reduction.items.map((item) => ({
      taskDigest: item.taskDigest,
      armId: item.armId,
      instrumentSha256: `sha256:${item.instrumentSha256}`,
      context: wireContext(item.context),
      cellKeys: [...item.cellKeys],
      accepted: item.accepted,
      rejected: item.rejected,
      decision: item.decision,
      unstable: item.unstable,
    })),
    excluded: {
      count: reduction.excluded.length,
      items: reduction.excluded.map((item) => ({
        taskDigest: item.taskDigest,
        armId: item.armId,
        instrumentSha256: `sha256:${item.instrumentSha256}`,
        context: wireContext(item.context),
        cellKeys: [...item.cellKeys],
        reasons: item.reasons.map((reason) => ({
          reason: reason.reason,
          cellKeys: [...reason.cellKeys],
        })),
      })),
    },
    conflicted: reduction.conflicted,
  };
}
