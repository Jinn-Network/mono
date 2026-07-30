// SPDX-License-Identifier: MIT

import { BASE_SEPOLIA_TODAY, JINN_ROUTER_V3_ABI } from "@jinn-network/marketplace-binding";
import { REVISED_COMMON_PROJECTOR_EVENTS_ABI } from "@jinn-network/marketplace-projector";
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { describe, expect, test, vi } from "vitest";
import type { BaseVenueSafeBroadcaster, SafeBroadcastReceipt } from "../broadcast/safe-broadcaster.js";
import {
  createClaimPreflight,
  createClaimWriter,
  decodeAttemptFromLogs,
  encodeClaimTaskCalldata,
} from "./claim.js";

const REVISED_CONFIG = { ...BASE_SEPOLIA_TODAY, generation: "revised" as const };
const SAFE_ADDRESS = "0x2222222222222222222222222222222222222222" as Address;
const OTHER_OPERATOR = "0x9999999999999999999999999999999999999999" as Address;
const PRIORITY_MECH = "0x3333333333333333333333333333333333333333" as Address;
const TASK_ID = 42n;
const TX_HASH = `0x${"a".repeat(64)}` as Hex;
const REQUEST_ID = `0x${"b".repeat(64)}` as Hex;

function successReceipt(logs: readonly Log[]): SafeBroadcastReceipt {
  return { txHash: TX_HASH, blockNumber: 1n, blockHash: `0x${"c".repeat(64)}` as Hex, logs, alreadySettled: false };
}

function alreadySettledReceipt(): SafeBroadcastReceipt {
  return { txHash: "0x" as Hex, blockNumber: 0n, blockHash: "0x" as Hex, logs: [], alreadySettled: true };
}

function todayAttemptCreatedLog(
  input: { readonly taskId: bigint; readonly attemptIndex: number; readonly requestId: Hex; readonly operator: Address },
): Log {
  const topics = encodeEventTopics({
    abi: JINN_ROUTER_V3_ABI,
    eventName: "TaskAttemptCreated",
    args: { taskId: input.taskId, attemptIndex: input.attemptIndex, requestId: input.requestId },
  });
  const data = encodeAbiParameters(
    parseAbiParameters("address operator, address priorityMech, uint256 deliveryRate"),
    [input.operator, PRIORITY_MECH, 0n],
  );
  return {
    address: BASE_SEPOLIA_TODAY.jinnRouter, topics, data,
    blockHash: `0x${"d".repeat(64)}` as Hex, blockNumber: 1n, logIndex: 0,
    transactionHash: TX_HASH, transactionIndex: 0, removed: false,
  } as Log;
}

function revisedAttemptCreatedLog(
  input: { readonly taskId: bigint; readonly attemptIndex: number; readonly operator: Address },
): Log {
  const topics = encodeEventTopics({
    abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI,
    eventName: "TaskAttemptCreated",
    args: { operator: input.operator, priorityMech: PRIORITY_MECH, taskId: input.taskId },
  });
  const data = encodeAbiParameters(
    parseAbiParameters("uint32 attemptIndex, uint64 attemptDeadline, uint256 deliveryRate"),
    [input.attemptIndex, 0n, 0n],
  );
  return {
    address: REVISED_CONFIG.jinnRouter, topics, data,
    blockHash: `0x${"e".repeat(64)}` as Hex, blockNumber: 1n, logIndex: 0,
    transactionHash: TX_HASH, transactionIndex: 0, removed: false,
  } as Log;
}

function mockBroadcaster(execute: (request: unknown) => Promise<SafeBroadcastReceipt>): BaseVenueSafeBroadcaster {
  return {
    execute: vi.fn(execute) as BaseVenueSafeBroadcaster["execute"],
    classify: () => {
      throw new Error("not exercised by this test");
    },
    broadcastCreateTask: () => {
      throw new Error("not exercised by this test");
    },
  };
}

