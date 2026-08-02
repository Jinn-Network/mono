// SPDX-License-Identifier: MIT

import {
  BASE_SEPOLIA_TODAY,
  SafeInnerRevertError,
  computeRawCodecCid,
  type SettlementPorts,
} from "@jinn-network/marketplace-binding";
import { REVISED_COMMON_PROJECTOR_EVENTS_ABI } from "@jinn-network/marketplace-projector";
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { describe, expect, test, vi } from "vitest";
import type { BaseVenueSafeBroadcaster, SafeBroadcastReceipt } from "../broadcast/safe-broadcaster.js";
import type { ChainLogSource } from "../log-source/chain-log-source.js";
import { createSettlementPorts, type SettlementWriterInput } from "./settlement.js";

const REVISED_CONFIG = { ...BASE_SEPOLIA_TODAY, generation: "revised" as const };
const SAFE_ADDRESS = "0x2222222222222222222222222222222222222222" as Address;
const PRIORITY_MECH = "0x3333333333333333333333333333333333333333" as Address;
const REQUEST_ID = `0x${"b".repeat(64)}` as Hex;
const TASK_ID = 42n;
const ATTEMPT_INDEX = 3;
const TX_HASH = `0x${"a".repeat(64)}` as Hex;
const DELIVERY_DIGEST = `0x${"c".repeat(64)}` as Hex;

function successReceipt(logs: readonly Log[]): SafeBroadcastReceipt {
  return { txHash: TX_HASH, blockNumber: 1n, blockHash: `0x${"d".repeat(64)}` as Hex, logs, alreadySettled: false };
}

