import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { Store } from '../../src/store/store.js';

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-phase-runs-'));
  return join(dir, 'jinn.db');
}

/** Minimal pre-feature schema: task_posts + activity_events, no phase tables. */
function createPreFeatureDb(dbPath: string): void {
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE task_posts (
      creator_safe_address TEXT NOT NULL,
      source_key TEXT NOT NULL,
      policy_type TEXT NOT NULL CHECK (policy_type IN ('once_per_safe', 'once_per_bucket', 'interval')),
      scope_key TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      first_posted_at TEXT NOT NULL,
      last_posted_at TEXT NOT NULL,
      post_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (creator_safe_address, source_key, policy_type, scope_key)
    );
    CREATE TABLE activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT,
      kind TEXT NOT NULL,
      request_id TEXT,
      service_index INTEGER,
      tx_hash TEXT,
      solver_type TEXT,
      outcome TEXT,
      detail TEXT
    );
    INSERT INTO task_posts (
      creator_safe_address, source_key, policy_type, scope_key,
      task_id, request_id, first_posted_at, last_posted_at, post_count
    ) VALUES (
      '0xsafe', 'src-1', 'once_per_safe', '',
      'task-1', 'req-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1
    );
    INSERT INTO activity_events (ts, kind, request_id)
    VALUES ('2026-01-01T00:00:00.000Z', 'created', 'req-1');
  `);
  const tables = (legacy.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  ).all() as Array<{ name: string }>).map((r) => r.name);
  expect(tables).not.toContain('phase_runs');
  expect(tables).not.toContain('phase_run_events');
  legacy.close();
}

function raceTransitionInWorker(
  dbPath: string,
  runKey: string,
  label: string,
): Promise<'won' | 'lost' | 'error'> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require('better-sqlite3');
      const { dbPath, runKey, label } = workerData;
      try {
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        const tx = db.transaction(() => {
          const now = Date.now();
          const result = db.prepare(
            'UPDATE phase_runs SET phase = @phase, revision = @nextRevision, updated_at = @now ' +
            'WHERE run_key = @runKey AND revision = @expectedRevision'
          ).run({
            runKey,
            phase: 'execute',
            nextRevision: 1,
            now,
            expectedRevision: 0,
          });
          if (result.changes === 0) {
            const err = new Error('ConcurrentPhaseTransitionError');
            err.name = 'ConcurrentPhaseTransitionError';
            throw err;
          }
          db.prepare(
            'INSERT INTO phase_run_events (run_key, revision, event_json, created_at) ' +
            'VALUES (@runKey, @revision, @eventJson, @now)'
          ).run({
            runKey,
            revision: 1,
            eventJson: JSON.stringify({ by: label }),
            now,
          });
        });
        tx();
        db.close();
        parentPort.postMessage('won');
      } catch (err) {
        if (err && err.name === 'ConcurrentPhaseTransitionError') {
          parentPort.postMessage('lost');
        } else {
          parentPort.postMessage('error:' + (err && err.message ? err.message : String(err)));
        }
      }
      `,
      { eval: true, workerData: { dbPath, runKey, label } },
    );
    worker.on('message', (msg: string) => {
      if (msg === 'won' || msg === 'lost') resolve(msg);
      else resolve('error');
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}`));
    });
  });
}

describe('PhaseRunStore', () => {
  it('roundtrips phase, revision, state, and events across a reopen', () => {
    const dbPath = tmpDbPath();
    let store = new Store(dbPath);
    let phaseRuns = store.phaseRuns();

    phaseRuns.createRun('run-1', 'plan', { foo: 'bar' });
    phaseRuns.transition('run-1', 0, { phase: 'execute', event: { kind: 'started' } });
    phaseRuns.transition('run-1', 1, { phase: 'verify', event: { kind: 'executed' } });
    phaseRuns.transition('run-1', 2, { phase: 'done', state: { foo: 'baz' }, event: { kind: 'verified' } });

    store.close();

    store = new Store(dbPath);
    phaseRuns = store.phaseRuns();
    const run = phaseRuns.getRun('run-1');

    expect(run).not.toBeNull();
    expect(run!.phase).toBe('done');
    expect(run!.revision).toBe(3);
    expect(run!.state).toEqual({ foo: 'baz' });
    expect(run!.events).toEqual([
      { kind: 'started' },
      { kind: 'executed' },
      { kind: 'verified' },
    ]);

    store.close();
  });

  it('getRun returns a consistent phase/revision/events aggregate under WAL interleaving', () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    store.phaseRuns().createRun('run-torn', 'plan');

    // Second WAL connection. Without a shared read transaction, a transition
    // committed between the two SELECTs tears phase/revision from events.
    const reader = new Database(dbPath);
    reader.pragma('journal_mode = WAL');

    const tornRow = reader.prepare(
      `SELECT phase, revision FROM phase_runs WHERE run_key = ?`,
    ).get('run-torn') as { phase: string; revision: number };
    store.phaseRuns().transition('run-torn', 0, { phase: 'execute', event: { e: 1 } });
    const tornEvents = reader.prepare(
      `SELECT event_json FROM phase_run_events WHERE run_key = ? ORDER BY id ASC`,
    ).all('run-torn') as Array<{ event_json: string }>;
    expect(tornRow.phase).toBe('plan');
    expect(tornRow.revision).toBe(0);
    expect(tornEvents).toHaveLength(1);

    // Same interleaving inside one read transaction (what getRun uses) keeps
    // a consistent pre-transition snapshot even though the writer commits.
    store.phaseRuns().createRun('run-safe', 'plan');
    const snap = reader.transaction(() => {
      const row = reader.prepare(
        `SELECT phase, revision FROM phase_runs WHERE run_key = ?`,
      ).get('run-safe') as { phase: string; revision: number };
      store.phaseRuns().transition('run-safe', 0, { phase: 'execute', event: { e: 1 } });
      const events = reader.prepare(
        `SELECT event_json FROM phase_run_events WHERE run_key = ? ORDER BY id ASC`,
      ).all('run-safe') as Array<{ event_json: string }>;
      return { phase: row.phase, revision: row.revision, events: events.length };
    })();
    expect(snap).toEqual({ phase: 'plan', revision: 0, events: 0 });

    const run = store.phaseRuns().getRun('run-safe');
    expect(run).not.toBeNull();
    expect(run!.revision).toBe(run!.events.length);
    expect(run!.phase).toBe('execute');
    expect(run!.state).toBeNull();
    expect(run!.events).toEqual([{ e: 1 }]);

    reader.close();
    store.close();
  });

  it('lets exactly one of two racing file-backed connections at the same expected revision succeed', async () => {
    const dbPath = tmpDbPath();
    const setup = new Store(dbPath);
    setup.phaseRuns().createRun('run-race', 'plan');
    setup.close();

    const [a, b] = await Promise.all([
      raceTransitionInWorker(dbPath, 'run-race', 'a'),
      raceTransitionInWorker(dbPath, 'run-race', 'b'),
    ]);

    const outcomes = [a, b].sort();
    expect(outcomes).toEqual(['lost', 'won']);

    const store = new Store(dbPath);
    const run = store.phaseRuns().getRun('run-race');
    expect(run!.revision).toBe(1);
    expect(run!.phase).toBe('execute');
    expect(run!.events).toHaveLength(1);
    expect(run!.revision).toBe(run!.events.length);
    store.close();
  });

  it('rolls back a successful CAS when event insert fails — no partial update', () => {
    const store = new Store(':memory:');
    const phaseRuns = store.phaseRuns();
    phaseRuns.createRun('run-atomic', 'plan', { keep: true });

    store.db.exec(`
      CREATE TRIGGER abort_phase_run_event_insert
      BEFORE INSERT ON phase_run_events
      BEGIN
        SELECT RAISE(ABORT, 'forced event insert failure');
      END;
    `);

    expect(() =>
      phaseRuns.transition('run-atomic', 0, { phase: 'execute', state: { keep: false }, event: { by: 'winner' } }),
    ).toThrow(/forced event insert failure/);

    store.db.exec(`DROP TRIGGER abort_phase_run_event_insert`);

    const run = phaseRuns.getRun('run-atomic');
    expect(run!.phase).toBe('plan');
    expect(run!.revision).toBe(0);
    expect(run!.state).toEqual({ keep: true });
    expect(run!.events).toHaveLength(0);

    const row = store.db
      .prepare('SELECT COUNT(*) as c FROM phase_run_events WHERE run_key = ?')
      .get('run-atomic') as { c: number };
    expect(row.c).toBe(0);

    store.close();
  });

  it('migrates a pre-feature database without losing task_posts or activity_events rows', () => {
    const dbPath = tmpDbPath();
    createPreFeatureDb(dbPath);

    const store = new Store(dbPath);

    const taskPost = store.db.prepare(
      `SELECT task_id, request_id, post_count FROM task_posts WHERE source_key = ?`,
    ).get('src-1') as { task_id: string; request_id: string; post_count: number };
    expect(taskPost).toEqual({ task_id: 'task-1', request_id: 'req-1', post_count: 1 });

    const sentinel = store.db.prepare(
      `SELECT kind, request_id FROM activity_events WHERE request_id = ? AND kind = ?`,
    ).get('req-1', 'created') as { kind: string; request_id: string };
    expect(sentinel).toEqual({ kind: 'created', request_id: 'req-1' });

    const tables = (store.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    ).all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain('phase_runs');
    expect(tables).toContain('phase_run_events');

    const phaseRunsCount = store.db.prepare('SELECT COUNT(*) as c FROM phase_runs').get() as { c: number };
    const phaseRunEventsCount = store.db.prepare('SELECT COUNT(*) as c FROM phase_run_events').get() as { c: number };
    expect(phaseRunsCount.c).toBe(0);
    expect(phaseRunEventsCount.c).toBe(0);

    store.phaseRuns().createRun('after-migrate', 'plan');
    expect(store.phaseRuns().getRun('after-migrate')!.revision).toBe(0);

    store.close();
  });

  it('createRun is idempotent; getRun of a nonexistent run is null; events accumulate in order', () => {
    const store = new Store(':memory:');
    const phaseRuns = store.phaseRuns();

    phaseRuns.createRun('run-crud', 'plan');
    phaseRuns.createRun('run-crud', 'plan');

    expect(phaseRuns.getRun('run-crud')!.revision).toBe(0);
    expect(phaseRuns.getRun('run-crud')!.phase).toBe('plan');
    expect(phaseRuns.getRun('nonexistent')).toBeNull();

    phaseRuns.transition('run-crud', 0, { phase: 'a', event: { n: 1 } });
    phaseRuns.transition('run-crud', 1, { phase: 'b', event: { n: 2 } });
    phaseRuns.transition('run-crud', 2, { phase: 'c', event: { n: 3 } });

    expect(phaseRuns.getRun('run-crud')!.events).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

    store.close();
  });

  it('preserves state when a transition omits it', () => {
    const store = new Store(':memory:');
    const phaseRuns = store.phaseRuns();

    phaseRuns.createRun('run-2', 'plan', { foo: 1 });
    phaseRuns.transition('run-2', 0, { phase: 'execute', event: { kind: 'noop' } });

    expect(phaseRuns.getRun('run-2')!.state).toEqual({ foo: 1 });

    store.close();
  });
});
