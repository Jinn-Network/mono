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
const TASK_PROTOCOL = "https://spec.jinn.network/profiles/task-execution/v1";
const TASK_PROFILE_URI = "https://spec.jinn.network/task-profiles/binary-judgment/1.0";
const TASK_PROFILE_SHA256 = "40f43e4ab9942f310da716e28ba2c1b8731fdf3c3837bb821573d4d8a0ec259d";
const INSTRUMENT_PROTOCOL = "https://spec.jinn.network/binary-judgment/judge-instrument/v1";
const OBSERVATION_PROTOCOL = "https://spec.jinn.network/binary-judgment/judge-observation/v1";
const ANALYSIS_CONTEXT_PROTOCOL = "https://spec.jinn.network/binary-judgment/analysis-context/v1";
const LABEL_RESOLUTION_PROTOCOL = "https://spec.jinn.network/binary-judgment/label-resolution/v1";
const EVALUATION_SPEC_PROTOCOL = "https://spec.jinn.network/profiles/evaluation-spec/v1";
const EVALUATION_SEMANTICS_VERSION = "4";
const RESPONSE_MEDIA_TYPE = "text/plain; charset=utf-8";
const OBSERVATION_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.observation.v1+json";
const INSPECT_LOG_MEDIA_TYPE = "application/vnd.inspect-ai.eval-log+json";
const ANALYSIS_CONTEXT_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.analysis-context.v1+json";
const LABEL_RESOLUTION_MEDIA_TYPE = "application/vnd.jinn.binary-judgment.label-resolution.v1+json";
const LABEL_RESOLUTION_NAME = "label-resolution.json";
const MODEL_ID = "gpt-5.6-luna";
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
  if (!isObject(value)) {
    throw new MethodInputError("binary-record-malformed", digest, `${label} must carry one lowercase sha256 digest`);
  }
  requireExactKeys(value, ["sha256"], digest, label);
  if (typeof value["sha256"] !== "string" || !SHA256.test(value["sha256"])) {
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

function requireDigestDescriptor(
  value: unknown,
  digest: string,
  label: string,
): string {
  if (!isObject(value)) {
    throw new MethodInputError("binary-record-malformed", digest, `${label} must be a descriptor`);
  }
  const digestMap = value["digest"];
  if (!isObject(digestMap)) {
    throw new MethodInputError("binary-record-malformed", digest, `${label}.digest is required`);
  }
  requireExactKeys(digestMap, ["sha256"], digest, `${label}.digest`);
  return digestObjectSha256(digestMap, digest, `${label}.digest`);
}

function requireSourceDescriptor(value: unknown, digest: string, label: string): void {
  if (!isObject(value)) {
    throw new MethodInputError("binary-record-malformed", digest, `${label} must be a source descriptor`);
  }
  const allowed = ["name", "uri", "digest", "mediaType", "downloadLocation"];
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) {
    throw new MethodInputError("binary-record-malformed", digest, `${label} has an unsupported field set`);
  }
  for (const key of ["uri"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new MethodInputError("binary-record-malformed", digest, `${label}.${key} must be non-empty`);
    }
  }
  for (const key of ["name", "mediaType", "downloadLocation"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length === 0)) {
      throw new MethodInputError("binary-record-malformed", digest, `${label}.${key} must be non-empty when present`);
    }
  }
  requireDigestDescriptor(value, digest, label);
}

interface ResolvedBinaryPayload {
  readonly itemId: string;
  readonly question: string;
  readonly referenceAnswer: string;
  readonly candidateAnswer: string;
  readonly provenance: readonly Readonly<Record<string, unknown>>[];
}

function validateTaskPayload(value: unknown, digest: string): ResolvedBinaryPayload {
  if (!isObject(value)) {
    throw new MethodInputError("binary-record-malformed", digest, "Task.payload must be an object");
  }
  requireExactKeys(
    value,
    ["itemId", "question", "referenceAnswer", "candidateAnswer", "provenance"],
    digest,
    "Task.payload",
  );
  if (
    typeof value["itemId"] !== "string"
    || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value["itemId"])
  ) {
    throw new MethodInputError("binary-record-malformed", digest, "Task.payload.itemId must be an opaque UUID URN");
  }
  for (const key of ["question", "referenceAnswer", "candidateAnswer"] as const) {
    if (typeof value[key] !== "string") {
      throw new MethodInputError("binary-record-malformed", digest, `Task.payload.${key} must be a string`);
    }
  }
  const provenance = value["provenance"];
  if (!Array.isArray(provenance) || provenance.length === 0) {
    throw new MethodInputError("binary-record-malformed", digest, "Task.payload.provenance must be non-empty");
  }
  for (const [index, descriptor] of provenance.entries()) {
    if (!isObject(descriptor)) {
      throw new MethodInputError("binary-record-malformed", digest, `Task.payload.provenance[${index}] must be an object`);
    }
    requireExactKeys(descriptor, ["digest"], digest, `Task.payload.provenance[${index}]`);
    requireDigestDescriptor(descriptor, digest, `Task.payload.provenance[${index}]`);
  }
  return value as unknown as ResolvedBinaryPayload;
}

