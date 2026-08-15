// SPDX-License-Identifier: Apache-2.0

import {
  EvaluationOperationalError,
  isEvaluationOperationalError,
  type CompletedEvaluation,
  type EvaluationContext,
  type EvaluationMeasurement,
  type EvaluatorAdapter,
  type ExactEvaluationMaterial,
  type ResourceDescriptor,
} from "@jinn-network/task-execution-evaluation-harness";
import {
  BINARY_JUDGMENT_ANALYSIS_CONTEXT_MEDIA_TYPE,
  BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
  BINARY_JUDGMENT_EVALUATION_PARSER_SEALED,
  BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE,
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  BINARY_JUDGMENT_LABEL_RESOLUTION_MEDIA_TYPE,
  BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE,
  BINARY_JUDGMENT_PROFILE_DIGEST,
  BINARY_JUDGMENT_PROFILE_URI,
  BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE,
  EVALUATION_SPEC_FORMAT_URI,
  EVAL_SEMANTICS_VERSION,
  BinaryJudgmentEvaluationContextSchema,
  binaryJudgmentSemanticRequestDigest,
  canonicalJsonBytes,
  decodeBinaryJudgmentInlineMaterial,
  parseBinaryJudgmentAnalysisContext,
  parseBinaryJudgmentInstrument,
  parseBinaryJudgmentLabelResolution,
  parseBinaryJudgmentObservation,
  parseBinaryJudgmentPayload,
  recordDigest,
  sealBinaryJudgmentAnalysisContext,
  sealBinaryJudgmentInstrument,
  sealBinaryJudgmentLabelResolution,
  sealBinaryJudgmentObservation,
  sealEvaluationSpec,
  type BinaryJudgmentAnalysisContext,
  type BinaryJudgmentEvaluationContext,
  type BinaryJudgmentInstrument,
  type BinaryJudgmentLabelResolution,
  type BinaryJudgmentObservation,
  type BinaryJudgmentPayload,
  type BinaryJudgmentTruthLabel,
  type DeterministicProcessBlock,
  type EvaluationSpec,
} from "@jinn-network/task-execution-profiles";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  TaskSpecificationSchema,
  documentDigest,
  sealTask,
  type TaskSpecification,
} from "@jinn-network/task-execution-protocol";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import {
  parseBinaryJudgmentResponse,
  type BinaryJudgmentDecision,
  type BinaryJudgmentResponseParse,
} from "./parse.js";

export const BINARY_JUDGMENT_CONTEXT_KEY = "binaryJudgment" as const;
export const BINARY_JUDGMENT_ANALYSIS_CONTEXT_NAME = "analysis-context.json" as const;
export const BINARY_JUDGMENT_LABEL_RESOLUTION_NAME = "label-resolution.json" as const;
export const BINARY_JUDGMENT_EVALUATION_OUTCOME_PROTOCOL =
  "https://spec.jinn.network/binary-judgment/evaluation-outcome/v1" as const;

export const BINARY_JUDGMENT_MEASUREMENTS = Object.freeze({
  judgeDecision: "judgeDecision",
  truthLabel: "truthLabel",
  agreement: "agreement",
  parseValid: "parseValid",
  candidateClass: "candidateClass",
  stratum: "stratum",
  labelResolutionSha256: "labelResolutionSha256",
  instrumentSha256: "instrumentSha256",
} as const);

export function binaryJudgmentEvaluationSpecMeasurements(): EvaluationSpec["measurements"] {
  return [
    { name: BINARY_JUDGMENT_MEASUREMENTS.judgeDecision, type: "string", required: true },
    { name: BINARY_JUDGMENT_MEASUREMENTS.truthLabel, type: "string", required: true },
    { name: BINARY_JUDGMENT_MEASUREMENTS.agreement, type: "boolean", required: true },
    { name: BINARY_JUDGMENT_MEASUREMENTS.parseValid, type: "boolean", required: true },
    { name: BINARY_JUDGMENT_MEASUREMENTS.candidateClass, type: "string", required: true },
    { name: BINARY_JUDGMENT_MEASUREMENTS.stratum, type: "string", required: true },
    { name: BINARY_JUDGMENT_MEASUREMENTS.labelResolutionSha256, type: "string", required: true },
    { name: BINARY_JUDGMENT_MEASUREMENTS.instrumentSha256, type: "string", required: true },
  ];
}

