// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { basename, join } from "node:path";
import {
  prepareResultEvaluation,
  type AttestationResourceReference,
  type EvaluationMeasurement as IssuerMeasurement,
} from "@jinn-network/attestation-issuer";
import type { ResourceDescriptorSchema } from "@jinn-network/evidence-protocol";
import {
  checkMeasurementCoverage,
  checkVerdictConsistency,
  deriveEvaluationTask,
  EVALUATION_TASK_PROFILE_URI,
  parseEvaluationSpec,
  parserAllowlistKey,
  ProfilesError,
  type DeterministicProcessBlock,
  type EvaluationSpec,
  type MeasurementMap,
} from "@jinn-network/task-execution-profiles";
import {
  documentDigest,
  sealDelivery,
  sealTask,
  validateDelivery,
  validateTask,
  type DeliveryRecord,
  type TaskSpecification,
} from "@jinn-network/task-execution-protocol";
import type { AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { WorkspacePaths } from "@jinn-network/task-execution-workspace";
import {
  EvaluationOperationalError,
  validateCompletedEvaluation,
  type ClaimEvidence,
  type CompletedEvaluation,
  type EvaluationMeasurement,
  type ExactEvaluationMaterial,
  type ResourceDescriptor,
} from "./adapter.js";
import type { EvaluatorRegistration } from "./registration.js";
import { makeSecretsSigner } from "./sign.js";

export const EVALUATION_HARNESS_EXIT_INVALID_INPUT = 65;
export const EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE = 70;
export const EVALUATION_HARNESS_EXIT_CONFIGURATION = 78;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SHA256_HEX = /^[0-9a-f]{64}$/u;

type ParsedResourceDescriptor = ReturnType<
  (typeof ResourceDescriptorSchema)["parse"]
>;

export interface EvaluationHarnessDeployment {
  /** Host-authored registrations. No registration is selected from Task/spec bytes. */
  readonly registrations: readonly EvaluatorRegistration[];
  /** Exact parser identity keys produced by `parserAllowlistKey`. */
  readonly parserAllowlist: ReadonlySet<string>;
}

class EvaluationHarnessInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvaluationHarnessInputError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new EvaluationHarnessInputError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EvaluationHarnessInputError(`${label} must be a non-empty string`);
  }
  return value;
}

function digest(value: unknown, label: string): `sha256:${string}` {
  const text = string(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(text)) {
    throw new EvaluationHarnessInputError(
      `${label} must be a canonical lowercase sha256 digest`,
    );
  }
  return text as `sha256:${string}`;
}

function digestObject(
  value: unknown,
  label: string,
): { readonly sha256: string } {
  const record = object(value, label);
  const sha256 = string(record["sha256"], `${label}.sha256`);
  if (!SHA256_HEX.test(sha256)) {
    throw new EvaluationHarnessInputError(
      `${label}.sha256 must be 64 lowercase hexadecimal characters`,
    );
  }
  return { sha256 };
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch (cause) {
    throw new EvaluationHarnessInputError(`${label} is not valid UTF-8 JSON`, {
      cause,
    });
  }
}

function safeMaterialName(value: unknown, label: string): string {
  const name = string(value, label);
  if (basename(name) !== name || name === "." || name === "..") {
    throw new EvaluationHarnessInputError(
      `${label} must be one material filename`,
    );
  }
  return name;
}

interface SubjectReference {
  readonly name: string;
  readonly digest: `sha256:${string}`;
}

function subjectReference(value: unknown, label: string): SubjectReference {
  const reference = object(value, label);
  return {
    name: safeMaterialName(reference["name"], `${label}.name`),
    digest: digest(reference["digest"], `${label}.digest`),
  };
}

async function readExactMaterial(
  inputDir: string,
  reference: SubjectReference,
): Promise<ExactEvaluationMaterial> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(join(inputDir, reference.name));
  } catch (cause) {
    throw new EvaluationHarnessInputError(
      `verified input material ${reference.name} is unavailable`,
      { cause },
    );
  }
  const observed = sha256(bytes);
  if (observed !== reference.digest) {
    throw new EvaluationHarnessInputError(
      `verified input material ${reference.name} no longer matches its digest`,
    );
  }
  return {
    descriptor: {
      name: reference.name,
      digest: { sha256: observed.slice("sha256:".length) },
    },
    bytes,
  };
}

