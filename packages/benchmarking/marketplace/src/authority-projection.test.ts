import { deriveMarketplaceAttemptUri } from "@jinn-network/marketplace-binding";
import type { ObservationMarketplaceEvent } from "@jinn-network/marketplace-projector";
import type { Address, Hex } from "viem";
import { describe, expect, test } from "vitest";
import {
  deriveAuthorityProjection,
  indexAttemptCreations,
  indexDeliveryPreparations,
  indexSolutionSettlements,
  isEventAuthorityEligible,
} from "./authority-projection.js";
const ANCHOR = {
  chain: "eip155:84532",
  blockNumber: 105,
  blockHash: "0x1515151515151515151515151515151515151515151515151515151515151515" as Hex,
};
const ORPHAN_HASH = "0x1010101010101010101010101010101010101010101010101010101010101010" as Hex;
const REQUEST_ELIGIBLE = `0x${"4".repeat(64)}` as Hex;
const REQUEST_ORPHAN = `0x${"5".repeat(64)}` as Hex;

const COORDINATOR = "0x1111111111111111111111111111111111111111" as Address;
const TASK_DIGEST = "7777777777777777777777777777777777777777777777777777777777777777";

function projectionShell(): ObservationMarketplaceEvent["projection"] {
  return {
    taskCoordinator: COORDINATOR,
    timestamp: "2026-08-01T00:00:00Z",
    submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
    taskDigest: `sha256:${TASK_DIGEST}`,
    effectiveDeadline: "2026-08-04T00:00:00Z",
    dispatchContext: {
      uri: "urn:jinn:marketplace:dispatch-context:42:0",
      digest: { sha256: "8888888888888888888888888888888888888888888888888888888888888888" },
    },
  };
}

function attemptCreated(input: {
  attemptIndex: number;
  deliveryRate: bigint;
  blockNumber: number;
  blockHash: Hex;
  finalityTier?: "finalized" | "safe";
  chainId?: number;
}): ObservationMarketplaceEvent {
  return {
    event: "TaskAttemptCreated",
    derivation: {
      chainId: input.chainId ?? 84532,
      contract: COORDINATOR,
      event: "TaskAttemptCreated",
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      txHash: `0x${String(input.attemptIndex).padStart(64, "a")}` as Hex,
      logIndex: input.attemptIndex,
      finalityTier: input.finalityTier ?? "finalized",
      contractGeneration: "revised",
    },
    projection: projectionShell(),
    facts: {
      taskId: 42n,
      attemptIndex: input.attemptIndex,
      deliveryRate: input.deliveryRate,
      operator: "0x3333333333333333333333333333333333333333" as Address,
      priorityMech: "0x4444444444444444444444444444444444444444" as Address,
      attemptDeadline: 1785369600n,
    },
  } as ObservationMarketplaceEvent;
}

function solutionPrepared(input: {
  attemptIndex: number;
  requestId: Hex;
  blockNumber: number;
  blockHash: Hex;
  finalityTier?: "finalized" | "safe";
}): ObservationMarketplaceEvent {
  return {
    event: "SolutionDeliveryPrepared",
    derivation: {
      chainId: 84532,
      contract: COORDINATOR,
      event: "SolutionDeliveryPrepared",
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      txHash: `0x${String(input.attemptIndex + 5).padStart(64, "c")}` as Hex,
      logIndex: 0,
      finalityTier: input.finalityTier ?? "finalized",
      contractGeneration: "revised",
    },
    projection: projectionShell(),
    facts: {
      taskId: 42n,
      attemptIndex: input.attemptIndex,
      operator: "0x3333333333333333333333333333333333333333" as Address,
      expectedRequestId: input.requestId,
      nonce: 7n,
      deliveryDigest: `0x${"d".repeat(64)}` as Hex,
    },
  } as ObservationMarketplaceEvent;
}

