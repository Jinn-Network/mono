/**
 * The evaluator's signed requester-association index (#2533).
 *
 * Extracted from `native-evaluator-opportunity-source.ts`, where it was inline, because the index
 * has one subtle invariant that is worth stating and testing on its own: **an association is
 * identified by its posting, not by its Task digest.**
 *
 * The prediction Task specification is deterministic, so every posting of it seals to the same
 * Task digest. On the live two-operator gate, tasks 1218, 1219 and 1220 all carried
 * `sha256:5f021ff3…` while their signed facts legitimately differed — different taskId, runId,
 * deadline and Submission. Keyed on the Task digest, the second posting was indistinguishable
 * from the first one having been tampered with, so the index refused it, and because the refusal
 * escaped the whole sync pass the evaluator's solver source never synced either: 802 consecutive
 * aborted ticks with the table pinned to task 1218.
 *
 * The discriminator this module implements:
 *
 * - **different posting that happens to share a spec digest** — expected; index it separately.
 * - **same posting, signed facts or signed provenance changed underneath us** — refuse, loudly.
 *
 * Nothing here weakens the second case. The equality check is byte-for-byte over the canonical
 * encoding plus the full provenance triple, exactly as before; only the row it is checked against
 * changed, from "whatever shares this Task digest" to "this exact posting".
 */
import type { Store } from '../store/store.js';
import type { NativeAuthorityTimeAnchor } from '../native-requester/requester.js';
import { canonicalAddress } from './native-evm-address.js';

/**
 * What actually identifies a requester association: the on-chain posting. Every field is proved
 * by `canonicalTaskCreated` before an association reaches this index.
 */
export interface NativePostingIdentity {
  readonly chainId: number;
  readonly coordinator: string;
  readonly taskId: bigint;
}

export interface IndexedNativeRequesterAssociation {
  readonly taskDigest: `sha256:${string}`;
  readonly submissionDigest: `sha256:${string}`;
  readonly requesterEnvelopeDigest: `sha256:${string}`;
  readonly admissionReceiptDigest: `sha256:${string}`;
  readonly sealedAt: string;
  readonly authorityTime: NativeAuthorityTimeAnchor;
  readonly requesterAgent: string;
  readonly chainId: 84532;
  readonly coordinator: `0x${string}`;
  readonly taskId: bigint;
  readonly responseTimeoutSeconds: bigint;
}

/** The signed provenance an indexed association is pinned to. */
export interface NativeAssociationProvenance {
  readonly sourceId: string;
  readonly sequence: string;
  readonly entryDigest: string;
}

/**
 * The posting identity as its exact three SQL bind parameters, in primary-key order.
 *
 * The coordinator is lowercase-canonicalized (#26). The requester signs its association with a
 * checksummed coordinator, while `native_evaluations.coordinator` — the value `deadline()` looks a
 * posting up by — is written lowercase. Keying the write and the read through the same
 * `canonicalAddress` makes both sides agree on the lowercase form, so a checksummed-signed
 * association still resolves under a lowercase lookup (and vice versa).
 */
function postingKey(posting: NativePostingIdentity): [string, string, string] {
  return [posting.chainId.toString(10), canonicalAddress(posting.coordinator), posting.taskId.toString(10)];
}

/** The canonical stored encoding. `bigint` has no JSON form, so both are decimal strings. */
export function encodeAssociation(association: IndexedNativeRequesterAssociation): string {
  return JSON.stringify({
    ...association,
    taskId: association.taskId.toString(10),
    responseTimeoutSeconds: association.responseTimeoutSeconds.toString(10),
  });
}

function decodeAssociation(associationJson: string): IndexedNativeRequesterAssociation {
  const value = JSON.parse(associationJson) as Omit<IndexedNativeRequesterAssociation, 'taskId' | 'responseTimeoutSeconds'> & {
    readonly taskId: string;
    readonly responseTimeoutSeconds: string;
  };
  return {
    ...value,
    taskId: BigInt(value.taskId),
    responseTimeoutSeconds: BigInt(value.responseTimeoutSeconds),
  };
}

/**
 * Rebuild a table created under the old `task_digest PRIMARY KEY` shape. SQLite cannot alter a
 * primary key, so this is the standard create/copy/drop/rename. It is lossless and re-derives
 * nothing: the posting-identity columns already live inside each stored `association_json`, and
 * the rows move verbatim with the provenance triple that pins them intact. An old table could
 * only ever hold one row per Task digest, so the copy cannot collide on the new key.
 */
function migrateToPostingKey(store: Store): void {
  const columns = store.db
    .prepare(`PRAGMA table_info(native_evaluator_requester_associations)`)
    .all() as Array<{ name: string }>;
  if (columns.length === 0 || columns.some(({ name }) => name === 'task_id')) return;

  store.db.exec(`
    CREATE TABLE native_evaluator_requester_associations_v2 (
      chain_id TEXT NOT NULL,
      coordinator TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_digest TEXT NOT NULL,
      association_json TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_sequence TEXT NOT NULL,
      entry_digest TEXT NOT NULL,
      PRIMARY KEY (chain_id, coordinator, task_id)
    );
    INSERT INTO native_evaluator_requester_associations_v2
      (chain_id, coordinator, task_id, task_digest, association_json, source_id, source_sequence, entry_digest)
    SELECT
      CAST(json_extract(association_json, '$.chainId') AS TEXT),
      json_extract(association_json, '$.coordinator'),
      json_extract(association_json, '$.taskId'),
      task_digest, association_json, source_id, source_sequence, entry_digest
    FROM native_evaluator_requester_associations;
    DROP TABLE native_evaluator_requester_associations;
    ALTER TABLE native_evaluator_requester_associations_v2
      RENAME TO native_evaluator_requester_associations;
  `);
}