interface EvaluationTaskBindings {
  readonly subjectTask: SubjectReference;
  readonly subjectDelivery: SubjectReference;
  readonly subjectResults: readonly SubjectReference[];
  readonly evaluationSpec: `sha256:${string}`;
}

async function readEvaluationTask(
  paths: WorkspacePaths,
): Promise<EvaluationTaskBindings> {
  const task = object(
    parseJson(await readFile(join(paths.input, "task.sealed")), "evaluation Task"),
    "evaluation Task",
  );
  const profile = object(task["profile"], "evaluation Task profile");
  if (profile["uri"] !== EVALUATION_TASK_PROFILE_URI) {
    throw new EvaluationHarnessInputError(
      "Task does not select evaluation-task/1.0",
    );
  }
  const payload = object(task["payload"], "evaluation Task payload");
  if (!Array.isArray(payload["subjectResults"])) {
    throw new EvaluationHarnessInputError(
      "evaluation Task payload.subjectResults must be an array",
    );
  }
  const subjectResults = payload["subjectResults"].map((value, index) =>
    subjectReference(value, `evaluation Task payload.subjectResults[${index}]`)
  );
  if (subjectResults.length === 0) {
    throw new EvaluationHarnessInputError(
      "evaluation Task requires at least one subject Result",
    );
  }
  const names = subjectResults.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    throw new EvaluationHarnessInputError(
      "evaluation Task subject Result names must be unique",
    );
  }
  return {
    subjectTask: subjectReference(
      payload["subjectTask"],
      "evaluation Task payload.subjectTask",
    ),
    subjectDelivery: subjectReference(
      payload["subjectDelivery"],
      "evaluation Task payload.subjectDelivery",
    ),
    subjectResults,
    evaluationSpec: digest(
      payload["evaluationSpec"],
      "evaluation Task payload.evaluationSpec",
    ),
  };
}

async function optionalContext(
  inputDir: string,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    return object(
      parseJson(
        await readFile(join(inputDir, "evaluation-context.json")),
        "evaluation context",
      ),
      "evaluation context",
    );
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return {};
    }
    throw cause;
  }
}

async function attemptIdentity(inputDir: string): Promise<AttemptIdentity> {
  const dispatch = object(
    parseJson(
      await readFile(join(inputDir, "dispatch-context.json")),
      "dispatch context",
    ),
    "dispatch context",
  );
  return {
    attemptUri: string(
      dispatch["attempt"],
      "dispatch context attempt",
    ) as AttemptIdentity["attemptUri"],
    nonce: string(dispatch["nonce"], "dispatch context nonce"),
    // The local v1 backend admits exactly one Attempt per Submission.
    attemptNumber: 1,
  };
}

function validateCrosswalk(
  task: ExactEvaluationMaterial,
  specificationDigest: `sha256:${string}`,
): AttestationResourceReference {
  const taskDocument = object(
    parseJson(task.bytes, "subject Task"),
    "subject Task",
  );
  const evaluation = object(
    taskDocument["evaluation"],
    "subject Task evaluation descriptor",
  );
  const declared = digestObject(
    evaluation["digest"],
    "subject Task evaluation descriptor digest",
  );
  if (`sha256:${declared.sha256}` !== specificationDigest) {
    throw new EvaluationHarnessInputError(
      "subject Task evaluation descriptor does not match the exact EvaluationSpec",
    );
  }
  return {
    name: string(
      evaluation["name"] ?? "evaluation-spec.json",
      "subject Task evaluation descriptor name",
    ),
    digest: specificationDigest,
    ...(evaluation["uri"] === undefined
      ? {}
      : {
          uri: string(
            evaluation["uri"],
            "subject Task evaluation descriptor uri",
          ),
        }),
    ...(evaluation["mediaType"] === undefined
      ? {}
      : {
          mediaType: string(
            evaluation["mediaType"],
            "subject Task evaluation descriptor mediaType",
          ),
        }),
  };
}

