// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { stateArtifactKeySet } from "./artifact.js";
import { createBudgetedArchivePort } from "./budget.js";
import {
  emptyKeySet,
  keySetWithAccount,
  keySetWithCode,
  keySetWithSlot,
} from "./key-set.js";
import { harvestTouchedState } from "./harvest.js";
import type { AnchorCapture } from "./anchor.js";
import {
  buildFakeTrieWorld,
  FAKE_POOL,
  FAKE_SLOT_1,
  FAKE_SLOT_2,
  FAKE_TOKEN,
} from "./testing.js";
import { normalizeHex32 } from "./hex.js";
import type { ChainStateDump } from "./ports.js";

function fakeAnchor(stateRoot: string): AnchorCapture {
  return {
    blockNumber: 1,
    blockHash: normalizeHex32(`0x${"1".repeat(64)}`),
    stateRoot: normalizeHex32(stateRoot),
    timestamp: 1,
    finality: {
      observedAt: "2026-07-31T09:00:00.000Z",
      finalizedBlockNumber: 1,
      depthBelowFinalized: 0,
      finalizedAtObservation: true,
    },
    headerProof: undefined,
  };
}

function poolJournal() {
  let journal = emptyKeySet();
  journal = keySetWithAccount(journal, FAKE_POOL);
  journal = keySetWithCode(journal, FAKE_POOL);
  journal = keySetWithSlot(journal, FAKE_POOL, FAKE_SLOT_1);
  journal = keySetWithSlot(journal, FAKE_POOL, FAKE_SLOT_2);
  return journal;
}

describe("harvestTouchedState", () => {
  it("builds the artifact from the journal alone and carries exactly the journaled keys", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 1_000_000 });
    const journal = poolJournal();

    const outcome = await harvestTouchedState(archive, {
      journal,
      anchor: fakeAnchor(world.stateRoot),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(stateArtifactKeySet(outcome.value.artifact)).toEqual(journal);
    expect(outcome.value.entryCounts).toEqual({
      accounts: 1,
      codeEntries: 1,
      storageSlots: 2,
    });
    expect(outcome.value.dumpOmissions).toEqual(emptyKeySet());
    expect(outcome.value.dumpOnlyEntries).toEqual(emptyKeySet());
  });

  it("reports dump omissions without changing the artifact when the dump lies", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 1_000_000 });
    const journal = poolJournal();
    const withoutDump = await harvestTouchedState(archive, {
      journal,
      anchor: fakeAnchor(world.stateRoot),
    });
    expect(withoutDump.ok).toBe(true);
    if (!withoutDump.ok) return;

    const dump: ChainStateDump = {
      accounts: {
        [FAKE_POOL]: {
          balance: "0x0",
          nonce: "0x1",
          code: "0x60016002",
          storage: { [FAKE_SLOT_1]: `0x${"0".repeat(63)}7` },
        },
      },
    };

    const outcome = await harvestTouchedState(archive, {
      journal,
      anchor: fakeAnchor(world.stateRoot),
      dump: { dump: async () => dump },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.artifact).toEqual(withoutDump.value.artifact);
    expect(outcome.value.dumpOmissions.storage).toEqual([
      { address: FAKE_POOL, slots: [FAKE_SLOT_2] },
    ]);
    expect(outcome.value.dumpOnlyEntries).toEqual(emptyKeySet());
  });

  it("reports dump-only accounts without admitting them to the artifact", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 1_000_000 });
    const journal = poolJournal();

    const dump: ChainStateDump = {
      accounts: {
        [FAKE_POOL]: {
          balance: "0x0",
          nonce: "0x1",
          code: "0x60016002",
          storage: {
            [FAKE_SLOT_1]: `0x${"0".repeat(63)}7`,
            [FAKE_SLOT_2]: `0x${"0".repeat(63)}3`,
          },
        },
        [FAKE_TOKEN]: {
          balance: "0x0",
          nonce: "0x1",
          code: "0x6042",
          storage: { [FAKE_SLOT_1]: `0x${"0".repeat(63)}5` },
        },
      },
    };

    const outcome = await harvestTouchedState(archive, {
      journal,
      anchor: fakeAnchor(world.stateRoot),
      dump: { dump: async () => dump },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.artifact.accounts.map((account) => account.address)).toEqual([FAKE_POOL]);
    expect(outcome.value.dumpOnlyEntries.accounts).toEqual([FAKE_TOKEN]);
    expect(outcome.value.dumpOnlyEntries.code).toEqual([FAKE_TOKEN]);
    expect(outcome.value.dumpOnlyEntries.storage).toEqual([
      { address: FAKE_TOKEN, slots: [FAKE_SLOT_1] },
    ]);
    expect(outcome.value.dumpOmissions).toEqual(emptyKeySet());
  });

  it("refuses an empty journal as harvest-empty", async () => {
    const world = buildFakeTrieWorld();
    const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 1_000_000 });

    const outcome = await harvestTouchedState(archive, {
      journal: emptyKeySet(),
      anchor: fakeAnchor(world.stateRoot),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("harvest-empty");
  });
});
