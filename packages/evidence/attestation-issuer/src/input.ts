// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";

import { cloneJsonValue } from "./deterministic-json.js";
import { AttestationIssuerError, invalidInput } from "./errors.js";
import type {
  AttestationAgentReference,
  AttestationResourceReference,
  EvaluationMeasurement,
  JsonValue,
  PrepareExecutionVerificationInput,
  PrepareResultEvaluationInput,
  VerificationCheck,
} from "./types.js";

type JsonObject = Record<string, JsonValue>;
const DIGEST = /^sha256:([0-9a-f]{64})$/u;
const ASCII_UNRESERVED = /^[A-Za-z0-9._~-]$/u;
const SUB_DELIMITERS = "!$&'()*+,;=";

const statementReserved = new Set(["_type", "subject", "predicateType", "predicate"]);
const evaluationPredicateReserved = new Set([
  "evaluatedAt", "evaluator", "evaluationMethod", "evaluationSpecification",
  "taskSubject", "resultSubjects", "verdict", "measurements", "evidence",
  "explanation", "limitations", "supersedes", "disputes",
]);
const verificationPredicateReserved = new Set([
  "verifiedAt", "verifier", "verificationMethod", "verificationPolicy",
  "executionId", "verdict", "checks", "explanation", "limitations",
  "supersedes", "disputes",
]);
const resourceReserved = new Set([
  "name",
  "digest",
  "uri",
  "content",
  "mediaType",
  "downloadLocation",
  "annotations",
]);
const agentReserved = new Set(["id"]);
const measurementReserved = new Set(["name", "value", "unit", "annotations"]);
const checkReserved = new Set(["name", "status", "explanation", "evidence", "annotations"]);

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalidInput(`${label} must be a non-empty string.`);
  }
  return value;
}

function optionalNonempty(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalidInput(`${label} must be a string.`);
  return value;
}

function snapshotRecord(value: unknown, label: string): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      invalidInput(`${label} must be an object.`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidInput(`${label} must have a safe plain-object prototype.`);
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        invalidInput(`${label} must not contain symbol properties.`);
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        invalidInput(`${label} must contain only enumerable data properties.`);
      }
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
    return snapshot;
  } catch (cause) {
    if (
      cause instanceof AttestationIssuerError &&
      cause.code === "INVALID_ISSUANCE_INPUT"
    ) {
      throw cause;
    }
    invalidInput(`${label} must be a readable plain data object.`, cause);
  }
}

