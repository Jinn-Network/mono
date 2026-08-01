// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Address, Hex } from "viem";
import { openVenueState, type VenueStateDatabase } from "../state/database.js";
import { createSubmissionLedger } from "./ledger.js";

const FROM = "0xAbC0000000000000000000000000000000000A" as Address;
const TO = "0x2222222222222222222222222222222222222222" as Address;
const DATA = "0xdeadbeef" as Hex;

let root: string;
let dbPath: string;
let state: VenueStateDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venue-ledger-"));
  dbPath = join(root, "venue.db");
  state = openVenueState(dbPath);
});

afterEach(() => {
  state.close();
  rmSync(root, { recursive: true, force: true });
});

describe("submission ledger (design §7 ruling 1 -- persistent submission ledger)", () => {
  test("record then get round-trips every field including bigint fees stored as TEXT", () => {
    const ledger = createSubmissionLedger(state);
    const txHash = `0x${"a".repeat(64)}` as Hex;
    ledger.record({
      chainId: 84532,
      from: FROM,
      nonce: 0,
      txHash,
      logicalTx: "claim",
      to: TO,
      value: 7n,
      data: DATA,
      fees: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n },
      submittedAtMs: 111,
    });

    const row = ledger.get({ chainId: 84532, from: FROM, nonce: 0 });
    expect(row?.txHash).toBe(txHash);
    expect(row?.logicalTx).toBe("claim");
    expect(row?.to).toBe(TO.toLowerCase());
    expect(row?.value).toBe(7n);
    expect(row?.data).toBe(DATA);
    expect(row?.fees.maxFeePerGas).toBe(1_000n);
    expect(row?.fees.maxPriorityFeePerGas).toBe(100n);
    expect(row?.submittedAtMs).toBe(111);
    expect(row?.resolvedAtMs).toBeUndefined();
  });

  test("a second record at the same (chainId, from, nonce) overwrites", () => {
    const ledger = createSubmissionLedger(state);
    const firstHash = `0x${"1".repeat(64)}` as Hex;
    const secondHash = `0x${"2".repeat(64)}` as Hex;
    ledger.record({
      chainId: 84532, from: FROM, nonce: 3, txHash: firstHash, logicalTx: "claim",
      to: TO, value: 0n, data: DATA, fees: { gasPrice: 100n }, submittedAtMs: 1,
    });
    ledger.record({
      chainId: 84532, from: FROM, nonce: 3, txHash: secondHash, logicalTx: "claim",
      to: TO, value: 0n, data: DATA, fees: { gasPrice: 150n }, submittedAtMs: 2,
    });

    const row = ledger.get({ chainId: 84532, from: FROM, nonce: 3 });
    expect(row?.txHash).toBe(secondHash);
    expect(row?.fees.gasPrice).toBe(150n);
  });

  test("markResolved sets resolvedAtMs and get reflects it", () => {
    const ledger = createSubmissionLedger(state);
    ledger.record({
      chainId: 84532, from: FROM, nonce: 1, txHash: `0x${"3".repeat(64)}` as Hex,
      logicalTx: "settle", to: TO, value: 0n, data: DATA, fees: {}, submittedAtMs: 5,
    });
    ledger.markResolved({ chainId: 84532, from: FROM, nonce: 1 }, 42);
    const row = ledger.get({ chainId: 84532, from: FROM, nonce: 1 });
    expect(row?.resolvedAtMs).toBe(42);
  });

  test("unresolvedBetween returns only rows with a NULL resolvedAtMs inside the half-open nonce range, ordered ascending", () => {
    const ledger = createSubmissionLedger(state);
    for (const nonce of [0, 1, 2, 3, 4]) {
      ledger.record({
        chainId: 84532, from: FROM, nonce, txHash: `0x${String(nonce).repeat(64)}` as Hex,
        logicalTx: "claim", to: TO, value: 0n, data: DATA, fees: {}, submittedAtMs: nonce,
      });
    }
    ledger.markResolved({ chainId: 84532, from: FROM, nonce: 1 }, 10);
    ledger.markResolved({ chainId: 84532, from: FROM, nonce: 4 }, 10);

    const unresolved = ledger.unresolvedBetween(84532, FROM, 0, 4);
    expect(unresolved.map((row) => row.nonce)).toEqual([0, 2, 3]);
  });

  test("a closed-then-reopened database still returns the row (durability across process restart)", () => {
    const restartRoot = mkdtempSync(join(tmpdir(), "venue-ledger-restart-"));
    const restartDbPath = join(restartRoot, "venue.db");
    const first = openVenueState(restartDbPath);
    try {
      createSubmissionLedger(first).record({
        chainId: 84532, from: FROM, nonce: 9, txHash: `0x${"9".repeat(64)}` as Hex,
        logicalTx: "claim", to: TO, value: 0n, data: DATA,
        fees: { maxFeePerGas: 5n, maxPriorityFeePerGas: 1n }, submittedAtMs: 1,
      });
    } finally {
      first.close();
    }

    const reopened = openVenueState(restartDbPath);
    try {
      const row = createSubmissionLedger(reopened).get({ chainId: 84532, from: FROM, nonce: 9 });
      expect(row?.txHash).toBe(`0x${"9".repeat(64)}`);
      expect(row?.fees.maxFeePerGas).toBe(5n);
    } finally {
      reopened.close();
      rmSync(restartRoot, { recursive: true, force: true });
    }
  });
});