function validateSubjectBindings(input: {
  readonly evaluationTaskBytes: Uint8Array;
  readonly bindings: EvaluationTaskBindings;
  readonly task: ExactEvaluationMaterial;
  readonly delivery: ExactEvaluationMaterial;
  readonly results: readonly ExactEvaluationMaterial[];
}): void {
  const taskDocument = parseJson(input.task.bytes, "subject Task");
  const taskValidation = validateTask(taskDocument);
  if (!taskValidation.conforms || !bytesEqual(sealTask(taskDocument), input.task.bytes)) {
    throw new EvaluationHarnessInputError("subject Task is not exact canonical Task bytes");
  }
  const deliveryDocument = parseJson(input.delivery.bytes, "subject Delivery");
  const deliveryValidation = validateDelivery(deliveryDocument);
  if (
    !deliveryValidation.conforms
    || !bytesEqual(sealDelivery(deliveryDocument), input.delivery.bytes)
  ) {
    throw new EvaluationHarnessInputError("subject Delivery is not exact canonical Delivery bytes");
  }
  const task = taskDocument as TaskSpecification;
  const delivery = deliveryDocument as DeliveryRecord;
  if (delivery.task !== documentDigest(input.task.bytes)) {
    throw new EvaluationHarnessInputError("subject Delivery is bound to a different Task");
  }
  if (delivery.outputs.length !== input.results.length) {
    throw new EvaluationHarnessInputError("subject Delivery output cardinality does not match supplied Results");
  }
  const taskOutputs = new Map(task.outputs.map((output) => [output.name, output]));
  const deliveryOutputs = new Map(delivery.outputs.map((output) => [output.name, output]));
  if (deliveryOutputs.size !== delivery.outputs.length) {
    throw new EvaluationHarnessInputError("subject Delivery output names must be unique");
  }
  for (const result of input.results) {
    const output = deliveryOutputs.get(result.descriptor.name);
    const taskOutput = taskOutputs.get(result.descriptor.name);
    if (
      output === undefined
      || taskOutput === undefined
      || output.mediaType !== taskOutput.mediaType
      || output.digest?.sha256 === undefined
      || `sha256:${output.digest.sha256}` !== sha256(result.bytes)
    ) {
      throw new EvaluationHarnessInputError("supplied Results do not exactly match subject Delivery outputs");
    }
  }
  const rederived = deriveEvaluationTask({
    subjectTask: input.bindings.subjectTask,
    subjectDelivery: input.bindings.subjectDelivery,
    subjectResults: [...input.bindings.subjectResults],
    evaluationSpecDigest: input.bindings.evaluationSpec,
  });
  if (!bytesEqual(rederived.bytes, input.evaluationTaskBytes)) {
    throw new EvaluationHarnessInputError("evaluation Task does not equal the profiles derivation");
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== allowed.length ||
    keys.some((key) => !allowed.includes(key))
  ) {
    throw new EvaluationHarnessInputError(
      `${label} is outside the closed declarative verdict vocabulary`,
    );
  }
}

function assertClosedVerdictRule(value: unknown, label = "verdictRule"): void {
  const rule = object(value, label);
  if (Object.hasOwn(rule, "threshold")) {
    exactKeys(rule, ["threshold"], label);
    exactKeys(
      object(rule["threshold"], `${label}.threshold`),
      ["measurement", "op", "value"],
      `${label}.threshold`,
    );
    return;
  }
  if (Object.hasOwn(rule, "all") || Object.hasOwn(rule, "any")) {
    const key = Object.hasOwn(rule, "all") ? "all" : "any";
    exactKeys(rule, [key], label);
    const children = rule[key];
    if (!Array.isArray(children)) {
      throw new EvaluationHarnessInputError(`${label}.${key} must be an array`);
    }
    children.forEach((child, index) =>
      assertClosedVerdictRule(child, `${label}.${key}[${index}]`)
    );
    return;
  }
  if (Object.hasOwn(rule, "not")) {
    exactKeys(rule, ["not"], label);
    assertClosedVerdictRule(rule["not"], `${label}.not`);
    return;
  }
  if (Object.hasOwn(rule, "inconclusiveWhen")) {
    exactKeys(rule, ["inconclusiveWhen", "class"], label);
    assertClosedVerdictRule(
      rule["inconclusiveWhen"],
      `${label}.inconclusiveWhen`,
    );
    return;
  }
  if (Object.hasOwn(rule, "pass")) {
    exactKeys(rule, ["pass"], label);
    return;
  }
  if (Object.hasOwn(rule, "fail")) {
    exactKeys(rule, ["fail"], label);
    return;
  }
  throw new EvaluationHarnessInputError(
    `${label} is outside the closed declarative verdict vocabulary`,
  );
}

