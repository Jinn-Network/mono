import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { createLegacyArtifactsSchemaDb } from '../helpers/legacy-artifacts-schema.js';

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('records own activity for role independence', () => {
    store.recordOwnActivity('req-1', 'created');
    store.recordOwnActivity('req-2', 'claimed');
    expect(store.isOwnActivity('req-1')).toBe(true);
    expect(store.isOwnActivity('req-3')).toBe(false);
  });

  it('tracks shutdown state', () => {
    store.setShutdownState('clean');
    expect(store.getShutdownState()).toBe('clean');
  });

  it('persists unresolved transaction submissions for replacement fee recovery', () => {
    store.recordTxSubmission({
      chainId: 84532,
      from: '0x1111111111111111111111111111111111111111',
      nonce: 7,
      hash: `0x${'11'.repeat(32)}`,
      logicalTx: 'safe.execTransaction',
      submittedAtMs: 1_000,
      fees: {
        maxFeePerGas: 100n,
        maxPriorityFeePerGas: 10n,
      },
      to: '0x2222222222222222222222222222222222222222',
      value: 0n,
      data: '0x1234',
    });

    expect(store.getTxSubmission({
      chainId: 84532,
      from: '0x1111111111111111111111111111111111111111',
      nonce: 7,
    })).toMatchObject({
      hash: `0x${'11'.repeat(32)}`,
      logicalTx: 'safe.execTransaction',
      fees: {
        maxFeePerGas: 100n,
        maxPriorityFeePerGas: 10n,
      },
      data: '0x1234',
      resolvedAtMs: null,
    });

    store.markTxSubmissionResolved({
      chainId: 84532,
      from: '0x1111111111111111111111111111111111111111',
      nonce: 7,
      resolvedAtMs: 2_000,
    });

    expect(store.getTxSubmission({
      chainId: 84532,
      from: '0x1111111111111111111111111111111111111111',
      nonce: 7,
    })?.resolvedAtMs).toBe(2_000);
  });

  it('aggregates own activity and config rows', () => {
    store.recordOwnActivity('r1', 'delivered');
    store.recordOwnActivity('r2', 'evaluated');
    store.setConfigValue('last_reward_claim_tick_at', '2026-01-02T00:00:00.000Z');
    expect(store.getOwnActivityCounts()).toEqual({ delivered: 1, evaluated: 1 });
    expect(store.getRecentOwnActivity(5)).toHaveLength(2);
    expect(store.getConfigValue('last_reward_claim_tick_at')).toBe('2026-01-02T00:00:00.000Z');
  });

  it('searches artifacts by taskId', () => {
    store.insertArtifact({
      id: 'art-1',
      taskId: 'my-state-id',
      requestId: 'req-1',
      title: 'Test artifact',
      content: 'Some content',
      tags: ['restoration', 'test'],
      outcome: 'SUCCESS',
    });
    store.insertArtifact({
      id: 'art-2',
      taskId: 'other-state-id',
      requestId: 'req-2',
      title: 'Other artifact',
      content: 'Other content',
      tags: ['test'],
      outcome: 'FAILURE',
    });

    const results = store.searchArtifacts({ taskId: 'my-state-id' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('art-1');

    const noMatch = store.searchArtifacts({ taskId: 'nonexistent' });
    expect(noMatch).toHaveLength(0);
  });

  it('migrates legacy desired_state artifact rows to task_id on startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-legacy-store-'));
    const dbPath = join(dir, 'jinn.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        desired_state_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE', 'UNKNOWN')),
        remote INTEGER NOT NULL DEFAULT 0,
        owner_address TEXT,
        endpoint TEXT,
        price TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO artifacts
        (id, desired_state_id, request_id, title, content, tags, outcome)
      VALUES
        ('legacy-art-1', 'legacy-state-1', 'req-1', 'Legacy artifact', 'content', '["legacy"]', 'SUCCESS');
    `);
    legacy.close();

    const migrated = new Store(dbPath);
    try {
      const cols = migrated.db.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain('task_id');
      expect(cols.map((c) => c.name)).toContain('protocol_task_id');
      expect(cols.map((c) => c.name)).toContain('task_cid');
      expect(migrated.searchArtifacts({ taskId: 'legacy-state-1' })).toMatchObject([
        { id: 'legacy-art-1', task_id: 'legacy-state-1' },
      ]);
    } finally {
      migrated.close();
    }
  });

  it('insertArtifact succeeds against a legacy desired_state_id NOT NULL schema (regression #506)', () => {
    // Issue #506: a successful on-chain delivery was persisted as FAILED
    // because insertArtifact() threw on this legacy NOT NULL column, and the
    // engine's error path flipped the run to FAILED. Guard against a
    // regression of that throw.
    const { dbPath } = createLegacyArtifactsSchemaDb('jinn-legacy-insert-');

    const legacyStore = new Store(dbPath);
    try {
      expect(() =>
        legacyStore.insertArtifact({
          id: 'art-legacy-insert-1',
          taskId: 'task-legacy-1',
          requestId: 'req-legacy-1',
          title: 'Restoration result',
          content: 'content',
          tags: ['restoration-result'],
          outcome: 'SUCCESS',
        }),
      ).not.toThrow();

      const results = legacyStore.searchArtifacts({ taskId: 'task-legacy-1' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('art-legacy-insert-1');
    } finally {
      legacyStore.close();
    }
  });

  it('stores durable task post records', () => {
    store.upsertTaskPostRecord({
      creatorSafeAddress: '0x00112233445566778899AABbCCdDeeFf00112233',
      sourceKey: 'manual:test-1',
      policyType: 'once_per_safe',
      scopeKey: '',
      taskId: 'test-1',
      requestId: 'req-1',
      firstPostedAt: '2026-04-23T10:00:00.000Z',
      lastPostedAt: '2026-04-23T10:00:00.000Z',
      postCount: 1,
      canonicalTaskJson: '{"id":"test-1"}',
      requestJson: '{"id":"request-1"}',
      creationTxHash: `0x${'ab'.repeat(32)}`,
      creationBlockNumber: 123,
      broadcastIntentAt: '2026-04-23T10:00:01.000Z',
    });

    expect(store.getTaskPostRecord({
      creatorSafeAddress: '0x00112233445566778899AABbCCdDeeFf00112233',
      sourceKey: 'manual:test-1',
      policyType: 'once_per_safe',
      scopeKey: '',
    })).toMatchObject({
      requestId: 'req-1',
      taskId: 'test-1',
      postCount: 1,
      canonicalTaskJson: '{"id":"test-1"}',
      requestJson: '{"id":"request-1"}',
      creationTxHash: `0x${'ab'.repeat(32)}`,
      creationBlockNumber: 123,
      broadcastIntentAt: '2026-04-23T10:00:01.000Z',
    });
  });

  it('atomically binds broadcast intent to the current lock owner and preserves it across upserts', () => {
    const key = {
      creatorSafeAddress: '0x00112233445566778899AABbCCdDeeFf00112233',
      sourceKey: 'autopilot:intent-1',
      policyType: 'once_per_safe' as const,
      scopeKey: '',
    };
    const baseRecord = {
      ...key,
      taskId: 'autopilot:intent-1',
      requestId: 'autopilot:intent-1',
      firstPostedAt: '2026-07-24T00:00:00.000Z',
      lastPostedAt: '2026-07-24T00:00:00.000Z',
      postCount: 0,
      canonicalTaskJson: '{"id":"autopilot:intent-1"}',
      requestJson: '{"schemaVersion":"jinn-task-submit-request.v1"}',
    };
    store.upsertTaskPostRecord(baseRecord);
    expect(store.acquireTaskPostLock({
      ...key,
      ownerToken: 'current-owner',
      lockedAt: '2026-07-24T00:00:00.000Z',
      staleAfterMs: 60_000,
    })).toBe(true);

    expect(store.markTaskPostBroadcastIntent({
      ...key,
      ownerToken: 'wrong-owner',
      lockedAt: '2026-07-24T00:00:01.000Z',
      broadcastIntentAt: '2026-07-24T00:00:01.000Z',
    })).toBe(false);
    expect(store.getTaskPostRecord(key)?.broadcastIntentAt).toBeNull();

    expect(store.markTaskPostBroadcastIntent({
      ...key,
      ownerToken: 'current-owner',
      lockedAt: '2026-07-24T00:00:02.000Z',
      broadcastIntentAt: '2026-07-24T00:00:02.000Z',
    })).toBe(true);
    expect(store.getTaskPostRecord(key)?.broadcastIntentAt)
      .toBe('2026-07-24T00:00:02.000Z');

    store.upsertTaskPostRecord({
      ...baseRecord,
      lastPostedAt: '2026-07-24T00:00:03.000Z',
      creationTxHash: `0x${'cd'.repeat(32)}`,
    });
    expect(store.getTaskPostRecord(key)).toMatchObject({
      broadcastIntentAt: '2026-07-24T00:00:02.000Z',
      creationTxHash: `0x${'cd'.repeat(32)}`,
    });
  });

  it('migrates legacy task_posts with nullable immutable bytes and creation provenance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-task-post-migration-'));
    const dbPath = join(dir, 'legacy.sqlite');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE task_posts (
        creator_safe_address TEXT NOT NULL,
        source_key TEXT NOT NULL,
        policy_type TEXT NOT NULL,
        scope_key TEXT NOT NULL DEFAULT '',
        task_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        first_posted_at TEXT NOT NULL,
        last_posted_at TEXT NOT NULL,
        post_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (creator_safe_address, source_key, policy_type, scope_key)
      );
    `);
    legacy.close();

    const migrated = new Store(dbPath);
    try {
      const inspect = new Database(dbPath, { readonly: true });
      const columns = inspect.prepare('PRAGMA table_info(task_posts)')
        .all() as Array<{ name: string }>;
      inspect.close();
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'canonical_task_json',
        'request_json',
        'creation_tx_hash',
        'creation_block_number',
        'broadcast_intent_at',
      ]));
    } finally {
      migrated.close();
    }
  });

  it('lists posted tasks by creator with solverType denormalised from activity_events', () => {
    const creator = '0x00112233445566778899AABbCCdDeeFf00112233';
    // Insert two posts at different timestamps. The accessor returns rows in
    // last_posted_at DESC order so the most recent should be first.
    store.upsertTaskPostRecord({
      creatorSafeAddress: creator,
      sourceKey: 'auto:prediction.v1:0xa',
      policyType: 'once_per_bucket',
      scopeKey: 'a',
      taskId: 'task-a',
      taskCid: 'Qma',
      requestId: 'req-a',
      firstPostedAt: '2026-05-05T10:00:00.000Z',
      lastPostedAt: '2026-05-05T10:00:00.000Z',
      postCount: 1,
    });
    store.upsertTaskPostRecord({
      creatorSafeAddress: creator,
      sourceKey: 'auto:prediction.v1:0xb',
      policyType: 'once_per_bucket',
      scopeKey: 'b',
      taskId: 'task-b',
      taskCid: 'Qmb',
      requestId: 'req-b',
      firstPostedAt: '2026-05-05T11:00:00.000Z',
      lastPostedAt: '2026-05-05T11:00:00.000Z',
      postCount: 1,
    });
    // Mirror the daemon's `task_posted` event so the JOIN populates solver_type.
    store.recordActivityEvent({
      ts: '2026-05-05T10:00:00.000Z',
      kind: 'task_posted',
      requestId: 'req-a',
      solverType: 'prediction.v1',
    });
    store.recordActivityEvent({
      ts: '2026-05-05T11:00:00.000Z',
      kind: 'task_posted',
      requestId: 'req-b',
      solverType: 'prediction.v1',
    });

    const all = store.listPostedTasksByCreator({ creatorSafeAddress: creator, limit: 10 });
    expect(all).toHaveLength(2);
    expect(all[0]?.taskId).toBe('task-b');
    expect(all[0]?.solverType).toBe('prediction.v1');
    expect(all[1]?.taskId).toBe('task-a');

    const paged = store.listPostedTasksByCreator({
      creatorSafeAddress: creator,
      limit: 10,
      before: '2026-05-05T11:00:00.000Z',
    });
    expect(paged).toHaveLength(1);
    expect(paged[0]?.taskId).toBe('task-a');

    const wrongCreator = store.listPostedTasksByCreator({
      creatorSafeAddress: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
      limit: 10,
    });
    expect(wrongCreator).toEqual([]);

    const count = store.countPostedTasksByCreatorAndSolverType({
      creatorSafeAddress: creator,
      solverType: 'prediction.v1',
    });
    expect(count).toBe(2);

    const otherSolverType = store.countPostedTasksByCreatorAndSolverType({
      creatorSafeAddress: creator,
      solverType: 'mystery.v1',
    });
    expect(otherSolverType).toBe(0);
  });

  it('does not create the retired derived_trajectories backfill sink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-retired-derived-trajectories-'));
    const dbPath = join(dir, 'jinn.sqlite');
    const freshStore = new Store(dbPath);
    const inspector = new Database(dbPath, { readonly: true });

    try {
      const table = inspector
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'derived_trajectories'`,
        )
        .get();
      expect(table).toBeUndefined();
    } finally {
      inspector.close();
      freshStore.close();
    }
  });

  // Regression coverage for spec §14.2 item 2 / issue #2402: a balance-cache
  // row written before gather-status.ts's `errorMessage` choke point started
  // masking RPC URLs can carry a raw key-in-path error string. It is REPLAYED
  // verbatim on every later /v1/status call unless getBalanceCache() re-masks
  // it on read (every call, not a one-shot — see the next describe block for
  // the actual one-shot migration).
  it('re-masks an already-poisoned balance-cache error on every read', () => {
    // Simulate a row persisted before the masking fix shipped — write it
    // directly via upsertBalanceCache (which itself does not mask; masking
    // before persistence is gather-status.ts's job) so the row genuinely
    // carries the leaked URL, the way a pre-fix daemon would have left it.
    store.upsertBalanceCache({
      role: 'service.1.agent',
      address: '0x1111111111111111111111111111111111111111',
      nativeWei: null,
      bondWei: null,
      fetchedAt: new Date(0).toISOString(),
      error:
        'HTTP request failed.\n\nURL: https://base-mainnet.g.alchemy.com/v2/SECRETKEY123\nRequest body: {"method":"eth_getBalance"}',
    });

    const [entry] = store.getBalanceCache();

    expect(entry?.error).toContain('base-mainnet.g.alchemy.com');
    expect(entry?.error).not.toContain('SECRETKEY123');
  });

  it('leaves a balance-cache row with no error, or an error with no URL, unchanged on read', () => {
    store.upsertBalanceCache({
      role: 'service.1.agent',
      address: '0x1111111111111111111111111111111111111111',
      nativeWei: '0',
      bondWei: null,
      fetchedAt: new Date(0).toISOString(),
      error: null,
    });
    store.upsertBalanceCache({
      role: 'service.1.multisig',
      address: '0x2222222222222222222222222222222222222222',
      nativeWei: null,
      bondWei: null,
      fetchedAt: new Date(0).toISOString(),
      error: 'connect ECONNREFUSED 127.0.0.1:0',
    });

    const byRole = new Map(store.getBalanceCache().map((e) => [e.role, e]));
    expect(byRole.get('service.1.agent')?.error).toBeNull();
    expect(byRole.get('service.1.multisig')?.error).toBe('connect ECONNREFUSED 127.0.0.1:0');
  });

});

// Regression coverage for spec §14.2 item 2 / issue #2402's orphan-row case:
// re-mask-on-read (above) only helps a role a client still fetches. A role
// that's since dropped out of the fleet (re-indexed display slot, removed
// service) has a row nothing ever calls getBalanceCache() to re-mask, so it
// would sit poisoned on disk indefinitely without a genuine one-shot scrub.
describe('Store balance_cache legacy-error migration (spec §14.2 item 2, issue #2402)', () => {
  it('clears an already-poisoned error at construction time, including for a role no longer fetched', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'jinn-balance-cache-migration-')), 'jinn.db');

    // Simulate a pre-fix DB on disk: write directly via better-sqlite3,
    // bypassing the Store class entirely (as a pre-fix daemon would have
    // left it), for a role ('service.9.agent') that no longer exists in the
    // current fleet — i.e. nothing will ever call getBalanceCache() and
    // re-mask this particular row on read.
    const raw = new Database(dbPath);
    raw.exec(
      `CREATE TABLE balance_cache (
        role TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        native_wei TEXT,
        bond_wei TEXT,
        asset_extra_json TEXT,
        fetched_at TEXT NOT NULL,
        error TEXT
      )`,
    );
    raw.prepare(
      `INSERT INTO balance_cache (role, address, native_wei, bond_wei, asset_extra_json, fetched_at, error)
       VALUES (@role, @address, NULL, NULL, NULL, @fetchedAt, @error)`,
    ).run({
      role: 'service.9.agent',
      address: '0x1111111111111111111111111111111111111111',
      fetchedAt: new Date(0).toISOString(),
      error:
        'HTTP request failed.\n\nURL: https://base-mainnet.g.alchemy.com/v2/SECRETKEY123\nRequest body: {"method":"eth_getBalance"}',
    });
    raw.close();

    // Opening a Store against this file runs the schema-init migration.
    const migratedStore = new Store(dbPath);
    try {
      const inspector = new Database(dbPath, { readonly: true });
      try {
        const row = inspector
          .prepare(`SELECT error FROM balance_cache WHERE role = 'service.9.agent'`)
          .get() as { error: string | null };
        expect(row.error).toBeNull();
      } finally {
        inspector.close();
      }
    } finally {
      migratedStore.close();
    }
  });

  it('leaves a balance-cache error with no URL untouched at construction time', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'jinn-balance-cache-migration-')), 'jinn.db');

    const raw = new Database(dbPath);
    raw.exec(
      `CREATE TABLE balance_cache (
        role TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        native_wei TEXT,
        bond_wei TEXT,
        asset_extra_json TEXT,
        fetched_at TEXT NOT NULL,
        error TEXT
      )`,
    );
    raw.prepare(
      `INSERT INTO balance_cache (role, address, native_wei, bond_wei, asset_extra_json, fetched_at, error)
       VALUES ('service.0.agent', '0x1111111111111111111111111111111111111111', NULL, NULL, NULL, ?, 'connect ECONNREFUSED 127.0.0.1:0')`,
    ).run(new Date(0).toISOString());
    raw.close();

    const migratedStore = new Store(dbPath);
    try {
      const inspector = new Database(dbPath, { readonly: true });
      try {
        const row = inspector
          .prepare(`SELECT error FROM balance_cache WHERE role = 'service.0.agent'`)
          .get() as { error: string | null };
        expect(row.error).toBe('connect ECONNREFUSED 127.0.0.1:0');
      } finally {
        inspector.close();
      }
    } finally {
      migratedStore.close();
    }
  });

  it('sanitizes RPC secrets on write and on read of already-persisted rows (#642)', () => {
    const store = new Store(':memory:');
    const secret = 'SECRETKEY123';
    const id = store.recordActivityEvent({
      ts: '2026-08-24T00:00:00.000Z',
      kind: 'tick_error',
      detail: `HTTP request to https://user:${secret}@paid.example/v2/${secret} failed`,
    });
    const written = store.getActivityEventById(id);
    expect(written?.detail).toBe('HTTP request to paid.example failed');
    expect(written?.detail).not.toContain(secret);

    store.db.prepare(
      `INSERT INTO activity_events (ts, kind, detail) VALUES (@ts, @kind, @detail)`,
    ).run({
      ts: '2026-08-24T00:01:00.000Z',
      kind: 'claim_failed',
      detail: `URL: https://rpc.example/?apiKey=${secret}#token=${secret}`,
    });
    const persisted = store.getRecentActivityEvents(5).find((row) => row.kind === 'claim_failed');
    expect(persisted?.detail).toContain('rpc.example');
    expect(persisted?.detail).not.toContain(secret);
    expect(persisted?.detail).not.toContain('apiKey=');
    store.close();
  });
});
