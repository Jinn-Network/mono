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
  buildResultEvaluationPayload,
  type AttestationResourceReference,
  type EvaluationMeasurement as IssuerMeasurement,
} from "@jinn-network/attestation-issuer";
import { ResourceDescriptorSchema } from "@jinn-network/evidence-protocol";
import {
  checkMeasurementCoverage,
  checkVerdictConsistency,
  deriveEvaluationTask,
  EVALUATION_TASK_PROFILE_URI,
  parseEvaluationSpec,
  parserAllowlistKey,
  ProfilesError,
  verifyEvaluationSubject,
  type DeriveEvaluationTaskInput,
  type DeterministicProcessBlock,
  type EvaluationSpec,
  type MeasurementMap,
  type VerifiedEvaluationSpecification,
} from "@jinn-network/task-execution-profiles";
import {
  fsyncBestEffort,
  type AttemptIdentity,
} from "@jinn-network/task-execution-supervisor";
import type { WorkspacePaths } from "@jinn-network/task-execution-workspace";
// #2538: one source for the provisioner's staged filenames — never a literal repeated per reader.
import { STAGED_SEALED_TASK_FILENAME } from "@jinn-network/task-execution-workspace";
import {
  EvaluationOperationalError,
  isEvaluationOperationalError,
  validateCompletedEvaluation,
  type ClaimEvidence,
  type CompletedEvaluation,
  type EvaluationMeasurement,
  type ExactEvaluationMaterial,
  type ResourceDescriptor,
} from "./adapter.js";
import {
  type EvaluatorRegistration,
  resolveEvaluationMethod,
  validateEvaluatorRegistrationSet,
} from "./registration.js";

export const EVALUATION_HARNESS_EXIT_INVALID_INPUT = 65;
export const EVALUATION_HARNESS_EXIT_OPERATIONAL_FAILURE = 70;
/** A provider outage that the sealed run policy may retry as a fresh evaluation attempt. */
export const EVALUATION_HARNESS_EXIT_PROVIDER_UNAVAILABLE = 71;
export const EVALUATION_HARNESS_EXIT_CONFIGURATION = 78;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SHA256_HEX = /^[0-9a-f]{64}$/u;

type ParsedResourceDescriptor = ReturnType<
  (typeof ResourceDescriptorSchema)["parse"]
>;

export interface EvidenceRepositoryWriter {
  putClaimEvidence(
    input: {
      readonly name: string;
      readonly bytes: Uint8Array;
      readonly mediaType?: string;
    },
    options: { readonly signal?: AbortSignal },
  ): Promise<ResourceDescriptor>;
}

