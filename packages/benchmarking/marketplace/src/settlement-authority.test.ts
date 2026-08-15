import type { InScopeCell } from "@jinn-network/benchmarking-run";
import { deriveMarketplaceAttemptUri } from "@jinn-network/marketplace-binding";
import { describe, expect, test } from "vitest";
import { createMarketplaceProjectionState } from "@jinn-network/marketplace-projector";
import type { AuthorityProjection } from "./authority-projection.js";
import { deriveSettledFeeForCell } from "./settlement-authority.js";

const COORDINATOR = "0x1111111111111111111111111111111111111111" as const;
const ATTEMPT = deriveMarketplaceAttemptUri({
  chainId: 84532,
  coordinator: COORDINATOR,
  taskId: 42n,
  attemptIndex: 0,
});
const REQUEST_ID = `0x${"4".repeat(64)}` as const;
const DELIVERY_DIGEST = `sha256:${"d".repeat(64)}` as const;
const TASK_DIGEST = "7777777777777777777777777777777777777777777777777777777777777777";

function cell(overrides: Partial<InScopeCell> = {}): InScopeCell {
  return {
    cellKey: `${TASK_DIGEST}/armA/1`,
    armId: "armA",
    replicate: 1,
    taskDigest: TASK_DIGEST,
    dispatches: 1,
    accounted: 1,
    attempt: ATTEMPT,
    deliveryDigest: DELIVERY_DIGEST,
    verdicts: [],
    ...overrides,
  };
}

function projection(overrides: Partial<AuthorityProjection> = {}): AuthorityProjection {
  const base = {
    observations: [{
      specversion: "1.0",
      id: "attempt-obs",
      source: "urn:jinn:backend:marketplace",
      subject: ATTEMPT,
      time: "2026-08-01T00:00:00Z",
      datacontenttype: "application/json",
      sequence: "0000000000000001",
      type: "network.jinn.task-execution.attempt-engaged.v1",
      data: {
        attempt: ATTEMPT,
        task: `sha256:${TASK_DIGEST}`,
        submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
        executor: "0x3333333333333333333333333333333333333333",
        effectiveDeadline: "2026-07-30T12:00:00Z",
        source: "urn:jinn:backend:marketplace",
        dispatchContext: {
          uri: "urn:jinn:marketplace:dispatch-context:42:0",
          digest: { sha256: "8888888888888888888888888888888888888888888888888888888888888888" },
        },
        annotations: {
          contractGeneration: "revised",
          engagement: { taskId: "42", attemptIndex: 0, kind: "solution" },
        },
      },
      derivation: {
        chainId: 84532,
        contract: "0x1111111111111111111111111111111111111111",
        event: "TaskAttemptCreated",
        blockNumber: 100,
        blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        logIndex: 1,
        finalityTier: "finalized",
        contractGeneration: "revised",
      },
    }, {
      specversion: "1.0",
      id: "delivery-obs",
      source: "urn:jinn:backend:marketplace",
      subject: ATTEMPT,
      time: "2026-08-01T00:00:01Z",
      datacontenttype: "application/json",
      sequence: "0000000000000002",
      type: "network.jinn.task-execution.delivery-recorded.v1",
      data: { digest: DELIVERY_DIGEST },
      derivation: {
        chainId: 84532,
        contract: "0x1111111111111111111111111111111111111111",
        event: "SolutionDeliveryClaimed",
        blockNumber: 101,
        blockHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
        txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        logIndex: 0,
        finalityTier: "finalized",
        contractGeneration: "revised",
      },
    }],
    events: [{
      event: "TaskAttemptCreated",
      derivation: {
        chainId: 84532,
        contract: "0x1111111111111111111111111111111111111111",
        event: "TaskAttemptCreated",
        blockNumber: 100,
        blockHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
        txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        logIndex: 1,
        finalityTier: "finalized",
        contractGeneration: "revised",
      },
      projection: {
        taskCoordinator: COORDINATOR,
        timestamp: "2026-07-29T12:00:00Z",
        submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
        taskDigest: `sha256:${TASK_DIGEST}`,
        effectiveDeadline: "2026-07-30T12:00:00Z",
        dispatchContext: {
          uri: "urn:jinn:marketplace:dispatch-context:42:0",
          digest: { sha256: "8888888888888888888888888888888888888888888888888888888888888888" },
        },
      },
      facts: {
        taskId: 42n,
        attemptIndex: 0,
        deliveryRate: 10n,
        operator: "0x3333333333333333333333333333333333333333",
        priorityMech: "0x4444444444444444444444444444444444444444",
        attemptDeadline: 1785369600n,
      },
    }, {
      event: "SolutionDeliveryPrepared",
      derivation: {
        chainId: 84532,
        contract: "0x1111111111111111111111111111111111111111",
        event: "SolutionDeliveryPrepared",
        blockNumber: 101,
        blockHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
        txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        logIndex: 0,
        finalityTier: "finalized",
        contractGeneration: "revised",
      },
      projection: {
        taskCoordinator: COORDINATOR,
        timestamp: "2026-07-29T12:00:01Z",
        submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
        taskDigest: `sha256:${TASK_DIGEST}`,
        effectiveDeadline: "2026-07-30T12:00:00Z",
        dispatchContext: {
          uri: "urn:jinn:marketplace:dispatch-context:42:0",
          digest: { sha256: "8888888888888888888888888888888888888888888888888888888888888888" },
        },
      },
      facts: {
        operator: "0x3333333333333333333333333333333333333333",
        expectedRequestId: REQUEST_ID,
        taskId: 42n,
        attemptIndex: 0,
        nonce: 1n,
        deliveryDigest: `0x${"d".repeat(64)}`,
      },
    }, {
      event: "SolutionDeliveryClaimed",
      derivation: {
        chainId: 84532,
        contract: "0x1111111111111111111111111111111111111111",
        event: "SolutionDeliveryClaimed",
        blockNumber: 101,
        blockHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
        txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        logIndex: 0,
        finalityTier: "finalized",
        contractGeneration: "revised",
      },
      projection: {
        taskCoordinator: COORDINATOR,
        timestamp: "2026-07-29T12:00:01Z",
        submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
        taskDigest: `sha256:${TASK_DIGEST}`,
        effectiveDeadline: "2026-07-30T12:00:00Z",
        dispatchContext: {
          uri: "urn:jinn:marketplace:dispatch-context:42:0",
          digest: { sha256: "8888888888888888888888888888888888888888888888888888888888888888" },
        },
      },
      facts: {
        taskId: 42n,
        attemptIndex: 0,
        requestId: REQUEST_ID,
        deliveryDigest: `0x${"d".repeat(64)}`,
        operator: "0x3333333333333333333333333333333333333333",
      },
    }],
    state: createMarketplaceProjectionState(),
  } as AuthorityProjection;
  return { ...base, ...overrides };
}

