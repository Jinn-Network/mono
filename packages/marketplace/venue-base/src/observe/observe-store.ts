// SPDX-License-Identifier: MIT

// Durable requester-scope ownership + recorded Delivery bytes (design §7, Task 16 -- the first
// half of the projector-backed `MarketplaceObservePort`). Backed by the `submission_scopes` and
// `attempt_deliveries` tables (Task 16 schema, version 3). Matching a completed scope is by
// EXACT Submission bytes, never by field equality -- `submission_bytes` is the identity (TEP
// §12.2 idempotent resubmission). `projector-observe.ts` composes this store with the
// chain-derived `observe`/`recover`/`drive` half to produce the full port.
import { randomUUID } from "node:crypto";
import type {
  ClaimSubmissionScopeInput,
  PendingSubmissionScopeRecord,
  RecordSubmissionInput,
  RecoveredSubmissionScopeResolution,
  ResolveRecoveredSubmissionScopeInput,
  SubmissionScopeClaim,
  SubmissionScopeOwnerToken,
  SubmissionScopeRecord,
} from "@jinn-network/marketplace-binding";
import {
  postingCommandDigestOf,
  postingIntentKeyOf,
  type PreparedPostingCommand,
} from "@jinn-network/marketplace-binding";
import { TaskExecutionError, type AttemptUri, type DeliveryRef, type SubmissionUri } from "@jinn-network/task-execution-backend";
import { documentDigest, type SubmissionRecord } from "@jinn-network/task-execution-protocol";
import type { VenueStateDatabase } from "../state/database.js";

interface SubmissionScopeRow {
  readonly requester: string;
  readonly idempotency_key: string;
  readonly submission_uri: string;
  readonly digest: string;
  readonly submission_bytes: Buffer;
  readonly owner_token: string;
  readonly resolved_at_ms: number | null;
  readonly resolved_task_id: string | null;
  readonly resolved_tx_hash: string | null;
  readonly engagement_attempt: string | null;
  readonly dispatch_context_json: string | null;
  readonly task_digest: string | null;
  readonly creator_safe: string | null;
  readonly venue_namespace: string | null;
  readonly command_digest: string | null;
  readonly posting_intent_key: string | null;
  readonly legacy_scope_unrecoverable: 0 | 1;
}

/** The durable half of a resolved scope `projector-observe.ts` needs for `observe`/`recover`. */
export interface ResolvedSubmissionScope extends SubmissionScopeRecord {
  readonly engagementAttempt?: AttemptUri;
}

