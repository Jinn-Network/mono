// SPDX-License-Identifier: MIT

// The durable transactional outbox (design §7 ruling 4), superseding the binding's in-memory
// crash WAL. The intent row is written in the same SQLite transaction that admits the operation
// and strictly before broadcast (program §6 contract 2); the sweeper drains pending rows through
// the Safe broadcaster; "broadcast-but-unrecorded" is the one state the recovery scan reconciles
// against the tx-submission ledger. The idempotency key is the LOGICAL operation identity from
// the sealed Submission -- never a tx hash.
import { randomUUID } from "node:crypto";
import type {
  PostingIntent, PostingIntentClaim, PostingIntentKey, PostingIntentRecord,
  PostingIntentStore, PostingOutcome, PostingOwnerToken,
} from "@jinn-network/marketplace-binding";
import type { VenueStateDatabase } from "../state/database.js";

interface IntentRow {
  readonly creator_safe: string;
  readonly task_cid_digest: string;
  readonly submission_digest: string;
  readonly idempotency_key: string;
  readonly owner_token: string;
  readonly created_at: string;
  readonly resolved_task_id: string | null;
  readonly resolved_tx_hash: string | null;
}

function toIntent(row: IntentRow): PostingIntent {
  return {
    creatorSafe: row.creator_safe as `0x${string}`,
    taskCidDigest: row.task_cid_digest as `sha256:${string}`,
    submissionDigest: row.submission_digest as `sha256:${string}`,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function toOutcome(row: IntentRow): PostingOutcome | undefined {
  if (row.resolved_task_id === null || row.resolved_tx_hash === null) return undefined;
  return { taskId: BigInt(row.resolved_task_id), txHash: row.resolved_tx_hash as `0x${string}` };
}

/** The durable `PostingIntentStore` backed by the `posting_intents` table (Task 6 schema). */
export function createSqlitePostingIntentStore(state: VenueStateDatabase): PostingIntentStore {
  const select = state.db.prepare(
    "SELECT * FROM posting_intents WHERE creator_safe = ? AND task_cid_digest = ? AND submission_digest = ?",
  );
  const insert = state.db.prepare(
    "INSERT INTO posting_intents (creator_safe, task_cid_digest, submission_digest, idempotency_key,"
    + " owner_token, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  );
  const resolveRow = state.db.prepare(
    "UPDATE posting_intents SET resolved_task_id = ?, resolved_tx_hash = ?"
    + " WHERE creator_safe = ? AND task_cid_digest = ? AND submission_digest = ? AND owner_token = ?"
    + " AND resolved_tx_hash IS NULL",
  );
  const pending = state.db.prepare("SELECT * FROM posting_intents WHERE resolved_tx_hash IS NULL ORDER BY created_at");

  const keyArgs = (key: PostingIntentKey): readonly [string, string, string] =>
    [key.creatorSafe.toLowerCase(), key.taskCidDigest, key.submissionDigest];

  return {
    async claim(intent: PostingIntent): Promise<PostingIntentClaim> {
      const ownerToken = `posting-owner:${randomUUID()}` as PostingOwnerToken;
      return state.transaction((): PostingIntentClaim => {
        const inserted = insert.run(
          intent.creatorSafe.toLowerCase(), intent.taskCidDigest, intent.submissionDigest,
          intent.idempotencyKey, ownerToken, intent.createdAt,
        );
        if (inserted.changes === 1) {
          return { kind: "owner", intent, ownerToken };
        }
        const row = select.get(...keyArgs(intent)) as IntentRow;
        const outcome = toOutcome(row);
        return outcome === undefined
          ? { kind: "pending-other", intent: toIntent(row) }
          : { kind: "resolved", outcome };
      });
    },

    async fence(key, ownerToken) {
      const row = select.get(...keyArgs(key)) as IntentRow | undefined;
      return row !== undefined && row.resolved_tx_hash === null && row.owner_token === ownerToken;
    },

    async resolve(key, ownerToken, outcome) {
      state.transaction(() => {
        const row = select.get(...keyArgs(key)) as IntentRow | undefined;
        if (row === undefined) throw new Error("cannot resolve an intent that was never claimed");
        if (row.owner_token !== ownerToken) throw new Error("only the posting intent owner token may resolve");
        const existing = toOutcome(row);
        if (existing !== undefined) {
          if (existing.taskId !== outcome.taskId || existing.txHash !== outcome.txHash) {
            throw new Error("posting intent is already resolved to a different outcome");
          }
          return;
        }
        resolveRow.run(outcome.taskId.toString(), outcome.txHash, ...keyArgs(key), ownerToken);
      });
    },

    async lookup(key): Promise<PostingIntentRecord | undefined> {
      const row = select.get(...keyArgs(key)) as IntentRow | undefined;
      if (row === undefined) return undefined;
      const outcome = toOutcome(row);
      return outcome === undefined ? toIntent(row) : { ...toIntent(row), resolved: outcome };
    },

    async scanPending() {
      return (pending.all() as IntentRow[]).map((row) => ({
        ...toIntent(row),
        ownerToken: row.owner_token as PostingOwnerToken,
      }));
    },
  };
}
