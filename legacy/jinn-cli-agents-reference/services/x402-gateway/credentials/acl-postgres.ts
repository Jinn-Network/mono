/**
 * Postgres ACL Backend
 *
 * Stores credential ACL in Postgres (uses Nango's existing database).
 * Used for production deployment on Railway.
 */

import pg from 'pg';
import type { CredentialGrant, ConnectionEntry } from './types.js';
import type { AclBackend } from './acl-backend.js';

const { Pool } = pg;

export class PostgresAclBackend implements AclBackend {
  private pool: InstanceType<typeof Pool>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  async getGrant(address: string, provider: string): Promise<CredentialGrant | null> {
    const { rows } = await this.pool.query(
      `SELECT nango_connection_id, price_per_access, expires_at, active
       FROM credential_grants
       WHERE address = $1 AND provider = $2 AND active = true`,
      [address.toLowerCase(), provider]
    );

    if (rows.length === 0) return null;

    const row = rows[0];

    // Check expiry
    if (row.expires_at) {
      const expiry = new Date(row.expires_at).getTime();
      if (Date.now() > expiry) return null;
    }

    return {
      nangoConnectionId: row.nango_connection_id,
      pricePerAccess: row.price_per_access,
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      active: row.active,
    };
  }

  async setGrant(address: string, provider: string, grant: CredentialGrant): Promise<void> {
    await this.pool.query(
      `INSERT INTO credential_grants (address, provider, nango_connection_id, price_per_access, expires_at, active)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (address, provider) DO UPDATE SET
         nango_connection_id = EXCLUDED.nango_connection_id,
         price_per_access = EXCLUDED.price_per_access,
         expires_at = EXCLUDED.expires_at,
         active = EXCLUDED.active,
         updated_at = NOW()`,
      [
        address.toLowerCase(),
        provider,
        grant.nangoConnectionId,
        grant.pricePerAccess,
        grant.expiresAt || null,
        grant.active,
      ]
    );
  }

  async revokeGrant(address: string, provider: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE credential_grants SET active = false, updated_at = NOW()
       WHERE address = $1 AND provider = $2 AND active = true`,
      [address.toLowerCase(), provider]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listGrants(address: string): Promise<Record<string, CredentialGrant>> {
    const { rows } = await this.pool.query(
      `SELECT provider, nango_connection_id, price_per_access, expires_at, active
       FROM credential_grants
       WHERE address = $1 AND active = true`,
      [address.toLowerCase()]
    );

    const grants: Record<string, CredentialGrant> = {};
    for (const row of rows) {
      grants[row.provider] = {
        nangoConnectionId: row.nango_connection_id,
        pricePerAccess: row.price_per_access,
        expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
        active: row.active,
      };
    }
    return grants;
  }

  async getConnection(connectionId: string): Promise<ConnectionEntry | null> {
    const { rows } = await this.pool.query(
      `SELECT provider, metadata
       FROM credential_connections
       WHERE connection_id = $1`,
      [connectionId]
    );

    if (rows.length === 0) return null;

    return {
      provider: rows[0].provider,
      metadata: rows[0].metadata || undefined,
    };
  }

  async setConnection(connectionId: string, entry: ConnectionEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO credential_connections (connection_id, provider, metadata)
       VALUES ($1, $2, $3)
       ON CONFLICT (connection_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         metadata = EXCLUDED.metadata`,
      [connectionId, entry.provider, entry.metadata ? JSON.stringify(entry.metadata) : null]
    );
  }
}
