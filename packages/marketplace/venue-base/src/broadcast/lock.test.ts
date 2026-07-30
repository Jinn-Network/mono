// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Address } from "viem";
import { openVenueState, type VenueStateDatabase } from "../state/database.js";
import { createBroadcastLock } from "./lock.js";

const SENDER = "0x5afe000000000000000000000000000000000A" as Address;
const OTHER_SENDER = "0x5afe000000000000000000000000000000000B" as Address;

let root: string;
let dbPath: string;
let state: VenueStateDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venue-lock-"));
  dbPath = join(root, "venue.db");
  state = openVenueState(dbPath);
});

afterEach(() => {
  state.close();
  rmSync(root, { recursive: true, force: true });
});

describe("broadcast lock (design §6.1 cross-process lock)", () => {
  test("two withSender calls on the same (chainId, sender) in one process serialize", async () => {
    const lock = createBroadcastLock(state);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = lock.withSender(84532, SENDER, async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    });

    // give the first call a tick to actually start
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["first-start"]);

    const second = lock.withSender(84532, SENDER, async () => {
      order.push("second-start");
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    // second must not have started yet -- first hasn't released
    expect(order).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  test("calls on different senders proceed concurrently", async () => {
    const lock = createBroadcastLock(state);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = lock.withSender(84532, SENDER, async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = lock.withSender(84532, OTHER_SENDER, async () => {
      order.push("second-start");
    });

    await second;
    expect(order).toEqual(["first-start", "second-start"]);
    releaseFirst();
    await first;
    expect(order).toEqual(["first-start", "second-start", "first-end"]);
  });

  test("a rejected body still releases the lease", async () => {
    const lock = createBroadcastLock(state);
    await expect(
      lock.withSender(84532, SENDER, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    let ran = false;
    await lock.withSender(84532, SENDER, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("a second VenueStateDatabase handle on the same file blocks while the first holds the lease", async () => {
    const otherState = openVenueState(dbPath);
    try {
      const lockA = createBroadcastLock(state, { holderId: "holder-a", leaseMs: 60_000 });
      const lockB = createBroadcastLock(otherState, { holderId: "holder-b", leaseMs: 60_000 });

      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

      const first = lockA.withSender(84532, SENDER, async () => {
        order.push("a-start");
        await firstGate;
        order.push("a-end");
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = lockB.withSender(84532, SENDER, async () => {
        order.push("b-start");
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(order).toEqual(["a-start"]);

      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(["a-start", "a-end", "b-start"]);
    } finally {
      otherState.close();
    }
  });

  test("an expired lease is stealable so a crashed holder never wedges the sender", async () => {
    let now = 1_000;
    const lock = createBroadcastLock(state, {
      holderId: "crashed-holder",
      leaseMs: 50,
      now: () => now,
    });

    // Simulate a crashed holder: acquire the lease and never release it (body never resolves the
    // gate, but we still let withSender's own promise dangle -- we only care about lock table state).
    const stuck = lock.withSender(84532, SENDER, () => new Promise(() => {}));
    // Let it acquire.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Advance time past the lease window and use a fresh lock instance (simulating a new process).
    now += 1_000;
    const recoveringLock = createBroadcastLock(state, {
      holderId: "recovering-holder",
      leaseMs: 50,
      now: () => now,
    });
    let recovered = false;
    await recoveringLock.withSender(84532, SENDER, async () => {
      recovered = true;
    });
    expect(recovered).toBe(true);
    void stuck; // never resolves; not awaited
  });
});
