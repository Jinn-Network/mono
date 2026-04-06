/**
 * Venture-Scoped Credentials
 *
 * Venture owners register their OAuth connections and control which operators
 * can access them via whitelist/blocklist and minimum trust tier gates.
 *
 * Access resolution:
 * 1. Check blocklist → DENY (even if tier-qualified)
 * 2. Check whitelist → ALLOW
 * 3. Check tier → ALLOW if meets minimum
 * 4. Otherwise → DENY
 *
 * access_mode controls global fallback:
 * - 'venture_only': No global grant fallback for this provider in this venture's workstream
 * - 'union_with_global': If venture denies, global grants are checked as fallback
 */

import pg from 'pg';
import type {
  VentureCredential,
  VentureCredentialOperator,
  TrustTier,
  AccessMode,
} from './types.js';
import { tierMeetsMinimum, normalizeAddress } from './types.js';

const { Pool } = pg;

let pool: InstanceType<typeof Pool> | null = null;

export function initVentureCredentialsDb(connectionString: string): void {
  pool = new Pool({ connectionString, max: 5 });
  pool.on('error', (err) => console.error('[venture-credentials] Pool error:', err.message));
}

// Auto-init from env
const dbUrl = process.env.ACL_DATABASE_URL;
if (dbUrl) initVentureCredentialsDb(dbUrl);

function getPool(): InstanceType<typeof Pool> {
  if (!pool) throw new Error('Venture credentials database not configured (ACL_DATABASE_URL)');
  return pool;
}

function rowToVentureCredential(row: Record<string, unknown>): VentureCredential {
  return {
    ventureId: row.venture_id as string,
    provider: row.provider as string,
    nangoConnectionId: (row.nango_connection_id as string) ?? null,
    minTrustTier: row.min_trust_tier as TrustTier,
    accessMode: row.access_mode as AccessMode,
    pricePerAccess: row.price_per_access as string,
    active: row.active as boolean,
  };
}

function rowToOperatorEntry(row: Record<string, unknown>): VentureCredentialOperator {
  return {
    ventureId: row.venture_id as string,
    provider: row.provider as string,
    operatorAddress: row.operator_address as string,
    status: row.status as 'allowed' | 'blocked',
    grantedBy: row.granted_by as string,
    grantedAt: (row.granted_at as Date).toISOString(),
  };
}

// ============================================================
// Venture Credential CRUD
// ============================================================

export async function getVentureCredential(
  ventureId: string,
  provider: string,
): Promise<VentureCredential | null> {
  const p = getPool();
  const { rows } = await p.query(
    'SELECT * FROM venture_credentials WHERE venture_id = $1 AND provider = $2',
    [ventureId, provider],
  );
  return rows[0] ? rowToVentureCredential(rows[0]) : null;
}

export async function listVentureCredentials(ventureId: string): Promise<VentureCredential[]> {
  const p = getPool();
  const { rows } = await p.query(
    'SELECT * FROM venture_credentials WHERE venture_id = $1 AND active = true ORDER BY provider',
    [ventureId],
  );
  return rows.map(rowToVentureCredential);
}

export async function upsertVentureCredential(vc: VentureCredential): Promise<VentureCredential> {
  const p = getPool();
  const { rows } = await p.query(
    `INSERT INTO venture_credentials
     (venture_id, provider, nango_connection_id, min_trust_tier, access_mode, price_per_access, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (venture_id, provider) DO UPDATE SET
       nango_connection_id = EXCLUDED.nango_connection_id,
       min_trust_tier = EXCLUDED.min_trust_tier,
       access_mode = EXCLUDED.access_mode,
       price_per_access = EXCLUDED.price_per_access,
       active = EXCLUDED.active,
       updated_at = NOW()
     RETURNING *`,
    [
      vc.ventureId,
      vc.provider,
      vc.nangoConnectionId,
      vc.minTrustTier,
      vc.accessMode,
      vc.pricePerAccess,
      vc.active,
    ],
  );
  return rowToVentureCredential(rows[0]);
}

