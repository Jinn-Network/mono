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

export interface MarketplaceProjectionState {
  /** Canonical chain-log identities already reduced, in first-seen order. */
  processedLogIds: string[];
  /** Idempotency keys for append-only reorg corrections already emitted. */
  processedCorrectionIds: string[];
  /** Last emitted sequence by authoritative `(source, subject)` observation stream. */
  sequenceBySourceSubject: Record<string, string>;
  /** Task-capacity facts required to detect exhaustion across host callback boundaries. */
  tasks: Record<string, { maxTotal: number; engaged: number }>;
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
        { ...value },
      ]),
    ),
    pendingMechDeliveries: Object.fromEntries(
      Object.entries(state.pendingMechDeliveries).map(([key, value]) => [
        key,
        {
          data: value.data,
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
    coordinator: event.derivation.contract,
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

function taskKey(event: ObservationMarketplaceEvent, taskId: bigint): string {
  return `${event.derivation.chainId}:${event.derivation.contract.toLowerCase()}:${taskId}`;
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
} {
  switch (verdictCode) {
    case 1:
      return { state: "delivered" };
    case 2:
      return { state: "rejected", category: "verdict-fail" };
    case 3:
      return { state: "failed", category: "verdict-invalid" };
    case 4:
      return { state: "failed", category: "verdict-unresolved" };
    default:
      return { state: "rejected", category: "verdict-code-invalid" };
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
  const processed = new Set(state.processedLogIds);

  function emit(
    event: ObservationMarketplaceEvent,
    type: ProtocolObservation["type"],
    subject: string,
    data: Record<string, unknown>,
  ): void {
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

  for (const event of events) {
    const identity = logIdentity(event);
    if (processed.has(identity)) continue;
    processed.add(identity);
    state.processedLogIds.push(identity);
    acceptedEvents.push(event);

    switch (event.event) {
      case "TaskCreated": {
        const anchoredTaskDigest = digestFromBytes32(event.facts.taskCidDigest);
        const key = taskKey(event, event.facts.taskId);
        const maxTotal = "maxClaims" in event.facts
          ? event.facts.maxClaims
          : event.facts.maxTotal;
        state.tasks[key] = { maxTotal, engaged: 0 };

        if (anchoredTaskDigest !== event.projection.taskDigest) {
          emit(
            event,
            "network.jinn.task-execution.submission-rejected.v1",
            event.projection.submission,
            {
              category: "digest-divergence",
              detail: "TaskCreated task digest does not match resolved signed Submission task digest",
            },
          );
          break;
        }
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

        const key = taskKey(event, event.facts.taskId);
        const taskCapacity = state.tasks[key];
        if (taskCapacity !== undefined) {
          taskCapacity.engaged += 1;
          if (taskCapacity.engaged >= taskCapacity.maxTotal) {
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
              category: "delivery-join-missing",
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
              category: "digest-divergence",
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
        emit(
          event,
          "network.jinn.task-execution.attempt-terminal.v1",
          attemptFor(event, event.facts.taskId, event.facts.attemptIndex),
          { state: "expired" },
        );
        break;
      }

      case "AttemptReleased": {
        emit(
          event,
          "network.jinn.task-execution.attempt-terminal.v1",
          attemptFor(event, event.facts.taskId, event.facts.attemptIndex),
          { state: "cancelled" },
        );
        break;
      }

      case "TaskBudgetRefunded":
      case "TaskClosed":
        emit(
          event,
          "network.jinn.task-execution.submission-closed.v1",
          event.projection.submission,
          { reason: "requester-close" },
        );
        break;

      case "AttemptsAdded": {
        const key = taskKey(event, event.facts.taskId);
        const existing = state.tasks[key];
        state.tasks[key] = {
          maxTotal: event.facts.newMaxTotal,
          engaged: existing?.engaged ?? 0,
        };
        break;
      }

      // Evaluation execution is projected by the M5 requester-sealed evaluation leg. This
      // on-chain event alone does not carry the distinct evaluation Task/Submission identities.
      case "EvaluationAttemptCreated":
        break;
    }
  }

  return { state, events: acceptedEvents, observations };
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
