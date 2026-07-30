// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { openVenueState, type VenueStateDatabase } from "../state/database.js";
import { createSubmissionLedger, type SubmissionLedger } from "./ledger.js";
import { evictStuckNonce } from "./stuck-nonce.js";

const FROM = "0x1111111111111111111111111111111111111111" as Address;
const RECOVERY_HASH = `0x${"e".repeat(64)}` as Hex;
const STALE_AFTER_MS = 120_000;
const NOW_MS = 1_000_000;

let root: string;
let state: VenueStateDatabase;
let ledger: SubmissionLedger;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venue-stuck-nonce-"));
  state = openVenueState(join(root, "venue.db"));
  ledger = createSubmissionLedger(state);
});
afterEach(() => { state.close(); rmSync(root, { recursive: true, force: true }); });

function chainWith(input: { readonly pending: number; readonly latest: number }): {
  publicClient: PublicClient;
  walletClient: WalletClient;
  sendTransaction: ReturnType<typeof vi.fn>;
} {
  const sendTransaction = vi.fn(async () => RECOVERY_HASH);
  const publicClient = {
    async getTransactionCount({ blockTag }: { readonly blockTag: "pending" | "latest" }) {
      return blockTag === "pending" ? input.pending : input.latest;
    },
    async estimateFeesPerGas() {
      return { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n };
    },
    async waitForTransactionReceipt() {
      return { status: "success", blockNumber: 1n, blockHash: `0x${"1".repeat(64)}` as Hex, logs: [] };
    },
  } as unknown as PublicClient;
  const walletClient = {
    account: { address: FROM },
    chain: undefined,
    sendTransaction,
  } as unknown as WalletClient;
  return { publicClient, walletClient, sendTransaction };
}

describe("stuck-nonce eviction (design §7 ruling 1 -- relayer profile's fourth obligation)", () => {
  test("no gap between pending and latest returns undefined without a self-send", async () => {
    const { publicClient, walletClient, sendTransaction } = chainWith({ pending: 3, latest: 3 });
    const result = await evictStuckNonce({
      chainId: 84532, from: FROM, publicClient, walletClient, ledger,
      staleAfterMs: STALE_AFTER_MS, nowMs: NOW_MS,
    });
    expect(result).toBeUndefined();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  test("a gap whose ledger row is younger than the stale window returns undefined without a self-send", async () => {
    ledger.record({
      chainId: 84532, from: FROM, nonce: 0, txHash: `0x${"a".repeat(64)}` as Hex,
      logicalTx: "claim", to: FROM, value: 0n, data: "0x" as Hex,
      fees: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n },
      submittedAtMs: NOW_MS - STALE_AFTER_MS + 1,
    });
    const { publicClient, walletClient, sendTransaction } = chainWith({ pending: 2, latest: 0 });
    const result = await evictStuckNonce({
      chainId: 84532, from: FROM, publicClient, walletClient, ledger,
      staleAfterMs: STALE_AFTER_MS, nowMs: NOW_MS,
    });
    expect(result).toBeUndefined();
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(ledger.get({ chainId: 84532, from: FROM, nonce: 0 })?.resolvedAtMs).toBeUndefined();
  });

  test("a stale gap is evicted by one zero-value self-send at that exact nonce, recorded and resolved", async () => {
    ledger.record({
      chainId: 84532, from: FROM, nonce: 0, txHash: `0x${"a".repeat(64)}` as Hex,
      logicalTx: "claim", to: FROM, value: 0n, data: "0x" as Hex,
      fees: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n },
      submittedAtMs: NOW_MS - STALE_AFTER_MS - 1,
    });
    const { publicClient, walletClient, sendTransaction } = chainWith({ pending: 1, latest: 0 });
    const result = await evictStuckNonce({
      chainId: 84532, from: FROM, publicClient, walletClient, ledger,
      staleAfterMs: STALE_AFTER_MS, nowMs: NOW_MS,
    });
    expect(result).toEqual({ nonce: 0, recoveryTxHash: RECOVERY_HASH });
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: FROM, value: 0n, nonce: 0 }),
    );
    const row = ledger.get({ chainId: 84532, from: FROM, nonce: 0 });
    expect(row?.txHash).toBe(RECOVERY_HASH);
    expect(row?.logicalTx).toBe("stuck-nonce-recovery");
    expect(row?.resolvedAtMs).toBe(NOW_MS);
  });

  test("the recovery fee is at least +15% over the stuck row's fee", async () => {
    ledger.record({
      chainId: 84532, from: FROM, nonce: 0, txHash: `0x${"a".repeat(64)}` as Hex,
      logicalTx: "claim", to: FROM, value: 0n, data: "0x" as Hex,
      fees: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n },
      submittedAtMs: NOW_MS - STALE_AFTER_MS - 1,
    });
    const { publicClient, walletClient, sendTransaction } = chainWith({ pending: 1, latest: 0 });
    await evictStuckNonce({
      chainId: 84532, from: FROM, publicClient, walletClient, ledger,
      staleAfterMs: STALE_AFTER_MS, nowMs: NOW_MS,
    });
    const call = sendTransaction.mock.calls[0]![0] as { maxFeePerGas: bigint };
    expect(call.maxFeePerGas * 10_000n).toBeGreaterThanOrEqual(1_000n * 11_500n);
  });

  test("only the lowest stale nonce is evicted per call", async () => {
    ledger.record({
      chainId: 84532, from: FROM, nonce: 0, txHash: `0x${"a".repeat(64)}` as Hex,
      logicalTx: "claim", to: FROM, value: 0n, data: "0x" as Hex,
      fees: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n },
      submittedAtMs: NOW_MS - STALE_AFTER_MS - 1,
    });
    ledger.record({
      chainId: 84532, from: FROM, nonce: 1, txHash: `0x${"b".repeat(64)}` as Hex,
      logicalTx: "settle", to: FROM, value: 0n, data: "0x" as Hex,
      fees: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n },
      submittedAtMs: NOW_MS - STALE_AFTER_MS - 1,
    });
    const { publicClient, walletClient, sendTransaction } = chainWith({ pending: 2, latest: 0 });
    const result = await evictStuckNonce({
      chainId: 84532, from: FROM, publicClient, walletClient, ledger,
      staleAfterMs: STALE_AFTER_MS, nowMs: NOW_MS,
    });
    expect(result?.nonce).toBe(0);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    const untouched = ledger.get({ chainId: 84532, from: FROM, nonce: 1 });
    expect(untouched?.txHash).toBe(`0x${"b".repeat(64)}`);
    expect(untouched?.logicalTx).toBe("settle");
    expect(untouched?.resolvedAtMs).toBeUndefined();
  });
});
