/**
 * ACL Facade
 *
 * Selects backend (JSON file or Postgres) based on environment variables:
 *   - CREDENTIAL_ACL_PATH → JSON file (local dev, E2E tests)
 *   - ACL_DATABASE_URL → Postgres (production, Nango's DB)
 *   - Neither → throws at startup
 */

import { JsonAclBackend } from './acl-json.js';
import { PostgresAclBackend } from './acl-postgres.js';
import type { AclBackend } from './acl-backend.js';

let backend: AclBackend;

const aclPath = process.env.CREDENTIAL_ACL_PATH;
const dbUrl = process.env.ACL_DATABASE_URL;

if (aclPath) {
  backend = new JsonAclBackend(aclPath);
  console.log(`[ACL] JSON backend: ${aclPath}`);
  if (dbUrl) {
    console.log('[ACL] Postgres modules also active (operators, ventures, policies, audit)');
  }
} else if (dbUrl) {
  backend = new PostgresAclBackend(dbUrl);
  console.log('[ACL] Postgres backend');
} else {
  throw new Error('[ACL] Set CREDENTIAL_ACL_PATH or ACL_DATABASE_URL');
}

export const getGrant = backend.getGrant.bind(backend);
export const setGrant = backend.setGrant.bind(backend);
export const revokeGrant = backend.revokeGrant.bind(backend);
export const listGrants = backend.listGrants.bind(backend);
export const getConnection = backend.getConnection.bind(backend);
export const setConnection = backend.setConnection.bind(backend);
