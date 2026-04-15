/**
 * JSON File ACL Backend
 *
 * Reads/writes credential ACL from a JSON file on disk.
 * Used for local development and E2E testing.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CredentialACL, CredentialGrant, ConnectionEntry } from './types.js';
import type { AclBackend } from './acl-backend.js';

export class JsonAclBackend implements AclBackend {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  private load(): CredentialACL {
    if (!existsSync(this.path)) {
      return { connections: {}, grants: {} };
    }
    const raw = readFileSync(this.path, 'utf-8');
    const acl = JSON.parse(raw) as CredentialACL;

    // Normalize grant keys to lowercase for case-insensitive address matching.
    // Addresses may be EIP-55 checksummed when files are written outside setGrant().
    const normalizedGrants: typeof acl.grants = {};
    for (const [addr, grants] of Object.entries(acl.grants)) {
      normalizedGrants[addr.toLowerCase()] = grants;
    }
    acl.grants = normalizedGrants;

    return acl;
  }

  private save(acl: CredentialACL): void {
    const dir = resolve(this.path, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.path, JSON.stringify(acl, null, 2) + '\n', 'utf-8');
  }

  async getGrant(address: string, provider: string): Promise<CredentialGrant | null> {
    const acl = this.load();
    const normalized = address.toLowerCase();
    const agentGrants = acl.grants[normalized];
    if (!agentGrants) return null;

    const grant = agentGrants[provider];
    if (!grant) return null;
    if (!grant.active) return null;

    if (grant.expiresAt) {
      const expiry = new Date(grant.expiresAt).getTime();
      if (Date.now() > expiry) return null;
    }

    return grant;
  }

  async getConnection(connectionId: string): Promise<ConnectionEntry | null> {
    const acl = this.load();
    return acl.connections[connectionId] || null;
  }

  async setGrant(address: string, provider: string, grant: CredentialGrant): Promise<void> {
    const acl = this.load();
    const normalized = address.toLowerCase();
    if (!acl.grants[normalized]) {
      acl.grants[normalized] = {};
    }
    acl.grants[normalized][provider] = grant;
    this.save(acl);
  }

  async setConnection(connectionId: string, entry: ConnectionEntry): Promise<void> {
    const acl = this.load();
    acl.connections[connectionId] = entry;
    this.save(acl);
  }

  async revokeGrant(address: string, provider: string): Promise<boolean> {
    const acl = this.load();
    const normalized = address.toLowerCase();
    const agentGrants = acl.grants[normalized];
    if (!agentGrants || !agentGrants[provider]) return false;

    agentGrants[provider].active = false;
    this.save(acl);
    return true;
  }

  async listGrants(address: string): Promise<Record<string, CredentialGrant>> {
    const acl = this.load();
    const normalized = address.toLowerCase();
    const agentGrants = acl.grants[normalized] || {};
    const active: Record<string, CredentialGrant> = {};
    for (const [provider, grant] of Object.entries(agentGrants)) {
      if (grant.active) {
        active[provider] = grant;
      }
    }
    return active;
  }
}
