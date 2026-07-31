import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createInMemoryPostingIntentStore,
  recoverPostingIntents,
  type PostingIntent,
  type PostingIntentStore,
} from "./broadcast-intent.js";
import { createFilePostingIntentStore } from "./posting-intent-file-store.js";

const CREATOR = "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98" as const;
const OUTCOME = { taskId: 7n, txHash: `0x${"cd".repeat(32)}` as const };

function intent(seed: string): PostingIntent {
  return {
    creatorSafe: CREATOR,
    taskCidDigest: `sha256:${seed.repeat(2).padEnd(64, "0")}`,
    submissionDigest: `sha256:${seed.repeat(2).padEnd(64, "1")}`,
    idempotencyKey: `key-${seed}`,
    createdAt: "2026-07-31T00:00:00Z",
  };
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fileStore(): PostingIntentStore {
  const directory = mkdtempSync(join(tmpdir(), "jinn-posting-intents-"));
  directories.push(directory);
  return createFilePostingIntentStore(directory);
}

describe.each([
  ["in-memory", () => createInMemoryPostingIntentStore()],
  ["file", fileStore],
])("PostingIntentStore conformance -- %s", (_name, make) => {
  test("claim creates ownership once; a second claim reports pending-other", async () => {
    const store = make();
    const first = await store.claim(intent("a"));
    const second = await store.claim(intent("a"));
    expect(first.kind).toBe("owner");
    expect(second.kind).toBe("pending-other");
    if (second.kind === "pending-other") expect(second.intent.idempotencyKey).toBe("key-a");
  });

  test("concurrent claims on one key produce exactly one owner", async () => {
    // The port's stated prohibition: `claim` atomically creates ownership, never a racy
    // lookup-then-unconditional-write. Racing N claimants is the only case that sees the
    // difference -- every other case in this suite is sequential, and a racy adapter passes them.
    const store = make();
    const claims = await Promise.all(Array.from({ length: 8 }, async () => store.claim(intent("2"))));
    expect(claims.filter((claim) => claim.kind === "owner")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "pending-other")).toHaveLength(7);
    expect(await store.scanPending()).toHaveLength(1);
  });

  test("pending-other never leaks the owner token or the resolution", async () => {
    const store = make();
    const claim = await store.claim(intent("3"));
    if (claim.kind !== "owner") throw new Error("expected owner");
    const second = await store.claim(intent("3"));
    if (second.kind !== "pending-other") throw new Error("expected pending-other");
    // `BroadcastUncertainError` embeds this view in its message, so a leak here prints an owner
    // token into operator logs.
    expect(Object.keys(second.intent)).not.toContain("ownerToken");
    expect(Object.keys(second.intent)).not.toContain("resolved");
  });

  test("a resolved key replays its outcome instead of re-claiming", async () => {
    const store = make();
    const claim = await store.claim(intent("b"));
    if (claim.kind !== "owner") throw new Error("expected owner");
    await store.resolve(intent("b"), claim.ownerToken, OUTCOME);
    const replay = await store.claim(intent("b"));
    expect(replay).toEqual({ kind: "resolved", outcome: OUTCOME });
  });

  test("fence is true only for the live owner of an unresolved intent", async () => {
    const store = make();
    const claim = await store.claim(intent("c"));
    if (claim.kind !== "owner") throw new Error("expected owner");
    expect(await store.fence(intent("c"), claim.ownerToken)).toBe(true);
    expect(await store.fence(intent("c"), "posting-owner:not-the-owner" as typeof claim.ownerToken)).toBe(false);
    expect(await store.fence(intent("d"), claim.ownerToken)).toBe(false);
    await store.resolve(intent("c"), claim.ownerToken, OUTCOME);
    expect(await store.fence(intent("c"), claim.ownerToken)).toBe(false);
  });

  test("only the owner token may resolve, and never to a second outcome", async () => {
    const store = make();
    const claim = await store.claim(intent("e"));
    if (claim.kind !== "owner") throw new Error("expected owner");
    await expect(store.resolve(intent("e"), "posting-owner:other" as typeof claim.ownerToken, OUTCOME))
      .rejects.toThrow(/owner token/u);
    await expect(store.resolve(intent("f"), claim.ownerToken, OUTCOME))
      .rejects.toThrow(/never claimed/u);
    await store.resolve(intent("e"), claim.ownerToken, OUTCOME);
    await store.resolve(intent("e"), claim.ownerToken, OUTCOME); // idempotent
    await expect(store.resolve(intent("e"), claim.ownerToken, { ...OUTCOME, taskId: 8n }))
      .rejects.toThrow(/different outcome/u);
  });

  test("lookup never leaks the owner token", async () => {
    const store = make();
    const claim = await store.claim(intent("9"));
    if (claim.kind !== "owner") throw new Error("expected owner");
    const record = await store.lookup(intent("9"));
    expect(record?.idempotencyKey).toBe("key-9");
    expect(Object.keys(record ?? {})).not.toContain("ownerToken");
    expect(await store.lookup(intent("8"))).toBeUndefined();
  });

  test("scanPending returns unresolved intents with their tokens, and recovery adopts a match", async () => {
    const store = make();
    const claimed = await store.claim(intent("7"));
    if (claimed.kind !== "owner") throw new Error("expected owner");
    const pending = await store.scanPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.ownerToken).toBe(claimed.ownerToken);

    const uncertain = await recoverPostingIntents(store, async () => OUTCOME);
    expect(uncertain).toEqual([]);
    expect(await store.lookup(intent("7"))).toMatchObject({ resolved: OUTCOME });
    expect(await store.scanPending()).toEqual([]);
  });

  test("a scan with no match leaves the intent uncertain and unresolved", async () => {
    const store = make();
    await store.claim(intent("6"));
    const uncertain = await recoverPostingIntents(store, async () => null);
    expect(uncertain).toHaveLength(1);
    expect(await store.scanPending()).toHaveLength(1);
  });
});
