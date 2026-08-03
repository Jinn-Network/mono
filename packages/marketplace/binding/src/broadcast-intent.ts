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
  /** Phase C commands are exact; absent fields identify a legacy record that cannot be replayed. */
  readonly version?: 2;
  readonly venueNamespace?: string;
  readonly commandDigest?: `sha256:${string}`;
  readonly command?: import("./posting.js").PreparedPostingCommand;
}

/** Exact operation key; the optional legs exist only to read frozen pre-Phase-C records. */
export type PostingIntentKey = Pick<PostingIntent, "creatorSafe" | "taskCidDigest" | "submissionDigest"
  | "venueNamespace" | "commandDigest">;

/** Stable cross-store join key for a requester scope and its sole broadcast WAL record. */
export function postingIntentKeyOf(key: PostingIntentKey): string {
  const legacy = `${key.creatorSafe.toLowerCase()}|${key.taskCidDigest}|${key.submissionDigest}`;
  return key.venueNamespace === undefined || key.commandDigest === undefined
    ? `legacy|${legacy}`
    : `v2|${key.venueNamespace}|${legacy}|${key.commandDigest}`;
}

/** Exact equality guard used by every durable adapter before treating a claim as replay. */
export function postingIntentsEqual(left: PostingIntent, right: PostingIntent): boolean {
  return postingIntentKeyOf(left) === postingIntentKeyOf(right)
    && left.idempotencyKey === right.idempotencyKey
    && JSON.stringify(left.command) === JSON.stringify(right.command);
}

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
    }
  | { readonly kind: "conflict"; readonly existing: PostingIntent };

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
  // One sealed Submission may bind exactly one money-path command. The logical row key remains
  // the original tuple so changed terms/venue bytes collide and are rejected by the exact
  // equality check instead of allocating a second broadcast authority.
  const keyOf = (key: PostingIntentKey): string =>
    `${key.creatorSafe.toLowerCase()}|${key.taskCidDigest}|${key.submissionDigest}`;

  return {
    async claim(intent) {
      const key = keyOf(intent);
      const existing = byKey.get(key);
      if (existing?.resolved !== undefined) {
        if (!postingIntentsEqual(existing, intent)) {
          return { kind: "conflict", existing };
        }
        return { kind: "resolved", outcome: existing.resolved };
      }
      if (existing !== undefined) {
        if (!postingIntentsEqual(existing, intent)) {
          return { kind: "conflict", existing };
        }
        return {
          kind: "pending-other",
          intent: {
            creatorSafe: existing.creatorSafe,
            taskCidDigest: existing.taskCidDigest,
            submissionDigest: existing.submissionDigest,
            idempotencyKey: existing.idempotencyKey,
            createdAt: existing.createdAt,
            ...(existing.version === undefined ? {} : { version: existing.version }),
            ...(existing.venueNamespace === undefined ? {} : { venueNamespace: existing.venueNamespace }),
            ...(existing.commandDigest === undefined ? {} : { commandDigest: existing.commandDigest }),
            ...(existing.command === undefined ? {} : { command: existing.command }),
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
 * Conservative chain diagnostic for legacy hosts. `TaskCreated` does not anchor a Submission or
 * command digest, so neither a singleton nor an ambiguous chain match may resolve this WAL. The
 * scan is still run to support operator diagnostics, but every pending intent remains uncertain.
 * Phase C requester recovery adopts only an already-resolved exact WAL (or a future exact local
 * transaction-ledger proof) through `MarketplaceRequesterBackend.recoverPosting()`.
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
    await scan(intent);
    // The owner token is intentionally retained in durable storage. Chain-only evidence cannot
    // distinguish two Submissions for the same Task digest and therefore cannot consume it.
    void ownerToken;
    stillUncertain.push(intent);
  }
  return stillUncertain;
}
