import { deriveMarketplaceAttemptUri } from "@jinn-network/marketplace-binding";
import {
  DISCOVERY_SIGNING_SCOPE,
  formatOrigin,
  RECORD_DISCOVERY_VERSION,
} from "@jinn-network/record-discovery-protocol";
import {
  ProtocolObservationSchema,
  type ProtocolObservation,
} from "@jinn-network/task-execution-protocol";
import type { Address, Hex } from "viem";
import { describe, expect, test } from "vitest";
import { projectAnnouncements, type AnnouncementProjectionPorts } from "./announce.js";
import type { DerivationAnnotation } from "./derivation.js";
import type { MarketplaceEvent } from "./events.js";
import {
  createMarketplaceProjectionState,
  projectObservations,
  reduceMarketplaceProjection,
  type ObservationMarketplaceEvent,
  type ObservationProjectionContext,
} from "./observe.js";

const COORDINATOR = "0x1111111111111111111111111111111111111111" satisfies Address;
const ROUTER = "0x9999999999999999999999999999999999999999" satisfies Address;
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
  taskCoordinator: COORDINATOR,
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
    blockNumber: 100,
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
  event: string,
  generation: "today" | "revised" = "today",
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
    derivation: derivation(event, logIndex, generation),
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

const todayTaskCreated = projectable({
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
  test("keeps every nested caller state value isolated across accepted and refused lifecycle facts", () => {
    const initial = createMarketplaceProjectionState();
    const created = projectable({
      event: "TaskCreated",
      facts: {
        creator: CREATOR,
        taskCidDigest: `0x${"7".repeat(64)}`,
        submissionDigest: `0x${"d".repeat(64)}`,
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
      derivation: derivation("TaskCreated", 80, "revised"),
    });
    const createdTransition = reduceMarketplaceProjection([created], initial);
    const claim = projectable({
      event: "TaskAttemptCreated",
      facts: {
        taskId: 42n, attemptIndex: 1, operator: OPERATOR,
        requestId: REQUEST_ID, priorityMech: OPERATOR, attemptDeadline: 1_800_000_001n,
        deliveryRate: 10n,
      },
      derivation: derivation("TaskAttemptCreated", 81, "revised"),
    });
    const beforeClaim = structuredClone(createdTransition.state);
    const claimed = reduceMarketplaceProjection([claim], createdTransition.state);
    expect(createdTransition.state).toEqual(beforeClaim);
    expect(claimed.state.tasks).not.toBe(createdTransition.state.tasks);
    expect(claimed.state.tasks[Object.keys(claimed.state.tasks)[0]!]?.liveAttemptIndices)
      .not.toBe(createdTransition.state.tasks[Object.keys(createdTransition.state.tasks)[0]!]?.liveAttemptIndices);

    const release = projectable({
      event: "AttemptReleased",
      facts: { taskId: 42n, attemptIndex: 1, operator: OPERATOR },
      derivation: derivation("AttemptReleased", 82, "revised"),
    });
    const beforeRelease = structuredClone(claimed.state);
    const released = reduceMarketplaceProjection([release], claimed.state);
    expect(claimed.state).toEqual(beforeRelease);

    const expiry = projectable({
      event: "AttemptExpired",
      facts: { taskId: 42n, attemptIndex: 1, operator: OPERATOR },
      derivation: derivation("AttemptExpired", 83, "revised"),
    });
    const beforeRefusal = structuredClone(released.state);
    const refused = reduceMarketplaceProjection([expiry], released.state);
    expect(released.state).toEqual(beforeRefusal);
    expect(refused.events).toEqual([]);
    expect(refused.observations).toEqual([]);
    expect(refused.refusals.map(({ reason }) => reason)).toEqual(["attempt-not-live"]);
    expect({ ...refused.state, processedLogIds: [] }).toEqual({ ...released.state, processedLogIds: [] });

    const replay = reduceMarketplaceProjection([expiry], refused.state);
    expect(replay.events).toEqual([]);
    expect(replay.observations).toEqual([]);
    expect(replay.refusals).toEqual([]);
    expect(replay.state).toEqual(refused.state);
  });
  test.each(["today", "revised"] as const)(
    "derives %s Attempt subjects from the configured TaskCoordinator, never the emitting router",
    (generation) => {
      const routedClaim = projectable({
        event: "TaskAttemptCreated",
        facts: generation === "today"
          ? {
              taskId: 42n,
              attemptIndex: 3,
              operator: OPERATOR,
              requestId: REQUEST_ID,
              priorityMech: OPERATOR,
              deliveryRate: 10n,
            }
          : {
              taskId: 42n,
              attemptIndex: 3,
              operator: OPERATOR,
              requestId: REQUEST_ID,
              priorityMech: OPERATOR,
              deliveryRate: 10n,
              attemptDeadline: 1_800_000_000n,
            },
        derivation: {
          ...derivation("TaskAttemptCreated", 1, generation),
          contract: ROUTER,
        },
      } as MarketplaceEvent);

      const state = createMarketplaceProjectionState();
      state.tasks["84532:0x1111111111111111111111111111111111111111:42"] = {
        maxTotal: 2, liveAttemptIndices: {}, seenAttemptIndices: {},
        highestAttemptIndex: -1, availability: "open",
      };
      const observation = projectObservations([routedClaim], state)[0]!;
      expect(observation.subject).toBe(ATTEMPT);
      expect(observation.subject).not.toBe(deriveMarketplaceAttemptUri({
        chainId: 84532,
        coordinator: ROUTER,
        taskId: 42n,
        attemptIndex: 3,
      }));
    },
  );

  test("projects posting and claim into exact TEP observations using the protocol-owned Attempt URI", () => {
    expect(projectObservations([todayTaskCreated, claim])).toEqual([
      {
        ...base("network.jinn.task-execution.submission-accepted.v1", SUBMISSION, 1n, 0, "TaskCreated"),
        data: { submission: SUBMISSION, task: TASK_DIGEST },
      },
      {
        ...base("network.jinn.task-execution.attempt-engaged.v1", ATTEMPT, 1n, 1, "TaskAttemptCreated"),
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
    expect(projectObservations([todayTaskCreated, claim, deliver(), solutionClaimed]).at(-1)).toEqual({
      ...base("network.jinn.task-execution.delivery-recorded.v1", ATTEMPT, 2n, 3, "SolutionDeliveryClaimed"),
      data: { digest: `sha256:${"a".repeat(64)}` },
    });

    const mismatch = projectObservations([
      todayTaskCreated,
      claim,
      deliver(`0x${"c".repeat(64)}`),
      solutionClaimed,
    ]);
    expect(mismatch.at(-1)).toEqual({
      ...base("network.jinn.task-execution.attempt-terminal.v1", ATTEMPT, 2n, 3, "SolutionDeliveryClaimed"),
      data: {
        state: "rejected",
        category: "content-corruption",
        detail: "today-mode sha256↔keccak correspondence failed",
      },
    });
    expect(
      mismatch.some(({ type }) =>
        type === "network.jinn.task-execution.delivery-recorded.v1"
      ),
    ).toBe(false);
  });

  test("today mode refuses unknown-task and regressing attempt identity without observations", () => {
    const unknown = reduceMarketplaceProjection([claim], createMarketplaceProjectionState());
    expect(unknown).toEqual({
      state: {
        ...createMarketplaceProjectionState(),
        processedLogIds: [
          `${claim.derivation.chainId}:${claim.derivation.contract.toLowerCase()}:${claim.derivation.blockHash.toLowerCase()}:${claim.derivation.txHash.toLowerCase()}:${claim.derivation.logIndex}`,
        ],
      },
      events: [],
      observations: [],
      availabilityOpenedLogIds: [],
      refusals: [{
        kind: "marketplace-projection-refused",
        reason: "unknown-task",
        derivation: claim.derivation,
        taskId: 42n,
        attemptIndex: 3,
      }],
    });

    const admitted = reduceMarketplaceProjection([todayTaskCreated, claim], createMarketplaceProjectionState());
    const regressing = reduceMarketplaceProjection([
      {
        ...claim,
        facts: { ...claim.facts, attemptIndex: 2 },
        derivation: { ...claim.derivation, txHash: `0x${"c".repeat(64)}`, logIndex: 4 },
      } as ObservationMarketplaceEvent,
    ], admitted.state);
    expect(regressing.observations).toEqual([]);
    expect(regressing.refusals.map(({ reason }) => reason)).toEqual(["attempt-identity-regressing"]);
  });

  test.each([
    ["today", "task-attempt"] as const,
    ["revised", "task-attempt"] as const,
  ])("%s refuses same-family request-id reuse on a distinct log", (generation, _role) => {
    const task = generation === "today"
      ? todayTaskCreated
      : projectable({
          event: "TaskCreated",
          facts: {
            creator: CREATOR,
            taskCidDigest: `0x${"7".repeat(64)}`,
            submissionDigest: `0x${"d".repeat(64)}`,
            taskId: 42n,
            maxTotal: 2,
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
    const firstClaim = projectable({
      event: "TaskAttemptCreated",
      facts: generation === "today"
        ? {
            taskId: 42n, attemptIndex: 3, operator: OPERATOR, requestId: REQUEST_ID,
            priorityMech: OPERATOR, deliveryRate: 10n,
          }
        : {
            operator: OPERATOR, priorityMech: OPERATOR, requestId: REQUEST_ID,
            taskId: 42n, attemptIndex: 3, attemptDeadline: 1_800_000_000n, deliveryRate: 10n,
          },
      derivation: derivation("TaskAttemptCreated", 1, generation),
    } as MarketplaceEvent);
    const reuseClaim = {
      ...firstClaim,
      facts: { ...firstClaim.facts, attemptIndex: 4 },
      derivation: { ...firstClaim.derivation, txHash: `0x${"e".repeat(64)}`, logIndex: 5 },
    } as ObservationMarketplaceEvent;
    const admitted = reduceMarketplaceProjection([task, firstClaim], createMarketplaceProjectionState());
    const before = structuredClone(admitted.state);
    const refused = reduceMarketplaceProjection([reuseClaim], admitted.state);
    expect(refused).toEqual({
      state: {
        ...before,
        processedLogIds: [
          ...before.processedLogIds,
          `${reuseClaim.derivation.chainId}:${reuseClaim.derivation.contract.toLowerCase()}:${reuseClaim.derivation.blockHash.toLowerCase()}:${reuseClaim.derivation.txHash.toLowerCase()}:${reuseClaim.derivation.logIndex}`,
        ],
      },
      events: [],
      observations: [],
      availabilityOpenedLogIds: [],
      refusals: [{
        kind: "marketplace-projection-refused",
        reason: "request-id-reused",
        derivation: reuseClaim.derivation,
        taskId: 42n,
        attemptIndex: 4,
      }],
    });
    expect(admitted.state.requestIdBindings).toEqual({
      [`84532:${REQUEST_ID.toLowerCase()}`]: {
        taskId: 42n,
        attemptIndex: 3,
        role: "task-attempt",
      },
    });
  });

  test.each([
    ["today", "evaluation-attempt"] as const,
    ["revised", "evaluation-attempt"] as const,
  ])("%s refuses evaluation request-id reuse across distinct logs", (generation, _role) => {
    const task = generation === "today"
      ? todayTaskCreated
      : revisedTaskCreated();
    const parent = taskClaimFor(generation, 1);
    const firstEval = evaluationClaimFor(generation, 2);
    const reuseEval = {
      ...firstEval,
      facts: { ...firstEval.facts, verdictIndex: 1 },
      derivation: { ...firstEval.derivation, txHash: `0x${"f".repeat(64)}`, logIndex: 6 },
    } as ObservationMarketplaceEvent;
    const admitted = reduceMarketplaceProjection([task, parent, firstEval], createMarketplaceProjectionState());
    const refused = reduceMarketplaceProjection([reuseEval], admitted.state);
    expect(refused.observations).toEqual([]);
    expect(refused.refusals).toEqual([{
      kind: "marketplace-projection-refused",
      reason: "request-id-reused",
      derivation: reuseEval.derivation,
      taskId: 42n,
      attemptIndex: 3,
    }]);
  });

  test.each(["today", "revised"] as const)(
    "%s refuses cross-family request-id reuse between task and evaluation attempts",
    (generation) => {
      const task = generation === "today"
        ? todayTaskCreated
        : projectable({
            event: "TaskCreated",
            facts: {
              creator: CREATOR,
              taskCidDigest: `0x${"7".repeat(64)}`,
              submissionDigest: `0x${"d".repeat(64)}`,
              taskId: 42n,
              maxTotal: 2,
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
      const taskClaim = projectable({
        event: "TaskAttemptCreated",
        facts: generation === "today"
          ? {
              taskId: 42n, attemptIndex: 3, operator: OPERATOR, requestId: REQUEST_ID,
              priorityMech: OPERATOR, deliveryRate: 10n,
            }
          : {
              operator: OPERATOR, priorityMech: OPERATOR, requestId: REQUEST_ID,
              taskId: 42n, attemptIndex: 3, attemptDeadline: 1_800_000_000n, deliveryRate: 10n,
            },
        derivation: derivation("TaskAttemptCreated", 1, generation),
      } as MarketplaceEvent);
      const evalClaim = projectable({
        event: "EvaluationAttemptCreated",
        facts: generation === "today"
          ? {
              taskId: 42n, attemptIndex: 3, verdictIndex: 0, requestId: REQUEST_ID,
              evaluator: OPERATOR, priorityMech: OPERATOR, deliveryRate: 10n,
            }
          : {
              evaluator: OPERATOR, priorityMech: OPERATOR, requestId: REQUEST_ID,
              taskId: 42n, attemptIndex: 3, verdictIndex: 0,
              attemptDeadline: 1_800_000_000n, deliveryRate: 10n,
            },
        derivation: derivation("EvaluationAttemptCreated", 2, generation),
      } as MarketplaceEvent);
      const afterTask = reduceMarketplaceProjection([task, taskClaim], createMarketplaceProjectionState());
      const refused = reduceMarketplaceProjection([evalClaim], afterTask.state);
      expect(refused.refusals.map(({ reason }) => reason)).toEqual(["request-id-reused"]);
      expect(refused.observations).toEqual([]);
    },
  );

  test("persists request-id bindings across split batches", () => {
    const admitted = reduceMarketplaceProjection(
      [todayTaskCreated, claim],
      createMarketplaceProjectionState(),
    );
    const secondBatch = reduceMarketplaceProjection([
      {
        ...claim,
        facts: { ...claim.facts, attemptIndex: 4 },
        derivation: { ...claim.derivation, txHash: `0x${"a1".repeat(32)}`, logIndex: 7 },
      } as ObservationMarketplaceEvent,
    ], admitted.state);
    expect(secondBatch.refusals.map(({ reason }) => reason)).toEqual(["request-id-reused"]);
    expect(admitted.state.requestIdBindings[`84532:${REQUEST_ID.toLowerCase()}`]).toEqual({
      taskId: 42n,
      attemptIndex: 3,
      role: "task-attempt",
    });
  });

  function appendProcessedLogId(
    state: ReturnType<typeof createMarketplaceProjectionState>,
    event: ObservationMarketplaceEvent,
  ): string[] {
    const derivation = event.derivation;
    return [...state.processedLogIds, [
      derivation.chainId,
      derivation.contract.toLowerCase(),
      derivation.blockHash.toLowerCase(),
      derivation.txHash.toLowerCase(),
      derivation.logIndex,
    ].join(":")];
  }

  function expectRefusalTransition(
    before: ReturnType<typeof createMarketplaceProjectionState>,
    result: ReturnType<typeof reduceMarketplaceProjection>,
    event: ObservationMarketplaceEvent,
    reason: string,
  ): void {
    expect(result).toEqual({
      state: {
        ...before,
        processedLogIds: appendProcessedLogId(before, event),
      },
      events: [],
      observations: [],
      availabilityOpenedLogIds: [],
      refusals: [expect.objectContaining({
        kind: "marketplace-projection-refused",
        reason,
        derivation: event.derivation,
      })],
    });
  }

  function revisedTaskCreated(logIndex = 0, maxConcurrent = 1): ObservationMarketplaceEvent {
    return projectable({
      event: "TaskCreated",
      facts: {
        creator: CREATOR,
        taskCidDigest: `0x${"7".repeat(64)}`,
        submissionDigest: `0x${"d".repeat(64)}`,
        taskId: 42n,
        maxTotal: 2,
        maxConcurrent,
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
      derivation: derivation("TaskCreated", logIndex, "revised"),
    });
  }

  function stringifyProjectionState(state: unknown): string {
    return JSON.stringify(state, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  }

  function incrementalRefusalPorts(): AnnouncementProjectionPorts {
    const agent = "did:key:zProjectorObserveFixture";
    const name = "marketplace";
    const previousHead = {
      protocol: RECORD_DISCOVERY_VERSION,
      origin: formatOrigin(agent, name),
      sequence: "0000000000000005",
      entry: `sha256:${"1".repeat(64)}` as const,
      issuedAt: "2026-07-29T12:00:00Z",
      refreshBy: "2026-07-30T12:00:00Z",
    };
    let signCalls = 0;
    let storePutCalls = 0;
    let appendCalls = 0;
    const base: AnnouncementProjectionPorts = {
      source: { agent, name },
      signer: {
        scope: DISCOVERY_SIGNING_SCOPE,
        async sign() {
          signCalls += 1;
          return [{ keyid: agent, sig: new Uint8Array([1]) }];
        },
      },
      store: {
        async put() {
          storePutCalls += 1;
        },
      },
      clock: { now: () => new Date("2026-07-29T12:00:01Z") },
      factsRecompute: { get: () => undefined },
      referencedBytes: { async fetch() { return undefined; } },
      async verifyVerdictObservation() {
        return { gate: { decisionGrade: false, failures: [] } };
      },
      previousHead,
      previousEntryDigest: previousHead.entry,
      initialSequence: 6n,
      async appendArchiveEntries() {
        appendCalls += 1;
        return { pages: ["0000000000000001"] };
      },
      async resolvePriorAnnouncementId() { return undefined; },
      async resolveRecord() {
        throw new Error("resolveRecord must not run on evaluation refusal");
      },
    };
    return Object.assign(base, {
      __callCounts: () => ({ signCalls, storePutCalls, appendCalls }),
    });
  }

  function taskClaimFor(
    generation: "today" | "revised",
    logIndex: number,
    requestId: Hex = REQUEST_ID,
    attemptIndex = 3,
  ): ObservationMarketplaceEvent {
    return projectable({
      event: "TaskAttemptCreated",
      facts: generation === "today"
        ? {
            taskId: 42n, attemptIndex, operator: OPERATOR, requestId,
            priorityMech: OPERATOR, deliveryRate: 10n,
          }
        : {
            operator: OPERATOR, priorityMech: OPERATOR, requestId,
            taskId: 42n, attemptIndex, attemptDeadline: 1_800_000_000n, deliveryRate: 10n,
          },
      derivation: derivation("TaskAttemptCreated", logIndex, generation),
    } as MarketplaceEvent);
  }

  function evaluationClaimFor(
    generation: "today" | "revised",
    logIndex: number,
    options: {
      readonly requestId?: Hex;
      readonly verdictIndex?: number;
      readonly attemptIndex?: number;
    } = {},
  ): ObservationMarketplaceEvent {
    const requestId = options.requestId ?? `0x${"e".repeat(64)}` as Hex;
    const verdictIndex = options.verdictIndex ?? 0;
    const attemptIndex = options.attemptIndex ?? 3;
    return projectable({
      event: "EvaluationAttemptCreated",
      facts: generation === "today"
        ? {
            taskId: 42n, attemptIndex, verdictIndex, requestId,
            evaluator: OPERATOR, priorityMech: OPERATOR, deliveryRate: 10n,
          }
        : {
            evaluator: OPERATOR, priorityMech: OPERATOR, requestId,
            taskId: 42n, attemptIndex, verdictIndex,
            attemptDeadline: 1_800_000_000n, deliveryRate: 10n,
          },
      derivation: derivation("EvaluationAttemptCreated", logIndex, generation),
    } as MarketplaceEvent);
  }

  test.each(["today", "revised"] as const)(
    "%s refuses evaluation before parent TaskAttemptCreated with attempt-not-live",
    (generation) => {
      const task = generation === "today" ? todayTaskCreated : revisedTaskCreated();
      const evalClaim = evaluationClaimFor(generation, 2);
      const before = reduceMarketplaceProjection([task], createMarketplaceProjectionState()).state;
      const refused = reduceMarketplaceProjection([evalClaim], before);
      expectRefusalTransition(before, refused, evalClaim, "attempt-not-live");
      expect(refused.state.evaluationIdentities).toEqual({});
      expect(refused.state.requestIdBindings).toEqual({});
    },
  );

  test.each([
    ["revised", "AttemptReleased"] as const,
    ["revised", "AttemptExpired"] as const,
  ])("%s refuses evaluation after parent %s", (generation, lifecycleEvent) => {
    const task = revisedTaskCreated();
    const parent = taskClaimFor(generation, 1);
    const lifecycle = projectable({
      event: lifecycleEvent,
      facts: { taskId: 42n, attemptIndex: 3, operator: OPERATOR },
      derivation: derivation(lifecycleEvent, 2, generation),
    });
    const afterLifecycle = reduceMarketplaceProjection(
      [task, parent, lifecycle],
      createMarketplaceProjectionState(),
    );
    const evalClaim = evaluationClaimFor(generation, 3, {
      requestId: `0x${"f1".repeat(32)}` as Hex,
    });
    const refused = reduceMarketplaceProjection([evalClaim], afterLifecycle.state);
    expectRefusalTransition(afterLifecycle.state, refused, evalClaim, "attempt-not-live");
    expect(refused.state.evaluationIdentities).toEqual({});
  });

  test.each([
    ["today", "VerdictDeliveryClaimed"] as const,
    ["revised", "TaskBudgetRefunded"] as const,
    ["revised", "TaskClosed"] as const,
  ])("%s refuses evaluation after terminal task cause via %s", (generation, terminalEvent) => {
    const task = generation === "today" ? todayTaskCreated : revisedTaskCreated();
    const parent = taskClaimFor(generation, 1);
    const terminal = terminalEvent === "VerdictDeliveryClaimed"
      ? projectable({
          event: "VerdictDeliveryClaimed",
          facts: {
            evaluator: OPERATOR, taskId: 42n, attemptIndex: 3, verdictIndex: 0,
            requestId: REQUEST_ID, verdictCode: 1,
          },
          derivation: derivation(terminalEvent, 2, generation),
        })
      : terminalEvent === "TaskBudgetRefunded"
      ? projectable({
          event: "TaskBudgetRefunded",
          facts: { taskId: 42n, creator: CREATOR, solutionAmount: 1n, verdictAmount: 1n },
          derivation: derivation(terminalEvent, 2, generation),
        })
      : projectable({
          event: "TaskClosed",
          facts: { taskId: 42n, creator: CREATOR },
          derivation: derivation(terminalEvent, 2, generation),
        });
    const closed = reduceMarketplaceProjection(
      [task, parent, terminal],
      createMarketplaceProjectionState(),
    );
    const evalClaim = evaluationClaimFor(generation, 3, {
      requestId: `0x${"f2".repeat(32)}` as Hex,
    });
    const refused = reduceMarketplaceProjection([evalClaim], closed.state);
    expectRefusalTransition(closed.state, refused, evalClaim, "task-closed");
    expect(refused.state.evaluationIdentities).toEqual({});
  });

  test.each(["today", "revised"] as const)(
    "%s refuses duplicate verdict slot with fresh request ID",
    (generation) => {
      const task = generation === "today" ? todayTaskCreated : revisedTaskCreated();
      const parent = taskClaimFor(generation, 1);
      const firstEval = evaluationClaimFor(generation, 2, {
        requestId: `0x${"a2".repeat(32)}` as Hex,
        verdictIndex: 1,
      });
      const admitted = reduceMarketplaceProjection(
        [task, parent, firstEval],
        createMarketplaceProjectionState(),
      );
      const duplicate = {
        ...evaluationClaimFor(generation, 3, {
          requestId: `0x${"b2".repeat(32)}` as Hex,
          verdictIndex: 1,
        }),
      } as ObservationMarketplaceEvent;
      const refused = reduceMarketplaceProjection([duplicate], admitted.state);
      expectRefusalTransition(admitted.state, refused, duplicate, "attempt-identity-regressing");
      expect(admitted.state.evaluationIdentities).toEqual({
        [`84532:${COORDINATOR.toLowerCase()}:42:3`]: {
          seenVerdictIndices: { "1": true },
          highestVerdictIndex: 1,
        },
      });
    },
  );

  test.each(["today", "revised"] as const)(
    "%s refuses regressing verdict index after a higher accepted slot",
    (generation) => {
      const task = generation === "today" ? todayTaskCreated : revisedTaskCreated();
      const parent = taskClaimFor(generation, 1);
      const firstEval = evaluationClaimFor(generation, 2, {
        requestId: `0x${"a3".repeat(32)}` as Hex,
        verdictIndex: 2,
      });
      const admitted = reduceMarketplaceProjection(
        [task, parent, firstEval],
        createMarketplaceProjectionState(),
      );
      const regressing = {
        ...evaluationClaimFor(generation, 3, {
          requestId: `0x${"b3".repeat(32)}` as Hex,
          verdictIndex: 1,
        }),
      } as ObservationMarketplaceEvent;
      const refused = reduceMarketplaceProjection([regressing], admitted.state);
      expectRefusalTransition(admitted.state, refused, regressing, "attempt-identity-regressing");
    },
  );

  test.each(["today", "revised"] as const)(
    "%s accepts one valid evaluation after a live parent without observations",
    (generation) => {
      const task = generation === "today" ? todayTaskCreated : revisedTaskCreated();
      const parent = taskClaimFor(generation, 1);
      const evalClaim = evaluationClaimFor(generation, 2, {
        requestId: `0x${"c3".repeat(32)}` as Hex,
        verdictIndex: 0,
      });
      const afterParent = reduceMarketplaceProjection(
        [task, parent],
        createMarketplaceProjectionState(),
      );
      const result = reduceMarketplaceProjection([evalClaim], afterParent.state);
      expect(result.observations).toEqual([]);
      expect(result.refusals).toEqual([]);
      expect(result.events).toEqual([evalClaim]);
      expect(result.state.evaluationIdentities).toEqual({
        [`84532:${COORDINATOR.toLowerCase()}:42:3`]: {
          seenVerdictIndices: { "0": true },
          highestVerdictIndex: 0,
        },
      });
      expect(result.state.requestIdBindings[`84532:0x${"c3".repeat(32)}`]).toEqual({
        taskId: 42n,
        attemptIndex: 3,
        role: "evaluation-attempt",
        verdictIndex: 0,
      });
    },
  );

  test.each(["today", "revised"] as const)(
    "%s persists evaluation identity across split batches",
    (generation) => {
      const task = generation === "today" ? todayTaskCreated : revisedTaskCreated();
      const parent = taskClaimFor(generation, 1);
      const firstBatch = reduceMarketplaceProjection(
        [task, parent],
        createMarketplaceProjectionState(),
      );
      const firstEval = evaluationClaimFor(generation, 2, {
        requestId: `0x${"d3".repeat(32)}` as Hex,
        verdictIndex: 0,
      });
      const admitted = reduceMarketplaceProjection([firstEval], firstBatch.state);
      const duplicate = {
        ...evaluationClaimFor(generation, 3, {
          requestId: `0x${"e3".repeat(32)}` as Hex,
          verdictIndex: 0,
        }),
      } as ObservationMarketplaceEvent;
      const refused = reduceMarketplaceProjection([duplicate], admitted.state);
      expectRefusalTransition(admitted.state, refused, duplicate, "attempt-identity-regressing");
    },
  );

  test.each(["today", "revised"] as const)(
    "%s exact-log evaluation replay is idempotent",
    (generation) => {
      const task = generation === "today" ? todayTaskCreated : revisedTaskCreated();
      const parent = taskClaimFor(generation, 1);
      const evalClaim = evaluationClaimFor(generation, 2);
      const first = reduceMarketplaceProjection(
        [task, parent, evalClaim],
        createMarketplaceProjectionState(),
      );
      const replay = reduceMarketplaceProjection([evalClaim], first.state);
      expect(replay).toEqual({
        state: first.state,
        events: [],
        observations: [],
        availabilityOpenedLogIds: [],
        refusals: [],
      });
    },
  );

  test.each(["today", "revised"] as const)(
    "%s preserves caller-owned state across sequential evaluation accepts (§7.72)",
    (generation) => {
      const task = generation === "today" ? todayTaskCreated : revisedTaskCreated();
      const parent = taskClaimFor(generation, 1);
      const afterParent = reduceMarketplaceProjection(
        [task, parent],
        createMarketplaceProjectionState(),
      );
      const callerState = afterParent.state;
      const snapshotBefore = stringifyProjectionState(callerState);
      const parentKey = `84532:${COORDINATOR.toLowerCase()}:42:3`;

      const eval0 = evaluationClaimFor(generation, 2, {
        requestId: `0x${"v0".repeat(32)}` as Hex,
        verdictIndex: 0,
      });
      const result0 = reduceMarketplaceProjection([eval0], callerState);
      expect(stringifyProjectionState(callerState)).toBe(snapshotBefore);
      expect(result0.state.evaluationIdentities).not.toBe(callerState.evaluationIdentities);
      const parentIdentity0 = result0.state.evaluationIdentities[parentKey]!;
      const seen0 = parentIdentity0.seenVerdictIndices;

      const eval1 = evaluationClaimFor(generation, 3, {
        requestId: `0x${"v1".repeat(32)}` as Hex,
        verdictIndex: 1,
      });
      const result1 = reduceMarketplaceProjection([eval1], result0.state);
      expect(seen0).toEqual({ "0": true });
      expect(result1.state.evaluationIdentities).not.toBe(result0.state.evaluationIdentities);
      expect(result1.state.evaluationIdentities[parentKey]).not.toBe(parentIdentity0);
      expect(result1.state.evaluationIdentities[parentKey]!.seenVerdictIndices).not.toBe(seen0);
      expect(result1.state.evaluationIdentities[parentKey]!.seenVerdictIndices).toEqual({
        "0": true,
        "1": true,
      });
    },
  );

  test.each(["today", "revised"] as const)(
    "%s evaluation refusal emits no announce/sign/archive side effects",
    async (generation) => {
      const task = generation === "today" ? todayTaskCreated : revisedTaskCreated();
      const evalClaim = evaluationClaimFor(generation, 2);
      const before = reduceMarketplaceProjection([task], createMarketplaceProjectionState()).state;
      const refused = reduceMarketplaceProjection([evalClaim], before);
      expectRefusalTransition(before, refused, evalClaim, "attempt-not-live");

      const ports = incrementalRefusalPorts() as AnnouncementProjectionPorts & {
        __callCounts: () => { signCalls: number; storePutCalls: number; appendCalls: number };
      };
      const previousHead = ports.previousHead;
      const announced = await projectAnnouncements(refused, ports);
      expect(announced.announcements).toEqual([]);
      expect(announced.entries).toEqual([]);
      expect(announced.pages).toEqual([]);
      expect(announced.refusals).toEqual([]);
      expect(announced.head).toBe(previousHead);
      const counts = ports.__callCounts();
      expect(counts.signCalls).toBe(0);
      expect(counts.storePutCalls).toBe(0);
      expect(counts.appendCalls).toBe(0);
    },
  );

  test.each(["today", "revised"] as const)(
    "%s isolates evaluation identity per parent attempt index",
    (generation) => {
      const task = generation === "today"
        ? todayTaskCreated
        : revisedTaskCreated(0, 2);
      const parent3 = taskClaimFor(generation, 1, `0x${"p3".repeat(32)}` as Hex, 3);
      const parent4 = taskClaimFor(generation, 2, `0x${"p4".repeat(32)}` as Hex, 4);
      const afterParents = reduceMarketplaceProjection(
        [task, parent3, parent4],
        createMarketplaceProjectionState(),
      );
      const eval3 = evaluationClaimFor(generation, 3, {
        attemptIndex: 3,
        requestId: `0x${"e3".repeat(32)}` as Hex,
        verdictIndex: 0,
      });
      const eval4 = evaluationClaimFor(generation, 4, {
        attemptIndex: 4,
        requestId: `0x${"e4".repeat(32)}` as Hex,
        verdictIndex: 0,
      });
      const afterEval3 = reduceMarketplaceProjection([eval3], afterParents.state);
      const afterBoth = reduceMarketplaceProjection([eval4], afterEval3.state);
      const key3 = `84532:${COORDINATOR.toLowerCase()}:42:3`;
      const key4 = `84532:${COORDINATOR.toLowerCase()}:42:4`;
      expect(afterBoth.state.evaluationIdentities[key3]).toEqual({
        seenVerdictIndices: { "0": true },
        highestVerdictIndex: 0,
      });
      expect(afterBoth.state.evaluationIdentities[key4]).toEqual({
        seenVerdictIndices: { "0": true },
        highestVerdictIndex: 0,
      });
      expect(afterBoth.observations).toEqual([]);
      const duplicate3 = {
        ...evaluationClaimFor(generation, 5, {
          attemptIndex: 3,
          requestId: `0x${"d3".repeat(32)}` as Hex,
          verdictIndex: 0,
        }),
        derivation: {
          ...evaluationClaimFor(generation, 5, {
            attemptIndex: 3,
            requestId: `0x${"d3".repeat(32)}` as Hex,
            verdictIndex: 0,
          }).derivation,
          txHash: `0x${"x3".repeat(32)}` as Hex,
        },
      } as ObservationMarketplaceEvent;
      const refused = reduceMarketplaceProjection([duplicate3], afterBoth.state);
      expectRefusalTransition(afterBoth.state, refused, duplicate3, "attempt-identity-regressing");
      expect(refused.state.evaluationIdentities[key4]).toEqual(
        afterBoth.state.evaluationIdentities[key4],
      );
    },
  );

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

    const state = createMarketplaceProjectionState();
    state.tasks["84532:0x1111111111111111111111111111111111111111:42"] = {
      maxTotal: 2, liveAttemptIndices: {}, seenAttemptIndices: {},
      highestAttemptIndex: -1, availability: "open",
    };
    expect(
      projectObservations([revisedClaim, operationalMechJoin, revisedSolution], state).at(-1),
    ).toEqual({
      ...base("network.jinn.task-execution.delivery-recorded.v1", ATTEMPT, 2n, 3, "SolutionDeliveryClaimed", "revised"),
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

    const state = createMarketplaceProjectionState();
    state.tasks["84532:0x1111111111111111111111111111111111111111:42"] = {
      maxTotal: 2, liveAttemptIndices: { "3": true }, seenAttemptIndices: { "3": true },
      highestAttemptIndex: 3, availability: "open",
    };
    expect(projectObservations(events, state).map(({ type, data }) => ({ type, data }))).toEqual([
      {
        type: "network.jinn.task-execution.attempt-terminal.v1",
        data: { state: "rejected", detail: "verdict-fail" },
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
        type: "network.jinn.task-execution.submission-closed.v1",
        data: { reason: "requester-close" },
      },
      {
        type: "network.jinn.task-execution.submission-closed.v1",
        data: { reason: "requester-close" },
      },
    ]);
  });

  test.each([
    [0, { state: "rejected", category: "protocol-violation" }],
    [1, { state: "delivered" }],
    [2, { state: "rejected", detail: "verdict-fail" }],
    [3, { state: "rejected", category: "protocol-violation" }],
    [4, { state: "failed", category: "result-unavailable" }],
    [5, { state: "rejected", category: "protocol-violation" }],
  ] as const)("maps verdict code %i to its complete frozen terminal output", (verdictCode, expected) => {
    const verdict = projectable({
      event: "VerdictDeliveryClaimed",
      facts: {
        evaluator: OPERATOR,
        requestId: REQUEST_ID,
        taskId: 42n,
        attemptIndex: 3,
        verdictIndex: 1,
        verdictCode,
      },
      derivation: derivation("VerdictDeliveryClaimed", 40 + verdictCode, "revised"),
    });
    const output = projectObservations([verdict]);
    expect(output).toEqual([
      {
        ...base(
          "network.jinn.task-execution.attempt-terminal.v1",
          ATTEMPT,
          1n,
          40 + verdictCode,
          "VerdictDeliveryClaimed",
          "revised",
        ),
        data: expected,
      },
      {
        ...base(
          "network.jinn.task-execution.submission-closed.v1",
          SUBMISSION,
          1n,
          40 + verdictCode,
          "VerdictDeliveryClaimed",
          "revised",
        ),
        data: { reason: "capacity" },
      },
    ]);
  });

  test("digest-rejected revised creation is a non-reopenable tombstone across claim then release", () => {
    const rejectedCreation = projectable({
      event: "TaskCreated",
      facts: {
        creator: CREATOR, taskCidDigest: `0x${"0".repeat(64)}`,
        submissionDigest: `0x${"d".repeat(64)}`, taskId: 42n, maxTotal: 1,
        maxConcurrent: 1, submissionDeadline: 1_800_000_000n, closeAt: 0n,
        responseTimeout: 3600n, minVerdicts: 1, requireDistinctEvaluator: true,
        solutionMaxDeliveryRate: 10n, verdictMaxDeliveryRate: 20n,
        solutionBudget: 100n, verdictBudget: 20n,
      },
      derivation: derivation("TaskCreated", 90, "revised"),
    });
    const revisedClaim = projectable({
      event: "TaskAttemptCreated",
      facts: {
        taskId: 42n, attemptIndex: 3, operator: OPERATOR, requestId: REQUEST_ID,
        priorityMech: OPERATOR, attemptDeadline: 1_800_000_000n, deliveryRate: 10n,
      },
      derivation: derivation("TaskAttemptCreated", 91, "revised"),
    });
    const release = projectable({
      event: "AttemptReleased",
      facts: { taskId: 42n, attemptIndex: 3, operator: OPERATOR },
      derivation: derivation("AttemptReleased", 92, "revised"),
    });

    const created = reduceMarketplaceProjection([rejectedCreation], createMarketplaceProjectionState());
    expect(created).toEqual({
      state: {
        processedLogIds: [`84532:${COORDINATOR}:${BLOCK_HASH}:${TX_HASH}:90`],
        processedCorrectionIds: [],
        requestIdBindings: {},
        evaluationIdentities: {},
        sequenceBySourceSubject: {
          [`${SOURCE.length}:${SOURCE}${SUBMISSION}`]: "0000000000000001",
        },
        tasks: {
          "84532:0x1111111111111111111111111111111111111111:42": {
            admission: "rejected",
            rejection: {
              category: "content-corruption",
              derivation: derivation("TaskCreated", 90, "revised"),
            },
          },
        },
        pendingMechDeliveries: {},
      },
      events: [rejectedCreation],
      observations: [{
        ...base("network.jinn.task-execution.submission-rejected.v1", SUBMISSION, 1n, 90, "TaskCreated", "revised"),
        data: {
          category: "content-corruption",
          detail: "TaskCreated task digest does not match resolved signed Submission task digest",
        },
      }],
      availabilityOpenedLogIds: [],
      refusals: [],
    });

    const claimed = reduceMarketplaceProjection([revisedClaim], created.state);
    const released = reduceMarketplaceProjection([release], claimed.state);
    expect(claimed).toEqual({
      state: {
        ...created.state,
        processedLogIds: [...created.state.processedLogIds, `84532:${COORDINATOR}:${BLOCK_HASH}:${TX_HASH}:91`],
      },
      events: [], observations: [], availabilityOpenedLogIds: [],
      refusals: [{
        kind: "marketplace-projection-refused",
        reason: "task-not-admissible",
        derivation: derivation("TaskAttemptCreated", 91, "revised"),
        taskId: 42n,
        attemptIndex: 3,
      }],
    });
    expect(released).toEqual({
      state: {
        ...claimed.state,
        processedLogIds: [...claimed.state.processedLogIds, `84532:${COORDINATOR}:${BLOCK_HASH}:${TX_HASH}:92`],
      },
      events: [], observations: [], availabilityOpenedLogIds: [],
      refusals: [{
        kind: "marketplace-projection-refused",
        reason: "task-not-admissible",
        derivation: derivation("AttemptReleased", 92, "revised"),
        taskId: 42n,
        attemptIndex: 3,
      }],
    });
  });

  test("a rejected today Task tombstone dominates every task-scoped lifecycle fact but keeps Deliver unbound", () => {
    const rejected = projectable({
      event: "TaskCreated",
      facts: {
        creator: CREATOR, taskCidDigest: `0x${"0".repeat(64)}`,
        taskId: 42n, manifestDigest: `0x${"1".repeat(64)}`, maxClaims: 1,
        solutionBudget: 100n, verdictBudget: 20n,
      },
      derivation: derivation("TaskCreated", 110),
    });
    const state = reduceMarketplaceProjection([rejected], createMarketplaceProjectionState()).state;
    const verdict = projectable({
      event: "VerdictDeliveryClaimed",
      facts: { evaluator: OPERATOR, taskId: 42n, attemptIndex: 3, verdictIndex: 0, requestId: REQUEST_ID, verdictCode: 1 },
      derivation: derivation("VerdictDeliveryClaimed", 114),
    });
    const refund = projectable({
      event: "TaskBudgetRefunded",
      facts: { taskId: 42n, creator: CREATOR, solutionAmount: 1n, verdictAmount: 1n },
      derivation: derivation("TaskBudgetRefunded", 115),
    });
    const evaluation = projectable({
      event: "EvaluationAttemptCreated",
      facts: { taskId: 42n, attemptIndex: 3, verdictIndex: 0, evaluator: OPERATOR, priorityMech: OPERATOR, requestId: REQUEST_ID, deliveryRate: 1n },
      derivation: derivation("EvaluationAttemptCreated", 116),
    });
    const result = reduceMarketplaceProjection([
      claim,
      deliver(),
      solutionClaimed,
      verdict,
      refund,
      evaluation,
    ], state);

    expect(result.events).toEqual([expect.objectContaining({ event: "Deliver" })]);
    expect(result.observations).toEqual([]);
    expect(result.availabilityOpenedLogIds).toEqual([]);
    expect(result.refusals).toEqual([
      expect.objectContaining({ reason: "task-not-admissible", taskId: 42n, attemptIndex: 3 }),
      expect.objectContaining({ reason: "task-not-admissible", taskId: 42n, attemptIndex: 3 }),
      expect.objectContaining({ reason: "task-not-admissible", taskId: 42n, attemptIndex: 3 }),
      expect.objectContaining({ reason: "task-not-admissible", taskId: 42n }),
      expect.objectContaining({ reason: "task-not-admissible", taskId: 42n, attemptIndex: 3 }),
    ]);
    expect(Object.keys(result.state.pendingMechDeliveries)).toHaveLength(1);
  });

  test.each([
    ["finalized", "VerdictDeliveryClaimed", "AttemptReleased"],
    ["refunded", "TaskBudgetRefunded", "AttemptExpired"],
  ] as const)(
    "%s is a permanent Task terminal cause while a live Attempt may finish",
    (_cause, terminalEvent, lifecycleEvent) => {
      const task = projectable({
        event: "TaskCreated",
        facts: {
          creator: CREATOR, taskCidDigest: `0x${"7".repeat(64)}`,
          submissionDigest: `0x${"d".repeat(64)}`, taskId: 42n, maxTotal: 1,
          maxConcurrent: 1, submissionDeadline: 1_800_000_000n, closeAt: 0n,
          responseTimeout: 3600n, minVerdicts: 1, requireDistinctEvaluator: true,
          solutionMaxDeliveryRate: 10n, verdictMaxDeliveryRate: 20n,
          solutionBudget: 100n, verdictBudget: 20n,
        },
        derivation: derivation("TaskCreated", 120, "revised"),
      });
      const engaged = projectable({
        event: "TaskAttemptCreated",
        facts: { taskId: 42n, attemptIndex: 3, operator: OPERATOR, requestId: REQUEST_ID, priorityMech: OPERATOR, attemptDeadline: 1_800_000_000n, deliveryRate: 10n },
        derivation: derivation("TaskAttemptCreated", 121, "revised"),
      });
      const terminal = terminalEvent === "VerdictDeliveryClaimed"
        ? projectable({ event: terminalEvent, facts: { evaluator: OPERATOR, taskId: 42n, attemptIndex: 3, verdictIndex: 0, requestId: REQUEST_ID, verdictCode: 1 }, derivation: derivation(terminalEvent, 122, "revised") })
        : projectable({ event: terminalEvent, facts: { taskId: 42n, creator: CREATOR, solutionAmount: 1n, verdictAmount: 1n }, derivation: derivation(terminalEvent, 122, "revised") });
      const lifecycle = projectable({ event: lifecycleEvent, facts: { taskId: 42n, attemptIndex: 3, operator: OPERATOR }, derivation: derivation(lifecycleEvent, 123, "revised") });
      const initial = reduceMarketplaceProjection([task, engaged], createMarketplaceProjectionState());
      const closed = reduceMarketplaceProjection([terminal], initial.state);
      const after = reduceMarketplaceProjection([lifecycle], closed.state);
      const retry = reduceMarketplaceProjection([{
        ...engaged,
        facts: { ...engaged.facts, attemptIndex: 4 },
        derivation: derivation("TaskAttemptCreated", 124, "revised"),
      } as ObservationMarketplaceEvent], after.state);
      const topUp = reduceMarketplaceProjection([projectable({
        event: "AttemptsAdded", facts: { taskId: 42n, creator: CREATOR, added: 1, newMaxTotal: 2 },
        derivation: derivation("AttemptsAdded", 125, "revised"),
      })], after.state);

      const taskState = Object.values(after.state.tasks)[0]!;
      expect(taskState).toMatchObject({ availability: "closed", terminalCause: _cause, liveAttemptIndices: {} });
      expect(after.availabilityOpenedLogIds).toEqual([]);
      expect(retry.refusals.map(({ reason }) => reason)).toEqual(["task-closed"]);
      expect(topUp.refusals.map(({ reason }) => reason)).toEqual(["task-closed"]);
    },
  );

  test("today finalization closes the Task permanently before a later claim", () => {
    const created = projectable({
      event: "TaskCreated",
      facts: { creator: CREATOR, taskCidDigest: `0x${"7".repeat(64)}`, taskId: 42n, manifestDigest: `0x${"1".repeat(64)}`, maxClaims: 2, solutionBudget: 100n, verdictBudget: 20n },
      derivation: derivation("TaskCreated", 130),
    });
    const verdict = projectable({
      event: "VerdictDeliveryClaimed",
      facts: { evaluator: OPERATOR, requestId: REQUEST_ID, taskId: 42n, attemptIndex: 3, verdictIndex: 0, verdictCode: 1 },
      derivation: derivation("VerdictDeliveryClaimed", 131),
    });
    const afterVerdict = reduceMarketplaceProjection([created, verdict], createMarketplaceProjectionState());
    const laterClaim = reduceMarketplaceProjection([{
      ...claim,
      derivation: derivation("TaskAttemptCreated", 132),
      facts: { ...claim.facts, attemptIndex: 4 },
    } as ObservationMarketplaceEvent], afterVerdict.state);

    expect(Object.values(afterVerdict.state.tasks)[0]).toMatchObject({ terminalCause: "finalized", availability: "closed" });
    expect(laterClaim).toMatchObject({
      events: [], observations: [], availabilityOpenedLogIds: [],
      refusals: [expect.objectContaining({ reason: "task-closed", taskId: 42n, attemptIndex: 4 })],
    });
  });

  test.each(["AttemptReleased", "AttemptExpired"] as const)(
    "TaskClosed remains terminal across a later %s batch", (lifecycleEvent) => {
      const revisedTask = projectable({
        event: "TaskCreated",
        facts: {
          creator: CREATOR, taskCidDigest: `0x${"7".repeat(64)}`,
          submissionDigest: `0x${"d".repeat(64)}`, taskId: 42n, maxTotal: 1,
          maxConcurrent: 1, submissionDeadline: 1_800_000_000n, closeAt: 0n,
          responseTimeout: 3600n, minVerdicts: 1, requireDistinctEvaluator: true,
          solutionMaxDeliveryRate: 10n, verdictMaxDeliveryRate: 20n,
          solutionBudget: 100n, verdictBudget: 20n,
        },
        derivation: derivation("TaskCreated", 100, "revised"),
      });
      const revisedClaim = projectable({
        event: "TaskAttemptCreated",
        facts: {
          taskId: 42n, attemptIndex: 3, operator: OPERATOR, requestId: REQUEST_ID,
          priorityMech: OPERATOR, attemptDeadline: 1_800_000_000n, deliveryRate: 10n,
        },
        derivation: derivation("TaskAttemptCreated", 101, "revised"),
      });
      const close = projectable({
        event: "TaskClosed",
        facts: { taskId: 42n, creator: CREATOR },
        derivation: derivation("TaskClosed", 102, "revised"),
      });
      const lifecycle = projectable({
        event: lifecycleEvent,
        facts: { taskId: 42n, attemptIndex: 3, operator: OPERATOR },
        derivation: derivation(lifecycleEvent, 103, "revised"),
      });
      const initial = reduceMarketplaceProjection([revisedTask, revisedClaim], createMarketplaceProjectionState());
      const closed = reduceMarketplaceProjection([close], initial.state);
      const after = reduceMarketplaceProjection([lifecycle], closed.state);
      const key = "84532:0x1111111111111111111111111111111111111111:42";
      const attemptSequenceKey = `${SOURCE.length}:${SOURCE}${ATTEMPT}`;
      expect(after).toEqual({
        state: {
          ...closed.state,
          processedLogIds: [...closed.state.processedLogIds, `84532:${COORDINATOR}:${BLOCK_HASH}:${TX_HASH}:103`],
          sequenceBySourceSubject: {
            ...closed.state.sequenceBySourceSubject,
            [attemptSequenceKey]: "0000000000000002",
          },
          tasks: {
            [key]: {
              ...closed.state.tasks[key],
              liveAttemptIndices: {},
              availability: "closed",
              requesterClosed: true,
            },
          },
        },
        events: [lifecycle],
        observations: [{
          ...base(
            "network.jinn.task-execution.attempt-terminal.v1",
            ATTEMPT,
            2n,
            103,
            lifecycleEvent,
            "revised",
          ),
          data: lifecycleEvent === "AttemptReleased" ? { state: "cancelled" } : { state: "expired" },
        }],
        availabilityOpenedLogIds: [],
        refusals: [],
      });
      const blockedClaim = {
        ...revisedClaim,
        facts: { ...revisedClaim.facts, attemptIndex: 4 },
        derivation: derivation("TaskAttemptCreated", 104, "revised"),
      } as ObservationMarketplaceEvent;
      const reannounceAttempt = reduceMarketplaceProjection([blockedClaim], after.state);
      expect(reannounceAttempt).toEqual({
        state: {
          ...after.state,
          processedLogIds: [...after.state.processedLogIds, `84532:${COORDINATOR}:${BLOCK_HASH}:${TX_HASH}:104`],
        },
        events: [], observations: [], availabilityOpenedLogIds: [],
        refusals: [{
          kind: "marketplace-projection-refused",
          reason: "task-closed",
          derivation: derivation("TaskAttemptCreated", 104, "revised"),
          taskId: 42n,
          attemptIndex: 4,
        }],
      });
      const topUp = projectable({
        event: "AttemptsAdded",
        facts: { taskId: 42n, creator: CREATOR, added: 1, newMaxTotal: 2 },
        derivation: derivation("AttemptsAdded", 105, "revised"),
      });
      expect(reduceMarketplaceProjection([topUp], after.state)).toEqual({
        state: {
          ...after.state,
          processedLogIds: [...after.state.processedLogIds, `84532:${COORDINATOR}:${BLOCK_HASH}:${TX_HASH}:105`],
        },
        events: [], observations: [], availabilityOpenedLogIds: [],
        refusals: [{
          kind: "marketplace-projection-refused",
          reason: "task-closed",
          derivation: derivation("AttemptsAdded", 105, "revised"),
          taskId: 42n,
        }],
      });
    },
  );

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
    const observations = projectObservations([todayTaskCreated, claim, deliver(), solutionClaimed]);
    expect(observations.map((item) => ProtocolObservationSchema.safeParse(item).success)).toEqual(
      observations.map(() => true),
    );
  });

  test("caller-owned reducer state makes duplicate log replay emit nothing", () => {
    const initial = createMarketplaceProjectionState();
    const first = reduceMarketplaceProjection([todayTaskCreated, claim], initial);
    const replay = reduceMarketplaceProjection([claim], first.state);

    expect(first.events).toEqual([todayTaskCreated, claim]);
    expect(first.observations).toHaveLength(2);
    expect(replay.events).toEqual([]);
    expect(replay.observations).toEqual([]);
    expect(replay.state).toEqual(first.state);
    expect(initial).toEqual(createMarketplaceProjectionState());
  });

  test("full replay equals ordered split batches and carries a Deliver join across the boundary", () => {
    const events = [todayTaskCreated, claim, deliver(), solutionClaimed];
    const full = reduceMarketplaceProjection(
      events,
      createMarketplaceProjectionState(),
    );

    const one = reduceMarketplaceProjection(
      [todayTaskCreated, claim],
      createMarketplaceProjectionState(),
    );
    const two = reduceMarketplaceProjection([deliver()], one.state);
    const three = reduceMarketplaceProjection([solutionClaimed], two.state);

    expect([
      ...one.observations,
      ...two.observations,
      ...three.observations,
    ]).toEqual(full.observations);
    expect(three.state).toEqual(full.state);
    expect(three.observations).toEqual([
      {
        ...base("network.jinn.task-execution.delivery-recorded.v1", ATTEMPT, 2n, 3, "SolutionDeliveryClaimed"),
        data: { digest: `sha256:${"a".repeat(64)}` },
      },
    ]);
  });

  test("capacity exhaustion and top-up survive ordered batch boundaries with monotonic subject sequences", () => {
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
      derivation: derivation("TaskCreated", 10, "revised"),
    });
    const firstClaim = projectable({
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
      derivation: derivation("TaskAttemptCreated", 11, "revised"),
    });
    const topUp = projectable({
      event: "AttemptsAdded",
      facts: { taskId: 42n, creator: CREATOR, added: 1, newMaxTotal: 2 },
      derivation: derivation("AttemptsAdded", 12, "revised"),
    });
    const secondClaim = projectable({
      event: "TaskAttemptCreated",
      facts: {
        operator: OPERATOR,
        priorityMech: OPERATOR,
        requestId: `0x${"c".repeat(64)}`,
        taskId: 42n,
        attemptIndex: 4,
        attemptDeadline: 1_800_000_100n,
        deliveryRate: 10n,
      },
      derivation: derivation("TaskAttemptCreated", 13, "revised"),
    });

    const one = reduceMarketplaceProjection([task], createMarketplaceProjectionState());
    const two = reduceMarketplaceProjection([firstClaim], one.state);
    const three = reduceMarketplaceProjection([topUp], two.state);
    const four = reduceMarketplaceProjection([secondClaim], three.state);
    const submissionClosures = [...two.observations, ...four.observations]
      .filter(({ type }) =>
        type === "network.jinn.task-execution.submission-closed.v1"
      );

    expect(submissionClosures.map(({ sequence, data }) => ({ sequence, data }))).toEqual([
      { sequence: "0000000000000002", data: { reason: "capacity" } },
      { sequence: "0000000000000003", data: { reason: "capacity" } },
    ]);
    expect(four.state.tasks).toMatchObject({
      "84532:0x1111111111111111111111111111111111111111:42": {
        maxTotal: 2,
        liveAttemptIndices: { "3": true, "4": true },
        seenAttemptIndices: { "3": true, "4": true },
        highestAttemptIndex: 4,
        availability: "closed",
        submissionAnchor: {
          digest: `sha256:${"9".repeat(64)}`,
          derivation: derivation("TaskCreated", 10, "revised"),
        },
      },
    });
  });

  test("revised max-one release and expiry free only the exact live identity for a distinct reclaim", () => {
    const revisedTask = projectable({
      event: "TaskCreated",
      facts: {
        creator: CREATOR, taskCidDigest: `0x${"7".repeat(64)}`,
        submissionDigest: `0x${"9".repeat(64)}`, taskId: 42n, maxTotal: 1,
        maxConcurrent: 1, submissionDeadline: 1_800_000_000n, closeAt: 0n,
        responseTimeout: 3600n, minVerdicts: 1, requireDistinctEvaluator: true,
        solutionMaxDeliveryRate: 10n, verdictMaxDeliveryRate: 20n,
        solutionBudget: 100n, verdictBudget: 20n,
      },
      derivation: derivation("TaskCreated", 20, "revised"),
    });
    const revisedClaim = (attemptIndex: number, logIndex: number) => projectable({
      event: "TaskAttemptCreated",
      facts: { operator: OPERATOR, priorityMech: OPERATOR, requestId: `0x${String(attemptIndex).repeat(64)}` as Hex, taskId: 42n, attemptIndex, attemptDeadline: 1_800_000_000n, deliveryRate: 10n },
      derivation: derivation("TaskAttemptCreated", logIndex, "revised"),
    });
    const release = projectable({
      event: "AttemptReleased",
      facts: { taskId: 42n, attemptIndex: 3, operator: OPERATOR },
      derivation: derivation("AttemptReleased", 22, "revised"),
    });
    const expiry = projectable({
      event: "AttemptExpired",
      facts: { taskId: 42n, attemptIndex: 4, operator: OPERATOR },
      derivation: derivation("AttemptExpired", 24, "revised"),
    });

    const one = reduceMarketplaceProjection([revisedTask, revisedClaim(3, 21)], createMarketplaceProjectionState());
    const two = reduceMarketplaceProjection([release], one.state);
    const three = reduceMarketplaceProjection([revisedClaim(4, 23)], two.state);
    const four = reduceMarketplaceProjection([expiry], three.state);
    const five = reduceMarketplaceProjection([revisedClaim(5, 25)], four.state);

    expect(two.state.tasks["84532:0x1111111111111111111111111111111111111111:42"]).toMatchObject({
      liveAttemptIndices: {}, highestAttemptIndex: 3, availability: "open",
    });
    expect(five.state.tasks["84532:0x1111111111111111111111111111111111111111:42"]).toMatchObject({
      liveAttemptIndices: { "5": true }, highestAttemptIndex: 5, availability: "closed",
    });
    expect([...one.observations, ...three.observations, ...five.observations]
      .filter(({ type }) => type === "network.jinn.task-execution.submission-closed.v1")).toHaveLength(3);
  });
});
