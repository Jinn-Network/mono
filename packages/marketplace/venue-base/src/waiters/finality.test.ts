// SPDX-License-Identifier: MIT

// The finality waiter is the last honest gate before decision-grade compute (design §6.1, N2):
// it must apply the projector's `finalityPolicy` exactly, treat a reorged claim distinctly from
// a failed one (the pipeline's release branch depends on that distinction), and never throw --
// a stuck receipt lookup is a `failed` result, not an unhandled rejection.
import { describe, expect, test, vi } from "vitest";
import type { Hex, PublicClient } from "viem";
import { finalityPolicy } from "@jinn-network/marketplace-projector";
import type { ChainLogCursor, ChainLogSource } from "../log-source/chain-log-source.js";
import { createFinalityWaiter } from "./finality.js";

const CLAIM_TX_HASH = `0x${"11".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"aa".repeat(32)}` as Hex;
const REORGED_CANONICAL_HASH = `0x${"bb".repeat(32)}` as Hex;
const CLAIM_BLOCK_NUMBER = 100n;

type ReceiptResult =
  | { readonly status: "success" | "reverted"; readonly blockNumber: bigint; readonly blockHash: Hex }
  | "missing";

function buildPublicClient(input: {
  readonly receipt: (call: number) => ReceiptResult;
  readonly block?: (blockNumber: bigint) => { readonly hash: Hex };
}): { readonly publicClient: PublicClient; readonly getTransactionReceipt: ReturnType<typeof vi.fn>; readonly getBlock: ReturnType<typeof vi.fn> } {
  let call = 0;
  const getTransactionReceipt = vi.fn(async () => {
    call += 1;
    const result = input.receipt(call);
    if (result === "missing") throw new Error("transaction receipt not found");
    return result;
  });
  const getBlock = vi.fn(async ({ blockNumber }: { readonly blockNumber: bigint }) => {
    if (input.block === undefined) throw new Error("unexpected getBlock call");
    return input.block(blockNumber);
  });
  return {
    publicClient: { getTransactionReceipt, getBlock } as unknown as PublicClient,
    getTransactionReceipt,
    getBlock,
  };
}

function buildLogSource(input: {
  readonly checkpoints: readonly (ChainLogCursor | undefined)[];
  readonly orphaned?: ReadonlySet<string>;
}): { readonly logSource: ChainLogSource; readonly poll: ReturnType<typeof vi.fn> } {
  let index = 0;
  const orphaned = input.orphaned ?? new Set<string>();
  const poll = vi.fn(async () => {
    index = Math.min(index + 1, input.checkpoints.length - 1);
    return {
      logs: [],
      cursor: { blockNumber: 0n, blockHash: "0x00" as Hex },
      finalizedCheckpoint: { blockNumber: 0n, blockHash: "0x00" as Hex },
    };
  });
  const logSource: ChainLogSource = {
    cursor: () => undefined,
    finalizedCheckpoint: () => input.checkpoints[index],
    orphanedBlockHashes: () => orphaned,
    async logsInRange() {
      return [];
    },
    poll,
    close: () => undefined,
  };
  return { logSource, poll };
}

