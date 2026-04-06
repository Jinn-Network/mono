/**
 * Operator Management
 *
 * CRUD for registered operators with trust tier calculation and
 * transaction-wrapped auto-provisioning of credential grants.
 *
 * Trust tier: determined by tier_override (admin-set), defaults to 'untrusted'.
 */

import pg from 'pg';
import type { Operator, TrustTier } from './types.js';
import { tierMeetsMinimum, normalizeAddress, TRUST_TIER_ORDER } from './types.js';
import { listPoliciesTx } from './policies.js';
import { logAdminAuditTx } from './admin-audit.js';

const { Pool } = pg;

let pool: InstanceType<typeof Pool> | null = null;

export function initOperatorsDb(connectionString: string): void {
  pool = new Pool({ connectionString, max: 5 });
  pool.on('error', (err) => console.error('[operators] Pool error:', err.message));
}

// Auto-init from env
const dbUrl = process.env.ACL_DATABASE_URL;
if (dbUrl) initOperatorsDb(dbUrl);

function getPool(): InstanceType<typeof Pool> {
  if (!pool) throw new Error('Operators database not configured (ACL_DATABASE_URL)');
  return pool;
}

function rowToOperator(row: Record<string, unknown>): Operator {
  return {
    address: row.address as string,
    serviceId: row.service_id != null ? Number(row.service_id) : null,
    trustTier: row.trust_tier as TrustTier,
    tierOverride: (row.tier_override as TrustTier) ?? null,
    registeredAt: (row.registered_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/**
 * Calculate the effective trust tier for an operator.
 */
export function calculateTrustTier(op: {
  tierOverride: TrustTier | null;
}): TrustTier {
  if (op.tierOverride && TRUST_TIER_ORDER.includes(op.tierOverride)) return op.tierOverride;
  return 'untrusted';
}

export async function getOperator(address: string): Promise<Operator | null> {
  const p = getPool();
  const { rows } = await p.query(
    'SELECT * FROM operators WHERE address = $1',
    [normalizeAddress(address)],
  );
  return rows[0] ? rowToOperator(rows[0]) : null;
}

export async function listOperators(filters?: {
  trustTier?: TrustTier;
  limit?: number;
  offset?: number;
}): Promise<Operator[]> {
  const p = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters?.trustTier) {
    conditions.push(`trust_tier = $${idx++}`);
    params.push(filters.trustTier);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  const { rows } = await p.query(
    `SELECT * FROM operators ${where} ORDER BY registered_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset],
  );
  return rows.map(rowToOperator);
}

/**
 * Register a new operator (self-service or admin).
 * If the operator already exists, updates and recalculates tier.
 */
export async function registerOperator(params: {
  address: string;
  serviceId?: number;
  actorAddress: string;
  ipAddress?: string;
}): Promise<{ operator: Operator; grantsAdded: string[]; grantsRevoked: string[] }> {
  const p = getPool();
  const addr = normalizeAddress(params.address);
  const client = await p.connect();

  try {
    await client.query('BEGIN');

    // Get existing state for audit
    const { rows: existing } = await client.query(
      'SELECT * FROM operators WHERE address = $1 FOR UPDATE',
      [addr],
    );
    const beforeState = existing[0] ? rowToOperator(existing[0]) : null;

    // Upsert operator
    const { rows } = await client.query(
      `INSERT INTO operators (address, service_id, trust_tier)
       VALUES ($1, $2, $3)
       ON CONFLICT (address) DO UPDATE SET
         service_id = COALESCE(EXCLUDED.service_id, operators.service_id),
         updated_at = NOW()
       RETURNING *`,
      [
        addr,
        params.serviceId ?? null,
        'untrusted', // Initial tier, recalculated below
      ],
    );

    const opRow = rows[0];
    const newTier = calculateTrustTier({
      tierOverride: opRow.tier_override,
    });

    // Update tier if changed
    if (opRow.trust_tier !== newTier) {
      await client.query(
        'UPDATE operators SET trust_tier = $1, updated_at = NOW() WHERE address = $2',
        [newTier, addr],
      );
      opRow.trust_tier = newTier;
    }

    // Auto-provision grants based on new tier
    const { added, revoked } = await autoProvision(client, addr, newTier, params.actorAddress);

    const afterState = rowToOperator(opRow);

    await logAdminAuditTx(client, {
      action: beforeState ? 'operator.update' : 'operator.register',
      actorAddress: params.actorAddress,
      targetAddress: addr,
      beforeState: beforeState as unknown as Record<string, unknown>,
      afterState: { ...afterState as unknown as Record<string, unknown>, grantsAdded: added, grantsRevoked: revoked },
      ipAddress: params.ipAddress,
    });

    await client.query('COMMIT');

    return { operator: afterState, grantsAdded: added, grantsRevoked: revoked };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Admin: set tier override for an operator.
 * Recalculates tier and auto-provisions/revokes grants in a transaction.
 */
export async function updateOperatorAdmin(params: {
  address: string;
  tierOverride?: TrustTier | null;
  actorAddress: string;
  ipAddress?: string;
}): Promise<{ operator: Operator; grantsAdded: string[]; grantsRevoked: string[] }> {
  const p = getPool();
  const addr = normalizeAddress(params.address);
  const client = await p.connect();

  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      'SELECT * FROM operators WHERE address = $1 FOR UPDATE',
      [addr],
    );

    if (!existing[0]) {
      throw new Error(`Operator ${addr} not registered`);
    }

    const beforeState = rowToOperator(existing[0]);
    const updates: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;

    if (params.tierOverride !== undefined) {
      updates.push(`tier_override = $${idx++}`);
      values.push(params.tierOverride);
    }

    values.push(addr);

    const { rows } = await client.query(
      `UPDATE operators SET ${updates.join(', ')} WHERE address = $${idx} RETURNING *`,
      values,
    );

    const opRow = rows[0];
    const newTier = calculateTrustTier({
      tierOverride: opRow.tier_override,
    });

    if (opRow.trust_tier !== newTier) {
      await client.query(
        'UPDATE operators SET trust_tier = $1, updated_at = NOW() WHERE address = $2',
        [newTier, addr],
      );
      opRow.trust_tier = newTier;
    }

    const { added, revoked } = await autoProvision(client, addr, newTier, params.actorAddress);

    const afterState = rowToOperator(opRow);

    await logAdminAuditTx(client, {
      action: 'operator.admin_update',
      actorAddress: params.actorAddress,
      targetAddress: addr,
      beforeState: beforeState as unknown as Record<string, unknown>,
      afterState: { ...afterState as unknown as Record<string, unknown>, grantsAdded: added, grantsRevoked: revoked },
      ipAddress: params.ipAddress,
    });

    await client.query('COMMIT');

    return { operator: afterState, grantsAdded: added, grantsRevoked: revoked };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Auto-provision or revoke credential grants based on trust tier.
 *
 * Rules:
 * - Only auto-provisions grants where policy.autoGrant = true AND !requiresApproval
 * - Only auto-revokes grants that were auto_provisioned = true
 * - Manual admin grants are never auto-revoked
 */
async function autoProvision(
  client: pg.PoolClient,
  address: string,
  newTier: TrustTier,
  provisionedBy: string,
): Promise<{ added: string[]; revoked: string[] }> {
  const policies = await listPoliciesTx(client);
  const added: string[] = [];
  const revoked: string[] = [];

  // Get current grants
  const { rows: grantRows } = await client.query(
    'SELECT provider, active, auto_provisioned FROM credential_grants WHERE address = $1',
    [address],
  );
  const currentGrants = new Map(
    grantRows.map((r: Record<string, unknown>) => [r.provider as string, {
      active: r.active as boolean,
      autoProvisioned: r.auto_provisioned as boolean,
    }]),
  );

  for (const policy of policies) {
    const grant = currentGrants.get(policy.provider);
    const hasActiveGrant = grant?.active === true;
    const isAutoProvisioned = grant?.autoProvisioned === true;
    const tierMet = tierMeetsMinimum(newTier, policy.minTrustTier);

    if (tierMet && policy.autoGrant && !policy.requiresApproval && !hasActiveGrant) {
      // Grant access
      await client.query(
        `INSERT INTO credential_grants
         (address, provider, nango_connection_id, price_per_access, active, auto_provisioned, provisioned_by, trust_tier_at_grant)
         VALUES ($1, $2, $3, $4, true, true, $5, $6)
         ON CONFLICT (address, provider) DO UPDATE SET
           nango_connection_id = EXCLUDED.nango_connection_id,
           price_per_access = EXCLUDED.price_per_access,
           active = true,
           auto_provisioned = true,
           provisioned_by = EXCLUDED.provisioned_by,
           trust_tier_at_grant = EXCLUDED.trust_tier_at_grant,
           updated_at = NOW()`,
        [
          address,
          policy.provider,
          policy.defaultNangoConnection ?? policy.provider,
          policy.defaultPrice,
          normalizeAddress(provisionedBy),
          newTier,
        ],
      );
      added.push(policy.provider);
    } else if (!tierMet && isAutoProvisioned && hasActiveGrant) {
      // Revoke auto-provisioned grant (manual grants are never auto-revoked)
      await client.query(
        `UPDATE credential_grants SET active = false, updated_at = NOW()
         WHERE address = $1 AND provider = $2 AND auto_provisioned = true`,
        [address, policy.provider],
      );
      revoked.push(policy.provider);
    }
  }

  return { added, revoked };
}
