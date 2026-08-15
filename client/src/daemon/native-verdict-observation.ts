/**
 * The REAL native verdict-observation adapter (one-swap M4b, umbrella #2461, DR-2026-08-05).
 *
 * M4a mounted the fleet evaluator loop and left the projector's `verifyVerdictObservation` port
 * fail-closed (`refuseNativeVerdictObservation`). This is the gate that CLOSES it, and closes
 * FLIP-GATE 1.
 *
 * What it does, and what it deliberately does NOT do:
 *
 * - The projector announces THIS operator's OWN verdicts (its source is
 *   `urn:jinn:operator:<mech>/operator-projector`). So a `VerdictDeliveryClaimed` observation the
 *   projector is about to announce is a verdict THIS operator produced and durably recorded. The
 *   adapter therefore verifies against the operator's own durable evaluator aggregate
 *   (`native_evaluation_authority` / `native_evaluations` / `native_evaluation_artifacts`), NOT a
 *   remote re-derivation.
 * - It derives `(VerdictDeliveryClaimed event, AnnouncementRecordMaterial)` into the exact
 *   `NativeEvaluatorVerdictVerificationInput` the SETTLEMENT path assembles, and runs it through the
 *   SAME `buildNativeEvaluatorVerdictVerification(...).verify` instance the coordinator drives
 *   (injected as `verification`). One gate, no drift.
 * - It FAILS CLOSED on every miss — the announced record does not join a durable aggregate, the
 *   durable evaluation-delivery digest does not equal the announced material, an on-chain identifier
 *   disagrees, or the decision-grade gate refuses. On any of those it THROWS. `projectAnnouncements`
 *   turns a `verifyVerdictObservation` throw into a fail-closed verdict refusal
 *   (`decisionGrade: false`), which is the correct answer. It NEVER fabricates a `decisionGrade: true`
 *   or a `statementVerdict` for a verdict it could not independently re-verify.
 *
 * Self-evaluation is refused upstream (M4a); this adapter does not re-check it. A verdict whose
 * subject is another operator's solution is a real evaluation this operator performed and resolves
 * normally here.
 */
import { documentDigest } from "@jinn-network/task-execution-protocol";
import {
  VerdictCode,
  type VerdictObservationGate,
} from "@jinn-network/marketplace-binding";
import type {
  AnnouncementRecordMaterial,
  ObservationMarketplaceEvent,
} from "@jinn-network/marketplace-projector";
import {
  materialFromState,
  type NativeEvaluatorVerdictVerificationPort,
} from "./native-evaluator-coordinator.js";
import type { NativeEvaluatorStateRepository } from "./native-evaluator-state.js";

/** The on-chain `VerdictDeliveryClaimed` observation the projector hands the gate. */
type VerdictDeliveryClaimedEvent = Extract<
  ObservationMarketplaceEvent,
  { event: "VerdictDeliveryClaimed" }
>;

/**
 * The exact result shape `projectAnnouncements` consumes from a `verifyVerdictObservation` port:
 * a decision-grade gate plus the correspondence verdict it will cross-check against the on-chain
 * `verdictCode`.
 */
export interface NativeVerdictObservationResult {
  readonly gate: VerdictObservationGate;
  readonly statementVerdict?: "pass" | "fail" | "inconclusive";
}

/**
 * The durable evaluator reads this adapter needs — the exact `NativeEvaluatorStateRepository`
 * surface, narrowed so the derivation can be tested against an in-memory fake without standing up
 * a Store.
 */
export type NativeVerdictObservationStateReader = Pick<
  NativeEvaluatorStateRepository,
  | "listEvaluations"
  | "listEvaluationArtifacts"
  | "getEvaluation"
  | "getAdmissionAuthority"
  | "getDerivedEvaluation"
  | "listSubjectArtifacts"
>;

export interface NativeVerdictObservationAdapterInput {
  /** The durable evaluator aggregate over the SHARED Store (M4a's `FleetNativeEvaluator.state`). */
  readonly state: NativeVerdictObservationStateReader;
  /**
   * The coordinator's OWN decision-grade verdict verification port
   * (`FleetNativeEvaluator.composition.verification`). Reused, never rebuilt.
   */
  readonly verification: NativeEvaluatorVerdictVerificationPort;
}

