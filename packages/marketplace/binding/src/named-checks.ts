import {
  DsseEnvelopeSchema,
  ResultEvaluationStatementShape,
  VERDICT_DSSE_PAYLOAD_TYPE,
  checkAdmissionReceipt,
  checkMeasurementCoverage,
  checkVerdictConsistency,
  compareCodeUnitStrings,
  deriveEvaluationTask,
  parseEvaluationSpec,
  sealEvaluationSpec,
  type EvaluationSpec,
  type EvaluationTaskSubjectRef,
  type MeasurementMap,
  type ResultEvaluationStatement,
} from "@jinn-network/task-execution-profiles";
import {
  DeliveryRecordSchema,
  ResourceDescriptorSchema,
  Rfc3339,
  SubmissionRecordSchema,
  TaskSpecificationSchema,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
  type DeliveryRecord,
  type ResourceDescriptor,
  type SubmissionRecord,
  type TaskSpecification,
} from "@jinn-network/task-execution-protocol";
import {
  authenticateRequester,
  parseExactDsseEnvelope,
  settlementJoinCheck,
  verifyEnvelopeBinding,
  type BindingResolver,
  type DsseChainVerifier,
  type PolicyCheckInput,
  type WitnessVerifier,
} from "@jinn-network/trust-core";
import { ADMISSION_RECEIPT_ANNOTATION_URI } from "./evaluation-derive.js";
import { VerdictCode, type VerdictCode as VerdictCodeValue } from "./venue/verdict-code.js";

export const ADMISSION_RECEIPT_TRUST_SCOPE =
  "https://spec.jinn.network/trust-scopes/admission-receipts/v1" as const;
const SUBMISSION_DSSE_PAYLOAD_TYPE =
  "application/vnd.jinn.task-execution.submission.v1+json";

export interface ExactEvaluationArtifact extends EvaluationTaskSubjectRef {
  readonly bytes: Uint8Array;
}

export interface SettlementAuthorizedEvaluationContext {
  readonly subjectTask: ExactEvaluationArtifact;
  readonly subjectDelivery: ExactEvaluationArtifact;
  readonly subjectResults: readonly ExactEvaluationArtifact[];
  readonly subjectSubmissionBytes: Uint8Array;
  readonly evaluationSpecBytes: Uint8Array;
  readonly evaluationTaskBytes: Uint8Array;
}

export interface VerdictObservationGateInput {
  readonly settlement: SettlementAuthorizedEvaluationContext;
  readonly admissionReceipt: {
    readonly envelopeBytes: Uint8Array;
    readonly signerKey: string;
    /** Trusted anchor-derived metadata, never a receipt payload assertion (§7.42). */
    readonly effectiveTime: string;
  };
  readonly verdict: {
    readonly envelopeBytes: Uint8Array;
    readonly signerKey: string;
    readonly settlementDeclarationKey: string;
    readonly claimBlockTime: string;
    readonly onChainVerdictCode: VerdictCodeValue;
    readonly solver: {
      readonly address: string;
      readonly claimedAgent: string;
      readonly declarationKey: string;
      readonly effectiveTime: string;
    };
    readonly evaluatorAddress: string;
  };
  readonly requesterAuthentication: {
    readonly envelopeBytes: Uint8Array;
    readonly signerKey: string;
    readonly sealingTime: string;
  };
}

export interface VerdictObservationGatePorts {
  readonly bindingResolver: BindingResolver;
  readonly witnessVerifier: WitnessVerifier;
  readonly dsseVerifier: DsseChainVerifier;
  /** The deployment's resolved policy entry for purpose `admission-agent`. */
  readonly admissionAgentPolicy: PolicyCheckInput;
  /** The deployment's resolved policy entry for purpose `evaluator-eligibility`, when configured. */
  readonly evaluatorPolicy?: PolicyCheckInput;
  readonly requesterPolicy?: PolicyCheckInput;
}

export interface VerdictObservationFailure {
  readonly check: string;
  readonly detail: string;
}

export interface VerdictObservationGate {
  readonly decisionGrade: boolean;
  readonly failures: VerdictObservationFailure[];
}

interface ParsedSettlementContext {
  readonly task: TaskSpecification;
  readonly delivery: DeliveryRecord;
  readonly subjectSubmission: SubmissionRecord;
  readonly evaluationSpec: EvaluationSpec;
  readonly admissionReceiptDescriptor: ResourceDescriptor;
}