function enforceParserAllowlist(
  specification: EvaluationSpec,
  allowlist: ReadonlySet<string>,
): void {
  if (specification.family !== "deterministic-process") return;
  const block = specification.familyBlock as DeterministicProcessBlock;
  const key = parserAllowlistKey(block.parser);
  if (!allowlist.has(key)) {
    throw new EvaluationHarnessInputError(
      `EvaluationSpec parser is not deployment-allowlisted: ${key}`,
    );
  }
}

function selectRegistration(
  deployment: EvaluationHarnessDeployment,
  specification: EvaluationSpec,
): EvaluatorRegistration {
  const compatible = deployment.registrations.filter((registration) =>
    registration.specificationCompatibility(specification)
  );
  if (compatible.length !== 1) {
    throw new EvaluationHarnessInputError(
      compatible.length === 0
        ? "no host evaluator registration supports the EvaluationSpec"
        : "more than one host evaluator registration supports the EvaluationSpec",
    );
  }
  return compatible[0]!;
}

function operational(message: string, cause?: unknown): never {
  throw new EvaluationOperationalError({
    canonicalCode: "FAILED_PRECONDITION",
    reason: "invalid-evaluator-output",
    recoveryAdvice: "new-attempt-required",
    safeDetail: message,
    cause,
  });
}

function measurementMap(
  completed: CompletedEvaluation,
  specification: EvaluationSpec,
): {
  readonly values: MeasurementMap;
  readonly measurements: readonly IssuerMeasurement[];
} {
  const delivered = completed.measurements ?? [];
  const declared = new Map(
    specification.measurements.map((measurement) => [
      measurement.name,
      measurement,
    ]),
  );
  const values: MeasurementMap = {};
  const measurements: IssuerMeasurement[] = [];
  for (const measurement of delivered) {
    const declaration = declared.get(measurement.name);
    if (declaration === undefined) {
      operational(
        `CompletedEvaluation contains undeclared measurement ${measurement.name}`,
      );
    }
    if (Object.hasOwn(values, measurement.name)) {
      operational(
        `CompletedEvaluation repeats measurement ${measurement.name}`,
      );
    }
    if (
      measurement.value === null ||
      typeof measurement.value !== declaration.type
    ) {
      operational(
        `CompletedEvaluation measurement ${measurement.name} has the wrong type`,
      );
    }
    if (
      declaration.unit !== undefined &&
      measurement.unit !== declaration.unit
    ) {
      operational(
        `CompletedEvaluation measurement ${measurement.name} has the wrong unit`,
      );
    }
    values[measurement.name] = measurement.value;
    measurements.push({
      name: measurement.name,
      value: measurement.value,
      ...(measurement.unit === undefined ? {} : { unit: measurement.unit }),
    });
  }
  const coverage = checkMeasurementCoverage(specification, values);
  if (!coverage.ok) {
    operational(
      `CompletedEvaluation is missing required measurements: ${
        coverage.missing.join(", ")
      }`,
    );
  }
  const consistency = checkVerdictConsistency({
    spec: specification,
    delivered: { verdict: completed.verdict },
    measurements: values,
  });
  if (!consistency.ok) {
    operational(
      `CompletedEvaluation verdict is inconsistent: ${consistency.reason}`,
    );
  }
  return { values, measurements };
}

