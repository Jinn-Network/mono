// SPDX-License-Identifier: MIT

import {
  checkDeliveryCorrespondence,
  decodeRevisedRequestData,
  deriveMarketplaceAttemptUri,
  REVISED_LEG_SOLUTION,
  REVISED_LEG_VERDICT,
} from "@jinn-network/marketplace-binding";
import {
  formatSequence,
  type ProtocolObservation,
  type ResourceDescriptor,
} from "@jinn-network/task-execution-protocol";
import type { Hex } from "viem";
import type { MarketplaceEvent } from "./events.js";

export interface ObservationProjectionContext {
  /** Authoritative TaskCoordinator used by the protocol-owned Attempt URI derivation. */
  readonly taskCoordinator: `0x${string}`;
  /** Deterministic block timestamp in RFC 3339 form; never projector wall-clock time. */
  readonly timestamp: string;
  /** Signed Submission identity resolved by the projector host for this on-chain task. */
  readonly submission: `urn:uuid:${string}`;
  /** Exact Task digest after the required Task/Submission/on-chain digest join. */
  readonly taskDigest: `sha256:${string}`;
  /** Today-mode deadline from the signed Submission; revised claims use their on-chain deadline. */
  readonly effectiveDeadline: string;
  /** Descriptor sealed by the binding when it engaged the two-party backend. */
  readonly dispatchContext: ResourceDescriptor;
  readonly source?: string;
  /**
   * Today-mode delivery bytes recomputation + chain-read facts. It is carried on the external
   * Mech Deliver fact and is mandatory before the matching router claim can project a delivery.
   */
  readonly deliveryCorrespondence?: {
    readonly sha256Digest: `sha256:${string}`;
    readonly keccakEvidenceHash: Hex;
    readonly onChainSha256CidDigest: `sha256:${string}`;
    readonly onChainKeccak: Hex;
  };
  /**
   * Requester-side today-mode delivery correspondence (defect #48), carried on the ROUTER's
   * `SolutionDeliveryClaimed` rather than on a Mech `Deliver`.
   *
   * A requester never subscribes to the counterparty's mech -- the projector's log filter scans
   * the router, the coordinator, and this operator's OWN mech(es) only -- so it can never hold a
   * `pendingMechDeliveries` fact for a solution another operator delivered. Absence of that fact
   * is therefore not evidence of an invalid reference on the requester; it is evidence of a
   * subscription this role does not have.
   *
   * What the requester DOES hold is the coordinator's own anchor for the attempt
   * (`getAttempt(taskId, attemptIndex).solutionCidDigest`, today generation's keccak evidence hash
   * over the exact sealed Delivery bytes) plus the record plane those bytes are published to. The
   * host resolves the published record, re-derives BOTH digests locally, and hands the pair over
   * here. The reducer re-checks the keccak leg itself rather than trusting the host -- the same
   * defense in depth `deliveryCorrespondence` already gets from `checkDeliveryCorrespondence`.
   *
   * Presence of this field is the requester-side witness. Its absence changes nothing: the
   * mech-fact requirement on every other role stays exactly as it was.
   */
  readonly recordPlaneDelivery?: {
    /** sha256 of the exact published Delivery bytes -- the digest `delivery-recorded.v1` carries. */
    readonly sha256Digest: `sha256:${string}`;
    /** keccak256 of those same bytes, recomputed locally by the host. */
    readonly keccakEvidenceHash: Hex;
    /** `TaskCoordinator.getAttempt(...).solutionCidDigest` for this attempt. */
    readonly onChainKeccak: Hex;
  };
}

export type ObservationMarketplaceEvent = MarketplaceEvent & {
  readonly projection: ObservationProjectionContext;
};

/** Marketplace CloudEvent extension required by rulings §7.21/§7.32. */
export type MarketplaceProtocolObservation = ProtocolObservation & {
  readonly derivation: MarketplaceEvent["derivation"];
  readonly correction?: {
    readonly retractsObservationId: string;
    readonly orphanedBlockHash: Hex;
  };
};

interface ReceiptPosition {
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly logIndex: number;
}

interface PendingMechDelivery {
  readonly data: Hex;
  readonly requestData?: Hex;
  readonly receipt?: ReceiptPosition;
  readonly deliveryCorrespondence?: NonNullable<
    ObservationProjectionContext["deliveryCorrespondence"]
  >;
}

interface AdmissibleTaskProjection {
  /** Undefined is accepted for legacy persisted admissible state. */
  readonly admission?: "admissible";
  maxTotal: number;
  liveAttemptIndices: Record<string, true>;
  seenAttemptIndices: Record<string, true>;
  highestAttemptIndex: number;
  availability: "open" | "closed";
  /** Terminal Task causes are monotonic and dominate capacity reopening. */
  terminalCause?: "finalized" | "refunded" | "requester-closed";
  /** Backward-compatible marker retained for persisted requester-closed state. */
  requesterClosed?: true;
  /** Revised creation anchor used to admit every later availability re-opening. */
  submissionAnchor?: {
    readonly digest: `sha256:${string}`;
    readonly derivation: MarketplaceEvent["derivation"];
  };
  /** Immutable creation facts reused by later availability announcements. */
  submissionTerms?: Record<string, string>;
}

interface RejectedTaskTombstone {
  readonly admission: "rejected";
  readonly rejection: {
    readonly category: "content-corruption";
    readonly derivation: MarketplaceEvent["derivation"];
  };
  /** These explicitly remain absent on the tombstone; optional `never` retains discriminated access. */
  readonly maxTotal?: never;
  readonly liveAttemptIndices?: never;
  readonly seenAttemptIndices?: never;
  readonly highestAttemptIndex?: never;
  readonly availability?: never;
  readonly terminalCause?: never;
  readonly requesterClosed?: never;
  readonly submissionAnchor?: never;
  readonly submissionTerms?: never;
}

type MarketplaceTaskProjection = AdmissibleTaskProjection | RejectedTaskTombstone;

export interface MarketplaceProjectionState {
  /** Canonical chain-log identities already reduced, in first-seen order. */
  processedLogIds: string[];
  /** Idempotency keys for append-only reorg corrections already emitted. */
  processedCorrectionIds: string[];
  /** Last emitted sequence by authoritative `(source, subject)` observation stream. */
  sequenceBySourceSubject: Record<string, string>;
  /**
   * Capacity, identity, and visibility are deliberately distinct: a released revised Attempt
   * ceases to occupy capacity but its index can never be reused for a different Attempt URI.
   */
  tasks: Record<string, MarketplaceTaskProjection>;
  /** External Mech delivery facts waiting for their router claim. */
  pendingMechDeliveries: Record<string, PendingMechDelivery>;
  /**
   * Persistent request-ID bindings keyed `chainId:normalizedRequestId`. Attempt-creation
   * events register here; any distinct-log reuse or contradictory rebinding is refused.
   */
  requestIdBindings: Record<string, RequestIdBinding>;
  /**
   * Evaluation verdict-slot identity keyed by `(chain, coordinator, taskId, parentAttemptIndex)`.
   * Distinct from task-attempt `seenAttemptIndices`; tracks monotonic single-use verdict slots.
   */
  evaluationIdentities: Record<string, EvaluationParentIdentity>;
  /** Claim-time identity keyed by the protocol Attempt URI. */
  attemptEngagements: Record<string, AttemptEngagement>;
  /** Evaluation claim identity keyed by parent identity plus verdict index. */
  evaluationEngagements: Record<string, EvaluationEngagement>;
}

interface EvaluationParentIdentity {
  seenVerdictIndices: Record<string, true>;
  highestVerdictIndex: number;
}

