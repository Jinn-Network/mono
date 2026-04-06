/**
 * Credential Policies
 *
 * Global rules for auto-provisioning credentials to operators.
 * Each policy maps a provider to a minimum trust tier and auto-grant rules.
 *
 * When a policy changes, all operators are re-evaluated (in a transaction).
 */

import pg from 'pg';
import type { CredentialPolicy, TrustTier } from './types.js';

const { Pool } = pg;

let pool: InstanceType<typeof Pool> | null = null;

export function initPoliciesDb(connectionString: string): void {
  pool = new Pool({ connectionString, max: 5 });
  pool.on('error', (err) => console.error('[policies] Pool error:', err.message));
}

// Auto-init from env
const dbUrl = process.env.ACL_DATABASE_URL;
if (dbUrl) initPoliciesDb(dbUrl);

function rowToPolicy(row: Record<string, unknown>): CredentialPolicy {
  return {
    provider: row.provider as string,
    minTrustTier: row.min_trust_tier as TrustTier,
    autoGrant: row.auto_grant as boolean,
    requiresApproval: row.requires_approval as boolean,
    defaultPrice: row.default_price as string,
    defaultNangoConnection: (row.default_nango_connection as string) ?? null,
    maxRequestsPerMinute: row.max_requests_per_minute as number,
    metadata: row.metadata as Record<string, unknown> | null,
  };
}

export async function getPolicy(provider: string): Promise<CredentialPolicy | null> {
  if (!pool) return null;
  const { rows } = await pool.query(
    'SELECT * FROM credential_policies WHERE provider = $1',
    [provider],
  );
  return rows[0] ? rowToPolicy(rows[0]) : null;
}

export async function listPolicies(): Promise<CredentialPolicy[]> {
  if (!pool) return [];
  const { rows } = await pool.query('SELECT * FROM credential_policies ORDER BY provider');
  return rows.map(rowToPolicy);
}

export async function upsertPolicy(policy: CredentialPolicy): Promise<CredentialPolicy> {
  if (!pool) throw new Error('Database not configured');
  const { rows } = await pool.query(
    `INSERT INTO credential_policies
     (provider, min_trust_tier, auto_grant, requires_approval, default_price,
      default_nango_connection, max_requests_per_minute, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (provider) DO UPDATE SET
       min_trust_tier = EXCLUDED.min_trust_tier,
       auto_grant = EXCLUDED.auto_grant,
       requires_approval = EXCLUDED.requires_approval,
       default_price = EXCLUDED.default_price,
       default_nango_connection = EXCLUDED.default_nango_connection,
       max_requests_per_minute = EXCLUDED.max_requests_per_minute,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      policy.provider,
      policy.minTrustTier,
      policy.autoGrant,
      policy.requiresApproval,
      policy.defaultPrice,
      policy.defaultNangoConnection,
      policy.maxRequestsPerMinute,
      policy.metadata ? JSON.stringify(policy.metadata) : null,
    ],
  );
  return rowToPolicy(rows[0]);
}

/**
 * Get all policies within a transaction (for auto-provisioning).
 */
export async function listPoliciesTx(client: pg.PoolClient): Promise<CredentialPolicy[]> {
  const { rows } = await client.query('SELECT * FROM credential_policies ORDER BY provider');
  return rows.map(rowToPolicy);
}

/**
 * Get the pool for transaction use in operators.ts.
 */
export function getPoliciesPool(): InstanceType<typeof Pool> | null {
  return pool;
}
