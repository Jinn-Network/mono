import {
  JINN_ROUTER_V3_ABI,
  MECH_ABI,
} from "@jinn-network/marketplace-binding";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, test } from "vitest";
import {
  REVISED_PROJECTOR_EVENTS_ABI,
  decodeMarketplaceLogs,
  type MarketplaceRawLog,
} from "./events.js";

const ROUTER = "0x1111111111111111111111111111111111111111" satisfies Address;
const MECH = "0x2222222222222222222222222222222222222222" satisfies Address;
const OPERATOR = "0x3333333333333333333333333333333333333333" satisfies Address;
const PRIORITY_MECH = "0x4444444444444444444444444444444444444444" satisfies Address;
const CREATOR = "0x5555555555555555555555555555555555555555" satisfies Address;
const REQUEST_ID = `0x${"6".repeat(64)}` satisfies Hex;
const TX_HASH = `0x${"7".repeat(64)}` satisfies Hex;
const BLOCK_HASH = `0x${"8".repeat(64)}` satisfies Hex;

function log(input: {
  readonly address?: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}): MarketplaceRawLog {
  return {
    chainId: 84532,
    address: input.address ?? ROUTER,
    topics: input.topics,
    data: input.data,
    blockNumber: 99n,
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    logIndex: 2,
    finalityTier: "safe",
  };
}

function exactTopics(
  topics: readonly (Hex | readonly Hex[] | null)[],
): readonly Hex[] {
  return topics.map((topic) => {
    if (typeof topic !== "string") throw new TypeError("fixture topic must be a single encoded hex value");
    return topic;
  });
}

