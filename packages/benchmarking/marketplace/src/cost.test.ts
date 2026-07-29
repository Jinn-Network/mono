import { deriveMarketplaceAttemptUri } from "@jinn-network/marketplace-binding";
import type { InScopeCell } from "@jinn-network/benchmarking-run";
import { describe, expect, test } from "vitest";
import type { AuthorityProjection } from "./authority-projection.js";
import {
  SettledCostValidationError,
  settledCostSource,
} from "./cost.js";
import { deriveSettledFeeForCell } from "./settlement-authority.js";

const COORDINATOR = "0x1111111111111111111111111111111111111111" as const;
const ATTEMPT = deriveMarketplaceAttemptUri({
  chainId: 84532,
  coordinator: COORDINATOR,
  taskId: 42n,
  attemptIndex: 0,
});
const TASK_DIGEST = "d".repeat(64);
const REQUEST_ID = `0x${"4".repeat(64)}` as const;
const DELIVERY_DIGEST = `sha256:${"d".repeat(64)}` as const;

const CELL: InScopeCell = {
  cellKey: `${TASK_DIGEST}/armA/1`,
  armId: "armA",
  replicate: 1,
  taskDigest: TASK_DIGEST,
  dispatches: 1,
  attempt: ATTEMPT,
  deliveryDigest: DELIVERY_DIGEST,
  verdicts: [],
};

const SETTLED_PROJECTION = {
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
      annotations: { requestId: REQUEST_ID },
    },
    derivation: {
      chainId: 84532,
      contract: COORDINATOR,
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
      contract: COORDINATOR,
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
      contract: COORDINATOR,
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
      requestId: REQUEST_ID,
      deliveryRate: 10n,
      operator: "0x3333333333333333333333333333333333333333",
      priorityMech: "0x4444444444444444444444444444444444444444",
      attemptDeadline: 1785369600n,
    },
  }, {
    event: "SolutionDeliveryClaimed",
    derivation: {
      chainId: 84532,
      contract: COORDINATOR,
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
  state: {
    processedLogIds: [],
    processedCorrectionIds: [],
    sequenceBySourceSubject: {},
    tasks: {},
    pendingMechDeliveries: {},
    requestIdBindings: {},
    evaluationIdentities: {},
  },
} as AuthorityProjection;

const EMPTY_PROJECTION = {
  observations: [],
  events: [],
  state: SETTLED_PROJECTION.state,
} as AuthorityProjection;

describe("settledCostSource", () => {
  test("labels projector-derived delivery rate with source settled", async () => {
    const cost = settledCostSource({
      generation: "revised",
      budgetUnit: "wei",
      projection: SETTLED_PROJECTION,
    });
    await expect(cost.costFor(CELL)).resolves.toEqual({
      value: "10",
      unit: "wei",
      source: "settled",
    });
    expect(deriveSettledFeeForCell({
      cell: CELL,
      projection: SETTLED_PROJECTION,
      generation: "revised",
      budgetUnit: "wei",
    })?.value).toBe("10");
  });

  test("falls back to reported and never relabels it settled", async () => {
    const cost = settledCostSource({
      generation: "today",
      budgetUnit: "wei",
      projection: EMPTY_PROJECTION,
      async reportedCostFor() {
        return { value: "7", unit: "wei" };
      },
    });
    await expect(cost.costFor(CELL)).resolves.toEqual({
      value: "7",
      unit: "wei",
      source: "reported",
    });
  });

  test("returns absent when no source exists", async () => {
    const cost = settledCostSource({
      generation: "today",
      budgetUnit: "wei",
      projection: EMPTY_PROJECTION,
    });
    await expect(cost.costFor(CELL)).resolves.toBeUndefined();
  });
});
