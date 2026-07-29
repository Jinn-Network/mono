// SPDX-License-Identifier: MIT

import {
  JINN_ROUTER_V3_ABI,
  MECH_ABI,
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
 * These event signatures are the M7 ABI contract frozen by program ruling §7.28 and marketplace
 * Addendum 2026-07-29-e. They are deliberately projector-local until M7 introduces the V4
 * contracts and their complete ABIs. Today mode never decodes them.
 */
export const REVISED_PROJECTOR_EVENTS_ABI = [
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

const TODAY_PROJECTOR_EVENTS_ABI = [
  ...JINN_ROUTER_V3_ABI.filter((entry) => entry.type === "event"),
  ...MECH_ABI,
] as const;

const TODAY_EVENT_TOPICS = new Set(
  TODAY_PROJECTOR_EVENTS_ABI.map((event) => toEventSelector(event)),
);
const REVISED_EVENT_TOPICS = new Set(
  REVISED_PROJECTOR_EVENTS_ABI.map((event) => toEventSelector(event)),
);

export interface MarketplaceRawLog extends DerivationLog {
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

type Event<Name extends string, Facts> = {
  readonly event: Name;
  readonly facts: Facts;
  readonly derivation: DerivationAnnotation;
};

export type MarketplaceEvent =
  | Event<"TaskCreated", {
      readonly creator: Address;
      readonly taskId: bigint;
      readonly manifestDigest: Hex;
      readonly taskCidDigest: Hex;
      readonly maxClaims: number;
      readonly solutionBudget: bigint;
      readonly verdictBudget: bigint;
    }>
  | Event<"TaskAttemptCreated", {
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly operator: Address;
      readonly requestId: Hex;
      readonly priorityMech: Address;
      readonly deliveryRate: bigint;
    }>
  | Event<"EvaluationAttemptCreated", {
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly verdictIndex: number;
      readonly requestId: Hex;
      readonly evaluator: Address;
      readonly priorityMech: Address;
      readonly deliveryRate: bigint;
    }>
  | Event<"Deliver", {
      readonly mech: Address;
      readonly mechServiceMultisig: Address;
      readonly requestId: Hex;
      readonly deliveryRate: bigint;
      readonly data: Hex;
    }>
  | Event<"SolutionDeliveryClaimed", {
      readonly operator: Address;
      readonly requestId: Hex;
      readonly taskId: bigint;
      readonly attemptIndex: number;
    }>
  | Event<"VerdictDeliveryClaimed", {
      readonly evaluator: Address;
      readonly requestId: Hex;
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly verdictIndex: number;
      readonly verdictCode: number;
    }>
  | Event<"TaskBudgetRefunded", {
      readonly taskId: bigint;
      readonly creator: Address;
      readonly solutionAmount: bigint;
      readonly verdictAmount: bigint;
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

function stringArg<T extends string>(
  args: Record<string, unknown>,
  name: string,
): T {
  const value = args[name];
  if (typeof value !== "string") throw new TypeError(`${name} is not a string`);
  return value as T;
}

function eventFromDecoded(
  eventName: string,
  decodedArgs: unknown,
  derivation: DerivationAnnotation,
): MarketplaceEvent | undefined {
  const args = argsRecord(decodedArgs);
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
    case "Deliver":
      return {
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
    case "AttemptExpired":
    case "AttemptReleased":
      return {
        event: eventName,
        facts: {
          taskId: bigintArg(args, "taskId"),
          attemptIndex: numberArg(args, "attemptIndex"),
          operator: stringArg<Address>(args, "operator"),
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
    default:
      return undefined;
  }
}

/**
 * Decodes only the event set available in the selected contract generation. Unknown logs are
 * ignored; malformed logs matching a known topic are rejected by viem rather than converted to
 * invented facts.
 */
export function decodeMarketplaceLogs(
  logs: readonly MarketplaceRawLog[],
  generation: ContractGeneration,
): MarketplaceEvent[] {
  const abi = generation === "today"
    ? TODAY_PROJECTOR_EVENTS_ABI
    : [...TODAY_PROJECTOR_EVENTS_ABI, ...REVISED_PROJECTOR_EVENTS_ABI] as const;
  const events: MarketplaceEvent[] = [];

  for (const log of logs) {
    if (log.topics.length === 0) continue;
    try {
      const decoded = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      const derivation = createDerivationAnnotation(log, decoded.eventName, generation);
      const event = eventFromDecoded(decoded.eventName, decoded.args, derivation);
      if (event !== undefined) events.push(event);
    } catch (cause) {
      const claimedTopic = log.topics[0];
      const known = claimedTopic !== undefined
        && (
          TODAY_EVENT_TOPICS.has(claimedTopic)
          || (generation === "revised" && REVISED_EVENT_TOPICS.has(claimedTopic))
        );
      if (known) throw cause;
      // The projector consumes logs from several addresses. A topic outside the selected
      // generation's exact ABI set is unrelated input and contributes no event fact.
    }
  }

  return events;
}