/**
 * One-time, idempotent re-key of stored coordinator keys to lowercase (#26). Rows written before
 * the `postingKey` canonicalization stored the coordinator column checksummed (verbatim from the
 * signed association), so a lowercase lookup misses them. The signed source resumes from a durable
 * cursor on reboot and does not replay already-committed associations, so an existing row is
 * persisted-once and never self-heals — it must be re-keyed here. `lower()` over ASCII hex is
 * exact; the guard makes an already-lowercase table a no-op, and one row per posting means the
 * update cannot collide on the primary key.
 */
function canonicalizeStoredCoordinatorKeys(store: Store): void {
  store.db.exec(`
    UPDATE native_evaluator_requester_associations
       SET coordinator = lower(coordinator)
     WHERE coordinator <> lower(coordinator);
  `);
}

/**
 * Create the association table (posting-keyed) and migrate any table still on the old shape.
 * `task_digest` stays as an indexed lookup column, because the solver-side read only ever learns
 * a Delivery's Task digest and disambiguates the candidates by attempt URI.
 */
export function installAssociationSchema(store: Store): void {
  migrateToPostingKey(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS native_evaluator_requester_associations (
      chain_id TEXT NOT NULL,
      coordinator TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_digest TEXT NOT NULL,
      association_json TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_sequence TEXT NOT NULL,
      entry_digest TEXT NOT NULL,
      PRIMARY KEY (chain_id, coordinator, task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_native_evaluator_associations_task_digest
      ON native_evaluator_requester_associations (task_digest);
  `);
  canonicalizeStoredCoordinatorKeys(store);
}

/**
 * Index one signed requester association, keyed by its posting.
 *
 * Refuses when THIS posting is already indexed with different signed facts or different signed
 * provenance. A different posting sharing a Task digest is not a conflict and gets its own row.
 */
export function upsertRequesterAssociation(input: {
  readonly store: Store;
  readonly association: IndexedNativeRequesterAssociation;
  readonly provenance: NativeAssociationProvenance;
}): void {
  const { store, provenance } = input;
  // Store the coordinator lowercase-canonical in BOTH the key and the encoded body (#26), so the
  // stored bytes are stable regardless of the casing the signed facts arrived in and the
  // idempotency equality is not tripped by a checksum-vs-lowercase difference alone.
  const association: IndexedNativeRequesterAssociation = {
    ...input.association,
    coordinator: canonicalAddress(input.association.coordinator) as `0x${string}`,
  };
  const encoded = encodeAssociation(association);
  const key = postingKey(association);
  const existing = store.db.prepare(
    `SELECT association_json, source_id, source_sequence, entry_digest
       FROM native_evaluator_requester_associations
      WHERE chain_id = ? AND coordinator = ? AND task_id = ?`,
  ).get(...key) as {
    association_json: string;
    source_id: string;
    source_sequence: string;
    entry_digest: string;
  } | undefined;

  if (existing !== undefined) {
    if (existing.association_json !== encoded
      || existing.source_id !== provenance.sourceId
      || existing.source_sequence !== provenance.sequence
      || existing.entry_digest !== provenance.entryDigest) {
      throw new Error(
        `requester association for task ${association.taskId} on ${association.coordinator} `
        + `(Task digest ${association.taskDigest}) changed signed facts`,
      );
    }
    return;
  }

  store.db.prepare(
    `INSERT INTO native_evaluator_requester_associations
      (chain_id, coordinator, task_id, task_digest, association_json, source_id, source_sequence, entry_digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...key,
    association.taskDigest,
    encoded,
    provenance.sourceId,
    provenance.sequence,
    provenance.entryDigest,
  );
}

/** The exact, unambiguous read: one posting, one association. */
export function associationForPosting(
  store: Store,
  posting: NativePostingIdentity,
): IndexedNativeRequesterAssociation | undefined {
  const row = store.db.prepare(
    `SELECT association_json FROM native_evaluator_requester_associations
      WHERE chain_id = ? AND coordinator = ? AND task_id = ?`,
  ).get(...postingKey(posting)) as { association_json: string } | undefined;
  return row === undefined ? undefined : decodeAssociation(row.association_json);
}

/**
 * Every posting that sealed this Task digest, by ascending task id. A deterministic specification
 * yields one row per posting here, so a caller holding only a Task digest MUST disambiguate —
 * the solver-side read does it by attempt URI, which is derived from the posting identity and so
 * matches exactly one candidate.
 */
export function associationsForTaskDigest(
  store: Store,
  taskDigest: `sha256:${string}`,
): readonly IndexedNativeRequesterAssociation[] {
  return (store.db.prepare(
    `SELECT association_json FROM native_evaluator_requester_associations
      WHERE task_digest = ? ORDER BY CAST(task_id AS INTEGER)`,
  ).all(taskDigest) as Array<{ association_json: string }>)
    .map(({ association_json: json }) => decodeAssociation(json));
}
