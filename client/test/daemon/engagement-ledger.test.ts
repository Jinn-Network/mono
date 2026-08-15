import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../../src/store/store.js';
import {
  ENGAGEMENT_LEDGER_SCHEMA,
  EngagementLedger,
  reconcileEngagements,
  type EngagementRow,
} from '../../src/daemon/engagement-ledger.js';

const WIRING = {
  workKind: 'QmSolver',
  harness: 'claude-code',
  model: 'claude-haiku-4-5-20251001',
  plugins: [],
  credentialRef: 'claude-code-default',
  isolationPolicy: 'process',
  legacyManifestDigest: 'QmSolver',
};

function ledger(): EngagementLedger {
  return new EngagementLedger(new Store(':memory:'));
}

const INTENT = {
  idempotencyKey: '84532:0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98:42',
  chainId: 84532,
  taskCoordinator: '0x8a34793e10595c89B7e41Cc7Ff0F76850F44AD98',
  taskId: 42n,
  workKind: 'QmSolver',
  wiring: WIRING,
};

describe('engagement ledger', () => {
  it('admits a claim intent and records the wiring entry that served it', () => {
    const led = ledger();
    expect(led.admitClaimIntent(INTENT)).toBe(true);
    const row = led.get(INTENT.idempotencyKey)!;
    expect(row.outcome).toBe('intended');
    expect(JSON.parse(row.wiringJson)).toEqual(WIRING);
    expect(row.claimTxHash).toBeNull();
  });

  it('refuses a second intent for the same task — the caller must not broadcast twice', () => {
    const led = ledger();
    expect(led.admitClaimIntent(INTENT)).toBe(true);
    expect(led.admitClaimIntent(INTENT)).toBe(false);
  });

  it('records the claim receipt and terminal outcome', () => {
    const led = ledger();
    led.admitClaimIntent(INTENT);
    led.recordClaimed(INTENT.idempotencyKey, {
      attemptIndex: 0,
      attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
      claimTxHash: `0x${'c'.repeat(64)}`,
    });
    led.recordOutcome(INTENT.idempotencyKey, 'settled');
    const row = led.get(INTENT.idempotencyKey)!;
    expect(row.attemptIndex).toBe(0);
    expect(row.outcome).toBe('settled');
    expect(led.listUnreconciled()).toEqual([]);
  });

  it('reconciles an intended row whose broadcast actually landed', async () => {
    const led = ledger();
    led.admitClaimIntent(INTENT);
    const result = await reconcileEngagements({
      ledger: led,
      readAttemptFacts: async () => ({
        kind: 'claimed',
        attemptIndex: 0,
        attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        claimTxHash: `0x${'c'.repeat(64)}`,
      }),
    });
    expect(result.reconciled).toBe(1);
    expect(led.get(INTENT.idempotencyKey)!.outcome).toBe('claimed');
    expect(result.stranded).toEqual([]);
  });

  it('abandons an intended row whose broadcast never landed', async () => {
    const led = ledger();
    led.admitClaimIntent(INTENT);
    await reconcileEngagements({ ledger: led, readAttemptFacts: async () => ({ kind: 'no-claim' }) });
    expect(led.get(INTENT.idempotencyKey)!.outcome).toBe('abandoned');
  });

  it('strands a claimed-but-unsettled row loudly instead of silently retrying', async () => {
    const led = ledger();
    led.admitClaimIntent(INTENT);
    led.recordClaimed(INTENT.idempotencyKey, {
      attemptIndex: 0,
      attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
      claimTxHash: `0x${'c'.repeat(64)}`,
    });
    const warnings: string[] = [];
    const result = await reconcileEngagements({
      ledger: led,
      readAttemptFacts: async () => ({
        kind: 'claimed',
        attemptIndex: 0,
        attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        claimTxHash: `0x${'c'.repeat(64)}`,
      }),
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(result.stranded.map((row: EngagementRow) => row.idempotencyKey)).toEqual([
      INTENT.idempotencyKey,
    ]);
    expect(warnings.join('\n')).toContain('unreleased attempt');
  });

  // Close-out C1: engagement ledger gains requestId correlation.
  describe('requestId correlation (C1)', () => {
    const REQUEST_ID = `0x${'a'.repeat(64)}`;

    it('persists the requestId recorded at claim time and is null before a claim lands', () => {
      const led = ledger();
      led.admitClaimIntent(INTENT);
      expect(led.get(INTENT.idempotencyKey)!.requestId).toBeNull();
      led.recordClaimed(INTENT.idempotencyKey, {
        attemptIndex: 0,
        attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        claimTxHash: `0x${'c'.repeat(64)}`,
        requestId: REQUEST_ID,
      });
      expect(led.get(INTENT.idempotencyKey)!.requestId).toBe(REQUEST_ID);
    });

    it('leaves requestId null for a revised-generation claim (none minted)', () => {
      const led = ledger();
      led.admitClaimIntent(INTENT);
      led.recordClaimed(INTENT.idempotencyKey, {
        attemptIndex: 0,
        attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        claimTxHash: `0x${'c'.repeat(64)}`,
      });
      expect(led.get(INTENT.idempotencyKey)!.requestId).toBeNull();
    });

    it('resolves a row by requestId', () => {
      const led = ledger();
      led.admitClaimIntent(INTENT);
      led.recordClaimed(INTENT.idempotencyKey, {
        attemptIndex: 0,
        attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        claimTxHash: `0x${'c'.repeat(64)}`,
        requestId: REQUEST_ID,
      });
      expect(led.getByRequestId(REQUEST_ID)?.idempotencyKey).toBe(INTENT.idempotencyKey);
    });

    it('returns undefined for a requestId no row carries', () => {
      const led = ledger();
      led.admitClaimIntent(INTENT);
      expect(led.getByRequestId(REQUEST_ID)).toBeUndefined();
    });

    it('ALTERs request_id into a pre-existing on-disk table that predates this column', () => {
      // Mirrors store.ts's own migration guard: build a database against the OLD schema (no
      // request_id column) via the raw SQL literal minus that column, exactly like a database
      // written before this migration existed, then open it through `Store` and confirm the
      // migration adds the column without dropping existing rows.
      const legacySchema = `
        CREATE TABLE IF NOT EXISTS engagement_ledger (
          idempotency_key  TEXT PRIMARY KEY,
          chain_id         INTEGER NOT NULL,
          task_coordinator TEXT NOT NULL,
          task_id          TEXT NOT NULL,
          work_kind        TEXT NOT NULL,
          wiring_json      TEXT NOT NULL,
          attempt_index    INTEGER,
          attempt_uri      TEXT,
          claim_tx_hash    TEXT,
          outcome          TEXT NOT NULL,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        );
      `;
      expect(ENGAGEMENT_LEDGER_SCHEMA).not.toEqual(legacySchema);
      const raw = new Database(':memory:');
      raw.exec(legacySchema);
      raw
        .prepare(
          `INSERT INTO engagement_ledger
             (idempotency_key, chain_id, task_coordinator, task_id, work_kind, wiring_json,
              outcome, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'intended', ?, ?)`,
        )
        .run(
          INTENT.idempotencyKey,
          INTENT.chainId,
          INTENT.taskCoordinator,
          INTENT.taskId.toString(),
          INTENT.workKind,
          JSON.stringify(WIRING),
          '2026-07-31T00:00:00Z',
          '2026-07-31T00:00:00Z',
        );
      raw.close();

      // `Store` doesn't take a pre-opened Database, so exercise the same migration path via a
      // real on-disk file: write the legacy DB to disk, then open it through `Store`, whose
      // constructor runs `ensureEngagementLedgerRequestIdColumn` before anything else touches it.
      const path = join(
        tmpdir(),
        `jinn-engagement-ledger-migration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
      );
      const seeded = new Database(path);
      seeded.exec(legacySchema);
      seeded
        .prepare(
          `INSERT INTO engagement_ledger
             (idempotency_key, chain_id, task_coordinator, task_id, work_kind, wiring_json,
              outcome, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'intended', ?, ?)`,
        )
        .run(
          INTENT.idempotencyKey,
          INTENT.chainId,
          INTENT.taskCoordinator,
          INTENT.taskId.toString(),
          INTENT.workKind,
          JSON.stringify(WIRING),
          '2026-07-31T00:00:00Z',
          '2026-07-31T00:00:00Z',
        );
      seeded.close();

      const migrated = new Store(path);
      const led = new EngagementLedger(migrated);
      const row = led.get(INTENT.idempotencyKey)!;
      expect(row.requestId).toBeNull();
      led.recordClaimed(INTENT.idempotencyKey, {
        attemptIndex: 0,
        attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        claimTxHash: `0x${'c'.repeat(64)}`,
        requestId: REQUEST_ID,
      });
      expect(led.getByRequestId(REQUEST_ID)?.idempotencyKey).toBe(INTENT.idempotencyKey);
      migrated.db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    });
  });

  // Finding E35 (ruled): the work loop seals the dispatch-context document once, at claim time,
  // into this same row -- bytes + digest, additive columns exactly like `request_id` (C1) above.
  describe('dispatch-context seal (E35)', () => {
    const DISPATCH_CONTEXT_DIGEST = `sha256:${'e'.repeat(64)}` as const;
    const DISPATCH_CONTEXT_BYTES = new TextEncoder().encode(
      '{"attempt":"urn:uuid:11111111-2222-3333-4444-555555555555","nonce":"nonce-1","submission":"urn:uuid:22222222-3333-4444-5555-666666666666","taskDigest":"sha256:aaaa"}',
    );

    it('is null before a claim lands and persists the sealed digest + bytes recorded at claim time', () => {
      const led = ledger();
      led.admitClaimIntent(INTENT);
      const before = led.get(INTENT.idempotencyKey)!;
      expect(before.dispatchContextDigest).toBeNull();
      expect(before.dispatchContextBytes).toBeNull();

      led.recordClaimed(INTENT.idempotencyKey, {
        attemptIndex: 0,
        attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        claimTxHash: `0x${'c'.repeat(64)}`,
        dispatchContext: { digest: DISPATCH_CONTEXT_DIGEST, bytes: DISPATCH_CONTEXT_BYTES },
      });

      const after = led.get(INTENT.idempotencyKey)!;
      expect(after.dispatchContextDigest).toBe(DISPATCH_CONTEXT_DIGEST);
      expect(after.dispatchContextBytes).toBe(Buffer.from(DISPATCH_CONTEXT_BYTES).toString('base64'));
      // Round-trips back to the exact original bytes -- not just an opaque equal string.
      expect(new Uint8Array(Buffer.from(after.dispatchContextBytes!, 'base64'))).toEqual(
        DISPATCH_CONTEXT_BYTES,
      );
    });

    it('leaves both columns null when the caller records a claim without sealing (back-compat)', () => {
      const led = ledger();
      led.admitClaimIntent(INTENT);
      led.recordClaimed(INTENT.idempotencyKey, {
        attemptIndex: 0,
        attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        claimTxHash: `0x${'c'.repeat(64)}`,
      });
      const row = led.get(INTENT.idempotencyKey)!;
      expect(row.dispatchContextDigest).toBeNull();
      expect(row.dispatchContextBytes).toBeNull();
    });

    it('ALTERs dispatch_context_digest/dispatch_context_bytes into a pre-existing on-disk table that predates these columns', () => {
      // Same migration-proof shape as the request_id test above: build a database against a
      // schema that has request_id but predates the dispatch-context columns, open it through
      // `Store`, and confirm the migration adds both columns without dropping existing rows.
      const legacySchema = `
        CREATE TABLE IF NOT EXISTS engagement_ledger (
          idempotency_key  TEXT PRIMARY KEY,
          chain_id         INTEGER NOT NULL,
          task_coordinator TEXT NOT NULL,
          task_id          TEXT NOT NULL,
          work_kind        TEXT NOT NULL,
          wiring_json      TEXT NOT NULL,
          attempt_index    INTEGER,
          attempt_uri      TEXT,
          claim_tx_hash    TEXT,
          request_id       TEXT,
          outcome          TEXT NOT NULL,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        );
      `;
      expect(ENGAGEMENT_LEDGER_SCHEMA).not.toEqual(legacySchema);

      const path = join(
        tmpdir(),
        `jinn-engagement-ledger-dispatch-context-migration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
      );
      const seeded = new Database(path);
      seeded.exec(legacySchema);
      seeded
        .prepare(
          `INSERT INTO engagement_ledger
             (idempotency_key, chain_id, task_coordinator, task_id, work_kind, wiring_json,
              outcome, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'intended', ?, ?)`,
        )
        .run(
          INTENT.idempotencyKey,
          INTENT.chainId,
          INTENT.taskCoordinator,
          INTENT.taskId.toString(),
          INTENT.workKind,
          JSON.stringify(WIRING),
          '2026-07-31T00:00:00Z',
          '2026-07-31T00:00:00Z',
        );
      seeded.close();

      const migrated = new Store(path);
      const led = new EngagementLedger(migrated);
      const row = led.get(INTENT.idempotencyKey)!;
      expect(row.dispatchContextDigest).toBeNull();
      expect(row.dispatchContextBytes).toBeNull();

      led.recordClaimed(INTENT.idempotencyKey, {
        attemptIndex: 0,
        attemptUri: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        claimTxHash: `0x${'c'.repeat(64)}`,
        dispatchContext: { digest: DISPATCH_CONTEXT_DIGEST, bytes: DISPATCH_CONTEXT_BYTES },
      });
      expect(led.get(INTENT.idempotencyKey)!.dispatchContextDigest).toBe(DISPATCH_CONTEXT_DIGEST);

      migrated.db.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    });
  });
});