export function binaryJudgmentEvaluationSpecVerdictRule(): EvaluationSpec["verdictRule"] {
  return {
    threshold: {
      measurement: BINARY_JUDGMENT_MEASUREMENTS.agreement,
      op: "eq",
      value: true,
    },
  };
}

/** The method bytes are the profiles-owned, code-free umbrella parser semantics. */
export function binaryJudgmentEvaluationMethodDescriptor(): ResourceDescriptor {
  return {
    name: "binary-judgment-evaluation-parser-semantics.json",
    digest: {
      sha256: BINARY_JUDGMENT_EVALUATION_PARSER_SEALED.digest.slice("sha256:".length),
    },
    mediaType: "application/json",
  };
}

export interface BinaryJudgmentMaterialRequest {
  readonly specification: EvaluationSpec;
  readonly task: ExactEvaluationMaterial;
  readonly results: readonly ExactEvaluationMaterial[];
  readonly context: EvaluationContext;
  readonly attempt: AttemptIdentity;
  readonly deadlineSignal: AbortSignal;
}

export interface BinaryJudgmentEvaluationInputs {
  readonly evaluationContext: BinaryJudgmentEvaluationContext;
  readonly instrument: BinaryJudgmentInstrument;
  readonly instrumentBytes: Uint8Array;
  readonly labelResolution: BinaryJudgmentLabelResolution;
  readonly labelResolutionBytes: Uint8Array;
  readonly analysisContext: BinaryJudgmentAnalysisContext;
  readonly analysisContextBytes: Uint8Array;
}

/** Host-owned material port; the evaluator itself performs no repository or broker I/O. */
export interface BinaryJudgmentMaterialSource {
  read(request: BinaryJudgmentMaterialRequest): Promise<BinaryJudgmentEvaluationInputs>;
}

function operational(options: ConstructorParameters<typeof EvaluationOperationalError>[0]): never {
  throw new EvaluationOperationalError(options);
}

