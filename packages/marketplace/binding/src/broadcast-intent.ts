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

declare const postingOwnerTokenBrand: unique symbol;
/** Unguessable durable authority returned only to the caller that atomically created an intent. */
export type PostingOwnerToken = string & {
  readonly [postingOwnerTokenBrand]: "PostingOwnerToken";
};

export interface PostingIntentRecord extends PostingIntent {
  readonly resolved?: PostingOutcome;
}

export interface OwnedPostingIntentRecord extends PostingIntentRecord {
  readonly ownerToken: PostingOwnerToken;
}

export type PostingIntentClaim =
  | {
      readonly kind: "owner";
      readonly intent: PostingIntent;
      readonly ownerToken: PostingOwnerToken;
    }
  | {
      readonly kind: "pending-other";
      readonly intent: PostingIntent;
    }
  | {
      readonly kind: "resolved";
      readonly outcome: PostingOutcome;
    };

/**
 * Linearizable persistence port (program §7.52). `claim` atomically creates ownership or reports
 * an existing pending/resolved record. Only the unguessable token owner may fence or resolve.
 * Durable adapters persist the token beside the intent so crash recovery can resume the same
 * ownership; they never implement `claim` as a racy lookup followed by an unconditional write.
 */
export interface PostingIntentStore {
  claim(intent: PostingIntent): Promise<PostingIntentClaim>;
  fence(key: PostingIntentKey, ownerToken: PostingOwnerToken): Promise<boolean>;
  resolve(
    key: PostingIntentKey,
    ownerToken: PostingOwnerToken,
    outcome: PostingOutcome,
  ): Promise<void>;
  lookup(key: PostingIntentKey): Promise<PostingIntentRecord | undefined>;
  scanPending(): Promise<readonly OwnedPostingIntentRecord[]>;
}

/** An in-memory `PostingIntentStore` -- the reference implementation for tests and small hosts. */
export function createInMemoryPostingIntentStore(): PostingIntentStore {
  const byKey = new Map<string, OwnedPostingIntentRecord>();
  const keyOf = (key: PostingIntentKey): string =>
    `${key.creatorSafe.toLowerCase()}|${key.taskCidDigest}|${key.submissionDigest}`;

  return {
    async claim(intent) {
      const key = keyOf(intent);
      const existing = byKey.get(key);
      if (existing?.resolved !== undefined) {
        return { kind: "resolved", outcome: existing.resolved };
      }
      if (existing !== undefined) {
        return {
          kind: "pending-other",
          intent: {
            creatorSafe: existing.creatorSafe,
            taskCidDigest: existing.taskCidDigest,
            submissionDigest: existing.submissionDigest,
            idempotencyKey: existing.idempotencyKey,
            createdAt: existing.createdAt,
          },
        };
      }
      const ownerToken =
        `posting-owner:${crypto.randomUUID()}` as PostingOwnerToken;
      byKey.set(key, { ...intent, ownerToken });
      return { kind: "owner", intent, ownerToken };
    },
    async fence(key, ownerToken) {
      const existing = byKey.get(keyOf(key));
      return existing !== undefined
        && existing.resolved === undefined
        && existing.ownerToken === ownerToken;
    },
    async resolve(key, ownerToken, outcome) {
      const existing = byKey.get(keyOf(key));
      if (existing === undefined) {
        throw new Error("cannot resolve an intent that was never claimed");
      }
      if (existing.ownerToken !== ownerToken) {
        throw new Error("only the posting intent owner token may resolve");
      }
      if (existing.resolved !== undefined) {
        if (
          existing.resolved.taskId !== outcome.taskId
          || existing.resolved.txHash !== outcome.txHash
        ) {
          throw new Error("posting intent is already resolved to a different outcome");
        }
        return;
      }
      byKey.set(keyOf(key), { ...existing, resolved: outcome });
    },
    async lookup(key) {
      const existing = byKey.get(keyOf(key));
      if (existing === undefined) return undefined;
      const { ownerToken: _ownerToken, ...view } = existing;
      return view;
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
  for (const ownedIntent of pending) {
    const { ownerToken, ...intent } = ownedIntent;
    // eslint-disable-next-line no-await-in-loop -- recovery scans are small and sequential by design.
    const match = await scan(intent);
    if (match !== null) {
      await store.resolve(intent, ownerToken, match);
    } else {
      stillUncertain.push(intent);
    }
  }
  return stillUncertain;
}
