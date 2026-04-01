import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS own_activity (
  request_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('created', 'claimed', 'delivered', 'evaluated'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  desired_state_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE', 'UNKNOWN')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_desired_state ON artifacts (desired_state_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_outcome ON artifacts (outcome);
`;

export class Store {
  private db: Database.Database;
  readonly path: string;

  constructor(dbPath: string) {
    this.path = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  recordOwnActivity(requestId: string, role: 'created' | 'claimed' | 'delivered' | 'evaluated'): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO own_activity (request_id, role) VALUES (?, ?)`
    ).run(requestId, role);
  }

  isOwnActivity(requestId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM own_activity WHERE request_id = ?').get(requestId);
    return row !== undefined;
  }

  setShutdownState(state: 'clean' | 'running'): void {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('shutdown_state', state);
  }

  getShutdownState(): string | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get('shutdown_state') as { value: string } | undefined;
    return row?.value ?? null;
  }

  getLastProcessedBlock(): bigint | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get('last_processed_block') as { value: string } | undefined;
    return row?.value ? BigInt(row.value) : null;
  }

  setLastProcessedBlock(block: bigint): void {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('last_processed_block', block.toString());
  }

  insertArtifact(artifact: {
    id: string;
    desiredStateId: string;
    requestId: string;
    title: string;
    content: string;
    tags: string[];
    outcome: 'SUCCESS' | 'FAILURE' | 'UNKNOWN';
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO artifacts (id, desired_state_id, request_id, title, content, tags, outcome)
      VALUES (@id, @desiredStateId, @requestId, @title, @content, @tags, @outcome)
    `).run({
      ...artifact,
      tags: JSON.stringify(artifact.tags),
    });
  }

  searchArtifacts(query: {
    tags?: string[];
    outcome?: string;
    limit?: number;
  }): Array<{ id: string; title: string; content: string; tags: string[]; outcome: string; created_at: string }> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.outcome) {
      conditions.push('outcome = @outcome');
      params['outcome'] = query.outcome;
    }

    if (query.tags && query.tags.length > 0) {
      for (let i = 0; i < query.tags.length; i++) {
        conditions.push(`tags LIKE @tag${i}`);
        params[`tag${i}`] = `%${query.tags[i]}%`;
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 50;

    const rows = this.db.prepare(
      `SELECT id, title, content, tags, outcome, created_at FROM artifacts ${where} ORDER BY created_at DESC LIMIT ${limit}`
    ).all(params) as Array<{ id: string; title: string; content: string; tags: string; outcome: string; created_at: string }>;

    return rows.map(row => ({
      ...row,
      tags: JSON.parse(row.tags) as string[],
    }));
  }

  close(): void {
    this.db.close();
  }
}
