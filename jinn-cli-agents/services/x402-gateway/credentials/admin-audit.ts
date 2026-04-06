/**
 * Admin Audit Log
 *
 * Records all admin mutations (operator whitelist, grant changes, venture
 * credential updates) with before/after state snapshots.
 *
 * Separate from credential_audit_log (which tracks runtime token access).
 * This tracks administrative configuration changes.
 */

import pg from 'pg';
import type { AdminAuditEntry } from './types.js';
import { normalizeAddress } from './types.js';

const { Pool } = pg;

let pool: InstanceType<typeof Pool> | null = null;

function initPool(): void {
  const url = process.env.AUDIT_DATABASE_URL || process.env.ACL_DATABASE_URL;
  if (url) {
    pool = new Pool({ connectionString: url, max: 3 });
    pool.on('error', (err) => console.error('[admin-audit] Pool error:', err.message));
  }
}

initPool();

/**
 * Write an admin audit entry. Fire-and-forget — never blocks the response.
 */
export function logAdminAudit(entry: AdminAuditEntry): void {
  const logObj = { timestamp: new Date().toISOString(), ...entry };
  console.log(`[admin-audit] ${entry.action}`, JSON.stringify(logObj));

  if (pool) {
    pool.query(
      `INSERT INTO admin_audit_log
       (action, actor_address, target_address, target_venture_id, target_provider,
        before_state, after_state, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.action,
        normalizeAddress(entry.actorAddress),
        entry.targetAddress ? normalizeAddress(entry.targetAddress) : null,
        entry.targetVentureId ?? null,
        entry.targetProvider ?? null,
        entry.beforeState ? JSON.stringify(entry.beforeState) : null,
        entry.afterState ? JSON.stringify(entry.afterState) : null,
        entry.ipAddress ?? null,
      ],
    ).catch((err) => console.error('[admin-audit] DB write failed:', err.message));
  }
}

/**
 * Write an admin audit entry within a transaction (for atomic operations).
 */
export async function logAdminAuditTx(
  client: pg.PoolClient,
  entry: AdminAuditEntry,
): Promise<void> {
  const logObj = { timestamp: new Date().toISOString(), ...entry };
  console.log(`[admin-audit] ${entry.action}`, JSON.stringify(logObj));

  await client.query(
    `INSERT INTO admin_audit_log
     (action, actor_address, target_address, target_venture_id, target_provider,
      before_state, after_state, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.action,
      normalizeAddress(entry.actorAddress),
      entry.targetAddress ? normalizeAddress(entry.targetAddress) : null,
      entry.targetVentureId ?? null,
      entry.targetProvider ?? null,
      entry.beforeState ? JSON.stringify(entry.beforeState) : null,
      entry.afterState ? JSON.stringify(entry.afterState) : null,
      entry.ipAddress ?? null,
    ],
  );
}

/**
 * Query admin audit log entries with filters.
 */
export async function queryAdminAudit(filters: {
  actor?: string;
  target?: string;
  action?: string;
  ventureId?: string;
  limit?: number;
  offset?: number;
}): Promise<(AdminAuditEntry & { id: number; createdAt: string })[]> {
  if (!pool) return [] as (AdminAuditEntry & { id: number; createdAt: string })[];

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.actor) {
    conditions.push(`actor_address = $${idx++}`);
    params.push(normalizeAddress(filters.actor));
  }
  if (filters.target) {
    conditions.push(`target_address = $${idx++}`);
    params.push(normalizeAddress(filters.target));
  }
  if (filters.action) {
    conditions.push(`action = $${idx++}`);
    params.push(filters.action);
  }
  if (filters.ventureId) {
    conditions.push(`target_venture_id = $${idx++}`);
    params.push(filters.ventureId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 1000);
  const offset = Math.min(Math.max(filters.offset ?? 0, 0), 1_000_000);

  const { rows } = await pool.query(
    `SELECT id, action, actor_address, target_address, target_venture_id, target_provider,
            before_state, after_state, ip_address, created_at
     FROM admin_audit_log ${where}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset],
  );

  return rows.map((row: Record<string, unknown>) => ({
    id: row.id as number,
    action: row.action as string,
    actorAddress: row.actor_address as string,
    targetAddress: (row.target_address as string) ?? undefined,
    targetVentureId: (row.target_venture_id as string) ?? undefined,
    targetProvider: (row.target_provider as string) ?? undefined,
    beforeState: row.before_state as Record<string, unknown> | undefined,
    afterState: row.after_state as Record<string, unknown> | undefined,
    ipAddress: (row.ip_address as string) ?? undefined,
    createdAt: (row.created_at as Date).toISOString(),
  }));
}
