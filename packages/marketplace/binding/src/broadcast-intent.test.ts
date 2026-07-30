import { describe, expect, test } from "vitest";
import {
  BroadcastUncertainError,
  createInMemoryPostingIntentStore,
  recoverPostingIntents,
  type PostingIntent,
  type PostingOwnerToken,
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
  test("claim then scanPending: exactly one recoverable owned intent, keyed on (creatorSafe, taskCidDigest, submissionDigest)", async () => {
    const store = createInMemoryPostingIntentStore();
    const claimed = await store.claim(intent());
    expect(claimed.kind).toBe("owner");
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
    const claimed = await store.claim(intent());
    if (claimed.kind !== "owner") throw new Error("unreachable");
    await store.resolve(intent(), claimed.ownerToken, { taskId: 1n, txHash: `0x${"c".repeat(64)}` });
    expect(await store.scanPending()).toHaveLength(0);
    expect((await store.lookup(intent()))?.resolved).toEqual({ taskId: 1n, txHash: `0x${"c".repeat(64)}` });
  });

  test("resolve without a matching claimed intent throws (never fabricates a resolution)", async () => {
    const store = createInMemoryPostingIntentStore();
    await expect(store.resolve(
      intent(),
      "invented-token" as PostingOwnerToken,
      { taskId: 1n, txHash: `0x${"c".repeat(64)}` },
    )).rejects.toThrow(
      /never claimed/,
    );
  });

  test("a simultaneous contender never receives the owner token and cannot fence or resolve", async () => {
    const store = createInMemoryPostingIntentStore();
    const [first, second] = await Promise.all([
      store.claim(intent()),
      store.claim(intent()),
    ]);
    const owner = [first, second].find((claim) => claim.kind === "owner");
    const contender = [first, second].find((claim) => claim.kind === "pending-other");
    expect(owner?.kind).toBe("owner");
    expect(contender).toEqual({ kind: "pending-other", intent: intent() });
    if (owner?.kind !== "owner") throw new Error("unreachable");

    expect(await store.fence(intent(), owner.ownerToken)).toBe(true);
    expect(
      await store.fence(intent(), "invented-token" as PostingOwnerToken),
    ).toBe(false);
    await expect(store.resolve(
      intent(),
      "invented-token" as PostingOwnerToken,
      { taskId: 1n, txHash: `0x${"c".repeat(64)}` },
    )).rejects.toThrow(/owner token/);
  });

  test("a claim after resolution returns the prior outcome, never fresh ownership", async () => {
    const store = createInMemoryPostingIntentStore();
    const claimed = await store.claim(intent());
    if (claimed.kind !== "owner") throw new Error("unreachable");
    const outcome = { taskId: 1n, txHash: `0x${"c".repeat(64)}` } as const;
    await store.resolve(intent(), claimed.ownerToken, outcome);
    await expect(store.claim(intent())).resolves.toEqual({
      kind: "resolved",
      outcome,
    });
  });
});

describe("recoverPostingIntents", () => {
  test("a matched intent is adopted idempotently (resolved, dropped from the returned uncertain list)", async () => {
    const store = createInMemoryPostingIntentStore();
    await store.claim(intent());
    const outcome = { taskId: 7n, txHash: `0x${"d".repeat(64)}` } as const;

    const uncertain = await recoverPostingIntents(store, async () => outcome);

    expect(uncertain).toEqual([]);
    expect(await store.scanPending()).toHaveLength(0);
    expect((await store.lookup(intent()))?.resolved).toEqual(outcome);
  });

  test("no on-chain match leaves the intent uncertain -- never silently retried", async () => {
    const store = createInMemoryPostingIntentStore();
    await store.claim(intent());
    let scanned: PostingIntent | undefined;

    const uncertain = await recoverPostingIntents(store, async (candidate) => {
      scanned = candidate;
      return null;
    });

    expect(uncertain).toHaveLength(1);
    expect(Object.hasOwn(scanned!, "ownerToken")).toBe(false);
    expect(Object.hasOwn(uncertain[0]!, "ownerToken")).toBe(false);
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