describe("deriveSettledFeeForCell", () => {
  test("returns exact creation deliveryRate for joined settlement", () => {
    const fee = deriveSettledFeeForCell({
      cell: cell(),
      projection: projection(),
      generation: "revised",
      budgetUnit: "wei",
    });
    expect(fee).toEqual({
      value: "10",
      unit: "wei",
      paymentAsset: "olas",
    });
  });

  test("returns undefined without settlement join", () => {
    expect(deriveSettledFeeForCell({
      cell: cell(),
      projection: projection({ events: projection().events.slice(0, 1) }),
      generation: "revised",
      budgetUnit: "wei",
    })).toBeUndefined();
  });

  test("returns undefined for wrong attempt", () => {
    expect(deriveSettledFeeForCell({
      cell: cell({ attempt: "urn:uuid:99999999-9999-4999-8999-999999999999" }),
      projection: projection(),
      generation: "revised",
      budgetUnit: "wei",
    })).toBeUndefined();
  });

  test("returns undefined when delivery digest mismatches observation", () => {
    expect(deriveSettledFeeForCell({
      cell: cell({ deliveryDigest: `sha256:${"e".repeat(64)}` }),
      projection: projection(),
      generation: "revised",
      budgetUnit: "wei",
    })).toBeUndefined();
  });

  test("returns undefined for generation mismatch", () => {
    expect(deriveSettledFeeForCell({
      cell: cell(),
      projection: projection(),
      generation: "today",
      budgetUnit: "wei",
    })).toBeUndefined();
  });

  test("cannot label budget envelope as delivery rate", () => {
    const fee = deriveSettledFeeForCell({
      cell: cell(),
      projection: projection(),
      generation: "revised",
      budgetUnit: "wei",
    });
    expect(fee?.value).toBe("10");
    expect(fee?.value).not.toBe("1000");
  });
});