function evidenceReference(
  evidence: ClaimEvidence,
): AttestationResourceReference {
  if (evidence.kind === "content") {
    if (evidence.name.length === 0) {
      operational("CompletedEvaluation evidence name must be non-empty");
    }
    return {
      name: evidence.name,
      digest: sha256(evidence.bytes),
      ...(evidence.mediaType === undefined
        ? {}
        : { mediaType: evidence.mediaType }),
    };
  }
  return resourceReference(evidence.descriptor, "claim evidence");
}

function resourceReference(
  descriptor: ParsedResourceDescriptor | ResourceDescriptor,
  label: string,
): AttestationResourceReference {
  const record = descriptor as {
    readonly name?: unknown;
    readonly digest?: unknown;
    readonly uri?: unknown;
    readonly mediaType?: unknown;
  };
  const name = string(record.name, `${label} name`);
  const observedDigest = digestObject(record.digest, `${label} digest`);
  return {
    name,
    digest: `sha256:${observedDigest.sha256}`,
    ...(record.uri === undefined
      ? {}
      : { uri: string(record.uri, `${label} uri`) }),
    ...(record.mediaType === undefined
      ? {}
      : { mediaType: string(record.mediaType, `${label} mediaType`) }),
  };
}

function validateCompletedDetails(
  completed: CompletedEvaluation,
  specification: EvaluationSpec,
): {
  readonly measurements: readonly IssuerMeasurement[];
  readonly evidence: readonly AttestationResourceReference[];
} {
  if (
    completed.explanation !== undefined &&
    completed.explanation.length === 0
  ) {
    operational("CompletedEvaluation explanation must be non-empty");
  }
  if (
    completed.limitations?.some((limitation) =>
      typeof limitation !== "string" || limitation.length === 0
    )
  ) {
    operational("CompletedEvaluation limitations must be non-empty strings");
  }
  const { measurements } = measurementMap(completed, specification);
  const evidence = (completed.claimEvidence ?? []).map(evidenceReference);
  const evidenceNames = new Set(evidence.map(({ name }) => name));
  const missingEvidence = specification.evidenceConventions.requiredRefs
    .filter((name) => !evidenceNames.has(name));
  if (missingEvidence.length > 0) {
    operational(
      `CompletedEvaluation is missing required evidence: ${
        missingEvidence.join(", ")
      }`,
    );
  }
  return { measurements, evidence };
}

