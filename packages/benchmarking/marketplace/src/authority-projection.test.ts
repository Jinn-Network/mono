import {
  deriveMarketplaceAttemptUri,
  encodeRevisedRequestData,
} from "@jinn-network/marketplace-binding";
import type { InScopeCell } from "@jinn-network/benchmarking-run";
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
import { deriveSettledFeeForCell } from "./settlement-authority.js";
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

function taskCreated(): ObservationMarketplaceEvent {
  return {
    event: "TaskCreated",
    derivation: {
      chainId: 84532,
      contract: COORDINATOR,
      event: "TaskCreated",
      blockNumber: 99,
      blockHash: `0x${"6".repeat(64)}`,
      txHash: `0x${"1".repeat(64)}`,
      logIndex: 0,
      finalityTier: "finalized",
      contractGeneration: "revised",
    },
    projection: projectionShell(),
    facts: {
      creator: "0x2222222222222222222222222222222222222222",
      taskCidDigest: `0x${TASK_DIGEST}`,
      submissionDigest: `0x${"8".repeat(64)}`,
      taskId: 42n,
      maxTotal: 2,
      maxConcurrent: 2,
      submissionDeadline: 1_800_000_000n,
      closeAt: 0n,
      responseTimeout: 3600n,
      minVerdicts: 1,
      requireDistinctEvaluator: true,
      solutionMaxDeliveryRate: 10n,
      verdictMaxDeliveryRate: 10n,
      solutionBudget: 20n,
      verdictBudget: 20n,
    },
  } as ObservationMarketplaceEvent;
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

function solutionDelivered(input: {
  attemptIndex: number;
  requestId: Hex;
  blockNumber: number;
  blockHash: Hex;
}): ObservationMarketplaceEvent {
  const deliveryDigest = `0x${"d".repeat(64)}` as Hex;
  return {
    event: "Deliver",
    derivation: {
      chainId: 84532,
      contract: "0x4444444444444444444444444444444444444444",
      event: "Deliver",
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      txHash: `0x${String(input.attemptIndex + 20).padStart(64, "d")}` as Hex,
      logIndex: 1,
      finalityTier: "finalized",
      contractGeneration: "revised",
    },
    projection: projectionShell(),
    facts: {
      mech: "0x4444444444444444444444444444444444444444",
      mechServiceMultisig: "0x3333333333333333333333333333333333333333",
      requestId: input.requestId,
      deliveryRate: 10n,
      requestData: encodeRevisedRequestData({
        legKind: 1,
        taskId: 42n,
        attemptIndex: input.attemptIndex,
        verdictIndex: 0,
        deliveryDigest,
        verdictCode: 0,
      }),
      deliveryData: deliveryDigest,
    },
  } as ObservationMarketplaceEvent;
}

describe("deriveAuthorityProjection ordering", () => {
  test("reducer-refused duplicates cannot shadow accepted authority continuity or cost", () => {
    const validAttempt = attemptCreated({
      attemptIndex: 0,
      deliveryRate: 10n,
      blockNumber: 100,
      blockHash: `0x${"7".repeat(64)}`,
    });
    const validPreparation = solutionPrepared({
      attemptIndex: 0,
      requestId: REQUEST_ELIGIBLE,
      blockNumber: 101,
      blockHash: `0x${"8".repeat(64)}`,
    });
    const refusedPreparation = solutionPrepared({
      attemptIndex: 0,
      requestId: REQUEST_ORPHAN,
      blockNumber: 102,
      blockHash: `0x${"9".repeat(64)}`,
    });
    const delivered = solutionDelivered({
      attemptIndex: 0,
      requestId: REQUEST_ELIGIBLE,
      blockNumber: 103,
      blockHash: `0x${"a".repeat(64)}`,
    });
    const validClaim = solutionClaimed({
      attemptIndex: 0,
      requestId: REQUEST_ELIGIBLE,
      blockNumber: 103,
      blockHash: `0x${"a".repeat(64)}`,
    });
    const refusedCreation = {
      ...attemptCreated({
        attemptIndex: 0,
        deliveryRate: 999n,
        blockNumber: 104,
        blockHash: `0x${"b".repeat(64)}`,
      }),
      facts: {
        ...validAttempt.facts,
        deliveryRate: 999n,
        operator: "0x9999999999999999999999999999999999999999",
      },
    } as ObservationMarketplaceEvent;
    const refusedDuplicateClaim = solutionClaimed({
      attemptIndex: 0,
      requestId: REQUEST_ORPHAN,
      blockNumber: 104,
      blockHash: `0x${"c".repeat(64)}`,
    });
    const refusedCrossAttemptClaim = solutionClaimed({
      attemptIndex: 1,
      requestId: REQUEST_ELIGIBLE,
      blockNumber: 104,
      blockHash: `0x${"d".repeat(64)}`,
    });

    const projection = deriveAuthorityProjection([
      taskCreated(),
      validAttempt,
      validPreparation,
      refusedPreparation,
      delivered,
      validClaim,
      refusedCreation,
      refusedDuplicateClaim,
      refusedCrossAttemptClaim,
    ], ANCHOR);
    const attemptUrn = deriveMarketplaceAttemptUri({
      chainId: 84532,
      coordinator: COORDINATOR,
      taskId: 42n,
      attemptIndex: 0,
    });
    const crossAttemptUrn = deriveMarketplaceAttemptUri({
      chainId: 84532,
      coordinator: COORDINATOR,
      taskId: 42n,
      attemptIndex: 1,
    });

    expect(projection.events).toHaveLength(5);
    expect(indexAttemptCreations(projection.events).get(attemptUrn)).toMatchObject({
      deliveryRate: 10n,
      operator: "0x3333333333333333333333333333333333333333",
    });
    expect(indexDeliveryPreparations(projection.events).get(attemptUrn)?.requestId)
      .toBe(REQUEST_ELIGIBLE);
    const settlements = indexSolutionSettlements(projection.events);
    expect(settlements.get(attemptUrn)?.requestId).toBe(REQUEST_ELIGIBLE);
    expect(settlements.has(crossAttemptUrn)).toBe(false);

    const cell = {
      cellKey: `${TASK_DIGEST}/armA/1`,
      armId: "armA",
      replicate: 1,
      taskDigest: TASK_DIGEST,
      dispatches: 1,
      accounted: 1,
      attempt: attemptUrn,
      deliveryDigest: `sha256:${"d".repeat(64)}`,
      verdicts: [],
    } satisfies InScopeCell;
    expect(deriveSettledFeeForCell({
      cell,
      projection,
      generation: "revised",
      budgetUnit: "wei",
    })?.value).toBe("10");
  });

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
    const allEvents = [taskCreated(), eligible, orphan];

    const projection = deriveAuthorityProjection(allEvents, ANCHOR, new Set([ORPHAN_HASH]));
    const creations = indexAttemptCreations(projection.events);
    expect(projection.events).toHaveLength(2);
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
    const eligibleDelivery = solutionDelivered({
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
        taskCreated(),
        attempt,
        eligiblePreparation,
        eligibleDelivery,
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
    expect(projection.events).toHaveLength(5);
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
    const projection = deriveAuthorityProjection([taskCreated(), eligible, safe, late], ANCHOR);
    expect(projection.events).toHaveLength(2);
    expect(indexAttemptCreations(projection.events).size).toBe(1);
    expect(isEventAuthorityEligible(safe, ANCHOR)).toBe(false);
    expect(isEventAuthorityEligible(late, ANCHOR)).toBe(false);
  });
});