export class NativeVerdictObservationError extends Error {
  override readonly name = "NativeVerdictObservationError";
}

const EVALUATION_DELIVERY_ROLE = "evaluation-delivery";

/**
 * The projector's `resolveRecord("evaluation-delivery")` leg for the TODAY generation (defect #45).
 *
 * Today-generation `VerdictDeliveryClaimed` carries no `evaluationDeliveryDigest`
 * (`packages/marketplace/projector/src/events.ts`'s `todayEvent`), so there is no digest to fetch
 * by. The ENGAGEMENT is the key instead — the SAME narrowing
 * `buildNativeVerdictObservationAdapter` applies below, minus the digest bind it cannot apply yet.
 *
 * This is not self-attestation, and the announce plane does not take these bytes on trust: the M4b
 * gate runs immediately after, on this exact material, and re-derives `documentDigest(material.bytes)`
 * to bind it to exactly one durable `evaluation-delivery` artifact row, then re-verifies the whole
 * aggregate through the coordinator's own gate. Bytes substituted anywhere between here and there
 * join zero rows and are refused. Returning the bytes is what lets that gate run at all.
 *
 * `undefined` (never a throw) on a miss and on an ambiguous match: `resolveRecord`'s caller turns
 * that into a named refusal, and more than one durable evaluation for one on-chain claim is a
 * derivation defect, not a record to guess between.
 */
export function buildNativeEvaluationDeliveryRecordResolver(
  state: Pick<NativeVerdictObservationStateReader, "listEvaluations" | "listEvaluationArtifacts">,
): (lookup: {
  readonly chainId: number;
  readonly coordinator: string;
  readonly taskId: bigint;
  readonly solutionAttemptIndex: number;
  readonly verdictCode: number;
  readonly evaluationRequestId: string;
}) => Promise<Uint8Array | undefined> {
  return async (lookup) => {
    const requestId = lookup.evaluationRequestId.toLowerCase();
    const coordinator = lookup.coordinator.toLowerCase();
    const matches = state.listEvaluations().filter((evaluation) =>
      evaluation.chainId === lookup.chainId
      && evaluation.coordinator.toLowerCase() === coordinator
      && evaluation.taskId === lookup.taskId
      && evaluation.solutionAttemptIndex === lookup.solutionAttemptIndex
      && evaluation.verdictCode === lookup.verdictCode
      && (evaluation.evaluationRequestId ?? "").toLowerCase() === requestId);
    if (matches.length !== 1) return undefined;
    const deliveries = state
      .listEvaluationArtifacts(matches[0]!.evaluationId)
      .filter(({ role }) => role === EVALUATION_DELIVERY_ROLE);
    if (deliveries.length !== 1) return undefined;
    return deliveries[0]!.bytes;
  };
}

function sha256ToBytes32(digest: `sha256:${string}`): `0x${string}` {
  const hex = digest.slice("sha256:".length);
  if (!/^[0-9a-f]{64}$/u.test(hex)) {
    throw new NativeVerdictObservationError(`durable digest is not a 32-byte sha256: ${digest}`);
  }
  return `0x${hex}`;
}

/**
 * Maps a decision-grade `VerdictCode` back to the Result Evaluation Statement verdict
 * `projectAnnouncements` cross-checks against the on-chain code (`decisionGradeVerdictCode` is the
 * exact inverse). `None(0)` and `Invalid(3)` have NO decision-grade statement verdict; refusing
 * them here is what keeps a non-decision-grade code from being announced as verified.
 */
function statementVerdictFor(code: VerdictCode): "pass" | "fail" | "inconclusive" {
  switch (code) {
    case VerdictCode.Pass:
      return "pass";
    case VerdictCode.Fail:
      return "fail";
    case VerdictCode.Unresolved:
      return "inconclusive";
    default:
      throw new NativeVerdictObservationError(
        `verdict code ${code} has no decision-grade Result Evaluation Statement verdict`,
      );
  }
}

