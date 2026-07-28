// SPDX-License-Identifier: MIT

// Honors `docs/superpowers/specs/2026-07-24-task-post-broadcast-intent-design.md` (pinned
// as-is, never rewritten): an intent is persisted BEFORE broadcast so a crash between the two
// leaves a recoverable, at-most-once trace, re-keyed here (design §6.1) onto
// `(creator Safe, Task CID digest, Submission digest)` in place of the retired
// SolverNet-manifest-digest leg. This package owns the CRASH-SAFETY half only (persist before
// broadcast; resolve on success; a pending intent blocks a concurrent re-broadcast) -- it does
// NOT own a durable cross-session "already posted" ledger (that is `client/src/store`'s
// `task_posts` table, a host/pipeline concern outside this standalone package's boundary). A
// caller that wants full idempotent resubmission across process restarts persists its own
// completed-post record and checks it before calling `postTask` again.

/** The broadcast-intent WAL record, persisted before the posting transaction is broadcast. */
export interface PostingIntent {
  readonly creatorSafe: `0x${string}`;
  readonly taskCidDigest: `sha256:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

/** The `(creatorSafe, taskCidDigest, submissionDigest)` key an intent is re-keyed onto (§6.1). */
export type PostingIntentKey = Pick<PostingIntent, "creatorSafe" | "taskCidDigest" | "submissionDigest">;

/** A resolved intent's on-chain outcome. */
export interface PostingOutcome {
  readonly taskId: bigint;
  readonly txHash: `0x${string}`;
}

export interface PostingIntentRecord extends PostingIntent {
  readonly resolved?: PostingOutcome;
}

/**
 * The injected persistence port. `postTask` (posting.ts) calls `persist` before broadcasting and
 * `resolve` after a successful broadcast; `recoverPostingIntents` reads `scanPending` to find
 * intents that crashed between the two.
 */
export interface PostingIntentStore {
  persist(intent: PostingIntent): Promise<void>;
  resolve(key: PostingIntentKey, outcome: PostingOutcome): Promise<void>;
  lookup(key: PostingIntentKey): Promise<PostingIntentRecord | undefined>;
  scanPending(): Promise<readonly PostingIntent[]>;
}

/** An in-memory `PostingIntentStore` -- the reference implementation for tests and small hosts. */
export function createInMemoryPostingIntentStore(): PostingIntentStore {
  const byKey = new Map<string, PostingIntentRecord>();
  const keyOf = (key: PostingIntentKey): string =>
    `${key.creatorSafe.toLowerCase()}${key.taskCidDigest}${key.submissionDigest}`;

  return {
    async persist(intent) {
      byKey.set(keyOf(intent), { ...intent });
    },
    async resolve(key, outcome) {
      const existing = byKey.get(keyOf(key));
      if (existing === undefined) throw new Error("cannot resolve an intent that was never persisted");
      byKey.set(keyOf(key), { ...existing, resolved: outcome });
    },
    async lookup(key) {
      return byKey.get(keyOf(key));
    },
    async scanPending() {
      return [...byKey.values()].filter((record) => record.resolved === undefined);
    },
  };
}

/** Thrown when `postTask` finds a pending (unresolved) intent for the same key already in flight. */
export class BroadcastUncertainError extends Error {
  constructor(readonly intent: PostingIntent) {
    super(
      `a broadcast intent for (creatorSafe=${intent.creatorSafe}, taskCidDigest=${intent.taskCidDigest}, `
        + `submissionDigest=${intent.submissionDigest}) is already pending -- run recoverPostingIntents `
        + "before retrying (broadcast_uncertain)",
    );
    this.name = "BroadcastUncertainError";
  }
}

/** A chain-side lookup for a matching on-chain post, given a pending intent (design's "exact recovery scan"). */
export type ScanForOnChainMatch = (intent: PostingIntent) => Promise<PostingOutcome | null>;

/**
 * The recovery scan (design §6.1): for every still-pending intent, ask the injected `scan` port
 * whether it actually landed on-chain. A match is adopted idempotently (resolved in the store,
 * dropped from the returned list); no match leaves the intent uncertain -- returned so the
 * caller can surface it (never silently retried/rebroadcast).
 */
export async function recoverPostingIntents(
  store: PostingIntentStore,
  scan: ScanForOnChainMatch,
): Promise<readonly PostingIntent[]> {
  const pending = await store.scanPending();
  const stillUncertain: PostingIntent[] = [];
  for (const intent of pending) {
    // eslint-disable-next-line no-await-in-loop -- recovery scans are small and sequential by design.
    const match = await scan(intent);
    if (match !== null) {
      await store.resolve(intent, match);
    } else {
      stillUncertain.push(intent);
    }
  }
  return stillUncertain;
}
