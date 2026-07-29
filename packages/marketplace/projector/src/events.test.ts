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
  REVISED_COMMON_PROJECTOR_EVENTS_ABI,
  REVISED_PROJECTOR_EVENTS_ABI,
  decodeMarketplaceLogs as decodeWithAuthority,
  marketplaceEventOriginAuthority,
  type MarketplaceRawLog,
} from "./events.js";
import {
  createMarketplaceProjectionState,
  reduceMarketplaceProjection,
  type ObservationProjectionContext,
} from "./observe.js";
import { BASE_SEPOLIA_TODAY } from "@jinn-network/marketplace-binding";

const ROUTER = "0x1111111111111111111111111111111111111111" satisfies Address;
const COORDINATOR = "0x9999999999999999999999999999999999999999" satisfies Address;
const MECH = "0x2222222222222222222222222222222222222222" satisfies Address;
const OPERATOR = "0x3333333333333333333333333333333333333333" satisfies Address;
const PRIORITY_MECH = "0x4444444444444444444444444444444444444444" satisfies Address;
const CREATOR = "0x5555555555555555555555555555555555555555" satisfies Address;
const REQUEST_ID = `0x${"6".repeat(64)}` satisfies Hex;
const TX_HASH = `0x${"7".repeat(64)}` satisfies Hex;
const BLOCK_HASH = `0x${"8".repeat(64)}` satisfies Hex;

const V4_TASK_CREATED_ABI = [{
  type: "event",
  name: "TaskCreated",
  inputs: [
    { name: "creator", type: "address", indexed: true },
    { name: "taskCidDigest", type: "bytes32", indexed: true },
    { name: "submissionDigest", type: "bytes32", indexed: true },
    { name: "taskId", type: "uint256", indexed: false },
    { name: "maxTotal", type: "uint32", indexed: false },
    { name: "maxConcurrent", type: "uint32", indexed: false },
    { name: "submissionDeadline", type: "uint64", indexed: false },
    { name: "closeAt", type: "uint64", indexed: false },
    { name: "responseTimeout", type: "uint64", indexed: false },
    { name: "minVerdicts", type: "uint32", indexed: false },
    { name: "requireDistinctEvaluator", type: "bool", indexed: false },
    { name: "solutionMaxDeliveryRate", type: "uint256", indexed: false },
    { name: "verdictMaxDeliveryRate", type: "uint256", indexed: false },
    { name: "solutionBudget", type: "uint256", indexed: false },
    { name: "verdictBudget", type: "uint256", indexed: false },
  ],
}] as const;

const V4_ATTEMPTS_ADDED_ABI = [{
  type: "event",
  name: "AttemptsAdded",
  inputs: [
    { name: "taskId", type: "uint256", indexed: true },
    { name: "creator", type: "address", indexed: true },
    { name: "added", type: "uint32", indexed: false },
    { name: "newMaxTotal", type: "uint32", indexed: false },
  ],
}] as const;

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

function decodeMarketplaceLogs(logs: readonly MarketplaceRawLog[], generation: "today" | "revised") {
  return decodeWithAuthority(logs, marketplaceEventOriginAuthority({
    ...BASE_SEPOLIA_TODAY,
    generation,
    jinnRouter: ROUTER,
    taskCoordinator: COORDINATOR,
    mechMarketplace: MECH,
  }, (address) => address.toLowerCase() === MECH.toLowerCase()));
}

function authority(generation: "today" | "revised", mechAuthorized = true) {
  return marketplaceEventOriginAuthority({
    ...BASE_SEPOLIA_TODAY,
    generation,
    jinnRouter: ROUTER,
    taskCoordinator: COORDINATOR,
    mechMarketplace: MECH,
  }, (address) => mechAuthorized && address.toLowerCase() === MECH.toLowerCase());
}

const PROJECTION: ObservationProjectionContext = {
  taskCoordinator: COORDINATOR,
  timestamp: "2026-07-29T12:00:00Z",
  submission: "urn:uuid:11111111-1111-4111-8111-111111111111",
  taskDigest: `sha256:${"7".repeat(64)}`,
  effectiveDeadline: "2026-07-30T12:00:00Z",
  dispatchContext: {
    uri: "urn:jinn:marketplace:dispatch-context:42:3",
    digest: { sha256: "8".repeat(64) },
  },
};

