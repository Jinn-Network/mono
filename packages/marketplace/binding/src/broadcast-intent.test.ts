import { describe, expect, test } from "vitest";
import {
  BroadcastUncertainError,
  createInMemoryPostingIntentStore,
  recoverPostingIntents,
  type PostingIntent,
} from "./broadcast-intent.js";

function intent(overrides: Partial<PostingIntent> = {}): PostingIntent {
  return {
    creatorSafe: "0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98",
    taskCidDigest: `sha256:${"a".repeat(64)}`,
    submissionDigest: `sha256:${"b".repeat(64)}`,
    idempotencyKey: "idem-1",
    createdAt: "2026-07-28T00:00:00Z",
    ...overrides,
  };
}

describe("PostingIntentStore (in-memory reference)", () => {
  test("persist then scanPending: exactly one recoverable intent, keyed on (creatorSafe, taskCidDigest, submissionDigest)", async () => {
    const store = createInMemoryPostingIntentStore();
    await store.persist(intent());
    const pending = await store.scanPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      creatorSafe: intent().creatorSafe,
      taskCidDigest: intent().taskCidDigest,
      submissionDigest: intent().submissionDigest,
    });
  });

  test("resolve clears an intent from scanPending (a completed post clears it)", async () => {
    const store = createInMemoryPostingIntentStore();
    await store.persist(intent());
    await store.resolve(intent(), { taskId: 1n, txHash: `0x${"c".repeat(64)}` });
    expect(await store.scanPending()).toHaveLength(0);
    expect((await store.lookup(intent()))?.resolved).toEqual({ taskId: 1n, txHash: `0x${"c".repeat(64)}` });
  });

  test("resolve without a matching persisted intent throws (never fabricates a resolution)", async () => {
    const store = createInMemoryPostingIntentStore();
    await expect(store.resolve(intent(), { taskId: 1n, txHash: `0x${"c".repeat(64)}` })).rejects.toThrow(
      /never persisted/,
    );
  });
});

describe("recoverPostingIntents", () => {
  test("a matched intent is adopted idempotently (resolved, dropped from the returned uncertain list)", async () => {
    const store = createInMemoryPostingIntentStore();
    await store.persist(intent());
    const outcome = { taskId: 7n, txHash: `0x${"d".repeat(64)}` } as const;

    const uncertain = await recoverPostingIntents(store, async () => outcome);

    expect(uncertain).toEqual([]);
    expect(await store.scanPending()).toHaveLength(0);
    expect((await store.lookup(intent()))?.resolved).toEqual(outcome);
  });

  test("no on-chain match leaves the intent uncertain -- never silently retried", async () => {
    const store = createInMemoryPostingIntentStore();
    await store.persist(intent());

    const uncertain = await recoverPostingIntents(store, async () => null);

    expect(uncertain).toHaveLength(1);
    expect(await store.scanPending()).toHaveLength(1); // still pending, not silently cleared
  });
});

describe("BroadcastUncertainError", () => {
  test("names the (creatorSafe, taskCidDigest, submissionDigest) key that is still pending", () => {
    const err = new BroadcastUncertainError(intent());
    expect(err.message).toContain(intent().creatorSafe);
    expect(err.message).toContain(intent().taskCidDigest);
    expect(err.message).toContain(intent().submissionDigest);
    expect(err.name).toBe("BroadcastUncertainError");
  });
});
