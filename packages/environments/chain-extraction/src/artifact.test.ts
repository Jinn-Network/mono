// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  mergeIntoStateArtifact,
  parseStateArtifact,
  serializeStateArtifact,
  stateArtifactDigest,
  stateArtifactKeySet,
  type StateArtifact,
} from "./artifact.js";
import { ChainExtractionError } from "./errors.js";
import { keySetWithAccount, keySetWithSlot } from "./key-set.js";

const ANCHOR = {
  blockNumber: 21_000_000,
  blockHash: `0x${"1".repeat(64)}`,
  stateRoot: `0x${"3".repeat(64)}`,
  timestamp: 1_760_000_000,
};
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SLOT_1 = `0x${"0".repeat(63)}1`;
const SLOT_2 = `0x${"0".repeat(63)}2`;

const MINIMAL: StateArtifact = {
  schemaVersion: "chain-state-artifact.v1",
  anchor: ANCHOR,
  accounts: [
    { address: A, balance: "0xde0b6b3a7640000", nonce: "0x1", code: "0x6001", storage: [{ slot: SLOT_1, value: `0x${"0".repeat(63)}7` }] },
  ],
};

describe("the state artifact", () => {
  it("round-trips through canonical bytes with a stable digest", () => {
    const bytes = serializeStateArtifact(MINIMAL);
    expect(parseStateArtifact(bytes)).toEqual(MINIMAL);
    expect(stateArtifactDigest(bytes)).toBe(stateArtifactDigest(serializeStateArtifact(MINIMAL)));
    expect(stateArtifactDigest(bytes).startsWith("sha256:")).toBe(true);
  });

  it("refuses non-canonical hex rather than silently accepting two spellings of one key", () => {
    const uppercased = JSON.parse(new TextDecoder().decode(serializeStateArtifact(MINIMAL))) as
      { accounts: { address: string }[] };
    uppercased.accounts[0]!.address = A.toUpperCase().replace("0X", "0x");
    expect(() => parseStateArtifact(new TextEncoder().encode(JSON.stringify(uppercased))))
      .toThrow(ChainExtractionError);
  });

  it("reports its own key set, which is what the widen loop subtracts from", () => {
    const keys = stateArtifactKeySet(MINIMAL);
    expect(keys.accounts).toEqual([A]);
    expect(keys.code).toEqual([A]);
    expect(keys.storage).toEqual([{ address: A, slots: [SLOT_1] }]);
  });

  it("merges widening entries in address order and keeps existing values", () => {
    const widened = mergeIntoStateArtifact(MINIMAL, [
      { address: B, balance: "0x0", nonce: "0x0", storage: [{ slot: SLOT_2, value: `0x${"0".repeat(63)}9` }] },
      { address: A, balance: "0xde0b6b3a7640000", nonce: "0x1", code: "0x6001", storage: [{ slot: SLOT_2, value: `0x${"0".repeat(64)}` }] },
    ]);
    expect(widened.accounts.map((account) => account.address)).toEqual([A, B]);
    expect(widened.accounts[0]?.storage.map((entry) => entry.slot)).toEqual([SLOT_1, SLOT_2]);
    // The widened artifact's key set is exactly the old one plus the two added slots
    // plus the new account -- the property the loop's termination test depends on.
    const expected = keySetWithAccount(
      keySetWithSlot(keySetWithSlot(stateArtifactKeySet(MINIMAL), A, SLOT_2), B, SLOT_2),
      B,
    );
    expect(stateArtifactKeySet(widened)).toEqual(expected);
  });

  it("refuses a merge that would change a committed value", () => {
    expect(() => mergeIntoStateArtifact(MINIMAL, [
      { address: A, balance: "0x1", nonce: "0x1", code: "0x6001", storage: [] },
    ])).toThrow(/committed/u);
  });

  it("hands CE3 a prefixed digest and never mints a bare-hex one itself", async () => {
    const { bareHexDigest } = await import("@jinn-network/chain-environment-record");
    const digest = stateArtifactDigest(serializeStateArtifact(MINIMAL));
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(bareHexDigest(digest)).toMatch(/^[0-9a-f]{64}$/u);
    const source = await readFile(new URL("./artifact.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/slice\(7\)|replace\("sha256:"/u);
  });
});

describe("adversarial fixture corpus", () => {
  const fixturesRoot = new URL("../fixtures/adversarial-v1/", import.meta.url);

  it.each([
    ["uppercase-hex.json", "address"],
    ["unsorted-slots.json", "slot"],
  ] as const)("rejects %s and names the offending field", async (filename, field) => {
    const bytes = await readFile(new URL(filename, fixturesRoot));
    expect(() => parseStateArtifact(bytes)).toThrow(ChainExtractionError);
    try {
      parseStateArtifact(bytes);
    } catch (error) {
      expect(error).toBeInstanceOf(ChainExtractionError);
      expect((error as ChainExtractionError).message).toMatch(new RegExp(field, "iu"));
    }
  });
});
