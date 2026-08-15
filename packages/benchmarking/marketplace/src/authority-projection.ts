// SPDX-License-Identifier: MIT

import { deriveMarketplaceAttemptUri } from "@jinn-network/marketplace-binding";
import {
  createMarketplaceProjectionState,
  reduceMarketplaceProjection,
  selectCanonicalMarketplaceObservations,
  type MarketplaceProjectionState,
  type MarketplaceProtocolObservation,
  type ObservationMarketplaceEvent,
} from "@jinn-network/marketplace-projector";
import type { ProtocolObservation } from "@jinn-network/task-execution-protocol";
import type { CloseAnchorRef } from "./input-scope.js";
import { isValidBlockHash } from "./canonical-bytes.js";

export function isValidCloseAnchor(anchor: CloseAnchorRef): boolean {
  if (!/^eip155:\d+$/.test(anchor.chain)) return false;
  if (!Number.isSafeInteger(anchor.blockNumber) || anchor.blockNumber < 0) return false;
  return isValidBlockHash(anchor.blockHash);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function derivationOf(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const derivation = value.derivation;
  return isRecord(derivation) ? derivation : undefined;
}

function chainFromAnchor(anchor: CloseAnchorRef): string | undefined {
  const match = /^eip155:(\d+)$/.exec(anchor.chain);
  return match?.[1];
}

function orphanedHashSet(orphanedBlockHashes: ReadonlySet<string>): ReadonlySet<string> {
  return new Set([...orphanedBlockHashes].map((hash) => hash.toLowerCase()));
}

function blockHashIsOrphaned(
  blockHash: unknown,
  orphaned: ReadonlySet<string>,
): boolean {
  return typeof blockHash === "string" && orphaned.has(blockHash.toLowerCase());
}

/** True when an observation is finalized on or before the close anchor block. */
export function isObservationEligible(
  observation: ProtocolObservation | ObservationMarketplaceEvent,
  anchor: CloseAnchorRef,
): boolean {
  if (!isValidCloseAnchor(anchor)) return false;
  const derivation = derivationOf(observation);
  if (derivation === undefined) return false;
  if (derivation.finalityTier !== "finalized") return false;

  const expectedChainId = chainFromAnchor(anchor);
  if (expectedChainId === undefined) return false;
  const chainId = derivation.chainId;
  if (
    typeof chainId !== "number"
    || !Number.isFinite(chainId)
    || !Number.isInteger(chainId)
    || chainId < 0
    || String(chainId) !== expectedChainId
  ) {
    return false;
  }

  const blockNumber = derivation.blockNumber;
  if (
    typeof blockNumber !== "number"
    || !Number.isFinite(blockNumber)
    || !Number.isInteger(blockNumber)
    || blockNumber < 0
    || blockNumber > anchor.blockNumber
  ) {
    return false;
  }

  const blockHash = derivation.blockHash;
  if (!isValidBlockHash(blockHash)) return false;
  if (
    blockNumber === anchor.blockNumber
    && blockHash.toLowerCase() !== anchor.blockHash.toLowerCase()
  ) {
    return false;
  }

  return true;
}

/** Event facts share the same finalized anchor gate as observations. */
export function isEventEligible(
  event: ObservationMarketplaceEvent,
  anchor: CloseAnchorRef,
): boolean {
  return isObservationEligible(event, anchor);
}

/**
 * Authority-grade event gate: finalized through anchor, correct chain/height/hash, not orphaned.
 * Orphan/safe/late/wrong-chain facts must never enter reducer state or authority indexes.
 */
export function isEventAuthorityEligible(
  event: ObservationMarketplaceEvent,
  anchor: CloseAnchorRef,
  orphanedBlockHashes: ReadonlySet<string> = new Set(),
): boolean {
  if (!isEventEligible(event, anchor)) return false;
  const derivation = derivationOf(event);
  if (derivation === undefined) return false;
  return !blockHashIsOrphaned(derivation.blockHash, orphanedHashSet(orphanedBlockHashes));
}

export interface AuthorityProjection {
  readonly observations: readonly MarketplaceProtocolObservation[];
  /** Finality/orphan-eligible events accepted by the projector reducer, in canonical order. */
  readonly events: readonly ObservationMarketplaceEvent[];
  readonly state: MarketplaceProjectionState;
}

/**
 * Private package authority projection (program §7.138). Host callbacks receive observations
 * only; eligible events and reducer state stay inside the package boundary.
 *
 * Eligibility is enforced before reduce, then the reducer's accepted transcript is frozen as
 * authority — ineligible and reducer-refused facts never enter state or downstream indexes.
 */
export function deriveAuthorityProjection(
  events: readonly ObservationMarketplaceEvent[],
  anchor: CloseAnchorRef,
  orphanedBlockHashes: ReadonlySet<string> = new Set(),
): AuthorityProjection {
  const orphaned = orphanedHashSet(orphanedBlockHashes);
  const eligibleEvents = events.filter((event) =>
    isEventAuthorityEligible(event, anchor, orphaned)
  );
  const reduced = reduceMarketplaceProjection(
    eligibleEvents,
    createMarketplaceProjectionState(),
  );
  const finalizedThroughAnchor = reduced.observations.filter((observation) =>
    isObservationEligible(observation, anchor)
  );
  return {
    observations: selectCanonicalMarketplaceObservations(
      finalizedThroughAnchor,
      orphaned,
    ),
    events: reduced.events,
    state: reduced.state,
  };
}

export interface AttemptCreationAuthority {
  readonly attemptUrn: `urn:uuid:${string}`;
  readonly requestId?: `0x${string}`;
  readonly deliveryRate: bigint;
  readonly operator: `0x${string}`;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly generation: "today" | "revised";
}

export interface AttemptObservationAuthority {
  readonly attemptUrn: `urn:uuid:${string}`;
  readonly submissionUrn: string;
  readonly taskDigest: `sha256:${string}`;
  readonly executor: `0x${string}`;
  readonly observationId: string;
  readonly requestId?: `0x${string}`;
  readonly generation: "today" | "revised";
}

export interface DeliveryPreparationAuthority {
  readonly attemptUrn: `urn:uuid:${string}`;
  readonly requestId: `0x${string}`;
  readonly deliveryDigest: `sha256:${string}`;
  readonly kind: "solution" | "verdict";
  readonly verdictIndex?: number;
  readonly generation: "revised";
}

export interface DeliveryObservationAuthority {
  readonly attemptUrn: `urn:uuid:${string}`;
  readonly digest: `sha256:${string}`;
  readonly observationId: string;
}

export interface SolutionSettlementAuthority {
  readonly attemptUrn: `urn:uuid:${string}`;
  readonly requestId: `0x${string}`;
  readonly deliveryDigest?: `sha256:${string}`;
  readonly generation: "today" | "revised";
}

export interface VerdictSettlementAuthority {
  readonly attemptUrn: `urn:uuid:${string}`;
  readonly requestId: `0x${string}`;
  readonly verdictIndex: number;
  readonly evaluator: `0x${string}`;
  readonly evaluationDeliveryDigest?: `sha256:${string}`;
  readonly verdictCode: number;
}

export interface AttemptTerminalAuthority {
  readonly attemptUrn: `urn:uuid:${string}`;
  readonly state: string;
  readonly category?: string;
  readonly detail?: string;
}

function digestFromBytes32(value: `0x${string}`): `sha256:${string}` {
  return `sha256:${value.slice(2).toLowerCase()}` as `sha256:${string}`;
}

function attemptForEvent(
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

/** Index canonical attempt creation facts from eligible events only. */
export function indexAttemptCreations(
  events: readonly ObservationMarketplaceEvent[],
): Map<string, AttemptCreationAuthority> {
  const index = new Map<string, AttemptCreationAuthority>();
  for (const event of events) {
    if (event.event !== "TaskAttemptCreated") continue;
    const attemptUrn = attemptForEvent(event, event.facts.taskId, event.facts.attemptIndex);
    index.set(attemptUrn, {
      attemptUrn,
      ...("requestId" in event.facts
        ? { requestId: event.facts.requestId }
        : {}),
      deliveryRate: event.facts.deliveryRate,
      operator: event.facts.operator,
      taskId: event.facts.taskId,
      attemptIndex: event.facts.attemptIndex,
      generation: event.derivation.contractGeneration,
    });
  }
  return index;
}

export function indexAttemptObservations(
  observations: readonly MarketplaceProtocolObservation[],
): Map<string, AttemptObservationAuthority> {
  const index = new Map<string, AttemptObservationAuthority>();
  for (const observation of observations) {
    if (observation.type !== "network.jinn.task-execution.attempt-engaged.v1") continue;
    const data = observation.data;
    if (!isRecord(data)) continue;
    const attempt = data.attempt;
    const submission = data.submission;
    const task = data.task;
    const executor = data.executor;
    const annotations = data.annotations;
    if (
      typeof attempt !== "string"
      || typeof submission !== "string"
      || typeof task !== "string"
      || typeof executor !== "string"
      || !isRecord(annotations)
    ) {
      continue;
    }
    index.set(attempt, {
      attemptUrn: attempt as `urn:uuid:${string}`,
      submissionUrn: submission,
      taskDigest: task as `sha256:${string}`,
      executor: executor as `0x${string}`,
      observationId: observation.id,
      ...(typeof annotations.requestId === "string"
        ? { requestId: annotations.requestId as `0x${string}` }
        : {}),
      generation: observation.derivation.contractGeneration,
    });
  }
  return index;
}

export function indexDeliveryPreparations(
  events: readonly ObservationMarketplaceEvent[],
): Map<string, DeliveryPreparationAuthority> {
  const byAttempt = new Map<string, DeliveryPreparationAuthority>();
  for (const event of events) {
    if (
      event.event !== "SolutionDeliveryPrepared"
      && event.event !== "VerdictDeliveryPrepared"
    ) {
      continue;
    }
    const attemptUrn = attemptForEvent(
      event,
      event.facts.taskId,
      event.facts.attemptIndex,
    );
    const preparation: DeliveryPreparationAuthority = {
      attemptUrn,
      requestId: event.facts.expectedRequestId,
      deliveryDigest: digestFromBytes32(event.facts.deliveryDigest),
      kind: event.event === "SolutionDeliveryPrepared" ? "solution" : "verdict",
      ...(event.event === "VerdictDeliveryPrepared"
        ? { verdictIndex: event.facts.verdictIndex }
        : {}),
      generation: "revised",
    };
    const key = preparation.kind === "solution"
      ? attemptUrn
      : `${attemptUrn}:verdict:${preparation.verdictIndex}`;
    byAttempt.set(key, preparation);
  }
  return byAttempt;
}

export function indexDeliveryObservations(
  observations: readonly MarketplaceProtocolObservation[],
): Map<string, DeliveryObservationAuthority> {
  const index = new Map<string, DeliveryObservationAuthority>();
  for (const observation of observations) {
    if (observation.type !== "network.jinn.task-execution.delivery-recorded.v1") continue;
    const data = observation.data;
    if (!isRecord(data) || typeof data.digest !== "string") continue;
    index.set(observation.subject, {
      attemptUrn: observation.subject as `urn:uuid:${string}`,
      digest: data.digest as `sha256:${string}`,
      observationId: observation.id,
    });
  }
  return index;
}

export function indexSolutionSettlements(
  events: readonly ObservationMarketplaceEvent[],
): Map<string, SolutionSettlementAuthority> {
  const byAttempt = new Map<string, SolutionSettlementAuthority>();
  for (const event of events) {
    if (event.event !== "SolutionDeliveryClaimed") continue;
    const attemptUrn = attemptForEvent(event, event.facts.taskId, event.facts.attemptIndex);
    byAttempt.set(attemptUrn, {
      attemptUrn,
      requestId: event.facts.requestId,
      ...("deliveryDigest" in event.facts
        ? { deliveryDigest: digestFromBytes32(event.facts.deliveryDigest) }
        : {}),
      generation: event.derivation.contractGeneration,
    });
  }
  return byAttempt;
}

export function indexVerdictSettlements(
  events: readonly ObservationMarketplaceEvent[],
): VerdictSettlementAuthority[] {
  const settlements: VerdictSettlementAuthority[] = [];
  for (const event of events) {
    if (event.event !== "VerdictDeliveryClaimed") continue;
    settlements.push({
      attemptUrn: attemptForEvent(event, event.facts.taskId, event.facts.attemptIndex),
      requestId: event.facts.requestId,
      verdictIndex: event.facts.verdictIndex,
      evaluator: event.facts.evaluator,
      verdictCode: event.facts.verdictCode,
      ...("evaluationDeliveryDigest" in event.facts
        ? { evaluationDeliveryDigest: digestFromBytes32(event.facts.evaluationDeliveryDigest) }
        : {}),
    });
  }
  return settlements;
}

export function indexAttemptTerminals(
  observations: readonly MarketplaceProtocolObservation[],
): Map<string, AttemptTerminalAuthority> {
  const index = new Map<string, AttemptTerminalAuthority>();
  for (const observation of observations) {
    if (observation.type !== "network.jinn.task-execution.attempt-terminal.v1") continue;
    const data = observation.data;
    if (!isRecord(data) || typeof data.state !== "string") continue;
    index.set(observation.subject, {
      attemptUrn: observation.subject as `urn:uuid:${string}`,
      state: data.state,
      ...(typeof data.category === "string" ? { category: data.category } : {}),
      ...(typeof data.detail === "string" ? { detail: data.detail } : {}),
    });
  }
  return index;
}
