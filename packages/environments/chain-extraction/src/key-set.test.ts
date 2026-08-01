// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  differenceKeySets,
  emptyKeySet,
  keySetDigest,
  keySetIsEmpty,
  keySetSize,
  keySetWithAccount,
  keySetWithCode,
  keySetWithSlot,
  unionKeySets,
} from "./key-set.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SLOT_1 = `0x${"0".repeat(63)}1`;
const SLOT_2 = `0x${"0".repeat(63)}2`;

describe("StateKeySet", () => {
  it("is order-free: insertion order never changes the digest", () => {
    const left = keySetWithSlot(keySetWithSlot(keySetWithAccount(emptyKeySet(), B), A, SLOT_2), A, SLOT_1);
    const right = keySetWithAccount(keySetWithSlot(keySetWithSlot(emptyKeySet(), A, SLOT_1), A, SLOT_2), B);
    expect(keySetDigest(left)).toBe(keySetDigest(right));
    expect(left.accounts).toEqual([B]);
    expect(left.storage[0]?.slots).toEqual([SLOT_1, SLOT_2]);
  });

  it("normalizes on the way in, so 0x1 and its padded form are one slot", () => {
    const set = keySetWithSlot(keySetWithSlot(emptyKeySet(), A, "0x1"), A, SLOT_1);
    expect(set.storage).toEqual([{ address: A, slots: [SLOT_1] }]);
    // One key: a slot read is a slot key. Recording a slot does NOT imply the account
    // fields were read -- the two are separate reads and separate artifact entries.
    expect(keySetSize(set)).toBe(1);
  });

  it("unions and differences by key, not by object identity", () => {
    const touched = keySetWithCode(keySetWithSlot(keySetWithAccount(emptyKeySet(), A), A, SLOT_1), A);
    const committed = keySetWithAccount(emptyKeySet(), A);
    const missing = differenceKeySets(touched, committed);
    expect(missing.accounts).toEqual([]);
    expect(missing.code).toEqual([A]);
    expect(missing.storage).toEqual([{ address: A, slots: [SLOT_1] }]);
    expect(keySetIsEmpty(differenceKeySets(touched, unionKeySets(committed, missing)))).toBe(true);
  });
});
