// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Hex } from "viem";
import { openVenueState, type VenueStateDatabase } from "../state/database.js";
import { createCursorStore } from "./cursor-store.js";

let root: string;
let path: string;
let state: VenueStateDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venue-cursor-store-"));
  path = join(root, "venue.db");
  state = openVenueState(path);
});
afterEach(() => { state.close(); rmSync(root, { recursive: true, force: true }); });

const LIVE_HASH = `0x${"1".repeat(64)}` as Hex;
const FINALIZED_HASH = `0x${"2".repeat(64)}` as Hex;

describe("cursor store (design §7 ruling 2)", () => {
  test("read on an unknown stream is undefined", () => {
    const store = createCursorStore(state);
    expect(store.read("venue:84532:0xabc")).toBeUndefined();
  });

  test("write then read round-trips both marks with exact bigint block numbers and hashes", () => {
    const store = createCursorStore(state);
    const live = { blockNumber: 40n, blockHash: LIVE_HASH };
    const finalized = { blockNumber: 12n, blockHash: FINALIZED_HASH };
    store.write("stream-a", 84532, live, finalized);
    const read = store.read("stream-a");
    expect(read).toBeDefined();
    expect(read!.live.blockNumber).toBe(40n);
    expect(read!.live.blockHash).toBe(LIVE_HASH);
    expect(read!.finalized.blockNumber).toBe(12n);
    expect(read!.finalized.blockHash).toBe(FINALIZED_HASH);
  });

  test("a second write on the same stream replaces, never duplicates, the row", () => {
    const store = createCursorStore(state);
    store.write("stream-a", 84532, { blockNumber: 10n, blockHash: LIVE_HASH }, { blockNumber: 1n, blockHash: FINALIZED_HASH });
    store.write("stream-a", 84532, { blockNumber: 20n, blockHash: FINALIZED_HASH }, { blockNumber: 5n, blockHash: LIVE_HASH });
    const count = state.db.prepare("SELECT COUNT(*) AS n FROM log_cursors WHERE stream = ?").get("stream-a") as { n: number };
    expect(count.n).toBe(1);
    const read = store.read("stream-a");
    expect(read!.live.blockNumber).toBe(20n);
    expect(read!.finalized.blockNumber).toBe(5n);
  });

  test("recordOrphaned is idempotent by (chainId, blockHash); orphanedHashes returns every recorded hash lowercased", () => {
    const store = createCursorStore(state);
    const mixedCaseHash = `0x${"A".repeat(64)}` as Hex;
    store.recordOrphaned(84532, [{ blockNumber: 20n, blockHash: mixedCaseHash }]);
    store.recordOrphaned(84532, [{ blockNumber: 20n, blockHash: mixedCaseHash }]);
    const count = state.db.prepare("SELECT COUNT(*) AS n FROM orphaned_blocks WHERE chain_id = ?").get(84532) as { n: number };
    expect(count.n).toBe(1);
    const hashes = store.orphanedHashes(84532);
    expect(hashes.has(mixedCaseHash.toLowerCase())).toBe(true);
    expect([...hashes]).toEqual([...hashes].map((h) => h.toLowerCase()));
  });

  test("a closed-then-reopened database still returns the cursor", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "venue-cursor-store-reopen-"));
    const otherPath = join(otherRoot, "venue.db");
    try {
      const first = openVenueState(otherPath);
      createCursorStore(first).write(
        "stream-a",
        84532,
        { blockNumber: 40n, blockHash: LIVE_HASH },
        { blockNumber: 12n, blockHash: FINALIZED_HASH },
      );
      first.close();

      const second = openVenueState(otherPath);
      try {
        const read = createCursorStore(second).read("stream-a");
        expect(read!.live.blockNumber).toBe(40n);
        expect(read!.finalized.blockNumber).toBe(12n);
      } finally {
        second.close();
      }
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
