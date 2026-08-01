// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createBudgetedArchivePort } from "./budget.js";
import { createLayeredStateBackend } from "./layered-backend.js";
import { normalizeAddress, normalizeSlot } from "./hex.js";
import { keySetIsEmpty } from "./key-set.js";
import {
  buildFakeTrieWorld,
  fakeStateArtifact,
  FAKE_ACTOR,
  FAKE_POOL,
  FAKE_SLOT_1,
  FAKE_SLOT_2,
} from "./testing.js";

describe("createLayeredStateBackend", () => {
  it("serves a committed account and slot without archive calls", async () => {
    const world = buildFakeTrieWorld();
    const inner = world.archive();
    const getAccount = vi.spyOn(inner, "getAccount");
    const getCode = vi.spyOn(inner, "getCode");
    const getStorageAt = vi.spyOn(inner, "getStorageAt");
    const archive = createBudgetedArchivePort(inner, { maxCalls: 100, maxBytes: 1_000_000 });
    const artifact = fakeStateArtifact(world.stateRoot);
    const backend = createLayeredStateBackend(artifact, archive);

    const pool = normalizeAddress(FAKE_POOL);
    await backend.getAccount(pool, 1);
    await backend.getCode(pool, 1);
    await backend.getStorageAt(pool, normalizeSlot(FAKE_SLOT_1), 1);

    expect(getAccount).not.toHaveBeenCalled();
    expect(getCode).not.toHaveBeenCalled();
    expect(getStorageAt).not.toHaveBeenCalled();
    expect(keySetIsEmpty(backend.misses())).toBe(true);
  });

  it("journals an uncommitted account and falls through to the archive", async () => {
    const world = buildFakeTrieWorld();
    const inner = world.archive();
    const getAccount = vi.spyOn(inner, "getAccount");
    const archive = createBudgetedArchivePort(inner, { maxCalls: 100, maxBytes: 1_000_000 });
    const full = fakeStateArtifact(world.stateRoot);
    const actorOnly = {
      ...full,
      accounts: full.accounts.filter((account) => account.address === normalizeAddress(FAKE_ACTOR)),
    };
    const backend = createLayeredStateBackend(actorOnly, archive);

    const pool = normalizeAddress(FAKE_POOL);
    await backend.getAccount(pool, 1);

    expect(getAccount).toHaveBeenCalledOnce();
    expect(backend.misses().accounts).toContain(pool);
  });

  it("treats a missing slot on a committed account as a miss", async () => {
    const world = buildFakeTrieWorld();
    const inner = world.archive();
    const getStorageAt = vi.spyOn(inner, "getStorageAt");
    const archive = createBudgetedArchivePort(inner, { maxCalls: 100, maxBytes: 1_000_000 });
    const artifact = fakeStateArtifact(world.stateRoot);
    const actorOnly = {
      ...artifact,
      accounts: artifact.accounts.filter((account) => account.address === normalizeAddress(FAKE_ACTOR)),
    };
    const backend = createLayeredStateBackend(actorOnly, archive);

    const pool = normalizeAddress(FAKE_POOL);
    const value = await backend.getStorageAt(pool, normalizeSlot(FAKE_SLOT_1), 1);

    expect(getStorageAt).toHaveBeenCalledOnce();
    expect(value).toBe(normalizeSlot(`0x${"0".repeat(63)}7`));
    expect(backend.misses().storage).toEqual([{
      address: pool,
      slots: [normalizeSlot(FAKE_SLOT_1)],
    }]);
  });
});