function alreadySettledReceipt(): SafeBroadcastReceipt {
  return { txHash: "0x" as Hex, blockNumber: 0n, blockHash: "0x" as Hex, logs: [], alreadySettled: true };
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

function mockLogSource(logs: readonly Log[]): ChainLogSource {
  return {
    poll: () => {
      throw new Error("not exercised by this test");
    },
    cursor: () => ({ blockNumber: 10n, blockHash: `0x${"1".repeat(64)}` as Hex }),
    finalizedCheckpoint: () => undefined,
    logsInRange: vi.fn(async () => logs) as unknown as ChainLogSource["logsInRange"],
    orphanedBlockHashes: () => new Set(),
    close: () => undefined,
  };
}

function todayDeliverLog(input: { readonly requestId: Hex; readonly dataHex: Hex }): Log {
  const topics = encodeEventTopics({
    abi: [{
      type: "event", name: "Deliver",
      inputs: [
        { name: "mech", type: "address", indexed: true },
        { name: "mechServiceMultisig", type: "address", indexed: true },
        { name: "requestId", type: "bytes32", indexed: false },
        { name: "deliveryRate", type: "uint256", indexed: false },
        { name: "data", type: "bytes", indexed: false },
      ],
    }] as const,
    eventName: "Deliver",
    args: { mech: PRIORITY_MECH, mechServiceMultisig: SAFE_ADDRESS },
  });
  const data = encodeAbiParameters(
    parseAbiParameters("bytes32 requestId, uint256 deliveryRate, bytes data"),
    [input.requestId, 0n, input.dataHex],
  );
  return {
    address: PRIORITY_MECH, topics, data,
    blockHash: `0x${"e".repeat(64)}` as Hex, blockNumber: 5n, logIndex: 0,
    transactionHash: TX_HASH, transactionIndex: 0, removed: false,
  } as Log;
}

function solutionDeliveryClaimedLog(input: {
  readonly requestId: Hex;
  readonly deliveryDigest: Hex;
  readonly taskId: bigint;
  readonly attemptIndex: number;
}): Log {
  const topics = encodeEventTopics({
    abi: REVISED_COMMON_PROJECTOR_EVENTS_ABI,
    eventName: "SolutionDeliveryClaimed",
    args: { operator: SAFE_ADDRESS, requestId: input.requestId, deliveryDigest: input.deliveryDigest },
  });
  const data = encodeAbiParameters(
    parseAbiParameters("uint256 taskId, uint32 attemptIndex"),
    [input.taskId, input.attemptIndex],
  );
  return {
    address: REVISED_CONFIG.jinnRouter, topics, data,
    blockHash: `0x${"f".repeat(64)}` as Hex, blockNumber: 6n, logIndex: 0,
    transactionHash: TX_HASH, transactionIndex: 0, removed: false,
  } as Log;
}

function baseInput(overrides: Partial<SettlementWriterInput> = {}): SettlementWriterInput {
  return {
    chain: BASE_SEPOLIA_TODAY,
    publicClient: {} as PublicClient,
    safeAddress: SAFE_ADDRESS,
    broadcaster: mockBroadcaster(async () => successReceipt([])),
    logSource: mockLogSource([]),
    pin: vi.fn(async () => undefined),
    verifySettlementGrade: vi.fn() as unknown as SettlementPorts["verifySettlementGrade"],
    ...overrides,
  };
}

describe("readMechDeliveryFacts", () => {
  test("scans the log source (never a bare unbounded getLogs) and decodes the requestId's sha256 raw-CID digest", async () => {
    const { cid, sha256Digest } = computeRawCodecCid(new TextEncoder().encode("solution-bytes"));
    const dataHex = toHex(new TextEncoder().encode(cid));
    const logSource = mockLogSource([todayDeliverLog({ requestId: REQUEST_ID, dataHex })]);
    const input = baseInput({ logSource, publicClient: { getBlockNumber: async () => 100n } as unknown as PublicClient });
    const ports = createSettlementPorts(input);

    const facts = await ports.readMechDeliveryFacts({ requestId: REQUEST_ID, config: BASE_SEPOLIA_TODAY });

    expect(facts).toEqual({ requestId: REQUEST_ID, sha256CidDigest: sha256Digest });
    expect(logSource.logsInRange).toHaveBeenCalledWith(0n, 100n);
  });

  // E44: production deliver-leg writes a raw 32-byte sha256 digest, not UTF-8 CID text.
  test("decodes a raw 32-byte sha256 digest from Deliver.data (production deliver-leg shape)", async () => {
    const digestHex = "a".repeat(64);
    const dataHex = `0x${digestHex}` as Hex;
    const logSource = mockLogSource([todayDeliverLog({ requestId: REQUEST_ID, dataHex })]);
    const input = baseInput({ logSource, publicClient: { getBlockNumber: async () => 100n } as unknown as PublicClient });
    const ports = createSettlementPorts(input);

    const facts = await ports.readMechDeliveryFacts({ requestId: REQUEST_ID, config: BASE_SEPOLIA_TODAY });

    expect(facts).toEqual({ requestId: REQUEST_ID, sha256CidDigest: `sha256:${digestHex}` });
  });

  test("throws, naming the requestId, when no Deliver event exists", async () => {
    const logSource = mockLogSource([]);
    const input = baseInput({ logSource, publicClient: { getBlockNumber: async () => 100n } as unknown as PublicClient });
    const ports = createSettlementPorts(input);

    await expect(ports.readMechDeliveryFacts({ requestId: REQUEST_ID, config: BASE_SEPOLIA_TODAY }))
      .rejects.toThrow(new RegExp(REQUEST_ID));
  });
});

describe("readRouterDeliveryFacts", () => {
  test("today generation reads {generation, requestId, keccakEvidenceHash} via the TaskCoordinator", async () => {
    const evidenceHash = `0x${"9".repeat(64)}` as Hex;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getRequestRef") return [TASK_ID, ATTEMPT_INDEX, true];
      if (functionName === "getAttempt") {
        return {
          taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX, operator: SAFE_ADDRESS, requestId: REQUEST_ID,
          solutionCidDigest: evidenceHash, solutionWeight: 0n, verdictCount: 0, status: 3,
        };
      }
      throw new Error(`unexpected readContract call: ${functionName}`);
    });
    const input = baseInput({ publicClient: { readContract } as unknown as PublicClient });
    const ports = createSettlementPorts(input);

    const facts = await ports.readRouterDeliveryFacts({ requestId: REQUEST_ID, config: BASE_SEPOLIA_TODAY });

    expect(facts).toEqual({ generation: "today", requestId: REQUEST_ID, keccakEvidenceHash: evidenceHash });
  });

  test("revised generation reads {generation, requestId, taskId, attemptIndex, sha256Digest} from the router's SolutionDeliveryClaimed log", async () => {
    const getContractEvents = vi.fn(async () => [{
      args: { taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX, deliveryDigest: DELIVERY_DIGEST },
    }]);
    const input = baseInput({
      chain: REVISED_CONFIG,
      publicClient: { getContractEvents } as unknown as PublicClient,
    });
    const ports = createSettlementPorts(input);

    const facts = await ports.readRouterDeliveryFacts({ requestId: REQUEST_ID, config: REVISED_CONFIG });

    expect(facts).toEqual({
      generation: "revised", requestId: REQUEST_ID, taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX,
      sha256Digest: `sha256:${DELIVERY_DIGEST.slice(2)}`,
    });
  });
});

