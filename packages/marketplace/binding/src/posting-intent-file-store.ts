// SPDX-License-Identifier: MIT

// A durable `PostingIntentStore` on the local filesystem -- the crash-safety half of the pinned
// 2026-07-24 broadcast-intent design, surviving process death (supply design §8 D7). The
// semantics are the in-memory store's, unchanged: `posting-intent-store-conformance.test.ts` runs
// one suite against both.
//
// Atomicity, concretely:
//   claim   -- a single `open(path, "wx")`. O_EXCL makes the OS pick the winner, so there is no
//              read-then-write window and no racy lookup-then-unconditional-write (the port's
//              stated prohibition).
//   resolve -- write a sibling temp file, fsync it, `rename` it over the record. POSIX rename
//              within one directory replaces atomically, so a reader sees the old record or the
//              new one, never a half-written one.
//   both    -- fsync the file and then the directory before returning. A write-ahead record that
//              is only in the page cache is not a write-ahead record.
//
// This store owns the crash-safety half only. It is NOT a cross-session "already posted" ledger;
// a caller wanting full idempotent resubmission keeps its own completed-post record (see
// broadcast-intent.ts's header).
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  OwnedPostingIntentRecord,
  PostingIntent,
  PostingIntentClaim,
  PostingIntentKey,
  PostingIntentRecord,
  PostingIntentStore,
  PostingOutcome,
  PostingOwnerToken,
} from "./broadcast-intent.js";
import { compareCodeUnitStrings } from "./order.js";

const CREATOR_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RECORD_SUFFIX = ".json";

