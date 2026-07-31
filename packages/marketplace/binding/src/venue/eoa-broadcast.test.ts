import { TaskExecutionError } from "@jinn-network/task-execution-backend";
import { encodeEventTopics, type PublicClient, type WalletClient } from "viem";
import { describe, expect, test, vi } from "vitest";
import { JINN_ROUTER_V3_ABI } from "../abis/jinn-router-v3.js";
import { createEoaBroadcastPort } from "./eoa-broadcast.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const ROUTER = "0x6f47863Ac4120A5a97Af224a5e30C3Ec2c9eA247" as const;
const TX = `0x${"ab".repeat(32)}` as const;

function taskCreatedLog(taskId: bigint, address: `0x${string}` = ROUTER) {
  const topics = encodeEventTopics({
    abi: JINN_ROUTER_V3_ABI,
    eventName: "TaskCreated",
    args: { creator: ACCOUNT, taskId, manifestDigest: `0x${"11".repeat(32)}` as const },
  });
  // taskCidDigest, maxClaims, solutionBudget, verdictBudget -- four unindexed words.
  const data = `0x${"22".repeat(32)}${(1).toString(16).padStart(64, "0")}${"0".repeat(64)}${"0".repeat(64)}` as const;
  return { address, topics, data };
}

function clients(overrides: {
  receipt?: unknown;
  sendTransaction?: ReturnType<typeof vi.fn>;
} = {}) {
  const sendTransaction = overrides.sendTransaction ?? vi.fn(async () => TX);
  const waitForTransactionReceipt = vi.fn(async () => overrides.receipt ?? {
    status: "success",
    logs: [taskCreatedLog(42n)],
  });
  const publicClient = { waitForTransactionReceipt } as unknown as PublicClient;
  const walletClient = { account: { address: ACCOUNT }, chain: null, sendTransaction } as unknown as WalletClient;
  return { publicClient, walletClient, sendTransaction, waitForTransactionReceipt };
}

describe("createEoaBroadcastPort", () => {
  test("broadcasts postTask's calldata and returns the decoded TaskCreated taskId", async () => {
    const { publicClient, walletClient, sendTransaction } = clients();
    const port = createEoaBroadcastPort(publicClient, walletClient);

    const outcome = await port.broadcastCreateTask({
      safeAddress: ACCOUNT, to: ROUTER, value: 15n, data: "0xdeadbeef",
    });

    expect(outcome).toEqual({ taskId: 42n, txHash: TX });
    expect(sendTransaction.mock.calls[0]?.[0]).toMatchObject({ to: ROUTER, data: "0xdeadbeef", value: 15n });
  });

  test("refuses to post under a creator of record that is not this wallet's account", async () => {
    const { publicClient, walletClient, sendTransaction } = clients();
    const port = createEoaBroadcastPort(publicClient, walletClient);

    await expect(port.broadcastCreateTask({
      safeAddress: "0x2222222222222222222222222222222222222222",
      to: ROUTER, value: 1n, data: "0x00",
    })).rejects.toBeInstanceOf(TaskExecutionError);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  test("throws on a reverted receipt", async () => {
    const { publicClient, walletClient } = clients({ receipt: { status: "reverted", logs: [] } });
    const port = createEoaBroadcastPort(publicClient, walletClient);
    await expect(port.broadcastCreateTask({ safeAddress: ACCOUNT, to: ROUTER, value: 1n, data: "0x00" }))
      .rejects.toThrow(/reverted/u);
  });

  test("ignores a TaskCreated emitted by another address and reports the missing event", async () => {
    const { publicClient, walletClient } = clients({
      receipt: { status: "success", logs: [taskCreatedLog(9n, "0x3333333333333333333333333333333333333333")] },
    });
    const port = createEoaBroadcastPort(publicClient, walletClient);
    // `TaskExecutionError` carries its prose in `detail`, not `message` (the tree's convention --
    // see `posting.test.ts`), so the missing-event report is asserted there.
    await expect(port.broadcastCreateTask({ safeAddress: ACCOUNT, to: ROUTER, value: 1n, data: "0x00" }))
      .rejects.toMatchObject({
        category: "protocol-violation",
        detail: expect.stringMatching(/TaskCreated/u),
      });
  });

  test("serializes concurrent broadcasts so one EOA nonce sequence is not raced", async () => {
    const order: string[] = [];
    const sendTransaction = vi.fn(async () => { order.push("send"); return TX; });
    const { publicClient, walletClient } = clients({ sendTransaction });
    const port = createEoaBroadcastPort(publicClient, walletClient);

    await Promise.all([
      port.broadcastCreateTask({ safeAddress: ACCOUNT, to: ROUTER, value: 1n, data: "0x01" }),
      port.broadcastCreateTask({ safeAddress: ACCOUNT, to: ROUTER, value: 1n, data: "0x02" }),
    ]);

    expect(order).toEqual(["send", "send"]);
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });

  test("a failed broadcast does not wedge the queue for the next caller", async () => {
    const sendTransaction = vi.fn()
      .mockRejectedValueOnce(new Error("nonce too low"))
      .mockResolvedValueOnce(TX);
    const { publicClient, walletClient } = clients({ sendTransaction });
    const port = createEoaBroadcastPort(publicClient, walletClient);

    await expect(port.broadcastCreateTask({ safeAddress: ACCOUNT, to: ROUTER, value: 1n, data: "0x01" }))
      .rejects.toThrow(/nonce too low/u);
    await expect(port.broadcastCreateTask({ safeAddress: ACCOUNT, to: ROUTER, value: 1n, data: "0x02" }))
      .resolves.toEqual({ taskId: 42n, txHash: TX });
  });
});