describe("decodeMarketplaceLogs", () => {
  test("decodes every remaining today-mode router event into its exact fact", () => {
    const taskCidDigest = `0x${"9".repeat(64)}` satisfies Hex;
    const manifestDigest = `0x${"a".repeat(64)}` satisfies Hex;
    const evaluator = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    const taskCreated = log({
      topics: exactTopics(encodeEventTopics({
        abi: JINN_ROUTER_V3_ABI,
        eventName: "TaskCreated",
        args: { creator: CREATOR, taskId: 42n, manifestDigest },
      })),
      data: encodeAbiParameters(
        [
          { name: "taskCidDigest", type: "bytes32" },
          { name: "maxClaims", type: "uint32" },
          { name: "solutionBudget", type: "uint256" },
          { name: "verdictBudget", type: "uint256" },
        ],
        [taskCidDigest, 5, 100n, 200n],
      ),
    });
    const evaluationCreated = log({
      topics: exactTopics(encodeEventTopics({
        abi: JINN_ROUTER_V3_ABI,
        eventName: "EvaluationAttemptCreated",
        args: { taskId: 42n, attemptIndex: 3, verdictIndex: 4 },
      })),
      data: encodeAbiParameters(
        [
          { name: "requestId", type: "bytes32" },
          { name: "evaluator", type: "address" },
          { name: "priorityMech", type: "address" },
          { name: "deliveryRate", type: "uint256" },
        ],
        [REQUEST_ID, evaluator, PRIORITY_MECH, 300n],
      ),
    });
    const solutionClaimed = log({
      topics: exactTopics(encodeEventTopics({
        abi: JINN_ROUTER_V3_ABI,
        eventName: "SolutionDeliveryClaimed",
        args: { operator: OPERATOR, requestId: REQUEST_ID, taskId: 42n },
      })),
      data: encodeAbiParameters(
        [{ name: "attemptIndex", type: "uint32" }],
        [3],
      ),
    });
    const verdictClaimed = log({
      topics: exactTopics(encodeEventTopics({
        abi: JINN_ROUTER_V3_ABI,
        eventName: "VerdictDeliveryClaimed",
        args: { evaluator, requestId: REQUEST_ID, taskId: 42n },
      })),
      data: encodeAbiParameters(
        [
          { name: "attemptIndex", type: "uint32" },
          { name: "verdictIndex", type: "uint32" },
          { name: "verdictCode", type: "uint8" },
        ],
        [3, 4, 1],
      ),
    });
    const budgetRefunded = log({
      topics: exactTopics(encodeEventTopics({
        abi: JINN_ROUTER_V3_ABI,
        eventName: "TaskBudgetRefunded",
        args: { taskId: 42n, creator: CREATOR },
      })),
      data: encodeAbiParameters(
        [
          { name: "solutionAmount", type: "uint256" },
          { name: "verdictAmount", type: "uint256" },
        ],
        [10n, 20n],
      ),
    });

    expect(
      decodeMarketplaceLogs([
        taskCreated,
        evaluationCreated,
        solutionClaimed,
        verdictClaimed,
        budgetRefunded,
      ], "today").map(({ event, facts }) => ({ event, facts })),
    ).toEqual([
      {
        event: "TaskCreated",
        facts: {
          creator: CREATOR,
          taskId: 42n,
          manifestDigest,
          taskCidDigest,
          maxClaims: 5,
          solutionBudget: 100n,
          verdictBudget: 200n,
        },
      },
      {
        event: "EvaluationAttemptCreated",
        facts: {
          taskId: 42n,
          attemptIndex: 3,
          verdictIndex: 4,
          requestId: REQUEST_ID,
          evaluator,
          priorityMech: PRIORITY_MECH,
          deliveryRate: 300n,
        },
      },
      {
        event: "SolutionDeliveryClaimed",
        facts: {
          operator: OPERATOR,
          requestId: REQUEST_ID,
          taskId: 42n,
          attemptIndex: 3,
        },
      },
      {
        event: "VerdictDeliveryClaimed",
        facts: {
          evaluator,
          requestId: REQUEST_ID,
          taskId: 42n,
          attemptIndex: 3,
          verdictIndex: 4,
          verdictCode: 1,
        },
      },
      {
        event: "TaskBudgetRefunded",
        facts: {
          taskId: 42n,
          creator: CREATOR,
          solutionAmount: 10n,
          verdictAmount: 20n,
        },
      },
    ]);
  });

  test("decodes the golden TaskAttemptCreated fact exactly", () => {
    const topics = encodeEventTopics({
      abi: JINN_ROUTER_V3_ABI,
      eventName: "TaskAttemptCreated",
      args: {
        taskId: 42n,
        attemptIndex: 3,
        requestId: REQUEST_ID,
      },
    });
    const data = encodeAbiParameters(
      [
        { name: "operator", type: "address" },
        { name: "priorityMech", type: "address" },
        { name: "deliveryRate", type: "uint256" },
      ],
      [OPERATOR, PRIORITY_MECH, 1000n],
    );

    expect(decodeMarketplaceLogs([log({ topics: exactTopics(topics), data })], "today")).toEqual([
      {
        event: "TaskAttemptCreated",
        facts: {
          taskId: 42n,
          attemptIndex: 3,
          operator: OPERATOR,
          requestId: REQUEST_ID,
          priorityMech: PRIORITY_MECH,
          deliveryRate: 1000n,
        },
        derivation: {
          chainId: 84532,
          contract: ROUTER,
          event: "TaskAttemptCreated",
          blockNumber: 99n,
          blockHash: BLOCK_HASH,
          txHash: TX_HASH,
          logIndex: 2,
          finalityTier: "safe",
          contractGeneration: "today",
        },
      },
    ]);
  });

  test("decodes the Mech Deliver fact with its exact request join key", () => {
    const topics = encodeEventTopics({
      abi: MECH_ABI,
      eventName: "Deliver",
      args: {
        mech: MECH,
        mechServiceMultisig: OPERATOR,
      },
    });
    const data = encodeAbiParameters(
      [
        { name: "requestId", type: "bytes32" },
        { name: "deliveryRate", type: "uint256" },
        { name: "data", type: "bytes" },
      ],
      [REQUEST_ID, 99n, "0x1234"],
    );

    expect(decodeMarketplaceLogs([
      log({ address: MECH, topics: exactTopics(topics), data }),
    ], "today")[0]).toEqual({
      event: "Deliver",
      facts: {
        mech: MECH,
        mechServiceMultisig: OPERATOR,
        requestId: REQUEST_ID,
        deliveryRate: 99n,
        data: "0x1234",
      },
      derivation: expect.objectContaining({
        contract: MECH,
        event: "Deliver",
        contractGeneration: "today",
      }),
    });
  });

  test.each([
    ["AttemptExpired", OPERATOR],
    ["AttemptReleased", OPERATOR],
  ] as const)("decodes revised-only %s with the frozen indexed fact triple", (eventName, operator) => {
    const topics = encodeEventTopics({
      abi: REVISED_PROJECTOR_EVENTS_ABI,
      eventName,
      args: { taskId: 42n, attemptIndex: 3, operator },
    });
    const revisedLog = log({ topics: exactTopics(topics), data: "0x" });

    expect(decodeMarketplaceLogs([revisedLog], "revised")).toEqual([
      {
        event: eventName,
        facts: { taskId: 42n, attemptIndex: 3, operator },
        derivation: expect.objectContaining({
          event: eventName,
          contractGeneration: "revised",
        }),
      },
    ]);
    expect(decodeMarketplaceLogs([revisedLog], "today")).toEqual([]);
  });

  test("decodes revised-only TaskClosed with its indexed creator party", () => {
    const topics = encodeEventTopics({
      abi: REVISED_PROJECTOR_EVENTS_ABI,
      eventName: "TaskClosed",
      args: { taskId: 42n, creator: CREATOR },
    });
    const revisedLog = log({ topics: exactTopics(topics), data: "0x" });

    expect(decodeMarketplaceLogs([revisedLog], "revised")).toEqual([
      {
        event: "TaskClosed",
        facts: { taskId: 42n, creator: CREATOR },
        derivation: expect.objectContaining({
          event: "TaskClosed",
          contractGeneration: "revised",
        }),
      },
    ]);
    expect(decodeMarketplaceLogs([revisedLog], "today")).toEqual([]);
  });

  test("ignores unknown logs instead of manufacturing event facts", () => {
    expect(
      decodeMarketplaceLogs([
        log({ topics: [`0x${"f".repeat(64)}`], data: "0x" }),
      ], "today"),
    ).toEqual([]);
  });

  test("rejects a malformed log whose topic claims a known event", () => {
    const topics = encodeEventTopics({
      abi: JINN_ROUTER_V3_ABI,
      eventName: "TaskAttemptCreated",
      args: {
        taskId: 42n,
        attemptIndex: 3,
        requestId: REQUEST_ID,
      },
    });
    expect(() =>
      decodeMarketplaceLogs([
        log({ topics: exactTopics(topics), data: "0x" }),
      ], "today")
    ).toThrow();
  });
});