interface StoredRecord {
  readonly creatorSafe: `0x${string}`;
  readonly taskCidDigest: `sha256:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly ownerToken: string;
  readonly resolved?: { readonly taskId: string; readonly txHash: `0x${string}` };
}

/**
 * The record file name. Every component is validated before it reaches a path: an unchecked
 * digest or address would be a path-traversal primitive, and a store that refuses a malformed key
 * fails closed instead of writing outside its directory.
 */
function recordFileName(key: PostingIntentKey): string {
  if (!CREATOR_PATTERN.test(key.creatorSafe)) {
    throw new Error(`creatorSafe is not a 20-byte address: ${key.creatorSafe}`);
  }
  if (!DIGEST_PATTERN.test(key.taskCidDigest)) {
    throw new Error(`taskCidDigest is not a sha256: digest: ${key.taskCidDigest}`);
  }
  if (!DIGEST_PATTERN.test(key.submissionDigest)) {
    throw new Error(`submissionDigest is not a sha256: digest: ${key.submissionDigest}`);
  }
  return `${key.creatorSafe.toLowerCase().slice(2)}-${key.taskCidDigest.slice(7)}`
    + `-${key.submissionDigest.slice(7)}${RECORD_SUFFIX}`;
}

function serialize(record: StoredRecord): string {
  return `${JSON.stringify(record, undefined, 2)}\n`;
}

function parse(text: string): StoredRecord {
  const parsed = JSON.parse(text) as StoredRecord;
  if (typeof parsed.ownerToken !== "string" || typeof parsed.idempotencyKey !== "string") {
    throw new Error("posting intent record is missing its owner token or idempotency key");
  }
  return parsed;
}

function toOwnedRecord(stored: StoredRecord): OwnedPostingIntentRecord {
  return {
    creatorSafe: stored.creatorSafe,
    taskCidDigest: stored.taskCidDigest,
    submissionDigest: stored.submissionDigest,
    idempotencyKey: stored.idempotencyKey,
    createdAt: stored.createdAt,
    ownerToken: stored.ownerToken as PostingOwnerToken,
    ...(stored.resolved === undefined
      ? {}
      : { resolved: { taskId: BigInt(stored.resolved.taskId), txHash: stored.resolved.txHash } }),
  };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
  } catch (error) {
    // Directory handles are not openable for fsync everywhere; the file fsync already happened.
    if (["EPERM", "EACCES", "EISDIR", "EINVAL"].includes(errorCode(error) ?? "")) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!["EPERM", "EACCES", "EISDIR", "EINVAL"].includes(errorCode(error) ?? "")) throw error;
  } finally {
    await handle.close();
  }
}

/**
 * @param directory absolute path the store owns; created on first write. One directory per
 * requester identity keeps `scanPending` scoped to the intents that identity may resolve.
 */
export function createFilePostingIntentStore(directory: string): PostingIntentStore {
  let prepared: Promise<void> | undefined;
  const ensureDirectory = async (): Promise<void> => {
    prepared ??= mkdir(directory, { recursive: true }).then(() => undefined);
    await prepared;
  };

  const readRecord = async (name: string): Promise<StoredRecord | undefined> => {
    let text: string;
    try {
      text = await readFile(join(directory, name), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    if (text.trim() === "") return undefined; // a claim interrupted before its record was durable
    return parse(text);
  };

  const writeThroughRename = async (name: string, record: StoredRecord): Promise<void> => {
    const target = join(directory, name);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(serialize(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await syncDirectory(directory);
  };

  const requireOwned = async (key: PostingIntentKey, ownerToken: PostingOwnerToken) => {
    const name = recordFileName(key);
    const existing = await readRecord(name);
    if (existing === undefined) throw new Error("cannot resolve an intent that was never claimed");
    if (existing.ownerToken !== ownerToken) {
      throw new Error("only the posting intent owner token may resolve");
    }
    return { name, existing };
  };

  return {
    async claim(intent: PostingIntent): Promise<PostingIntentClaim> {
      await ensureDirectory();
      const name = recordFileName(intent);
      const record: StoredRecord = {
        creatorSafe: intent.creatorSafe,
        taskCidDigest: intent.taskCidDigest,
        submissionDigest: intent.submissionDigest,
        idempotencyKey: intent.idempotencyKey,
        createdAt: intent.createdAt,
        ownerToken: `posting-owner:${crypto.randomUUID()}`,
      };

      let handle;
      try {
        handle = await open(join(directory, name), "wx");
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const existing = await readRecord(name);
        if (existing === undefined) {
          // A zero-length record provably precedes any broadcast: `postTask` broadcasts only
          // after `claim` returns owner, and the record is durable before that. Taking it over is
          // safe, and if two callers do so at once the loser's `fence` fails and it raises
          // BroadcastUncertainError rather than posting twice -- at-most-once holds.
          await writeThroughRename(name, record);
          return { kind: "owner", intent, ownerToken: record.ownerToken as PostingOwnerToken };
        }
        if (existing.resolved !== undefined) {
          return {
            kind: "resolved",
            outcome: { taskId: BigInt(existing.resolved.taskId), txHash: existing.resolved.txHash },
          };
        }
        const { ownerToken: _ownerToken, resolved: _resolved, ...view } = toOwnedRecord(existing);
        return { kind: "pending-other", intent: view };
      }

      try {
        await handle.writeFile(serialize(record), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(directory);
      return { kind: "owner", intent, ownerToken: record.ownerToken as PostingOwnerToken };
    },

    async fence(key: PostingIntentKey, ownerToken: PostingOwnerToken): Promise<boolean> {
      const existing = await readRecord(recordFileName(key));
      return existing !== undefined
        && existing.resolved === undefined
        && existing.ownerToken === ownerToken;
    },

    async resolve(
      key: PostingIntentKey,
      ownerToken: PostingOwnerToken,
      outcome: PostingOutcome,
    ): Promise<void> {
      const { name, existing } = await requireOwned(key, ownerToken);
      if (existing.resolved !== undefined) {
        if (
          BigInt(existing.resolved.taskId) !== outcome.taskId
          || existing.resolved.txHash !== outcome.txHash
        ) {
          throw new Error("posting intent is already resolved to a different outcome");
        }
        return;
      }
      await writeThroughRename(name, {
        ...existing,
        resolved: { taskId: outcome.taskId.toString(10), txHash: outcome.txHash },
      });
    },

    async lookup(key: PostingIntentKey): Promise<PostingIntentRecord | undefined> {
      const existing = await readRecord(recordFileName(key));
      if (existing === undefined) return undefined;
      const { ownerToken: _ownerToken, ...view } = toOwnedRecord(existing);
      return view;
    },

    async scanPending(): Promise<readonly OwnedPostingIntentRecord[]> {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
      // readdir order is not specified; a fixed code-unit order makes recovery replay the same
      // way twice (localeCompare is banned in this tree -- see src/order.ts).
      const records: OwnedPostingIntentRecord[] = [];
      for (const name of names.filter((entry) => entry.endsWith(RECORD_SUFFIX)).sort(compareCodeUnitStrings)) {
        // eslint-disable-next-line no-await-in-loop -- recovery scans are small and sequential.
        const stored = await readRecord(name);
        if (stored === undefined || stored.resolved !== undefined) continue;
        records.push(toOwnedRecord(stored));
      }
      return records;
    },
  };
}