function validateTaskOutputs(value: unknown, digest: string): void {
  const expected = [
    { name: "judge-response", mediaType: RESPONSE_MEDIA_TYPE, required: true },
    { name: "judge-observation", mediaType: OBSERVATION_MEDIA_TYPE, required: true },
    { name: "inspect-log", mediaType: INSPECT_LOG_MEDIA_TYPE, required: false },
  ];
  if (
    !Array.isArray(value)
    || !bytesEqual(canonicalJsonBytes(value), canonicalJsonBytes(expected))
  ) {
    throw new MethodInputError("binary-binding-mismatch", digest, "Task.outputs must equal the frozen three-slot binary judge contract");
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
  readonly payload: ResolvedBinaryPayload;
  readonly context: BinaryInstrumentItemContext;
}

function measurementDeclarations(spec: Record<string, unknown>, digest: string): void {
  const measurements = spec["measurements"];
  if (!Array.isArray(measurements) || measurements.length !== MEASUREMENT_NAMES.length) {
    throw new MethodInputError("binary-binding-mismatch", digest, "EvaluationSpec must declare exactly the binary-instrument@1 measurements");
  }
  const expected = [
    [BINARY_INSTRUMENT_MEASUREMENTS.judgeDecision, "string"],
    [BINARY_INSTRUMENT_MEASUREMENTS.truthLabel, "string"],
    [BINARY_INSTRUMENT_MEASUREMENTS.agreement, "boolean"],
    [BINARY_INSTRUMENT_MEASUREMENTS.parseValid, "boolean"],
    [BINARY_INSTRUMENT_MEASUREMENTS.candidateClass, "string"],
    [BINARY_INSTRUMENT_MEASUREMENTS.stratum, "string"],
    [BINARY_INSTRUMENT_MEASUREMENTS.labelResolutionSha256, "string"],
    [BINARY_INSTRUMENT_MEASUREMENTS.instrumentSha256, "string"],
  ] as const;
  for (const [index, measurement] of measurements.entries()) {
    if (!isObject(measurement) || typeof measurement["name"] !== "string") {
      throw new MethodInputError("binary-record-malformed", digest, `measurements[${index}] is invalid`);
    }
    requireExactKeys(measurement, ["name", "type", "required"], digest, `measurements[${index}]`);
    const [expectedName, expectedType] = expected[index]!;
    if (
      measurement["name"] !== expectedName
      || measurement["type"] !== expectedType
      || measurement["required"] !== true
    ) {
      throw new MethodInputError("binary-binding-mismatch", digest, `measurement ${index} drifts from the frozen profile`);
    }
  }
}

function requireEmptyObject(value: unknown, digest: string, label: string): void {
  if (!isObject(value) || Object.keys(value).length !== 0) {
    throw new MethodInputError("binary-binding-mismatch", digest, `${label} must be an empty object`);
  }
}

function validateEvaluationSpecShape(spec: Record<string, unknown>, digest: `sha256:${string}`): void {
  requireExactKeys(
    spec,
    ["protocol", "semanticsVersion", "family", "grader", "familyBlock", "measurements", "verdictRule", "unscorable", "evidenceConventions"],
    digest,
    "EvaluationSpec",
  );
  if (
    spec["protocol"] !== EVALUATION_SPEC_PROTOCOL
    || spec["semanticsVersion"] !== EVALUATION_SEMANTICS_VERSION
    || spec["family"] !== "deterministic-process"
  ) {
    throw new MethodInputError("binary-binding-mismatch", digest, "EvaluationSpec identity is not the frozen deterministic binary profile");
  }
  if (!Array.isArray(spec["unscorable"]) || spec["unscorable"].length !== 0) {
    throw new MethodInputError("binary-binding-mismatch", digest, "EvaluationSpec.unscorable must be empty");
  }
  const evidence = spec["evidenceConventions"];
  if (!isObject(evidence)) {
    throw new MethodInputError("binary-record-malformed", digest, "EvaluationSpec.evidenceConventions must be an object");
  }
  requireExactKeys(evidence, ["requiredRefs"], digest, "EvaluationSpec.evidenceConventions");
  if (
    !Array.isArray(evidence["requiredRefs"])
    || evidence["requiredRefs"].length !== 1
    || evidence["requiredRefs"][0] !== LABEL_RESOLUTION_NAME
  ) {
    throw new MethodInputError("binary-binding-mismatch", digest, "EvaluationSpec must require exact label-resolution evidence");
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
  requireExactKeys(
    task,
    ["protocol", "profile", "instructions", "payload", "outputs", "evaluation", "author", ITEM_COMMITMENT_KEY],
    taskWire,
    "Task",
  );
  if (
    task["protocol"] !== TASK_PROTOCOL
    || task["instructions"] !== "Return exactly ACCEPT or REJECT."
    || typeof task["author"] !== "string"
    || task["author"].length === 0
  ) {
    throw new MethodInputError("binary-binding-mismatch", taskWire, "Task is not a binary task-execution/v1 record");
  }
  const profile = task["profile"];
  if (isObject(profile)) {
    requireExactKeys(profile, ["uri", "digest"], taskWire, "Task.profile");
  }
  if (
    !isObject(profile)
    || digestObjectSha256(profile["digest"], taskWire, "Task.profile.digest") !== TASK_PROFILE_SHA256
    || profile["uri"] !== TASK_PROFILE_URI
  ) {
    throw new MethodInputError("binary-binding-mismatch", taskWire, "Task does not pin the binary-judgment/1.0 profile");
  }
  const payload = validateTaskPayload(task["payload"], taskWire);
  validateTaskOutputs(task["outputs"], taskWire);
  const taskItemSha256 = wireSha256(task[ITEM_COMMITMENT_KEY], taskWire, `Task.${ITEM_COMMITMENT_KEY}`);
  const recomputedItemSha256 = recordDigest(canonicalJsonBytes(payload));
  if (taskItemSha256 !== recomputedItemSha256) {
    throw new MethodInputError("binary-binding-mismatch", taskWire, "Task item commitment does not match the closed solver-visible payload");
  }
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
  requireExactKeys(evaluation, ["digest"], taskWire, "Task.evaluation");
  const evaluationSpecSha256 = digestObjectSha256(
    evaluation["digest"],
    taskWire,
    "Task.evaluation.digest",
  );
  const specWire = `sha256:${evaluationSpecSha256}` as const;
  const spec = resolveExactJson(specWire, input.resolveRecordBytes, "EvaluationSpec");
  validateEvaluationSpecShape(spec, specWire);
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
  if (!isObject(grader)) {
    throw new MethodInputError("binary-record-malformed", specWire, "EvaluationSpec grader must be one descriptor");
  }
  requireExactKeys(grader, ["name", "digest", "accessClass"], specWire, "EvaluationSpec.grader");
  if (grader["name"] !== EVALUATION_PARSER_ID || grader["accessClass"] !== "public") {
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
  requireExactKeys(
    familyBlock,
    ["image", "platform", "workspace", "testMaterial", "parser", "transitions", "timeout"],
    specWire,
    "EvaluationSpec.familyBlock",
  );
  requireDigestDescriptor(familyBlock["image"], specWire, "EvaluationSpec.familyBlock.image");
  if (familyBlock["platform"] !== "linux/amd64") {
    throw new MethodInputError("binary-binding-mismatch", specWire, "EvaluationSpec platform must be linux/amd64");
  }
  requireEmptyObject(familyBlock["workspace"], specWire, "EvaluationSpec.familyBlock.workspace");
  const transitions = familyBlock["transitions"];
  if (!isObject(transitions)) {
    throw new MethodInputError("binary-record-malformed", specWire, "EvaluationSpec transitions must be an object");
  }
  requireExactKeys(transitions, ["failToPass", "passToPass"], specWire, "EvaluationSpec.familyBlock.transitions");
  if (
    !Array.isArray(transitions["failToPass"])
    || transitions["failToPass"].length !== 0
    || !Array.isArray(transitions["passToPass"])
    || transitions["passToPass"].length !== 0
  ) {
    throw new MethodInputError("binary-binding-mismatch", specWire, "EvaluationSpec transitions must be empty");
  }
  if (!Number.isSafeInteger(familyBlock["timeout"]) || (familyBlock["timeout"] as number) < 1) {
    throw new MethodInputError("binary-record-malformed", specWire, "EvaluationSpec timeout must be a positive safe integer");
  }
  const parser = familyBlock["parser"];
  if (isObject(parser)) {
    requireExactKeys(parser, ["id", "version", "digest"], specWire, "EvaluationSpec.familyBlock.parser");
  }
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
  if (!Array.isArray(testMaterial) || testMaterial.length !== 1) {
    throw new MethodInputError("binary-record-malformed", specWire, "EvaluationSpec testMaterial must be an array");
  }
  const contexts = testMaterial.filter((value) => isObject(value) && value["name"] === "analysis-context.json");
  if (contexts.length !== 1 || !isObject(contexts[0])) {
    throw new MethodInputError("binary-binding-mismatch", specWire, "EvaluationSpec must name one analysis-context.json");
  }
  requireExactKeys(
    contexts[0],
    ["name", "digest", "mediaType", "accessClass"],
    specWire,
    "EvaluationSpec analysis-context descriptor",
  );
  if (contexts[0]["mediaType"] !== ANALYSIS_CONTEXT_MEDIA_TYPE || contexts[0]["accessClass"] !== "private") {
    throw new MethodInputError("binary-binding-mismatch", specWire, "EvaluationSpec analysis-context descriptor is not private exact material");
  }
  const analysisSha256 = digestObjectSha256(contexts[0]["digest"], specWire, "analysis-context.json digest");
  const expectedSpec = {
    protocol: EVALUATION_SPEC_PROTOCOL,
    semanticsVersion: EVALUATION_SEMANTICS_VERSION,
    family: "deterministic-process",
    grader: {
      name: EVALUATION_PARSER_ID,
      digest: { sha256: EVALUATION_PARSER_SHA256 },
      accessClass: "public",
    },
    familyBlock: {
      image: {
        name: "binary-judgment-evaluation-parser-semantics.json",
        digest: { sha256: EVALUATION_PARSER_SHA256 },
      },
      platform: "linux/amd64",
      workspace: {},
      testMaterial: [{
        name: "analysis-context.json",
        digest: { sha256: analysisSha256 },
        mediaType: ANALYSIS_CONTEXT_MEDIA_TYPE,
        accessClass: "private",
      }],
      parser: {
        id: EVALUATION_PARSER_ID,
        version: EVALUATION_PARSER_VERSION,
        digest: `sha256:${EVALUATION_PARSER_SHA256}`,
      },
      transitions: { failToPass: [], passToPass: [] },
      timeout: 60,
    },
    measurements: [
      { name: BINARY_INSTRUMENT_MEASUREMENTS.judgeDecision, type: "string", required: true },
      { name: BINARY_INSTRUMENT_MEASUREMENTS.truthLabel, type: "string", required: true },
      { name: BINARY_INSTRUMENT_MEASUREMENTS.agreement, type: "boolean", required: true },
      { name: BINARY_INSTRUMENT_MEASUREMENTS.parseValid, type: "boolean", required: true },
      { name: BINARY_INSTRUMENT_MEASUREMENTS.candidateClass, type: "string", required: true },
      { name: BINARY_INSTRUMENT_MEASUREMENTS.stratum, type: "string", required: true },
      { name: BINARY_INSTRUMENT_MEASUREMENTS.labelResolutionSha256, type: "string", required: true },
      { name: BINARY_INSTRUMENT_MEASUREMENTS.instrumentSha256, type: "string", required: true },
    ],
    verdictRule: { threshold: { measurement: BINARY_INSTRUMENT_MEASUREMENTS.agreement, op: "eq", value: true } },
    unscorable: [],
    evidenceConventions: { requiredRefs: [LABEL_RESOLUTION_NAME] },
  };
  if (!bytesEqual(canonicalJsonBytes(spec), canonicalJsonBytes(expectedSpec))) {
    throw new MethodInputError("binary-binding-mismatch", specWire, "EvaluationSpec drifts from the frozen binary evaluator contract");
  }
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
  if (itemId !== payload.itemId) {
    throw new MethodInputError("binary-binding-mismatch", analysisWire, "analysis context itemId drifts from the Task payload");
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
    payload,
    context: {
      analysisContextSha256: analysisSha256,
      truthLabel,
      candidateClass,
      stratum,
      labelResolutionSha256: labelResolutionWire.slice("sha256:".length),
    },
  };
}

interface ResolvedArmInstrument {
  readonly digest: string;
  readonly document: Readonly<Record<string, unknown>>;
}

function exactGeneration(value: unknown, digest: string): void {
  if (!isObject(value)) {
    throw new MethodInputError("binary-record-malformed", digest, "instrument generation must be an object");
  }
  requireExactKeys(
    value,
    [
      "reasoningEffort", "maxOutputTokens", "store", "background", "stream", "serviceTier",
      "tools", "fallbackModels", "retries", "persistedConversation", "metadata", "promptCacheIdentifier",
    ],
    digest,
    "instrument.model.generation",
  );
  if (
    (value["reasoningEffort"] !== "none" && value["reasoningEffort"] !== "low")
    || value["maxOutputTokens"] !== 128
    || value["store"] !== false
    || value["background"] !== false
    || value["stream"] !== false
    || value["serviceTier"] !== "default"
    || !Array.isArray(value["tools"])
    || value["tools"].length !== 0
    || !Array.isArray(value["fallbackModels"])
    || value["fallbackModels"].length !== 0
    || value["retries"] !== 0
    || value["persistedConversation"] !== false
    || value["metadata"] !== null
    || value["promptCacheIdentifier"] !== null
  ) {
    throw new MethodInputError("binary-binding-mismatch", digest, "instrument generation drifts from the frozen Luna call policy");
  }
}

function validateInstrument(
  instrument: Record<string, unknown>,
  digest: `sha256:${string}`,
  armId: string,
): void {
  requireExactKeys(
    instrument,
    ["protocol", "instrumentId", "messages", "promptTemplateSha256", "promptSource", "license", "attribution", "model", "response"],
    digest,
    "instrument",
  );
  if (
    instrument["protocol"] !== INSTRUMENT_PROTOCOL
    || instrument["instrumentId"] !== armId
  ) {
    throw new MethodInputError("binary-binding-mismatch", digest, "instrument identity does not match the Run arm");
  }
  const messages = instrument["messages"];
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new MethodInputError("binary-record-malformed", digest, "instrument.messages must be non-empty");
  }
  const usedFields = new Set<string>();
  for (const [messageIndex, message] of messages.entries()) {
    if (!isObject(message)) {
      throw new MethodInputError("binary-record-malformed", digest, `instrument.messages[${messageIndex}] must be an object`);
    }
    requireExactKeys(message, ["role", "segments"], digest, `instrument.messages[${messageIndex}]`);
    if (message["role"] !== "developer" && message["role"] !== "user") {
      throw new MethodInputError("binary-record-malformed", digest, `instrument.messages[${messageIndex}].role is unsupported`);
    }
    const segments = message["segments"];
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new MethodInputError("binary-record-malformed", digest, `instrument.messages[${messageIndex}].segments must be non-empty`);
    }
    for (const [segmentIndex, segment] of segments.entries()) {
      if (!isObject(segment)) {
        throw new MethodInputError("binary-record-malformed", digest, `instrument message segment ${segmentIndex} is invalid`);
      }
      const keys = Object.keys(segment);
      if (keys.length !== 1 || (keys[0] !== "literal" && keys[0] !== "field")) {
        throw new MethodInputError("binary-record-malformed", digest, "instrument message segment has an unsupported field set");
      }
      if (keys[0] === "literal" && typeof segment["literal"] !== "string") {
        throw new MethodInputError("binary-record-malformed", digest, "instrument literal segment must be a string");
      }
      if (keys[0] === "field") {
        const field = segment["field"];
        if (field !== "question" && field !== "referenceAnswer" && field !== "candidateAnswer") {
          throw new MethodInputError("binary-record-malformed", digest, "instrument field segment is unsupported");
        }
        usedFields.add(field);
      }
    }
  }
  if (["question", "referenceAnswer", "candidateAnswer"].some((field) => !usedFields.has(field))) {
    throw new MethodInputError("binary-binding-mismatch", digest, "instrument prompt must interpolate every solver-visible field");
  }
  const promptTemplateSha256 = wireSha256(instrument["promptTemplateSha256"], digest, "instrument.promptTemplateSha256");
  if (promptTemplateSha256 !== recordDigest(canonicalJsonBytes(messages))) {
    throw new MethodInputError("binary-binding-mismatch", digest, "instrument prompt digest does not match its message templates");
  }
  requireSourceDescriptor(instrument["promptSource"], digest, "instrument.promptSource");
  requireSourceDescriptor(instrument["license"], digest, "instrument.license");
  requireSourceDescriptor(instrument["attribution"], digest, "instrument.attribution");
  const model = instrument["model"];
  if (!isObject(model)) {
    throw new MethodInputError("binary-record-malformed", digest, "instrument.model must be an object");
  }
  requireExactKeys(model, ["adapter", "requested", "generation"], digest, "instrument.model");
  if (model["adapter"] !== "jinn-openai" || model["requested"] !== MODEL_ID) {
    throw new MethodInputError("binary-binding-mismatch", digest, "instrument must use the frozen Luna adapter/model");
  }
  exactGeneration(model["generation"], digest);
  const response = instrument["response"];
  if (!isObject(response)) {
    throw new MethodInputError("binary-record-malformed", digest, "instrument.response must be an object");
  }
  requireExactKeys(response, ["mediaType", "parser", "invalidOutputDecision"], digest, "instrument.response");
  if (response["mediaType"] !== RESPONSE_MEDIA_TYPE || response["invalidOutputDecision"] !== "REJECT") {
    throw new MethodInputError("binary-binding-mismatch", digest, "instrument response contract is unsupported");
  }
  const parser = response["parser"];
  if (!isObject(parser)) {
    throw new MethodInputError("binary-record-malformed", digest, "instrument parser must be an object");
  }
  requireExactKeys(parser, ["id", "version", "digest"], digest, "instrument.response.parser");
  if (
    parser["id"] !== RESPONSE_PARSER_ID
    || parser["version"] !== RESPONSE_PARSER_VERSION
    || parser["digest"] !== RESPONSE_PARSER_DIGEST
  ) {
    throw new MethodInputError("binary-binding-mismatch", digest, "instrument parser is not the frozen ACCEPT/REJECT semantics");
  }
}

function resolveArmInstruments(
  matrix: MatrixRecord,
  input: Pick<MethodComputeInput, "resolveRunBytes" | "resolveRecordBytes">,
  k: number,
): Map<string, ResolvedArmInstrument> {
  const run = resolveRun(matrixRunDigest(matrix), input);
  if (run.replicates !== k) {
    throw new MethodInputError(
      "incompatible-run-replicates",
      matrixRunDigest(matrix),
      `binary-instrument@1 parameter k=${k} does not match Run.replicates=${run.replicates}`,
    );
  }
  const matrixArms = [...new Set(matrix.cells.map((cell) => cell.armId))].sort(compareCodeUnitStrings);
  const runArms = run.arms.map((arm) => arm.armId).sort(compareCodeUnitStrings);
  if (
    runArms.length !== 4
    || matrixArms.length !== 4
    || runArms.length !== matrixArms.length
    || runArms.some((armId, index) => armId !== matrixArms[index])
  ) {
    throw new MethodInputError("binary-binding-mismatch", matrixRunDigest(matrix), "binary-instrument@1 requires exactly four matching Run and Matrix arms");
  }
  const instruments = new Map<string, ResolvedArmInstrument>();
  for (const arm of run.arms) {
    const instrumentWire = wireSha256(
      arm.pinning[INSTRUMENT_REQUIREMENT_KEY],
      matrixRunDigest(matrix),
      `Run arm ${arm.armId} instrument pin`,
    );
    const instrument = resolveExactJson(instrumentWire, input.resolveRecordBytes, `arm ${arm.armId} instrument`);
    validateInstrument(instrument, instrumentWire, arm.armId);
    instruments.set(arm.armId, {
      digest: instrumentWire.slice("sha256:".length),
      document: instrument,
    });
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

function renderSemanticRequest(
  payload: ResolvedBinaryPayload,
  instrument: Readonly<Record<string, unknown>>,
  digest: string,
): Record<string, unknown> {
  const messages = instrument["messages"] as readonly Readonly<Record<string, unknown>>[];
  const rendered = messages.map((message) => ({
    role: message["role"],
    text: (message["segments"] as readonly Readonly<Record<string, unknown>>[]).map((segment) => {
      if (Object.hasOwn(segment, "literal")) return segment["literal"] as string;
      const field = segment["field"] as "question" | "referenceAnswer" | "candidateAnswer";
      return payload[field];
    }).join(""),
  }));
  const model = instrument["model"];
  if (!isObject(model)) {
    throw new MethodInputError("binary-record-malformed", digest, "instrument.model is unavailable for request replay");
  }
  return {
    model: MODEL_ID,
    messages: rendered,
    generation: model["generation"],
  };
}

function parseFrozenResponse(bytes: Uint8Array): {
  readonly decision: "ACCEPT" | "REJECT";
  readonly parseValid: boolean;
} {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { decision: "REJECT", parseValid: false };
  }
  const token = text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
  return token === "ACCEPT" || token === "REJECT"
    ? { decision: token, parseValid: true }
    : { decision: "REJECT", parseValid: false };
}

function validateObservation(
  observation: Record<string, unknown>,
  digest: `sha256:${string}`,
  expected: {
    readonly cell: MatrixRecord["cells"][number];
    readonly instrument: ResolvedArmInstrument;
    readonly responseSha256: string;
    readonly requestSha256: string;
  },
): void {
  requireExactKeys(
    observation,
    ["protocol", "taskDigest", "armId", "replicate", "instrumentSha256", "requestSha256", "response", "provider", "call", "limitations"],
    digest,
    "judge observation",
  );
  if (
    observation["protocol"] !== OBSERVATION_PROTOCOL
    || observation["taskDigest"] !== `sha256:${expected.cell.taskDigest}`
    || observation["armId"] !== expected.cell.armId
    || observation["replicate"] !== expected.cell.replicate
    || observation["instrumentSha256"] !== `sha256:${expected.instrument.digest}`
    || observation["requestSha256"] !== expected.requestSha256
  ) {
    throw new MethodInputError("binary-binding-mismatch", digest, "judge observation drifts from its exact Matrix cell or semantic request");
  }
  const response = observation["response"];
  if (!isObject(response)) {
    throw new MethodInputError("binary-record-malformed", digest, "judge observation response must be an object");
  }
  requireExactKeys(response, ["digest", "mediaType"], digest, "judge observation response");
  if (response["digest"] !== `sha256:${expected.responseSha256}` || response["mediaType"] !== RESPONSE_MEDIA_TYPE) {
    throw new MethodInputError("binary-binding-mismatch", digest, "judge observation response binding is inconsistent");
  }
  const provider = observation["provider"];
  if (!isObject(provider)) {
    throw new MethodInputError("binary-record-malformed", digest, "judge observation provider must be an object");
  }
  requireExactKeys(provider, ["requestedModel", "resolvedModel", "responseId", "eventSha256", "usage"], digest, "judge observation provider");
  if (
    provider["requestedModel"] !== MODEL_ID
    || provider["resolvedModel"] !== MODEL_ID
    || typeof provider["responseId"] !== "string"
    || provider["responseId"].length === 0
  ) {
    throw new MethodInputError("binary-binding-mismatch", digest, "judge observation provider identity is unsupported");
  }
  wireSha256(provider["eventSha256"], digest, "judge observation provider eventSha256");
  const usage = provider["usage"];
  if (!isObject(usage)) {
    throw new MethodInputError("binary-record-malformed", digest, "judge observation usage must be an object");
  }
  requireExactKeys(usage, ["inputTokens", "outputTokens", "totalTokens"], digest, "judge observation usage");
  const inputTokens = usage["inputTokens"];
  const outputTokens = usage["outputTokens"];
  const totalTokens = usage["totalTokens"];
  if (
    !Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0
    || !Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0
    || !Number.isSafeInteger(totalTokens) || (totalTokens as number) < 0
    || totalTokens !== (inputTokens as number) + (outputTokens as number)
  ) {
    throw new MethodInputError("binary-record-malformed", digest, "judge observation token usage is inconsistent");
  }
  const call = observation["call"];
  if (!isObject(call)) {
    throw new MethodInputError("binary-record-malformed", digest, "judge observation call must be an object");
  }
  requireExactKeys(call, ["count", "retries", "fallbacks"], digest, "judge observation call");
  if (call["count"] !== 1 || call["retries"] !== 0 || call["fallbacks"] !== 0) {
    throw new MethodInputError("binary-binding-mismatch", digest, "judge observation does not describe one frozen call");
  }
  if (
    !Array.isArray(observation["limitations"])
    || observation["limitations"].length !== 1
    || observation["limitations"][0] !== "mutable-model-alias"
  ) {
    throw new MethodInputError("binary-binding-mismatch", digest, "judge observation limitations are not the frozen disclosure");
  }
}

function subjectByName(
  subjects: readonly unknown[],
  name: string,
  verdictDigest: string,
): Record<string, unknown> {
  const matches = subjects.filter((subject) => isObject(subject) && subject["name"] === name);
  if (matches.length !== 1 || !isObject(matches[0])) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, `Result Evaluation must name exactly one ${name} subject`);
  }
  return matches[0];
}

