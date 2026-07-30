// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { VENUE_STATE_SCHEMA_VERSION, openVenueState } from "./database.js";

let root: string;
let path: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venue-state-"));
  path = join(root, "venue.db");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("venue state database", () => {
  test("creates the file, enables WAL and records the schema version", () => {
    const state = openVenueState(path);
    try {
      expect(state.db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(state.db.pragma("foreign_keys", { simple: true })).toBe(1);
      const row = state.db.prepare("SELECT schema_version FROM venue_state_metadata WHERE singleton = 1").get() as
        { schema_version: number } | undefined;
      expect(row?.schema_version).toBe(VENUE_STATE_SCHEMA_VERSION);
    } finally { state.close(); }
  });

  test("is idempotent: reopening an existing file leaves the schema and data intact", () => {
    const first = openVenueState(path);
    first.db.prepare(
      "INSERT INTO tx_submissions (chain_id, from_address, nonce, submitted_at_ms) VALUES (?, ?, ?, ?)",
    ).run(84532, "0x1111111111111111111111111111111111111111", 3, 1);
    first.close();
    const second = openVenueState(path);
    try {
      const count = second.db.prepare("SELECT COUNT(*) AS n FROM tx_submissions").get() as { n: number };
      expect(count.n).toBe(1);
    } finally { second.close(); }
  });

  test("declares all five tables plus metadata", () => {
    const state = openVenueState(path);
    try {
      const names = (state.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as
        { name: string }[]).map((row) => row.name).filter((name) => !name.startsWith("sqlite_")).sort();
      expect(names).toEqual([
        "broadcast_locks", "log_cursors", "orphaned_blocks",
        "posting_intents", "tx_submissions", "venue_state_metadata",
      ]);
    } finally { state.close(); }
  });

  test("rejects a state file written by a newer schema version", () => {
    const raw = new Database(path);
    raw.exec(
      "CREATE TABLE venue_state_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1),"
      + " schema_version INTEGER NOT NULL, created_at_ms INTEGER NOT NULL);"
      + " INSERT INTO venue_state_metadata VALUES (1, 99, 0);",
    );
    raw.close();
    expect(() => openVenueState(path)).toThrow(/schema version 99/u);
  });

  test("the log_cursors CHECK refuses a finalized mark ahead of the live cursor", () => {
    const state = openVenueState(path);
    try {
      expect(() => state.db.prepare(
        "INSERT INTO log_cursors (stream, chain_id, live_block_number, live_block_hash,"
        + " finalized_block_number, finalized_block_hash, updated_at_ms) VALUES (?,?,?,?,?,?,?)",
      ).run("venue", 84532, 10, `0x${"a".repeat(64)}`, 20, `0x${"b".repeat(64)}`, 1)).toThrow(/CHECK/u);
    } finally { state.close(); }
  });

  test("the posting_intents CHECK refuses a half-resolved outbox row", () => {
    const state = openVenueState(path);
    try {
      expect(() => state.db.prepare(
        "INSERT INTO posting_intents (creator_safe, task_cid_digest, submission_digest,"
        + " idempotency_key, owner_token, created_at, resolved_task_id, resolved_tx_hash)"
        + " VALUES (?,?,?,?,?,?,?,?)",
      ).run("0x11", "sha256:aa", "sha256:bb", "k", "t", "2026-07-30T00:00:00Z", "7", null))
        .toThrow(/CHECK/u);
    } finally { state.close(); }
  });

  test("transaction() rolls the whole unit back on throw", () => {
    const state = openVenueState(path);
    try {
      expect(() => state.transaction(() => {
        state.db.prepare(
          "INSERT INTO tx_submissions (chain_id, from_address, nonce, submitted_at_ms) VALUES (?,?,?,?)",
        ).run(84532, "0x11", 1, 1);
        throw new Error("boom");
      })).toThrow("boom");
      const count = state.db.prepare("SELECT COUNT(*) AS n FROM tx_submissions").get() as { n: number };
      expect(count.n).toBe(0);
    } finally { state.close(); }
  });
});
