// SPDX-License-Identifier: MIT

import {
  JINN_ROUTER_V3_ABI,
  MECH_DELIVER_TO_MARKETPLACE_ABI,
  SafeInnerRevertError,
  VerdictCode,
} from "@jinn-network/marketplace-binding";
import { describe, expect, test, vi } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";
import type { BaseVenueSafeBroadcaster, SafeBroadcastReceipt } from "./broadcast/safe-broadcaster.js";
import { createVerdictPorts } from "./verdict.js";

const ROUTER = "0x00000000000000000000000000000000000000a1" as Address;
const MECH = "0x00000000000000000000000000000000000000b2" as Address;
const SAFE = "0x00000000000000000000000000000000000000c3" as Address;
const REQUEST_ID = `0x${"11".repeat(32)}` as Hex;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const CANONICAL_TX_HASH = `0x${"ef".repeat(32)}` as Hex;
const OPERATION_ID = "native-v1:verdict:delivery:1";
const DELIVERY_DIGEST = `0x${"33".repeat(32)}` as Hex;

function successReceipt(): SafeBroadcastReceipt {
  return {
    txHash: TX_HASH,
    blockNumber: 1n,
    blockHash: `0x${"cd".repeat(32)}` as Hex,
    logs: [],
    alreadySettled: false,
  };
}

function mockBroadcaster(execute: BaseVenueSafeBroadcaster["execute"]): BaseVenueSafeBroadcaster {
  return {
    execute: vi.fn(execute),
    classify: () => {
      throw new Error("not exercised by this test");
    },
    broadcastCreateTask: () => {
      throw new Error("not exercised by this test");
    },
  };
}

function canonicalVerdictSettlementEvent() {
  return {
    args: {
      evaluator: SAFE,
      requestId: REQUEST_ID,
      taskId: 7n,
      attemptIndex: 2,
      verdictIndex: 3,
      verdictCode: VerdictCode.Fail,
    },
    transactionHash: CANONICAL_TX_HASH,
    blockNumber: 9n,
    blockHash: `0x${"fe".repeat(32)}` as Hex,
    logIndex: 4,
  };
}

function canonicalVerdictDeliveryEvent() {
  return {
    args: { requestId: REQUEST_ID, data: DELIVERY_DIGEST },
    transactionHash: CANONICAL_TX_HASH,
    blockNumber: 8n,
    blockHash: `0x${"dc".repeat(32)}` as Hex,
    logIndex: 3,
  };
}

function deps(overrides: Partial<Parameters<typeof createVerdictPorts>[0]> = {}) {
  return {
    publicClient: {
      simulateContract: vi.fn().mockResolvedValue({}),
      readContract: vi.fn().mockResolvedValue(false),
      getContractEvents: vi.fn().mockResolvedValue([]),
    },
    broadcaster: mockBroadcaster(async () => successReceipt()),
    safeAddress: SAFE,
    routerAddress: ROUTER,
    mechAddress: MECH,
    ...overrides,
  } as unknown as Parameters<typeof createVerdictPorts>[0];
}

