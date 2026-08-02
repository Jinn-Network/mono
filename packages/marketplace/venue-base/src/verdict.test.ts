// SPDX-License-Identifier: MIT

import { VerdictCode } from "@jinn-network/marketplace-binding";
import { describe, expect, test, vi } from "vitest";
import type { Address, Hex } from "viem";
import type { BaseVenueSafeBroadcaster, SafeBroadcastReceipt } from "./broadcast/safe-broadcaster.js";
import { createVerdictPorts } from "./verdict.js";

const ROUTER = "0x00000000000000000000000000000000000000a1" as Address;
const MECH = "0x00000000000000000000000000000000000000b2" as Address;
const SAFE = "0x00000000000000000000000000000000000000c3" as Address;
const REQUEST_ID = `0x${"11".repeat(32)}` as Hex;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const OPERATION_ID = "native-v1:verdict:delivery:1";

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

  test("claimVerdictDelivery reports already-settled without broadcasting", async () => {
    const d = deps();
    (d.publicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const ports = createVerdictPorts(d);
    const result = await ports.claimVerdictDelivery({
      operationId: OPERATION_ID,
      requestId: REQUEST_ID,
      verdictDigest: `0x${"22".repeat(32)}`,
      verdictCode: VerdictCode.Fail,
    });
    expect(result).toEqual({ operationId: OPERATION_ID, status: "already-settled" });
    expect(d.broadcaster.execute).not.toHaveBeenCalled();
  });

  test("every write uses the caller-owned stable operation id and returns a transaction identity", async () => {
    const d = deps();
    const ports = createVerdictPorts(d);
    const result = await ports.deliverVerdictToMarketplace({
      operationId: OPERATION_ID,
      requestId: REQUEST_ID,
      deliveryDigest: `0x${"33".repeat(32)}`,
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
