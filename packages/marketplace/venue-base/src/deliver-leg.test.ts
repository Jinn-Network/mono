// SPDX-License-Identifier: MIT

import {
  MECH_ABI,
  MECH_DELIVER_TO_MARKETPLACE_ABI,
  computeRawCodecCid,
} from "@jinn-network/marketplace-binding";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { describe, expect, test, vi } from "vitest";
import type { BaseVenueSafeBroadcaster, SafeBroadcastReceipt } from "./broadcast/safe-broadcaster.js";
import { deliverToMarketplace, encodeMechDeliverCalldata } from "./deliver-leg.js";

const MECH = "0x3333333333333333333333333333333333333333" as Address;
const REQUEST = `0x${"d".repeat(64)}` as Hex;
const OTHER_REQUEST = `0x${"f".repeat(64)}` as Hex;
const TX_HASH = `0x${"e".repeat(64)}` as Hex;
const BYTES = new TextEncoder().encode('{"protocol":"https://jinn.network/profiles/task-execution/1.0"}');

function successReceipt(logs: readonly Log[]): SafeBroadcastReceipt {
  return { txHash: TX_HASH, blockNumber: 1n, blockHash: `0x${"c".repeat(64)}` as Hex, logs, alreadySettled: false };
}

function alreadySettledReceipt(): SafeBroadcastReceipt {
  return { txHash: "0x" as Hex, blockNumber: 0n, blockHash: "0x" as Hex, logs: [], alreadySettled: true };
}

/** A real Mech `Deliver` event log for `requestId` (`requestId` is a non-indexed field). */
function deliverLog(requestId: Hex): Log {
  const topics = encodeEventTopics({
    abi: MECH_ABI,
    eventName: "Deliver",
    args: { mech: MECH, mechServiceMultisig: MECH },
  });
  const data = encodeAbiParameters(
    parseAbiParameters("bytes32 requestId, uint256 deliveryRate, bytes data"),
    [requestId, 0n, "0x"],
  );
  return {
    address: MECH,
    topics,
    data,
    blockHash: `0x${"a".repeat(64)}` as Hex,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    removed: false,
  } as Log;
}

function mockBroadcaster(
  execute: (request: unknown) => Promise<SafeBroadcastReceipt>,
  classify: BaseVenueSafeBroadcaster["classify"] = () => {
    throw new Error("not exercised by this test");
  },
): BaseVenueSafeBroadcaster {
  return {
    execute: vi.fn(execute) as BaseVenueSafeBroadcaster["execute"],
    classify,
    broadcastCreateTask: () => {
      throw new Error("not exercised by this test");
    },
  };
}

describe("marketplace deliver leg", () => {
  test("encodes deliverToMarketplace with the Delivery raw-CID sha256 digest", () => {
    const data = encodeMechDeliverCalldata({ requestId: REQUEST, deliveryBytes: BYTES });
    const decoded = decodeFunctionData({ abi: MECH_DELIVER_TO_MARKETPLACE_ABI, data });

    expect(decoded.functionName).toBe("deliverToMarketplace");
    const [requestIds, datas] = decoded.args;
    expect(requestIds).toEqual([REQUEST]);
    expect(datas).toEqual([`0x${computeRawCodecCid(BYTES).sha256Digest.slice("sha256:".length)}`]);
  });

  test("broadcasts once through the venue broadcaster with a per-requestId logicalTx", async () => {
    const broadcaster = mockBroadcaster(async () => successReceipt([deliverLog(REQUEST)]));

    const result = await deliverToMarketplace(
      { mechAddress: MECH, requestId: REQUEST, deliveryBytes: BYTES },
      broadcaster,
    );

    expect(result).toEqual({ delivered: "sent", txHash: TX_HASH });
    expect(broadcaster.execute).toHaveBeenCalledExactlyOnceWith({
      to: MECH,
      value: 0n,
      data: encodeMechDeliverCalldata({ requestId: REQUEST, deliveryBytes: BYTES }),
      logicalTx: `deliver:${REQUEST}`,
    });
  });

  test("reports an already-delivered request instead of throwing when the broadcaster classifies the revert already-settled", async () => {
    const broadcaster = mockBroadcaster(
      async () => {
        throw new Error("execution reverted: some undecoded mech selector");
      },
      () => "already-settled",
    );

    const result = await deliverToMarketplace(
      { mechAddress: MECH, requestId: REQUEST, deliveryBytes: BYTES },
      broadcaster,
    );

    expect(result).toEqual({ delivered: "already" });
  });

  test("falls back to the regex when a thrown already-delivered revert is not classifiable", async () => {
    const broadcaster = mockBroadcaster(
      async () => {
        throw new Error("execution reverted: AlreadyDelivered()");
      },
      () => "permanent",
    );

    const result = await deliverToMarketplace(
      { mechAddress: MECH, requestId: REQUEST, deliveryBytes: BYTES },
      broadcaster,
    );

    expect(result).toEqual({ delivered: "already" });
  });

  test("reports already-delivered when the tx succeeds but no Deliver event landed for our requestId (front-run / duplicate)", async () => {
    // OlasMech.deliverToMarketplace / MechMarketplace.deliverMarketplace do not revert on a
    // stale requestId -- the delivery loop `continue`s that entry and emits RevokeRequest instead
    // of Deliver, so the Safe tx still succeeds with no inner revert at all.
    const broadcaster = mockBroadcaster(async () => successReceipt([deliverLog(OTHER_REQUEST)]));

    const result = await deliverToMarketplace(
      { mechAddress: MECH, requestId: REQUEST, deliveryBytes: BYTES },
      broadcaster,
    );

    expect(result).toEqual({ delivered: "already" });
  });

  test("reports already-delivered when the broadcaster itself resolves an already-settled receipt", async () => {
    const broadcaster = mockBroadcaster(async () => alreadySettledReceipt());

    const result = await deliverToMarketplace(
      { mechAddress: MECH, requestId: REQUEST, deliveryBytes: BYTES },
      broadcaster,
    );

    expect(result).toEqual({ delivered: "already" });
  });

  test("rethrows an unrelated, unclassifiable revert", async () => {
    const broadcaster = mockBroadcaster(
      async () => {
        throw new Error("execution reverted: NotAuthorized()");
      },
      () => "permanent",
    );

    await expect(
      deliverToMarketplace({ mechAddress: MECH, requestId: REQUEST, deliveryBytes: BYTES }, broadcaster),
    ).rejects.toThrow("NotAuthorized");
  });
});