describe("claimSolutionDelivery", () => {
  test("returns the mined transaction identity and uses an injected durable operation identity", async () => {
    const readContract = vi.fn(async () => false);
    const broadcaster = mockBroadcaster(async () => successReceipt([]));
    const input = baseInput({ publicClient: { readContract } as unknown as PublicClient, broadcaster });
    const ports = createSettlementPorts(input);

    const result = await ports.claimSolutionDelivery({
      requestId: REQUEST_ID,
      solutionDigest: DELIVERY_DIGEST,
      operationId: `sha256:${"4".repeat(64)}`,
    });

    expect(result).toEqual({ status: "settled", txHash: TX_HASH });
    expect(broadcaster.execute).toHaveBeenCalledWith(expect.objectContaining({
      to: BASE_SEPOLIA_TODAY.jinnRouter, value: 0n, logicalTx: `sha256:${"4".repeat(64)}`,
    }));
  });

  test("returns already-settled when the router's claimed(requestId) view already reads true, without broadcasting", async () => {
    const readContract = vi.fn(async () => true);
    const broadcaster = mockBroadcaster(async () => successReceipt([]));
    const getContractEvents = vi.fn(async () => [{ transactionHash: TX_HASH }]);
    const input = baseInput({
      publicClient: { readContract, getContractEvents } as unknown as PublicClient,
      broadcaster,
    });
    const ports = createSettlementPorts(input);

    const result = await ports.claimSolutionDelivery({ requestId: REQUEST_ID, solutionDigest: DELIVERY_DIGEST });

    expect(result).toEqual({ status: "already-settled", txHash: TX_HASH });
    expect(broadcaster.execute).not.toHaveBeenCalled();
  });

  test("returns already-settled when the broadcaster reports alreadySettled", async () => {
    const readContract = vi.fn(async () => false);
    const getContractEvents = vi.fn(async () => [{ transactionHash: TX_HASH }]);
    const broadcaster = mockBroadcaster(async () => alreadySettledReceipt());
    const input = baseInput({
      publicClient: { readContract, getContractEvents } as unknown as PublicClient,
      broadcaster,
    });
    const ports = createSettlementPorts(input);

    const result = await ports.claimSolutionDelivery({ requestId: REQUEST_ID, solutionDigest: DELIVERY_DIGEST });

    expect(result).toEqual({ status: "already-settled", txHash: TX_HASH });
  });

  test("returns rejected on a decoded permanent inner revert that is not an already-claimed variant", async () => {
    const readContract = vi.fn(async () => false);
    const revertError = new SafeInnerRevertError("reverted", "0xdeadbeef", "0x", "RouterZeroValue", [], TX_HASH);
    const broadcaster = mockBroadcaster(async () => {
      throw revertError;
    });
    const input = baseInput({ publicClient: { readContract } as unknown as PublicClient, broadcaster });
    const ports = createSettlementPorts(input);

    const result = await ports.claimSolutionDelivery({ requestId: REQUEST_ID, solutionDigest: DELIVERY_DIGEST });

    expect(result).toEqual({ status: "rejected" });
  });

  test("returns delivered-unsettled when the router refuses this claimant (RouterWrongDeliveryOperator)", async () => {
    const readContract = vi.fn(async () => false);
    const revertError = new SafeInnerRevertError(
      "reverted", "0xdeadbeef", "0x", "RouterWrongDeliveryOperator", [], TX_HASH,
    );
    const broadcaster = mockBroadcaster(async () => {
      throw revertError;
    });
    const input = baseInput({ publicClient: { readContract } as unknown as PublicClient, broadcaster });
    const ports = createSettlementPorts(input);

    const result = await ports.claimSolutionDelivery({ requestId: REQUEST_ID, solutionDigest: DELIVERY_DIGEST });

    expect(result).toEqual({ status: "delivered-unsettled" });
  });
});

