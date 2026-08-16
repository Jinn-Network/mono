/**
 * #2539. The evaluator's public-record location index keyed on `(record_digest, location)`, and
 * `location` is derived from the digest, so the key was the digest alone. The prediction Task
 * specification is deterministic: the requester's postings at sequences 1, 2 and 3 (live tasks
 * 1218/1219/1220) all announced `sha256:5f021ff3…`. Row one stored `source_sequence = 1`; posting
 * two presented `2`, the equality check read that as tampering, and it threw — every tick, 1854
 * times in round 8. The requester pass went down with it, so the source checkpoint never advanced
 * past sequence 3 and task 1221's card was never enqueued.
 *
 * The two things that must BOTH hold, and that the old key could not separate:
 *   - a later signed statement re-announcing an identical content-addressed record is indexed, not
 *     refused;
 *   - the same source, at the same sequence, presenting a different log entry still refuses.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import {
  installPublicRecordSchema,
  publicRecordLocations,
  upsertPublicRecordLocation,
} from '../../src/daemon/native-evaluator-public-record-index.js';

// The deterministic prediction specification: every posting of it seals to this one digest.
const SHARED_TASK_DIGEST = `sha256:${'5f021ff3'.repeat(8)}` as const;
const SOURCE = 'did:jinn:requester-a/postings';
const location = (digest: string) => `https://requester-a.example/records/${digest.slice(7)}`;
const provenanceAt = (sequence: string) => ({
  sourceId: SOURCE,
  sequence,
  entryDigest: `sha256:${sequence.padStart(64, '0')}`,
});

describe('native evaluator public-record index', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-public-records-'));
    store = new Store(join(dir, 'evaluator.db'));
    installPublicRecordSchema(store);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // The live case, and the one no test exercised: THREE postings of one deterministic profile.
  // Before the fix, posting 2 threw "changed signed provenance" and posting 3 was never reached.
  it('indexes successive postings of one deterministic specification cleanly', () => {
    for (const sequence of ['1', '2', '3']) {
      expect(() => upsertPublicRecordLocation({
        store,
        digest: SHARED_TASK_DIGEST,
        location: location(SHARED_TASK_DIGEST),
        provenance: provenanceAt(sequence),
      })).not.toThrow();
    }

    // One location, corroborated three times — the fetcher asks for locations, not statements.
    expect(publicRecordLocations(store, SHARED_TASK_DIGEST))
      .toStrictEqual([location(SHARED_TASK_DIGEST)]);
    expect((store.db.prepare(
      `SELECT count(*) AS n FROM native_evaluator_public_records WHERE record_digest = ?`,
    ).get(SHARED_TASK_DIGEST) as { n: number }).n).toBe(3);
  });

  it('replaying the identical signed statement is a no-op, not a conflict', () => {
    const write = () => upsertPublicRecordLocation({
      store,
      digest: SHARED_TASK_DIGEST,
      location: location(SHARED_TASK_DIGEST),
      provenance: provenanceAt('7'),
    });
    write();
    expect(write).not.toThrow();
    expect((store.db.prepare(
      `SELECT count(*) AS n FROM native_evaluator_public_records`,
    ).get() as { n: number }).n).toBe(1);
  });

  /**
   * THE GUARD. Delete the `entry_digest` comparison in `upsertPublicRecordLocation` and this test
   * goes red — that is the whole point of it. Same source, same sequence, different signed log
   * entry is a rewritten append-only history, and it must refuse rather than accumulate a second
   * row or silently overwrite the first.
   */
  it('refuses a tampered statement: same source and sequence, different signed entry', () => {
    upsertPublicRecordLocation({
      store,
      digest: SHARED_TASK_DIGEST,
      location: location(SHARED_TASK_DIGEST),
      provenance: provenanceAt('1'),
    });

    expect(() => upsertPublicRecordLocation({
      store,
      digest: SHARED_TASK_DIGEST,
      location: location(SHARED_TASK_DIGEST),
      provenance: { ...provenanceAt('1'), entryDigest: `sha256:${'f'.repeat(64)}` },
    })).toThrow(/changed signed provenance/u);

    // And the refusal left the verified row exactly as it was.
    expect((store.db.prepare(
      `SELECT entry_digest FROM native_evaluator_public_records`,
    ).all() as Array<{ entry_digest: string }>).map(({ entry_digest: e }) => e))
      .toStrictEqual([provenanceAt('1').entryDigest]);
  });

  it('keeps distinct locations for one record distinct', () => {
    for (const base of ['https://a.example', 'https://b.example']) {
      upsertPublicRecordLocation({
        store,
        digest: SHARED_TASK_DIGEST,
        location: `${base}/records/x`,
        provenance: provenanceAt('1'),
      });
    }
    expect(publicRecordLocations(store, SHARED_TASK_DIGEST))
      .toStrictEqual(['https://a.example/records/x', 'https://b.example/records/x']);
  });

  /**
   * A database written by the pre-fix daemon. The migration must carry its rows over verbatim —
   * they were verified in under the same rules — and the second posting that used to refuse must
   * index straight away, without the operator deleting anything.
   */
  it('migrates a database written under the old digest-keyed shape', () => {
    store.db.exec(`DROP TABLE native_evaluator_public_records`);
    store.db.exec(`
      CREATE TABLE native_evaluator_public_records (
        record_digest TEXT NOT NULL,
        location      TEXT NOT NULL,
        source_id     TEXT NOT NULL,
        source_sequence TEXT NOT NULL,
        entry_digest  TEXT NOT NULL,
        PRIMARY KEY (record_digest, location)
      );
    `);
    store.db.prepare(
      `INSERT INTO native_evaluator_public_records
        (record_digest, location, source_id, source_sequence, entry_digest) VALUES (?, ?, ?, ?, ?)`,
    ).run(SHARED_TASK_DIGEST, location(SHARED_TASK_DIGEST), SOURCE, '1', provenanceAt('1').entryDigest);

    installPublicRecordSchema(store);

    expect(publicRecordLocations(store, SHARED_TASK_DIGEST))
      .toStrictEqual([location(SHARED_TASK_DIGEST)]);
    expect(() => upsertPublicRecordLocation({
      store,
      digest: SHARED_TASK_DIGEST,
      location: location(SHARED_TASK_DIGEST),
      provenance: provenanceAt('2'),
    })).not.toThrow();
    // The tamper guard survives the migration intact.
    expect(() => upsertPublicRecordLocation({
      store,
      digest: SHARED_TASK_DIGEST,
      location: location(SHARED_TASK_DIGEST),
      provenance: { ...provenanceAt('1'), entryDigest: `sha256:${'e'.repeat(64)}` },
    })).toThrow(/changed signed provenance/u);
  });

  it('is idempotent across repeated installs', () => {
    upsertPublicRecordLocation({
      store,
      digest: SHARED_TASK_DIGEST,
      location: location(SHARED_TASK_DIGEST),
      provenance: provenanceAt('1'),
    });
    installPublicRecordSchema(store);
    installPublicRecordSchema(store);
    expect(publicRecordLocations(store, SHARED_TASK_DIGEST))
      .toStrictEqual([location(SHARED_TASK_DIGEST)]);
  });
});
