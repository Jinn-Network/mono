/**
 * Issue #2416 AC2 — one-shot cleanup for `activity_events.detail` rows written
 * before the #642 persistence choke point existed.
 *
 * Every write path is sealed today (`emitEvent` and
 * `ActivityEventsStore.recordActivityEvent` both apply `sanitizePersistedText`)
 * and `mapRow` re-masks at read, so no API reader sees a legacy URL. The
 * residual is the on-disk column itself: a support bundle, a direct SQLite
 * read, or any future consumer that does not go through `mapRow` still sees
 * the raw text. This is the same residual `BalanceCacheStore.clearLegacyErrors`
 * closed for the balance cache in #2415, and it is closed the same way.
 */
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store/store.js';

const RPC_HOST = 'base-mainnet.paid-provider.example';
const RPC_SECRET = 'SUPERSECRETKEY1234567';
const LEGACY_DETAIL = `HTTP request failed. URL: https://${RPC_HOST}/v2/${RPC_SECRET}`;

const MIGRATION_KEY = 'activity_events_detail_masked_v1';

function dbFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'jinn-legacy-detail-')), 'jinn.db');
}

/** Write a row the way a pre-#642 daemon did — straight past every sanitizer. */
function seedLegacyRow(path: string, detail: string): void {
  const raw = new Database(path);
  raw.prepare(
    `INSERT INTO activity_events (ts, kind, outcome, detail) VALUES (?, 'tick_error', 'failed', ?)`,
  ).run(new Date().toISOString(), detail);
  // The first Store open already ran (and keyed) the migration; clear the key
  // so the reopen below faces the same state a pre-#642 database presents.
  raw.prepare('DELETE FROM config WHERE key = ?').run(MIGRATION_KEY);
  raw.close();
}

function readRawDetails(path: string): Array<string | null> {
  const raw = new Database(path);
  const rows = raw.prepare('SELECT detail FROM activity_events ORDER BY id').all() as Array<{
    detail: string | null;
  }>;
  raw.close();
  return rows.map((r) => r.detail);
}

describe('legacy activity_events.detail masking (#2416)', () => {
  it('masks a legacy RPC URL in the stored column on the next open', () => {
    const path = dbFile();
    new Store(path).close();
    seedLegacyRow(path, LEGACY_DETAIL);

    expect(readRawDetails(path)[0]).toContain(RPC_SECRET);

    new Store(path).close();

    const [stored] = readRawDetails(path);
    expect(stored).not.toContain(RPC_SECRET);
    // Host survives — the cleanup masks, it does not discard the diagnostic.
    expect(stored).toContain(RPC_HOST);
  });

  it('leaves URL-free details untouched and is idempotent', () => {
    const path = dbFile();
    new Store(path).close();
    seedLegacyRow(path, 'claim reverted: NotEligible');

    new Store(path).close();
    expect(readRawDetails(path)[0]).toBe('claim reverted: NotEligible');

    new Store(path).close();
    expect(readRawDetails(path)[0]).toBe('claim reverted: NotEligible');
  });

  it('re-running the open does not re-mask an already-masked row', () => {
    const path = dbFile();
    new Store(path).close();
    seedLegacyRow(path, LEGACY_DETAIL);

    new Store(path).close();
    const afterFirst = readRawDetails(path)[0];
    new Store(path).close();
    expect(readRawDetails(path)[0]).toBe(afterFirst);
  });
});
