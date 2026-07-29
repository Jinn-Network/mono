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

type DeliverEvent = Extract<MarketplaceEvent, { event: "Deliver" }> & {
  readonly projection: ObservationProjectionContext;
};

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
export function projectObservations(
  events: readonly ObservationMarketplaceEvent[],
): ProtocolObservation[] {
  const observations: ProtocolObservation[] = [];
  const mechDeliveries = new Map<Hex, DeliverEvent>();
  const capacity = new Map<string, { maxTotal: number; engaged: number }>();

  function emit(
    event: ObservationMarketplaceEvent,
    type: ProtocolObservation["type"],
    subject: string,
    data: Record<string, unknown>,
  ): void {
    const observation = {
      specversion: "1.0",
      id: `${event.derivation.txHash}:${event.derivation.logIndex}:${type}`,
      source: sourceFor(event),
      subject,
      time: event.projection.timestamp,
      datacontenttype: "application/json",
      sequence: formatSequence(BigInt(observations.length + 1)),
      taskdigest: event.projection.taskDigest,
      type,
      data,
    } as ProtocolObservation;
    observations.push(observation);
  }

  for (const event of events) {
    switch (event.event) {
      case "TaskCreated": {
        const anchoredTaskDigest = digestFromBytes32(event.facts.taskCidDigest);
        const key = taskKey(event, event.facts.taskId);
        const maxTotal = "maxClaims" in event.facts
          ? event.facts.maxClaims
          : event.facts.maxTotal;
        capacity.set(key, { maxTotal, engaged: 0 });

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
        const taskCapacity = capacity.get(key);
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

      case "Deliver":
        mechDeliveries.set(event.facts.requestId, event as DeliverEvent);
        break;

      case "SolutionDeliveryClaimed": {
        const attempt = attemptFor(event, event.facts.taskId, event.facts.attemptIndex);
        const mechDelivery = mechDeliveries.get(event.facts.requestId);
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

        if ("deliveryDigest" in event.facts) {
          emit(
            event,
            "network.jinn.task-execution.delivery-recorded.v1",
            attempt,
            { digest: digestFromBytes32(event.facts.deliveryDigest) },
          );
          break;
        }

        const correspondence = mechDelivery.projection.deliveryCorrespondence;
        const mechDigest = mechDelivery.facts.data.length === 66
          ? digestFromBytes32(mechDelivery.facts.data)
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
        const existing = capacity.get(key);
        capacity.set(key, {
          maxTotal: event.facts.newMaxTotal,
          engaged: existing?.engaged ?? 0,
        });
        break;
      }

      // Evaluation execution is projected by the M5 requester-sealed evaluation leg. This
      // on-chain event alone does not carry the distinct evaluation Task/Submission identities.
      case "EvaluationAttemptCreated":
        break;
    }
  }

  return observations;
}