interface RequestIdBinding {
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly role:
    | "task-attempt"
    | "evaluation-attempt"
    | "solution-preparation"
    | "verdict-preparation";
  readonly kind?: "solution" | "verdict";
  readonly verdictIndex?: number;
  readonly party?: `0x${string}`;
  readonly priorityMech?: `0x${string}`;
  readonly deliveryRate?: bigint;
  readonly deliveryDigest?: Hex;
  readonly verdictCode?: number;
  readonly nonce?: bigint;
  readonly   preparation?: ReceiptPosition;
  status?: "claimed" | "prepared" | "delivered" | "forfeited";
  /** Prevents duplicate attempt-terminal emissions across coordinator/reservation forfeit. */
  forfeitTerminalEmitted?: true;
}

interface AttemptEngagement {
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly operator: `0x${string}`;
  readonly priorityMech: `0x${string}`;
  readonly deliveryRate: bigint;
  readonly generation: "today" | "revised";
  status: "live" | "prepared" | "submitted" | "released" | "expired" | "forfeited";
  preparedRequestId?: Hex;
}

interface EvaluationEngagement {
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly verdictIndex: number;
  readonly evaluator: `0x${string}`;
  readonly priorityMech: `0x${string}`;
  readonly deliveryRate: bigint;
  readonly generation: "today" | "revised";
  status: "live" | "prepared" | "delivered" | "released" | "expired" | "forfeited";
  preparedRequestId?: Hex;
}

export interface MarketplaceProjectionTransition {
  /** Next caller-owned state. The input state is never mutated. */
  readonly state: MarketplaceProjectionState;
  /** Only first-seen events accepted by this transition; replayed log identities are absent. */
  readonly events: ObservationMarketplaceEvent[];
  /** Exact observation result consumed by the announcement projector. */
  readonly observations: MarketplaceProtocolObservation[];
  /** Revised-chain facts that changed a Submission from closed to open in this batch. */
  readonly availabilityOpenedLogIds: readonly string[];
  /** Typed fail-closed capacity/identity refusals; no observation is emitted for these facts. */
  readonly refusals: readonly MarketplaceProjectionRefusal[];
}

export interface MarketplaceProjectionRefusal {
  readonly kind: "marketplace-projection-refused";
  readonly reason:
    | "unknown-task"
    | "task-not-admissible"
    | "task-closed"
    | "attempt-identity-regressing"
    | "request-id-reused"
    | "attempt-not-live"
    | "capacity-contradiction"
    | "attempt-already-prepared"
    | "preparation-mismatch"
    | "deliver-request-data-invalid"
    | "deliver-request-data-mismatch"
    | "receipt-continuity-mismatch"
    | "reservation-not-prepared"
    | "reservation-not-delivered"
    | "engagement-forfeited";
  readonly derivation: MarketplaceEvent["derivation"];
  readonly taskId: bigint;
  readonly attemptIndex?: number;
}

export function createMarketplaceProjectionState(): MarketplaceProjectionState {
  return {
    processedLogIds: [],
    processedCorrectionIds: [],
    sequenceBySourceSubject: {},
    tasks: {},
    pendingMechDeliveries: {},
    requestIdBindings: {},
    evaluationIdentities: {},
    attemptEngagements: {},
    evaluationEngagements: {},
  };
}

export function cloneMarketplaceProjectionState(
  state: MarketplaceProjectionState,
): MarketplaceProjectionState {
  return {
    processedLogIds: [...state.processedLogIds],
    processedCorrectionIds: [...state.processedCorrectionIds],
    sequenceBySourceSubject: { ...state.sequenceBySourceSubject },
    tasks: Object.fromEntries(
      Object.entries(state.tasks).map(([key, value]) => [
        key,
        value.admission === "rejected"
          ? {
              admission: "rejected" as const,
              rejection: {
                category: value.rejection.category,
                derivation: { ...value.rejection.derivation },
              },
            }
          : {
          ...value,
          liveAttemptIndices: { ...value.liveAttemptIndices },
          seenAttemptIndices: { ...value.seenAttemptIndices },
          ...(value.submissionTerms === undefined
            ? {}
            : { submissionTerms: { ...value.submissionTerms } }),
          ...(value.submissionAnchor === undefined
            ? {}
            : {
                submissionAnchor: {
                  digest: value.submissionAnchor.digest,
                  derivation: { ...value.submissionAnchor.derivation },
                },
              }),
        },
      ]),
    ),
    pendingMechDeliveries: Object.fromEntries(
      Object.entries(state.pendingMechDeliveries).map(([key, value]) => [
        key,
        {
          data: value.data.slice() as Hex,
          ...(value.requestData === undefined
            ? {}
            : { requestData: value.requestData.slice() as Hex }),
          ...(value.receipt === undefined
            ? {}
            : { receipt: { ...value.receipt } }),
          ...(value.deliveryCorrespondence === undefined
            ? {}
            : {
                deliveryCorrespondence: {
                  ...value.deliveryCorrespondence,
                },
              }),
        },
      ]),
    ),
    requestIdBindings: Object.fromEntries(
      Object.entries(state.requestIdBindings).map(([key, value]) => [
        key,
        {
          ...value,
          ...(value.preparation === undefined
            ? {}
            : { preparation: { ...value.preparation } }),
        },
      ]),
    ),
    evaluationIdentities: Object.fromEntries(
      Object.entries(state.evaluationIdentities).map(([key, value]) => [
        key,
        {
          seenVerdictIndices: { ...value.seenVerdictIndices },
          highestVerdictIndex: value.highestVerdictIndex,
        },
      ]),
    ),
    attemptEngagements: Object.fromEntries(
      Object.entries(state.attemptEngagements ?? {}).map(([key, value]) => [
        key,
        { ...value },
      ]),
    ),
    evaluationEngagements: Object.fromEntries(
      Object.entries(state.evaluationEngagements ?? {}).map(([key, value]) => [
        key,
        { ...value },
      ]),
    ),
  };
}

function sourceFor(event: ObservationMarketplaceEvent): string {
  return event.projection.source
    ?? `urn:jinn:marketplace-projector:eip155:${event.derivation.chainId}:${event.derivation.contract.toLowerCase()}`;
}

function attemptFor(
  event: ObservationMarketplaceEvent,
  taskId: bigint,
  attemptIndex: number,
): `urn:uuid:${string}` {
  return deriveMarketplaceAttemptUri({
    chainId: event.derivation.chainId,
    coordinator: event.projection.taskCoordinator,
    taskId,
    attemptIndex,
  });
}

function unixSecondsToRfc3339(seconds: bigint): string {
  const milliseconds = seconds * 1000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`attempt deadline exceeds the supported Date range: ${seconds}`);
  }
  return new Date(Number(milliseconds)).toISOString();
}