describe("decodeMarketplaceLogs", () => {
  test("isolates changed V3 and V4 router topics by contract generation", () => {
    const v3Topics = encodeEventTopics({
      abi: JINN_ROUTER_V3_ABI,
      eventName: "TaskCreated",
      args: {
        creator: CREATOR,
        taskId: 42n,
        manifestDigest: `0x${"9".repeat(64)}`,
      },
    });
    const v3Data = encodeAbiParameters(
      [
        { name: "taskCidDigest", type: "bytes32" },
        { name: "maxClaims", type: "uint32" },
        { name: "solutionBudget", type: "uint256" },
        { name: "verdictBudget", type: "uint256" },
      ],
      [`0x${"a".repeat(64)}`, 2, 100n, 20n],
    );

    const v4Topics = encodeEventTopics({
      abi: V4_TASK_CREATED_ABI,
      eventName: "TaskCreated",
      args: {
        creator: CREATOR,
        taskCidDigest: `0x${"a".repeat(64)}`,
        submissionDigest: `0x${"b".repeat(64)}`,
      },
    });
    const v4Data = encodeAbiParameters(
      V4_TASK_CREATED_ABI[0].inputs.filter((input) => !input.indexed),
      [
        42n,
        2,
        1,
        1_800_000_000n,
        1_800_000_100n,
        3600n,
        2,
        true,
        10n,
        20n,
        100n,
        200n,
      ],
    );

    expect(
      decodeMarketplaceLogs([
        log({ topics: exactTopics(v3Topics), data: v3Data }),
      ], "revised"),
    ).toEqual([]);
    expect(
      decodeMarketplaceLogs([
        log({ topics: exactTopics(v4Topics), data: v4Data }),
      ], "today"),
    ).toEqual([]);
    expect(
      decodeMarketplaceLogs([
        log({ topics: exactTopics(v4Topics), data: v4Data }),
      ], "revised").map(({ event, facts }) => ({ event, facts })),
    ).toEqual([
      {
        event: "TaskCreated",
        facts: {
          creator: CREATOR,
          taskCidDigest: `0x${"a".repeat(64)}`,
          submissionDigest: `0x${"b".repeat(64)}`,
          taskId: 42n,
          maxTotal: 2,
          maxConcurrent: 1,
          submissionDeadline: 1_800_000_000n,
          closeAt: 1_800_000_100n,
          responseTimeout: 3600n,
          minVerdicts: 2,
          requireDistinctEvaluator: true,
          solutionMaxDeliveryRate: 10n,
          verdictMaxDeliveryRate: 20n,
          solutionBudget: 100n,
          verdictBudget: 200n,
        },
      },
    ]);
  });

  test("decodes AttemptsAdded only in revised mode as a distinct capacity fact", () => {
    const topics = encodeEventTopics({
      abi: V4_ATTEMPTS_ADDED_ABI,
      eventName: "AttemptsAdded",
      args: { taskId: 42n, creator: CREATOR },
    });
    const data = encodeAbiParameters(
      V4_ATTEMPTS_ADDED_ABI[0].inputs.filter((input) => !input.indexed),
      [2, 5],
    );
    const capacityLog = log({ topics: exactTopics(topics), data });

    expect(decodeMarketplaceLogs([capacityLog], "today")).toEqual([]);
    expect(decodeMarketplaceLogs([capacityLog], "revised")).toEqual([
      {
        event: "AttemptsAdded",
        facts: {
          taskId: 42n,
          creator: CREATOR,
          added: 2,
          newMaxTotal: 5,
        },
        derivation: expect.objectContaining({
          event: "AttemptsAdded",
          contractGeneration: "revised",
        }),
      },
    ]);
  });

  test("decodes the remaining exact V4 common facts and rejects their topics in today mode", () => {
    const evaluator = getAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
    const deliveryDigest = `0x${"c".repeat(64)}` satisfies Hex;
    const evaluationDeliveryDigest = `0x${"d".repeat(64)}` satisfies Hex;

    const taskAttempt = log({
      topics: exactTopics(encodeEventTopics({
        abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI,
        eventName: "TaskAttemptCreated",
        args: { operator: OPERATOR, priorityMech: PRIORITY_MECH, requestId: REQUEST_ID },
      })),
      data: encodeAbiParameters(
        [
          { name: "taskId", type: "uint256" },
          { name: "attemptIndex", type: "uint32" },
          { name: "attemptDeadline", type: "uint64" },
          { name: "deliveryRate", type: "uint256" },
        ],
        [42n, 3, 1_800_000_000n, 100n],
      ),
    });
    const evaluationAttempt = log({
      topics: exactTopics(encodeEventTopics({
        abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI,
        eventName: "EvaluationAttemptCreated",
        args: { evaluator, priorityMech: PRIORITY_MECH, requestId: REQUEST_ID },
      })),
      data: encodeAbiParameters(
        [
          { name: "taskId", type: "uint256" },
          { name: "attemptIndex", type: "uint32" },
          { name: "verdictIndex", type: "uint32" },
          { name: "attemptDeadline", type: "uint64" },
          { name: "deliveryRate", type: "uint256" },
        ],
        [42n, 3, 4, 1_800_000_100n, 200n],
      ),
    });
    const solutionClaimed = log({
      topics: exactTopics(encodeEventTopics({
        abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI,
        eventName: "SolutionDeliveryClaimed",
        args: { operator: OPERATOR, requestId: REQUEST_ID, deliveryDigest },
      })),
      data: encodeAbiParameters(
        [
          { name: "taskId", type: "uint256" },
          { name: "attemptIndex", type: "uint32" },
        ],
        [42n, 3],
      ),
    });
    const verdictClaimed = log({
      topics: exactTopics(encodeEventTopics({
        abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI,
        eventName: "VerdictDeliveryClaimed",
        args: { evaluator, requestId: REQUEST_ID, evaluationDeliveryDigest },
      })),
      data: encodeAbiParameters(
        [
          { name: "taskId", type: "uint256" },
          { name: "attemptIndex", type: "uint32" },
          { name: "verdictIndex", type: "uint32" },
          { name: "verdictCode", type: "uint8" },
        ],
        [42n, 3, 4, 2],
      ),
    });
    const changedV4Logs = [
      taskAttempt,
      evaluationAttempt,
      solutionClaimed,
      verdictClaimed,
    ];

    expect(decodeMarketplaceLogs(changedV4Logs, "today")).toEqual([]);
    expect(
      decodeMarketplaceLogs(changedV4Logs, "revised").map(({ event, facts }) => ({ event, facts })),
    ).toEqual([
      {
        event: "TaskAttemptCreated",
        facts: {
          operator: OPERATOR,
          priorityMech: PRIORITY_MECH,
          requestId: REQUEST_ID,
          taskId: 42n,
          attemptIndex: 3,
          attemptDeadline: 1_800_000_000n,
          deliveryRate: 100n,
        },
      },
      {
        event: "EvaluationAttemptCreated",
        facts: {
          evaluator,
          priorityMech: PRIORITY_MECH,
          requestId: REQUEST_ID,
          taskId: 42n,
          attemptIndex: 3,
          verdictIndex: 4,
          attemptDeadline: 1_800_000_100n,
          deliveryRate: 200n,
        },
      },
      {
        event: "SolutionDeliveryClaimed",
        facts: {
          operator: OPERATOR,
          requestId: REQUEST_ID,
          deliveryDigest,
          taskId: 42n,
          attemptIndex: 3,
        },
      },
      {
        event: "VerdictDeliveryClaimed",
        facts: {
          evaluator,
          requestId: REQUEST_ID,
          evaluationDeliveryDigest,
          taskId: 42n,
          attemptIndex: 3,
          verdictIndex: 4,
          verdictCode: 2,
        },
      },
    ]);
  });

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
          blockNumber: 99,
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
    expect(decodeMarketplaceLogs([
      log({ address: MECH, topics: exactTopics(topics), data }),
    ], "revised")[0]).toEqual({
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
        contractGeneration: "revised",
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

  test("ignores ABI-shaped logs from unauthorized contract addresses", () => {
    const spoofed = getAddress("0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001");
    const taskCreatedTopics = encodeEventTopics({
      abi: JINN_ROUTER_V3_ABI,
      eventName: "TaskCreated",
      args: { creator: CREATOR, taskId: 42n, manifestDigest: `0x${"a".repeat(64)}` },
    });
    const taskCreatedData = encodeAbiParameters(
      [
        { name: "taskCidDigest", type: "bytes32" },
        { name: "maxClaims", type: "uint32" },
        { name: "solutionBudget", type: "uint256" },
        { name: "verdictBudget", type: "uint256" },
      ],
      [`0x${"9".repeat(64)}`, 5, 100n, 200n],
    );
    const attemptTopics = encodeEventTopics({
      abi: JINN_ROUTER_V3_ABI,
      eventName: "TaskAttemptCreated",
      args: { taskId: 42n, attemptIndex: 3, requestId: REQUEST_ID },
    });
    const attemptData = encodeAbiParameters(
      [
        { name: "operator", type: "address" },
        { name: "priorityMech", type: "address" },
        { name: "deliveryRate", type: "uint256" },
      ],
      [OPERATOR, PRIORITY_MECH, 10n],
    );

    expect(decodeWithAuthority([
      log({ address: spoofed, topics: exactTopics(taskCreatedTopics), data: taskCreatedData }),
      log({ address: COORDINATOR, topics: exactTopics(attemptTopics), data: attemptData }),
    ], authority("today"))).toEqual([]);
  });

  test.each([
    {
      generation: "today" as const,
      eventName: "TaskCreated",
      build: () => {
        const topics = encodeEventTopics({
          abi: JINN_ROUTER_V3_ABI,
          eventName: "TaskCreated",
          args: { creator: CREATOR, taskId: 42n, manifestDigest: `0x${"a".repeat(64)}` },
        });
        const data = encodeAbiParameters(
          [
            { name: "taskCidDigest", type: "bytes32" },
            { name: "maxClaims", type: "uint32" },
            { name: "solutionBudget", type: "uint256" },
            { name: "verdictBudget", type: "uint256" },
          ],
          [`0x${"9".repeat(64)}`, 5, 100n, 200n],
        );
        return log({ topics: exactTopics(topics), data });
      },
      contract: "router" as const,
    },
    {
      generation: "today" as const,
      eventName: "TaskAttemptCreated",
      build: () => {
        const topics = encodeEventTopics({
          abi: JINN_ROUTER_V3_ABI,
          eventName: "TaskAttemptCreated",
          args: { taskId: 42n, attemptIndex: 3, requestId: REQUEST_ID },
        });
        const data = encodeAbiParameters(
          [
            { name: "operator", type: "address" },
            { name: "priorityMech", type: "address" },
            { name: "deliveryRate", type: "uint256" },
          ],
          [OPERATOR, PRIORITY_MECH, 10n],
        );
        return log({ topics: exactTopics(topics), data });
      },
      contract: "router" as const,
    },
    {
      generation: "today" as const,
      eventName: "EvaluationAttemptCreated",
      build: () => {
        const topics = encodeEventTopics({
          abi: JINN_ROUTER_V3_ABI,
          eventName: "EvaluationAttemptCreated",
          args: { taskId: 42n, attemptIndex: 3, verdictIndex: 1 },
        });
        const data = encodeAbiParameters(
          [
            { name: "requestId", type: "bytes32" },
            { name: "evaluator", type: "address" },
            { name: "priorityMech", type: "address" },
            { name: "deliveryRate", type: "uint256" },
          ],
          [REQUEST_ID, OPERATOR, PRIORITY_MECH, 10n],
        );
        return log({ topics: exactTopics(topics), data });
      },
      contract: "router" as const,
    },
    {
      generation: "today" as const,
      eventName: "SolutionDeliveryClaimed",
      build: () => {
        const topics = encodeEventTopics({
          abi: JINN_ROUTER_V3_ABI,
          eventName: "SolutionDeliveryClaimed",
          args: { operator: OPERATOR, requestId: REQUEST_ID, taskId: 42n },
        });
        const data = encodeAbiParameters([{ name: "attemptIndex", type: "uint32" }], [3]);
        return log({ topics: exactTopics(topics), data });
      },
      contract: "router" as const,
    },
    {
      generation: "today" as const,
      eventName: "VerdictDeliveryClaimed",
      build: () => {
        const topics = encodeEventTopics({
          abi: JINN_ROUTER_V3_ABI,
          eventName: "VerdictDeliveryClaimed",
          args: { evaluator: OPERATOR, requestId: REQUEST_ID, taskId: 42n },
        });
        const data = encodeAbiParameters(
          [
            { name: "attemptIndex", type: "uint32" },
            { name: "verdictIndex", type: "uint32" },
            { name: "verdictCode", type: "uint8" },
          ],
          [3, 1, 1],
        );
        return log({ topics: exactTopics(topics), data });
      },
      contract: "router" as const,
    },
    {
      generation: "today" as const,
      eventName: "TaskBudgetRefunded",
      build: () => {
        const topics = encodeEventTopics({
          abi: JINN_ROUTER_V3_ABI,
          eventName: "TaskBudgetRefunded",
          args: { taskId: 42n, creator: CREATOR },
        });
        const data = encodeAbiParameters(
          [
            { name: "solutionAmount", type: "uint256" },
            { name: "verdictAmount", type: "uint256" },
          ],
          [10n, 20n],
        );
        return log({ topics: exactTopics(topics), data });
      },
      contract: "router" as const,
    },
    {
      generation: "today" as const,
      eventName: "Deliver",
      build: () => {
        const topics = encodeEventTopics({
          abi: MECH_ABI,
          eventName: "Deliver",
          args: { mech: MECH, mechServiceMultisig: OPERATOR },
        });
        const data = encodeAbiParameters(
          [
            { name: "requestId", type: "bytes32" },
            { name: "deliveryRate", type: "uint256" },
            { name: "data", type: "bytes" },
          ],
          [REQUEST_ID, 10n, `0x${"a".repeat(64)}`],
        );
        return log({ address: MECH, topics: exactTopics(topics), data });
      },
      contract: "mech" as const,
    },
    {
      generation: "revised" as const,
      eventName: "TaskCreated",
      build: () => {
        const topics = encodeEventTopics({
          abi: V4_TASK_CREATED_ABI,
          eventName: "TaskCreated",
          args: {
            creator: CREATOR,
            taskCidDigest: `0x${"a".repeat(64)}`,
            submissionDigest: `0x${"b".repeat(64)}`,
          },
        });
        const data = encodeAbiParameters(
          V4_TASK_CREATED_ABI[0].inputs.filter((input) => !input.indexed),
          [42n, 2, 1, 1_800_000_000n, 0n, 3600n, 1, true, 10n, 20n, 100n, 200n],
        );
        return log({ topics: exactTopics(topics), data });
      },
      contract: "router" as const,
    },
    {
      generation: "revised" as const,
      eventName: "TaskAttemptCreated",
      build: () => {
        const topics = encodeEventTopics({
          abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI,
          eventName: "TaskAttemptCreated",
          args: { operator: OPERATOR, priorityMech: PRIORITY_MECH, requestId: REQUEST_ID },
        });
        const data = encodeAbiParameters(
          [
            { name: "taskId", type: "uint256" },
            { name: "attemptIndex", type: "uint32" },
            { name: "attemptDeadline", type: "uint64" },
            { name: "deliveryRate", type: "uint256" },
          ],
          [42n, 3, 1_800_000_000n, 10n],
        );
        return log({ topics: exactTopics(topics), data });
      },
      contract: "router" as const,
    },
    {
      generation: "revised" as const,
      eventName: "EvaluationAttemptCreated",
      build: () => {
        const topics = encodeEventTopics({
          abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI,
          eventName: "EvaluationAttemptCreated",
          args: { evaluator: OPERATOR, priorityMech: PRIORITY_MECH, requestId: REQUEST_ID },
        });
        const data = encodeAbiParameters(
          [
            { name: "taskId", type: "uint256" },
            { name: "attemptIndex", type: "uint32" },
            { name: "verdictIndex", type: "uint32" },
            { name: "attemptDeadline", type: "uint64" },
            { name: "deliveryRate", type: "uint256" },
          ],
          [42n, 3, 1, 1_800_000_000n, 10n],
        );
        return log({ topics: exactTopics(topics), data });
      },
      contract: "router" as const,
    },
    {
      generation: "revised" as const,
      eventName: "SolutionDeliveryClaimed",
      build: () => {
        const topics = encodeEventTopics({
          abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI,
          eventName: "SolutionDeliveryClaimed",
          args: {
            operator: OPERATOR,
            requestId: REQUEST_ID,
            deliveryDigest: `0x${"c".repeat(64)}`,
          },
        });
        const data = encodeAbiParameters(
          [{ name: "taskId", type: "uint256" }, { name: "attemptIndex", type: "uint32" }],
          [42n, 3],
        );
        return log({ topics: exactTopics(topics), data });
      },
      contract: "router" as const,
    },
    {
      generation: "revised" as const,
      eventName: "VerdictDeliveryClaimed",
      build: () => {
        const topics = encodeEventTopics({
          abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI,
          eventName: "VerdictDeliveryClaimed",
          args: {
            evaluator: OPERATOR,
            requestId: REQUEST_ID,
            evaluationDeliveryDigest: `0x${"d".repeat(64)}`,
          },
        });
        const data = encodeAbiParameters(
          [
            { name: "taskId", type: "uint256" },
            { name: "attemptIndex", type: "uint32" },
            { name: "verdictIndex", type: "uint32" },
            { name: "verdictCode", type: "uint8" },
          ],
          [42n, 3, 1, 1],
        );
        return log({ topics: exactTopics(topics), data });
      },
      contract: "router" as const,
    },
    {
      generation: "revised" as const,
      eventName: "TaskBudgetRefunded",
      build: () => {
        const topics = encodeEventTopics({
          abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI,
          eventName: "TaskBudgetRefunded",
          args: { taskId: 42n, creator: CREATOR },
        });
        const data = encodeAbiParameters(
          [
            { name: "solutionAmount", type: "uint256" },
            { name: "verdictAmount", type: "uint256" },
          ],
          [10n, 20n],
        );
        return log({ topics: exactTopics(topics), data });
      },
      contract: "router" as const,
    },
    {
      generation: "revised" as const,
      eventName: "AttemptsAdded",
      build: () => {
        const topics = encodeEventTopics({
          abi: V4_ATTEMPTS_ADDED_ABI,
          eventName: "AttemptsAdded",
          args: { taskId: 42n, creator: CREATOR },
        });
        const data = encodeAbiParameters(
          [{ name: "added", type: "uint32" }, { name: "newMaxTotal", type: "uint32" }],
          [2, 5],
        );
        return log({ topics: exactTopics(topics), data });
      },
      contract: "router" as const,
    },
    {
      generation: "revised" as const,
      eventName: "AttemptExpired",
      build: () => {
        const topics = encodeEventTopics({
          abi: REVISED_PROJECTOR_EVENTS_ABI,
          eventName: "AttemptExpired",
          args: { taskId: 42n, attemptIndex: 3, operator: OPERATOR },
        });
        return log({ topics: exactTopics(topics), data: "0x" });
      },
      contract: "router" as const,
    },
    {
      generation: "revised" as const,
      eventName: "AttemptReleased",
      build: () => {
        const topics = encodeEventTopics({
          abi: REVISED_PROJECTOR_EVENTS_ABI,
          eventName: "AttemptReleased",
          args: { taskId: 42n, attemptIndex: 3, operator: OPERATOR },
        });
        return log({ topics: exactTopics(topics), data: "0x" });
      },
      contract: "router" as const,
    },
    {
      generation: "revised" as const,
      eventName: "TaskClosed",
      build: () => {
        const topics = encodeEventTopics({
          abi: REVISED_PROJECTOR_EVENTS_ABI,
          eventName: "TaskClosed",
          args: { taskId: 42n, creator: CREATOR },
        });
        return log({ topics: exactTopics(topics), data: "0x" });
      },
      contract: "router" as const,
    },
    {
      generation: "revised" as const,
      eventName: "Deliver",
      build: () => {
        const topics = encodeEventTopics({
          abi: MECH_ABI,
          eventName: "Deliver",
          args: { mech: MECH, mechServiceMultisig: OPERATOR },
        });
        const data = encodeAbiParameters(
          [
            { name: "requestId", type: "bytes32" },
            { name: "deliveryRate", type: "uint256" },
            { name: "data", type: "bytes" },
          ],
          [REQUEST_ID, 10n, `0x${"a".repeat(64)}`],
        );
        return log({ address: MECH, topics: exactTopics(topics), data });
      },
      contract: "mech" as const,
    },
  ])(
    "$generation $eventName accepts only its configured $contract origin",
    ({ generation, eventName, build, contract }) => {
      const sample = build();
      const positiveAddress = contract === "mech" ? MECH : ROUTER;
      const spoofed = getAddress("0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001");
      expect(decodeWithAuthority([
        log({ ...sample, address: positiveAddress }),
      ], authority(generation))).toEqual([
        expect.objectContaining({ event: eventName }),
      ]);
      expect(decodeWithAuthority([
        log({ ...sample, address: spoofed }),
      ], authority(generation))).toEqual([]);
      if (contract === "router") {
        expect(decodeWithAuthority([
          log({ ...sample, address: COORDINATOR }),
        ], authority(generation))).toEqual([]);
      } else {
        expect(decodeWithAuthority([
          log({ ...sample, address: ROUTER }),
        ], authority(generation))).toEqual([]);
        expect(decodeWithAuthority([
          log({ ...sample, address: MECH }),
        ], authority(generation, false))).toEqual([]);
      }
    },
  );

  test("decode→reduce drops hostile origins before reducer observations or bindings", () => {
    const taskCreatedTopics = encodeEventTopics({
      abi: JINN_ROUTER_V3_ABI,
      eventName: "TaskCreated",
      args: { creator: CREATOR, taskId: 42n, manifestDigest: `0x${"a".repeat(64)}` },
    });
    const taskCreatedData = encodeAbiParameters(
      [
        { name: "taskCidDigest", type: "bytes32" },
        { name: "maxClaims", type: "uint32" },
        { name: "solutionBudget", type: "uint256" },
        { name: "verdictBudget", type: "uint256" },
      ],
      [`0x${"9".repeat(64)}`, 5, 100n, 200n],
    );
    const attemptTopics = encodeEventTopics({
      abi: JINN_ROUTER_V3_ABI,
      eventName: "TaskAttemptCreated",
      args: { taskId: 42n, attemptIndex: 3, requestId: REQUEST_ID },
    });
    const attemptData = encodeAbiParameters(
      [
        { name: "operator", type: "address" },
        { name: "priorityMech", type: "address" },
        { name: "deliveryRate", type: "uint256" },
      ],
      [OPERATOR, PRIORITY_MECH, 10n],
    );
    const decoded = decodeWithAuthority([
      log({ address: ROUTER, topics: exactTopics(taskCreatedTopics), data: taskCreatedData }),
      log({ address: COORDINATOR, topics: exactTopics(attemptTopics), data: attemptData }),
    ], authority("today"));
    expect(decoded.map(({ event }) => event)).toEqual(["TaskCreated"]);
    const initial = createMarketplaceProjectionState();
    const reduced = reduceMarketplaceProjection(
      decoded.map((event) => ({ ...event, projection: PROJECTION })),
      initial,
    );
    expect(reduced.events.map(({ event }) => event)).toEqual(["TaskCreated"]);
    expect(reduced.events.some(({ event }) => event === "TaskAttemptCreated")).toBe(false);
    expect(reduced.refusals).toEqual([]);
    expect(reduced.state.requestIdBindings).toEqual({});
    expect(Object.keys(reduced.state.pendingMechDeliveries)).toHaveLength(0);
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
