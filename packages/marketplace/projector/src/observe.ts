// SPDX-License-Identifier: MIT

import {
  checkDeliveryCorrespondence,
  deriveMarketplaceAttemptUri,
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

interface PendingMechDelivery {
  readonly data: Hex;
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
  /** `TaskClosed` is monotonic and dominates capacity reopening. */
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
    | "attempt-not-live"
    | "capacity-contradiction";
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
    if (task.requesterClosed === true) return "closed";
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
        if (event.derivation.contractGeneration === "revised") {
          if (taskCapacity?.admission === "rejected") {
            refuse(event, "task-not-admissible", event.facts.taskId, event.facts.attemptIndex);
            break;
          }
          if (!admissibleTask(taskCapacity)) {
            refuse(event, "unknown-task", event.facts.taskId, event.facts.attemptIndex);
            break;
          }
          if (taskCapacity.requesterClosed === true) {
            refuse(event, "task-closed", event.facts.taskId, event.facts.attemptIndex);
            break;
          }
          if (
            taskCapacity.seenAttemptIndices[String(event.facts.attemptIndex)] !== undefined
            || event.facts.attemptIndex <= taskCapacity.highestAttemptIndex
          ) {
            refuse(event, "attempt-identity-regressing", event.facts.taskId, event.facts.attemptIndex);
            break;
          }
          taskCapacity.seenAttemptIndices[String(event.facts.attemptIndex)] = true;
          taskCapacity.liveAttemptIndices[String(event.facts.attemptIndex)] = true;
          taskCapacity.highestAttemptIndex = event.facts.attemptIndex;
        } else if (admissibleTask(taskCapacity)) {
          // Today has no release/expiry; every chain claim remains a monotonic occupancy fact.
          taskCapacity.seenAttemptIndices[String(event.facts.attemptIndex)] = true;
          taskCapacity.liveAttemptIndices[String(event.facts.attemptIndex)] = true;
          taskCapacity.highestAttemptIndex = Math.max(taskCapacity.highestAttemptIndex, event.facts.attemptIndex);
        }
        const attempt = attemptFor(event, event.facts.taskId, event.facts.attemptIndex);
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
              requestId: event.facts.requestId,
              contractGeneration: event.derivation.contractGeneration,
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

      case "Deliver": {
        state.pendingMechDeliveries[
          pendingDeliveryKey(event, event.facts.requestId)
        ] = {
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
        const attempt = attemptFor(event, event.facts.taskId, event.facts.attemptIndex);
        const pendingKey = pendingDeliveryKey(event, event.facts.requestId);
        const mechDelivery = state.pendingMechDeliveries[pendingKey];
        if (mechDelivery === undefined) {
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
        taskCapacity.availability = updateAvailability(taskCapacity);
        if (wasClosed && taskCapacity.availability === "open" && taskCapacity.requesterClosed !== true) availabilityOpenedLogIds.push(identity);
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
        taskCapacity.availability = updateAvailability(taskCapacity);
        if (wasClosed && taskCapacity.availability === "open" && taskCapacity.requesterClosed !== true) availabilityOpenedLogIds.push(identity);
        emit(
          event,
          "network.jinn.task-execution.attempt-terminal.v1",
          attemptFor(event, event.facts.taskId, event.facts.attemptIndex),
          { state: "cancelled" },
        );
        break;
      }

      case "TaskBudgetRefunded":
        emit(
          event,
          "network.jinn.task-execution.submission-closed.v1",
          event.projection.submission,
          { reason: "requester-close" },
        );
        break;

      case "TaskClosed": {
        const key = taskKey(event, event.facts.taskId);
        const task = state.tasks[key];
        if (task?.admission === "rejected") {
          refuse(event, "task-not-admissible", event.facts.taskId);
          break;
        }
        if (admissibleTask(task)) {
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
        if (existing.requesterClosed === true) {
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
      case "EvaluationAttemptCreated":
        break;
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