function resolveSubjectBytes(
  descriptor: Record<string, unknown>,
  verdictDigest: string,
  label: string,
  resolve: ((digest: string) => Uint8Array | undefined) | undefined,
): { readonly sha256: string; readonly bytes: Uint8Array } {
  const sha256 = descriptorDigest(descriptor, verdictDigest, label);
  if (resolve === undefined) {
    throw new MethodInputError("binary-record-unavailable", verdictDigest, `${label} requires resolveRecordBytes`);
  }
  const bytes = resolve(`sha256:${sha256}`);
  if (bytes === undefined) {
    throw new MethodInputError("binary-record-unavailable", `sha256:${sha256}`, `${label} bytes are unavailable`);
  }
  const actual = recordDigest(bytes);
  if (actual !== `sha256:${sha256}`) {
    throw new MethodInputError("binary-record-digest-mismatch", `sha256:${sha256}`, `${label} bytes hash to ${actual}`);
  }
  return { sha256, bytes };
}

function resolveCellInput(
  verdictDigest: string,
  cell: MatrixRecord["cells"][number],
  binding: ExpectedTaskBinding,
  expectedInstrument: ResolvedArmInstrument,
  input: Pick<MethodComputeInput, "resolveVerdictBytes" | "resolveRecordBytes">,
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
  const resultSubjects = predicate["resultSubjects"];
  if (!Array.isArray(resultSubjects)) {
    throw new MethodInputError("verdict-record-malformed", verdictDigest, "Result Evaluation resultSubjects must be an array");
  }
  const expectedResultNames = resultSubjects.includes("inspect-log")
    ? ["judge-response", "judge-observation", "inspect-log"]
    : ["judge-response", "judge-observation"];
  if (
    resultSubjects.length !== expectedResultNames.length
    || new Set(resultSubjects).size !== resultSubjects.length
    || expectedResultNames.some((name) => !resultSubjects.includes(name))
  ) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "Result Evaluation must bind the exact binary judge Results");
  }
  const expectedSubjectNames = new Set([taskSubject, ...expectedResultNames]);
  if (
    subjects.length !== expectedSubjectNames.size
    || subjects.some((subject) => !isObject(subject) || !expectedSubjectNames.has(subject["name"] as string))
  ) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "Result Evaluation subject-name crosswalk is not exact");
  }
  const responseDescriptor = subjectByName(subjects, "judge-response", verdictDigest);
  const observationDescriptor = subjectByName(subjects, "judge-observation", verdictDigest);
  if (responseDescriptor["mediaType"] !== RESPONSE_MEDIA_TYPE || observationDescriptor["mediaType"] !== OBSERVATION_MEDIA_TYPE) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "Result Evaluation result media types are inconsistent");
  }
  if (resultSubjects.includes("inspect-log")) {
    const inspectDescriptor = subjectByName(subjects, "inspect-log", verdictDigest);
    if (inspectDescriptor["mediaType"] !== INSPECT_LOG_MEDIA_TYPE) {
      throw new MethodInputError("binary-binding-mismatch", verdictDigest, "Result Evaluation inspect-log media type is inconsistent");
    }
  }
  const responseMaterial = resolveSubjectBytes(
    responseDescriptor,
    verdictDigest,
    "judge-response",
    input.resolveRecordBytes,
  );
  const observationMaterial = resolveSubjectBytes(
    observationDescriptor,
    verdictDigest,
    "judge-observation",
    input.resolveRecordBytes,
  );
  const observationWire = `sha256:${observationMaterial.sha256}` as const;
  const observation = resolveExactJson(observationWire, input.resolveRecordBytes, "judge observation");
  const requestSha256 = recordDigest(canonicalJsonBytes(
    renderSemanticRequest(binding.payload, expectedInstrument.document, verdictDigest),
  ));
  validateObservation(observation, observationWire, {
    cell,
    instrument: expectedInstrument,
    responseSha256: responseMaterial.sha256,
    requestSha256,
  });
  const responseParse = parseFrozenResponse(responseMaterial.bytes);
  const evidence = predicate["evidence"];
  if (!Array.isArray(evidence) || evidence.length !== 1 || !isObject(evidence[0])) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "Result Evaluation must carry one exact label-resolution evidence reference");
  }
  const labelEvidence = evidence[0];
  if (
    labelEvidence["name"] !== LABEL_RESOLUTION_NAME
    || labelEvidence["mediaType"] !== LABEL_RESOLUTION_MEDIA_TYPE
    || descriptorDigest(labelEvidence, verdictDigest, "label resolution evidence") !== binding.context.labelResolutionSha256
  ) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "Result Evaluation label-resolution evidence drifts from admitted truth");
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
  if (judgeDecision !== responseParse.decision || parseValid !== responseParse.parseValid) {
    throw new MethodInputError("binary-binding-mismatch", verdictDigest, "signed response measurements do not replay from exact judge-response bytes");
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
  if (instrumentSha256 !== expectedInstrument.digest) {
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

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCodeUnitStrings);
  const wanted = [...expected].sort(compareCodeUnitStrings);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sortedUniqueStrings(value: unknown, expectedLength?: number): value is readonly string[] {
  if (!Array.isArray(value) || (expectedLength !== undefined && value.length !== expectedLength)) return false;
  return value.every((entry, index) =>
    typeof entry === "string"
    && entry.length > 0
    && (index === 0 || compareCodeUnitStrings(value[index - 1] as string, entry) < 0));
}

function contextIssues(
  value: unknown,
  path: string,
  candidateClasses: readonly string[],
  issues: string[],
): void {
  if (!isObject(value) || !exactKeys(value, [
    "analysisContextSha256",
    "truthLabel",
    "candidateClass",
    "stratum",
    "labelResolutionSha256",
  ])) {
    issues.push(`${path} has an unsupported field set`);
    return;
  }
  if (!SHA256_URI.test(String(value["analysisContextSha256"]))) issues.push(`${path}.analysisContextSha256 is invalid`);
  if (!SHA256_URI.test(String(value["labelResolutionSha256"]))) issues.push(`${path}.labelResolutionSha256 is invalid`);
  if (value["truthLabel"] !== "CORRECT" && value["truthLabel"] !== "WRONG") issues.push(`${path}.truthLabel is invalid`);
  if (typeof value["candidateClass"] !== "string" || !candidateClasses.includes(value["candidateClass"])) issues.push(`${path}.candidateClass is invalid`);
  if (value["stratum"] !== "core" && value["stratum"] !== "stress") issues.push(`${path}.stratum is invalid`);
}

function sameWireContext(left: unknown, right: unknown): boolean {
  return isObject(left) && isObject(right)
    && left["analysisContextSha256"] === right["analysisContextSha256"]
    && left["truthLabel"] === right["truthLabel"]
    && left["candidateClass"] === right["candidateClass"]
    && left["stratum"] === right["stratum"]
    && left["labelResolutionSha256"] === right["labelResolutionSha256"];
}

function projectionIssues(value: unknown, path: string, k: number, issues: string[]): void {
  if (!isObject(value)) { issues.push(`${path} must be an object`); return; }
  const exact = (expected: readonly string[]) => {
    if (!exactKeys(value, expected)) {
      issues.push(`${path} has an unsupported field set`);
    }
  };
  exact(["item", "call", "confusion", "agreement", "falseAccept", "falseReject", "instability", "parserInvalid"]);
  for (const [name, fields] of [
    ["item", ["expected", "complete", "excluded", "unstable"]],
    ["call", ["expected", "evaluated", "parseInvalid"]],
    ["confusion", ["correctAccepted", "correctRejected", "wrongAccepted", "wrongRejected"]],
  ] as const) {
    const child = value[name];
    if (!isObject(child)) { issues.push(`${path}.${name} must be an object`); continue; }
    if (!exactKeys(child, fields)) issues.push(`${path}.${name} has an unsupported field set`);
    if (fields.some((field) => !Number.isSafeInteger(child[field]) || (child[field] as number) < 0)) issues.push(`${path}.${name} counts must be non-negative safe integers`);
  }
  for (const name of ["agreement", "falseAccept", "falseReject", "instability", "parserInvalid"] as const) {
    const rate = value[name];
    if (!isObject(rate)) { issues.push(`${path}.${name} must be a rate object`); continue; }
    const zero = rate["denominator"] === 0;
    const expected = zero
      ? ["numerator", "denominator", "estimate", "wilsonInterval", "withheldReason"]
      : ["numerator", "denominator", "estimate", "wilsonInterval"];
    if (!exactKeys(rate, expected)) issues.push(`${path}.${name} has an unsupported field set`);
    if (!Number.isSafeInteger(rate["numerator"]) || !Number.isSafeInteger(rate["denominator"]) || (rate["numerator"] as number) < 0 || (rate["denominator"] as number) < 0 || (rate["numerator"] as number) > (rate["denominator"] as number)) issues.push(`${path}.${name} has invalid counts`);
    if (zero) {
      if (rate["estimate"] !== null || rate["wilsonInterval"] !== null || rate["withheldReason"] !== "zero-denominator") issues.push(`${path}.${name} zero denominator must be withheld`);
    } else if (Number.isSafeInteger(rate["numerator"]) && Number.isSafeInteger(rate["denominator"])) {
      const canonical = rateProjection(rate["numerator"] as number, rate["denominator"] as number);
      if (
        rate["estimate"] !== canonical.estimate
        || !isObject(rate["wilsonInterval"])
        || !exactKeys(rate["wilsonInterval"], ["low", "high"])
        || rate["wilsonInterval"]["low"] !== canonical.wilsonInterval?.low
        || rate["wilsonInterval"]["high"] !== canonical.wilsonInterval?.high
      ) issues.push(`${path}.${name} must carry the canonical estimate and Wilson interval for its counts`);
    }
  }
  const item = value["item"];
  const call = value["call"];
  const confusion = value["confusion"];
  if (isObject(item) && isObject(call) && isObject(confusion)) {
    if (item["expected"] !== (item["complete"] as number) + (item["excluded"] as number)) issues.push(`${path}.item counts are inconsistent`);
    if ((item["unstable"] as number) > (item["complete"] as number)) issues.push(`${path}.item.unstable exceeds complete items`);
    if (call["expected"] !== (item["expected"] as number) * k) issues.push(`${path}.call.expected is inconsistent with item.expected and k`);
    if ((call["evaluated"] as number) > (call["expected"] as number) || (call["parseInvalid"] as number) > (call["evaluated"] as number)) issues.push(`${path}.call counts are inconsistent`);
    const complete = (confusion["correctAccepted"] as number) + (confusion["correctRejected"] as number)
      + (confusion["wrongAccepted"] as number) + (confusion["wrongRejected"] as number);
    if (complete !== item["complete"]) issues.push(`${path}.confusion does not partition complete items`);
    const expectedRates = {
      agreement: [(confusion["correctAccepted"] as number) + (confusion["wrongRejected"] as number), item["complete"] as number],
      falseAccept: [confusion["wrongAccepted"] as number, (confusion["wrongAccepted"] as number) + (confusion["wrongRejected"] as number)],
      falseReject: [confusion["correctRejected"] as number, (confusion["correctAccepted"] as number) + (confusion["correctRejected"] as number)],
      instability: [item["unstable"] as number, item["complete"] as number],
      parserInvalid: [call["parseInvalid"] as number, call["evaluated"] as number],
    } as const;
    for (const [name, [numerator, denominator]] of Object.entries(expectedRates)) {
      const rate = value[name];
      if (isObject(rate) && (rate["numerator"] !== numerator || rate["denominator"] !== denominator)) issues.push(`${path}.${name} counts are inconsistent with the projection`);
    }
  }
}

/** Closed validator for the F6 public projection. It intentionally rejects unknown fields so
 * publication cannot smuggle a winner, loser, ranking, threshold, or preferred-arm conclusion. */
export function validateBinaryInstrumentQualificationProjection(value: unknown):
  { readonly ok: true } | { readonly ok: false; readonly issues: readonly string[] } {
  const issues: string[] = [];
  if (!isObject(value)) return { ok: false, issues: ["qualification must be an object"] };
  const rootKeys = Object.keys(value).sort(compareCodeUnitStrings);
  const expectedRoot = ["configuration", "arms", "itemDecisions", "excluded", "conflicted"].sort(compareCodeUnitStrings);
  if (rootKeys.length !== expectedRoot.length || rootKeys.some((key, index) => key !== expectedRoot[index])) issues.push("qualification has an unsupported field set");
  const configuration = value["configuration"];
  const configurationKeys = ["verdictRule", "k", "reduction", "measurementProfile", "candidateClasses", "strata", "parserInvalidPolicy", "truthAdmission", "intervalAlpha"];
  if (!isObject(configuration) || Object.keys(configuration).sort(compareCodeUnitStrings).join("\0") !== configurationKeys.sort(compareCodeUnitStrings).join("\0")) {
    issues.push("qualification.configuration has an unsupported field set");
  } else if (!validateBinaryInstrumentParameters(configuration).ok) {
    issues.push("qualification.configuration is not the registered binary-instrument parameter set");
  }
  const candidateClasses = isObject(configuration) && Array.isArray(configuration["candidateClasses"])
    ? configuration["candidateClasses"].filter((entry): entry is string => typeof entry === "string")
    : [];
  const k = isObject(configuration) && Number.isSafeInteger(configuration["k"])
    ? configuration["k"] as number
    : 0;
  const arms = value["arms"];
  if (!isObject(arms) || Object.keys(arms).length !== 4) issues.push("qualification.arms must contain exactly four arms");
  else for (const [armId, raw] of Object.entries(arms)) {
    if (!CANDIDATE_CLASS.test(armId) || !isObject(raw)) { issues.push(`qualification.arms.${armId} is invalid`); continue; }
    const expected = ["instrumentSha256", "item", "call", "confusion", "agreement", "falseAccept", "falseReject", "instability", "parserInvalid", "byCandidateClass", "byStratum"].sort(compareCodeUnitStrings);
    if (Object.keys(raw).sort(compareCodeUnitStrings).join("\0") !== expected.join("\0") || typeof raw["instrumentSha256"] !== "string" || !SHA256_URI.test(raw["instrumentSha256"] as string)) issues.push(`qualification.arms.${armId} has an unsupported field set`);
    projectionIssues(Object.fromEntries(
      ["item", "call", "confusion", "agreement", "falseAccept", "falseReject", "instability", "parserInvalid"]
        .map((key) => [key, raw[key]]),
    ), `qualification.arms.${armId}`, k, issues);
    for (const sliceName of ["byCandidateClass", "byStratum"] as const) {
      const slices = raw[sliceName];
      if (!isObject(slices)) { issues.push(`qualification.arms.${armId}.${sliceName} must be an object`); continue; }
      const expectedSlices = sliceName === "byCandidateClass" ? candidateClasses : ["core", "stress"];
      if (!exactKeys(slices, expectedSlices)) issues.push(`qualification.arms.${armId}.${sliceName} must exactly match the registered slice vocabulary`);
      for (const [name, slice] of Object.entries(slices)) projectionIssues(slice, `qualification.arms.${armId}.${sliceName}.${name}`, k, issues);
    }
  }
  const armEntries = isObject(arms) ? Object.entries(arms) : [];
  const armIds = armEntries.map(([armId]) => armId);
  const instrumentByArm = new Map(armEntries.flatMap(([armId, arm]) =>
    isObject(arm) && typeof arm["instrumentSha256"] === "string" ? [[armId, arm["instrumentSha256"]] as const] : []));
  if (armIds.some((armId, index) => index > 0 && compareCodeUnitStrings(armIds[index - 1]!, armId) >= 0)) issues.push("qualification.arms must be code-unit sorted and unique");
  if (new Set(instrumentByArm.values()).size !== 4) issues.push("qualification.arms must bind four distinct instruments");
  const decisions = value["itemDecisions"];
  if (!Array.isArray(decisions)) issues.push("qualification.itemDecisions must be an array");
  else for (const [index, raw] of decisions.entries()) {
    if (!isObject(raw) || Object.keys(raw).sort(compareCodeUnitStrings).join("\0") !== ["taskDigest", "armId", "instrumentSha256", "context", "cellKeys", "accepted", "rejected", "decision", "unstable"].sort(compareCodeUnitStrings).join("\0")) { issues.push(`qualification.itemDecisions.${index} has an unsupported field set`); continue; }
    const accepted = raw["accepted"];
    const rejected = raw["rejected"];
    if (typeof raw["taskDigest"] !== "string" || !SHA256.test(raw["taskDigest"] as string)
      || typeof raw["armId"] !== "string" || !armIds.includes(raw["armId"])
      || raw["instrumentSha256"] !== instrumentByArm.get(raw["armId"] as string)
      || !sortedUniqueStrings(raw["cellKeys"], k)
      || !Number.isSafeInteger(accepted) || (accepted as number) < 0
      || !Number.isSafeInteger(rejected) || (rejected as number) < 0
      || (accepted as number) + (rejected as number) !== k
      || (raw["decision"] !== "ACCEPT" && raw["decision"] !== "REJECT")
      || raw["decision"] !== ((accepted as number) > (rejected as number) ? "ACCEPT" : "REJECT")
      || typeof raw["unstable"] !== "boolean"
      || raw["unstable"] !== ((accepted as number) !== 0 && (rejected as number) !== 0)) issues.push(`qualification.itemDecisions.${index} is invalid`);
    contextIssues(raw["context"], `qualification.itemDecisions.${index}.context`, candidateClasses, issues);
  }
  const excluded = value["excluded"];
  if (!isObject(excluded) || !exactKeys(excluded, ["count", "items"]) || !Number.isSafeInteger(excluded["count"]) || (excluded["count"] as number) < 0 || !Array.isArray(excluded["items"]) || excluded["count"] !== excluded["items"].length) issues.push("qualification.excluded is invalid");
  else for (const [index, raw] of excluded["items"].entries()) {
    if (!isObject(raw) || !exactKeys(raw, ["taskDigest", "armId", "instrumentSha256", "context", "cellKeys", "reasons"])) { issues.push(`qualification.excluded.items.${index} is invalid`); continue; }
    if (typeof raw["taskDigest"] !== "string" || !SHA256.test(raw["taskDigest"] as string)
      || typeof raw["armId"] !== "string" || !armIds.includes(raw["armId"])
      || raw["instrumentSha256"] !== instrumentByArm.get(raw["armId"] as string)
      || !sortedUniqueStrings(raw["cellKeys"], k)
      || !Array.isArray(raw["reasons"]) || raw["reasons"].length === 0) issues.push(`qualification.excluded.items.${index} is invalid`);
    contextIssues(raw["context"], `qualification.excluded.items.${index}.context`, candidateClasses, issues);
    const parentCellKeys = Array.isArray(raw["cellKeys"]) ? raw["cellKeys"].filter((entry): entry is string => typeof entry === "string") : [];
    if (Array.isArray(raw["reasons"])) for (const [reasonIndex, reason] of raw["reasons"].entries()) {
      const reasonPath = `qualification.excluded.items.${index}.reasons.${reasonIndex}`;
      if (!isObject(reason) || !exactKeys(reason, ["reason", "cellKeys"])
        || !["cell-not-judged", "conflicted-evaluations", "inconclusive-evaluation", "missing-evaluation"].includes(reason["reason"] as string)
        || !sortedUniqueStrings(reason["cellKeys"]) || reason["cellKeys"].length === 0
        || reason["cellKeys"].some((cellKey) => !parentCellKeys.includes(cellKey))) issues.push(`${reasonPath} is invalid`);
      const previousReason = raw["reasons"][reasonIndex - 1];
      if (reasonIndex > 0 && isObject(previousReason) && isObject(reason)
        && compareCodeUnitStrings(String(previousReason["reason"]), String(reason["reason"])) >= 0) issues.push(`${reasonPath} must be sorted and unique`);
    }
  }
  const conflicted = value["conflicted"];
  if (!isObject(conflicted) || !exactKeys(conflicted, ["count", "cellKeys"]) || !Number.isSafeInteger(conflicted["count"]) || (conflicted["count"] as number) < 0 || !sortedUniqueStrings(conflicted["cellKeys"]) || conflicted["count"] !== conflicted["cellKeys"].length) issues.push("qualification.conflicted is invalid");
  const groups = [
    ...(Array.isArray(decisions) ? decisions : []),
    ...(isObject(excluded) && Array.isArray(excluded["items"]) ? excluded["items"] : []),
  ].filter(isObject);
  const decisionGroupKeys = (Array.isArray(decisions) ? decisions : []).filter(isObject).map((entry) => `${String(entry["taskDigest"])}\u001f${String(entry["armId"])}`);
  const excludedGroupKeys = (isObject(excluded) && Array.isArray(excluded["items"]) ? excluded["items"] : []).filter(isObject).map((entry) => `${String(entry["taskDigest"])}\u001f${String(entry["armId"])}`);
  if (decisionGroupKeys.some((key, index) => index > 0 && compareCodeUnitStrings(decisionGroupKeys[index - 1]!, key) >= 0)) issues.push("qualification.itemDecisions must be code-unit sorted and unique");
  if (excludedGroupKeys.some((key, index) => index > 0 && compareCodeUnitStrings(excludedGroupKeys[index - 1]!, key) >= 0)) issues.push("qualification.excluded.items must be code-unit sorted and unique");
  if (new Set([...decisionGroupKeys, ...excludedGroupKeys]).size !== decisionGroupKeys.length + excludedGroupKeys.length) issues.push("qualification item groups must be unique across complete and excluded items");
  const groupsByTask = new Map<string, Record<string, unknown>[]>();
  for (const group of groups) {
    const task = String(group["taskDigest"]);
    groupsByTask.set(task, [...(groupsByTask.get(task) ?? []), group]);
  }
  for (const [task, taskGroups] of groupsByTask) {
    taskGroups.sort((left, right) => compareCodeUnitStrings(String(left["armId"]), String(right["armId"])));
    if (taskGroups.length !== armIds.length || taskGroups.some((group, index) => group["armId"] !== armIds[index])) issues.push(`qualification task ${task} must carry exactly one group for every arm`);
    const firstContext = taskGroups[0]?.["context"];
    if (taskGroups.some((group) => !sameWireContext(firstContext, group["context"]))) issues.push(`qualification task ${task} carries inconsistent contexts`);
  }
  const allGroupCellKeys = groups.flatMap((entry) => Array.isArray(entry["cellKeys"])
    ? entry["cellKeys"].filter((cellKey): cellKey is string => typeof cellKey === "string")
    : []);
  if (new Set(allGroupCellKeys).size !== allGroupCellKeys.length) issues.push("qualification cell keys must be unique across item groups");
  if (isObject(conflicted) && Array.isArray(conflicted["cellKeys"])) {
    const allCellKeys = new Set(allGroupCellKeys);
    if (conflicted["cellKeys"].some((cellKey) => !allCellKeys.has(cellKey as string))) issues.push("qualification.conflicted contains an unknown cell key");
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
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
      .map(([armId, instrument]) => ({ armId, instrumentSha256: instrument.digest }))
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
      instrumentSha256: `sha256:${instruments.get(armId)!.digest}`,
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