export interface SubmissionScopeStore {
  claimSubmissionScope(input: ClaimSubmissionScopeInput): Promise<SubmissionScopeClaim>;
  readSubmissionScope(requester: string, idempotencyKey: string): Promise<SubmissionScopeRecord | undefined>;
  scanPendingSubmissionScopes(): Promise<readonly (PendingSubmissionScopeRecord | (SubmissionScopeRecord & {
    readonly requester: string;
    readonly idempotencyKey: string;
    readonly legacyScopeUnrecoverable: true;
  }))[]>;
  reclaimSubmissionScope(input: ClaimSubmissionScopeInput): Promise<SubmissionScopeClaim>;
  resolveRecoveredSubmissionScope(
    input: ResolveRecoveredSubmissionScopeInput,
  ): Promise<RecoveredSubmissionScopeResolution>;
  resolveSubmissionScope(input: RecordSubmissionInput, ownerToken: SubmissionScopeOwnerToken): Promise<void>;
  /** Durable submission -> engagement lookup for the chain-derived half (`projector-observe.ts`). */
  findResolvedScope(submissionUri: SubmissionUri): ResolvedSubmissionScope | undefined;
  recordDelivery(attempt: AttemptUri, deliveryBytes: Uint8Array): Promise<void>;
  deliveries(attempt: AttemptUri): Promise<DeliveryRef[]>;
  fetchDelivery(ref: DeliveryRef): Promise<Uint8Array>;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function toRecord(row: SubmissionScopeRow): SubmissionScopeRecord {
  return {
    submissionUri: row.submission_uri as SubmissionUri,
    digest: row.digest as `sha256:${string}`,
    submissionBytes: new Uint8Array(row.submission_bytes),
    ...(row.task_digest === null ? {} : { taskDigest: row.task_digest as `sha256:${string}` }),
    ...(row.creator_safe === null ? {} : { creatorSafe: row.creator_safe as `0x${string}` }),
    ...(row.venue_namespace === null ? {} : { venueNamespace: row.venue_namespace }),
    ...(row.command_digest === null ? {} : { commandDigest: row.command_digest as `sha256:${string}` }),
    ...(row.posting_intent_key === null ? {} : { postingIntentKey: row.posting_intent_key }),
    ...(row.resolved_task_id === null || row.resolved_tx_hash === null ? {} : {
      outcome: {
        taskId: BigInt(row.resolved_task_id),
        txHash: row.resolved_tx_hash as `0x${string}`,
      },
    }),
    ...(row.legacy_scope_unrecoverable === 1 ? { legacyScopeUnrecoverable: true as const } : {}),
  };
}

export function createObserveStore(state: VenueStateDatabase): SubmissionScopeStore {
  const selectByKey = state.db.prepare(
    "SELECT * FROM submission_scopes WHERE requester = ? AND idempotency_key = ?",
  );
  const selectResolvedBySubmission = state.db.prepare(
    "SELECT * FROM submission_scopes WHERE submission_uri = ? AND resolved_at_ms IS NOT NULL",
  );
  const selectPending = state.db.prepare(
    "SELECT * FROM submission_scopes WHERE resolved_at_ms IS NULL ORDER BY requester, idempotency_key",
  );
  const insertPending = state.db.prepare(
    "INSERT INTO submission_scopes (requester, idempotency_key, submission_uri, digest, submission_bytes, owner_token,"
    + " task_digest, creator_safe, venue_namespace, command_digest, posting_intent_key, legacy_scope_unrecoverable)"
    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
  );
  const resolveRow = state.db.prepare(
    "UPDATE submission_scopes SET resolved_at_ms = ?, resolved_task_id = ?, resolved_tx_hash = ?,"
    + " engagement_attempt = ?, dispatch_context_json = ?"
    + " WHERE requester = ? AND idempotency_key = ? AND owner_token = ? AND resolved_at_ms IS NULL",
  );
  const reclaimRow = state.db.prepare(
    "UPDATE submission_scopes SET owner_token = ?"
    + " WHERE requester = ? AND idempotency_key = ? AND digest = ? AND task_digest = ?"
    + " AND lower(creator_safe) = lower(?) AND venue_namespace = ? AND command_digest = ? AND posting_intent_key = ?"
    + " AND resolved_at_ms IS NULL AND legacy_scope_unrecoverable = 0",
  );
  const resolveRecoveredRow = state.db.prepare(
    "UPDATE submission_scopes SET resolved_at_ms = ?, resolved_task_id = ?, resolved_tx_hash = ?"
    + " WHERE requester = ? AND idempotency_key = ? AND digest = ? AND task_digest = ?"
    + " AND lower(creator_safe) = lower(?) AND venue_namespace = ? AND command_digest = ? AND posting_intent_key = ?"
    + " AND resolved_at_ms IS NULL AND legacy_scope_unrecoverable = 0",
  );
  const selectPostingIntent = state.db.prepare(
    "SELECT resolved_task_id, resolved_tx_hash, venue_namespace, command_digest, command_json, legacy_unrecoverable"
    + " FROM posting_intents WHERE lower(creator_safe) = lower(?) AND task_cid_digest = ? AND submission_digest = ?",
  );
  const insertDelivery = state.db.prepare(
    "INSERT INTO attempt_deliveries (attempt, digest, delivery_bytes, recorded_at_ms) VALUES (?, ?, ?, ?)"
    + " ON CONFLICT (attempt, digest) DO NOTHING",
  );
  const selectDeliveries = state.db.prepare(
    "SELECT digest FROM attempt_deliveries WHERE attempt = ? ORDER BY recorded_at_ms",
  );
  const selectDeliveryBytes = state.db.prepare(
    "SELECT delivery_bytes FROM attempt_deliveries WHERE attempt = ? AND digest = ?",
  );

  return {
    async claimSubmissionScope(input) {
      const row = selectByKey.get(input.requester, input.idempotencyKey) as SubmissionScopeRow | undefined;
      if (row === undefined) {
        const ownerToken = `submission-scope-owner:${randomUUID()}` as SubmissionScopeOwnerToken;
        insertPending.run(
          input.requester,
          input.idempotencyKey,
          input.submissionUri,
          input.digest,
          Buffer.from(input.submissionBytes),
          ownerToken,
          input.taskDigest,
          input.creatorSafe.toLowerCase(),
          input.venueNamespace,
          input.commandDigest,
          input.postingIntentKey,
        );
        return { kind: "owner", ownerToken };
      }
      if (!bytesEqual(new Uint8Array(row.submission_bytes), input.submissionBytes)) {
        return { kind: "conflict" };
      }
      return row.resolved_at_ms === null
        ? { kind: "pending" }
        : { kind: "resolved", record: toRecord(row) };
    },

    async readSubmissionScope(requester, idempotencyKey) {
      const row = selectByKey.get(requester, idempotencyKey) as SubmissionScopeRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },

    async scanPendingSubmissionScopes() {
      return (selectPending.all() as SubmissionScopeRow[]).map((row) => {
        const record = toRecord(row);
        if (
          row.legacy_scope_unrecoverable === 1
          || record.taskDigest === undefined
          || record.creatorSafe === undefined
          || record.venueNamespace === undefined
          || record.commandDigest === undefined
          || record.postingIntentKey === undefined
        ) {
          return {
            ...record,
            requester: row.requester,
            idempotencyKey: row.idempotency_key,
            legacyScopeUnrecoverable: true as const,
          };
        }
        return {
          ...record,
          requester: row.requester,
          idempotencyKey: row.idempotency_key,
          taskDigest: record.taskDigest,
          creatorSafe: record.creatorSafe,
          venueNamespace: record.venueNamespace,
          commandDigest: record.commandDigest,
          postingIntentKey: record.postingIntentKey,
        };
      });
    },

    async reclaimSubmissionScope(input) {
      return state.transaction((): SubmissionScopeClaim => {
        const row = selectByKey.get(input.requester, input.idempotencyKey) as SubmissionScopeRow | undefined;
        if (row === undefined || !bytesEqual(new Uint8Array(row.submission_bytes), input.submissionBytes)) {
          return { kind: "conflict" };
        }
        if (row.resolved_at_ms !== null) return { kind: "resolved", record: toRecord(row) };
        if (row.legacy_scope_unrecoverable === 1) return { kind: "pending" };
        const ownerToken = `submission-scope-owner:${randomUUID()}` as SubmissionScopeOwnerToken;
        const changed = reclaimRow.run(
          ownerToken,
          input.requester,
          input.idempotencyKey,
          input.digest,
          input.taskDigest,
          input.creatorSafe,
          input.venueNamespace,
          input.commandDigest,
          input.postingIntentKey,
        );
        return changed.changes === 1 ? { kind: "owner", ownerToken } : { kind: "conflict" };
      });
    },

    async resolveRecoveredSubmissionScope(input) {
      return state.transaction((): RecoveredSubmissionScopeResolution => {
        const row = selectByKey.get(input.requester, input.idempotencyKey) as SubmissionScopeRow | undefined;
        if (row === undefined || !bytesEqual(new Uint8Array(row.submission_bytes), input.submissionBytes)) {
          return "conflict";
        }
        if (
          row.task_digest !== input.taskDigest
          || row.creator_safe?.toLowerCase() !== input.creatorSafe.toLowerCase()
          || row.venue_namespace !== input.venueNamespace
          || row.command_digest !== input.commandDigest
          || row.posting_intent_key !== input.postingIntentKey
        ) return "conflict";
        if (row.resolved_at_ms !== null) return "already-resolved";
        if (row.legacy_scope_unrecoverable === 1) return "legacy-scope-unrecoverable";
        const expectedKey = postingIntentKeyOf({
          creatorSafe: input.creatorSafe,
          taskCidDigest: input.taskDigest,
          submissionDigest: input.digest,
          venueNamespace: input.venueNamespace,
          commandDigest: input.commandDigest,
        });
        if (expectedKey !== input.postingIntentKey) return "conflict";
        const wal = selectPostingIntent.get(
          input.creatorSafe,
          input.taskDigest,
          input.digest,
        ) as {
          resolved_task_id: string | null;
          resolved_tx_hash: string | null;
          venue_namespace: string | null;
          command_digest: string | null;
          command_json: string | null;
          legacy_unrecoverable: 0 | 1;
        } | undefined;
        if (wal === undefined) return "no-intent";
        if (
          wal.legacy_unrecoverable === 1
          || wal.venue_namespace !== input.venueNamespace
          || wal.command_digest !== input.commandDigest
          || wal.command_json === null
        ) return "conflict";
        let command: PreparedPostingCommand;
        try {
          command = JSON.parse(wal.command_json) as PreparedPostingCommand;
        } catch {
          return "conflict";
        }
        const { commandDigest, ...unsignedCommand } = command;
        if (
          typeof commandDigest !== "string"
          || typeof command.venueNamespace !== "string"
          || typeof command.creatorSafe !== "string"
          || typeof command.taskCidDigest !== "string"
          || typeof command.submissionDigest !== "string"
          || commandDigest !== input.commandDigest
          || postingCommandDigestOf(unsignedCommand) !== input.commandDigest
          || command.venueNamespace !== input.venueNamespace
          || command.creatorSafe.toLowerCase() !== input.creatorSafe.toLowerCase()
          || command.taskCidDigest !== input.taskDigest
          || command.submissionDigest !== input.digest
        ) return "conflict";
        if (wal.resolved_task_id === null || wal.resolved_tx_hash === null) return "pending-intent";
        const changed = resolveRecoveredRow.run(
          Date.now(),
          wal.resolved_task_id,
          wal.resolved_tx_hash,
          input.requester,
          input.idempotencyKey,
          input.digest,
          input.taskDigest,
          input.creatorSafe,
          input.venueNamespace,
          input.commandDigest,
          input.postingIntentKey,
        );
        return changed.changes === 1 ? "resolved" : "conflict";
      });
    },

    async resolveSubmissionScope(input, ownerToken) {
      const submission = input.submission as Pick<SubmissionRecord, "requester" | "idempotencyKey">;
      const row = selectByKey.get(submission.requester, submission.idempotencyKey) as SubmissionScopeRow | undefined;
      if (row === undefined || row.resolved_at_ms !== null || row.owner_token !== ownerToken) {
        throw new Error("only the claimed requester-scope owner may resolve a Submission");
      }
      if (!bytesEqual(new Uint8Array(row.submission_bytes), input.submissionBytes) || row.digest !== input.submissionDigest) {
        throw new Error("requester-scope completion does not match its claimed exact Submission");
      }
      const dispatchContext = input.engagement?.dispatchContext;
      const changes = resolveRow.run(
        Date.now(),
        input.outcome.taskId.toString(),
        input.outcome.txHash,
        input.engagement?.attemptUri ?? null,
        dispatchContext === undefined ? null : JSON.stringify(dispatchContext),
        submission.requester,
        submission.idempotencyKey,
        ownerToken,
      );
      if (changes.changes !== 1) {
        throw new Error("submission scope is already resolved");
      }
    },

    findResolvedScope(submissionUri) {
      const row = selectResolvedBySubmission.get(submissionUri) as SubmissionScopeRow | undefined;
      if (row === undefined) return undefined;
      return {
        ...toRecord(row),
        ...(row.engagement_attempt === null ? {} : { engagementAttempt: row.engagement_attempt as AttemptUri }),
      };
    },

    async recordDelivery(attempt, deliveryBytes) {
      const digest = documentDigest(deliveryBytes);
      insertDelivery.run(attempt, digest, Buffer.from(deliveryBytes), Date.now());
    },

    async deliveries(attempt) {
      const rows = selectDeliveries.all(attempt) as { digest: string }[];
      return rows.map((row) => ({ attempt, digest: row.digest as `sha256:${string}` }));
    },

    async fetchDelivery(ref) {
      const row = selectDeliveryBytes.get(ref.attempt, ref.digest) as { delivery_bytes: Buffer } | undefined;
      if (row === undefined) {
        throw new TaskExecutionError("result-unavailable", {
          detail: `no Delivery "${ref.digest}" recorded for Attempt "${ref.attempt}"`,
        });
      }
      return new Uint8Array(row.delivery_bytes);
    },
  };
}