function solutionClaimed(input: {
  attemptIndex: number;
  requestId: Hex;
  blockNumber: number;
  blockHash: Hex;
  finalityTier?: "finalized" | "safe";
}): ObservationMarketplaceEvent {
  return {
    event: "SolutionDeliveryClaimed",
    derivation: {
      chainId: 84532,
      contract: COORDINATOR,
      event: "SolutionDeliveryClaimed",
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      txHash: `0x${String(input.attemptIndex + 10).padStart(64, "b")}` as Hex,
      logIndex: 0,
      finalityTier: input.finalityTier ?? "finalized",
      contractGeneration: "revised",
    },
    projection: projectionShell(),
    facts: {
      taskId: 42n,
      attemptIndex: input.attemptIndex,
      requestId: input.requestId,
      deliveryDigest: `0x${"d".repeat(64)}` as Hex,
      operator: "0x3333333333333333333333333333333333333333" as Address,
    },
  } as ObservationMarketplaceEvent;
}

describe("deriveAuthorityProjection ordering", () => {
  test("orphan TaskAttemptCreated never enters creation index", () => {
    const eligible = attemptCreated({
      attemptIndex: 0,
      deliveryRate: 10n,
      blockNumber: 100,
      blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
    });
    const orphan = attemptCreated({
      attemptIndex: 1,
      deliveryRate: 999n,
      blockNumber: 101,
      blockHash: ORPHAN_HASH,
    });
    const allEvents = [eligible, orphan];

    const projection = deriveAuthorityProjection(allEvents, ANCHOR, new Set([ORPHAN_HASH]));
    const creations = indexAttemptCreations(projection.events);
    expect(projection.events).toHaveLength(1);
    expect(creations.size).toBe(1);
    expect(creations.get(
      deriveMarketplaceAttemptUri({ chainId: 84532, coordinator: COORDINATOR, taskId: 42n, attemptIndex: 0 }),
    )?.deliveryRate).toBe(10n);
    expect(isEventAuthorityEligible(orphan, ANCHOR, new Set([ORPHAN_HASH]))).toBe(false);
  });

  test("orphan settlement never enters settlement index", () => {
    const attempt = attemptCreated({
      attemptIndex: 0,
      deliveryRate: 10n,
      blockNumber: 100,
      blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
    });
    const eligiblePreparation = solutionPrepared({
      attemptIndex: 0,
      requestId: REQUEST_ELIGIBLE,
      blockNumber: 101,
      blockHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
    });
    const eligibleSettlement = solutionClaimed({
      attemptIndex: 0,
      requestId: REQUEST_ELIGIBLE,
      blockNumber: 102,
      blockHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
    });
    const orphanPreparation = solutionPrepared({
      attemptIndex: 0,
      requestId: REQUEST_ORPHAN,
      blockNumber: 103,
      blockHash: ORPHAN_HASH,
    });
    const orphanSettlement = solutionClaimed({
      attemptIndex: 0,
      requestId: REQUEST_ORPHAN,
      blockNumber: 103,
      blockHash: ORPHAN_HASH,
    });
    const projection = deriveAuthorityProjection(
      [
        attempt,
        eligiblePreparation,
        eligibleSettlement,
        orphanPreparation,
        orphanSettlement,
      ],
      ANCHOR,
      new Set([ORPHAN_HASH]),
    );
    const settlements = indexSolutionSettlements(projection.events);
    const attemptUrn = deriveMarketplaceAttemptUri({
      chainId: 84532,
      coordinator: COORDINATOR,
      taskId: 42n,
      attemptIndex: 0,
    });
    expect(settlements.get(attemptUrn)?.requestId).toBe(REQUEST_ELIGIBLE);
    expect(indexDeliveryPreparations(projection.events).get(attemptUrn)?.requestId)
      .toBe(REQUEST_ELIGIBLE);
    expect(projection.events).toHaveLength(3);
  });

  test("safe and late events do not mutate authority indexes", () => {
    const eligible = attemptCreated({
      attemptIndex: 0,
      deliveryRate: 10n,
      blockNumber: 100,
      blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
    });
    const safe = attemptCreated({
      attemptIndex: 1,
      deliveryRate: 888n,
      blockNumber: 100,
      blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
      finalityTier: "safe",
    });
    const late = attemptCreated({
      attemptIndex: 2,
      deliveryRate: 777n,
      blockNumber: 200,
      blockHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
    });
    const projection = deriveAuthorityProjection([eligible, safe, late], ANCHOR);
    expect(projection.events).toHaveLength(1);
    expect(indexAttemptCreations(projection.events).size).toBe(1);
    expect(isEventAuthorityEligible(safe, ANCHOR)).toBe(false);
    expect(isEventAuthorityEligible(late, ANCHOR)).toBe(false);
  });
});