type ParsedVerdict =
  | { readonly ok: true; readonly statement: ResultEvaluationStatement }
  | { readonly ok: false; readonly check: "verdict-correspondence" | "verdict-envelope"; readonly detail: string };

function byteEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function floorDivide(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor < 0n ? quotient - 1n : quotient;
}

/** Proleptic-Gregorian day number; the epoch is irrelevant because only differences compare. */
function civilDay(yearInput: bigint, month: bigint, day: bigint): bigint {
  const year = yearInput - (month <= 2n ? 1n : 0n);
  const era = floorDivide(year, 400n);
  const yearOfEra = year - era * 400n;
  const shiftedMonth = month + (month > 2n ? -3n : 9n);
  const dayOfYear = (153n * shiftedMonth + 2n) / 5n + day - 1n;
  const dayOfEra =
    yearOfEra * 365n
    + yearOfEra / 4n
    - yearOfEra / 100n
    + dayOfYear;
  return era * 146097n + dayOfEra;
}

function exactRfc3339Instant(value: string): {
  readonly wholeSecond: bigint;
  readonly fraction: string;
} {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (match === null) {
    throw new Error(`invalid RFC 3339 instant "${value}"`);
  }
  const [, year, month, day, hour, minute, second, fraction = "", zone] =
    match;
  const localSecond =
    civilDay(BigInt(year!), BigInt(month!), BigInt(day!)) * 86_400n
    + BigInt(hour!) * 3_600n
    + BigInt(minute!) * 60n
    + BigInt(second!);
  const offsetSecond = zone === "Z"
    ? 0n
    : (
        BigInt(zone!.slice(1, 3)) * 3_600n
        + BigInt(zone!.slice(4, 6)) * 60n
      ) * (zone!.startsWith("+") ? 1n : -1n);
  return {
    wholeSecond: localSecond - offsetSecond,
    fraction,
  };
}

function compareRfc3339Instants(left: string, right: string): number {
  const leftInstant = exactRfc3339Instant(left);
  const rightInstant = exactRfc3339Instant(right);
  if (leftInstant.wholeSecond < rightInstant.wholeSecond) return -1;
  if (leftInstant.wholeSecond > rightInstant.wholeSecond) return 1;
  const width = Math.max(
    leftInstant.fraction.length,
    rightInstant.fraction.length,
  );
  for (let index = 0; index < width; index += 1) {
    const leftDigit = leftInstant.fraction[index] ?? "0";
    const rightDigit = rightInstant.fraction[index] ?? "0";
    if (leftDigit < rightDigit) return -1;
    if (leftDigit > rightDigit) return 1;
  }
  return 0;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`${label} bytes are not valid UTF-8 JSON: ${String(cause)}`);
  }
}

function requireCanonical<T>(
  bytes: Uint8Array,
  parsed: T,
  seal: (document: unknown) => Uint8Array,
  label: string,
): void {
  const canonical = seal(parsed);
  if (!byteEqual(bytes, canonical)) {
    throw new Error(`${label} bytes are not the exact canonical sealed bytes`);
  }
}

function requireArtifactDigest(artifact: ExactEvaluationArtifact, label: string): void {
  const actual = documentDigest(artifact.bytes);
  if (artifact.digest !== actual) {
    throw new Error(`${label} descriptor digest ${artifact.digest} does not match exact bytes ${actual}`);
  }
}

function descriptorDigest(descriptor: { digest?: unknown }): `sha256:${string}` | undefined {
  const digest = descriptor.digest;
  const hex =
    typeof digest === "object" && digest !== null
      ? (digest as { sha256?: unknown }).sha256
      : undefined;
  return typeof hex === "string" ? `sha256:${hex}` : undefined;
}

