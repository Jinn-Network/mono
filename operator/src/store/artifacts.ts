import type Database from 'better-sqlite3';

export class ArtifactsStore {
  /**
   * Legacy schemas predating Task-native IDs (#406) defined `desired_state_id`
   * as `TEXT NOT NULL` on `artifacts`. Newer code only writes `task_id`, which
   * makes inserts revert with "NOT NULL constraint failed: artifacts.desired_state_id"
   * on databases created before the migration. We can't ALTER COLUMN to drop
   * the constraint in SQLite without rebuilding the table, so we detect the
   * legacy column on startup and mirror `task_id` into it from `insertArtifact`.
   */
  private hasLegacyDesiredStateId = false;

  constructor(private readonly db: Database.Database) {}

  runMigrations(): void {
    this.ensureArtifactsTaskColumns();
  }

  /** Older request-first DBs keyed artifacts by desired_state_id before Task-native IDs landed. */
  private ensureArtifactsTaskColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    this.hasLegacyDesiredStateId = names.has('desired_state_id');
    if (!names.has('task_id')) {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN task_id TEXT`);
      if (this.hasLegacyDesiredStateId) {
        this.db.exec(`UPDATE artifacts SET task_id = desired_state_id WHERE task_id IS NULL`);
      }
    }
    if (!names.has('protocol_task_id')) {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN protocol_task_id TEXT`);
    }
    if (!names.has('task_cid')) {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN task_cid TEXT`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts (task_id)`);
  }

  insertArtifact(artifact: {
    id: string;
    taskId: string;
    requestId: string;
    title: string;
    content: string;
    tags: string[];
    outcome: 'SUCCESS' | 'FAILURE' | 'UNKNOWN';
  }): void {
    const columns = ['id', 'task_id', 'request_id', 'title', 'content', 'tags', 'outcome'];
    const values = ['@id', '@taskId', '@requestId', '@title', '@content', '@tags', '@outcome'];
    if (this.hasLegacyDesiredStateId) {
      columns.push('desired_state_id');
      values.push('@taskId');
    }
    this.db.prepare(`
      INSERT OR REPLACE INTO artifacts (${columns.join(', ')})
      VALUES (${values.join(', ')})
    `).run({
      ...artifact,
      tags: JSON.stringify(artifact.tags),
    });
  }

  searchArtifacts(query: {
    tags?: string[];
    outcome?: string;
    requestId?: string;
    taskId?: string;
    after?: string;   // ISO timestamp — only return artifacts created after this time
    before?: string;  // ISO timestamp — only return artifacts created before this time
    limit?: number;
  }): Array<{ id: string; title: string; content: string; tags: string[]; outcome: string; request_id: string; task_id: string; created_at: string }> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (query.outcome) {
      conditions.push('outcome = @outcome');
      params['outcome'] = query.outcome;
    }

    if (query.requestId) {
      conditions.push('request_id = @requestId');
      params['requestId'] = query.requestId;
    }

    if (query.taskId) {
      conditions.push('task_id = @taskId');
      params['taskId'] = query.taskId;
    }

    if (query.after) {
      conditions.push('created_at >= @after');
      params['after'] = query.after;
    }

    if (query.before) {
      conditions.push('created_at <= @before');
      params['before'] = query.before;
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
      `SELECT id, title, content, tags, outcome, request_id, task_id, created_at FROM artifacts ${where} ORDER BY created_at DESC LIMIT ${limit}`
    ).all(params) as Array<{ id: string; title: string; content: string; tags: string; outcome: string; request_id: string; task_id: string; created_at: string }>;

    return rows.map(row => ({
      ...row,
      tags: JSON.parse(row.tags) as string[],
    }));
  }

  /**
   * Text body for a catalog artifact id: local `artifacts.content`, else a peer-cached
   * blob in `network_artifacts` (via `peer_catalog_id`).
   */
  resolveCatalogArtifactContent(id: string): string | null {
    const local = this.db.prepare('SELECT content FROM artifacts WHERE id = ?').get(id) as
      | { content: string | null }
      | undefined;
    if (local?.content != null) return local.content;

    const net = this.db.prepare(
      `SELECT content FROM network_artifacts WHERE peer_catalog_id = ? ORDER BY fetched_at DESC LIMIT 1`,
    ).get(id) as { content: Buffer } | undefined;
    if (!net) return null;
    return net.content.toString('utf-8');
  }

  getArtifactByRequestId(requestId: string, tag: string): { id: string; title: string; content: string; tags: string[]; outcome: string } | null {
    const row = this.db.prepare(
      `SELECT id, title, content, tags, outcome FROM artifacts WHERE request_id = ? AND tags LIKE ? ORDER BY created_at DESC LIMIT 1`
    ).get(requestId, `%${tag}%`) as { id: string; title: string; content: string; tags: string; outcome: string } | undefined;
    if (!row) return null;
    return { ...row, tags: JSON.parse(row.tags) as string[] };
  }
}