describe("settleRevisedSolutionDelivery", () => {
  function revisedReadContract(overrides: Record<string, unknown> = {}) {
    return vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "solutionReservations") {
        return [1, TASK_ID, ATTEMPT_INDEX, 0, SAFE_ADDRESS, PRIORITY_MECH, 5n, 0n, false, false];
      }
      if (functionName === "tokenPaymentType") return `0x${"7".repeat(64)}` as Hex;
      if (functionName === "mapNonces") return 1n;
      if (functionName === "getRequestId") return REQUEST_ID;
      const value = overrides[functionName];
      if (value !== undefined) return value;
      throw new Error(`unexpected readContract call: ${functionName}`);
    });
  }

  test("submits exactly one Safe transaction and returns the requestId decoded from SolutionDeliveryClaimed", async () => {
    const log = solutionDeliveryClaimedLog({
      requestId: REQUEST_ID, deliveryDigest: DELIVERY_DIGEST, taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX,
    });
    const broadcaster = mockBroadcaster(async () => successReceipt([log]));
    const input = baseInput({
      chain: REVISED_CONFIG,
      publicClient: { readContract: revisedReadContract() } as unknown as PublicClient,
      broadcaster,
    });
    const ports = createSettlementPorts(input);

    const result = await ports.settleRevisedSolutionDelivery?.({
      taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX, deliveryDigest: DELIVERY_DIGEST,
      deliveryBytes: new TextEncoder().encode("delivery"),
    });

    expect(result).toEqual({ status: "settled", requestId: REQUEST_ID });
    expect(broadcaster.execute).toHaveBeenCalledTimes(1);
  });

  test("is absent (undefined) when chain.generation === 'today'", () => {
    const ports = createSettlementPorts(baseInput());
    expect(ports.settleRevisedSolutionDelivery).toBeUndefined();
  });

  test("recovers the requestId from the router's SolutionDeliveryClaimed history when the broadcaster reports alreadySettled", async () => {
    const getContractEvents = vi.fn(async () => [{ args: { requestId: REQUEST_ID } }]);
    const broadcaster = mockBroadcaster(async () => alreadySettledReceipt());
    const input = baseInput({
      chain: REVISED_CONFIG,
      publicClient: {
        readContract: revisedReadContract(), getContractEvents,
      } as unknown as PublicClient,
      broadcaster,
    });
    const ports = createSettlementPorts(input);

    const result = await ports.settleRevisedSolutionDelivery?.({
      taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX, deliveryDigest: DELIVERY_DIGEST,
      deliveryBytes: new TextEncoder().encode("delivery"),
    });

    expect(result).toEqual({ status: "already-settled", requestId: REQUEST_ID });
    expect(getContractEvents).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "SolutionDeliveryClaimed", args: { deliveryDigest: DELIVERY_DIGEST },
    }));
  });

  test("returns rejected on a decoded permanent inner revert", async () => {
    const revertError = new SafeInnerRevertError("reverted", "0xdeadbeef", "0x", "RouterZeroValue", [], TX_HASH);
    const broadcaster = mockBroadcaster(async () => {
      throw revertError;
    });
    const input = baseInput({
      chain: REVISED_CONFIG,
      publicClient: { readContract: revisedReadContract() } as unknown as PublicClient,
      broadcaster,
    });
    const ports = createSettlementPorts(input);

    const result = await ports.settleRevisedSolutionDelivery?.({
      taskId: TASK_ID, attemptIndex: ATTEMPT_INDEX, deliveryDigest: DELIVERY_DIGEST,
      deliveryBytes: new TextEncoder().encode("delivery"),
    });

    expect(result).toEqual({ status: "rejected" });
  });
});

describe("pin and verifySettlementGrade pass-through", () => {
  test("are exposed unchanged on the settlement ports", () => {
    const input = baseInput();
    const ports = createSettlementPorts(input);

    expect(ports.pin).toBe(input.pin);
    expect(ports.verifySettlementGrade).toBe(input.verifySettlementGrade);
  });
});