/**
 * Builds the projector's `verifyVerdictObservation` port. The returned function derives the durable
 * aggregate from the announcement, re-verifies it through the coordinator's gate, and either returns
 * the decision-grade correspondence or throws (fail-closed).
 */
export function buildNativeVerdictObservationAdapter(
  input: NativeVerdictObservationAdapterInput,
): (
  event: VerdictDeliveryClaimedEvent,
  material: AnnouncementRecordMaterial,
) => Promise<NativeVerdictObservationResult> {
  const { state, verification } = input;
  return async (event, material) => {
    const facts = event.facts;
    // The announced record's OWN digest is the join key: "did this operator durably produce THIS
    // exact evaluation-delivery record?" Never derive an expected digest from anything but the
    // announced bytes.
    const materialDigest = documentDigest(material.bytes);
    const requestId = facts.requestId.toLowerCase();

    // Narrow on the cheap row fields first (taskId / solution attempt / verdict code / evaluation
    // request id), then bind on the durable evaluation-delivery artifact digest. Every one of these
    // must agree with the on-chain claim; disagreement is a derivation miss, not a soft skip.
    const matches = state.listEvaluations().filter((evaluation) =>
      evaluation.taskId === facts.taskId
      && evaluation.solutionAttemptIndex === facts.attemptIndex
      && evaluation.verdictCode === facts.verdictCode
      && (evaluation.evaluationRequestId ?? "").toLowerCase() === requestId
      && state
        .listEvaluationArtifacts(evaluation.evaluationId)
        .some(({ role, digest }) => role === EVALUATION_DELIVERY_ROLE && digest === materialDigest),
    );
    if (matches.length !== 1) {
      throw new NativeVerdictObservationError(
        `announced verdict joins ${matches.length} durable evaluation aggregates for `
        + `task=${facts.taskId} attempt=${facts.attemptIndex} requestId=${facts.requestId} `
        + `evaluationDelivery=${materialDigest}; refusing rather than announcing an unverified verdict`,
      );
    }
    const evaluation = matches[0]!;

    // V4 carries the evaluation-delivery digest on the claim itself; when present it must equal the
    // announced material's own digest, byte-for-byte.
    if ("evaluationDeliveryDigest" in facts
      && facts.evaluationDeliveryDigest.toLowerCase() !== sha256ToBytes32(materialDigest).toLowerCase()) {
      throw new NativeVerdictObservationError(
        `on-chain evaluationDeliveryDigest ${facts.evaluationDeliveryDigest} does not equal the `
        + `announced evaluation-delivery ${materialDigest}`,
      );
    }

    const evaluationAuthority = state.getAdmissionAuthority(evaluation.evaluationId);
    const derived = state.getDerivedEvaluation(evaluation.evaluationId);
    if (evaluationAuthority === undefined || derived === undefined) {
      throw new NativeVerdictObservationError(
        `durable evaluation ${evaluation.evaluationId} is missing verified authority or its sealed `
        + "pair; refusing to announce a verdict this operator cannot re-verify",
      );
    }

    // Re-verify the whole graph from durable exact bytes through the coordinator's own gate. No
    // `canonical` is supplied: the projector's own downstream check compares
    // `decisionGradeVerdictCode(statementVerdict)` to `event.facts.verdictCode`, so the on-chain
    // correspondence is closed there.
    const verified = await verification.verify({
      evaluation,
      evaluationAuthority,
      subject: materialFromState(state, evaluation.evaluationId),
      derived,
      artifacts: state.listEvaluationArtifacts(evaluation.evaluationId),
    });
    if (!verified.ok) {
      throw new NativeVerdictObservationError(
        `decision-grade verdict gate refused durable evaluation ${evaluation.evaluationId}: ${verified.reason}`,
      );
    }
    if (verified.verdictCode !== facts.verdictCode) {
      throw new NativeVerdictObservationError(
        `re-verified verdict code ${verified.verdictCode} does not equal the on-chain claim `
        + `${facts.verdictCode}`,
      );
    }

    return {
      gate: { decisionGrade: true, failures: [] },
      statementVerdict: statementVerdictFor(verified.verdictCode),
    };
  };
}
