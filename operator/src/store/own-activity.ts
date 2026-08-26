import type Database from 'better-sqlite3';

export class OwnActivityStore {
  constructor(private readonly db: Database.Database) {}

  record(requestId: string, role: 'created' | 'claimed' | 'delivered' | 'evaluated'): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO own_activity (request_id, role) VALUES (?, ?)`,
    ).run(requestId, role);
  }

  isOwnActivity(requestId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM own_activity WHERE request_id = ?').get(requestId);
    return row !== undefined;
  }

  /** Raw `own_activity` table counts grouped by role. */
  getCounts(): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT role, COUNT(*) as c FROM own_activity GROUP BY role`,
    ).all() as Array<{ role: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.role] = r.c;
    return out;
  }
}
