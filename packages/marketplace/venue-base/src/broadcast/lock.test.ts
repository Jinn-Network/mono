// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

  // D0a round-1 review (important finding): the lease is acquired once and
  // never renewed, so mutual exclusion silently lapses for any critical
  // section that runs longer than `leaseMs` -- exactly the shape
  // `executeSafeTxBatch` now holds this lock across (retries + backoff can
  // plausibly exceed 60s). A live holder must keep its lease alive for as
  // long as its critical section is actually open.
  //
  // FAKE TIMERS, deliberately (#2440/#2457). The property under test is a race between two real
  // schedules -- the holder's renewal `setInterval` at `leaseMs / 2` and the challenger's 25ms
  // `acquireLease` retry -- decided by the SQL guard `expires_at_ms <= now`. On real timers with a
  // 30ms lease, ONE event-loop stall longer than the lease window (a CI runner executing ~70
  // matrix jobs does this routinely) lets the row go stale between renewals: B's next retry
  // legitimately wins, and A's next renewal matches zero rows. That reddened the whole marketplace
  // verification lane on PRs touching nothing near this code. Reproduced deterministically by
  // starving the timer past the window -- it is jitter, not a defect in the lock.
  //
  // A controlled clock removes the jitter WITHOUT weakening the assertion: every renewal tick and
  // every retry still executes, against the same guard, in the same order. Deleting the renewal
  // still fails this test -- the lease expires at t=30 and B's retry at t=50 steals the row.
  test("a slow critical section renews its lease so a second process cannot steal it mid-flight", async () => {
    vi.useFakeTimers();
    const otherState = openVenueState(dbPath);
    try {
      const lockA = createBroadcastLock(state, { holderId: "holder-a", leaseMs: 30 });
      const lockB = createBroadcastLock(otherState, { holderId: "holder-b", leaseMs: 30 });

      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

      const first = lockA.withSender(84532, SENDER, async () => {
        order.push("a-start");
        await firstGate;
        order.push("a-end");
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(order).toEqual(["a-start"]);

      // Without renewal, this 30ms lease is trivially stealable well before
      // `first` releases -- a slow critical section (P2's multi-attempt
      // `executeSafeTxBatch`) must keep it alive underneath itself.
      const second = lockB.withSender(84532, SENDER, async () => {
        order.push("b-start");
      });

      // Five full lease windows. A renews at 15/30/45/... and B retries at 25/50/75/...; each
      // retry finds an expiry the preceding renewal already pushed past it.
      await vi.advanceTimersByTimeAsync(150);
      expect(order).toEqual(["a-start"]);

      releaseFirst();
      // B is parked in a faked `sleep(25)`; its next retry only runs once the clock moves.
      await vi.advanceTimersByTimeAsync(50);
      await Promise.all([first, second]);
      expect(order).toEqual(["a-start", "a-end", "b-start"]);
    } finally {
      otherState.close();
      vi.useRealTimers();
    }
  });

  // D0a round-2 minor: renewal was silently best-effort -- `renew.run(...)` matching zero rows
  // (exactly what happens once another process has legitimately stolen the row after this
  // holder's lease genuinely expired) was indistinguishable from success at the call site, so the
  // holder kept executing its critical section as if it still had exclusion. This proves the
  // fencing check: once another holder steals the row, this holder's NEXT renewal tick surfaces
  // the loss by rejecting its `withSender` call rather than letting it run to a false "success".
  test("a stolen lease is detected on the next renewal tick and the critical section is signaled to abort", async () => {
    const otherState = openVenueState(dbPath);
    try {
      // A's frozen `now` never advances, so its own lease's expiry is a fixed point in the past
      // relative to B's frozen `now` -- B's very first acquire attempt steals the row deterministically,
      // with no dependence on real wall-clock elapsed time.
      const lockA = createBroadcastLock(state, { holderId: "holder-a", leaseMs: 20, now: () => 0 });
      const lockB = createBroadcastLock(otherState, {
        holderId: "holder-b",
        leaseMs: 20,
        now: () => 1_000_000,
      });

      let aBodyEntered = false;
      const first = lockA.withSender(84532, SENDER, async () => {
        aBodyEntered = true;
        // Never resolves on its own -- only the lease-loss signal can end this call.
        await new Promise(() => {});
      });
      // Observed via the assertion below; this just prevents an unhandled-rejection warning if
      // the interpreter notices the rejection before the `expect(...).rejects` attaches.
      first.catch(() => undefined);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(aBodyEntered).toBe(true);

      await lockB.withSender(84532, SENDER, async () => {
        // No-op: entering this body at all proves the steal succeeded.
      });

      await expect(first).rejects.toThrow(/lease .* was lost to another holder/i);
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

describe("lease renewal outliving its database", () => {
  // Found blocking an unrelated PR: the renewal timer fires from an unref'd `setInterval`, so a
  // renewal that lands after the connection closes throws where no caller can catch it. Vitest
  // reports it as an uncaught exception and fails the whole file -- for a lock whose owner had
  // already finished. Same shape as every other "a writer outlived its resource" defect.
  test("a renewal that lands after the database closes does not throw from the timer", async () => {
    const owned = openVenueState(join(root, "renewal.db"));
    // Renew every 1ms (leaseMs/2, floored at 1) so a tick is guaranteed inside the wait below.
    const lock = createBroadcastLock(owned, { holderId: "renewal-holder", leaseMs: 2 });

    let closeWhileHeld!: () => void;
    const closed = new Promise<void>((resolve) => { closeWhileHeld = resolve; });
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => { uncaught.push(error); };
    process.on("uncaughtException", onUncaught);

    try {
      await lock.withSender(84532, SENDER, async () => {
        // Close the database out from under the still-armed renewal timer, then leave time for
        // several renewal ticks to fire against the dead connection.
        owned.close();
        closeWhileHeld();
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      });
    } catch {
      // `withSender`'s own release path also touches the closed database; that rejection is the
      // caller's to see and is not what this test pins.
    }

    await closed;
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    process.off("uncaughtException", onUncaught);

    expect(uncaught).toEqual([]);
  });
});
