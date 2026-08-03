// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Address, Hex } from "viem";
import { openVenueState, type VenueStateDatabase } from "../state/database.js";
import { createSubmissionLedger } from "./ledger.js";
import { createBroadcastLock } from "./lock.js";
import { createSafeBroadcaster } from "./safe-broadcaster.js";
import { buildScriptedChain } from "./scripted-chain.fixture.js";

const SAFE = "0x5afe000000000000000000000000000000000000" as Address;
const TO = "0x2222222222222222222222222222222222222222" as Address;
const DATA = "0xdeadbeef" as Hex;

let root: string;
let state: VenueStateDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venue-broadcast-"));
  state = openVenueState(join(root, "venue.db"));
});
afterEach(() => { state.close(); rmSync(root, { recursive: true, force: true }); });

function broadcaster(chain: ReturnType<typeof buildScriptedChain>, maxCostWei?: bigint) {
  return createSafeBroadcaster({
    chainId: 84532,
    safeAddress: SAFE,
    publicClient: chain.publicClient,
    walletClient: chain.walletClient,
    ledger: createSubmissionLedger(state),
    lock: createBroadcastLock(state, { now: chain.now, sleep: chain.sleep }),
    options: {
      now: chain.now,
      sleep: chain.sleep,
      ...(maxCostWei === undefined ? {} : { maxCostWei: () => maxCostWei }),
    },
  });
}