function parseSettlementContext(
  context: SettlementAuthorizedEvaluationContext,
): ParsedSettlementContext {
  requireArtifactDigest(context.subjectTask, "subject Task");
  requireArtifactDigest(context.subjectDelivery, "subject Delivery");
  for (const result of context.subjectResults) {
    requireArtifactDigest(result, `subject Result "${result.name}"`);
  }

  const task = TaskSpecificationSchema.parse(parseJson(context.subjectTask.bytes, "subject Task"));
  requireCanonical(context.subjectTask.bytes, task, sealTask, "subject Task");
  const delivery = DeliveryRecordSchema.parse(
    parseJson(context.subjectDelivery.bytes, "subject Delivery"),
  );
  requireCanonical(context.subjectDelivery.bytes, delivery, sealDelivery, "subject Delivery");
  if (delivery.task !== context.subjectTask.digest) {
    throw new Error("subject Delivery does not bind the settlement-authorized Task digest");
  }

  const expectedResults = [...context.subjectResults].sort((left, right) =>
    compareCodeUnitStrings(left.name, right.name),
  );
  const deliveredResults = delivery.outputs
    .map((output) => ({ name: output.name, digest: descriptorDigest(output) }))
    .sort((left, right) => compareCodeUnitStrings(left.name, right.name));
  if (
    deliveredResults.length !== expectedResults.length
    || expectedResults.some((result, index) => {
      const delivered = deliveredResults[index];
      return delivered?.name !== result.name || delivered.digest !== result.digest;
    })
  ) {
    throw new Error("subject Delivery outputs do not exactly bind the settlement-authorized Results");
  }

  const subjectSubmission = SubmissionRecordSchema.parse(
    parseJson(context.subjectSubmissionBytes, "subject Submission"),
  );
  requireCanonical(
    context.subjectSubmissionBytes,
    subjectSubmission,
    sealSubmission,
    "subject Submission",
  );
  if (descriptorDigest(subjectSubmission.task) !== context.subjectTask.digest) {
    throw new Error("subject Submission does not bind the settlement-authorized Task digest");
  }

  const receiptCandidate =
    subjectSubmission.annotations?.[ADMISSION_RECEIPT_ANNOTATION_URI];
  const admissionReceiptDescriptor =
    ResourceDescriptorSchema.parse(receiptCandidate) as ResourceDescriptor;
  if (admissionReceiptDescriptor.name !== "admission-receipt") {
    throw new Error('subject Submission receipt descriptor is not named "admission-receipt"');
  }

  const evaluationSpec = parseEvaluationSpec(context.evaluationSpecBytes);
  const sealedSpec = sealEvaluationSpec(evaluationSpec);
  if (!byteEqual(context.evaluationSpecBytes, sealedSpec.bytes)) {
    throw new Error("EvaluationSpec bytes are not the exact canonical sealed bytes");
  }
  if (descriptorDigest(task.evaluation ?? {}) !== sealedSpec.digest) {
    throw new Error("subject Task evaluation descriptor does not bind the supplied EvaluationSpec");
  }

  const expectedEvaluationTask = deriveEvaluationTask({
    subjectTask: {
      name: context.subjectTask.name,
      digest: context.subjectTask.digest,
    },
    subjectDelivery: {
      name: context.subjectDelivery.name,
      digest: context.subjectDelivery.digest,
    },
    subjectResults: context.subjectResults.map((result) => ({
      name: result.name,
      digest: result.digest,
    })),
    evaluationSpecDigest: sealedSpec.digest,
    admissionReceipt: admissionReceiptDescriptor as ResourceDescriptor & Record<string, unknown>,
  });
  if (!byteEqual(context.evaluationTaskBytes, expectedEvaluationTask.bytes)) {
    throw new Error(
      "actual evaluation Task bytes differ from the settlement-authorized full-document derivation",
    );
  }

  return {
    task,
    delivery,
    subjectSubmission,
    evaluationSpec,
    admissionReceiptDescriptor,
  };
}

/**
 * Reads the delivered verdict envelope with the STRICT `parseExactDsseEnvelope` (defect-#34
 * follow-up). This gate owns a fail-closed decision, so it must not inherit its encoding floor
 * from whichever `dsseVerifier` a composition happens to inject: under a loose structural parse
 * a validly-signed envelope in an alternate JSON spelling reached full decision-grade whenever
 * the injected verifier was itself loose. Every producer of these bytes seals canonically
 * (`sealDsseEnvelope` / `sealSignedRecord` / task-execution-profiles' `buildVerdictEnvelope`),
 * so an alternate spelling is never legitimate -- and refusing it here names the encoding as a
 * `verdict-envelope` failure instead of surfacing it as an opaque `settlement-join` signature error.
 */
