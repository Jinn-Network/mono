// SPDX-License-Identifier: MIT

import {
  createMarketplaceProjectionState,
  projectAnnouncements,
  reduceMarketplaceProjection,
  type AnnouncementProjectionPorts,
  type MarketplaceProjectionTransition,
  type ObservationMarketplaceEvent,
  type ObservationProjectionContext,
} from "@jinn-network/marketplace-projector";
import type { Address, Hex } from "viem";
import { describe, expect, test } from "vitest";

const COORDINATOR = "0x1111111111111111111111111111111111111111" satisfies Address;
const OPERATOR = "0x2222222222222222222222222222222222222222" satisfies Address;
const CREATOR = "0x3333333333333333333333333333333333333333" satisfies Address;
const REQUEST_ID = `0x${"4".repeat(64)}` satisfies Hex;
const TX_HASH = `0x${"5".repeat(64)}` satisfies Hex;
const BLOCK_HASH = `0x${"6".repeat(64)}` satisfies Hex;
const TASK_DIGEST = `sha256:${"7".repeat(64)}` as const;
const SUBMISSION = "urn:uuid:11111111-1111-4111-8111-111111111111" as const;

const PROJECTION: ObservationProjectionContext = {
  taskCoordinator: COORDINATOR,
  timestamp: "2026-07-29T12:00:00Z",
  submission: SUBMISSION,
  taskDigest: TASK_DIGEST,
  effectiveDeadline: "2026-07-30T12:00:00Z",
  dispatchContext: {
    uri: "urn:jinn:marketplace:dispatch-context:42:3",
    digest: { sha256: "8".repeat(64) },
  },
};

