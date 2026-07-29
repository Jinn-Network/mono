// SPDX-License-Identifier: MIT

import {
  JINN_ROUTER_V3_ABI,
  MECH_ABI,
  type MarketplaceChainConfig,
  type ContractGeneration,
} from "@jinn-network/marketplace-binding";
import {
  decodeEventLog,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import {
  createDerivationAnnotation,
  type DerivationAnnotation,
  type DerivationLog,
} from "./derivation.js";

/**
 * Exact V4 router event contract frozen by marketplace Addendum 2026-07-29-f / program
 * ruling §7.29. M7's compiled contract ABI must match these fixtures byte-for-byte.
 */
export const REVISED_COMMON_PROJECTOR_EVENTS_ABI = [
  {
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
  },
  {
    type: "event",
    name: "TaskAttemptCreated",
    inputs: [
      { name: "operator", type: "address", indexed: true },
      { name: "priorityMech", type: "address", indexed: true },
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: false },
      { name: "attemptDeadline", type: "uint64", indexed: false },
      { name: "deliveryRate", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EvaluationAttemptCreated",
    inputs: [
      { name: "evaluator", type: "address", indexed: true },
      { name: "priorityMech", type: "address", indexed: true },
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: false },
      { name: "verdictIndex", type: "uint32", indexed: false },
      { name: "attemptDeadline", type: "uint64", indexed: false },
      { name: "deliveryRate", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SolutionDeliveryPrepared",
    inputs: [
      { name: "operator", type: "address", indexed: true },
      { name: "expectedRequestId", type: "bytes32", indexed: true },
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "deliveryDigest", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VerdictDeliveryPrepared",
    inputs: [
      { name: "evaluator", type: "address", indexed: true },
      { name: "expectedRequestId", type: "bytes32", indexed: true },
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: false },
      { name: "verdictIndex", type: "uint32", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "deliveryDigest", type: "bytes32", indexed: false },
      { name: "verdictCode", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SolutionDeliveryClaimed",
    inputs: [
      { name: "operator", type: "address", indexed: true },
      { name: "requestId", type: "bytes32", indexed: true },
      { name: "deliveryDigest", type: "bytes32", indexed: true },
      { name: "taskId", type: "uint256", indexed: false },
      { name: "attemptIndex", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "VerdictDeliveryClaimed",
    inputs: [
      { name: "evaluator", type: "address", indexed: true },
      { name: "requestId", type: "bytes32", indexed: true },
      { name: "evaluationDeliveryDigest", type: "bytes32", indexed: true },
      { name: "taskId", type: "uint256", indexed: false },
      { name: "attemptIndex", type: "uint32", indexed: false },
      { name: "verdictIndex", type: "uint32", indexed: false },
      { name: "verdictCode", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "TaskBudgetRefunded",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "solutionAmount", type: "uint256", indexed: false },
      { name: "verdictAmount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AttemptsAdded",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "added", type: "uint32", indexed: false },
      { name: "newMaxTotal", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ReservationForfeited",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: true },
      { name: "verdictIndex", type: "uint32", indexed: true },
      { name: "requestId", type: "bytes32", indexed: false },
      { name: "rate", type: "uint256", indexed: false },
      { name: "legKind", type: "uint8", indexed: false },
    ],
  },
] as const;

/** Exact V4 lifecycle events frozen by Addendum 2026-07-29-e / ruling §7.28. */
export const REVISED_LIFECYCLE_PROJECTOR_EVENTS_ABI = [
  {
    type: "event",
    name: "AttemptExpired",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: true },
      { name: "operator", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "AttemptReleased",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: true },
      { name: "operator", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "TaskClosed",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "creator", type: "address", indexed: true },
    ],
  },
] as const;

export const REVISED_ROUTER_PROJECTOR_EVENTS_ABI = [
  ...REVISED_COMMON_PROJECTOR_EVENTS_ABI,
  ...REVISED_LIFECYCLE_PROJECTOR_EVENTS_ABI,
] as const;

export const REVISED_COORDINATOR_PROJECTOR_EVENTS_ABI = [
  {
    type: "event",
    name: "AttemptForfeited",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: true },
      { name: "operator", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "VerdictForfeited",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "attemptIndex", type: "uint32", indexed: true },
      { name: "verdictIndex", type: "uint32", indexed: true },
      { name: "evaluator", type: "address", indexed: false },
    ],
  },
] as const;

export const REVISED_PROJECTOR_EVENTS_ABI = [
  ...REVISED_ROUTER_PROJECTOR_EVENTS_ABI,
  ...REVISED_COORDINATOR_PROJECTOR_EVENTS_ABI,
] as const;

/** Exact signed-delivery event emitted by MechMarketplace in revised mode. */
export const REVISED_MECH_DELIVER_ABI = [{
  type: "event",
  name: "Deliver",
  inputs: [
    { name: "mech", type: "address", indexed: true },
    { name: "mechServiceMultisig", type: "address", indexed: true },
    { name: "requestId", type: "bytes32", indexed: false },
    { name: "deliveryRate", type: "uint256", indexed: false },
    { name: "requestData", type: "bytes", indexed: false },
    { name: "deliveryData", type: "bytes", indexed: false },
  ],
}] as const;

const V3_ROUTER_EVENTS_ABI = JINN_ROUTER_V3_ABI.filter(
  (entry) => entry.type === "event",
);
const TODAY_ROUTER_EVENT_TOPICS = new Set(
  V3_ROUTER_EVENTS_ABI.map((event) => toEventSelector(event)),
);
const TODAY_PROJECTOR_EVENTS_ABI = [...V3_ROUTER_EVENTS_ABI, ...MECH_ABI] as const;
const REVISED_DECODE_EVENTS_ABI = [
  ...REVISED_PROJECTOR_EVENTS_ABI,
  ...REVISED_MECH_DELIVER_ABI,
] as const;
const REVISED_ROUTER_EVENT_TOPICS = new Set(
  REVISED_ROUTER_PROJECTOR_EVENTS_ABI.map((event) => toEventSelector(event)),
);
const REVISED_COORDINATOR_EVENT_TOPICS = new Set(
  REVISED_COORDINATOR_PROJECTOR_EVENTS_ABI.map((event) => toEventSelector(event)),
);

const TODAY_EVENT_TOPICS = new Set(
  TODAY_PROJECTOR_EVENTS_ABI.map((event) => toEventSelector(event)),
);
const REVISED_EVENT_TOPICS = new Set(
  REVISED_DECODE_EVENTS_ABI.map((event) => toEventSelector(event)),
);
const TODAY_MECH_EVENT_TOPICS = new Set(
  MECH_ABI.map((event) => toEventSelector(event)),
);
const REVISED_MECH_EVENT_TOPICS = new Set(
  REVISED_MECH_DELIVER_ABI.map((event) => toEventSelector(event)),
);

/**
 * Explicit decode authority: configuration supplies exact chain/router/coordinator identities;
 * the host supplies the deployment's dynamic authorized-Mech membership rule. No ABI-shaped log
 * crosses this boundary until its origin is authorized for the relevant event family.
 */
export interface MarketplaceEventOriginAuthority {
  readonly config: MarketplaceChainConfig;
  readonly isAuthorizedMechOrigin: (address: Address) => boolean;
}

export function marketplaceEventOriginAuthority(
  config: MarketplaceChainConfig,
  isAuthorizedMechOrigin: (address: Address) => boolean,
): MarketplaceEventOriginAuthority {
  return { config, isAuthorizedMechOrigin };
}

function sameEvmAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function authorizedOrigin(
  log: MarketplaceRawLog,
  authority: MarketplaceEventOriginAuthority,
): boolean {
  if (log.chainId !== authority.config.chainId || log.topics.length === 0) return false;
  const topic = log.topics[0]!;
  const mechTopics = authority.config.generation === "today"
    ? TODAY_MECH_EVENT_TOPICS
    : REVISED_MECH_EVENT_TOPICS;
  if (mechTopics.has(topic)) {
    return authority.isAuthorizedMechOrigin(log.address);
  }
  const routerTopics = authority.config.generation === "today"
    ? TODAY_ROUTER_EVENT_TOPICS
    : REVISED_ROUTER_EVENT_TOPICS;
  if (routerTopics.has(topic)) {
    return sameEvmAddress(log.address, authority.config.jinnRouter);
  }
  if (
    authority.config.generation === "revised"
    && REVISED_COORDINATOR_EVENT_TOPICS.has(topic)
  ) {
    return sameEvmAddress(log.address, authority.config.taskCoordinator);
  }
  return false;
}

export interface MarketplaceRawLog extends DerivationLog {
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

type Event<Name extends string, Facts> = {
  readonly event: Name;
  readonly facts: Facts;
  readonly derivation: DerivationAnnotation;
};

type V3TaskCreated = Event<"TaskCreated", {
  readonly creator: Address;
  readonly taskId: bigint;
  readonly manifestDigest: Hex;
  readonly taskCidDigest: Hex;
  readonly maxClaims: number;
  readonly solutionBudget: bigint;
  readonly verdictBudget: bigint;
}>;

type V4TaskCreated = Event<"TaskCreated", {
  readonly creator: Address;
  readonly taskCidDigest: Hex;
  readonly submissionDigest: Hex;
  readonly taskId: bigint;
  readonly maxTotal: number;
  readonly maxConcurrent: number;
  readonly submissionDeadline: bigint;
  readonly closeAt: bigint;
  readonly responseTimeout: bigint;
  readonly minVerdicts: number;
  readonly requireDistinctEvaluator: boolean;
  readonly solutionMaxDeliveryRate: bigint;
  readonly verdictMaxDeliveryRate: bigint;
  readonly solutionBudget: bigint;
  readonly verdictBudget: bigint;
}>;

type V3TaskAttemptCreated = Event<"TaskAttemptCreated", {
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly operator: Address;
  readonly requestId: Hex;
  readonly priorityMech: Address;
  readonly deliveryRate: bigint;
}>;

type V4TaskAttemptCreated = Event<"TaskAttemptCreated", {
  readonly operator: Address;
  readonly priorityMech: Address;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly attemptDeadline: bigint;
  readonly deliveryRate: bigint;
}>;

type V3EvaluationAttemptCreated = Event<"EvaluationAttemptCreated", {
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly verdictIndex: number;
  readonly requestId: Hex;
  readonly evaluator: Address;
  readonly priorityMech: Address;
  readonly deliveryRate: bigint;
}>;

type V4EvaluationAttemptCreated = Event<"EvaluationAttemptCreated", {
  readonly evaluator: Address;
  readonly priorityMech: Address;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly verdictIndex: number;
  readonly attemptDeadline: bigint;
  readonly deliveryRate: bigint;
}>;

type V3SolutionDeliveryClaimed = Event<"SolutionDeliveryClaimed", {
  readonly operator: Address;
  readonly requestId: Hex;
  readonly taskId: bigint;
  readonly attemptIndex: number;
}>;

type V4SolutionDeliveryClaimed = Event<"SolutionDeliveryClaimed", {
  readonly operator: Address;
  readonly requestId: Hex;
  readonly deliveryDigest: Hex;
  readonly taskId: bigint;
  readonly attemptIndex: number;
}>;

type V3VerdictDeliveryClaimed = Event<"VerdictDeliveryClaimed", {
  readonly evaluator: Address;
  readonly requestId: Hex;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly verdictIndex: number;
  readonly verdictCode: number;
}>;

type V4VerdictDeliveryClaimed = Event<"VerdictDeliveryClaimed", {
  readonly evaluator: Address;
  readonly requestId: Hex;
  readonly evaluationDeliveryDigest: Hex;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly verdictIndex: number;
  readonly verdictCode: number;
}>;

export type MarketplaceEvent =
  | V3TaskCreated
  | V4TaskCreated
  | V3TaskAttemptCreated
  | V4TaskAttemptCreated
  | V3EvaluationAttemptCreated
  | V4EvaluationAttemptCreated
  | Event<"Deliver", {
      readonly mech: Address;
      readonly mechServiceMultisig: Address;
      readonly requestId: Hex;
      readonly deliveryRate: bigint;
      readonly data: Hex;
    }>
  | Event<"Deliver", {
      readonly mech: Address;
      readonly mechServiceMultisig: Address;
      readonly requestId: Hex;
      readonly deliveryRate: bigint;
      readonly requestData: Hex;
      readonly deliveryData: Hex;
    }>
  | Event<"SolutionDeliveryPrepared", {
      readonly operator: Address;
      readonly expectedRequestId: Hex;
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly nonce: bigint;
      readonly deliveryDigest: Hex;
    }>
  | Event<"VerdictDeliveryPrepared", {
      readonly evaluator: Address;
      readonly expectedRequestId: Hex;
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly verdictIndex: number;
      readonly nonce: bigint;
      readonly deliveryDigest: Hex;
      readonly verdictCode: number;
    }>
  | V3SolutionDeliveryClaimed
  | V4SolutionDeliveryClaimed
  | V3VerdictDeliveryClaimed
  | V4VerdictDeliveryClaimed
  | Event<"TaskBudgetRefunded", {
      readonly taskId: bigint;
      readonly creator: Address;
      readonly solutionAmount: bigint;
      readonly verdictAmount: bigint;
    }>
  | Event<"AttemptsAdded", {
      readonly taskId: bigint;
      readonly creator: Address;
      readonly added: number;
      readonly newMaxTotal: number;
    }>
  | Event<"AttemptExpired", {
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly operator: Address;
    }>
  | Event<"AttemptReleased", {
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly operator: Address;
    }>
  | Event<"TaskClosed", {
      readonly taskId: bigint;
      readonly creator: Address;
    }>
  | Event<"ReservationForfeited", {
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly verdictIndex: number;
      readonly requestId: Hex;
      readonly rate: bigint;
      readonly legKind: number;
    }>
  | Event<"AttemptForfeited", {
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly operator: Address;
    }>
  | Event<"VerdictForfeited", {
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly verdictIndex: number;
      readonly evaluator: Address;
    }>;

function argsRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Decoded marketplace event has no named arguments");
  }
  return value as Record<string, unknown>;
}

function bigintArg(args: Record<string, unknown>, name: string): bigint {
  const value = args[name];
  if (typeof value !== "bigint") throw new TypeError(`${name} is not an exact EVM integer`);
  return value;
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (
    typeof value === "bigint"
    && value >= 0n
    && value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  throw new TypeError(`${name} is not a safe integer`);
}

function booleanArg(args: Record<string, unknown>, name: string): boolean {
  const value = args[name];
  if (typeof value !== "boolean") throw new TypeError(`${name} is not a boolean`);
  return value;
}

function stringArg<T extends string>(
  args: Record<string, unknown>,
  name: string,
): T {
  const value = args[name];
  if (typeof value !== "string") throw new TypeError(`${name} is not a string`);
  return value as T;
}

function commonEvent(
  eventName: string,
  args: Record<string, unknown>,
  derivation: DerivationAnnotation,
): MarketplaceEvent | undefined {
  switch (eventName) {
    case "Deliver":
      return "requestData" in args
        ? {
            event: eventName,
            facts: {
              mech: stringArg<Address>(args, "mech"),
              mechServiceMultisig: stringArg<Address>(
                args,
                "mechServiceMultisig",
              ),
              requestId: stringArg<Hex>(args, "requestId"),
              deliveryRate: bigintArg(args, "deliveryRate"),
              requestData: stringArg<Hex>(args, "requestData"),
              deliveryData: stringArg<Hex>(args, "deliveryData"),
            },
            derivation,
          }
        : {
        event: eventName,
        facts: {
          mech: stringArg<Address>(args, "mech"),
          mechServiceMultisig: stringArg<Address>(args, "mechServiceMultisig"),
          requestId: stringArg<Hex>(args, "requestId"),
          deliveryRate: bigintArg(args, "deliveryRate"),
          data: stringArg<Hex>(args, "data"),
        },
        derivation,
      };
    case "TaskBudgetRefunded":
      return {
        event: eventName,
        facts: {
          taskId: bigintArg(args, "taskId"),
          creator: stringArg<Address>(args, "creator"),
          solutionAmount: bigintArg(args, "solutionAmount"),
          verdictAmount: bigintArg(args, "verdictAmount"),
        },
        derivation,
      };
    default:
      return undefined;
  }
}

function todayEvent(
  eventName: string,
  args: Record<string, unknown>,
  derivation: DerivationAnnotation,
): MarketplaceEvent | undefined {
  switch (eventName) {
    case "TaskCreated":
      return {
        event: eventName,
        facts: {
          creator: stringArg<Address>(args, "creator"),
          taskId: bigintArg(args, "taskId"),
          manifestDigest: stringArg<Hex>(args, "manifestDigest"),
          taskCidDigest: stringArg<Hex>(args, "taskCidDigest"),
          maxClaims: numberArg(args, "maxClaims"),
          solutionBudget: bigintArg(args, "solutionBudget"),
          verdictBudget: bigintArg(args, "verdictBudget"),
        },
        derivation,
      };
    case "TaskAttemptCreated":
      return {
        event: eventName,
        facts: {
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
          operator: stringArg<Address>(args, "operator"),
          requestId: stringArg<Hex>(args, "requestId"),
          priorityMech: stringArg<Address>(args, "priorityMech"),
          deliveryRate: bigintArg(args, "deliveryRate"),
        },
        derivation,
      };
    case "EvaluationAttemptCreated":
      return {
        event: eventName,
        facts: {
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
          verdictIndex: numberArg(args, "verdictIndex"),
          requestId: stringArg<Hex>(args, "requestId"),
          evaluator: stringArg<Address>(args, "evaluator"),
          priorityMech: stringArg<Address>(args, "priorityMech"),
          deliveryRate: bigintArg(args, "deliveryRate"),
        },
        derivation,
      };
    case "SolutionDeliveryClaimed":
      return {
        event: eventName,
        facts: {
          operator: stringArg<Address>(args, "operator"),
          requestId: stringArg<Hex>(args, "requestId"),
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
        },
        derivation,
      };
    case "VerdictDeliveryClaimed":
      return {
        event: eventName,
        facts: {
          evaluator: stringArg<Address>(args, "evaluator"),
          requestId: stringArg<Hex>(args, "requestId"),
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
          verdictIndex: numberArg(args, "verdictIndex"),
          verdictCode: numberArg(args, "verdictCode"),
        },
        derivation,
      };
    default:
      return commonEvent(eventName, args, derivation);
  }
}

function revisedEvent(
  eventName: string,
  args: Record<string, unknown>,
  derivation: DerivationAnnotation,
): MarketplaceEvent | undefined {
  switch (eventName) {
    case "TaskCreated":
      return {
        event: eventName,
        facts: {
          creator: stringArg<Address>(args, "creator"),
          taskCidDigest: stringArg<Hex>(args, "taskCidDigest"),
          submissionDigest: stringArg<Hex>(args, "submissionDigest"),
          taskId: bigintArg(args, "taskId"),
          maxTotal: numberArg(args, "maxTotal"),
          maxConcurrent: numberArg(args, "maxConcurrent"),
          submissionDeadline: bigintArg(args, "submissionDeadline"),
          closeAt: bigintArg(args, "closeAt"),
          responseTimeout: bigintArg(args, "responseTimeout"),
          minVerdicts: numberArg(args, "minVerdicts"),
          requireDistinctEvaluator: booleanArg(args, "requireDistinctEvaluator"),
          solutionMaxDeliveryRate: bigintArg(args, "solutionMaxDeliveryRate"),
          verdictMaxDeliveryRate: bigintArg(args, "verdictMaxDeliveryRate"),
          solutionBudget: bigintArg(args, "solutionBudget"),
          verdictBudget: bigintArg(args, "verdictBudget"),
        },
        derivation,
      };
    case "TaskAttemptCreated":
      return {
        event: eventName,
        facts: {
          operator: stringArg<Address>(args, "operator"),
          priorityMech: stringArg<Address>(args, "priorityMech"),
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
          attemptDeadline: bigintArg(args, "attemptDeadline"),
          deliveryRate: bigintArg(args, "deliveryRate"),
        },
        derivation,
      };
    case "EvaluationAttemptCreated":
      return {
        event: eventName,
        facts: {
          evaluator: stringArg<Address>(args, "evaluator"),
          priorityMech: stringArg<Address>(args, "priorityMech"),
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
          verdictIndex: numberArg(args, "verdictIndex"),
          attemptDeadline: bigintArg(args, "attemptDeadline"),
          deliveryRate: bigintArg(args, "deliveryRate"),
        },
        derivation,
      };
    case "SolutionDeliveryPrepared":
      return {
        event: eventName,
        facts: {
          operator: stringArg<Address>(args, "operator"),
          expectedRequestId: stringArg<Hex>(args, "expectedRequestId"),
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
          nonce: bigintArg(args, "nonce"),
          deliveryDigest: stringArg<Hex>(args, "deliveryDigest"),
        },
        derivation,
      };
    case "VerdictDeliveryPrepared":
      return {
        event: eventName,
        facts: {
          evaluator: stringArg<Address>(args, "evaluator"),
          expectedRequestId: stringArg<Hex>(args, "expectedRequestId"),
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
          verdictIndex: numberArg(args, "verdictIndex"),
          nonce: bigintArg(args, "nonce"),
          deliveryDigest: stringArg<Hex>(args, "deliveryDigest"),
          verdictCode: numberArg(args, "verdictCode"),
        },
        derivation,
      };
    case "SolutionDeliveryClaimed":
      return {
        event: eventName,
        facts: {
          operator: stringArg<Address>(args, "operator"),
          requestId: stringArg<Hex>(args, "requestId"),
          deliveryDigest: stringArg<Hex>(args, "deliveryDigest"),
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
        },
        derivation,
      };
    case "VerdictDeliveryClaimed":
      return {
        event: eventName,
        facts: {
          evaluator: stringArg<Address>(args, "evaluator"),
          requestId: stringArg<Hex>(args, "requestId"),
          evaluationDeliveryDigest: stringArg<Hex>(args, "evaluationDeliveryDigest"),
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
          verdictIndex: numberArg(args, "verdictIndex"),
          verdictCode: numberArg(args, "verdictCode"),
        },
        derivation,
      };
    case "AttemptsAdded":
      return {
        event: eventName,
        facts: {
          taskId: bigintArg(args, "taskId"),
          creator: stringArg<Address>(args, "creator"),
          added: numberArg(args, "added"),
          newMaxTotal: numberArg(args, "newMaxTotal"),
        },
        derivation,
      };
    case "AttemptExpired":
    case "AttemptReleased":
    case "AttemptForfeited":
      return {
        event: eventName,
        facts: {
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
          operator: stringArg<Address>(args, "operator"),
        },
        derivation,
      };
    case "VerdictForfeited":
      return {
        event: eventName,
        facts: {
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
          verdictIndex: numberArg(args, "verdictIndex"),
          evaluator: stringArg<Address>(args, "evaluator"),
        },
        derivation,
      };
    case "TaskClosed":
      return {
        event: eventName,
        facts: {
          taskId: bigintArg(args, "taskId"),
          creator: stringArg<Address>(args, "creator"),
        },
        derivation,
      };
    case "ReservationForfeited":
      return {
        event: eventName,
        facts: {
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
          verdictIndex: numberArg(args, "verdictIndex"),
          requestId: stringArg<Hex>(args, "requestId"),
          rate: bigintArg(args, "rate"),
          legKind: numberArg(args, "legKind"),
        },
        derivation,
      };
    default:
      return commonEvent(eventName, args, derivation);
  }
}

/**
 * Decodes only the router event contract available in the selected generation. The unchanged
 * external Mech Deliver event is decoded in both generations as an operational join, but V3
 * router topics are never composed into revised mode and V4 topics never enter today mode.
 */
export function decodeMarketplaceLogs(
  logs: readonly MarketplaceRawLog[],
  authority: MarketplaceEventOriginAuthority,
): MarketplaceEvent[] {
  const generation = authority.config.generation;
  const abi = generation === "today"
    ? TODAY_PROJECTOR_EVENTS_ABI
    : REVISED_DECODE_EVENTS_ABI;
  const knownTopics = generation === "today" ? TODAY_EVENT_TOPICS : REVISED_EVENT_TOPICS;
  const events: MarketplaceEvent[] = [];

  for (const log of logs) {
    if (log.topics.length === 0) continue;
    if (!authorizedOrigin(log, authority)) continue;
    try {
      const decoded = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      const derivation = createDerivationAnnotation(log, decoded.eventName, generation);
      const args = argsRecord(decoded.args);
      const event = generation === "today"
        ? todayEvent(decoded.eventName, args, derivation)
        : revisedEvent(decoded.eventName, args, derivation);
      if (event !== undefined) events.push(event);
    } catch (cause) {
      const claimedTopic = log.topics[0];
      if (claimedTopic !== undefined && knownTopics.has(claimedTopic)) throw cause;
      // The projector consumes logs from several addresses. A topic outside the selected
      // generation's exact ABI set is unrelated input and contributes no event fact.
    }
  }

  return events;
}