function snapshotDenseArray(value: unknown, label: string): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      invalidInput(`${label} must be an array.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors["length"] as
      | PropertyDescriptor
      | undefined;
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > 0xffff_ffff
    ) {
      invalidInput(`${label} must have a valid data-property length.`);
    }
    const length = lengthDescriptor.value as number;
    const ownKeys = Reflect.ownKeys(descriptors);
    for (let index = 0; index < ownKeys.length; index += 1) {
      const key = ownKeys[index]!;
      if (
        typeof key !== "string" ||
        (
          key !== "length" &&
          (
            !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
            Number(key) >= length ||
            Number(key) > 0xffff_fffe
          )
        )
      ) {
        invalidInput(`${label} must not contain non-index properties.`);
      }
    }
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        invalidInput(`${label} must be a dense data-property array.`);
      }
      snapshot[index] = descriptor.value;
    }
    return snapshot;
  } catch (cause) {
    if (
      cause instanceof AttestationIssuerError &&
      cause.code === "INVALID_ISSUANCE_INPUT"
    ) {
      throw cause;
    }
    invalidInput(`${label} must be a readable dense data-property array.`, cause);
  }
}

function isUcsCharacter(codePoint: number): boolean {
  if (
    (codePoint >= 0x00a0 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfdcf) ||
    (codePoint >= 0xfdf0 && codePoint <= 0xffef)
  ) {
    return true;
  }
  if (
    codePoint >= 0x10000 &&
    codePoint <= 0xdfffd &&
    (codePoint & 0xffff) <= 0xfffd
  ) {
    return true;
  }
  return (
    codePoint >= 0xe1000 &&
    codePoint <= 0xefffd &&
    (codePoint & 0xffff) <= 0xfffd
  );
}

function isPrivateQueryCharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  );
}

function isIriComponent(
  value: string,
  extraAscii: string,
  allowPrivate = false,
): boolean {
  if (/[\p{Cc}\p{Cs}]/u.test(value)) return false;
  for (let index = 0; index < value.length;) {
    if (value[index] === "%") {
      if (!/^[0-9A-Fa-f]{2}$/u.test(value.slice(index + 1, index + 3))) {
        return false;
      }
      index += 3;
      continue;
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) return false;
    if (codePoint < 0x80) {
      const character = value[index]!;
      if (
        !ASCII_UNRESERVED.test(character) &&
        !SUB_DELIMITERS.includes(character) &&
        !extraAscii.includes(character)
      ) {
        return false;
      }
    } else if (
      !isUcsCharacter(codePoint) &&
      !(allowPrivate && isPrivateQueryCharacter(codePoint))
    ) {
      return false;
    }
    index += codePoint > 0xffff ? 2 : 1;
  }
  return true;
}

function isValidIpLiteral(value: string): boolean {
  if (isIP(value) === 6) return true;
  return /^v[0-9A-F]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+$/iu.test(value);
}

function isValidAuthority(value: string): boolean {
  const firstAt = value.indexOf("@");
  if (firstAt !== value.lastIndexOf("@")) return false;
  const userInfo = firstAt === -1 ? undefined : value.slice(0, firstAt);
  const hostPort = firstAt === -1 ? value : value.slice(firstAt + 1);
  if (userInfo !== undefined && !isIriComponent(userInfo, ":")) return false;

  if (hostPort.startsWith("[")) {
    const closingBracket = hostPort.indexOf("]");
    if (closingBracket <= 1) return false;
    const host = hostPort.slice(1, closingBracket);
    const remainder = hostPort.slice(closingBracket + 1);
    return (
      isValidIpLiteral(host) &&
      (remainder === "" || /^:[0-9]*$/u.test(remainder))
    );
  }
  if (hostPort.includes("[") || hostPort.includes("]")) return false;

  const firstColon = hostPort.indexOf(":");
  if (firstColon !== hostPort.lastIndexOf(":")) return false;
  const host = firstColon === -1 ? hostPort : hostPort.slice(0, firstColon);
  const port = firstColon === -1 ? undefined : hostPort.slice(firstColon + 1);
  return (
    isIriComponent(host, "") &&
    (port === undefined || /^[0-9]*$/u.test(port))
  );
}

function isAbsoluteIri(value: string): boolean {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.exec(value);
  if (scheme === null || /[\p{Cc}\p{Cs}]/u.test(value)) return false;
  const remainder = value.slice(scheme[0].length);

  const fragmentStart = remainder.indexOf("#");
  if (
    fragmentStart !== -1 &&
    fragmentStart !== remainder.lastIndexOf("#")
  ) {
    return false;
  }
  const beforeFragment = fragmentStart === -1
    ? remainder
    : remainder.slice(0, fragmentStart);
  const fragment = fragmentStart === -1
    ? undefined
    : remainder.slice(fragmentStart + 1);
  if (
    fragment !== undefined &&
    !isIriComponent(fragment, ":@/?")
  ) {
    return false;
  }

  const queryStart = beforeFragment.indexOf("?");
  const hierarchy = queryStart === -1
    ? beforeFragment
    : beforeFragment.slice(0, queryStart);
  const query = queryStart === -1
    ? undefined
    : beforeFragment.slice(queryStart + 1);
  if (
    query !== undefined &&
    !isIriComponent(query, ":@/?", true)
  ) {
    return false;
  }

  if (!hierarchy.startsWith("//")) {
    return isIriComponent(hierarchy, ":@/");
  }
  const authorityAndPath = hierarchy.slice(2);
  const pathStart = authorityAndPath.indexOf("/");
  const authority = pathStart === -1
    ? authorityAndPath
    : authorityAndPath.slice(0, pathStart);
  const path = pathStart === -1 ? "" : authorityAndPath.slice(pathStart);
  return isValidAuthority(authority) && isIriComponent(path, ":@/");
}

function absoluteIri(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!isAbsoluteIri(text)) {
    invalidInput(`${label} must be an absolute IRI.`);
  }
  return text;
}

function extensions(
  value: unknown,
  reserved: ReadonlySet<string>,
  label: string,
): JsonObject {
  if (value === undefined) return {};
  const cloned = cloneJsonValue(value);
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") {
    invalidInput(`${label} extensions must be a JSON object.`);
  }
  for (const key of Object.keys(cloned)) {
    if (reserved.has(key)) invalidInput(`${label} extension "${key}" is reserved.`);
  }
  return cloned as JsonObject;
}

function annotations(value: unknown, label: string): JsonObject | undefined {
  if (value === undefined) return undefined;
  const cloned = cloneJsonValue(value);
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") {
    invalidInput(`${label} annotations must be a JSON object.`);
  }
  return cloned as JsonObject;
}

export interface NormalizedResourceDescriptor extends JsonObject {
  readonly name: string;
  readonly digest: { readonly sha256: string } & JsonObject;
}

export function normalizeResource(
  reference: AttestationResourceReference,
  label: string,
): NormalizedResourceDescriptor {
  const accepted = snapshotRecord(reference, `${label} resource reference`);
  const name = requiredString(accepted.name, `${label} name`);
  const match = typeof accepted.digest === "string"
    ? DIGEST.exec(accepted.digest)
    : null;
  if (!match) invalidInput(`${label} digest must be canonical lowercase sha256.`);
  const ext = extensions(accepted.extensions, resourceReserved, label);
  const normalized: JsonObject = {
    ...ext,
    name,
    digest: { sha256: match![1]! },
  };
  if (accepted.uri !== undefined) normalized.uri = optionalString(accepted.uri, `${label} uri`)!;
  if (accepted.mediaType !== undefined) {
    normalized.mediaType = optionalString(accepted.mediaType, `${label} mediaType`)!;
  }
  const note = annotations(accepted.annotations, label);
  if (note !== undefined) normalized.annotations = note;
  return normalized as NormalizedResourceDescriptor;
}

function normalizeAgent(reference: AttestationAgentReference, label: string): JsonObject {
  const accepted = snapshotRecord(reference, `${label} Agent reference`);
  return {
    ...extensions(accepted.extensions, agentReserved, label),
    id: absoluteIri(accepted.id, `${label} id`),
  };
}

function normalizeMeasurement(value: EvaluationMeasurement, index: number): JsonObject {
  const label = `measurement ${index}`;
  const accepted = snapshotRecord(value, label);
  const scalar = cloneJsonValue(accepted.value);
  if (typeof scalar === "object" && scalar !== null) {
    invalidInput(`${label} value must be a JSON scalar.`);
  }
  const output: JsonObject = {
    ...extensions(accepted.extensions, measurementReserved, label),
    name: requiredString(accepted.name, `${label} name`),
    value: scalar,
  };
  if (accepted.unit !== undefined) output.unit = optionalString(accepted.unit, `${label} unit`)!;
  const note = annotations(accepted.annotations, label);
  if (note !== undefined) output.annotations = note;
  return output;
}

function normalizeCheck(value: VerificationCheck, index: number): JsonObject {
  const label = `check ${index}`;
  const accepted = snapshotRecord(value, label);
  if (!["pass", "fail", "unknown"].includes(accepted.status as string)) {
    invalidInput(`${label} status is invalid.`);
  }
  const output: JsonObject = {
    ...extensions(accepted.extensions, checkReserved, label),
    name: requiredString(accepted.name, `${label} name`),
    status: accepted.status as JsonValue,
  };
  const explanation = optionalNonempty(accepted.explanation, `${label} explanation`);
  if (explanation !== undefined) output.explanation = explanation;
  if (accepted.evidence !== undefined) {
    output.evidence = resources(
      accepted.evidence as readonly AttestationResourceReference[],
      `${label} evidence`,
    )!;
  }
  const note = annotations(accepted.annotations, label);
  if (note !== undefined) output.annotations = note;
  return output;
}

function stringList(value: readonly string[] | undefined, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  const values = snapshotDenseArray(value, label);
  const normalized: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    normalized[index] = optionalString(values[index], `${label} ${index}`)!;
  }
  return normalized;
}

function resources(
  value: readonly AttestationResourceReference[] | undefined,
  label: string,
): NormalizedResourceDescriptor[] | undefined {
  if (value === undefined) return undefined;
  const values = snapshotDenseArray(value, label);
  const normalized: NormalizedResourceDescriptor[] = [];
  for (let index = 0; index < values.length; index += 1) {
    normalized[index] = normalizeResource(
      values[index] as AttestationResourceReference,
      `${label} ${index}`,
    );
  }
  return normalized;
}

export interface NormalizedResultEvaluation {
  readonly statementExtensions: JsonObject;
  readonly predicateExtensions: JsonObject;
  readonly task: NormalizedResourceDescriptor;
  readonly results: readonly NormalizedResourceDescriptor[];
  readonly predicate: JsonObject;
}

export function normalizeResultEvaluationInput(
  input: PrepareResultEvaluationInput,
): NormalizedResultEvaluation {
  const accepted = snapshotRecord(input, "Result Evaluation input");
  const resultValues = snapshotDenseArray(
    accepted.results,
    "Result Evaluation results",
  );
  if (resultValues.length === 0) {
    invalidInput("Result Evaluation requires at least one Result.");
  }
  if (!["pass", "fail", "inconclusive"].includes(accepted.verdict as string)) {
    invalidInput("Evaluation verdict is invalid.");
  }
  const task = normalizeResource(
    accepted.task as AttestationResourceReference,
    "Task",
  );
  const results: NormalizedResourceDescriptor[] = [];
  const names = [task.name];
  for (let index = 0; index < resultValues.length; index += 1) {
    const result = normalizeResource(
      resultValues[index] as AttestationResourceReference,
      `Result ${index}`,
    );
    results[index] = result;
    names[index + 1] = result.name;
  }
  if (new Set(names).size !== names.length) {
    invalidInput("Task and Result subject names must be unique.");
  }
  const resultSubjects: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    resultSubjects[index] = results[index]!.name;
  }
  const predicate: JsonObject = {
    ...extensions(
      accepted.predicateExtensions,
      evaluationPredicateReserved,
      "evaluation predicate",
    ),
    evaluatedAt: requiredString(accepted.evaluatedAt, "evaluatedAt"),
    evaluator: normalizeAgent(
      accepted.evaluator as AttestationAgentReference,
      "evaluator",
    ),
    taskSubject: task.name,
    resultSubjects,
    verdict: accepted.verdict as JsonValue,
  };
  const optionalResources = [
    ["evaluationSpecification", accepted.evaluationSpecification],
    ["evaluationMethod", accepted.evaluationMethod],
  ] as const;
  for (const [key, value] of optionalResources) {
    if (value !== undefined) {
      predicate[key] = normalizeResource(
        value as AttestationResourceReference,
        key,
      );
    }
  }
  const inputMeasurements = accepted.measurements;
  if (inputMeasurements !== undefined) {
    const measurementValues = snapshotDenseArray(inputMeasurements, "measurements");
    const measurements: JsonObject[] = [];
    for (let index = 0; index < measurementValues.length; index += 1) {
      measurements[index] = normalizeMeasurement(
        measurementValues[index] as EvaluationMeasurement,
        index,
      );
    }
    predicate.measurements = measurements;
  }
  for (const [key, value] of [
    ["evidence", accepted.evidence],
    ["supersedes", accepted.supersedes],
    ["disputes", accepted.disputes],
  ] as const) {
    const normalized = resources(
      value as readonly AttestationResourceReference[] | undefined,
      key,
    );
    if (normalized !== undefined) predicate[key] = normalized;
  }
  const explanation = optionalNonempty(accepted.explanation, "explanation");
  if (explanation !== undefined) predicate.explanation = explanation;
  const limitations = stringList(
    accepted.limitations as readonly string[] | undefined,
    "limitation",
  );
  if (limitations !== undefined) predicate.limitations = limitations;
  return {
    statementExtensions: extensions(
      accepted.statementExtensions,
      statementReserved,
      "Statement",
    ),
    predicateExtensions: {},
    task,
    results,
    predicate,
  };
}

export interface NormalizedExecutionVerification {
  readonly statementExtensions: JsonObject;
  readonly subject: NormalizedResourceDescriptor;
  readonly predicate: JsonObject;
}

export function normalizeExecutionVerificationInput(
  input: PrepareExecutionVerificationInput,
): NormalizedExecutionVerification {
  const accepted = snapshotRecord(input, "Execution Verification input");
  if (
    !["verified", "rejected", "inconclusive"].includes(
      accepted.verdict as string,
    )
  ) {
    invalidInput("Verification verdict is invalid.");
  }
  const subject = normalizeResource({
    name: "ro-crate-metadata.json",
    digest: accepted.executionEvidenceDigest as
      PrepareExecutionVerificationInput["executionEvidenceDigest"],
  }, "Execution Evidence");
  const predicate: JsonObject = {
    ...extensions(
      accepted.predicateExtensions,
      verificationPredicateReserved,
      "verification predicate",
    ),
    executionId: absoluteIri(accepted.executionId, "executionId"),
    verifiedAt: requiredString(accepted.verifiedAt, "verifiedAt"),
    verifier: normalizeAgent(
      accepted.verifier as AttestationAgentReference,
      "verifier",
    ),
    verdict: accepted.verdict as JsonValue,
  };
  for (const [key, value] of [
    ["verificationPolicy", accepted.verificationPolicy],
    ["verificationMethod", accepted.verificationMethod],
  ] as const) {
    if (value !== undefined) {
      predicate[key] = normalizeResource(
        value as AttestationResourceReference,
        key,
      );
    }
  }
  const inputChecks = accepted.checks;
  if (inputChecks !== undefined) {
    const checkValues = snapshotDenseArray(inputChecks, "checks");
    const checks: JsonObject[] = [];
    for (let index = 0; index < checkValues.length; index += 1) {
      checks[index] = normalizeCheck(
        checkValues[index] as VerificationCheck,
        index,
      );
    }
    predicate.checks = checks;
  }
  for (const [key, value] of [
    ["supersedes", accepted.supersedes],
    ["disputes", accepted.disputes],
  ] as const) {
    const normalized = resources(
      value as readonly AttestationResourceReference[] | undefined,
      key,
    );
    if (normalized !== undefined) predicate[key] = normalized;
  }
  const explanation = optionalNonempty(accepted.explanation, "explanation");
  if (explanation !== undefined) predicate.explanation = explanation;
  const limitations = stringList(
    accepted.limitations as readonly string[] | undefined,
    "limitation",
  );
  if (limitations !== undefined) predicate.limitations = limitations;
  return {
    statementExtensions: extensions(
      accepted.statementExtensions,
      statementReserved,
      "Statement",
    ),
    subject,
    predicate,
  };
}
