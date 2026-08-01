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
      requestId: REQUEST_ID,
      verdictDigest: `0x${"22".repeat(32)}`,
      verdictCode: VerdictCode.Fail,
    });
    expect(result).toEqual({ status: "already-settled" });
    expect(d.broadcaster.execute).not.toHaveBeenCalled();
  });

  test("every write goes through the injected Safe broadcast port", async () => {
    const d = deps();
    const ports = createVerdictPorts(d);
    await ports.deliverVerdictToMarketplace({
      requestId: REQUEST_ID,
      deliveryDigest: `0x${"33".repeat(32)}`,
    });
    expect(d.broadcaster.execute).toHaveBeenCalledTimes(1);
    expect(d.broadcaster.execute).toHaveBeenCalledWith(
      expect.objectContaining({ to: MECH, value: 0n }),
    );
  });
});
