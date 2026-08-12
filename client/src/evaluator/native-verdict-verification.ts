import {
  ResultEvaluationStatementShape,
} from "@jinn-network/task-execution-profiles";
import {
  DeliveryRecordSchema,
  documentDigest,
  sealDelivery,
} from "@jinn-network/task-execution-protocol";
import {
  parseExactDsseEnvelope,
} from "@jinn-network/trust-core";
import {
  decisionGradeVerdictCode,
  type VerdictCode,
  type VerdictObservationGate,
  type VerdictObservationGateInput,
} from "@jinn-network/marketplace-binding";
import type {
  NativeEvaluatorVerdictVerificationPort,
  NativeEvaluatorVerdictVerificationInput,
} from "../daemon/native-evaluator-coordinator.js";

export interface NativeEnvelopeAuthorityPort {
  verify(input: {
    readonly envelopeBytes: Uint8Array;
    readonly payloadBytes: Uint8Array;
    readonly signerKey: string;
    readonly agent: string;
    readonly family: "deliveries";
    readonly atTime: string;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
}

export interface NativeVerdictVerificationDependencies {
  readonly gate: { gate(input: VerdictObservationGateInput): Promise<VerdictObservationGate> };
  readonly solutionDeliveryAuthority: NativeEnvelopeAuthorityPort;
  readonly evaluationDeliveryAuthority: NativeEnvelopeAuthorityPort;
  readonly preSettlementClaimTime: () => Promise<string>;
  readonly blockTime: (blockNumber: bigint) => Promise<string>;
}

function fail(reason: string): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason };
}

function artifact(input: NativeEvaluatorVerdictVerificationInput, role: string) {
  const matches = input.artifacts.filter((candidate) => candidate.role === role);
  return matches.length === 1 ? matches[0] : undefined;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

/**
 * Reads the delivered verdict's code from its DSSE envelope, using the STRICT
 * `parseExactDsseEnvelope` -- the same authority-bearing parser the cross-operator consumer
 * applies via `verifyNativeDsse` (defect-#34 follow-up). The loose structural parser accepted
 * alternate JSON spellings the strict one refuses, so this operator's own pre-settlement path
 * derived a verdict code from bytes that could never settle; the refusal surfaced later as an
 * opaque `settlement-join` signature failure instead of naming the encoding. Refusing here
 * returns `undefined`, which `verifyExactGraph` reports as `evaluation-record-graph-invalid`.
 *
 * The verdict itself is read with `decisionGradeVerdictCode` -- the same reader the named gate
 * applies to this same field to derive its `verdict-correspondence` expectation. The code derived
 * here becomes the gate's `onChainVerdictCode` pre-settlement, so a second reader with its own
 * vocabulary is not an alternative spelling, it is a disagreement the gate cannot survive. The
 * previous reader (`verdictCodeFromValue`) accepted a wider venue vocabulary yet had no case for
 * the ratified `inconclusive`, so every honest `Unresolved(4)` verdict refused here as
 * `evaluation-record-graph-invalid` and never reached `recordVerdict`.
 */
function codeFromVerdict(bytes: Uint8Array): VerdictCode | undefined {
  try {
    const envelope = parseExactDsseEnvelope(bytes);
    const statement = ResultEvaluationStatementShape.parse(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(envelope.payloadBytes),
    ));
    return decisionGradeVerdictCode(statement.predicate.verdict);
  } catch {
    return undefined;
  }
}

function verifyExactGraph(input: NativeEvaluatorVerdictVerificationInput):
  | {
      readonly delivery: ReturnType<typeof DeliveryRecordSchema.parse>;
      readonly deliveryBytes: Uint8Array;
      readonly deliveryEnvelopeBytes: Uint8Array;
      readonly verdictBytes: Uint8Array;
      readonly verdictCode: VerdictCode;
    }
  | undefined {
  const deliveryArtifact = artifact(input, "evaluation-delivery");
  const deliveryEnvelope = artifact(input, "evaluation-delivery-envelope");
  const verdict = artifact(input, "verdict");
  if (deliveryArtifact === undefined || deliveryEnvelope === undefined || verdict === undefined) return undefined;
  for (const value of [...input.artifacts, ...input.subject.evidenceRecords, ...input.subject.results]) {
    if (documentDigest(value.bytes) !== value.digest) return undefined;
  }
  let delivery;
  try {
    delivery = DeliveryRecordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(deliveryArtifact.bytes)));
  } catch {
    return undefined;
  }
  if (!equal(sealDelivery(delivery), deliveryArtifact.bytes)) return undefined;
  if (delivery.task !== input.derived.taskDigest || delivery.attempt !== input.derived.attemptUri) return undefined;
  const verdictOutputs = delivery.outputs.filter(({ name }) => name === "verdict");
  if (verdictOutputs.length !== 1
    || verdictOutputs[0]!.digest?.sha256 === undefined
    || `sha256:${verdictOutputs[0]!.digest!.sha256}` !== verdict.digest) return undefined;
  const evidence = new Set(input.artifacts
    .filter(({ role }) => role === "evaluation-evidence")
    .map(({ digest }) => digest));
  if ((delivery.evidenceRecords?.length ?? 0) !== evidence.size
    || (delivery.evidenceRecords ?? []).some(({ digest }) => !evidence.has(digest as `sha256:${string}`))) return undefined;
  const verdictCode = codeFromVerdict(verdict.bytes);
  if (verdictCode === undefined) return undefined;
  return {
    delivery,
    deliveryBytes: deliveryArtifact.bytes,
    deliveryEnvelopeBytes: deliveryEnvelope.bytes,
    verdictBytes: verdict.bytes,
    verdictCode,
  };
}

