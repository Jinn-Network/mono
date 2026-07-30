// SPDX-License-Identifier: MIT

// Durable requester-scope ownership + recorded Delivery bytes (design §7, Task 16 -- the first
// half of the projector-backed `MarketplaceObservePort`). Backed by the `submission_scopes` and
// `attempt_deliveries` tables (Task 16 schema, version 3). Matching a completed scope is by
// EXACT Submission bytes, never by field equality -- `submission_bytes` is the identity (TEP
// §12.2 idempotent resubmission). `projector-observe.ts` composes this store with the
// chain-derived `observe`/`recover`/`drive` half to produce the full port.
import { randomUUID } from "node:crypto";
import type {
  RecordSubmissionInput,
  SubmissionScopeClaim,
  SubmissionScopeOwnerToken,
  SubmissionScopeRecord,
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
}

/** The durable half of a resolved scope `projector-observe.ts` needs for `observe`/`recover`. */
export interface ResolvedSubmissionScope extends SubmissionScopeRecord {
  readonly engagementAttempt?: AttemptUri;
}

export interface SubmissionScopeStore {
  claimSubmissionScope(input: SubmissionScopeRecord & {
    readonly requester: string;
    readonly idempotencyKey: string;
  }): Promise<SubmissionScopeClaim>;
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
  };
}

export function createObserveStore(state: VenueStateDatabase): SubmissionScopeStore {
  const selectByKey = state.db.prepare(
    "SELECT * FROM submission_scopes WHERE requester = ? AND idempotency_key = ?",
  );
  const selectResolvedBySubmission = state.db.prepare(
    "SELECT * FROM submission_scopes WHERE submission_uri = ? AND resolved_at_ms IS NOT NULL",
  );
  const insertPending = state.db.prepare(
    "INSERT INTO submission_scopes (requester, idempotency_key, submission_uri, digest, submission_bytes, owner_token)"
    + " VALUES (?, ?, ?, ?, ?, ?)",
  );
  const resolveRow = state.db.prepare(
    "UPDATE submission_scopes SET resolved_at_ms = ?, resolved_task_id = ?, resolved_tx_hash = ?,"
    + " engagement_attempt = ?, dispatch_context_json = ?"
    + " WHERE requester = ? AND idempotency_key = ? AND owner_token = ? AND resolved_at_ms IS NULL",
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
