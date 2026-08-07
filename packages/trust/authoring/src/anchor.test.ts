// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  NATIVE_ANCHOR_PROFILE,
  submitAnchor,
  waitForFinalizedAnchor,
  type FinalizedAnchorObservation,
} from "./anchor.js";

const DIGEST = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;
const TARGET = "0x00000000000000000000000000000000000a11c0" as const;
const TX = `0x${"ab".repeat(32)}` as `0x${string}`;

function clients(timestamp: bigint) {
  const sent: { to: string; data: string; value: bigint }[] = [];
  return {
    sent,
    walletClient: {
      async sendTransaction(input: { to: `0x${string}`; value: bigint; data: `0x${string}` }) {
        sent.push(input);
        return TX;
      },
    },
    publicClient: {
      async waitForTransactionReceipt() { return { blockNumber: 42n, status: "success" }; },
      async getBlock() { return { timestamp }; },
    },
  };
}

describe("submitAnchor", () => {
  it("sends the bare digest as calldata and returns the block time in millisecond ISO", async () => {
    const { walletClient, publicClient, sent } = clients(1_786_000_496n);
    const locator = await submitAnchor({ walletClient, publicClient, target: TARGET, digest: DIGEST });
    expect(sent).toEqual([{ to: TARGET, value: 0n, data: `0x${DIGEST.slice("sha256:".length)}` }]);
    expect(locator).toEqual({
      profile: NATIVE_ANCHOR_PROFILE,
      chainId: 84532,
      transactionHash: TX,
      contractAddress: TARGET,
      inputByteOffset: 0,
      anchorTime: "2026-08-06T07:14:56.000Z",
    });
    // The exact form the production reader emits — what makes `validFrom = anchorTime` verbatim.
    expect(locator.anchorTime).toBe(new Date(Number(1_786_000_496n) * 1_000).toISOString());
  });

  it("refuses a reverted anchor transaction", async () => {
    const { walletClient } = clients(0n);
    await expect(submitAnchor({
      walletClient,
      publicClient: {
        async waitForTransactionReceipt() { return { blockNumber: 1n, status: "reverted" }; },
        async getBlock() { return { timestamp: 0n }; },
      },
      target: TARGET,
      digest: DIGEST,
    })).rejects.toThrow(/reverted/u);
  });
});

describe("waitForFinalizedAnchor", () => {
  const locator = {
    profile: NATIVE_ANCHOR_PROFILE,
    chainId: 84532 as const,
    transactionHash: TX,
    contractAddress: TARGET,
    inputByteOffset: 0,
  };
  const observation: FinalizedAnchorObservation = {
    digest: DIGEST,
    anchorTime: "2026-08-06T07:14:56.000Z",
    chainId: 84532,
    transactionHash: TX,
    blockHash: `0x${"ef".repeat(32)}`,
    blockNumber: 42n,
    finalized: true,
  };

  it("polls until the anchor reads back finalized", async () => {
    let calls = 0;
    const result = await waitForFinalizedAnchor({
      anchorClient: {
        async lookupFinalizedAnchor() {
          calls += 1;
          return calls < 3 ? null : observation;
        },
      },
      digest: DIGEST,
      locator,
      timeoutMs: 10_000,
      pollMs: 1,
      sleep: async () => undefined,
    });
    expect(calls).toBe(3);
    expect(result).toEqual(observation);
  });

  it("refuses on timeout rather than declaring an unusable catalog a success", async () => {
    let clock = 0;
    await expect(waitForFinalizedAnchor({
      anchorClient: { async lookupFinalizedAnchor() { return null; } },
      digest: DIGEST,
      locator,
      timeoutMs: 100,
      pollMs: 10,
      now: () => clock,
      sleep: async () => { clock += 60; },
    })).rejects.toThrow(/did not read back finalized/u);
  });
});
