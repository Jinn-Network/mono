/**
 * ACL Backend Interface
 *
 * Strategy pattern for credential ACL storage.
 * Implementations: JSON file (dev/testing), Postgres (production).
 */

import type { CredentialGrant, ConnectionEntry } from './types.js';

export interface AclBackend {
  getGrant(address: string, provider: string): Promise<CredentialGrant | null>;
  setGrant(address: string, provider: string, grant: CredentialGrant): Promise<void>;
  revokeGrant(address: string, provider: string): Promise<boolean>;
  listGrants(address: string): Promise<Record<string, CredentialGrant>>;
  getConnection(connectionId: string): Promise<ConnectionEntry | null>;
  setConnection(connectionId: string, entry: ConnectionEntry): Promise<void>;
}