function parseVerdict(envelopeBytes: Uint8Array): ParsedVerdict {
  let parsedEnvelope;
  try {
    parsedEnvelope = parseExactDsseEnvelope(envelopeBytes);
  } catch (cause) {
    return { ok: false, check: "verdict-envelope", detail: String(cause) };
  }
  if (parsedEnvelope.payloadType !== VERDICT_DSSE_PAYLOAD_TYPE) {
    return {
      ok: false,
      check: "verdict-envelope",
      detail: `unexpected verdict payloadType "${parsedEnvelope.payloadType}"`,
    };
  }

  let untyped: unknown;
  try {
    untyped = parseJson(parsedEnvelope.payloadBytes, "Result Evaluation Statement");
  } catch (cause) {
    return { ok: false, check: "verdict-envelope", detail: String(cause) };
  }
  const predicate =
    typeof untyped === "object" && untyped !== null
      ? (untyped as { predicate?: unknown }).predicate
      : undefined;
  const verdict =
    typeof predicate === "object" && predicate !== null
      ? (predicate as { verdict?: unknown }).verdict
      : undefined;
  if (verdict === undefined) {
    return {
      ok: false,
      check: "verdict-correspondence",
      detail: "Result Evaluation Statement is missing predicate.verdict; refusing to default",
    };
  }

  const parsed = ResultEvaluationStatementShape.safeParse(untyped);
  if (!parsed.success) {
    return {
      ok: false,
      check: "verdict-envelope",
      detail: `Result Evaluation Statement failed schema validation: ${parsed.error.message}`,
    };
  }
  return { ok: true, statement: parsed.data };
}

export function decisionGradeVerdictCode(verdict: unknown): VerdictCodeValue {
  switch (verdict) {
    case "pass":
      return VerdictCode.Pass;
    case "fail":
      return VerdictCode.Fail;
    case "inconclusive":
      return VerdictCode.Unresolved;
    default:
      throw new Error(
        `missing or non-conforming Result Evaluation verdict "${String(verdict)}"; refusing to default (§7.41)`,
      );
  }
}

function measurementMap(
  statement: ResultEvaluationStatement,
): { ok: true; value: MeasurementMap } | { ok: false; detail: string } {
  const values: MeasurementMap = {};
  for (const measurement of statement.predicate.measurements ?? []) {
    if (Object.hasOwn(values, measurement.name)) {
      return { ok: false, detail: `duplicate delivered measurement "${measurement.name}"` };
    }
    if (measurement.value === null) {
      return { ok: false, detail: `delivered measurement "${measurement.name}" is null` };
    }
    values[measurement.name] = measurement.value;
  }
  return { ok: true, value: values };
}

function statementPairFailure(
  statement: ResultEvaluationStatement,
  context: SettlementAuthorizedEvaluationContext,
  spec: EvaluationSpec,
): string | undefined {
  const specDigest = sealEvaluationSpec(spec).digest;
  if (descriptorDigest(statement.predicate.evaluationSpecification ?? {}) !== specDigest) {
    return "Result Evaluation evaluationSpecification does not bind the supplied EvaluationSpec";
  }
  if (statement.predicate.taskSubject !== context.subjectTask.name) {
    return "Result Evaluation taskSubject does not name the settlement-authorized Task";
  }
  const expectedResultNames = context.subjectResults
    .map((result) => result.name)
    .sort(compareCodeUnitStrings);
  const actualResultNames = [...statement.predicate.resultSubjects].sort(compareCodeUnitStrings);
  if (
    expectedResultNames.length !== actualResultNames.length
    || expectedResultNames.some((name, index) => actualResultNames[index] !== name)
  ) {
    return "Result Evaluation resultSubjects do not name the settlement-authorized Results";
  }
  const expectedSubjects = [context.subjectTask, ...context.subjectResults]
    .map((subject) => `${subject.name}\u0000${subject.digest}`)
    .sort(compareCodeUnitStrings);
  const actualSubjects = statement.subject
    .map((subject) => `${subject.name}\u0000${descriptorDigest(subject) ?? "missing"}`)
    .sort(compareCodeUnitStrings);
  if (
    expectedSubjects.length !== actualSubjects.length
    || expectedSubjects.some((subject, index) => actualSubjects[index] !== subject)
  ) {
    return "Result Evaluation subjects do not exactly bind the settlement-authorized Task and Results";
  }
  return undefined;
}

