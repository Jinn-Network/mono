import { deriveMarketplaceAttemptUri } from "@jinn-network/marketplace-binding";
import {
  ProtocolObservationSchema,
  type ProtocolObservation,
} from "@jinn-network/task-execution-protocol";
import type { Address, Hex } from "viem";
import { describe, expect, test } from "vitest";
import type { DerivationAnnotation } from "./derivation.js";
import type { MarketplaceEvent } from "./events.js";
import {
  projectObservations,
  type ObservationMarketplaceEvent,
  type ObservationProjectionContext,
} from "./observe.js";

const COORDINATOR = "0x1111111111111111111111111111111111111111" satisfies Address;
const OPERATOR = "0x2222222222222222222222222222222222222222" satisfies Address;
const CREATOR = "0x3333333333333333333333333333333333333333" satisfies Address;
const REQUEST_ID = `0x${"4".repeat(64)}` satisfies Hex;
const TX_HASH = `0x${"5".repeat(64)}` satisfies Hex;
const BLOCK_HASH = `0x${"6".repeat(64)}` satisfies Hex;
const TASK_DIGEST = `sha256:${"7".repeat(64)}` as const;
const SUBMISSION = "urn:uuid:11111111-1111-4111-8111-111111111111" as const;
const TIME = "2026-07-29T12:00:00Z";
const DEADLINE = "2026-07-30T12:00:00Z";
const SOURCE = "urn:jinn:marketplace-projector:eip155:84532:0x1111111111111111111111111111111111111111";
const DISPATCH_CONTEXT = {
  uri: "urn:jinn:marketplace:dispatch-context:42:3",
  digest: { sha256: "8".repeat(64) },
} as const;
const ATTEMPT = deriveMarketplaceAttemptUri({
  chainId: 84532,
  coordinator: COORDINATOR,
  taskId: 42n,
  attemptIndex: 3,
});

const CONTEXT: ObservationProjectionContext = {
  timestamp: TIME,
  submission: SUBMISSION,
  taskDigest: TASK_DIGEST,
  effectiveDeadline: DEADLINE,
  dispatchContext: DISPATCH_CONTEXT,
};

function derivation(
  event: string,
  logIndex: number,
  contractGeneration: "today" | "revised" = "today",
): DerivationAnnotation {
  return {
    chainId: 84532,
    contract: COORDINATOR,
    event,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    txHash: TX_HASH,
    logIndex,
    finalityTier: "safe" as const,
    contractGeneration,
  };
}

function projectable(
  event: MarketplaceEvent,
  projection: Partial<ObservationProjectionContext> = {},
): ObservationMarketplaceEvent {
  return {
    ...event,
    projection: { ...CONTEXT, ...projection },
  } as ObservationMarketplaceEvent;
}

function base(
  type: ProtocolObservation["type"],
  subject: string,
  sequence: bigint,
  logIndex: number,
) {
  return {
    specversion: "1.0",
    id: `${TX_HASH}:${logIndex}:${type}`,
    source: SOURCE,
    subject,
    time: TIME,
    datacontenttype: "application/json",
    sequence: sequence.toString().padStart(16, "0"),
    taskdigest: TASK_DIGEST,
    type,
  };
}

const claim = projectable({
  event: "TaskAttemptCreated",
  facts: {
    taskId: 42n,
    attemptIndex: 3,
    operator: OPERATOR,
    requestId: REQUEST_ID,
    priorityMech: OPERATOR,
    deliveryRate: 10n,
  },
  derivation: derivation("TaskAttemptCreated", 1),
});

function deliver(
  chainKeccak: Hex = `0x${"b".repeat(64)}`,
): ObservationMarketplaceEvent {
  return projectable({
    event: "Deliver",
    facts: {
      mech: OPERATOR,
      mechServiceMultisig: OPERATOR,
      requestId: REQUEST_ID,
      deliveryRate: 10n,
      data: `0x${"a".repeat(64)}`,
    },
    derivation: derivation("Deliver", 2),
  }, {
    deliveryCorrespondence: {
      sha256Digest: `sha256:${"a".repeat(64)}`,
      keccakEvidenceHash: `0x${"b".repeat(64)}`,
      onChainSha256CidDigest: `sha256:${"a".repeat(64)}`,
      onChainKeccak: chainKeccak,
    },
  });
}