async function atomicExclusiveWrite(
  directory: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  const target = join(directory, name);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    // A hard-link publishes complete prepared bytes atomically and refuses an existing verdict.
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validDeployment(value: unknown): value is EvaluationHarnessDeployment {
  if (typeof value !== "object" || value === null) return false;
  const deployment = value as {
    readonly registrations?: unknown;
    readonly parserAllowlist?: unknown;
  };
  return (
    Array.isArray(deployment.registrations) &&
    typeof deployment.parserAllowlist === "object" &&
    deployment.parserAllowlist !== null &&
    typeof (deployment.parserAllowlist as ReadonlySet<string>).has === "function"
  );
}

async function deploymentFromEnvironment(): Promise<EvaluationHarnessDeployment> {
  const specifier =
    process.env["JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE"];
  if (specifier === undefined || specifier.length === 0) {
    throw new TypeError(
      "JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE is required by the spawned harness",
    );
  }
  const module = await import(specifier) as {
    readonly default?: unknown;
    readonly evaluationHarnessDeployment?: unknown;
  };
  const deployment = module.evaluationHarnessDeployment ?? module.default;
  if (!validDeployment(deployment)) {
    throw new TypeError(
      "evaluation deployment module must export EvaluationHarnessDeployment",
    );
  }
  return deployment;
}

/**
 * Executes one evaluation Attempt. A deployment may be injected in-process for embedding/tests;
 * the spawned one-argument form loads only the host-selected deployment module from environment.
 */
export async function runEvaluationHarness(
  paths: WorkspacePaths,
  configuredDeployment?: EvaluationHarnessDeployment,
): Promise<number> {
  try {
    const deployment = configuredDeployment ?? await deploymentFromEnvironment();
    const bindings = await readEvaluationTask(paths);
    const [task, delivery, ...results] = await Promise.all([
      readExactMaterial(paths.input, bindings.subjectTask),
      readExactMaterial(paths.input, bindings.subjectDelivery),
      ...bindings.subjectResults.map((reference) =>
        readExactMaterial(paths.input, reference)
      ),
    ]);
    const specificationBytes = await readFile(
      join(paths.input, "evaluation-spec.json"),
    );
    const specificationDigest = sha256(specificationBytes);
    if (specificationDigest !== bindings.evaluationSpec) {
      throw new EvaluationHarnessInputError(
        "evaluation Task crosswalk digest does not match evaluation-spec.json",
      );
    }
    const evaluationTaskBytes = await readFile(join(paths.input, "task.sealed"));
    validateSubjectBindings({
      evaluationTaskBytes,
      bindings,
      task,
      delivery,
      results,
    });
    const evaluationSpecification = validateCrosswalk(
      task,
      specificationDigest,
    );
    const rawSpecification = object(
      parseJson(specificationBytes, "EvaluationSpec"),
      "EvaluationSpec",
    );
    assertClosedVerdictRule(rawSpecification["verdictRule"]);
    const specification = parseEvaluationSpec(specificationBytes);
    enforceParserAllowlist(specification, deployment.parserAllowlist);
    const registration = selectRegistration(deployment, specification);
    const context = await optionalContext(paths.input);
    const attempt = await attemptIdentity(paths.input);
    const completed = validateCompletedEvaluation(
      registration.outcomeValidator(
        validateCompletedEvaluation(
          await registration.adapter.evaluate(
            task,
            results,
            specification,
            context,
            attempt,
            new AbortController().signal,
          ),
        ),
      ),
    );
    const normalized = validateCompletedDetails(completed, specification);
    const prepared = await prepareResultEvaluation({
      task: resourceReference(task.descriptor, "Task subject"),
      results: results.map(({ descriptor }) =>
        resourceReference(descriptor, "Result subject")
      ) as [
        AttestationResourceReference,
        ...AttestationResourceReference[],
      ],
      evaluator: { id: registration.evaluatorIdentity.id },
      evaluatedAt: completed.evaluatedAt,
      verdict: completed.verdict,
      evaluationSpecification,
      evaluationMethod: resourceReference(
        registration.evaluationMethod,
        "evaluation method",
      ),
      measurements: normalized.measurements,
      evidence: normalized.evidence,
      ...(completed.explanation === undefined
        ? {}
        : { explanation: completed.explanation }),
      ...(completed.limitations === undefined
        ? {}
        : { limitations: completed.limitations }),
    }, makeSecretsSigner(paths.secrets, registration.signer.handle));
    await atomicExclusiveWrite(paths.out, "verdict", prepared.envelopeBytes);
    return 0;
  } catch (cause) {
    if (
      cause instanceof EvaluationHarnessInputError ||
      cause instanceof ProfilesError
    ) {
      return EVALUATION_HARNESS_EXIT_INVALID_INPUT;
    }
    return EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE;
  }
}

const ENVIRONMENT_PATHS = {
  root: "JINN_ATTEMPT_ROOT",
  input: "JINN_ATTEMPT_INPUT",
  work: "JINN_ATTEMPT_WORK",
  out: "JINN_ATTEMPT_OUT",
  logs: "JINN_ATTEMPT_LOGS",
  harnessState: "JINN_ATTEMPT_HARNESS_STATE",
  secrets: "JINN_ATTEMPT_SECRETS",
  tmp: "TMPDIR",
  meta: "JINN_ATTEMPT_META",
} as const;

export function pathsFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkspacePaths {
  const paths = {} as Record<keyof WorkspacePaths, string>;
  for (const [field, variable] of Object.entries(ENVIRONMENT_PATHS) as [
    keyof WorkspacePaths,
    string,
  ][]) {
    const value = environment[variable];
    if (value === undefined || value.length === 0) {
      throw new TypeError(`${variable} is required`);
    }
    paths[field] = value;
  }
  return paths;
}