describe("createClaimWriter", () => {
  test("today generation broadcasts an encoded claimTask to the router with value 0n and a claim logicalTx, decoding the attempt from the receipt", async () => {
    const log = todayAttemptCreatedLog({ taskId: TASK_ID, attemptIndex: 3, requestId: REQUEST_ID, operator: SAFE_ADDRESS });
    const broadcaster = mockBroadcaster(async () => successReceipt([log]));
    const writer = createClaimWriter({
      chain: BASE_SEPOLIA_TODAY, publicClient: {} as PublicClient, safeAddress: SAFE_ADDRESS,
      broadcaster, priorityMech: PRIORITY_MECH,
    });

    const result = await writer.claimTask({ taskId: TASK_ID, priorityMech: PRIORITY_MECH });

    expect(result).toEqual({ attemptIndex: 3, requestId: REQUEST_ID, txHash: TX_HASH });
    expect(broadcaster.execute).toHaveBeenCalledWith({
      to: BASE_SEPOLIA_TODAY.jinnRouter,
      value: 0n,
      data: encodeClaimTaskCalldata(BASE_SEPOLIA_TODAY, TASK_ID, PRIORITY_MECH),
      logicalTx: `claim.claimTask:${TASK_ID}`,
    });
  });

  test("revised generation encodes claimTask against the V4 ABI, and a V3-shaped TaskAttemptCreated log never satisfies revised-mode decode (the two ABIs never mix)", () => {
    const revisedCalldata = encodeClaimTaskCalldata(REVISED_CONFIG, TASK_ID, PRIORITY_MECH);
    const todayCalldata = encodeClaimTaskCalldata(BASE_SEPOLIA_TODAY, TASK_ID, PRIORITY_MECH);
    // Both ABIs share the same `claimTask(uint256,address)` signature, so calldata bytes match --
    // the real distinction is on the decode/event side, not the function selector.
    expect(revisedCalldata).toEqual(todayCalldata);

    const v3Log = todayAttemptCreatedLog({ taskId: TASK_ID, attemptIndex: 3, requestId: REQUEST_ID, operator: SAFE_ADDRESS });
    expect(decodeAttemptFromLogs(REVISED_CONFIG, [v3Log])).toBeUndefined();
  });

  test("revised generation decodes attemptIndex from the V4 TaskAttemptCreated log with requestId left undefined", async () => {
    const log = revisedAttemptCreatedLog({ taskId: TASK_ID, attemptIndex: 5, operator: SAFE_ADDRESS });
    const broadcaster = mockBroadcaster(async () => successReceipt([log]));
    const writer = createClaimWriter({
      chain: REVISED_CONFIG, publicClient: {} as PublicClient, safeAddress: SAFE_ADDRESS,
      broadcaster, priorityMech: PRIORITY_MECH,
    });

    const result = await writer.claimTask({ taskId: TASK_ID, priorityMech: PRIORITY_MECH });

    expect(result.attemptIndex).toBe(5);
    expect(result.requestId).toBeUndefined();
  });

  test("today generation throws, naming the tx hash, when the receipt carries no TaskAttemptCreated event", async () => {
    const broadcaster = mockBroadcaster(async () => successReceipt([]));
    const writer = createClaimWriter({
      chain: BASE_SEPOLIA_TODAY, publicClient: {} as PublicClient, safeAddress: SAFE_ADDRESS,
      broadcaster, priorityMech: PRIORITY_MECH,
    });

    await expect(writer.claimTask({ taskId: TASK_ID, priorityMech: PRIORITY_MECH }))
      .rejects.toThrow(new RegExp(`no TaskAttemptCreated event for task ${TASK_ID}.*${TX_HASH}`));
  });

  test("an alreadySettled broadcast decodes the attempt from an on-chain TaskAttemptCreated read rather than the receipt's empty logs", async () => {
    const staleLog = revisedAttemptCreatedLog({ taskId: TASK_ID, attemptIndex: 1, operator: OTHER_OPERATOR });
    const mineLog = revisedAttemptCreatedLog({ taskId: TASK_ID, attemptIndex: 7, operator: SAFE_ADDRESS });
    const decodedEvents = [staleLog, mineLog].map((log) => ({
      ...log,
      args: (() => {
        const decoded = decodeAttemptFromLogs(REVISED_CONFIG, [log]);
        // Reuse the log's own decode to build the args viem's getContractEvents would return.
        const operatorTopic = log.topics[1] as Hex;
        return {
          operator: `0x${operatorTopic.slice(-40)}` as Address,
          attemptIndex: decoded?.attemptIndex,
        };
      })(),
    }));
    const getContractEvents = vi.fn(async () => decodedEvents);
    const broadcaster = mockBroadcaster(async () => alreadySettledReceipt());
    const writer = createClaimWriter({
      chain: REVISED_CONFIG,
      publicClient: { getContractEvents } as unknown as PublicClient,
      safeAddress: SAFE_ADDRESS,
      broadcaster,
      priorityMech: PRIORITY_MECH,
    });

    const result = await writer.claimTask({ taskId: TASK_ID, priorityMech: PRIORITY_MECH });

    expect(result.attemptIndex).toBe(7);
    expect(getContractEvents).toHaveBeenCalledWith(expect.objectContaining({
      address: REVISED_CONFIG.jinnRouter,
      eventName: "TaskAttemptCreated",
      args: { taskId: TASK_ID },
    }));
  });
});

describe("createClaimPreflight", () => {
  test("resolves { ok: true } via a Safe-address simulateContract call on success", async () => {
    const simulateContract = vi.fn(async (params: { readonly account: Address }) => {
      expect(params.account).toBe(SAFE_ADDRESS);
      return { result: 3 };
    });
    const preflight = createClaimPreflight({
      chain: BASE_SEPOLIA_TODAY,
      publicClient: { simulateContract } as unknown as PublicClient,
      safeAddress: SAFE_ADDRESS,
      broadcaster: mockBroadcaster(async () => successReceipt([])),
      priorityMech: PRIORITY_MECH,
    }, TASK_ID);

    await expect(preflight()).resolves.toEqual({ ok: true });
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      account: SAFE_ADDRESS,
      address: BASE_SEPOLIA_TODAY.jinnRouter,
      functionName: "claimTask",
      args: [TASK_ID, PRIORITY_MECH],
    }));
  });

  test("resolves { ok: false, reason } carrying the decoded TCMaxClaimsReached revert name, not a raw hex blob", async () => {
    const revertError = new Error("execution reverted") as Error & { data: Hex };
    // selector 0x90386e7c = TCMaxClaimsReached(uint256 taskId), taskId = 42.
    revertError.data = `0x90386e7c${TASK_ID.toString(16).padStart(64, "0")}` as Hex;
    const simulateContract = vi.fn(async () => {
      throw revertError;
    });
    const preflight = createClaimPreflight({
      chain: BASE_SEPOLIA_TODAY,
      publicClient: { simulateContract } as unknown as PublicClient,
      safeAddress: SAFE_ADDRESS,
      broadcaster: mockBroadcaster(async () => successReceipt([])),
      priorityMech: PRIORITY_MECH,
    }, TASK_ID);

    const result = await preflight();

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("reason", revertError.data);
    if (!result.ok) {
      expect(result.reason).toContain("TCMaxClaimsReached");
      expect(result.reason).not.toMatch(/^0x/);
    }
  });
});
