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
import { describe, expect, it, vi } from 'vitest';
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

  it('masks every legacy row, past one batch', () => {
    const path = dbFile();
    new Store(path).close();
    // 600 > the 500-row page size, so this exercises the paging loop rather
    // than a single pass.
    for (let i = 0; i < 600; i += 1) seedLegacyRow(path, `${LEGACY_DETAIL} #${i}`);

    new Store(path).close();

    const details = readRawDetails(path);
    expect(details).toHaveLength(600);
    expect(details.every((d) => d !== null && !d.includes(RPC_SECRET))).toBe(true);
    expect(details.every((d) => d !== null && d.includes(RPC_HOST))).toBe(true);
  });

  /**
   * A LIKE-matching detail can mask to itself (`http://` with nothing for
   * the URL regex to consume). `store.ts`'s paging cursor must advance on
   * every selected row, not only on ones that actually change — advancing
   * only on update would re-select a self-masking row forever.
   *
   * A single seeded row cannot pin that: with one matching row, `store.ts`'s
   * `if (rows.length < batch) break` ends the loop on page size alone,
   * whether or not the cursor advanced. Seeding a full page (`batch`, 500 —
   * see the constant in `maskLegacyActivityEventDetails`) of self-masking
   * rows makes the first page return exactly `batch` rows, so only the
   * cursor decides whether a second page is fetched.
   *
   * There is no `timeout` option here because it would not help: `new
   * Store(...)` runs the scrub synchronously inside the constructor, and
   * Vitest's per-test timeout is a `setTimeout` race that never gets a turn
   * on a blocked event loop — it cannot interrupt a synchronous hang. The
   * real bound is the `Database.prototype.prepare` spy below, which caps the
   * number of pages the scrub may fetch; exceeding it throws, and the
   * scrub's own catch turns that into a skipped migration (the key stays
   * unset) rather than a hang, so a regression fails the assertion instead
   * of wedging the suite.
   */
  it('does not loop forever when a full page of rows mask to themselves', () => {
    const path = dbFile();
    new Store(path).close();

    const batch = 500;
    for (let i = 0; i < batch; i += 1) seedLegacyRow(path, 'claim reverted: see http://');

    let selectCalls = 0;
    const originalPrepare = Database.prototype.prepare;
    const prepareSpy = vi
      .spyOn(Database.prototype, 'prepare')
      .mockImplementation(function (this: Database.Database, sql: string) {
        const stmt = originalPrepare.call(this, sql) as Database.Statement<unknown[]>;
        if (!sql.includes('WHERE id > @afterId')) return stmt;
        const originalAll = stmt.all;
        stmt.all = ((...args: unknown[]) => {
          selectCalls += 1;
          // A correctly-advancing cursor needs exactly two pages here (one
          // full page, then one empty page). A stalled cursor re-fetches
          // the same full page forever; capping well above 2 bounds that
          // without constraining the passing case.
          if (selectCalls > 4) {
            throw new Error('select-all page cap exceeded: cursor is not advancing');
          }
          return originalAll.apply(stmt, args);
        }) as typeof stmt.all;
        return stmt;
      });

    let store: Store;
    try {
      store = new Store(path);
    } finally {
      prepareSpy.mockRestore();
    }
    expect(selectCalls).toBeLessThanOrEqual(2);
    expect(store).toBeInstanceOf(Store);
    expect(store.getConfigValue(MIGRATION_KEY)).toBe('true');
    store.close();

    expect(readRawDetails(path)[0]).toBe('claim reverted: see http://');
  });

  /**
   * The accepted residual, pinned so it stays a decision rather than a
   * surprise: the scrub is a config-keyed one-shot, so a row written raw AFTER
   * the key is set (only reachable by downgrading to a pre-#642 daemon) stays
   * raw on disk. Every API reader is still covered by `mapRow`'s read-time
   * re-mask; the exposure is limited to a direct SQLite read.
   */
  it('does not re-run once keyed', () => {
    const path = dbFile();
    new Store(path).close();

    const raw = new Database(path);
    raw.prepare(
      `INSERT INTO activity_events (ts, kind, outcome, detail) VALUES (?, 'tick_error', 'failed', ?)`,
    ).run(new Date().toISOString(), LEGACY_DETAIL);
    raw.close();

    new Store(path).close();
    expect(readRawDetails(path)[0]).toContain(RPC_SECRET);
  });
});
