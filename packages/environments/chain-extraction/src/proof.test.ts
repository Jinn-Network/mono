// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { verifyAccountProof } from "./proof.js";
import { buildFakeTrieWorld, FAKE_POOL, FAKE_SLOT_1 } from "./testing.js";

describe("EIP-1186 verification", () => {
  it("verifies an account and its storage against the declared root", () => {
    const world = buildFakeTrieWorld();
    const verdict = verifyAccountProof(world.proofFor(FAKE_POOL, [FAKE_SLOT_1]), world.stateRoot);
    expect(verdict.account).toBe(true);
    expect(verdict.storage[FAKE_SLOT_1]).toBe(true);
  });

  it("refuses a proof presented against a different root", () => {
    const world = buildFakeTrieWorld();
    const verdict = verifyAccountProof(world.proofFor(FAKE_POOL, [FAKE_SLOT_1]), `0x${"e".repeat(64)}`);
    expect(verdict.account).toBe(false);
    expect(verdict.storage[FAKE_SLOT_1]).toBe(false);
  });

  it("refuses a tampered storage value while the account still verifies", () => {
    // The forged-slice case from design §16: real protocol code and most storage proven
    // against the true root, one slot quietly changed.
    const world = buildFakeTrieWorld();
    const proof = world.proofFor(FAKE_POOL, [FAKE_SLOT_1]);
    const tampered = {
      ...proof,
      storageProof: proof.storageProof.map((entry) => ({ ...entry, value: "0xdead" })),
    };
    const verdict = verifyAccountProof(tampered, world.stateRoot);
    expect(verdict.account).toBe(true);
    expect(verdict.storage[FAKE_SLOT_1]).toBe(false);
  });

  it("verifies a proven-absent account, because reading empty state is legal", () => {
    const world = buildFakeTrieWorld();
    const verdict = verifyAccountProof(world.absenceProofFor(`0x${"9".repeat(40)}`), world.stateRoot);
    expect(verdict.account).toBe(true);
    expect(verdict.absent).toBe(true);
  });
});