function stringifyState(state: unknown): string {
  return JSON.stringify(state, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

function derivation(
  event: string,
  logIndex: number,
  contractGeneration: "today" | "revised",
) {
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
  } as const;
}

function appendProcessedLogId(
  state: { readonly processedLogIds: readonly string[] },
  event: ObservationMarketplaceEvent,
): string[] {
  const d = event.derivation;
  return [...state.processedLogIds, [
    d.chainId,
    d.contract.toLowerCase(),
    d.blockHash.toLowerCase(),
    d.txHash.toLowerCase(),
    d.logIndex,
  ].join(":")];
}

interface PortCallCounts {
  sign: number;
  storePut: number;
  appendArchiveEntries: number;
  resolveRecord: number;
  resolvePriorAnnouncementId: number;
}

function instrumentPorts(base: AnnouncementProjectionPorts): {
  readonly ports: AnnouncementProjectionPorts;
  readonly calls: PortCallCounts;
} {
  const calls: PortCallCounts = {
    sign: 0,
    storePut: 0,
    appendArchiveEntries: 0,
    resolveRecord: 0,
    resolvePriorAnnouncementId: 0,
  };
  return {
    calls,
    ports: {
      ...base,
      signer: {
        scope: base.signer.scope,
        async sign(input) {
          calls.sign += 1;
          return base.signer.sign(input);
        },
      },
      store: {
        async put(key, bytes, contentType) {
          calls.storePut += 1;
          return base.store.put(key, bytes, contentType);
        },
      },
      ...(base.appendArchiveEntries === undefined ? {} : {
        appendArchiveEntries: async (input) => {
          calls.appendArchiveEntries += 1;
          return base.appendArchiveEntries!(input);
        },
      }),
      resolveRecord: async (event, role) => {
        calls.resolveRecord += 1;
        return base.resolveRecord(event, role);
      },
      ...(base.resolvePriorAnnouncementId === undefined ? {} : {
        resolvePriorAnnouncementId: async (event, role) => {
          calls.resolvePriorAnnouncementId += 1;
          return base.resolvePriorAnnouncementId!(event, role);
        },
      }),
    },
  };
}

function expectRefusalTransition(
  before: ReturnType<typeof createMarketplaceProjectionState>,
  result: MarketplaceProjectionTransition,
  event: ObservationMarketplaceEvent,
  reason: string,
): void {
  expect(result.state).toEqual({
    ...before,
    processedLogIds: appendProcessedLogId(before, event),
  });
  expect(result.events).toEqual([]);
  expect(result.observations).toEqual([]);
  expect(result.availabilityOpenedLogIds).toEqual([]);
  expect(result.refusals).toEqual([expect.objectContaining({
    kind: "marketplace-projection-refused",
    reason,
    derivation: event.derivation,
  })]);
}

async function expectRefusalThroughAnnounceBoundary(
  options: MarketplaceProjectorIdentityConformanceOptions,
  before: ReturnType<typeof createMarketplaceProjectionState>,
  result: MarketplaceProjectionTransition,
  event: ObservationMarketplaceEvent,
  reason: string,
): Promise<void> {
  expectRefusalTransition(before, result, event, reason);

  const base = options.incrementalPorts();
  const previousHead = base.previousHead;
  const { ports, calls } = instrumentPorts(base);
  const announced = await projectAnnouncements(result, ports);

  expect(announced.announcements).toEqual([]);
  expect(announced.entries).toEqual([]);
  expect(announced.pages).toEqual([]);
  expect(announced.refusals).toEqual([]);
  if (previousHead !== undefined) {
    expect(announced.head).toBe(previousHead);
  } else {
    expect(announced.head).toBeUndefined();
  }
  expect(calls.sign).toBe(0);
  expect(calls.storePut).toBe(0);
  expect(calls.appendArchiveEntries).toBe(0);
  expect(calls.resolveRecord).toBe(0);
  expect(calls.resolvePriorAnnouncementId).toBe(0);
}

function taskCreated(
  generation: "today" | "revised",
  options: { readonly twoLiveParents?: boolean } = {},
): ObservationMarketplaceEvent {
  if (generation === "today") {
    return {
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
      derivation: derivation("TaskCreated", 0, generation),
      projection: PROJECTION,
    };
  }
  return {
    event: "TaskCreated",
    facts: {
      creator: CREATOR,
      taskCidDigest: `0x${"7".repeat(64)}`,
      submissionDigest: `0x${"d".repeat(64)}`,
      taskId: 42n,
      maxTotal: 2,
      maxConcurrent: options.twoLiveParents === true ? 2 : 1,
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
    derivation: derivation("TaskCreated", 0, generation),
    projection: PROJECTION,
  };
}

function taskClaim(
  generation: "today" | "revised",
  logIndex: number,
  options: { readonly requestId?: Hex; readonly attemptIndex?: number } = {},
): ObservationMarketplaceEvent {
  const requestId = options.requestId ?? REQUEST_ID;
  const attemptIndex = options.attemptIndex ?? 3;
  if (generation === "today") {
    return {
      event: "TaskAttemptCreated",
      facts: {
        taskId: 42n, attemptIndex, operator: OPERATOR, requestId,
        priorityMech: OPERATOR, deliveryRate: 10n,
      },
      derivation: derivation("TaskAttemptCreated", logIndex, generation),
      projection: PROJECTION,
    };
  }
  return {
    event: "TaskAttemptCreated",
    facts: {
      operator: OPERATOR, priorityMech: OPERATOR, requestId,
      taskId: 42n, attemptIndex, attemptDeadline: 1_800_000_000n, deliveryRate: 10n,
    },
    derivation: derivation("TaskAttemptCreated", logIndex, generation),
    projection: PROJECTION,
  };
}

function evaluationClaim(
  generation: "today" | "revised",
  logIndex: number,
  options: {
    readonly requestId?: Hex;
    readonly verdictIndex?: number;
    readonly attemptIndex?: number;
  } = {},
): ObservationMarketplaceEvent {
  const requestId = options.requestId ?? (`0x${"e".repeat(64)}` as Hex);
  const verdictIndex = options.verdictIndex ?? 0;
  const attemptIndex = options.attemptIndex ?? 3;
  if (generation === "today") {
    return {
      event: "EvaluationAttemptCreated",
      facts: {
        taskId: 42n, attemptIndex, verdictIndex, requestId,
        evaluator: OPERATOR, priorityMech: OPERATOR, deliveryRate: 10n,
      },
      derivation: derivation("EvaluationAttemptCreated", logIndex, generation),
      projection: PROJECTION,
    };
  }
  return {
    event: "EvaluationAttemptCreated",
    facts: {
      evaluator: OPERATOR, priorityMech: OPERATOR, requestId,
      taskId: 42n, attemptIndex, verdictIndex,
      attemptDeadline: 1_800_000_000n, deliveryRate: 10n,
    },
    derivation: derivation("EvaluationAttemptCreated", logIndex, generation),
    projection: PROJECTION,
  };
}

function evaluationParentKey(taskId: bigint, attemptIndex: number): string {
  return `84532:${COORDINATOR.toLowerCase()}:${taskId}:${attemptIndex}`;
}

export interface MarketplaceProjectorIdentityConformanceOptions {
  readonly ports: () => AnnouncementProjectionPorts;
  readonly incrementalPorts: () => AnnouncementProjectionPorts;
}

/**
 * Native today/revised identity suites for TaskAttemptCreated and EvaluationAttemptCreated facts.
 * Uses the public reduce → announce path and asserts complete transition surfaces.
 */
export function describeMarketplaceProjectorIdentityConformance(
  options: MarketplaceProjectorIdentityConformanceOptions,
): void {
  describe("marketplace projector identity conformance (§7.110, §7.125)", () => {
    for (const generation of ["today", "revised"] as const) {
      describe(`${generation} generation`, () => {
        test("TaskAttemptCreated unknown-task refusal preserves complete boundary", async () => {
          const created = reduceMarketplaceProjection(
            [taskCreated(generation)],
            createMarketplaceProjectionState(),
          );
          const unknown = {
            ...taskClaim(generation, 1),
            facts: { ...taskClaim(generation, 1).facts, taskId: 999n, attemptIndex: 4 },
            derivation: { ...derivation("TaskAttemptCreated", 1, generation), txHash: `0x${"a".repeat(64)}` },
          } as ObservationMarketplaceEvent;
          const refused = reduceMarketplaceProjection([unknown], created.state);
          await expectRefusalThroughAnnounceBoundary(
            options, created.state, refused, unknown, "unknown-task",
          );
        });

        test("TaskAttemptCreated duplicate/regressing identity refusal", async () => {
          const created = reduceMarketplaceProjection(
            [taskCreated(generation), taskClaim(generation, 1)],
            createMarketplaceProjectionState(),
          );
          const duplicate = {
            ...taskClaim(generation, 1),
            derivation: { ...taskClaim(generation, 1).derivation, txHash: `0x${"b".repeat(64)}`, logIndex: 2 },
          } as ObservationMarketplaceEvent;
          await expectRefusalThroughAnnounceBoundary(
            options,
            created.state,
            reduceMarketplaceProjection([duplicate], created.state),
            duplicate,
            "attempt-identity-regressing",
          );
          const regressing = {
            ...taskClaim(generation, 1),
            facts: { ...taskClaim(generation, 1).facts, attemptIndex: 2 },
            derivation: { ...taskClaim(generation, 1).derivation, txHash: `0x${"c".repeat(64)}`, logIndex: 3 },
          } as ObservationMarketplaceEvent;
          await expectRefusalThroughAnnounceBoundary(
            options,
            created.state,
            reduceMarketplaceProjection([regressing], created.state),
            regressing,
            "attempt-identity-regressing",
          );
        });

        test("TaskAttemptCreated request-id-reused refusal", async () => {
          const created = reduceMarketplaceProjection(
            [taskCreated(generation), taskClaim(generation, 1)],
            createMarketplaceProjectionState(),
          );
          const reused = {
            ...taskClaim(generation, 1),
            facts: { ...taskClaim(generation, 1).facts, attemptIndex: 4 },
            derivation: { ...taskClaim(generation, 1).derivation, txHash: `0x${"d".repeat(64)}`, logIndex: 4 },
          } as ObservationMarketplaceEvent;
          await expectRefusalThroughAnnounceBoundary(
            options,
            created.state,
            reduceMarketplaceProjection([reused], created.state),
            reused,
            "request-id-reused",
          );
        });

        if (generation === "revised") {
          test("TaskAttemptCreated attempt-not-live on release/expiry without parent claim", async () => {
            const created = reduceMarketplaceProjection(
              [taskCreated(generation)],
              createMarketplaceProjectionState(),
            );
            for (const lifecycleEvent of ["AttemptReleased", "AttemptExpired"] as const) {
              const lifecycle = {
                event: lifecycleEvent,
                facts: { taskId: 42n, attemptIndex: 3, operator: OPERATOR },
                derivation: derivation(lifecycleEvent, 1, generation),
                projection: PROJECTION,
              } as ObservationMarketplaceEvent;
              await expectRefusalThroughAnnounceBoundary(
                options,
                created.state,
                reduceMarketplaceProjection([lifecycle], created.state),
                lifecycle,
                "attempt-not-live",
              );
            }
          });
        }

        test("EvaluationAttemptCreated refuses before parent TaskAttemptCreated", async () => {
          const created = reduceMarketplaceProjection(
            [taskCreated(generation)],
            createMarketplaceProjectionState(),
          );
          const evalClaim = evaluationClaim(generation, 2);
          await expectRefusalThroughAnnounceBoundary(
            options,
            created.state,
            reduceMarketplaceProjection([evalClaim], created.state),
            evalClaim,
            "attempt-not-live",
          );
        });

        if (generation === "revised") {
          test("EvaluationAttemptCreated refuses after parent release/expiry", async () => {
            const afterLifecycle = reduceMarketplaceProjection(
              [
                taskCreated(generation),
                taskClaim(generation, 1),
                {
                  event: "AttemptReleased",
                  facts: { taskId: 42n, attemptIndex: 3, operator: OPERATOR },
                  derivation: derivation("AttemptReleased", 2, generation),
                  projection: PROJECTION,
                } as ObservationMarketplaceEvent,
              ],
              createMarketplaceProjectionState(),
            );
            const evalClaim = evaluationClaim(generation, 3, {
              requestId: `0x${"f1".repeat(32)}` as Hex,
            });
            await expectRefusalThroughAnnounceBoundary(
              options,
              afterLifecycle.state,
              reduceMarketplaceProjection([evalClaim], afterLifecycle.state),
              evalClaim,
              "attempt-not-live",
            );
          });
        }

        test("EvaluationAttemptCreated refuses on closed task with fresh request ID", async () => {
          const terminal = generation === "today"
            ? ({
                event: "VerdictDeliveryClaimed",
                facts: {
                  evaluator: OPERATOR, taskId: 42n, attemptIndex: 3, verdictIndex: 0,
                  requestId: REQUEST_ID, verdictCode: 1,
                },
                derivation: derivation("VerdictDeliveryClaimed", 2, generation),
                projection: PROJECTION,
              } as ObservationMarketplaceEvent)
            : ({
                event: "TaskBudgetRefunded",
                facts: { taskId: 42n, creator: CREATOR, solutionAmount: 1n, verdictAmount: 1n },
                derivation: derivation("TaskBudgetRefunded", 2, generation),
                projection: PROJECTION,
              } as ObservationMarketplaceEvent);
          const closed = reduceMarketplaceProjection(
            [taskCreated(generation), taskClaim(generation, 1), terminal],
            createMarketplaceProjectionState(),
          );
          const evalClaim = evaluationClaim(generation, 3, {
            requestId: `0x${"f2".repeat(32)}` as Hex,
          });
          await expectRefusalThroughAnnounceBoundary(
            options,
            closed.state,
            reduceMarketplaceProjection([evalClaim], closed.state),
            evalClaim,
            "task-closed",
          );
        });

        test("EvaluationAttemptCreated duplicate/regressing verdict slots and request-id reuse", async () => {
          const admitted = reduceMarketplaceProjection(
            [
              taskCreated(generation),
              taskClaim(generation, 1),
              evaluationClaim(generation, 2, {
                requestId: `0x${"a2".repeat(32)}` as Hex,
                verdictIndex: 2,
              }),
            ],
            createMarketplaceProjectionState(),
          );
          const duplicateVerdict = {
            ...evaluationClaim(generation, 3, {
              requestId: `0x${"b2".repeat(32)}` as Hex,
              verdictIndex: 2,
            }),
          } as ObservationMarketplaceEvent;
          await expectRefusalThroughAnnounceBoundary(
            options,
            admitted.state,
            reduceMarketplaceProjection([duplicateVerdict], admitted.state),
            duplicateVerdict,
            "attempt-identity-regressing",
          );
          const regressingVerdict = {
            ...evaluationClaim(generation, 4, {
              requestId: `0x${"c2".repeat(32)}` as Hex,
              verdictIndex: 1,
            }),
          } as ObservationMarketplaceEvent;
          await expectRefusalThroughAnnounceBoundary(
            options,
            admitted.state,
            reduceMarketplaceProjection([regressingVerdict], admitted.state),
            regressingVerdict,
            "attempt-identity-regressing",
          );
          const crossFamilyReuse = evaluationClaim(generation, 5, {
            requestId: `0x${"a2".repeat(32)}` as Hex,
            verdictIndex: 3,
          });
          await expectRefusalThroughAnnounceBoundary(
            options,
            admitted.state,
            reduceMarketplaceProjection([crossFamilyReuse], admitted.state),
            crossFamilyReuse,
            "request-id-reused",
          );
        });

        test("EvaluationAttemptCreated split-batch persistence and exact-log replay", async () => {
          const firstBatch = reduceMarketplaceProjection(
            [taskCreated(generation), taskClaim(generation, 1)],
            createMarketplaceProjectionState(),
          );
          const evalClaim = evaluationClaim(generation, 2, {
            requestId: `0x${"d3".repeat(32)}` as Hex,
            verdictIndex: 0,
          });
          const admitted = reduceMarketplaceProjection([evalClaim], firstBatch.state);
          const duplicate = {
            ...evaluationClaim(generation, 3, {
              requestId: `0x${"e3".repeat(32)}` as Hex,
              verdictIndex: 0,
            }),
          } as ObservationMarketplaceEvent;
          await expectRefusalThroughAnnounceBoundary(
            options,
            admitted.state,
            reduceMarketplaceProjection([duplicate], admitted.state),
            duplicate,
            "attempt-identity-regressing",
          );
          const replay = reduceMarketplaceProjection([evalClaim], admitted.state);
          expect(replay).toEqual({
            state: admitted.state,
            events: [],
            observations: [],
            availabilityOpenedLogIds: [],
            refusals: [],
          });
        });

        test("EvaluationAttemptCreated parent-attempt identity isolation", async () => {
          const task = taskCreated(generation, { twoLiveParents: true });
          const parent3 = taskClaim(generation, 1, {
            attemptIndex: 3,
            requestId: `0x${"p3".repeat(32)}` as Hex,
          });
          const parent4 = taskClaim(generation, 2, {
            attemptIndex: 4,
            requestId: `0x${"p4".repeat(32)}` as Hex,
          });
          const afterParents = reduceMarketplaceProjection(
            [task, parent3, parent4],
            createMarketplaceProjectionState(),
          );
          const eval3 = evaluationClaim(generation, 3, {
            attemptIndex: 3,
            requestId: `0x${"e3".repeat(32)}` as Hex,
            verdictIndex: 0,
          });
          const eval4 = evaluationClaim(generation, 4, {
            attemptIndex: 4,
            requestId: `0x${"e4".repeat(32)}` as Hex,
            verdictIndex: 0,
          });
          const afterEval3 = reduceMarketplaceProjection([eval3], afterParents.state);
          expect(afterEval3.refusals).toEqual([]);
          expect(afterEval3.observations).toEqual([]);
          expect(afterEval3.events).toEqual([eval3]);
          const afterBoth = reduceMarketplaceProjection([eval4], afterEval3.state);
          expect(afterBoth.refusals).toEqual([]);
          expect(afterBoth.observations).toEqual([]);
          expect(afterBoth.events).toEqual([eval4]);

          const key3 = evaluationParentKey(42n, 3);
          const key4 = evaluationParentKey(42n, 4);
          expect(key3).toMatch(/:42:3$/);
          expect(key4).toMatch(/:42:4$/);
          expect(afterBoth.state.evaluationIdentities[key3]).toEqual({
            seenVerdictIndices: { "0": true },
            highestVerdictIndex: 0,
          });
          expect(afterBoth.state.evaluationIdentities[key4]).toEqual({
            seenVerdictIndices: { "0": true },
            highestVerdictIndex: 0,
          });
          expect(afterBoth.state.evaluationIdentities[key3]!.seenVerdictIndices)
            .not.toBe(afterBoth.state.evaluationIdentities[key4]!.seenVerdictIndices);

          const duplicate3 = {
            ...evaluationClaim(generation, 5, {
              attemptIndex: 3,
              requestId: `0x${"d3".repeat(32)}` as Hex,
              verdictIndex: 0,
            }),
            derivation: {
              ...evaluationClaim(generation, 5, {
                attemptIndex: 3,
                requestId: `0x${"d3".repeat(32)}` as Hex,
                verdictIndex: 0,
              }).derivation,
              txHash: `0x${"x3".repeat(32)}` as Hex,
            },
          } as ObservationMarketplaceEvent;
          const refused = reduceMarketplaceProjection([duplicate3], afterBoth.state);
          await expectRefusalThroughAnnounceBoundary(
            options, afterBoth.state, refused, duplicate3, "attempt-identity-regressing",
          );
          expect(refused.state.evaluationIdentities[key3]).toEqual(
            afterBoth.state.evaluationIdentities[key3],
          );
          expect(refused.state.evaluationIdentities[key4]).toEqual(
            afterBoth.state.evaluationIdentities[key4],
          );
        });

        test("EvaluationAttemptCreated accepted path preserves caller state (§7.72)", async () => {
          const afterParent = reduceMarketplaceProjection(
            [taskCreated(generation), taskClaim(generation, 1)],
            createMarketplaceProjectionState(),
          );
          const callerState = afterParent.state;
          const snapshotBefore = stringifyState(callerState);

          const eval0 = evaluationClaim(generation, 2, {
            requestId: `0x${"v0".repeat(32)}` as Hex,
            verdictIndex: 0,
          });
          const result0 = reduceMarketplaceProjection([eval0], callerState);
          expect(stringifyState(callerState)).toBe(snapshotBefore);

          const parentKey = evaluationParentKey(42n, 3);
          expect(result0.state.evaluationIdentities).not.toBe(callerState.evaluationIdentities);
          const parentIdentity0 = result0.state.evaluationIdentities[parentKey]!;
          const seen0 = parentIdentity0.seenVerdictIndices;

          const eval1 = evaluationClaim(generation, 3, {
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

          const announced = await projectAnnouncements(result1, options.ports());
          expect(announced.announcements).toEqual([]);
          expect(announced.entries).toEqual([]);
        });

        test("EvaluationAttemptCreated accepted path emits no observations through announce boundary", async () => {
          const afterParent = reduceMarketplaceProjection(
            [taskCreated(generation), taskClaim(generation, 1)],
            createMarketplaceProjectionState(),
          );
          const evalClaim = evaluationClaim(generation, 2, {
            requestId: `0x${"c3".repeat(32)}` as Hex,
            verdictIndex: 0,
          });
          const transition = reduceMarketplaceProjection([evalClaim], afterParent.state);
          expect(transition.observations).toEqual([]);
          expect(transition.refusals).toEqual([]);
          expect(transition.events).toEqual([evalClaim]);
          const announced = await projectAnnouncements(transition, options.ports());
          expect(announced.announcements).toEqual([]);
          expect(announced.entries).toEqual([]);
          expect(announced.pages).toEqual([]);
          expect(announced.refusals).toEqual([]);
        });
      });
    }
  });
}
