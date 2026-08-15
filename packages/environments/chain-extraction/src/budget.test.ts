// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ChainStateBackend } from "@jinn-network/chain-environment-record";

import { createBudgetedArchivePort } from "./budget.js";
import { ChainExtractionError } from "./errors.js";
import { asChainStateBackend, type ArchiveRpcPort } from "./ports.js";

const ADDRESS = "0xcccccccccccccccccccccccccccccccccccccccc";

function countingPort(): ArchiveRpcPort {
  return {
    async getBlockHeader() {
      return {
        number: 21_000_000,
        hash: `0x${"1".repeat(64)}`,
        parentHash: `0x${"2".repeat(64)}`,
        stateRoot: `0x${"3".repeat(64)}`,
        timestamp: 1_760_000_000,
      };
    },
    async getAccount() {
      return { nonce: "0x0", balanceWei: "0x0", codeHash: `0x${"4".repeat(64)}` };
    },
    async getCode() {
      return "0x6001";
    },
    async getStorageAt() {
      return `0x${"0".repeat(64)}`;
    },
    async getProof() {
      return {
        address: ADDRESS,
        balance: "0x0",
        nonce: "0x0",
        codeHash: `0x${"4".repeat(64)}`,
        storageHash: `0x${"5".repeat(64)}`,
        accountProof: ["0xaabb"],
        storageProof: [],
      };
    },
  };
}

describe("the budgeted archive port", () => {
  it("journals every read as a state key, which is the harvest ground truth", async () => {
    const budgeted = createBudgetedArchivePort(countingPort(), { maxCalls: 10, maxBytes: 1_000_000 });
    await budgeted.getAccount(ADDRESS, 21_000_000);
    await budgeted.getCode(ADDRESS, 21_000_000);
    await budgeted.getStorageAt(ADDRESS, "0x1", 21_000_000);

    expect(budgeted.journal().accounts).toEqual([ADDRESS]);
    expect(budgeted.journal().code).toEqual([ADDRESS]);
    expect(budgeted.journal().storage).toEqual([
      { address: ADDRESS, slots: [`0x${"0".repeat(63)}1`] },
    ]);
    expect(budgeted.usage().calls).toBe(3);
    expect(budgeted.usage().bytes).toBeGreaterThan(0);
  });

  it("does not journal header or proof reads: they are not agent-visible state", async () => {
    const budgeted = createBudgetedArchivePort(countingPort(), { maxCalls: 10, maxBytes: 1_000_000 });
    await budgeted.getBlockHeader(21_000_000);
    await budgeted.getProof(ADDRESS, ["0x1"], 21_000_000);
    expect(budgeted.journal().accounts).toEqual([]);
    expect(budgeted.usage().calls).toBe(2);
  });

  it("refuses the call that would exceed the ceiling, before it reaches the port", async () => {
    let reached = 0;
    const port = countingPort();
    const counted: ArchiveRpcPort = {
      ...port,
      async getAccount(address, block) {
        reached += 1;
        return port.getAccount(address, block);
      },
    };
    const budgeted = createBudgetedArchivePort(counted, { maxCalls: 1, maxBytes: 1_000_000 });
    await budgeted.getAccount(ADDRESS, 21_000_000);
    await expect(budgeted.getAccount(ADDRESS, 21_000_000)).rejects.toThrow(ChainExtractionError);
    expect(reached).toBe(1);
    expect(budgeted.usage().exhausted).toBe("calls");
  });

  it("presents as CE1's ChainStateBackend, and carries account absence faithfully", async () => {
    const budgeted = createBudgetedArchivePort(countingPort(), { maxCalls: 50, maxBytes: 1_000_000 });
    // The annotation is the point: if CE1 changes the backend contract, this stops
    // compiling, which is the earliest possible warning.
    const backend: ChainStateBackend = asChainStateBackend(budgeted);
    const account = await backend.getAccount(ADDRESS, 21_000_000);
    expect(account?.balanceWei).toBe("0x0");
    // One call, not two: `storageRoot` is optional (CE1-F12), so a plain account read
    // never drags an eth_getProof behind it.
    expect(account?.storageRoot).toBeUndefined();
    expect(budgeted.usage().calls).toBe(1);

    const empty = createBudgetedArchivePort(
      { ...countingPort(), async getAccount() { return undefined; } },
      { maxCalls: 50, maxBytes: 1_000_000 },
    );
    const absent: ChainStateBackend = asChainStateBackend(empty);
    expect(await absent.getAccount(ADDRESS, 21_000_000)).toBeUndefined();
  });

  it("stays exhausted once exhausted, and reports usage on the way out", async () => {
    const budgeted = createBudgetedArchivePort(countingPort(), { maxCalls: 10, maxBytes: 1 });
    await expect(budgeted.getAccount(ADDRESS, 21_000_000)).rejects.toThrow(/maxBytes/u);
    expect(budgeted.usage().exhausted).toBe("bytes");
    await expect(budgeted.getCode(ADDRESS, 21_000_000)).rejects.toThrow(/maxBytes/u);
  });
});
