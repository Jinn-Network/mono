import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';

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
    });
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

  // #1672 — derived_trajectories table (backfill sink + idempotency probe).
  describe('derived_trajectories', () => {
    it('round-trips a parsed derived-trajectory row', () => {
      expect(store.hasDerivedTrajectory('sha-1')).toBe(false);
      store.saveDerivedTrajectory({
        sourceSha256: 'sha-1',
        sourceEnvelopeCid: 'bafy-src',
        sourceRequestId: 'req-1',
        harness: 'claude-code',
        outcome: 'parsed',
        spanCount: 3,
        trajectoryJson: '{"schemaVersion":"jinn.trajectory.v1"}',
        parserName: 'claude-code-stream-json',
        parserVersion: '1.0.0',
        createdAt: '2026-07-15T00:00:00.000Z',
      });
      expect(store.hasDerivedTrajectory('sha-1')).toBe(true);
      const row = store.getDerivedTrajectory('sha-1');
      expect(row).not.toBeNull();
      expect(row!.sourceEnvelopeCid).toBe('bafy-src');
      expect(row!.harness).toBe('claude-code');
      expect(row!.outcome).toBe('parsed');
      expect(row!.spanCount).toBe(3);
      expect(row!.trajectoryJson).toBe('{"schemaVersion":"jinn.trajectory.v1"}');
      expect(row!.parserName).toBe('claude-code-stream-json');
      expect(row!.parserVersion).toBe('1.0.0');
      expect(row!.publishedCid).toBeNull();
    });

    it('persists a no_transcript skip row with null trajectory_json', () => {
      store.saveDerivedTrajectory({
        sourceSha256: 'sha-skip',
        sourceEnvelopeCid: null,
        sourceRequestId: null,
        harness: null,
        outcome: 'no_transcript',
        spanCount: 0,
        trajectoryJson: null,
        parserName: null,
        parserVersion: null,
        createdAt: '2026-07-15T00:00:00.000Z',
      });
      const row = store.getDerivedTrajectory('sha-skip');
      expect(row!.outcome).toBe('no_transcript');
      expect(row!.trajectoryJson).toBeNull();
      expect(row!.spanCount).toBe(0);
    });

    it('INSERT OR REPLACE updates in place, does not duplicate', () => {
      const base = {
        sourceSha256: 'sha-dup',
        sourceEnvelopeCid: null,
        sourceRequestId: null,
        harness: 'codex' as const,
        outcome: 'parsed' as const,
        spanCount: 1,
        trajectoryJson: '{}',
        parserName: 'codex-exec-json',
        parserVersion: '1.0.0',
        createdAt: '2026-07-15T00:00:00.000Z',
      };
      store.saveDerivedTrajectory(base);
      store.saveDerivedTrajectory({ ...base, spanCount: 9 });
      expect(store.getDerivedTrajectory('sha-dup')!.spanCount).toBe(9);
    });

    it('setDerivedTrajectoryPublishedCid sets the published cid', () => {
      store.saveDerivedTrajectory({
        sourceSha256: 'sha-pub',
        sourceEnvelopeCid: 'bafy-src',
        sourceRequestId: null,
        harness: 'claude-code',
        outcome: 'parsed',
        spanCount: 2,
        trajectoryJson: '{}',
        parserName: 'claude-code-stream-json',
        parserVersion: '1.0.0',
        createdAt: '2026-07-15T00:00:00.000Z',
      });
      store.setDerivedTrajectoryPublishedCid('sha-pub', 'bafy-published');
      expect(store.getDerivedTrajectory('sha-pub')!.publishedCid).toBe('bafy-published');
    });
  });

  // #1672 — a full historical walk pages served_artifacts via a `before` cursor.
  it('listServedArtifactMetadata pages a full walk via the before cursor', () => {
    const total = 7;
    for (let i = 0; i < total; i++) {
      const idx = String(i).padStart(2, '0');
      store.saveServedArtifact({
        sha256: `sha-${idx}`,
        artifactType: 'system_snapshot',
        requestId: `req-${idx}`,
        envelopeCid: null,
        content: Buffer.from(`c-${idx}`),
        priceUsdc: '0',
        createdAt: `2026-07-15T00:00:${idx}.000Z`,
      });
    }
    const pageSize = 3;
    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = store.listServedArtifactMetadata({
        artifactType: 'system_snapshot',
        limit: pageSize,
        before,
      });
      if (page.length === 0) break;
      for (const r of page) seen.push(r.sha256);
      before = page[page.length - 1]!.createdAt;
      if (page.length < pageSize) break;
    }
    expect(new Set(seen).size).toBe(total);
    // DESC order across the whole walk.
    expect(seen[0]).toBe('sha-06');
    expect(seen[seen.length - 1]).toBe('sha-00');
  });

  // #1672 — keyset pagination survives a created_at tie at a page boundary.
  // Three rows share the EXACT same millisecond; the composite (created_at,
  // sha256) cursor must enumerate every row exactly once with no drop.
  it('listServedArtifactMetadata pages a tie-on-created_at walk without dropping rows', () => {
    const tie = '2026-07-15T00:00:01.000Z';
    const rows = [
      { sha256: 'sha-z', createdAt: '2026-07-15T00:00:02.000Z' }, // after the tie
      { sha256: 'sha-c', createdAt: tie },
      { sha256: 'sha-b', createdAt: tie },
      { sha256: 'sha-a', createdAt: tie },
      { sha256: 'sha-0', createdAt: '2026-07-15T00:00:00.000Z' }, // before the tie
    ];
    for (const r of rows) {
      store.saveServedArtifact({
        sha256: r.sha256,
        artifactType: 'system_snapshot',
        requestId: r.sha256,
        envelopeCid: null,
        content: Buffer.from(r.sha256),
        priceUsdc: '0',
        createdAt: r.createdAt,
      });
    }
    const pageSize = 2; // forces a page boundary inside the tie group
    const seen: string[] = [];
    let before: string | undefined;
    let beforeSha256: string | undefined;
    for (;;) {
      const page = store.listServedArtifactMetadata({
        artifactType: 'system_snapshot',
        limit: pageSize,
        before,
        beforeSha256,
      });
      if (page.length === 0) break;
      for (const r of page) seen.push(r.sha256);
      const last = page[page.length - 1]!;
      before = last.createdAt;
      beforeSha256 = last.sha256;
      if (page.length < pageSize) break;
    }
    // Every row enumerated exactly once, no drop, no duplicate.
    expect(seen.length).toBe(rows.length);
    expect(new Set(seen).size).toBe(rows.length);
    expect(new Set(seen)).toEqual(new Set(rows.map((r) => r.sha256)));
    // Stable DESC order on (created_at, sha256): tie group is c > b > a.
    expect(seen).toEqual(['sha-z', 'sha-c', 'sha-b', 'sha-a', 'sha-0']);
  });
});
