// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PostingIntent, PostingOwnerToken } from "@jinn-network/marketplace-binding";
import { openVenueState, type VenueStateDatabase } from "../state/database.js";
import { createSqlitePostingIntentStore } from "./intent-store.js";

const CREATOR_SAFE = `0x${"a".repeat(40)}` as `0x${string}`;
const TASK_DIGEST = `sha256:${"a".repeat(64)}` as `sha256:${string}`;
const SUBMISSION_DIGEST = `sha256:${"b".repeat(64)}` as `sha256:${string}`;
const TX_HASH = `0x${"c".repeat(64)}` as `0x${string}`;

function baseIntent(overrides: Partial<PostingIntent> = {}): PostingIntent {
  return {
    creatorSafe: CREATOR_SAFE,
    taskCidDigest: TASK_DIGEST,
    submissionDigest: SUBMISSION_DIGEST,
    idempotencyKey: "idem-1",
    createdAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

let root: string;
let dbPath: string;
let state: VenueStateDatabase;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "venue-posting-intents-"));
  dbPath = join(root, "venue.db");
  state = openVenueState(dbPath);
});

afterEach(() => {
  state.close();
  rmSync(root, { recursive: true, force: true });
});

describe("createSqlitePostingIntentStore (design §7 ruling 4 -- transactional outbox)", () => {
  test("claim on an unseen key returns owner and persists atomically; a concurrent claim yields pending-other", async () => {
    const store = createSqlitePostingIntentStore(state);
    const intent = baseIntent();

    const [first, second] = await Promise.all([store.claim(intent), store.claim(intent)]);

    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["owner", "pending-other"]);
  });

  test("the logical tuple rejects a second command digest instead of creating another WAL", async () => {
    const store = createSqlitePostingIntentStore(state);
    const firstDigest = `sha256:${"d".repeat(64)}` as const;
    const first = baseIntent({
      version: 2,
      venueNamespace: "eip155:84532:today:router",
      commandDigest: firstDigest,
      command: { commandDigest: firstDigest } as NonNullable<PostingIntent["command"]>,
    });
    expect((await store.claim(first)).kind).toBe("owner");
    const changedDigest = `sha256:${"e".repeat(64)}` as const;
    const changed = {
      ...first,
      commandDigest: changedDigest,
      command: { commandDigest: changedDigest } as NonNullable<PostingIntent["command"]>,
    };

    await expect(store.claim(changed)).resolves.toMatchObject({ kind: "conflict" });
    expect(await store.scanPending()).toHaveLength(1);
  });

  test("claim on a pending key owned elsewhere returns the STORED intent, not the caller's", async () => {
    const store = createSqlitePostingIntentStore(state);
    const original = baseIntent({ createdAt: "2026-01-01T00:00:00.000Z" });
    await store.claim(original);

    const replay = await store.claim({ ...original, createdAt: "2026-02-02T00:00:00.000Z" });

    expect(replay.kind).toBe("pending-other");
    if (replay.kind !== "pending-other") throw new Error("expected pending-other");
    expect(replay.intent.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("claim on a resolved key returns resolved with the exact taskId (bigint round-tripped through TEXT) and txHash", async () => {
    const store = createSqlitePostingIntentStore(state);
    const intent = baseIntent();
    const claim = await store.claim(intent);
    if (claim.kind !== "owner") throw new Error("expected owner");
    const outcome = { taskId: 123_456_789_012_345_678_901_234_567_890n, txHash: TX_HASH };
    await store.resolve(intent, claim.ownerToken, outcome);

    const replay = await store.claim(intent);

    expect(replay).toEqual({ kind: "resolved", outcome });
  });

  test("fence returns true only for the live owner token, false after resolve, and false for a foreign token", async () => {
    const store = createSqlitePostingIntentStore(state);
    const intent = baseIntent();
    const claim = await store.claim(intent);
    if (claim.kind !== "owner") throw new Error("expected owner");

    expect(await store.fence(intent, claim.ownerToken)).toBe(true);
    expect(await store.fence(intent, "posting-owner:foreign" as PostingOwnerToken)).toBe(false);

    await store.resolve(intent, claim.ownerToken, { taskId: 1n, txHash: TX_HASH });
    expect(await store.fence(intent, claim.ownerToken)).toBe(false);
  });

  test("resolve with a foreign token throws", async () => {
    const store = createSqlitePostingIntentStore(state);
    const intent = baseIntent();
    const claim = await store.claim(intent);
    if (claim.kind !== "owner") throw new Error("expected owner");

    await expect(
      store.resolve(intent, "posting-owner:foreign" as PostingOwnerToken, { taskId: 1n, txHash: TX_HASH }),
    ).rejects.toThrow("only the posting intent owner token may resolve");
  });

  test("resolve twice with the same outcome is a no-op", async () => {
    const store = createSqlitePostingIntentStore(state);
    const intent = baseIntent();
    const claim = await store.claim(intent);
    if (claim.kind !== "owner") throw new Error("expected owner");
    const outcome = { taskId: 1n, txHash: TX_HASH };

    await store.resolve(intent, claim.ownerToken, outcome);
    await expect(store.resolve(intent, claim.ownerToken, outcome)).resolves.toBeUndefined();

    const record = await store.lookup(intent);
    expect(record?.resolved).toEqual(outcome);
  });

  test("resolve twice with a different outcome throws -- the store never silently re-points a landed post", async () => {
    const store = createSqlitePostingIntentStore(state);
    const intent = baseIntent();
    const claim = await store.claim(intent);
    if (claim.kind !== "owner") throw new Error("expected owner");
    await store.resolve(intent, claim.ownerToken, { taskId: 1n, txHash: TX_HASH });

    await expect(
      store.resolve(intent, claim.ownerToken, { taskId: 2n, txHash: TX_HASH }),
    ).rejects.toThrow("already resolved to a different outcome");
  });

  test("resolve on a never-claimed key throws", async () => {
    const store = createSqlitePostingIntentStore(state);
    await expect(
      store.resolve(baseIntent(), "posting-owner:nope" as PostingOwnerToken, { taskId: 1n, txHash: TX_HASH }),
    ).rejects.toThrow("cannot resolve an intent that was never claimed");
  });

  test("the schema CHECK is a real guard against a half-resolved row, exercised through the public API", async () => {
    const store = createSqlitePostingIntentStore(state);
    const intent = baseIntent();
    const claim = await store.claim(intent);
    if (claim.kind !== "owner") throw new Error("expected owner");

    // A malformed outcome that sets one resolved column but not the other must hit the
    // `posting_intents` CHECK constraint, not just an application-level guard.
    const malformed = { taskId: 1n, txHash: null as unknown as `0x${string}` };
    await expect(store.resolve(intent, claim.ownerToken, malformed)).rejects.toThrow(/CHECK constraint failed/);

    // The failed write must not have persisted a half-resolved row.
    const record = await store.lookup(intent);
    expect(record?.resolved).toBeUndefined();
  });

  test("lookup returns the record without the owner token", async () => {
    const store = createSqlitePostingIntentStore(state);
    const intent = baseIntent();
    await store.claim(intent);

    const record = await store.lookup(intent);

    expect(record).toEqual(intent);
    expect(record && "ownerToken" in record).toBe(false);
  });

  test("lookup on an unseen key returns undefined", async () => {
    const store = createSqlitePostingIntentStore(state);
    expect(await store.lookup(baseIntent())).toBeUndefined();
  });

  test("scanPending returns only unresolved rows, each carrying its owner token", async () => {
    const store = createSqlitePostingIntentStore(state);
    const pending = baseIntent({ submissionDigest: `sha256:${"1".repeat(64)}` as `sha256:${string}` });
    const resolved = baseIntent({ submissionDigest: `sha256:${"2".repeat(64)}` as `sha256:${string}` });
    const pendingClaim = await store.claim(pending);
    const resolvedClaim = await store.claim(resolved);
    if (pendingClaim.kind !== "owner" || resolvedClaim.kind !== "owner") throw new Error("expected owner");
    await store.resolve(resolved, resolvedClaim.ownerToken, { taskId: 1n, txHash: TX_HASH });

    const rows = await store.scanPending();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.submissionDigest).toBe(pending.submissionDigest);
    expect(rows[0]?.ownerToken).toBe(pendingClaim.ownerToken);
  });

  test("a closed-then-reopened database returns identical lookup and scanPending results", async () => {
    const restartRoot = mkdtempSync(join(tmpdir(), "venue-posting-intents-restart-"));
    const restartDbPath = join(restartRoot, "venue.db");
    const first = openVenueState(restartDbPath);
    const intent = baseIntent();
    let ownerToken: PostingOwnerToken;
    try {
      const claim = await createSqlitePostingIntentStore(first).claim(intent);
      if (claim.kind !== "owner") throw new Error("expected owner");
      ownerToken = claim.ownerToken;
    } finally {
      first.close();
    }

    const reopened = openVenueState(restartDbPath);
    try {
      const store = createSqlitePostingIntentStore(reopened);
      expect(await store.lookup(intent)).toEqual(intent);
      const pendingRows = await store.scanPending();
      expect(pendingRows).toHaveLength(1);
      expect(pendingRows[0]?.ownerToken).toBe(ownerToken);
    } finally {
      reopened.close();
      rmSync(restartRoot, { recursive: true, force: true });
    }
  });
});