describe("Safe broadcaster (design §6.1 Safe broadcast, §7 ruling 1)", () => {
  test("signs with the eth_sign v-adjustment and records the ledger row before waiting", async () => {
    const chain = buildScriptedChain();
    const receipt = await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
    expect(receipt.txHash).toBe(chain.minedTxHashes()[0]);
    const signature = chain.lastSignature();
    expect(signature).toBeDefined();
    // Safe contracts spec: checkNSignatures treats v > 30 as an eth_sign-prefixed signature.
    expect(Number.parseInt(signature!.slice(-2), 16)).toBeGreaterThan(30);
    const row = createSubmissionLedger(state).get({ chainId: 84532, from: chain.from, nonce: 0 });
    expect(row?.txHash).toBe(receipt.txHash);
    expect(row?.logicalTx).toBe("claim");
    expect(row?.to).toBe(SAFE.toLowerCase());
    expect(row?.resolvedAtMs).toBeGreaterThan(0);
  });

  test("passes value through to execTransaction so escrow-carrying calls fund correctly", async () => {
    const chain = buildScriptedChain();
    await broadcaster(chain).execute({ to: TO, value: 7n, data: DATA, logicalTx: "post" });
    expect(chain.lastWrite()?.value).toBe(7n);
    expect(chain.lastWrite()?.args?.[1]).toBe(7n);
  });

  test("estimates the exact signed Safe call and refuses a broadcast above its operation cap", async () => {
    const chain = buildScriptedChain();
    await expect(
      broadcaster(chain, 20_999_999_999_999n).execute({
        to: TO,
        value: 0n,
        data: DATA,
        logicalTx: "claim",
      }),
    ).rejects.toThrow(/exact gas maximum 21000000000000 exceeds configured cap 20999999999999/u);
    expect(chain.writeCount()).toBe(0);

    await expect(
      broadcaster(chain, 21_000_000_000_000n).execute({
        to: TO,
        value: 0n,
        data: DATA,
        logicalTx: "claim",
      }),
    ).resolves.toMatchObject({ alreadySettled: false });
    expect(chain.writeCount()).toBe(1);
  });

  test("defaults execTransaction to operation 0 (Call) and forwards operation 1 for a delegatecall batch", async () => {
    const plain = buildScriptedChain();
    await broadcaster(plain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
    // execTransaction(to, value, data, operation, ...) — operation is the fourth argument.
    expect(plain.lastWrite()?.args?.[3]).toBe(0);

    const batched = buildScriptedChain();
    await broadcaster(batched).execute({
      to: TO, value: 0n, data: DATA, logicalTx: "settle", operation: 1,
    });
    // A MultiSend batch must delegatecall so each inner leg keeps `msg.sender == Safe`.
    expect(batched.lastWrite()?.args?.[3]).toBe(1);
  });

  test("serializes two concurrent executes: nonce N then N+1, never N twice", async () => {
    const chain = buildScriptedChain();
    const subject = broadcaster(chain);
    await Promise.all([
      subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" }),
      subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" }),
    ]);
    expect(chain.submittedNonces()).toEqual([0, 1]);
  });

  test("nonce too low refreshes the pinned nonce and re-signs at the fresh value", async () => {
    const chain = buildScriptedChain();
    chain.failNextWriteWith(new Error("nonce too low"));
    chain.setPendingNonce(4);
    await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
    expect(chain.submittedNonces().at(-1)).toBe(4);
  });

  test("nonce too low reconciles against this call's own mined ledger tx instead of re-signing", async () => {
    const chain = buildScriptedChain();
    const ledger = createSubmissionLedger(state);
    const priorHash = `0x${"c".repeat(64)}` as Hex;
    chain.seedMinedTx(priorHash, 0);
    ledger.record({
      chainId: 84532, from: chain.from, nonce: 0, txHash: priorHash,
      logicalTx: "settle", to: SAFE.toLowerCase() as Address, value: 0n, data: DATA,
      fees: { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, submittedAtMs: 1,
    });
    chain.failNextWriteWith(new Error("nonce too low"));
    const receipt = await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" });
    expect(receipt.txHash).toBe(priorHash);
    expect(chain.writeCount()).toBe(1); // the failed attempt only; no re-sign
  });

  test("a ledger row for a DIFFERENT logical tx at the same nonce is never adopted", async () => {
    const chain = buildScriptedChain();
    const ledger = createSubmissionLedger(state);
    const foreignHash = `0x${"d".repeat(64)}` as Hex;
    chain.seedMinedTx(foreignHash, 0);
    ledger.record({
      chainId: 84532, from: chain.from, nonce: 0, txHash: foreignHash,
      logicalTx: "identity.setMetadata", to: SAFE.toLowerCase() as Address, value: 0n,
      data: "0xfeedface" as Hex, fees: {}, submittedAtMs: 1,
    });
    chain.failNextWriteWith(new Error("nonce too low"));
    chain.setPendingNonce(1);
    const receipt = await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" });
    expect(receipt.txHash).not.toBe(foreignHash);
  });

  test("replacement underpriced re-submits at the same nonce with at least a 15% bump", async () => {
    const chain = buildScriptedChain();
    chain.failNextWriteWith(new Error("replacement transaction underpriced"));
    await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
    const fees = chain.submittedFees();
    expect(fees).toHaveLength(2);
    expect(fees[1]!.maxFeePerGas! * 10_000n).toBeGreaterThanOrEqual(fees[0]!.maxFeePerGas! * 11_500n);
  });

  test("a decoded permanent inner revert throws SafeInnerRevertError without retrying", async () => {
    const chain = buildScriptedChain();
    chain.setInnerRevert("0x90386e7c");
    chain.failEveryWriteWith(new Error("execution reverted: GS013"));
    await expect(
      broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" }),
    ).rejects.toThrow(/TCMaxClaimsReached/u);
    expect(chain.writeCount()).toBe(1);
  });

  test("an already-settled inner revert resolves as alreadySettled instead of throwing", async () => {
    const chain = buildScriptedChain();
    chain.setInnerRevert("0x22d686d9"); // RouterAlreadyClaimed
    chain.failEveryWriteWith(new Error("execution reverted: GS013"));
    const receipt = await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" });
    expect(receipt.alreadySettled).toBe(true);
  });

  test("GS026 with a non-owner signer is terminal and names the repair", async () => {
    const chain = buildScriptedChain({ signerIsOwner: false });
    chain.failEveryWriteWith(new Error("execution reverted: GS026"));
    await expect(
      broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" }),
    ).rejects.toThrow(/signing key is not a Safe owner/u);
  });

  test("a mined-but-reverted receipt with no inner revert re-reads the nonce and re-signs", async () => {
    const chain = buildScriptedChain();
    chain.revertNextReceipt();
    const receipt = await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
    expect(chain.writeCount()).toBe(2);
    expect(receipt.txHash).toBe(chain.minedTxHashes().at(-1));
  });

  test("broadcastCreateTask decodes TaskCreated from the receipt and returns the PostingOutcome", async () => {
    const chain = buildScriptedChain();
    chain.emitTaskCreated(42n);
    const outcome = await broadcaster(chain).broadcastCreateTask({
      safeAddress: SAFE, to: TO, value: 4n, data: DATA,
    });
    expect(outcome.taskId).toBe(42n);
    expect(outcome.txHash).toBe(chain.minedTxHashes().at(-1));
  });
});