describe("createFinalityWaiter", () => {
  test("a claim block at or below the finalized checkpoint resolves ok:true on the first poll", async () => {
    const { publicClient, getTransactionReceipt, getBlock } = buildPublicClient({
      receipt: () => ({ status: "success", blockNumber: CLAIM_BLOCK_NUMBER, blockHash: BLOCK_HASH }),
      block: () => ({ hash: BLOCK_HASH }),
    });
    const { logSource, poll } = buildLogSource({
      checkpoints: [{ blockNumber: CLAIM_BLOCK_NUMBER, blockHash: BLOCK_HASH }],
    });
    const sleep = vi.fn(async () => {
      throw new Error("should not need to sleep: checkpoint already covers the claim block");
    });
    const waiter = createFinalityWaiter({ publicClient, logSource, options: { sleep } });

    const result = await waiter.awaitFinalized({
      taskId: 1n, attemptIndex: 0, claimTxHash: CLAIM_TX_HASH,
    });

    expect(result).toEqual({ ok: true });
    expect(getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(getBlock).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  test("a claim block above the checkpoint polls until the checkpoint advances past it", async () => {
    const { publicClient } = buildPublicClient({
      receipt: () => ({ status: "success", blockNumber: CLAIM_BLOCK_NUMBER, blockHash: BLOCK_HASH }),
      block: () => ({ hash: BLOCK_HASH }),
    });
    const { logSource, poll } = buildLogSource({
      checkpoints: [
        undefined,
        { blockNumber: 50n, blockHash: BLOCK_HASH },
        { blockNumber: CLAIM_BLOCK_NUMBER, blockHash: BLOCK_HASH },
      ],
    });
    const sleep = vi.fn(async () => undefined);
    const waiter = createFinalityWaiter({ publicClient, logSource, options: { sleep } });

    const result = await waiter.awaitFinalized({
      taskId: 1n, attemptIndex: 0, claimTxHash: CLAIM_TX_HASH,
    });

    expect(result).toEqual({ ok: true });
    expect(poll).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test("a claim block whose canonical hash at that height no longer matches resolves reorged, not failed", async () => {
    const { publicClient, getBlock } = buildPublicClient({
      receipt: () => ({ status: "success", blockNumber: CLAIM_BLOCK_NUMBER, blockHash: BLOCK_HASH }),
      block: () => ({ hash: REORGED_CANONICAL_HASH }),
    });
    const { logSource } = buildLogSource({
      checkpoints: [{ blockNumber: CLAIM_BLOCK_NUMBER, blockHash: BLOCK_HASH }],
    });
    const waiter = createFinalityWaiter({ publicClient, logSource });

    const result = await waiter.awaitFinalized({
      taskId: 1n, attemptIndex: 0, claimTxHash: CLAIM_TX_HASH,
    });

    expect(result).toEqual({ ok: false, kind: "reorged" });
    expect(getBlock).toHaveBeenCalledTimes(1);
  });

  test("a claim block already in orphanedBlockHashes resolves reorged without waiting for the height comparison", async () => {
    const { publicClient, getBlock } = buildPublicClient({
      receipt: () => ({ status: "success", blockNumber: CLAIM_BLOCK_NUMBER, blockHash: BLOCK_HASH }),
    });
    const { logSource, poll } = buildLogSource({
      checkpoints: [undefined],
      orphaned: new Set([BLOCK_HASH.toLowerCase()]),
    });
    const sleep = vi.fn(async () => {
      throw new Error("should not need to sleep: orphaned hash is decisive immediately");
    });
    const waiter = createFinalityWaiter({ publicClient, logSource, options: { sleep } });

    const result = await waiter.awaitFinalized({
      taskId: 1n, attemptIndex: 0, claimTxHash: CLAIM_TX_HASH,
    });

    expect(result).toEqual({ ok: false, kind: "reorged" });
    expect(getBlock).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
  });

  test("a reverted claim receipt resolves failed", async () => {
    const { publicClient, getBlock } = buildPublicClient({
      receipt: () => ({ status: "reverted", blockNumber: CLAIM_BLOCK_NUMBER, blockHash: BLOCK_HASH }),
    });
    const { logSource } = buildLogSource({ checkpoints: [undefined] });
    const waiter = createFinalityWaiter({ publicClient, logSource });

    const result = await waiter.awaitFinalized({
      taskId: 1n, attemptIndex: 0, claimTxHash: CLAIM_TX_HASH,
    });

    expect(result).toEqual({ ok: false, kind: "failed" });
    expect(getBlock).not.toHaveBeenCalled();
  });

  test("a receipt lookup that never resolves within timeoutMs resolves failed, never throws", async () => {
    const { publicClient } = buildPublicClient({ receipt: () => "missing" });
    const { logSource } = buildLogSource({ checkpoints: [undefined] });
    const waiter = createFinalityWaiter({
      publicClient,
      logSource,
      options: { timeoutMs: 20, pollIntervalMs: 5, sleep: async () => undefined },
    });

    await expect(
      waiter.awaitFinalized({ taskId: 1n, attemptIndex: 0, claimTxHash: CLAIM_TX_HASH }),
    ).resolves.toEqual({ ok: false, kind: "failed" });
  });

  test("finalityPolicy gates execution on the finalized tier exactly, never on safe", () => {
    expect(finalityPolicy({ finalityTier: "safe" }).gateExecution).toBe(false);
    expect(finalityPolicy({ finalityTier: "finalized" }).gateExecution).toBe(true);
  });
});