// ============================================================
// Operator Whitelist / Blocklist
// ============================================================

export async function setOperatorStatus(params: {
  ventureId: string;
  provider: string;
  operatorAddress: string;
  status: 'allowed' | 'blocked';
  grantedBy: string;
}): Promise<VentureCredentialOperator> {
  const p = getPool();
  const { rows } = await p.query(
    `INSERT INTO venture_credential_operators
     (venture_id, provider, operator_address, status, granted_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (venture_id, provider, operator_address) DO UPDATE SET
       status = EXCLUDED.status,
       granted_by = EXCLUDED.granted_by,
       granted_at = NOW()
     RETURNING *`,
    [
      params.ventureId,
      params.provider,
      normalizeAddress(params.operatorAddress),
      params.status,
      normalizeAddress(params.grantedBy),
    ],
  );
  return rowToOperatorEntry(rows[0]);
}

export async function removeOperatorEntry(
  ventureId: string,
  provider: string,
  operatorAddress: string,
): Promise<boolean> {
  const p = getPool();
  const result = await p.query(
    `DELETE FROM venture_credential_operators
     WHERE venture_id = $1 AND provider = $2 AND operator_address = $3`,
    [ventureId, provider, normalizeAddress(operatorAddress)],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listOperatorEntries(
  ventureId: string,
  provider: string,
): Promise<VentureCredentialOperator[]> {
  const p = getPool();
  const { rows } = await p.query(
    `SELECT * FROM venture_credential_operators
     WHERE venture_id = $1 AND provider = $2
     ORDER BY granted_at DESC`,
    [ventureId, provider],
  );
  return rows.map(rowToOperatorEntry);
}

// ============================================================
// Access Resolution
// ============================================================

export interface VentureAccessResult {
  allowed: boolean;
  reason: 'blocked' | 'whitelisted' | 'tier_met' | 'tier_not_met' | 'no_credential';
  ventureCredential?: VentureCredential;
  /** If venture_only, global fallback should be skipped */
  blockGlobalFallback: boolean;
}

/**
 * Check if an operator can access a venture-scoped credential.
 *
 * Returns access decision + whether global fallback should be blocked.
 */
export async function checkVentureAccess(params: {
  ventureId: string;
  provider: string;
  operatorAddress: string;
  operatorTrustTier: TrustTier;
}): Promise<VentureAccessResult> {
  const vc = await getVentureCredential(params.ventureId, params.provider);

  if (!vc || !vc.active) {
    return { allowed: false, reason: 'no_credential', blockGlobalFallback: false };
  }

  const blockGlobal = vc.accessMode === 'venture_only';

  // Check blocklist
  const p = getPool();
  const { rows: blockedRows } = await p.query(
    `SELECT 1 FROM venture_credential_operators
     WHERE venture_id = $1 AND provider = $2 AND operator_address = $3 AND status = 'blocked'`,
    [params.ventureId, params.provider, normalizeAddress(params.operatorAddress)],
  );
  if (blockedRows.length > 0) {
    return { allowed: false, reason: 'blocked', ventureCredential: vc, blockGlobalFallback: blockGlobal };
  }

  // Check whitelist
  const { rows: allowedRows } = await p.query(
    `SELECT 1 FROM venture_credential_operators
     WHERE venture_id = $1 AND provider = $2 AND operator_address = $3 AND status = 'allowed'`,
    [params.ventureId, params.provider, normalizeAddress(params.operatorAddress)],
  );
  if (allowedRows.length > 0) {
    return { allowed: true, reason: 'whitelisted', ventureCredential: vc, blockGlobalFallback: blockGlobal };
  }

  // Check trust tier
  if (tierMeetsMinimum(params.operatorTrustTier, vc.minTrustTier)) {
    return { allowed: true, reason: 'tier_met', ventureCredential: vc, blockGlobalFallback: blockGlobal };
  }

  return { allowed: false, reason: 'tier_not_met', ventureCredential: vc, blockGlobalFallback: blockGlobal };
}