export interface EvaluationHarnessDeployment {
  /** Host-authored registrations. No registration is selected from Task/spec bytes. */
  readonly registrations: readonly EvaluatorRegistration[];
  /** Exact parser identity keys produced by `parserAllowlistKey`. */
  readonly parserAllowlist: ReadonlySet<string>;
  readonly evidenceWriter: EvidenceRepositoryWriter;
  readonly maxClaimEvidenceBytes: number;
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

/**
 * The one optional input the fixed derivation appends after every subject artifact (program §7.39,
 * `buildEvaluationTaskProfile`'s `admission-receipt` slot). It lives ONLY in the sealed Task's
 * `inputs` — never in `payload` — so a verifier that reads bindings out of `payload` alone
 * re-derives the receipt-free shape and byte-compares it against a receipt-bearing document.
 */
const ADMISSION_RECEIPT_INPUT_NAME = "admission-receipt";

type DeclaredAdmissionReceipt = NonNullable<
  DeriveEvaluationTaskInput["admissionReceipt"]
>;

interface EvaluationTaskBindings {
  readonly subjectTask: SubjectReference;
  readonly subjectDelivery: SubjectReference;
  readonly subjectResults: readonly SubjectReference[];
  readonly evaluationSpec: `sha256:${string}`;
  /**
   * #40: present exactly when the sealed Task declares the receipt input. The producer
   * (`deriveAndSealEvaluationSubmission`) supplies it from the subject Submission's annotation;
   * every other verifier already passes it through. This binding is what lets the harness
   * re-derive BOTH legal shapes instead of only the receipt-free one.
   */
  readonly admissionReceipt?: DeclaredAdmissionReceipt;
}

/**
 * Reads the declared receipt positionally, exactly as `deriveEvaluationTask` emits it: the fixed
 * `inputs` order is `[subjectTask, subjectDelivery, ...subjectResults, admissionReceipt?]`. Keying
 * on position rather than on a name search is deliberate — a subject Result legitimately named
 * `admission-receipt` would otherwise be mistaken for the receipt and break a Task that verifies
 * today. Anything other than the two derivable lengths is refused here rather than left to the
 * byte-compare, so the operator gets the specific reason.
 */
function declaredAdmissionReceipt(
  task: Record<string, unknown>,
  subjectCount: number,
): DeclaredAdmissionReceipt | undefined {
  const inputs = task["inputs"];
  if (!Array.isArray(inputs)) {
    throw new EvaluationHarnessInputError(
      "evaluation Task inputs must be an array",
    );
  }
  if (inputs.length === subjectCount) return undefined;
  if (inputs.length !== subjectCount + 1) {
    throw new EvaluationHarnessInputError(
      "evaluation Task inputs do not match its bound subject artifacts",
    );
  }
  const declared = object(
    inputs[subjectCount],
    "evaluation Task admission-receipt input",
  );
  if (declared["name"] !== ADMISSION_RECEIPT_INPUT_NAME) {
    throw new EvaluationHarnessInputError(
      `evaluation Task input after its subject artifacts must be named "${ADMISSION_RECEIPT_INPUT_NAME}"`,
    );
  }
  return declared as DeclaredAdmissionReceipt;
}

/**
 * The declared receipt is staged by the same `materializeInput` pass that stages every other
 * declared input, so it earns the same post-staging digest re-check the subject materials already
 * get through `readExactMaterial`. The `digest.sha256` guard mirrors the provisioner's own
 * conditional (`materializeAt`): a descriptor that pins no sha256 binds the derivation without
 * pinning staged bytes, and the profile's `admission-receipt` slot declares no
 * `descriptorMustCarry`, so requiring one here would be stricter than the profile.
 */
async function verifyStagedAdmissionReceipt(
  inputDir: string,
  descriptor: DeclaredAdmissionReceipt,
): Promise<void> {
  const declared = (descriptor as { readonly digest?: unknown }).digest;
  if (declared === undefined) return;
  const sha256Value = object(
    declared,
    "evaluation Task admission-receipt digest",
  )["sha256"];
  if (sha256Value === undefined) return;
  if (typeof sha256Value !== "string" || !SHA256_HEX.test(sha256Value)) {
    throw new EvaluationHarnessInputError(
      "evaluation Task admission-receipt digest.sha256 must be 64 lowercase hexadecimal characters",
    );
  }
  await readExactMaterial(inputDir, {
    name: ADMISSION_RECEIPT_INPUT_NAME,
    digest: `sha256:${sha256Value}`,
  });
}

async function readEvaluationTask(
  paths: WorkspacePaths,
): Promise<EvaluationTaskBindings> {
  const task = object(
    parseJson(await readFile(join(paths.input, STAGED_SEALED_TASK_FILENAME)), "evaluation Task"),
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
  // The derivation emits one input per subject artifact, then the optional receipt.
  const receipt = declaredAdmissionReceipt(task, 2 + subjectResults.length);
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
    ...(receipt === undefined ? {} : { admissionReceipt: receipt }),
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
  evaluationSpecification: VerifiedEvaluationSpecification,
  specificationDigest: `sha256:${string}`,
): AttestationResourceReference {
  if (evaluationSpecification.digest !== specificationDigest) {
    throw new EvaluationHarnessInputError(
      "subject Task evaluation descriptor does not match the exact EvaluationSpec",
    );
  }
  return {
    name: evaluationSpecification.name,
    digest: specificationDigest,
    ...(evaluationSpecification.uri === undefined
      ? {}
      : { uri: evaluationSpecification.uri }),
    ...(evaluationSpecification.mediaType === undefined
      ? {}
      : { mediaType: evaluationSpecification.mediaType }),
  };
}

function validateEvaluationTaskDerivation(input: {
  readonly evaluationTaskBytes: Uint8Array;
  readonly bindings: EvaluationTaskBindings;
}): void {
  let rederived: ReturnType<typeof deriveEvaluationTask>;
  try {
    rederived = deriveEvaluationTask({
      subjectTask: input.bindings.subjectTask,
      subjectDelivery: input.bindings.subjectDelivery,
      subjectResults: [...input.bindings.subjectResults],
      evaluationSpecDigest: input.bindings.evaluationSpec,
      // #40: the producer passes this whenever the subject carries an admission family, and so
      // must every verifier. Omitting it re-derived the receipt-free 3-input template and
      // byte-compared it against the sealed 4-input document.
      ...(input.bindings.admissionReceipt === undefined
        ? {}
        : { admissionReceipt: input.bindings.admissionReceipt }),
    });
  } catch (cause) {
    // A binding the profiles derivation cannot even accept (a receipt descriptor carrying no
    // locator, say) is invalid input, not an operational failure — classify it as such rather
    // than letting a raw schema throw fall through to exit 70.
    if (cause instanceof ProfilesError) throw cause;
    throw new EvaluationHarnessInputError(
      "evaluation Task bindings are not a derivable profiles input",
      { cause },
    );
  }
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
  selectedId?: string,
): EvaluatorRegistration {
  const compatible = validateEvaluatorRegistrationSet(deployment.registrations).filter((registration) =>
    (selectedId === undefined || registration.registrationId === selectedId)
    &&
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

async function evidenceReference(
  evidence: ClaimEvidence,
  deployment: EvaluationHarnessDeployment,
): Promise<AttestationResourceReference> {
  if (evidence.kind === "content") {
    if (evidence.name.length === 0) {
      operational("CompletedEvaluation evidence name must be non-empty");
    }
    if (evidence.bytes.byteLength > deployment.maxClaimEvidenceBytes) {
      operational("CompletedEvaluation evidence exceeds the deployment content bound");
    }
    let descriptor: ResourceDescriptor;
    try {
      descriptor = await deployment.evidenceWriter.putClaimEvidence({
        name: evidence.name,
        bytes: evidence.bytes,
        ...(evidence.mediaType === undefined ? {} : { mediaType: evidence.mediaType }),
      }, { signal: undefined });
    } catch (cause) {
      operational("claim evidence storage failed", cause);
    }
    const parsed = ResourceDescriptorSchema.safeParse(descriptor!);
    if (!parsed.success || parsed.data.content !== undefined) {
      operational("claim evidence writer returned an invalid descriptor");
    }
    const reference = resourceReference(parsed.data, "claim evidence writer result");
    if (reference.name !== evidence.name || reference.mediaType !== evidence.mediaType) {
      operational("claim evidence writer returned a contradictory descriptor");
    }
    return reference;
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

async function validateCompletedDetails(
  completed: CompletedEvaluation,
  specification: EvaluationSpec,
  deployment: EvaluationHarnessDeployment,
): Promise<{
  readonly measurements: readonly IssuerMeasurement[];
  readonly evidence: readonly AttestationResourceReference[];
}> {
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
  const evidence = await Promise.all(
    (completed.claimEvidence ?? []).map((claim) => evidenceReference(claim, deployment)),
  );
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
    await fsyncBestEffort(file);
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
    readonly evidenceWriter?: unknown;
    readonly maxClaimEvidenceBytes?: unknown;
  };
  return (
    Array.isArray(deployment.registrations) &&
    typeof deployment.parserAllowlist === "object" &&
    deployment.parserAllowlist !== null &&
    typeof (deployment.parserAllowlist as ReadonlySet<string>).has === "function" &&
    typeof (deployment.evidenceWriter as EvidenceRepositoryWriter | undefined)
      ?.putClaimEvidence === "function" &&
    typeof deployment.maxClaimEvidenceBytes === "number" &&
    Number.isSafeInteger(deployment.maxClaimEvidenceBytes) &&
    deployment.maxClaimEvidenceBytes > 0
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

/** Never let a pathological message flood the captured stderr log. */
const MAX_REFUSAL_DETAIL_CHARS = 512;

/**
 * Emits one line naming why this Attempt produced no verdict (#39b).
 *
 * The live gate's first harness run refused its subject and exited 65 in 413ms with BOTH captured
 * harness logs at 0 bytes: the reason existed, was exact, and was thrown away at the catch. A
 * fully-diagnosed refusal that reports only a number costs the operator the whole diagnosis.
 *
 * Stderr is the channel because the backend already captures it into the attempt's harness-stderr
 * log AND already tails that into the terminal detail it records, so one write carries the reason
 * to the operator's audit row without any new plumbing.
 *
 * The bin.ts posture holds: exact inputs, provider diagnostics, and secrets never reach log
 * output. Only two message sources are echoed, both safe by construction -- this package's own
 * `EvaluationHarnessInputError`/`ProfilesError` structural messages (which name document and
 * output NAMES from the already-public signed Task and Delivery, never their bytes) and
 * `EvaluationOperationalError.safeDetail` (whose whole contract is to be safe). Anything else --
 * an adapter throwing a raw `Error`, a provider SDK, a module-load failure -- contributes its
 * classification only, never its message.
 */
function reportRefusal(reasonCode: string, safeDetail?: string): void {
  const detail = safeDetail === undefined || safeDetail.length === 0
    ? ""
    : `: ${safeDetail.replaceAll(/\s+/gu, " ").slice(0, MAX_REFUSAL_DETAIL_CHARS)}`;
  try {
    process.stderr.write(`evaluation-harness: refused (${reasonCode})${detail}\n`);
  } catch {
    // A closed or broken stderr must never turn a classified refusal into an unclassified crash.
  }
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
    const selectedRegistrationId = configuredDeployment === undefined
      ? process.env["JINN_ATTEMPT_EVALUATOR_REGISTRATION"]
      : undefined;
    if (configuredDeployment === undefined && (selectedRegistrationId === undefined || selectedRegistrationId.length === 0)) {
      throw new EvaluationHarnessInputError("spawned evaluation harness has no selected registration");
    }
    const bindings = await readEvaluationTask(paths);
    const [task, delivery, ...results] = await Promise.all([
      readExactMaterial(paths.input, bindings.subjectTask),
      readExactMaterial(paths.input, bindings.subjectDelivery),
      ...bindings.subjectResults.map((reference) =>
        readExactMaterial(paths.input, reference)
      ),
    ]);
    // #40: a declared receipt is staged material like any other, so it gets the same digest
    // re-check. The harness grades on (Task, Results) only — this consumes the bytes to verify
    // them, never to feed the adapter.
    if (bindings.admissionReceipt !== undefined) {
      await verifyStagedAdmissionReceipt(paths.input, bindings.admissionReceipt);
    }
    const specificationBytes = await readFile(
      join(paths.input, "evaluation-spec.json"),
    );
    const specificationDigest = sha256(specificationBytes);
    if (specificationDigest !== bindings.evaluationSpec) {
      throw new EvaluationHarnessInputError(
        "evaluation Task crosswalk digest does not match evaluation-spec.json",
      );
    }
    const evaluationTaskBytes = await readFile(join(paths.input, STAGED_SEALED_TASK_FILENAME));
    const verifiedSubject = verifyEvaluationSubject({
      taskBytes: task.bytes,
      deliveryBytes: delivery.bytes,
      results: results.map((result) => ({
        name: result.descriptor.name,
        bytes: result.bytes,
      })),
    });
    validateEvaluationTaskDerivation({
      evaluationTaskBytes,
      bindings,
    });
    const exactTask: ExactEvaluationMaterial = {
      descriptor: {
        name: bindings.subjectTask.name,
        digest: {
          sha256: verifiedSubject.task.digest.slice("sha256:".length),
        },
      },
      bytes: verifiedSubject.task.bytes,
    };
    const exactResults: readonly ExactEvaluationMaterial[] =
      verifiedSubject.results.map((result) => ({
        descriptor: {
          name: result.name,
          digest: {
            sha256: result.digest.slice("sha256:".length),
          },
          mediaType: result.mediaType,
        },
        bytes: result.bytes,
      }));
    const evaluationSpecification = validateCrosswalk(
      verifiedSubject.evaluationSpecification,
      specificationDigest,
    );
    const rawSpecification = object(
      parseJson(specificationBytes, "EvaluationSpec"),
      "EvaluationSpec",
    );
    assertClosedVerdictRule(rawSpecification["verdictRule"]);
    const specification = parseEvaluationSpec(specificationBytes);
    enforceParserAllowlist(specification, deployment.parserAllowlist);
    const registration = selectRegistration(deployment, specification, selectedRegistrationId);
    const context = await optionalContext(paths.input);
    const attempt = await attemptIdentity(paths.input);
    const completed = validateCompletedEvaluation(
      registration.outcomeValidator(
        validateCompletedEvaluation(
          await registration.adapter.evaluate(
            exactTask,
            exactResults,
            specification,
            context,
            attempt,
            new AbortController().signal,
          ),
        ),
      ),
    );
    const normalized = await validateCompletedDetails(completed, specification, deployment);
    const payloadBytes = buildResultEvaluationPayload({
      task: resourceReference(exactTask.descriptor, "Task subject"),
      results: exactResults.map(({ descriptor }) =>
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
        resolveEvaluationMethod(registration, specification),
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
    });
    await atomicExclusiveWrite(paths.out, "verdict", payloadBytes);
    return 0;
  } catch (cause) {
    if (
      cause instanceof EvaluationHarnessInputError ||
      cause instanceof ProfilesError
    ) {
      reportRefusal("invalid-evaluation-input", cause.message);
      return EVALUATION_HARNESS_EXIT_INVALID_INPUT;
    }
    // Brand, not `instanceof`: the throwing adapter comes from a separately-imported deployment
    // module that resolves its own copy of this package, so the class objects differ and
    // `instanceof` drops the one thing the operator needs -- see
    // `EVALUATION_OPERATIONAL_ERROR_BRAND`. This line is the whole difference between a readable
    // refusal and `refused (evaluation-operational-failure)` with no reason at all; the backend
    // carries this stderr text into the attempt journal's terminal detail and the audit row.
    const operational = isEvaluationOperationalError(cause) ? cause : undefined;
    reportRefusal(
      "evaluation-operational-failure",
      operational?.safeDetail,
    );
    if (
      operational?.canonicalCode === "UNAVAILABLE"
      && operational.reason === "provider-unavailable"
      && operational.recoveryAdvice === "new-attempt-required"
    ) {
      return EVALUATION_HARNESS_EXIT_PROVIDER_UNAVAILABLE;
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