async function admissionReceiptFailure(
  input: VerdictObservationGateInput,
  context: ParsedSettlementContext,
  ports: VerdictObservationGatePorts,
): Promise<string | undefined> {
  if (!Rfc3339.safeParse(input.admissionReceipt.effectiveTime).success) {
    return "trusted admission-receipt effective time is not RFC 3339";
  }
  const carriedDigest = descriptorDigest(context.admissionReceiptDescriptor);
  const actualDigest = documentDigest(input.admissionReceipt.envelopeBytes);
  if (carriedDigest !== actualDigest) {
    return `carried receipt digest ${String(carriedDigest)} does not match exact envelope digest ${actualDigest}`;
  }

  // Completes this gate's encoding floor (see `parseVerdict`). This read differs from the other
  // two: it interprets the envelope through a Zod SHAPE, which accepts any JSON spelling, so the
  // strict parse is added as a gate rather than swapped in -- `checkAdmissionReceipt` below still
  // consumes the shape-parsed envelope. Producer drift here is self-consistent (the carried
  // descriptor digest is taken over whatever bytes the producer emitted, and the signature stays
  // valid over the payload), so no other check on this path can catch it.
  try {
    parseExactDsseEnvelope(input.admissionReceipt.envelopeBytes);
  } catch (cause) {
    return `admission-receipt envelope is not the exact producer encoding: ${String(cause)}`;
  }

  let envelope: unknown;
  try {
    envelope = parseJson(input.admissionReceipt.envelopeBytes, "admission-receipt envelope");
  } catch (cause) {
    return String(cause);
  }
  const envelopeShape = DsseEnvelopeSchema.safeParse(envelope);
  if (!envelopeShape.success) {
    return `admission-receipt envelope failed schema validation: ${envelopeShape.error.message}`;
  }
  if (envelopeShape.data.payloadType !== VERDICT_DSSE_PAYLOAD_TYPE) {
    return `admission-receipt payloadType "${envelopeShape.data.payloadType}" is not ${VERDICT_DSSE_PAYLOAD_TYPE}`;
  }
  const specDigest = sealEvaluationSpec(context.evaluationSpec).digest;
  const structural = checkAdmissionReceipt({
    envelope: envelopeShape.data,
    expectedTaskDigest: input.settlement.subjectTask.digest,
    expectedEvaluationSpecDigest: specDigest,
  });
  if (!structural.ok) return structural.reason;

  let verified;
  try {
    verified = await verifyEnvelopeBinding(
      {
        envelopeBytes: input.admissionReceipt.envelopeBytes,
        key: input.admissionReceipt.signerKey,
        agent: structural.issuer,
        family: ADMISSION_RECEIPT_TRUST_SCOPE,
        atTime: input.admissionReceipt.effectiveTime,
      },
      {
        bindingResolver: ports.bindingResolver,
        witnessVerifier: ports.witnessVerifier,
        dsseVerifier: ports.dsseVerifier,
        policy: ports.admissionAgentPolicy,
      },
    );
  } catch (cause) {
    return `admission-agent envelope binding dependency failed: ${String(cause)}`;
  }
  return verified.ok
    ? undefined
    : `admission-agent envelope binding failed: ${verified.reason ?? "unknown"}${verified.detail === undefined ? "" : `: ${verified.detail}`}`;
}