const solutionClaimed = projectable({
  event: "SolutionDeliveryClaimed",
  facts: {
    operator: OPERATOR,
    requestId: REQUEST_ID,
    taskId: 42n,
    attemptIndex: 3,
  },
  derivation: derivation("SolutionDeliveryClaimed", 3),
});

describe("projectObservations", () => {
  test("projects posting and claim into exact TEP observations using the protocol-owned Attempt URI", () => {
    const task = projectable({
      event: "TaskCreated",
      facts: {
        creator: CREATOR,
        taskId: 42n,
        manifestDigest: `0x${"0".repeat(64)}`,
        taskCidDigest: `0x${"7".repeat(64)}`,
        maxClaims: 2,
        solutionBudget: 100n,
        verdictBudget: 20n,
      },
      derivation: derivation("TaskCreated", 0),
    });

    expect(projectObservations([task, claim])).toEqual([
      {
        ...base("network.jinn.task-execution.submission-accepted.v1", SUBMISSION, 1n, 0),
        data: { submission: SUBMISSION, task: TASK_DIGEST },
      },
      {
        ...base("network.jinn.task-execution.attempt-engaged.v1", ATTEMPT, 2n, 1),
        data: {
          attempt: ATTEMPT,
          task: TASK_DIGEST,
          submission: SUBMISSION,
          executor: OPERATOR,
          effectiveDeadline: DEADLINE,
          source: SOURCE,
          dispatchContext: DISPATCH_CONTEXT,
          annotations: {
            requestId: REQUEST_ID,
            contractGeneration: "today",
          },
        },
      },
    ]);
  });

  test("emits delivery-recorded only when the joined today sha256↔keccak correspondence is exact", () => {
    expect(projectObservations([claim, deliver(), solutionClaimed]).at(-1)).toEqual({
      ...base("network.jinn.task-execution.delivery-recorded.v1", ATTEMPT, 2n, 3),
      data: { digest: `sha256:${"a".repeat(64)}` },
    });

    const mismatch = projectObservations([
      claim,
      deliver(`0x${"c".repeat(64)}`),
      solutionClaimed,
    ]);
    expect(mismatch.at(-1)).toEqual({
      ...base("network.jinn.task-execution.attempt-terminal.v1", ATTEMPT, 2n, 3),
      data: {
        state: "rejected",
        category: "digest-divergence",
        detail: "today-mode sha256↔keccak correspondence failed",
      },
    });
    expect(
      mismatch.some(({ type }) =>
        type === "network.jinn.task-execution.delivery-recorded.v1"
      ),
    ).toBe(false);
  });

  test("uses only the V4 router sha256 anchor for revised delivery identity", () => {
    const revisedClaim = projectable({
      event: "TaskAttemptCreated",
      facts: {
        operator: OPERATOR,
        priorityMech: OPERATOR,
        requestId: REQUEST_ID,
        taskId: 42n,
        attemptIndex: 3,
        attemptDeadline: 1_800_000_000n,
        deliveryRate: 10n,
      },
      derivation: derivation("TaskAttemptCreated", 1, "revised"),
    });
    const revisedSolution = projectable({
      event: "SolutionDeliveryClaimed",
      facts: {
        operator: OPERATOR,
        requestId: REQUEST_ID,
        deliveryDigest: `0x${"d".repeat(64)}`,
        taskId: 42n,
        attemptIndex: 3,
      },
      derivation: derivation("SolutionDeliveryClaimed", 3, "revised"),
    });
    const operationalMechJoin = projectable({
      event: "Deliver",
      facts: {
        mech: OPERATOR,
        mechServiceMultisig: OPERATOR,
        requestId: REQUEST_ID,
        deliveryRate: 10n,
        data: "0x1234",
      },
      derivation: derivation("Deliver", 2, "revised"),
    }, {
      deliveryCorrespondence: undefined,
    });

    expect(
      projectObservations([revisedClaim, operationalMechJoin, revisedSolution]).at(-1),
    ).toEqual({
      ...base("network.jinn.task-execution.delivery-recorded.v1", ATTEMPT, 2n, 3),
      data: { digest: `sha256:${"d".repeat(64)}` },
    });
  });

  test("maps verdict, expiry, release, refund, and close into exact terminal/closed observations", () => {
    const events = [
      projectable({
        event: "VerdictDeliveryClaimed",
        facts: {
          evaluator: OPERATOR,
          requestId: REQUEST_ID,
          taskId: 42n,
          attemptIndex: 3,
          verdictIndex: 1,
          verdictCode: 2,
        },
        derivation: derivation("VerdictDeliveryClaimed", 4),
      }),
      projectable({
        event: "AttemptExpired",
        facts: { taskId: 42n, attemptIndex: 3, operator: OPERATOR },
        derivation: derivation("AttemptExpired", 5, "revised"),
      }),
      projectable({
        event: "AttemptReleased",
        facts: { taskId: 42n, attemptIndex: 3, operator: OPERATOR },
        derivation: derivation("AttemptReleased", 6, "revised"),
      }),
      projectable({
        event: "TaskBudgetRefunded",
        facts: {
          taskId: 42n,
          creator: CREATOR,
          solutionAmount: 1n,
          verdictAmount: 2n,
        },
        derivation: derivation("TaskBudgetRefunded", 7),
      }),
      projectable({
        event: "TaskClosed",
        facts: { taskId: 42n, creator: CREATOR },
        derivation: derivation("TaskClosed", 8, "revised"),
      }),
    ];

    expect(projectObservations(events).map(({ type, data }) => ({ type, data }))).toEqual([
      {
        type: "network.jinn.task-execution.attempt-terminal.v1",
        data: { state: "rejected", category: "verdict-fail" },
      },
      {
        type: "network.jinn.task-execution.submission-closed.v1",
        data: { reason: "capacity" },
      },
      {
        type: "network.jinn.task-execution.attempt-terminal.v1",
        data: { state: "expired" },
      },
      {
        type: "network.jinn.task-execution.attempt-terminal.v1",
        data: { state: "cancelled" },
      },
      {
        type: "network.jinn.task-execution.submission-closed.v1",
        data: { reason: "requester-close" },
      },
      {
        type: "network.jinn.task-execution.submission-closed.v1",
        data: { reason: "requester-close" },
      },
    ]);
  });

  test("emits capacity closure at exhaustion and treats AttemptsAdded as a capacity fact, not a fake acceptance", () => {
    const task = projectable({
      event: "TaskCreated",
      facts: {
        creator: CREATOR,
        taskCidDigest: `0x${"7".repeat(64)}`,
        submissionDigest: `0x${"9".repeat(64)}`,
        taskId: 42n,
        maxTotal: 1,
        maxConcurrent: 1,
        submissionDeadline: 1_800_000_000n,
        closeAt: 0n,
        responseTimeout: 3600n,
        minVerdicts: 1,
        requireDistinctEvaluator: true,
        solutionMaxDeliveryRate: 10n,
        verdictMaxDeliveryRate: 20n,
        solutionBudget: 100n,
        verdictBudget: 20n,
      },
      derivation: derivation("TaskCreated", 0, "revised"),
    });
    const topUp = projectable({
      event: "AttemptsAdded",
      facts: { taskId: 42n, creator: CREATOR, added: 1, newMaxTotal: 2 },
      derivation: derivation("AttemptsAdded", 2, "revised"),
    });
    const revisedClaim = projectable({
      event: "TaskAttemptCreated",
      facts: {
        operator: OPERATOR,
        priorityMech: OPERATOR,
        requestId: REQUEST_ID,
        taskId: 42n,
        attemptIndex: 3,
        attemptDeadline: 1_800_000_000n,
        deliveryRate: 10n,
      },
      derivation: derivation("TaskAttemptCreated", 1, "revised"),
    });

    const output = projectObservations([task, revisedClaim, topUp]);
    expect(output.map(({ type }) => type)).toEqual([
      "network.jinn.task-execution.submission-accepted.v1",
      "network.jinn.task-execution.attempt-engaged.v1",
      "network.jinn.task-execution.submission-closed.v1",
    ]);
  });

  test("every emitted object conforms to the protocol observation schema", () => {
    const observations = projectObservations([claim, deliver(), solutionClaimed]);
    expect(observations.map((item) => ProtocolObservationSchema.safeParse(item).success)).toEqual(
      observations.map(() => true),
    );
  });
});
