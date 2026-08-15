// SPDX-License-Identifier: MIT

// A durable `PostingIntentStore` on the local filesystem -- the crash-safety half of the pinned
// 2026-07-24 broadcast-intent design, surviving process death (supply design §8 D7). The
// semantics are the in-memory store's, unchanged: `posting-intent-store-conformance.test.ts` runs
// one suite against both.
//
// Atomicity, concretely:
//   claim   -- write the whole record to a sibling temp, fsync it, then `link` it into place.
//              `link` fails EEXIST atomically (the OS picks the winner, exactly like O_EXCL) but
//              the bytes are already durable, so the record name never exists half-written or
//              zero-length. That is what makes `claim` atomic in CONTENT and not merely in
//              existence: there is no state a second claimant could read as "empty" and take
//              over, which is the racy lookup-then-unconditional-write the port forbids.
//   resolve -- write a sibling temp file, fsync it, `rename` it over the record. POSIX rename
//              within one directory replaces atomically, so a reader sees the old record or the
//              new one, never a half-written one.
//   both    -- fsync the file and then the directory before returning. A write-ahead record that
//              is only in the page cache is not a write-ahead record.
//
// A file this store did not write (empty, truncated, or otherwise unparseable) is never taken
// over: `claim` refuses it, and `scanPending` quarantines it so one poisoned file cannot deny
// recovery to every other pending intent in the directory.
//
// This store owns the crash-safety half only. It is NOT a cross-session "already posted" ledger;
// a caller wanting full idempotent resubmission keeps its own completed-post record (see
// broadcast-intent.ts's header).
import { link, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { postingIntentsEqual } from "./broadcast-intent.js";
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
  readonly version?: 2;
  readonly venueNamespace?: string;
  readonly commandDigest?: `sha256:${string}`;
  readonly command?: PostingIntent["command"];
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
    ...(stored.version === undefined ? {} : { version: stored.version }),
    ...(stored.venueNamespace === undefined ? {} : { venueNamespace: stored.venueNamespace }),
    ...(stored.commandDigest === undefined ? {} : { commandDigest: stored.commandDigest }),
    ...(stored.command === undefined ? {} : { command: stored.command }),
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

/** A file `scanPending` skipped because it is not a readable intent record. */
export interface MalformedIntentRecordReport {
  /** File name within the store directory; the file is left on disk for an operator to inspect. */
  readonly file: string;
  readonly reason: string;
}

export interface FilePostingIntentStoreOptions {
  /**
   * Called once per file `scanPending` quarantines. A torn record is the likeliest artifact of the
   * process death this store exists to survive, and throwing on it would make every OTHER pending
   * intent in the directory unrecoverable until someone hand-deleted the bad file. The scan skips
   * and reports instead; the claim path still fails closed on the same file.
   */
  readonly onMalformedRecord?: (report: MalformedIntentRecordReport) => void;
}

/**
 * @param directory absolute path the store owns; created on first write. One directory per
 * requester identity keeps `scanPending` scoped to the intents that identity may resolve.
 */
export function createFilePostingIntentStore(
  directory: string,
  options: FilePostingIntentStoreOptions = {},
): PostingIntentStore {
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
    // `claim` links a fully-written record into place, so this store never produces an empty one.
    // An empty file is therefore foreign, and refusing it is the same fail-closed answer a
    // truncated one gets -- never a takeover.
    if (text.trim() === "") {
      throw new Error(
        `posting intent record ${name} is empty -- this store cannot have written it; refusing to `
          + "claim over a record it does not own",
      );
    }
    return parse(text);
  };

  /** Writes the record to a durable temp, then hands it to `commit` under the record's own name. */
  const writeDurableTemp = async (
    name: string,
    record: StoredRecord,
    commit: (temporary: string, target: string) => Promise<void>,
  ): Promise<void> => {
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
      await commit(temporary, target);
    } finally {
      // After `link` the target is a second name for the same inode, so dropping the temp is
      // always correct; after `rename` the temp is already gone and the unlink is a no-op.
      await unlink(temporary).catch(() => undefined);
    }
    await syncDirectory(directory);
  };

  const writeThroughRename = async (name: string, record: StoredRecord): Promise<void> => {
    await writeDurableTemp(name, record, async (temporary, target) => {
      await rename(temporary, target);
    });
  };

  /** Creates the record under its own name, or reports that the name is already taken. */
  const claimThroughLink = async (name: string, record: StoredRecord): Promise<boolean> => {
    let created = true;
    await writeDurableTemp(name, record, async (temporary, target) => {
      try {
        await link(temporary, target);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        created = false;
      }
    });
    return created;
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
        ...(intent.version === undefined ? {} : { version: intent.version }),
        ...(intent.venueNamespace === undefined ? {} : { venueNamespace: intent.venueNamespace }),
        ...(intent.commandDigest === undefined ? {} : { commandDigest: intent.commandDigest }),
        ...(intent.command === undefined ? {} : { command: intent.command }),
        ownerToken: `posting-owner:${crypto.randomUUID()}`,
      };

      if (await claimThroughLink(name, record)) {
        return { kind: "owner", intent, ownerToken: record.ownerToken as PostingOwnerToken };
      }

      // The name was taken; the record under it is complete by construction. `readRecord` throws
      // on anything this store did not write, which is the fail-closed answer -- never a takeover.
      const existing = await readRecord(name);
      if (existing === undefined) {
        throw new Error(
          `posting intent record ${name} existed when this claim was made and vanished before it `
            + "could be read -- another writer is mutating this store's directory",
        );
      }
      if (!postingIntentsEqual(toOwnedRecord(existing), intent)) {
        return { kind: "conflict", existing: toOwnedRecord(existing) };
      }
      if (existing.resolved !== undefined) {
        return {
          kind: "resolved",
          outcome: { taskId: BigInt(existing.resolved.taskId), txHash: existing.resolved.txHash },
        };
      }
      const { ownerToken: _ownerToken, resolved: _resolved, ...view } = toOwnedRecord(existing);
      return { kind: "pending-other", intent: view };
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
        let stored: StoredRecord | undefined;
        try {
          // eslint-disable-next-line no-await-in-loop -- recovery scans are small and sequential.
          stored = await readRecord(name);
        } catch (error) {
          // Quarantine, do not throw: one unreadable file must not make every other pending intent
          // in this directory unrecoverable. The file stays on disk; the caller is told about it.
          options.onMalformedRecord?.({
            file: name,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (stored === undefined || stored.resolved !== undefined) continue;
        records.push(toOwnedRecord(stored));
      }
      return records;
    },
  };
}
