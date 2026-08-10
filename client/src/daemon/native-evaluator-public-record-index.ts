/**
 * The evaluator's signed public-record location index (#2539).
 *
 * Extracted from `native-evaluator-opportunity-source.ts` — where it was inline — for the same
 * reason `native-evaluator-association-index.ts` was extracted by #2533: the index has one
 * invariant that is worth stating, testing and defending on its own.
 *
 * **A row records "source S, at sequence N, said this content-addressed record is at this
 * location". The sequence is part of that statement's identity, not a conflict with it.**
 *
 * The table was keyed `(record_digest, location)`, and `location` is derived from the digest, so
 * the key was effectively the digest alone. The prediction Task specification is deterministic:
 * every posting of it seals to the same Task digest, so the requester's postings at sequences 1,
 * 2 and 3 all announced `sha256:5f021ff3…`. The first posting stored `source_sequence = 1`; the
 * second presented `2`, the equality check read that as the first one having been tampered with,
 * and it threw — on every tick, 1854 times in the live gate's round 8. The whole requester pass
 * aborted with it, so the evaluator's checkpoint never advanced past sequence 3 and task 1221's
 * card was never enqueued at all.
 *
 * The discriminator this module implements:
 *
 * - **a later posting re-announcing a record whose content is identical** — expected, and in fact
 *   corroboration; it gets its own row.
 * - **the same source, at the same sequence, now carrying a different signed log entry** — that
 *   is equivocation over an append-only history. Refuse, loudly.
 *
 * Nothing here weakens the second case: the `entry_digest` equality is byte-for-byte exactly as
 * before, and the `source_id` a row is pinned to still cannot change. Only the row the check runs
 * against moved, from "whatever shares this digest" to "this exact signed statement".
 */
import type { Store } from '../store/store.js';

/** The signed log statement a location row is pinned to. */
export interface NativePublicRecordProvenance {
  readonly sourceId: string;
  readonly sequence: string;
  readonly entryDigest: string;
}

/**
 * Rebuild a table created under the old `(record_digest, location)` primary key. SQLite cannot
 * alter a primary key, so this is the standard create/copy/drop/rename. It is lossless and
 * re-derives nothing: the two new key columns already exist as ordinary columns on the old table,
 * every row moves verbatim, and because the old key was a strict prefix of the new one the copy
 * cannot collide.
 */
function migrateToStatementKey(store: Store): void {
  const columns = store.db
    .prepare(`PRAGMA table_info(native_evaluator_public_records)`)
    .all() as Array<{ name: string; pk: number }>;
  if (columns.length === 0) return;
  if (columns.some(({ name, pk }) => name === 'source_sequence' && pk > 0)) return;

  store.db.exec(`
    CREATE TABLE native_evaluator_public_records_v2 (
      record_digest   TEXT NOT NULL,
      location        TEXT NOT NULL,
      source_id       TEXT NOT NULL,
      source_sequence TEXT NOT NULL,
      entry_digest    TEXT NOT NULL,
      PRIMARY KEY (record_digest, location, source_id, source_sequence)
    );
    INSERT INTO native_evaluator_public_records_v2
      (record_digest, location, source_id, source_sequence, entry_digest)
    SELECT record_digest, location, source_id, source_sequence, entry_digest
      FROM native_evaluator_public_records;
    DROP TABLE native_evaluator_public_records;
    ALTER TABLE native_evaluator_public_records_v2
      RENAME TO native_evaluator_public_records;
  `);
}

/**
 * Create the public-record location table (signed-statement keyed) and migrate any table still on
 * the old shape. `record_digest` keeps an index of its own: the only read is "every location that
 * has ever been signed for this digest", which is now a many-row answer by construction.
 */
export function installPublicRecordSchema(store: Store): void {
  migrateToStatementKey(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS native_evaluator_public_records (
      record_digest   TEXT NOT NULL,
      location        TEXT NOT NULL,
      source_id       TEXT NOT NULL,
      source_sequence TEXT NOT NULL,
      entry_digest    TEXT NOT NULL,
      PRIMARY KEY (record_digest, location, source_id, source_sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_native_evaluator_public_records_digest
      ON native_evaluator_public_records (record_digest);
  `);
}

/**
 * Index one signed statement that `digest` is retrievable at `location`.
 *
 * Refuses when THIS source, at THIS sequence, is already on record for this location under a
 * different signed log entry — a rewritten append-only history. A later sequence re-announcing the
 * same content-addressed record is not a conflict and gets its own row.
 */
export function upsertPublicRecordLocation(input: {
  readonly store: Store;
  readonly digest: `sha256:${string}`;
  readonly location: string;
  readonly provenance: NativePublicRecordProvenance;
}): void {
  const { store, digest, location, provenance } = input;
  const existing = store.db.prepare(
    `SELECT entry_digest FROM native_evaluator_public_records
      WHERE record_digest = ? AND location = ? AND source_id = ? AND source_sequence = ?`,
  ).get(digest, location, provenance.sourceId, provenance.sequence) as
    { entry_digest: string } | undefined;

  if (existing !== undefined) {
    if (existing.entry_digest !== provenance.entryDigest) {
      throw new Error(
        `public record ${digest} changed signed provenance: `
        + `${provenance.sourceId} sequence ${provenance.sequence} previously sealed `
        + `${existing.entry_digest}, now presents ${provenance.entryDigest}`,
      );
    }
    return;
  }

  store.db.prepare(
    `INSERT INTO native_evaluator_public_records
      (record_digest, location, source_id, source_sequence, entry_digest) VALUES (?, ?, ?, ?, ?)`,
  ).run(digest, location, provenance.sourceId, provenance.sequence, provenance.entryDigest);
}

/** Every distinct location any signed source has ever announced for this record, in stable order. */
export function publicRecordLocations(
  store: Store,
  digest: `sha256:${string}`,
): readonly string[] {
  return (store.db.prepare(
    `SELECT DISTINCT location FROM native_evaluator_public_records
      WHERE record_digest = ? ORDER BY location`,
  ).all(digest) as Array<{ location: string }>).map(({ location }) => location);
}
