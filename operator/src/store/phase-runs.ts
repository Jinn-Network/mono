import type Database from 'better-sqlite3';

export const PHASE_RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS phase_runs (
  run_key      TEXT PRIMARY KEY,
  phase        TEXT NOT NULL,
  revision     INTEGER NOT NULL DEFAULT 0,
  state_json   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS phase_run_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_key      TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  event_json   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (run_key) REFERENCES phase_runs(run_key)
  -- Note: FK is declarative only -- Store never sets PRAGMA foreign_keys = ON,
  -- so SQLite does not enforce this. Do not rely on it for correctness.
);
CREATE INDEX IF NOT EXISTS idx_phase_run_events_run_key ON phase_run_events (run_key, id);
`;

export class ConcurrentPhaseTransitionError extends Error {
  readonly runKey: string;
  readonly expectedRevision: number;
  constructor(runKey: string, expectedRevision: number) {
    super(`ConcurrentPhaseTransitionError: ${runKey} expected revision=${expectedRevision} but DB row has changed`);
    this.name = 'ConcurrentPhaseTransitionError';
    this.runKey = runKey;
    this.expectedRevision = expectedRevision;
  }
}

export interface PhaseRun {
  runKey: string;
  phase: string;
  revision: number;
  state: unknown;
  events: unknown[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Opaque generator phase persistence (issue #2042). Callers own the phase
 * vocabulary and event shapes -- this store only knows revisions, JSON blobs,
 * and append-only ordering. `transition()` performs a CAS (compare-and-swap)
 * on `revision` and appends its event atomically in the same transaction, so
 * a losing racer never leaves an orphan event row.
 */
export class PhaseRunStore {
  constructor(private readonly db: Database.Database) {}

  createRun(runKey: string, phase: string, state?: unknown): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT OR IGNORE INTO phase_runs (run_key, phase, revision, state_json, created_at, updated_at)
       VALUES (@runKey, @phase, 0, @stateJson, @now, @now)`
    ).run({
      runKey, phase,
      stateJson: state !== undefined ? JSON.stringify(state) : null,
      now,
    });
  }

  transition(
    runKey: string,
    expectedRevision: number,
    next: { phase: string; state?: unknown; event: unknown },
  ): void {
    const tx = this.db.transaction(() => {
      const now = Date.now();
      const setClauses = ['phase = @phase', 'revision = @nextRevision', 'updated_at = @now'];
      const params: Record<string, unknown> = {
        runKey, phase: next.phase, nextRevision: expectedRevision + 1,
        now, expectedRevision,
      };
      if (next.state !== undefined) {
        setClauses.push('state_json = @stateJson');
        params['stateJson'] = JSON.stringify(next.state);
      }
      const result = this.db.prepare(
        `UPDATE phase_runs SET ${setClauses.join(', ')}
         WHERE run_key = @runKey AND revision = @expectedRevision`
      ).run(params);
      if (result.changes === 0) {
        throw new ConcurrentPhaseTransitionError(runKey, expectedRevision);
      }
      this.db.prepare(
        `INSERT INTO phase_run_events (run_key, revision, event_json, created_at)
         VALUES (@runKey, @revision, @eventJson, @now)`
      ).run({ runKey, revision: expectedRevision + 1, eventJson: JSON.stringify(next.event), now });
    });
    tx();
  }

  getRun(runKey: string): PhaseRun | null {
    // Both SELECTs must share one read transaction. Under WAL, a second
    // connection can commit transition() between auto-commit statements and
    // otherwise tear phase/revision from events (WAL multi-statement hazard).
    return this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM phase_runs WHERE run_key = ?`
      ).get(runKey) as Record<string, unknown> | undefined;
      if (!row) return null;
      const eventRows = this.db.prepare(
        `SELECT event_json FROM phase_run_events WHERE run_key = ? ORDER BY id ASC`
      ).all(runKey) as Array<{ event_json: string }>;
      return {
        runKey: row.run_key as string,
        phase: row.phase as string,
        revision: row.revision as number,
        state: row.state_json ? JSON.parse(row.state_json as string) : null,
        events: eventRows.map((r) => JSON.parse(r.event_json)),
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      };
    })();
  }
}