describe("verdict ports", () => {
  test("claimVerdictDelivery refuses a missing verdict code rather than defaulting to Pass", async () => {
    const ports = createVerdictPorts(deps());
    await expect(
      ports.claimVerdictDelivery({
        operationId: OPERATION_ID,
        requestId: REQUEST_ID,
        verdictDigest: `0x${"22".repeat(32)}`,
        verdictCode: undefined as unknown as VerdictCode,
      }),
    ).rejects.toThrow(/refusing to default/);
  });

  test("claimVerdictDelivery returns the canonical transaction identity for a settled replay", async () => {
    const d = deps();
    (d.publicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (d.publicClient.getContractEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
      canonicalVerdictSettlementEvent(),
    ]);
    const ports = createVerdictPorts(d);
    const result = await ports.claimVerdictDelivery({
      operationId: OPERATION_ID,
      requestId: REQUEST_ID,
      verdictDigest: `0x${"22".repeat(32)}`,
      verdictCode: VerdictCode.Fail,
      reconciliationFromBlock: 7n,
    });
    expect(result).toEqual({
      operationId: OPERATION_ID,
      status: "already-settled",
      transaction: {
        hash: CANONICAL_TX_HASH,
        blockNumber: 9n,
        blockHash: `0x${"fe".repeat(32)}`,
      },
    });
    expect(d.broadcaster.execute).not.toHaveBeenCalled();
  });

  test("fails closed when a settled replay has no caller range or canonical transaction identity", async () => {
    const d = deps();
    (d.publicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await expect(createVerdictPorts(d).claimVerdictDelivery({
      operationId: OPERATION_ID,
      requestId: REQUEST_ID,
      verdictDigest: `0x${"22".repeat(32)}`,
      verdictCode: VerdictCode.Fail,
    })).rejects.toThrow(/reconciliationFromBlock/u);
    expect(d.broadcaster.execute).not.toHaveBeenCalled();
  });

  test("reconciles a synthetic already-settled delivery receipt to the real Mech transaction", async () => {
    const d = deps({
      broadcaster: mockBroadcaster(async () => ({
        txHash: "0x" as Hex,
        blockNumber: 0n,
        blockHash: "0x" as Hex,
        logs: [],
        alreadySettled: true,
      })),
    });
    (d.publicClient.getContractEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
      canonicalVerdictDeliveryEvent(),
    ]);

    await expect(createVerdictPorts(d).deliverVerdictToMarketplace({
      operationId: OPERATION_ID,
      requestId: REQUEST_ID,
      deliveryDigest: DELIVERY_DIGEST,
      reconciliationFromBlock: 7n,
    })).resolves.toEqual({
      operationId: OPERATION_ID,
      transaction: {
        hash: CANONICAL_TX_HASH,
        blockNumber: 8n,
        blockHash: `0x${"dc".repeat(32)}`,
      },
    });
  });

  test("every write uses the caller-owned stable operation id and returns a transaction identity", async () => {
    const d = deps();
    const ports = createVerdictPorts(d);
    const result = await ports.deliverVerdictToMarketplace({
      operationId: OPERATION_ID,
      requestId: REQUEST_ID,
      deliveryDigest: DELIVERY_DIGEST,
    });

    expect(d.broadcaster.execute).toHaveBeenCalledWith(expect.objectContaining({
      to: MECH,
      value: 0n,
      logicalTx: OPERATION_ID,
    }));
    expect(result).toEqual({
      operationId: OPERATION_ID,
      transaction: {
        hash: TX_HASH,
        blockNumber: 1n,
        blockHash: `0x${"cd".repeat(32)}`,
      },
    });
  });

  test("fails closed rather than returning a synthetic successful transaction identity", async () => {
    const d = deps({
      broadcaster: mockBroadcaster(async () => ({
        txHash: "0x" as Hex,
        blockNumber: 0n,
        blockHash: "0x" as Hex,
        logs: [],
        alreadySettled: false,
      })),
    });
    const ports = createVerdictPorts(d);

    await expect(ports.deliverVerdictToMarketplace({
      operationId: "native-v1:verdict:deliver:synthetic",
      requestId: REQUEST_ID,
      deliveryDigest: DELIVERY_DIGEST,
    })).rejects.toThrow(/no real canonical transaction identity/u);
    await expect(ports.claimVerdictDelivery({
      operationId: "native-v1:verdict:claim:synthetic",
      requestId: REQUEST_ID,
      verdictDigest: DELIVERY_DIGEST,
      verdictCode: VerdictCode.Fail,
    })).rejects.toThrow(/no real canonical transaction identity/u);
  });

  test("preflights a V3 evaluation attempt successfully", async () => {
    const d = deps();
    await expect(createVerdictPorts(d).canOpenVerdictAttempt({ taskId: 7n, attemptIndex: 2 }))
      .resolves.toEqual({ ok: true });
    expect(d.publicClient.simulateContract).toHaveBeenCalledOnce();
  });

  test("preserves the exact Delivery digest from marketplace delivery through the router verdict claim", async () => {
    const d = deps();
    const ports = createVerdictPorts(d);
    await ports.deliverVerdictToMarketplace({
      operationId: "native-v1:verdict:deliver:1",
      requestId: REQUEST_ID,
      deliveryDigest: DELIVERY_DIGEST,
    });
    await ports.claimVerdictDelivery({
      operationId: "native-v1:verdict:claim:1",
      requestId: REQUEST_ID,
      verdictDigest: DELIVERY_DIGEST,
      verdictCode: VerdictCode.Fail,
    });

    const calls = (d.broadcaster.execute as ReturnType<typeof vi.fn>).mock.calls;
    const delivery = decodeFunctionData({ abi: MECH_DELIVER_TO_MARKETPLACE_ABI, data: calls[0]![0].data });
    const claim = decodeFunctionData({ abi: JINN_ROUTER_V3_ABI, data: calls[1]![0].data });
    expect(delivery.args[1]).toEqual([DELIVERY_DIGEST]);
    expect(claim.args[1]).toBe(DELIVERY_DIGEST);
  });

  test("returns rejected for a decoded permanent router failure", async () => {
    const d = deps({
      broadcaster: mockBroadcaster(async () => {
        throw new SafeInnerRevertError(
          "wrong evaluator",
          "0x" as Hex,
          "0x" as Hex,
          "RouterWrongDeliveryOperator",
          null,
          null,
        );
      }),
    });
    await expect(createVerdictPorts(d).claimVerdictDelivery({
      operationId: OPERATION_ID,
      requestId: REQUEST_ID,
      verdictDigest: DELIVERY_DIGEST,
      verdictCode: VerdictCode.Fail,
    })).resolves.toEqual({ operationId: OPERATION_ID, status: "rejected" });
  });

  test("returns a real canonical transaction identity when the broadcaster replays a verdict settlement", async () => {
    const d = deps({
      broadcaster: mockBroadcaster(async () => ({
        txHash: "0x" as Hex,
        blockNumber: 0n,
        blockHash: "0x" as Hex,
        logs: [],
        alreadySettled: true,
      })),
    });
    (d.publicClient.getContractEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
      canonicalVerdictSettlementEvent(),
    ]);
    (d.publicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await expect(createVerdictPorts(d).claimVerdictDelivery({
      operationId: OPERATION_ID,
      requestId: REQUEST_ID,
      verdictDigest: DELIVERY_DIGEST,
      verdictCode: VerdictCode.Fail,
      reconciliationFromBlock: 7n,
    })).resolves.toMatchObject({
      status: "already-settled",
      transaction: { hash: CANONICAL_TX_HASH, blockNumber: 9n },
    });
  });

  test("refuses an already-settled reconciliation without a caller-owned event range", async () => {
    const d = deps({
      broadcaster: mockBroadcaster(async () => ({ ...successReceipt(), alreadySettled: true })),
    });

    await expect(createVerdictPorts(d).openVerdictAttempt({
      operationId: OPERATION_ID,
      taskId: 7n,
      attemptIndex: 2,
      evaluationTaskCidDigest: `0x${"44".repeat(32)}`,
    })).rejects.toThrow(/reconciliationFromBlock/u);
    expect(d.publicClient.getContractEvents).not.toHaveBeenCalled();
  });

  test("reads the canonical verdict attempt for reconciliation instead of inventing request identity", async () => {
    const d = deps();
    (d.publicClient.getContractEvents as ReturnType<typeof vi.fn>).mockResolvedValue([{
      args: {
        taskId: 7n,
        attemptIndex: 2,
        verdictIndex: 3,
        requestId: REQUEST_ID,
        evaluator: SAFE,
      },
      transactionHash: TX_HASH,
      blockNumber: 9n,
      blockHash: `0x${"ef".repeat(32)}`,
      logIndex: 4,
    }]);

    await expect(createVerdictPorts(d).readCanonicalVerdictAttempt({
      taskId: 7n,
      attemptIndex: 2,
      fromBlock: 75n,
    }))
      .resolves.toEqual({
        taskId: 7n,
        attemptIndex: 2,
        verdictIndex: 3,
        requestId: REQUEST_ID,
        evaluator: SAFE,
        transaction: {
          hash: TX_HASH,
          blockNumber: 9n,
          blockHash: `0x${"ef".repeat(32)}`,
          logIndex: 4,
        },
      });
    expect(d.publicClient.getContractEvents).toHaveBeenCalledWith(expect.objectContaining({
      fromBlock: 75n,
    }));
  });
});