/** Rebuilds every gate input from exact public bytes; producer verification flags are ignored. */
export function buildNativeEvaluatorVerdictVerification(
  dependencies: NativeVerdictVerificationDependencies,
): NativeEvaluatorVerdictVerificationPort {
  return {
    async verify(input) {
      const exact = verifyExactGraph(input);
      if (exact === undefined) return fail("evaluation-record-graph-invalid");

      // Authority was persisted only after pre-claim trust verification, but settlement must
      // re-resolve both Delivery signatures at their own effective times.
      const stateAuthority = input.evaluationAuthority;
      const subjectDelivery = DeliveryRecordSchema.parse(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(input.subject.delivery.bytes),
      ));
      if (!equal(sealDelivery(subjectDelivery), input.subject.delivery.bytes)) {
        return fail("solution-delivery-noncanonical");
      }
      const solutionEvidence = new Set(input.subject.evidenceRecords.map(({ digest }) => digest));
      if ((subjectDelivery.evidenceRecords?.length ?? 0) !== solutionEvidence.size
        || (subjectDelivery.evidenceRecords ?? []).some(({ digest }) =>
          !solutionEvidence.has(digest as `sha256:${string}`))) {
        return fail("solution-evidence-graph-invalid");
      }
      const solutionAuthority = await dependencies.solutionDeliveryAuthority.verify({
        envelopeBytes: input.subject.deliveryEnvelope.bytes,
        payloadBytes: input.subject.delivery.bytes,
        signerKey: stateAuthority.executor.signerKey,
        agent: stateAuthority.executor.agent,
        family: "deliveries",
        atTime: subjectDelivery.createdAt,
      });
      if (!solutionAuthority.ok) return fail(`solution-delivery-authority:${solutionAuthority.reason}`);
      const evaluationAuthority = await dependencies.evaluationDeliveryAuthority.verify({
        envelopeBytes: exact.deliveryEnvelopeBytes,
        payloadBytes: exact.deliveryBytes,
        signerKey: stateAuthority.evaluator.signerKey,
        agent: stateAuthority.evaluator.agent,
        family: "deliveries",
        atTime: exact.delivery.createdAt,
      });
      if (!evaluationAuthority.ok) return fail(`evaluation-delivery-authority:${evaluationAuthority.reason}`);

      const claimBlockTime = input.canonical === undefined
        ? await dependencies.preSettlementClaimTime()
        : await dependencies.blockTime(input.canonical.transaction.blockNumber);
      const onChainVerdictCode = input.canonical?.verdictCode ?? exact.verdictCode;
      const gate = await dependencies.gate.gate({
        settlement: {
          subjectTask: input.subject.task,
          subjectDelivery: input.subject.delivery,
          subjectResults: input.subject.results,
          subjectSubmissionBytes: input.subject.submission.bytes,
          evaluationSpecBytes: input.subject.evaluationSpec.bytes,
          evaluationTaskBytes: input.derived.taskBytes,
        },
        admissionReceipt: {
          envelopeBytes: input.subject.admissionReceipt.bytes,
          signerKey: stateAuthority.admission.signerKey,
          effectiveTime: stateAuthority.admission.effectiveTime,
        },
        requesterAuthentication: {
          envelopeBytes: input.subject.requesterEnvelope.bytes,
          signerKey: stateAuthority.requester.signerKey,
          sealingTime: stateAuthority.requester.sealingTime,
        },
        verdict: {
          envelopeBytes: exact.verdictBytes,
          signerKey: stateAuthority.evaluator.signerKey,
          settlementDeclarationKey: stateAuthority.evaluator.declarationKey,
          claimBlockTime,
          onChainVerdictCode,
          solver: {
            address: stateAuthority.executor.address,
            claimedAgent: stateAuthority.executor.agent,
            declarationKey: stateAuthority.executor.declarationKey,
            effectiveTime: stateAuthority.executor.effectiveTime,
          },
          evaluatorAddress: input.canonical?.evaluator ?? stateAuthority.evaluator.address,
        },
      });
      if (!gate.decisionGrade) {
        return fail(`named-verdict-gate:${gate.failures.map(({ check }) => check).join(",")}`);
      }
      if (input.canonical !== undefined && input.canonical.verdictCode !== exact.verdictCode) {
        return fail("canonical-verdict-code-mismatch");
      }
      return { ok: true, verdictCode: exact.verdictCode };
    },
  };
}