async function requesterAuthenticationFailure(
  input: VerdictObservationGateInput,
  context: ParsedSettlementContext,
  ports: VerdictObservationGatePorts,
): Promise<string | undefined> {
  if (!Rfc3339.safeParse(input.requesterAuthentication.sealingTime).success) {
    return "requester Submission sealing time is not RFC 3339";
  }
  // Strict for the same reason as `parseVerdict` above: the requester Submission envelope has a
  // single canonical producer (`native-requester`'s `sealDsseEnvelope`), so this gate refuses
  // alternate spellings on its own rather than depending on the injected `dsseVerifier`.
  let signedSubmission;
  try {
    signedSubmission = parseExactDsseEnvelope(input.requesterAuthentication.envelopeBytes);
  } catch (cause) {
    return String(cause);
  }
  if (!byteEqual(signedSubmission.payloadBytes, input.settlement.subjectSubmissionBytes)) {
    return "requester DSSE envelope payload is not the exact subject Submission bytes";
  }
  if (signedSubmission.payloadType !== SUBMISSION_DSSE_PAYLOAD_TYPE) {
    return `requester DSSE payloadType "${signedSubmission.payloadType}" is not ${SUBMISSION_DSSE_PAYLOAD_TYPE}`;
  }
  let outcome;
  try {
    outcome = await authenticateRequester(
      {
        envelopeBytes: input.requesterAuthentication.envelopeBytes,
        key: input.requesterAuthentication.signerKey,
        requesterAgent: context.subjectSubmission.requester,
        sealingTime: input.requesterAuthentication.sealingTime,
      },
      {
        bindingResolver: ports.bindingResolver,
        witnessVerifier: ports.witnessVerifier,
        dsseVerifier: ports.dsseVerifier,
        ...(ports.requesterPolicy === undefined ? {} : { policy: ports.requesterPolicy }),
      },
    );
  } catch (cause) {
    return `requester authentication dependency failed: ${String(cause)}`;
  }
  return outcome.ok ? undefined : outcome.reason ?? "requester authentication failed";
}

/**
 * Runs every off-chain named check that determines whether a marketplace
 * verdict observation is decision-grade. It never gates or rewrites the
 * today-generation on-chain settlement transaction (§6.4).
 */
