/**
 * #2533. The evaluator's requester-association index keyed on `task_digest` alone, but an
 * association is per-posting. The prediction Task specification is deterministic, so live tasks
 * 1218, 1219 and 1220 all sealed to `sha256:5f021ff3…` with legitimately different signed facts;
 * the second posting read as the first one tampered with, and the refusal aborted the whole sync
 * pass — 802 consecutive aborted ticks with the table pinned to 1218.
 *
 * The two things that must BOTH hold, and that the old key could not separate:
 *   - a different posting sharing a spec digest is indexed separately (no collision);
 *   - the same posting with changed signed facts still refuses, loudly.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import {
  associationForPosting,
  associationsForTaskDigest,
  encodeAssociation,
  installAssociationSchema,
  upsertRequesterAssociation,
  type IndexedNativeRequesterAssociation,
} from '../../src/daemon/native-evaluator-association-index.js';

const COORDINATOR = '0x1234567890123456789012345678901234567890' as const;
// The deterministic prediction specification: every posting of it seals to this one digest.
const SHARED_TASK_DIGEST = `sha256:${'5f021ff3'.repeat(8)}` as const;

function association(
  overrides: Partial<IndexedNativeRequesterAssociation> = {},
): IndexedNativeRequesterAssociation {
  return {
    taskDigest: SHARED_TASK_DIGEST,
    submissionDigest: `sha256:${'a'.repeat(64)}`,
    requesterEnvelopeDigest: `sha256:${'b'.repeat(64)}`,
    admissionReceiptDigest: `sha256:${'c'.repeat(64)}`,
    sealedAt: '2026-08-07T00:00:00.000Z',
    authorityTime: {
      chainId: 84532,
      blockNumber: '45192125',
      blockHash: `0x${'d'.repeat(64)}`,
      timestamp: '2026-08-07T00:00:00.000Z',
      finalized: true,
    },
    requesterAgent: 'did:jinn:requester-a',
    chainId: 84532,
    coordinator: COORDINATOR,
    taskId: 1218n,
    responseTimeoutSeconds: 3_600n,
    ...overrides,
  };
}

const provenanceAt = (sequence: string) => ({
  sourceId: 'did:jinn:requester-a/postings',
  sequence,
  entryDigest: `sha256:${sequence.padStart(64, '0')}`,
});

describe('native evaluator requester-association index', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-assoc-'));
    store = new Store(join(dir, 'evaluator.db'));
    installAssociationSchema(store);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // The live case. Before the fix this threw "changed signed facts" on the second posting.
  it('gives each posting of one deterministic specification its own row', () => {
    const postings = [
      association({ taskId: 1218n, submissionDigest: `sha256:${'1'.repeat(64)}`, responseTimeoutSeconds: 3_600n }),
      association({ taskId: 1219n, submissionDigest: `sha256:${'2'.repeat(64)}`, responseTimeoutSeconds: 1_800n }),
      association({ taskId: 1220n, submissionDigest: `sha256:${'3'.repeat(64)}`, responseTimeoutSeconds: 900n }),
    ];

    postings.forEach((value, index) => {
      expect(() => upsertRequesterAssociation({
        store,
        association: value,
        provenance: provenanceAt(String(index + 1)),
      })).not.toThrow();
    });

    // All three share one Task digest, and all three are indexed.
    expect(new Set(postings.map(({ taskDigest }) => taskDigest)).size).toBe(1);
    expect(associationsForTaskDigest(store, SHARED_TASK_DIGEST).map(({ taskId }) => taskId))
      .toStrictEqual([1218n, 1219n, 1220n]);

    // And each posting reads back its OWN facts — no row overwrote another.
    for (const value of postings) {
      const found = associationForPosting(store, value);
      expect(found?.submissionDigest).toBe(value.submissionDigest);
      expect(found?.responseTimeoutSeconds).toBe(value.responseTimeoutSeconds);
    }
  });

  it('is idempotent: re-indexing the identical posting is not a conflict', () => {
    const value = association();
    upsertRequesterAssociation({ store, association: value, provenance: provenanceAt('1') });

    expect(() => upsertRequesterAssociation({ store, association: value, provenance: provenanceAt('1') }))
      .not.toThrow();
    expect(associationsForTaskDigest(store, SHARED_TASK_DIGEST)).toHaveLength(1);
  });

  // The guard that must survive the re-key. Each case is the SAME posting — same chainId,
  // coordinator and taskId — with something underneath it changed.
  describe('refuses a tampered association on the same posting', () => {
    const tampers: ReadonlyArray<readonly [string, Partial<IndexedNativeRequesterAssociation>]> = [
      ['a different Submission digest', { submissionDigest: `sha256:${'9'.repeat(64)}` }],
      ['a different requester envelope digest', { requesterEnvelopeDigest: `sha256:${'9'.repeat(64)}` }],
      ['a different admission receipt digest', { admissionReceiptDigest: `sha256:${'9'.repeat(64)}` }],
      ['a different Task digest', { taskDigest: `sha256:${'9'.repeat(64)}` }],
      ['a different response timeout', { responseTimeoutSeconds: 7_200n }],
      ['a different requester agent', { requesterAgent: 'did:jinn:impostor' }],
      ['a different sealing time', { sealedAt: '2026-08-07T12:00:00.000Z' }],
    ];

    it.each(tampers)('refuses %s', (_label, overrides) => {
      upsertRequesterAssociation({ store, association: association(), provenance: provenanceAt('1') });

      expect(() => upsertRequesterAssociation({
        store,
        association: association(overrides),
        provenance: provenanceAt('1'),
      })).toThrow(/changed signed facts/u);
    });

    it.each([
      ['a different source', { sourceId: 'did:jinn:impostor/postings' }],
      ['a replayed sequence', { sequence: '99' }],
      ['a different entry digest', { entryDigest: `sha256:${'9'.repeat(64)}` }],
    ] as const)('refuses %s in the signed provenance', (_label, overrides) => {
      upsertRequesterAssociation({ store, association: association(), provenance: provenanceAt('1') });

      expect(() => upsertRequesterAssociation({
        store,
        association: association(),
        provenance: { ...provenanceAt('1'), ...overrides },
      })).toThrow(/changed signed facts/u);
    });

    it('names the posting, not just the Task digest, so the refusal is actionable', () => {
      upsertRequesterAssociation({ store, association: association(), provenance: provenanceAt('1') });

      expect(() => upsertRequesterAssociation({
        store,
        association: association({ responseTimeoutSeconds: 7_200n }),
        provenance: provenanceAt('1'),
      })).toThrow(new RegExp(`task 1218 on ${COORDINATOR}`, 'u'));
    });

    it('leaves the stored row untouched when it refuses', () => {
      const original = association();
      upsertRequesterAssociation({ store, association: original, provenance: provenanceAt('1') });

      expect(() => upsertRequesterAssociation({
        store,
        association: association({ submissionDigest: `sha256:${'9'.repeat(64)}` }),
        provenance: provenanceAt('1'),
      })).toThrow();
      expect(associationForPosting(store, original)?.submissionDigest).toBe(original.submissionDigest);
    });
  });

  it('reads nothing for a posting it has never indexed', () => {
    upsertRequesterAssociation({ store, association: association(), provenance: provenanceAt('1') });

    expect(associationForPosting(store, { chainId: 84532, coordinator: COORDINATOR, taskId: 9999n }))
      .toBeUndefined();
    // A different coordinator is a different posting even at the same task id.
    expect(associationForPosting(store, {
      chainId: 84532,
      coordinator: '0x0000000000000000000000000000000000000001',
      taskId: 1218n,
    })).toBeUndefined();
  });

  it('round-trips bigint fields through the stored encoding', () => {
    const value = association({ taskId: 2n ** 63n, responseTimeoutSeconds: 2n ** 40n });
    upsertRequesterAssociation({ store, association: value, provenance: provenanceAt('1') });

    const found = associationForPosting(store, value);
    expect(found?.taskId).toBe(2n ** 63n);
    expect(found?.responseTimeoutSeconds).toBe(2n ** 40n);
  });

  // The upgrade path for an operator DB written under the old shape.
  it('migrates a task_digest-keyed table without re-deriving any signed fact', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'jinn-assoc-legacy-'));
    const legacy = new Store(join(legacyDir, 'legacy.db'));
    try {
      legacy.db.exec(`
        CREATE TABLE native_evaluator_requester_associations (
          task_digest TEXT PRIMARY KEY,
          association_json TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_sequence TEXT NOT NULL,
          entry_digest TEXT NOT NULL
        );
      `);
      const existing = association();
      legacy.db.prepare(
        `INSERT INTO native_evaluator_requester_associations
          (task_digest, association_json, source_id, source_sequence, entry_digest)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(existing.taskDigest, encodeAssociation(existing), 'did:jinn:requester-a/postings', '1', 'sha256:seed');

      installAssociationSchema(legacy);

      // The row survives, keyed by its posting, byte-identical.
      expect(associationForPosting(legacy, existing)).toStrictEqual(existing);
      // And the next posting of the same specification now indexes alongside it.
      expect(() => upsertRequesterAssociation({
        store: legacy,
        association: association({ taskId: 1219n, submissionDigest: `sha256:${'7'.repeat(64)}` }),
        provenance: provenanceAt('2'),
      })).not.toThrow();
      expect(associationsForTaskDigest(legacy, SHARED_TASK_DIGEST)).toHaveLength(2);
    } finally {
      legacy.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it('is idempotent across repeated schema installs', () => {
    upsertRequesterAssociation({ store, association: association(), provenance: provenanceAt('1') });
    installAssociationSchema(store);
    installAssociationSchema(store);

    expect(associationsForTaskDigest(store, SHARED_TASK_DIGEST)).toHaveLength(1);
  });

  // #26 — the CP6 verdict blocker proved live on the two-operator gate (round 14, task 1223).
  // The requester's signed association carries a CHECKSUMMED coordinator, so the index stored the
  // row keyed checksummed; but `native_evaluations.coordinator` is written lowercase-canonical, so
  // `deadline(evaluation)` looked the association up with a LOWERCASE coordinator. SQLite's
  // `WHERE coordinator = ?` is case-sensitive, so the lookup missed and the evaluator logged
  // "no signed requester deadline authority for task 1223" 130x, never emitting a verdict.
  describe('resolves a posting regardless of coordinator address case (#26)', () => {
    // One address, two casings that differ only in case — the exact live divergence.
    const CHECKSUMMED = `0x8A34${'0'.repeat(32)}AD98` as const;
    const LOWERCASE = `0x8a34${'0'.repeat(32)}ad98` as const;

    it('finds an association stored checksummed when looked up lowercase', () => {
      // Written as the requester signs it: coordinator verbatim (checksummed).
      upsertRequesterAssociation({
        store,
        association: association({ coordinator: CHECKSUMMED, taskId: 1223n }),
        provenance: provenanceAt('1'),
      });

      // Read as `deadline(evaluation)` does it: the lowercase coordinator off the evaluation row.
      const found = associationForPosting(store, { chainId: 84532, coordinator: LOWERCASE, taskId: 1223n });
      expect(found?.responseTimeoutSeconds).toBe(3_600n);
    });

    it('finds an association stored lowercase when looked up checksummed', () => {
      upsertRequesterAssociation({
        store,
        association: association({ coordinator: LOWERCASE, taskId: 1223n }),
        provenance: provenanceAt('1'),
      });

      const found = associationForPosting(store, { chainId: 84532, coordinator: CHECKSUMMED, taskId: 1223n });
      expect(found?.responseTimeoutSeconds).toBe(3_600n);
    });

    it('treats the two casings as one posting, not two rows', () => {
      upsertRequesterAssociation({
        store,
        association: association({ coordinator: CHECKSUMMED, taskId: 1223n }),
        provenance: provenanceAt('1'),
      });
      // The lowercase re-index is the SAME posting with the SAME signed facts — idempotent, not a
      // second row and not a "changed signed facts" refusal.
      expect(() => upsertRequesterAssociation({
        store,
        association: association({ coordinator: LOWERCASE, taskId: 1223n }),
        provenance: provenanceAt('1'),
      })).not.toThrow();
      expect(associationsForTaskDigest(store, SHARED_TASK_DIGEST)).toHaveLength(1);
    });
  });

  // The live 1223 association row is already stored CHECKSUMMED on the preserved DB. After the fix
  // the lookup keys lowercase, so the existing row would still miss unless it is re-keyed. The
  // one-time idempotent migration in `installAssociationSchema` lowercases stored coordinator keys.
  it('migrates a pre-existing checksummed coordinator row to lowercase (#26)', () => {
    const CHECKSUMMED = `0x8A34${'0'.repeat(32)}AD98` as const;
    const LOWERCASE = `0x8a34${'0'.repeat(32)}ad98` as const;
    const stored = association({ coordinator: CHECKSUMMED, taskId: 1223n });

    // Simulate a row written BEFORE the fix: coordinator column stored checksummed, verbatim.
    store.db.prepare(
      `INSERT INTO native_evaluator_requester_associations
        (chain_id, coordinator, task_id, task_digest, association_json, source_id, source_sequence, entry_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '84532',
      CHECKSUMMED,
      '1223',
      stored.taskDigest,
      encodeAssociation(stored),
      'did:jinn:requester-a/postings',
      '1',
      `sha256:${'1'.padStart(64, '0')}`,
    );

    // Before the migration the lowercase lookup misses — the live failure.
    expect(associationForPosting(store, { chainId: 84532, coordinator: LOWERCASE, taskId: 1223n }))
      .toBeUndefined();

    // Running the schema install (as the daemon does on boot) re-keys the stored row.
    installAssociationSchema(store);

    const found = associationForPosting(store, { chainId: 84532, coordinator: LOWERCASE, taskId: 1223n });
    expect(found?.responseTimeoutSeconds).toBe(3_600n);

    // Idempotent: a second install does not disturb the already-lowercased row.
    installAssociationSchema(store);
    expect(associationsForTaskDigest(store, SHARED_TASK_DIGEST)).toHaveLength(1);
  });

  // Fast-follow to #2562: the column migration above re-keys `coordinator` on the ROW but leaves
  // the coordinator embedded inside the stored `association_json` body checksummed. A later
  // out-of-band replay of the SAME posting (checkpoint reset, source re-key, or a second requester
  // source re-serving the posting) calls `upsertRequesterAssociation`, which always
  // lowercase-canonicalizes the coordinator before encoding — so it compares its freshly-encoded
  // LOWERCASE body against the stored CHECKSUMMED body and throws "changed signed facts" for a
  // posting whose signed facts never actually changed. Part of #2461.
  it('migrates the coordinator inside association_json too, so a replayed posting is a clean no-op (#2461)', () => {
    const CHECKSUMMED = `0x8A34${'0'.repeat(32)}AD98` as const;
    const LOWERCASE = `0x8a34${'0'.repeat(32)}ad98` as const;
    const stored = association({ coordinator: CHECKSUMMED, taskId: 1223n });

    // Simulate a row written BEFORE the fix: coordinator checksummed in BOTH the column and the
    // encoded JSON body — exactly what a requester's signed association looks like on disk before
    // any canonicalization ran.
    store.db.prepare(
      `INSERT INTO native_evaluator_requester_associations
        (chain_id, coordinator, task_id, task_digest, association_json, source_id, source_sequence, entry_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '84532',
      CHECKSUMMED,
      '1223',
      stored.taskDigest,
      encodeAssociation(stored),
      'did:jinn:requester-a/postings',
      '1',
      `sha256:${'1'.padStart(64, '0')}`,
    );

    installAssociationSchema(store);

    // Replay the identical posting, exactly as the signed source would re-serve it under
    // out-of-band replay — this must be a clean no-op, not a "changed signed facts" refusal.
    expect(() => upsertRequesterAssociation({
      store,
      association: stored,
      provenance: provenanceAt('1'),
    })).not.toThrow();
    expect(associationsForTaskDigest(store, SHARED_TASK_DIGEST)).toHaveLength(1);

    // The migrated body is now byte-identical to what a fresh upsert of this posting would encode.
    const row = store.db.prepare(
      `SELECT association_json FROM native_evaluator_requester_associations
        WHERE chain_id = ? AND coordinator = ? AND task_id = ?`,
    ).get('84532', LOWERCASE, '1223') as { association_json: string };
    expect(row.association_json).toBe(encodeAssociation({ ...stored, coordinator: LOWERCASE }));
  });
});