function digestFromBytes32(value: Hex): `sha256:${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`expected bytes32 sha256 anchor, got ${value}`);
  }
  return `sha256:${value.slice(2).toLowerCase()}`;
}

function creationSubmissionTerms(
  event: Extract<ObservationMarketplaceEvent, { event: "TaskCreated" }>,
): Record<string, string> {
  if ("maxClaims" in event.facts) {
    return {
      contractGeneration: "today",
      maxTotal: String(event.facts.maxClaims),
      solutionBudgetWei: event.facts.solutionBudget.toString(),
      verdictBudgetWei: event.facts.verdictBudget.toString(),
    };
  }
  return {
    contractGeneration: "revised",
    maxTotal: String(event.facts.maxTotal),
    maxConcurrent: String(event.facts.maxConcurrent),
    submissionDeadline: event.facts.submissionDeadline.toString(),
    ...(event.facts.closeAt === 0n ? {} : { closeAt: event.facts.closeAt.toString() }),
    responseTimeout: event.facts.responseTimeout.toString(),
    minVerdicts: String(event.facts.minVerdicts),
    requireDistinctEvaluator: String(event.facts.requireDistinctEvaluator),
    solutionMaxDeliveryRateWei: event.facts.solutionMaxDeliveryRate.toString(),
    verdictMaxDeliveryRateWei: event.facts.verdictMaxDeliveryRate.toString(),
    solutionBudgetWei: event.facts.solutionBudget.toString(),
    verdictBudgetWei: event.facts.verdictBudget.toString(),
  };
}

function taskKey(event: ObservationMarketplaceEvent, taskId: bigint): string {
  return `${event.derivation.chainId}:${event.projection.taskCoordinator.toLowerCase()}:${taskId}`;
}

function pendingDeliveryKey(
  event: ObservationMarketplaceEvent,
  requestId: Hex,
): string {
  return `${event.derivation.chainId}:${requestId.toLowerCase()}`;
}

function logIdentity(event: ObservationMarketplaceEvent): string {
  const derivation = event.derivation;
  return [
    derivation.chainId,
    derivation.contract.toLowerCase(),
    derivation.blockHash.toLowerCase(),
    derivation.txHash.toLowerCase(),
    derivation.logIndex,
  ].join(":");
}

const CANONICAL_HASH = /^0x[0-9a-f]{64}$/;

function receiptPosition(
  derivation: MarketplaceEvent["derivation"],
): ReceiptPosition | undefined {
  if (
    !CANONICAL_HASH.test(derivation.blockHash)
    || !CANONICAL_HASH.test(derivation.txHash)
    || !Number.isSafeInteger(derivation.logIndex)
    || derivation.logIndex < 0
  ) {
    return undefined;
  }
  return {
    blockHash: derivation.blockHash,
    txHash: derivation.txHash,
    logIndex: derivation.logIndex,
  };
}

function followsInSameReceipt(
  earlier: ReceiptPosition | undefined,
  laterDerivation: MarketplaceEvent["derivation"],
): boolean {
  const later = receiptPosition(laterDerivation);
  return earlier !== undefined
    && later !== undefined
    && earlier.blockHash === later.blockHash
    && earlier.txHash === later.txHash
    && earlier.logIndex < later.logIndex;
}

function requestIdBindingKey(chainId: number, requestId: Hex): string {
  return `${chainId}:${requestId.toLowerCase()}`;
}

function registerRequestIdBinding(
  state: MarketplaceProjectionState,
  chainId: number,
  requestId: Hex,
  binding: RequestIdBinding,
): boolean {
  const key = requestIdBindingKey(chainId, requestId);
  if (state.requestIdBindings[key] !== undefined) return false;
  state.requestIdBindings[key] = binding;
  return true;
}

function evaluationParentKey(
  event: ObservationMarketplaceEvent,
  taskId: bigint,
  attemptIndex: number,
): string {
  return `${event.derivation.chainId}:${event.projection.taskCoordinator.toLowerCase()}:${taskId}:${attemptIndex}`;
}

function evaluationEngagementKey(
  event: ObservationMarketplaceEvent,
  taskId: bigint,
  attemptIndex: number,
  verdictIndex: number,
): string {
  return `${evaluationParentKey(event, taskId, attemptIndex)}:${verdictIndex}`;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Case-insensitive bytes32 comparison. Same shape as `sameAddress`, different width. */
function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * The all-zero anchor. `TaskCoordinator.recordSubmission` rejects a zero `solutionCidDigest`, so an
 * attempt that reads back zero has no submission recorded at all -- never something a resolved
 * record may be matched against (a zero-vs-zero compare would otherwise "pass").
 */
function isZeroHash(value: string): boolean {
  return /^0x0{64}$/i.test(value);
}

type ContractGeneration = "today" | "revised";

function taskContractGeneration(
  task: MarketplaceTaskProjection | undefined,
): ContractGeneration | undefined {
  if (task === undefined || task.admission === "rejected") return undefined;
  const generation = task.submissionTerms?.contractGeneration;
  return generation === "revised" || generation === "today"
    ? generation
    : undefined;
}

function bindingContractGeneration(binding: RequestIdBinding): ContractGeneration {
  return binding.role === "task-attempt" || binding.role === "evaluation-attempt"
    ? "today"
    : "revised";
}

function isDeliverableAttemptEngagement(
  engagement: AttemptEngagement | undefined,
): engagement is AttemptEngagement {
  return engagement !== undefined
    && (engagement.status === "live" || engagement.status === "prepared");
}

function isDeliverableEvaluationEngagement(
  engagement: EvaluationEngagement | undefined,
): engagement is EvaluationEngagement {
  return engagement !== undefined
    && (engagement.status === "live" || engagement.status === "prepared");
}

function forfeitPreparedOrDeliveredBindings(
  state: MarketplaceProjectionState,
  chainId: number,
  predicate: (binding: RequestIdBinding) => boolean,
): boolean {
  let hadDeliveredBinding = false;
  for (const [key, binding] of Object.entries(state.requestIdBindings)) {
    if (!key.startsWith(`${chainId}:`) || !predicate(binding)) continue;
    if (binding.status === "delivered") hadDeliveredBinding = true;
    if (binding.status === "prepared" || binding.status === "delivered") {
      binding.status = "forfeited";
      delete state.pendingMechDeliveries[key];
    }
  }
  return hadDeliveredBinding;
}

function evaluationVerdictIdentityRefused(
  state: MarketplaceProjectionState,
  parentKey: string,
  verdictIndex: number,
): boolean {
  const parent = state.evaluationIdentities[parentKey];
  return (
    parent?.seenVerdictIndices[String(verdictIndex)] !== undefined
    || verdictIndex <= (parent?.highestVerdictIndex ?? -1)
  );
}

function registerEvaluationVerdictIdentity(
  state: MarketplaceProjectionState,
  parentKey: string,
  verdictIndex: number,
): void {
  let parent = state.evaluationIdentities[parentKey];
  if (parent === undefined) {
    parent = { seenVerdictIndices: {}, highestVerdictIndex: -1 };
    state.evaluationIdentities[parentKey] = parent;
  }
  parent.seenVerdictIndices[String(verdictIndex)] = true;
  parent.highestVerdictIndex = verdictIndex;
}

function sequenceStreamKey(source: string, subject: string): string {
  return `${source.length}:${source}${subject}`;
}

const NON_PROTOCOL_CATEGORIES = new Set([
  "verdict-fail",
  "verdict-invalid",
  "verdict-unresolved",
  "verdict-code-invalid",
  "digest-divergence",
  "delivery-join-missing",
]);

/** Internal refusal labels must never escape as frozen TEP §13 observation categories. */
function assertProtocolCategory(data: Record<string, unknown>): void {
  const category = data["category"];
  if (typeof category === "string" && NON_PROTOCOL_CATEGORIES.has(category)) {
    throw new Error(`internal marketplace refusal "${category}" cannot be a Protocol Observation category`);
  }
}

export function nextMarketplaceObservationSequence(
  state: MarketplaceProjectionState,
  source: string,
  subject: string,
  floor?: string,
): string {
  const key = sequenceStreamKey(source, subject);
  const recorded = state.sequenceBySourceSubject[key];
  const previous = floor !== undefined
    && (recorded === undefined || recorded < floor)
    ? floor
    : recorded;
  const next = previous === undefined ? 1n : BigInt(previous) + 1n;
  const sequence = formatSequence(next);
  state.sequenceBySourceSubject[key] = sequence;
  return sequence;
}

function verdictTerminal(verdictCode: number): {
  readonly state: "delivered" | "rejected" | "failed";
  readonly category?: string;
  readonly detail?: string;
} {
  switch (verdictCode) {
    case 1:
      return { state: "delivered" };
    case 2:
      return { state: "rejected", detail: "verdict-fail" };
    case 3:
      return { state: "rejected", category: "protocol-violation" };
    case 4:
      return { state: "failed", category: "result-unavailable" };
    default:
      return { state: "rejected", category: "protocol-violation" };
  }
}

/**
 * The observation and announcement projectors consume the same ordered, context-enriched event
 * facts. Context is host-resolved signed-record/block data, kept separate from exact EVM facts.
 */
export function reduceMarketplaceProjection(
  events: readonly ObservationMarketplaceEvent[],
  previousState: MarketplaceProjectionState,
): MarketplaceProjectionTransition {
  const state = cloneMarketplaceProjectionState(previousState);
  const observations: MarketplaceProtocolObservation[] = [];
  const acceptedEvents: ObservationMarketplaceEvent[] = [];
  const availabilityOpenedLogIds: string[] = [];
  const refusals: MarketplaceProjectionRefusal[] = [];
  const processed = new Set(state.processedLogIds);
  let eventRefused = false;

  function emit(
    event: ObservationMarketplaceEvent,
    type: ProtocolObservation["type"],
    subject: string,
    data: Record<string, unknown>,
  ): void {
    assertProtocolCategory(data);
    const source = sourceFor(event);
    const observation = {
      specversion: "1.0",
      id: `${event.derivation.txHash}:${event.derivation.logIndex}:${type}`,
      source,
      subject,
      time: event.projection.timestamp,
      datacontenttype: "application/json",
      sequence: nextMarketplaceObservationSequence(state, source, subject),
      taskdigest: event.projection.taskDigest,
      derivation: event.derivation,
      type,
      data,
    } as MarketplaceProtocolObservation;
    observations.push(observation);
  }

  function refuse(
    event: ObservationMarketplaceEvent,
    reason: MarketplaceProjectionRefusal["reason"],
    taskId: bigint,
    attemptIndex?: number,
  ): void {
    eventRefused = true;
    refusals.push({
      kind: "marketplace-projection-refused",
      reason,
      derivation: event.derivation,
      taskId,
      ...(attemptIndex === undefined ? {} : { attemptIndex }),
    });
  }

  function updateAvailability(task: AdmissibleTaskProjection): "open" | "closed" {
    if (task.terminalCause !== undefined || task.requesterClosed === true) return "closed";
    return Object.keys(task.liveAttemptIndices).length >= task.maxTotal ? "closed" : "open";
  }

  function admissibleTask(
    task: MarketplaceTaskProjection | undefined,
  ): task is AdmissibleTaskProjection {
    return task !== undefined && task.admission !== "rejected";
  }

  for (const event of events) {
    const identity = logIdentity(event);
    if (processed.has(identity)) continue;
    processed.add(identity);
    state.processedLogIds.push(identity);
    eventRefused = false;

    switch (event.event) {
      case "TaskCreated": {
        const anchoredTaskDigest = digestFromBytes32(event.facts.taskCidDigest);
        const key = taskKey(event, event.facts.taskId);
        const previous = state.tasks[key];
        if (previous?.admission === "rejected") {
          refuse(event, "task-not-admissible", event.facts.taskId);
          break;
        }
        if (anchoredTaskDigest !== event.projection.taskDigest) {
          state.tasks[key] = {
            admission: "rejected",
            rejection: {
              category: "content-corruption",
              derivation: { ...event.derivation },
            },
          };
          emit(
            event,
            "network.jinn.task-execution.submission-rejected.v1",
            event.projection.submission,
            {
              category: "content-corruption",
              detail: "TaskCreated task digest does not match resolved signed Submission task digest",
            },
          );
          break;
        }
        const maxTotal = "maxClaims" in event.facts
          ? event.facts.maxClaims
          : event.facts.maxTotal;
        state.tasks[key] = {
          maxTotal,
          liveAttemptIndices: {},
          seenAttemptIndices: {},
          highestAttemptIndex: -1,
          availability: maxTotal === 0 ? "closed" : "open",
          submissionTerms: creationSubmissionTerms(event),
          ...(event.derivation.contractGeneration === "revised" && "submissionDigest" in event.facts
            ? {
                submissionAnchor: {
                  digest: digestFromBytes32(event.facts.submissionDigest),
                  derivation: { ...event.derivation },
                },
              }
            : {}),
        };

        emit(
          event,
          "network.jinn.task-execution.submission-accepted.v1",
          event.projection.submission,
          {
            submission: event.projection.submission,
            task: event.projection.taskDigest,
          },
        );
        break;
      }

      case "TaskAttemptCreated": {
        const key = taskKey(event, event.facts.taskId);
        const taskCapacity = state.tasks[key];
        if (taskCapacity?.admission === "rejected") {
          refuse(event, "task-not-admissible", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        if (
          admissibleTask(taskCapacity)
          && (taskCapacity.terminalCause !== undefined || taskCapacity.requesterClosed === true)
        ) {
          refuse(event, "task-closed", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        if (!admissibleTask(taskCapacity)) {
          refuse(event, "unknown-task", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        if (
          taskCapacity.seenAttemptIndices[String(event.facts.attemptIndex)] !== undefined
          || event.facts.attemptIndex <= taskCapacity.highestAttemptIndex
        ) {
          refuse(event, "attempt-identity-regressing", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        if (
          event.derivation.contractGeneration === "today"
          && "requestId" in event.facts
        ) {
          if (!registerRequestIdBinding(
            state,
            event.derivation.chainId,
            event.facts.requestId,
            {
              taskId: event.facts.taskId,
              attemptIndex: event.facts.attemptIndex,
              role: "task-attempt",
            },
          )) {
            refuse(event, "request-id-reused", event.facts.taskId, event.facts.attemptIndex);
            break;
          }
        }
        // Today has no release/expiry; every chain claim remains a monotonic occupancy fact.
        taskCapacity.seenAttemptIndices[String(event.facts.attemptIndex)] = true;
        taskCapacity.liveAttemptIndices[String(event.facts.attemptIndex)] = true;
        taskCapacity.highestAttemptIndex = event.facts.attemptIndex;
        const attempt = attemptFor(event, event.facts.taskId, event.facts.attemptIndex);
        state.attemptEngagements[attempt] = {
          taskId: event.facts.taskId,
          attemptIndex: event.facts.attemptIndex,
          operator: event.facts.operator,
          priorityMech: event.facts.priorityMech,
          deliveryRate: event.facts.deliveryRate,
          generation: event.derivation.contractGeneration,
          status: "live",
        };
        const effectiveDeadline = "attemptDeadline" in event.facts
          ? unixSecondsToRfc3339(event.facts.attemptDeadline)
          : event.projection.effectiveDeadline;
        emit(
          event,
          "network.jinn.task-execution.attempt-engaged.v1",
          attempt,
          {
            attempt,
            task: event.projection.taskDigest,
            submission: event.projection.submission,
            executor: event.facts.operator,
            effectiveDeadline,
            source: sourceFor(event),
            dispatchContext: event.projection.dispatchContext,
            annotations: {
              contractGeneration: event.derivation.contractGeneration,
              ...(event.derivation.contractGeneration === "today"
                && "requestId" in event.facts
                ? { requestId: event.facts.requestId }
                : {
                    engagement: {
                      taskId: event.facts.taskId.toString(),
                      attemptIndex: event.facts.attemptIndex,
                      kind: "solution",
                    },
                  }),
            },
          },
        );

        if (admissibleTask(taskCapacity)) {
          const wasOpen = taskCapacity.availability === "open";
          taskCapacity.availability = updateAvailability(taskCapacity);
          if (wasOpen && taskCapacity.availability === "closed") {
            emit(
              event,
              "network.jinn.task-execution.submission-closed.v1",
              event.projection.submission,
              { reason: "capacity" },
            );
          }
        }
        break;
      }

      case "SolutionDeliveryPrepared": {
        const attempt = attemptFor(
          event,
          event.facts.taskId,
          event.facts.attemptIndex,
        );
        const engagement = state.attemptEngagements[attempt];
        if (
          engagement === undefined
          || engagement.generation !== "revised"
          || !sameAddress(engagement.operator, event.facts.operator)
        ) {
          refuse(
            event,
            "attempt-not-live",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (engagement.preparedRequestId !== undefined) {
          refuse(
            event,
            "attempt-already-prepared",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (engagement.status !== "live") {
          refuse(
            event,
            "attempt-not-live",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        const preparation = receiptPosition(event.derivation);
        if (preparation === undefined) {
          refuse(
            event,
            "receipt-continuity-mismatch",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (!registerRequestIdBinding(
          state,
          event.derivation.chainId,
          event.facts.expectedRequestId,
          {
            taskId: event.facts.taskId,
            attemptIndex: event.facts.attemptIndex,
            role: "solution-preparation",
            kind: "solution",
            party: event.facts.operator,
            priorityMech: engagement.priorityMech,
            deliveryRate: engagement.deliveryRate,
            deliveryDigest: event.facts.deliveryDigest,
            verdictCode: 0,
            nonce: event.facts.nonce,
            preparation,
            status: "prepared",
          },
        )) {
          refuse(
            event,
            "request-id-reused",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        engagement.preparedRequestId = event.facts.expectedRequestId;
        engagement.status = "prepared";
        break;
      }

      case "VerdictDeliveryPrepared": {
        const key = evaluationEngagementKey(
          event,
          event.facts.taskId,
          event.facts.attemptIndex,
          event.facts.verdictIndex,
        );
        const engagement = state.evaluationEngagements[key];
        if (
          engagement === undefined
          || engagement.generation !== "revised"
          || !sameAddress(engagement.evaluator, event.facts.evaluator)
        ) {
          refuse(
            event,
            "attempt-not-live",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (engagement.preparedRequestId !== undefined) {
          refuse(
            event,
            "attempt-already-prepared",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (engagement.status !== "live") {
          refuse(
            event,
            "attempt-not-live",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        const preparation = receiptPosition(event.derivation);
        if (preparation === undefined) {
          refuse(
            event,
            "receipt-continuity-mismatch",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (!registerRequestIdBinding(
          state,
          event.derivation.chainId,
          event.facts.expectedRequestId,
          {
            taskId: event.facts.taskId,
            attemptIndex: event.facts.attemptIndex,
            verdictIndex: event.facts.verdictIndex,
            role: "verdict-preparation",
            kind: "verdict",
            party: event.facts.evaluator,
            priorityMech: engagement.priorityMech,
            deliveryRate: engagement.deliveryRate,
            deliveryDigest: event.facts.deliveryDigest,
            verdictCode: event.facts.verdictCode,
            nonce: event.facts.nonce,
            preparation,
            status: "prepared",
          },
        )) {
          refuse(
            event,
            "request-id-reused",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        engagement.preparedRequestId = event.facts.expectedRequestId;
        engagement.status = "prepared";
        break;
      }

      case "Deliver": {
        const pendingKey = pendingDeliveryKey(event, event.facts.requestId);
        const bindingKey = requestIdBindingKey(
          event.derivation.chainId,
          event.facts.requestId,
        );
        const existingBinding = state.requestIdBindings[bindingKey];
        if (existingBinding?.status === "forfeited") {
          refuse(
            event,
            "engagement-forfeited",
            existingBinding.taskId,
            existingBinding.attemptIndex,
          );
          break;
        }
        if ("requestData" in event.facts) {
          let decoded;
          try {
            decoded = decodeRevisedRequestData(event.facts.requestData);
          } catch {
            refuse(event, "deliver-request-data-invalid", 0n);
            break;
          }
          const binding = state.requestIdBindings[bindingKey];
          const deliveryReceipt = receiptPosition(event.derivation);
          const kind = decoded.legKind === REVISED_LEG_SOLUTION
            ? "solution"
            : decoded.legKind === REVISED_LEG_VERDICT
              ? "verdict"
              : undefined;
          if (
            binding === undefined
            || binding.status !== "prepared"
            || binding.kind !== kind
            || binding.taskId !== decoded.taskId
            || binding.attemptIndex !== decoded.attemptIndex
            || (binding.verdictIndex ?? 0) !== decoded.verdictIndex
            || binding.deliveryDigest !== decoded.deliveryDigest
            || (binding.verdictCode ?? 0) !== decoded.verdictCode
            || binding.priorityMech === undefined
            || !sameAddress(binding.priorityMech, event.facts.mech)
            || binding.party === undefined
            || !sameAddress(binding.party, event.facts.mechServiceMultisig)
            || binding.deliveryRate !== event.facts.deliveryRate
          ) {
            refuse(
              event,
              "deliver-request-data-mismatch",
              decoded.taskId,
              decoded.attemptIndex,
            );
            break;
          }
          const attempt = attemptFor(event, decoded.taskId, decoded.attemptIndex);
          const engagement = kind === "solution"
            ? state.attemptEngagements[attempt]
            : undefined;
          const evaluation = kind === "verdict"
            ? state.evaluationEngagements[evaluationEngagementKey(
              event,
              decoded.taskId,
              decoded.attemptIndex,
              decoded.verdictIndex,
            )]
            : undefined;
          if (
            (kind === "solution" && !isDeliverableAttemptEngagement(engagement))
            || (kind === "verdict" && !isDeliverableEvaluationEngagement(evaluation))
          ) {
            refuse(
              event,
              engagement?.status === "forfeited" || evaluation?.status === "forfeited"
                ? "engagement-forfeited"
                : "attempt-not-live",
              decoded.taskId,
              decoded.attemptIndex,
            );
            break;
          }
          if (
            deliveryReceipt === undefined
            || !followsInSameReceipt(binding.preparation, event.derivation)
          ) {
            refuse(
              event,
              "receipt-continuity-mismatch",
              decoded.taskId,
              decoded.attemptIndex,
            );
            break;
          }
          binding.status = "delivered";
          state.pendingMechDeliveries[pendingKey] = {
            data: event.facts.deliveryData,
            requestData: event.facts.requestData,
            receipt: deliveryReceipt,
            ...(event.projection.deliveryCorrespondence === undefined
              ? {}
              : {
                  deliveryCorrespondence:
                    event.projection.deliveryCorrespondence,
                }),
          };
          break;
        }
        if (
          existingBinding !== undefined
          && bindingContractGeneration(existingBinding) === "revised"
        ) {
          refuse(
            event,
            "deliver-request-data-invalid",
            existingBinding.taskId,
            existingBinding.attemptIndex,
          );
          break;
        }
        state.pendingMechDeliveries[pendingKey] = {
          data: event.facts.data,
          ...(event.projection.deliveryCorrespondence === undefined
            ? {}
            : {
                deliveryCorrespondence:
                  event.projection.deliveryCorrespondence,
              }),
        };
        break;
      }

      case "SolutionDeliveryClaimed": {
        const task = state.tasks[taskKey(event, event.facts.taskId)];
        if (task?.admission === "rejected") {
          refuse(event, "task-not-admissible", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        const attempt = attemptFor(event, event.facts.taskId, event.facts.attemptIndex);
        const engagement = state.attemptEngagements[attempt];
        const authoritativeGeneration = taskContractGeneration(task)
          ?? engagement?.generation;
        if (
          authoritativeGeneration === "revised"
          && !("deliveryDigest" in event.facts)
        ) {
          refuse(
            event,
            "reservation-not-delivered",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (engagement?.status === "forfeited") {
          refuse(
            event,
            "engagement-forfeited",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (
          authoritativeGeneration === "revised"
          && !admissibleTask(task)
        ) {
          refuse(
            event,
            "unknown-task",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        const pendingKey = pendingDeliveryKey(event, event.facts.requestId);
        const mechDelivery = state.pendingMechDeliveries[pendingKey];
        const binding = state.requestIdBindings[
          requestIdBindingKey(event.derivation.chainId, event.facts.requestId)
        ];
        if (binding?.status === "forfeited") {
          refuse(
            event,
            "engagement-forfeited",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (
          "deliveryDigest" in event.facts
          && (
            mechDelivery === undefined
            || mechDelivery.requestData === undefined
            || binding === undefined
            || binding.role !== "solution-preparation"
            || binding.status !== "delivered"
            || binding.taskId !== event.facts.taskId
            || binding.attemptIndex !== event.facts.attemptIndex
            || binding.deliveryDigest !== event.facts.deliveryDigest
            || binding.party === undefined
            || !sameAddress(binding.party, event.facts.operator)
          )
        ) {
          refuse(
            event,
            "reservation-not-delivered",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (
          "deliveryDigest" in event.facts
          && (
            !followsInSameReceipt(binding?.preparation, event.derivation)
            || !followsInSameReceipt(mechDelivery?.receipt, event.derivation)
          )
        ) {
          refuse(
            event,
            "receipt-continuity-mismatch",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (mechDelivery === undefined) {
          // Defect #48. Role-aware, and deliberately additive: the mech-fact requirement below is
          // untouched for every producer that can actually witness a Mech `Deliver`. Only a host
          // that resolved the published Delivery record off the record plane AND re-derived its
          // digests locally supplies `recordPlaneDelivery`, and only a REQUESTER host does that
          // (see `ObservationProjectionContext.recordPlaneDelivery`). Emitting the old
          // `rejected`/`invalid-reference` terminal there was a false rejection of a delivery the
          // coordinator itself settled, and -- landing beside the verdict's own terminal -- folded
          // the Attempt `contradictory`, which `adoptPostedTask` refuses outright.
          const recordPlane = event.projection.recordPlaneDelivery;
          if (recordPlane !== undefined) {
            // Re-check the anchor here rather than trusting the host's own comparison: this is the
            // same posture the today-mode mech branch takes with `checkDeliveryCorrespondence`.
            // Only the keccak leg exists requester-side -- today's sha256 anchor lives solely in
            // the Mech `Deliver` payload -- so this is the whole on-chain binding available, and
            // it binds the exact bytes: `solutionCidDigest` is keccak256 over the sealed Delivery.
            if (
              !sameHex(recordPlane.keccakEvidenceHash, recordPlane.onChainKeccak)
              || isZeroHash(recordPlane.onChainKeccak)
            ) {
              emit(
                event,
                "network.jinn.task-execution.attempt-terminal.v1",
                attempt,
                {
                  state: "rejected",
                  category: "content-corruption",
                  detail: "record-plane Delivery does not hash to the coordinator's solution anchor",
                },
              );
              break;
            }
            emit(
              event,
              "network.jinn.task-execution.delivery-recorded.v1",
              attempt,
              { digest: recordPlane.sha256Digest },
            );
            break;
          }
          emit(
            event,
            "network.jinn.task-execution.attempt-terminal.v1",
            attempt,
            {
              state: "rejected",
              category: "invalid-reference",
              detail: "no external Mech Deliver fact for router requestId",
            },
          );
          break;
        }
        delete state.pendingMechDeliveries[pendingKey];

        if ("deliveryDigest" in event.facts) {
          if (binding !== undefined) binding.status = "claimed";
          if (admissibleTask(task)) {
            delete task.liveAttemptIndices[String(event.facts.attemptIndex)];
            task.availability = updateAvailability(task);
          }
          const engagement = state.attemptEngagements[attempt];
          if (engagement !== undefined) engagement.status = "submitted";
          emit(
            event,
            "network.jinn.task-execution.delivery-recorded.v1",
            attempt,
            { digest: digestFromBytes32(event.facts.deliveryDigest) },
          );
          break;
        }

        const correspondence = mechDelivery.deliveryCorrespondence;
        const mechDigest = mechDelivery.data.length === 66
          ? digestFromBytes32(mechDelivery.data)
          : undefined;
        const checked = correspondence === undefined
          ? undefined
          : checkDeliveryCorrespondence(correspondence);
        if (
          correspondence === undefined
          || mechDigest !== correspondence.onChainSha256CidDigest
          || checked?.ok !== true
        ) {
          emit(
            event,
            "network.jinn.task-execution.attempt-terminal.v1",
            attempt,
            {
              state: "rejected",
              category: "content-corruption",
              detail: "today-mode sha256↔keccak correspondence failed",
            },
          );
          break;
        }
        emit(
          event,
          "network.jinn.task-execution.delivery-recorded.v1",
          attempt,
          { digest: correspondence.sha256Digest },
        );
        break;
      }

      case "VerdictDeliveryClaimed": {
        const task = state.tasks[taskKey(event, event.facts.taskId)];
        if (task?.admission === "rejected") {
          refuse(event, "task-not-admissible", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        const evaluation = state.evaluationEngagements[
          evaluationEngagementKey(
            event,
            event.facts.taskId,
            event.facts.attemptIndex,
            event.facts.verdictIndex,
          )
        ];
        const authoritativeGeneration = taskContractGeneration(task)
          ?? evaluation?.generation;
        if (
          authoritativeGeneration === "revised"
          && !("evaluationDeliveryDigest" in event.facts)
        ) {
          refuse(
            event,
            "reservation-not-delivered",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (evaluation?.status === "forfeited") {
          refuse(
            event,
            "engagement-forfeited",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (authoritativeGeneration === "revised") {
          const pendingKey = pendingDeliveryKey(event, event.facts.requestId);
          const mechDelivery = state.pendingMechDeliveries[pendingKey];
          const binding = state.requestIdBindings[
            requestIdBindingKey(event.derivation.chainId, event.facts.requestId)
          ];
          if (binding?.status === "forfeited") {
            refuse(
              event,
              "engagement-forfeited",
              event.facts.taskId,
              event.facts.attemptIndex,
            );
            break;
          }
          if (
            !("evaluationDeliveryDigest" in event.facts)
            || mechDelivery?.requestData === undefined
            || binding === undefined
            || binding.role !== "verdict-preparation"
            || binding.status !== "delivered"
            || binding.taskId !== event.facts.taskId
            || binding.attemptIndex !== event.facts.attemptIndex
            || binding.verdictIndex !== event.facts.verdictIndex
            || binding.deliveryDigest !== event.facts.evaluationDeliveryDigest
            || binding.verdictCode !== event.facts.verdictCode
            || binding.party === undefined
            || !sameAddress(binding.party, event.facts.evaluator)
          ) {
            refuse(
              event,
              "reservation-not-delivered",
              event.facts.taskId,
              event.facts.attemptIndex,
            );
            break;
          }
          if (
            !followsInSameReceipt(binding.preparation, event.derivation)
            || !followsInSameReceipt(mechDelivery.receipt, event.derivation)
          ) {
            refuse(
              event,
              "receipt-continuity-mismatch",
              event.facts.taskId,
              event.facts.attemptIndex,
            );
            break;
          }
          delete state.pendingMechDeliveries[pendingKey];
          binding.status = "claimed";
          if (evaluation !== undefined) evaluation.status = "delivered";
        }
        if (admissibleTask(task)) {
          task.terminalCause ??= "finalized";
          task.availability = "closed";
        }
        const attempt = attemptFor(event, event.facts.taskId, event.facts.attemptIndex);
        emit(
          event,
          "network.jinn.task-execution.attempt-terminal.v1",
          attempt,
          verdictTerminal(event.facts.verdictCode),
        );
        emit(
          event,
          "network.jinn.task-execution.submission-closed.v1",
          event.projection.submission,
          { reason: "capacity" },
        );
        break;
      }

      case "AttemptExpired": {
        const key = taskKey(event, event.facts.taskId);
        const taskCapacity = state.tasks[key];
        if (taskCapacity?.admission === "rejected") {
          refuse(event, "task-not-admissible", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        if (!admissibleTask(taskCapacity)) {
          refuse(event, "unknown-task", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        if (taskCapacity.liveAttemptIndices[String(event.facts.attemptIndex)] === undefined) {
          refuse(event, "attempt-not-live", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        const wasClosed = taskCapacity.availability === "closed";
        delete taskCapacity.liveAttemptIndices[String(event.facts.attemptIndex)];
        const expiredAttempt = state.attemptEngagements[
          attemptFor(event, event.facts.taskId, event.facts.attemptIndex)
        ];
        if (expiredAttempt !== undefined) expiredAttempt.status = "expired";
        taskCapacity.availability = updateAvailability(taskCapacity);
        if (wasClosed && taskCapacity.availability === "open" && taskCapacity.terminalCause === undefined && taskCapacity.requesterClosed !== true) availabilityOpenedLogIds.push(identity);
        emit(
          event,
          "network.jinn.task-execution.attempt-terminal.v1",
          attemptFor(event, event.facts.taskId, event.facts.attemptIndex),
          { state: "expired" },
        );
        break;
      }

      case "AttemptReleased": {
        const key = taskKey(event, event.facts.taskId);
        const taskCapacity = state.tasks[key];
        if (taskCapacity?.admission === "rejected") {
          refuse(event, "task-not-admissible", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        if (!admissibleTask(taskCapacity)) {
          refuse(event, "unknown-task", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        if (taskCapacity.liveAttemptIndices[String(event.facts.attemptIndex)] === undefined) {
          refuse(event, "attempt-not-live", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        const wasClosed = taskCapacity.availability === "closed";
        delete taskCapacity.liveAttemptIndices[String(event.facts.attemptIndex)];
        const releasedAttempt = state.attemptEngagements[
          attemptFor(event, event.facts.taskId, event.facts.attemptIndex)
        ];
        if (releasedAttempt !== undefined) releasedAttempt.status = "released";
        taskCapacity.availability = updateAvailability(taskCapacity);
        if (wasClosed && taskCapacity.availability === "open" && taskCapacity.terminalCause === undefined && taskCapacity.requesterClosed !== true) availabilityOpenedLogIds.push(identity);
        emit(
          event,
          "network.jinn.task-execution.attempt-terminal.v1",
          attemptFor(event, event.facts.taskId, event.facts.attemptIndex),
          { state: "cancelled" },
        );
        break;
      }

      case "AttemptForfeited": {
        const task = state.tasks[taskKey(event, event.facts.taskId)];
        if (!admissibleTask(task)) {
          refuse(
            event,
            task?.admission === "rejected"
              ? "task-not-admissible"
              : "unknown-task",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        const attempt = attemptFor(
          event,
          event.facts.taskId,
          event.facts.attemptIndex,
        );
        const engagement = state.attemptEngagements[attempt];
        if (
          engagement === undefined
          || (
            engagement.status !== "live"
            && engagement.status !== "prepared"
          )
          || !sameAddress(engagement.operator, event.facts.operator)
        ) {
          refuse(
            event,
            "attempt-not-live",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        const hadDeliveredBinding = forfeitPreparedOrDeliveredBindings(
          state,
          event.derivation.chainId,
          (binding) =>
            binding.taskId === event.facts.taskId
            && binding.attemptIndex === event.facts.attemptIndex
            && binding.kind === "solution",
        );
        delete task.liveAttemptIndices[String(event.facts.attemptIndex)];
        task.availability = updateAvailability(task);
        engagement.status = "forfeited";
        if (!hadDeliveredBinding) {
          for (const binding of Object.values(state.requestIdBindings)) {
            if (
              binding.taskId === event.facts.taskId
              && binding.attemptIndex === event.facts.attemptIndex
              && binding.kind === "solution"
            ) {
              binding.forfeitTerminalEmitted = true;
            }
          }
          emit(
            event,
            "network.jinn.task-execution.attempt-terminal.v1",
            attempt,
            {
              state: "failed",
              category: "result-unavailable",
              detail: "delivery reservation forfeited",
            },
          );
        }
        break;
      }

      case "VerdictForfeited": {
        const engagement = state.evaluationEngagements[
          evaluationEngagementKey(
            event,
            event.facts.taskId,
            event.facts.attemptIndex,
            event.facts.verdictIndex,
          )
        ];
        if (
          engagement === undefined
          || (
            engagement.status !== "live"
            && engagement.status !== "prepared"
          )
          || !sameAddress(engagement.evaluator, event.facts.evaluator)
        ) {
          refuse(
            event,
            "attempt-not-live",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        forfeitPreparedOrDeliveredBindings(
          state,
          event.derivation.chainId,
          (binding) =>
            binding.taskId === event.facts.taskId
            && binding.attemptIndex === event.facts.attemptIndex
            && binding.verdictIndex === event.facts.verdictIndex
            && binding.kind === "verdict",
        );
        engagement.status = "forfeited";
        break;
      }

      case "ReservationForfeited": {
        const bindingKey = requestIdBindingKey(
          event.derivation.chainId,
          event.facts.requestId,
        );
        const binding = state.requestIdBindings[bindingKey];
        const expectedKind = event.facts.legKind === REVISED_LEG_SOLUTION
          ? "solution"
          : event.facts.legKind === REVISED_LEG_VERDICT
            ? "verdict"
            : undefined;
        if (
          binding === undefined
          || binding.kind !== expectedKind
          || binding.taskId !== event.facts.taskId
          || binding.attemptIndex !== event.facts.attemptIndex
          || (binding.verdictIndex ?? 0) !== event.facts.verdictIndex
          || binding.deliveryRate !== event.facts.rate
        ) {
          refuse(
            event,
            "reservation-not-delivered",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        if (binding.status === "forfeited") {
          if (binding.forfeitTerminalEmitted === true) {
            break;
          }
          if (expectedKind !== "solution") {
            const evaluation = state.evaluationEngagements[
              evaluationEngagementKey(
                event,
                event.facts.taskId,
                event.facts.attemptIndex,
                event.facts.verdictIndex,
              )
            ];
            if (evaluation !== undefined) evaluation.status = "forfeited";
            binding.forfeitTerminalEmitted = true;
            break;
          }
          const task = state.tasks[taskKey(event, event.facts.taskId)];
          if (!admissibleTask(task)) {
            refuse(
              event,
              task?.admission === "rejected"
                ? "task-not-admissible"
                : "unknown-task",
              event.facts.taskId,
              event.facts.attemptIndex,
            );
            break;
          }
          const attempt = attemptFor(
            event,
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          delete task.liveAttemptIndices[String(event.facts.attemptIndex)];
          task.availability = updateAvailability(task);
          const engagement = state.attemptEngagements[attempt];
          if (engagement !== undefined) engagement.status = "forfeited";
          binding.forfeitTerminalEmitted = true;
          emit(
            event,
            "network.jinn.task-execution.attempt-terminal.v1",
            attempt,
            {
              state: "failed",
              category: "result-unavailable",
              detail: "delivery reservation forfeited",
            },
          );
          break;
        }
        if (
          binding.status !== "delivered"
          || state.pendingMechDeliveries[
            pendingDeliveryKey(event, event.facts.requestId)
          ] === undefined
        ) {
          refuse(
            event,
            "reservation-not-delivered",
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          break;
        }
        binding.status = "forfeited";
        delete state.pendingMechDeliveries[
          pendingDeliveryKey(event, event.facts.requestId)
        ];
        if (expectedKind === "solution") {
          const task = state.tasks[taskKey(event, event.facts.taskId)];
          if (!admissibleTask(task)) {
            refuse(
              event,
              task?.admission === "rejected"
                ? "task-not-admissible"
                : "unknown-task",
              event.facts.taskId,
              event.facts.attemptIndex,
            );
            break;
          }
          const attempt = attemptFor(
            event,
            event.facts.taskId,
            event.facts.attemptIndex,
          );
          delete task.liveAttemptIndices[String(event.facts.attemptIndex)];
          task.availability = updateAvailability(task);
          const engagement = state.attemptEngagements[attempt];
          if (engagement !== undefined) engagement.status = "forfeited";
          binding.forfeitTerminalEmitted = true;
          emit(
            event,
            "network.jinn.task-execution.attempt-terminal.v1",
            attempt,
            {
              state: "failed",
              category: "result-unavailable",
              detail: "delivery reservation forfeited",
            },
          );
        } else {
          const evaluation = state.evaluationEngagements[
            evaluationEngagementKey(
              event,
              event.facts.taskId,
              event.facts.attemptIndex,
              event.facts.verdictIndex,
            )
          ];
          if (evaluation !== undefined) evaluation.status = "forfeited";
          binding.forfeitTerminalEmitted = true;
        }
        break;
      }

      case "TaskBudgetRefunded": {
        const task = state.tasks[taskKey(event, event.facts.taskId)];
        if (task?.admission === "rejected") {
          refuse(event, "task-not-admissible", event.facts.taskId);
          break;
        }
        if (admissibleTask(task)) {
          task.terminalCause ??= "refunded";
          task.availability = "closed";
        }
        emit(
          event,
          "network.jinn.task-execution.submission-closed.v1",
          event.projection.submission,
          { reason: "requester-close" },
        );
        break;
      }

      case "TaskClosed": {
        const key = taskKey(event, event.facts.taskId);
        const task = state.tasks[key];
        if (task?.admission === "rejected") {
          refuse(event, "task-not-admissible", event.facts.taskId);
          break;
        }
        if (admissibleTask(task)) {
          task.terminalCause ??= "requester-closed";
          task.requesterClosed = true;
          task.availability = "closed";
        }
        emit(
          event,
          "network.jinn.task-execution.submission-closed.v1",
          event.projection.submission,
          { reason: "requester-close" },
        );
        break;
      }

      case "AttemptsAdded": {
        const key = taskKey(event, event.facts.taskId);
        const existing = state.tasks[key];
        if (existing?.admission === "rejected") {
          refuse(event, "task-not-admissible", event.facts.taskId);
          break;
        }
        if (!admissibleTask(existing)) {
          refuse(event, "unknown-task", event.facts.taskId);
          break;
        }
        if (existing.terminalCause !== undefined || existing.requesterClosed === true) {
          refuse(event, "task-closed", event.facts.taskId);
          break;
        }
        if (
          event.facts.newMaxTotal <= existing.maxTotal
          || event.facts.newMaxTotal - existing.maxTotal !== event.facts.added
        ) {
          refuse(event, "capacity-contradiction", event.facts.taskId);
          break;
        }
        const wasClosed = existing.availability === "closed";
        existing.maxTotal = event.facts.newMaxTotal;
        existing.availability = updateAvailability(existing);
        if (wasClosed && existing.availability === "open") availabilityOpenedLogIds.push(identity);
        break;
      }

      // Evaluation execution is projected by the M5 requester-sealed evaluation leg. This
      // on-chain event alone does not carry the distinct evaluation Task/Submission identities.
      case "EvaluationAttemptCreated": {
        const key = taskKey(event, event.facts.taskId);
        const task = state.tasks[key];
        if (task?.admission === "rejected") {
          refuse(event, "task-not-admissible", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        if (!admissibleTask(task)) {
          refuse(event, "unknown-task", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        if (task.terminalCause !== undefined || task.requesterClosed === true) {
          refuse(event, "task-closed", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        const parentAttempt = state.attemptEngagements[
          attemptFor(event, event.facts.taskId, event.facts.attemptIndex)
        ];
        const parentIsEligible = event.derivation.contractGeneration === "revised"
          ? parentAttempt?.status === "submitted"
          : task.liveAttemptIndices[String(event.facts.attemptIndex)] !== undefined;
        if (!parentIsEligible) {
          refuse(event, "attempt-not-live", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        const evaluationParent = evaluationParentKey(
          event,
          event.facts.taskId,
          event.facts.attemptIndex,
        );
        if (evaluationVerdictIdentityRefused(
          state,
          evaluationParent,
          event.facts.verdictIndex,
        )) {
          refuse(event, "attempt-identity-regressing", event.facts.taskId, event.facts.attemptIndex);
          break;
        }
        if (
          event.derivation.contractGeneration === "today"
          && "requestId" in event.facts
        ) {
          if (!registerRequestIdBinding(
            state,
            event.derivation.chainId,
            event.facts.requestId,
            {
              taskId: event.facts.taskId,
              attemptIndex: event.facts.attemptIndex,
              role: "evaluation-attempt",
              verdictIndex: event.facts.verdictIndex,
            },
          )) {
            refuse(event, "request-id-reused", event.facts.taskId, event.facts.attemptIndex);
            break;
          }
        }
        registerEvaluationVerdictIdentity(
          state,
          evaluationParent,
          event.facts.verdictIndex,
        );
        state.evaluationEngagements[evaluationEngagementKey(
          event,
          event.facts.taskId,
          event.facts.attemptIndex,
          event.facts.verdictIndex,
        )] = {
          taskId: event.facts.taskId,
          attemptIndex: event.facts.attemptIndex,
          verdictIndex: event.facts.verdictIndex,
          evaluator: event.facts.evaluator,
          priorityMech: event.facts.priorityMech,
          deliveryRate: event.facts.deliveryRate,
          generation: event.derivation.contractGeneration,
          status: "live",
        };
        break;
      }
    }
    if (!eventRefused) acceptedEvents.push(event);
  }

  return {
    state,
    events: acceptedEvents,
    observations,
    availabilityOpenedLogIds,
    refusals,
  };
}

/**
 * Stateless convenience for one complete ordered log. Incremental hosts must retain the
 * transition state from `reduceMarketplaceProjection`; this wrapper intentionally does not hide
 * state behind module globals.
 */
export function projectObservations(
  events: readonly ObservationMarketplaceEvent[],
  state: MarketplaceProjectionState = createMarketplaceProjectionState(),
): MarketplaceProtocolObservation[] {
  return reduceMarketplaceProjection(events, state).observations;
}