export async function gateVerdictObservation(
  input: VerdictObservationGateInput,
  ports: VerdictObservationGatePorts,
): Promise<VerdictObservationGate> {
  const failures: VerdictObservationFailure[] = [];
  let context: ParsedSettlementContext | undefined;
  try {
    context = parseSettlementContext(input.settlement);
  } catch (cause) {
    failures.push({ check: "derivation-byte-equality", detail: String(cause) });
  }

  if (context !== undefined) {
    const admissionFailure = await admissionReceiptFailure(input, context, ports);
    if (admissionFailure !== undefined) {
      failures.push({ check: "admission-receipt", detail: admissionFailure });
    }
    const requesterFailure = await requesterAuthenticationFailure(input, context, ports);
    if (requesterFailure !== undefined) {
      failures.push({ check: "requester-authentication", detail: requesterFailure });
    }
  }

  const parsedVerdict = parseVerdict(input.verdict.envelopeBytes);
  if (!parsedVerdict.ok) {
    failures.push({ check: parsedVerdict.check, detail: parsedVerdict.detail });
  } else if (context !== undefined) {
    const statement = parsedVerdict.statement;
    const expectedCode = decisionGradeVerdictCode(statement.predicate.verdict);
    if (expectedCode !== input.verdict.onChainVerdictCode) {
      failures.push({
        check: "verdict-correspondence",
        detail:
          `Statement verdict "${statement.predicate.verdict}" requires code ${expectedCode}; `
          + `on-chain claim carries ${input.verdict.onChainVerdictCode}`,
      });
    }

    const pairFailure = statementPairFailure(
      statement,
      input.settlement,
      context.evaluationSpec,
    );
    const measurements = measurementMap(statement);
    if (pairFailure !== undefined) {
      failures.push({ check: "verdict-consistency", detail: pairFailure });
    } else if (!measurements.ok) {
      failures.push({ check: "verdict-consistency", detail: measurements.detail });
    } else {
      const coverage = checkMeasurementCoverage(context.evaluationSpec, measurements.value);
      if (!coverage.ok) {
        failures.push({
          check: "verdict-consistency",
          detail: `missing required measurements: ${coverage.missing.join(", ")}`,
        });
      } else {
        try {
          const consistency = checkVerdictConsistency({
            spec: context.evaluationSpec,
            delivered: { verdict: statement.predicate.verdict },
            measurements: measurements.value,
          });
          if (!consistency.ok) {
            failures.push({ check: "verdict-consistency", detail: consistency.reason });
          }
        } catch (cause) {
          failures.push({ check: "verdict-consistency", detail: String(cause) });
        }
      }
    }

    let distinctnessFailure =
      input.verdict.evaluatorAddress.toLowerCase()
        === input.verdict.solver.address.toLowerCase()
        ? "on-chain evaluator address equals the subject solver address"
        : undefined;
    let resolvedSolverAgent: string | undefined;
    if (!Rfc3339.safeParse(input.verdict.solver.effectiveTime).success) {
      distinctnessFailure =
        `solver declaration effective time "${input.verdict.solver.effectiveTime}" is not RFC 3339`;
    } else {
      try {
        const solverBinding = await ports.bindingResolver.resolveBinding(
          {
            key: input.verdict.solver.declarationKey,
            agent: input.verdict.solver.claimedAgent,
          },
          input.verdict.solver.effectiveTime,
        );
        if (solverBinding === null) {
          distinctnessFailure =
            "solver declaration does not resolve to the claimed solver Agent IRI";
        } else if (
          solverBinding.binding.relationship !== "controls"
          && solverBinding.binding.relationship !== "signs-for"
        ) {
          distinctnessFailure =
            `solver declaration relationship "${solverBinding.binding.relationship}" is not authority-bearing`;
        } else if (solverBinding.binding.agent !== input.verdict.solver.claimedAgent) {
          distinctnessFailure =
            "solver declaration resolved to a different Agent IRI";
        } else {
          resolvedSolverAgent = solverBinding.binding.agent;
        }
      } catch (cause) {
        distinctnessFailure =
          `solver declaration resolution dependency failed: ${String(cause)}`;
      }
    }

    const evaluatedAt = statement.predicate.evaluatedAt;
    const validEvaluatedAt = Rfc3339.safeParse(evaluatedAt).success;
    const validClaimTime = Rfc3339.safeParse(input.verdict.claimBlockTime).success;
    if (
      !validEvaluatedAt
      || !validClaimTime
      || compareRfc3339Instants(evaluatedAt, input.verdict.claimBlockTime) > 0
    ) {
      failures.push({
        check: "verdict-effective-time",
        detail:
          `evaluatedAt "${evaluatedAt}" must be valid RFC 3339 and no later than `
          + `claim block time "${input.verdict.claimBlockTime}"`,
      });
    } else {
      let envelopeBinding;
      try {
        envelopeBinding = await verifyEnvelopeBinding(
          {
            envelopeBytes: input.verdict.envelopeBytes,
            key: input.verdict.signerKey,
            agent: statement.predicate.evaluator.id,
            family: "verdicts",
            atTime: evaluatedAt,
          },
          {
            bindingResolver: ports.bindingResolver,
            witnessVerifier: ports.witnessVerifier,
            dsseVerifier: ports.dsseVerifier,
            ...(ports.evaluatorPolicy === undefined ? {} : { policy: ports.evaluatorPolicy }),
          },
        );
      } catch (cause) {
        failures.push({
          check: "settlement-join",
          detail: `verdict envelope binding dependency failed: ${String(cause)}`,
        });
      }
      if (envelopeBinding === undefined) {
        // The dependency exception is already represented as a typed named-check failure.
      } else if (!envelopeBinding.ok) {
        failures.push({
          check: "settlement-join",
          detail:
            `verdict envelope binding failed: ${envelopeBinding.reason ?? "unknown"}`
            + `${envelopeBinding.detail === undefined ? "" : `: ${envelopeBinding.detail}`}`,
        });
      } else {
        let join;
        try {
          join = await settlementJoinCheck(
            {
              verdictKey: input.verdict.signerKey,
              settlementDeclarationKey: input.verdict.settlementDeclarationKey,
              claimedEvaluatorAgent: statement.predicate.evaluator.id,
              family: "verdicts",
              envelopeEffectiveTime: evaluatedAt,
              claimTime: input.verdict.claimBlockTime,
            },
            { bindingResolver: ports.bindingResolver },
          );
        } catch (cause) {
          failures.push({
            check: "settlement-join",
            detail: `settlement join dependency failed: ${String(cause)}`,
          });
        }
        if (join !== undefined && !join.ok) {
          failures.push({
            check: "settlement-join",
            detail: join.reason ?? "settlement join failed",
          });
        } else if (
          join?.agent !== undefined
          && resolvedSolverAgent !== undefined
          && join.agent === resolvedSolverAgent
        ) {
          distinctnessFailure =
            `solver and evaluator declarations both resolve to Agent IRI "${join.agent}"`;
        }
      }
    }

    if (distinctnessFailure !== undefined) {
      failures.push({
        check: "evaluator-distinctness",
        detail: distinctnessFailure,
      });
    }
  }

  return { decisionGrade: failures.length === 0, failures };
}