function malformed(detail: string, cause?: unknown): never {
  operational({
    canonicalCode: "DATA_LOSS",
    reason: "invalid-evaluator-output",
    recoveryAdvice: "do-not-retry",
    safeDetail: detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function mismatch(detail: string): never {
  operational({
    canonicalCode: "DATA_LOSS",
    reason: "subject-digest-mismatch",
    recoveryAdvice: "do-not-retry",
    safeDetail: detail,
  });
}

function missing(detail: string): never {
  operational({
    canonicalCode: "NOT_FOUND",
    reason: "subject-not-found",
    recoveryAdvice: "do-not-retry",
    safeDetail: detail,
  });
}

function cancelled(detail: string): never {
  operational({
    canonicalCode: "CANCELLED",
    reason: "provider-unavailable",
    recoveryAdvice: "resume-attempt",
    safeDetail: detail,
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function requireCanonical(
  actual: Uint8Array,
  canonical: Uint8Array,
  label: string,
): void {
  if (!bytesEqual(actual, canonical)) malformed(`${label} is not in its canonical sealed form`);
}

function descriptorDigest(material: ExactEvaluationMaterial, label: string): `sha256:${string}` {
  const sha256 = material.descriptor.digest?.["sha256"];
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) {
    malformed(`${label} descriptor has no exact sha256 digest`);
  }
  const actual = recordDigest(material.bytes);
  if (actual !== `sha256:${sha256}`) mismatch(`${label} bytes do not match their descriptor`);
  return actual;
}

function contextValue(context: EvaluationContext): unknown {
  if (!Object.hasOwn(context, BINARY_JUDGMENT_CONTEXT_KEY)) {
    missing(`the evaluation context carries no ${BINARY_JUDGMENT_CONTEXT_KEY} material`);
  }
  return context[BINARY_JUDGMENT_CONTEXT_KEY];
}

/**
 * Reads the strict evaluator-only context and independently parses and re-hashes every embedded
 * material. Inline base64 is transport only; no digest in the context is trusted on sight.
 */
export function contextBinaryJudgmentMaterialSource(): BinaryJudgmentMaterialSource {
  return {
    async read({ context }) {
      const parsed = BinaryJudgmentEvaluationContextSchema.safeParse(contextValue(context));
      if (!parsed.success) malformed("binaryJudgment evaluation context is malformed");
      const evaluationContext = parsed.data;
      try {
        const instrumentBytes = decodeBinaryJudgmentInlineMaterial(
          evaluationContext.material.instrument,
        );
        const labelResolutionBytes = decodeBinaryJudgmentInlineMaterial(
          evaluationContext.material.labelResolution,
        );
        const analysisContextBytes = decodeBinaryJudgmentInlineMaterial(
          evaluationContext.material.analysisContext,
        );
        const instrument = parseBinaryJudgmentInstrument(instrumentBytes);
        const labelResolution = parseBinaryJudgmentLabelResolution(labelResolutionBytes);
        const analysisContext = parseBinaryJudgmentAnalysisContext(analysisContextBytes);
        requireCanonical(
          instrumentBytes,
          sealBinaryJudgmentInstrument(instrument).bytes,
          "binary judgment instrument",
        );
        requireCanonical(
          labelResolutionBytes,
          sealBinaryJudgmentLabelResolution(labelResolution).bytes,
          "binary judgment label resolution",
        );
        requireCanonical(
          analysisContextBytes,
          sealBinaryJudgmentAnalysisContext(analysisContext).bytes,
          "binary judgment analysis context",
        );
        return {
          evaluationContext,
          instrument,
          instrumentBytes,
          labelResolution,
          labelResolutionBytes,
          analysisContext,
          analysisContextBytes,
        };
      } catch (cause) {
        if (isEvaluationOperationalError(cause)) throw cause;
        malformed("embedded binary judgment material is malformed", cause);
      }
    },
  };
}

const taskDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function parseTaskMaterial(material: ExactEvaluationMaterial): TaskSpecification {
  try {
    const task = TaskSpecificationSchema.parse(JSON.parse(taskDecoder.decode(material.bytes)));
    requireCanonical(material.bytes, sealTask(task), "binary judgment Task");
    descriptorDigest(material, "binary judgment Task");
    return task;
  } catch (cause) {
    if (isEvaluationOperationalError(cause)) throw cause;
    malformed("binary judgment Task is malformed", cause);
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function requireBinaryJudgmentTask(
  task: TaskSpecification,
  specificationDigest: `sha256:${string}`,
): BinaryJudgmentPayload {
  if (task.protocol !== TASK_EXECUTION_PROTOCOL_URI) {
    malformed("binary judgment Task uses the wrong protocol");
  }
  const profileDigest = task.profile.digest?.["sha256"];
  if (
    profileDigest !== BINARY_JUDGMENT_PROFILE_DIGEST.slice("sha256:".length)
    || (task.profile.uri !== undefined && task.profile.uri !== BINARY_JUDGMENT_PROFILE_URI)
  ) {
    malformed("binary judgment Task does not pin the binary-judgment/1.0 profile");
  }
  if (task.evaluation?.digest?.["sha256"] !== specificationDigest.slice("sha256:".length)) {
    mismatch("binary judgment Task does not bind the evaluated specification");
  }
  if (
    task.requirements !== undefined
    && Object.hasOwn(task.requirements, BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY)
  ) {
    malformed("shared binary judgment Task must not pin one arm-specific instrument");
  }

  const expectedSlots = new Map<string, { mediaType: string; required: boolean }>([
    ["judge-response", { mediaType: BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE, required: true }],
    ["judge-observation", { mediaType: BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE, required: true }],
    ["inspect-log", { mediaType: BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE, required: false }],
  ]);
  if (task.outputs.length < 2 || task.outputs.length > 3) {
    malformed("binary judgment Task has the wrong output slots");
  }
  const seen = new Set<string>();
  for (const output of task.outputs) {
    const expected = expectedSlots.get(output.name);
    if (
      expected === undefined
      || seen.has(output.name)
      || output.mediaType !== expected.mediaType
      || output.required !== expected.required
      || !exactKeys(output, ["name", "mediaType", "required"])
    ) {
      malformed("binary judgment Task has a malformed output slot");
    }
    seen.add(output.name);
  }
  if (!seen.has("judge-response") || !seen.has("judge-observation")) {
    malformed("binary judgment Task omits a required judge output");
  }

  let payload: BinaryJudgmentPayload;
  try {
    payload = parseBinaryJudgmentPayload(canonicalJsonBytes(task.payload));
  } catch (cause) {
    malformed("binary judgment Task payload is malformed", cause);
  }
  const itemDigest = recordDigest(canonicalJsonBytes(payload));
  if (task["network.jinn.binary-judgment.item-sha256"] !== itemDigest) {
    mismatch("binary judgment Task item commitment does not match its payload");
  }
  return payload;
}

interface BinaryResults {
  readonly response: ExactEvaluationMaterial;
  readonly observation: ExactEvaluationMaterial;
}

function requireResults(results: readonly ExactEvaluationMaterial[]): BinaryResults {
  if (results.length < 2 || results.length > 3) {
    missing("binary judgment evaluation requires response and observation Results");
  }
  const byName = new Map<string, ExactEvaluationMaterial>();
  for (const result of results) {
    const name = result.descriptor.name;
    if (typeof name !== "string" || byName.has(name)) {
      malformed("binary judgment Results have a missing or duplicate name");
    }
    byName.set(name, result);
  }
  for (const name of byName.keys()) {
    if (name !== "judge-response" && name !== "judge-observation" && name !== "inspect-log") {
      malformed("binary judgment Results contain an undeclared output");
    }
  }
  const response = byName.get("judge-response");
  const observation = byName.get("judge-observation");
  if (response === undefined || observation === undefined) {
    missing("binary judgment evaluation requires response and observation Results");
  }
  if (response.descriptor.mediaType !== BINARY_JUDGMENT_RESPONSE_MEDIA_TYPE) {
    malformed("judge-response has the wrong media type");
  }
  if (observation.descriptor.mediaType !== BINARY_JUDGMENT_OBSERVATION_MEDIA_TYPE) {
    malformed("judge-observation has the wrong media type");
  }
  const inspectLog = byName.get("inspect-log");
  if (
    inspectLog !== undefined
    && inspectLog.descriptor.mediaType !== BINARY_JUDGMENT_INSPECT_LOG_MEDIA_TYPE
  ) {
    malformed("inspect-log has the wrong media type");
  }
  for (const [name, material] of byName) descriptorDigest(material, name);
  return { response, observation };
}

function requireObservation(bytes: Uint8Array): BinaryJudgmentObservation {
  try {
    const observation = parseBinaryJudgmentObservation(bytes);
    requireCanonical(
      bytes,
      sealBinaryJudgmentObservation(observation).bytes,
      "binary judgment observation",
    );
    return observation;
  } catch (cause) {
    if (isEvaluationOperationalError(cause)) throw cause;
    malformed("binary judgment observation is malformed", cause);
  }
}

function digestFromDescriptor(value: unknown): `sha256:${string}` | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const digest = (value as Record<string, unknown>)["digest"];
  if (typeof digest !== "object" || digest === null || Array.isArray(digest)) return undefined;
  const sha256 = (digest as Record<string, unknown>)["sha256"];
  return typeof sha256 === "string" && /^[0-9a-f]{64}$/u.test(sha256)
    ? `sha256:${sha256}`
    : undefined;
}

function requireJoinedInputs(options: {
  readonly task: ExactEvaluationMaterial;
  readonly results: BinaryResults;
  readonly specification: EvaluationSpec;
  readonly inputs: BinaryJudgmentEvaluationInputs;
}): {
  readonly payload: BinaryJudgmentPayload;
  readonly observation: BinaryJudgmentObservation;
  readonly responseParse: BinaryJudgmentResponseParse;
} {
  const specificationDigest = sealEvaluationSpec(options.specification).digest;
  const payload = requireBinaryJudgmentTask(
    parseTaskMaterial(options.task),
    specificationDigest,
  );
  const observation = requireObservation(options.results.observation.bytes);
  const responseDigest = recordDigest(options.results.response.bytes);
  const observationDigest = recordDigest(options.results.observation.bytes);
  const taskDigest = documentDigest(options.task.bytes);
  const itemDigest = recordDigest(canonicalJsonBytes(payload));
  const instrumentDigest = recordDigest(options.inputs.instrumentBytes);
  const labelResolutionDigest = recordDigest(options.inputs.labelResolutionBytes);
  const analysisContextDigest = recordDigest(options.inputs.analysisContextBytes);
  const evaluationContext = options.inputs.evaluationContext;

  const joins: readonly [boolean, string][] = [
    [evaluationContext.evaluationSpecSha256 === specificationDigest, "evaluation context/specification"],
    [evaluationContext.taskDigest === taskDigest, "evaluation context/Task"],
    [observation.taskDigest === taskDigest, "observation/Task"],
    [evaluationContext.judgeObservationSha256 === observationDigest, "evaluation context/observation"],
    [evaluationContext.responseSha256 === responseDigest, "evaluation context/response"],
    [observation.response.digest === responseDigest, "observation/response"],
    [observation.instrumentSha256 === instrumentDigest, "observation/instrument"],
    [evaluationContext.material.instrument.digest === instrumentDigest, "evaluation context/instrument"],
    [evaluationContext.material.labelResolution.digest === labelResolutionDigest, "evaluation context/label resolution"],
    [evaluationContext.material.analysisContext.digest === analysisContextDigest, "evaluation context/analysis context"],
    [observation.armId === evaluationContext.armId, "observation/arm"],
    [observation.replicate === evaluationContext.replicate, "observation/replicate"],
    [options.inputs.analysisContext.itemSha256 === itemDigest, "analysis context/item"],
    [options.inputs.analysisContext.itemId === payload.itemId, "analysis context/item id"],
    [options.inputs.analysisContext.labelResolutionSha256 === labelResolutionDigest, "analysis context/label resolution"],
    [options.inputs.labelResolution.itemSha256 === itemDigest, "label resolution/item"],
    [options.inputs.labelResolution.itemId === payload.itemId, "label resolution/item id"],
    [options.inputs.labelResolution.truthLabel === options.inputs.analysisContext.truthLabel, "truth label projection"],
    [options.inputs.labelResolution.candidateClass === options.inputs.analysisContext.candidateClass, "candidate class projection"],
    [options.inputs.labelResolution.stratum === options.inputs.analysisContext.stratum, "stratum projection"],
    [binaryJudgmentSemanticRequestDigest(payload, options.inputs.instrument) === observation.requestSha256, "semantic request/observation"],
  ];
  for (const [matches, label] of joins) {
    if (!matches) mismatch(`binary judgment digest join failed: ${label}`);
  }

  const block = options.specification.familyBlock as DeterministicProcessBlock;
  const [analysisDescriptor] = block.testMaterial;
  if (digestFromDescriptor(analysisDescriptor) !== analysisContextDigest) {
    mismatch("EvaluationSpec analysis-context descriptor does not match evaluator material");
  }
  return {
    payload,
    observation,
    responseParse: parseBinaryJudgmentResponse(options.results.response.bytes),
  };
}

function agrees(decision: BinaryJudgmentDecision, truthLabel: BinaryJudgmentTruthLabel): boolean {
  return (decision === "ACCEPT" && truthLabel === "CORRECT")
    || (decision === "REJECT" && truthLabel === "WRONG");
}

function sameJson(left: unknown, right: unknown): boolean {
  return bytesEqual(canonicalJsonBytes(left), canonicalJsonBytes(right));
}

function exactAnalysisDescriptor(block: DeterministicProcessBlock): boolean {
  if (block.testMaterial.length !== 1) return false;
  const descriptor = block.testMaterial[0]!;
  return descriptor.name === BINARY_JUDGMENT_ANALYSIS_CONTEXT_NAME
    && descriptor.mediaType === BINARY_JUDGMENT_ANALYSIS_CONTEXT_MEDIA_TYPE
    && descriptor.accessClass === "private"
    && digestFromDescriptor(descriptor) !== undefined
    && exactKeys(descriptor, ["name", "digest", "mediaType", "accessClass"])
    && descriptor.digest !== undefined
    && exactKeys(descriptor.digest, ["sha256"]);
}

/** Exact registration gate for the one closed binary-judgment evaluation contract. */
export function isBinaryJudgmentEvaluationSpecification(
  specification: EvaluationSpec,
): boolean {
  if (
    specification.protocol !== EVALUATION_SPEC_FORMAT_URI
    || specification.semanticsVersion !== EVAL_SEMANTICS_VERSION
    || specification.family !== "deterministic-process"
  ) return false;
  const block = specification.familyBlock as DeterministicProcessBlock;
  const grader = specification.grader;
  if (Array.isArray(grader)) return false;
  return block.parser.id === BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.id
    && block.parser.version === BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.version
    && block.parser.digest === BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.digest
    && grader.name === BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.id
    && digestFromDescriptor(grader) === BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY.digest
    && grader.accessClass === "public"
    && block.transitions.failToPass.length === 0
    && block.transitions.passToPass.length === 0
    && exactAnalysisDescriptor(block)
    && sameJson(specification.measurements, binaryJudgmentEvaluationSpecMeasurements())
    && sameJson(specification.verdictRule, binaryJudgmentEvaluationSpecVerdictRule())
    && specification.unscorable.length === 0
    && sameJson(
      specification.evidenceConventions.requiredRefs,
      [BINARY_JUDGMENT_LABEL_RESOLUTION_NAME],
    );
}

export interface BinaryJudgmentAdapterOptions {
  readonly materialSource: BinaryJudgmentMaterialSource;
  /** Host clock seam; scoring and every scientific digest join remain clock-free. */
  readonly now?: () => Date;
}

export function createBinaryJudgmentEvaluatorAdapter(
  options: BinaryJudgmentAdapterOptions,
): EvaluatorAdapter {
  const now = options.now ?? (() => new Date());
  return {
    async evaluate(task, rawResults, specification, context, attempt, deadlineSignal) {
      if (deadlineSignal.aborted) {
        cancelled("the evaluation deadline elapsed before binary judgment scoring began");
      }
      if (!isBinaryJudgmentEvaluationSpecification(specification)) {
        operational({
          canonicalCode: "FAILED_PRECONDITION",
          reason: "unsupported-specification",
          recoveryAdvice: "do-not-retry",
          safeDetail: "the binary judgment evaluator does not serve this EvaluationSpec",
        });
      }
      const results = requireResults(rawResults);
      const inputs = await options.materialSource.read({
        specification,
        task,
        results: rawResults,
        context,
        attempt,
        deadlineSignal,
      });
      if (deadlineSignal.aborted) {
        cancelled("the evaluation deadline elapsed before binary judgment scoring began");
      }
      const { observation, responseParse } = requireJoinedInputs({
        task,
        results,
        specification,
        inputs,
      });
      const truthLabel = inputs.analysisContext.truthLabel;
      const agreement = agrees(responseParse.decision, truthLabel);
      const instrumentSha256 = recordDigest(inputs.instrumentBytes);
      const labelResolutionSha256 = recordDigest(inputs.labelResolutionBytes);
      const measurements: EvaluationMeasurement[] = [
        { name: BINARY_JUDGMENT_MEASUREMENTS.judgeDecision, value: responseParse.decision },
        { name: BINARY_JUDGMENT_MEASUREMENTS.truthLabel, value: truthLabel },
        { name: BINARY_JUDGMENT_MEASUREMENTS.agreement, value: agreement },
        { name: BINARY_JUDGMENT_MEASUREMENTS.parseValid, value: responseParse.parseValid },
        { name: BINARY_JUDGMENT_MEASUREMENTS.candidateClass, value: inputs.analysisContext.candidateClass },
        { name: BINARY_JUDGMENT_MEASUREMENTS.stratum, value: inputs.analysisContext.stratum },
        { name: BINARY_JUDGMENT_MEASUREMENTS.labelResolutionSha256, value: labelResolutionSha256 },
        { name: BINARY_JUDGMENT_MEASUREMENTS.instrumentSha256, value: instrumentSha256 },
      ];
      return {
        detailedOutcome: {
          protocol: BINARY_JUDGMENT_EVALUATION_OUTCOME_PROTOCOL,
          parser: BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY,
          itemId: inputs.analysisContext.itemId,
          judgeDecision: responseParse.decision,
          truthLabel,
          agreement,
          parseValid: responseParse.parseValid,
          ...(responseParse.invalidReason === undefined
            ? {}
            : { invalidReason: responseParse.invalidReason }),
          truthAdmission: inputs.labelResolution.truthAdmission,
          candidateClass: inputs.analysisContext.candidateClass,
          stratum: inputs.analysisContext.stratum,
          labelResolutionSha256,
          instrumentSha256,
        },
        verdict: agreement ? "pass" : "fail",
        evaluatedAt: now().toISOString(),
        measurements,
        explanation: agreement
          ? "The parsed judge decision agrees with the admitted truth label."
          : "The parsed judge decision disagrees with the admitted truth label.",
        limitations: [...observation.limitations],
        claimEvidence: [{
          kind: "content",
          name: BINARY_JUDGMENT_LABEL_RESOLUTION_NAME,
          bytes: inputs.labelResolutionBytes,
          mediaType: BINARY_JUDGMENT_LABEL_RESOLUTION_MEDIA_TYPE,
        }],
      } satisfies CompletedEvaluation;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Registration-specific defense against adapter or composition drift. */
export function validateBinaryJudgmentCompletedEvaluation(
  evaluation: CompletedEvaluation,
): CompletedEvaluation {
  const outcome = evaluation.detailedOutcome;
  if (!isRecord(outcome)) malformed("binary judgment detailedOutcome must be an object");
  const allowedOutcomeKeys = [
    "protocol",
    "parser",
    "itemId",
    "judgeDecision",
    "truthLabel",
    "agreement",
    "parseValid",
    "truthAdmission",
    "candidateClass",
    "stratum",
    "labelResolutionSha256",
    "instrumentSha256",
    ...(outcome["parseValid"] === false ? ["invalidReason"] : []),
  ];
  if (!exactKeys(outcome, allowedOutcomeKeys)) {
    malformed("binary judgment detailedOutcome is outside the closed shape");
  }
  const judgeDecision = outcome["judgeDecision"];
  const truthLabel = outcome["truthLabel"];
  const agreement = outcome["agreement"];
  if (
    outcome["protocol"] !== BINARY_JUDGMENT_EVALUATION_OUTCOME_PROTOCOL
    || !sameJson(outcome["parser"], BINARY_JUDGMENT_EVALUATION_PARSER_IDENTITY)
    || (judgeDecision !== "ACCEPT" && judgeDecision !== "REJECT")
    || (truthLabel !== "CORRECT" && truthLabel !== "WRONG")
    || typeof outcome["parseValid"] !== "boolean"
    || (outcome["truthAdmission"] !== "two-human-unanimous"
      && outcome["truthAdmission"] !== "operator-only")
    || typeof outcome["itemId"] !== "string"
    || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(outcome["itemId"] as string)
    || typeof outcome["candidateClass"] !== "string"
    || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(outcome["candidateClass"] as string)
    || (outcome["stratum"] !== "core" && outcome["stratum"] !== "stress")
    || typeof outcome["labelResolutionSha256"] !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(outcome["labelResolutionSha256"] as string)
    || typeof outcome["instrumentSha256"] !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(outcome["instrumentSha256"] as string)
    || (outcome["parseValid"] === false && judgeDecision !== "REJECT")
    || agreement !== agrees(judgeDecision, truthLabel)
    || evaluation.verdict !== (agreement ? "pass" : "fail")
  ) {
    malformed("binary judgment detailedOutcome is internally inconsistent");
  }
  if (
    outcome["parseValid"] === false
    && outcome["invalidReason"] !== "invalid-utf8"
    && outcome["invalidReason"] !== "unexpected-token"
  ) {
    malformed("binary judgment invalid response reason is missing or invalid");
  }

  const expectedValues: Record<string, unknown> = {
    [BINARY_JUDGMENT_MEASUREMENTS.judgeDecision]: judgeDecision,
    [BINARY_JUDGMENT_MEASUREMENTS.truthLabel]: truthLabel,
    [BINARY_JUDGMENT_MEASUREMENTS.agreement]: agreement,
    [BINARY_JUDGMENT_MEASUREMENTS.parseValid]: outcome["parseValid"],
    [BINARY_JUDGMENT_MEASUREMENTS.candidateClass]: outcome["candidateClass"],
    [BINARY_JUDGMENT_MEASUREMENTS.stratum]: outcome["stratum"],
    [BINARY_JUDGMENT_MEASUREMENTS.labelResolutionSha256]: outcome["labelResolutionSha256"],
    [BINARY_JUDGMENT_MEASUREMENTS.instrumentSha256]: outcome["instrumentSha256"],
  };
  const measurements = evaluation.measurements ?? [];
  if (measurements.length !== binaryJudgmentEvaluationSpecMeasurements().length) {
    malformed("binary judgment CompletedEvaluation has the wrong measurements");
  }
  const seen = new Set<string>();
  for (const measurement of measurements) {
    if (seen.has(measurement.name) || measurement.unit !== undefined) {
      malformed("binary judgment CompletedEvaluation repeats or units a measurement");
    }
    seen.add(measurement.name);
    if (!Object.hasOwn(expectedValues, measurement.name)
      || measurement.value !== expectedValues[measurement.name]) {
      malformed("binary judgment CompletedEvaluation measurement is inconsistent");
    }
  }
  const evidence = evaluation.claimEvidence ?? [];
  if (
    evidence.length !== 1
    || evidence[0]?.kind !== "content"
    || evidence[0].name !== BINARY_JUDGMENT_LABEL_RESOLUTION_NAME
    || evidence[0].mediaType !== BINARY_JUDGMENT_LABEL_RESOLUTION_MEDIA_TYPE
    || recordDigest(evidence[0].bytes) !== outcome["labelResolutionSha256"]
  ) {
    malformed("binary judgment CompletedEvaluation label evidence is inconsistent");
  }
  try {
    const content = evidence[0] as Extract<NonNullable<CompletedEvaluation["claimEvidence"]>[number], {
      kind: "content";
    }>;
    const resolution = parseBinaryJudgmentLabelResolution(content.bytes);
    requireCanonical(
      content.bytes,
      sealBinaryJudgmentLabelResolution(resolution).bytes,
      "binary judgment CompletedEvaluation label evidence",
    );
    if (
      resolution.itemId !== outcome["itemId"]
      || resolution.truthLabel !== truthLabel
      || resolution.truthAdmission !== outcome["truthAdmission"]
      || resolution.candidateClass !== outcome["candidateClass"]
      || resolution.stratum !== outcome["stratum"]
    ) {
      malformed("binary judgment CompletedEvaluation label projection is inconsistent");
    }
  } catch (cause) {
    if (isEvaluationOperationalError(cause)) throw cause;
    malformed("binary judgment CompletedEvaluation label evidence is malformed", cause);
  }
  return evaluation;
}
