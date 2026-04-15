/**
 * Credential Provisioning CLI
 *
 * Registers OAuth connections and grants agent access.
 * The OAuth dance itself is handled by Nango's dashboard or frontend SDK.
 * This CLI manages the ACL that maps agent addresses to Nango connections.
 *
 * Usage:
 *   # Register a connection and grant access
 *   tsx provision.ts grant --agent=0x123... --provider=twitter --connection=conn-xyz --price=0
 *
 *   # Revoke access
 *   tsx provision.ts revoke --agent=0x123... --provider=twitter
 *
 *   # List grants for an address
 *   tsx provision.ts list --agent=0x123...
 *
 *   # Check Nango health
 *   tsx provision.ts health
 */

import 'dotenv/config';
import { setGrant, setConnection, revokeGrant, listGrants, getConnection } from './acl.js';
import { checkNangoHealth, getNangoAccessToken } from './nango-client.js';
import type { CredentialGrant, ConnectionEntry } from './types.js';

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const arg of args) {
    const match = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (match) {
      parsed[match[1]] = match[2];
    }
  }
  return parsed;
}

async function handleGrant(opts: Record<string, string>) {
  const { agent, provider, connection, price, expires, handle, email } = opts;

  if (!agent || !provider || !connection) {
    console.error('Required: --agent=<address> --provider=<name> --connection=<nango-id>');
    process.exit(1);
  }

  // Register connection metadata if not already known
  const existing = await getConnection(connection);
  if (!existing) {
    const metadata: Record<string, string> = {};
    if (handle) metadata.handle = handle;
    if (email) metadata.email = email;

    const entry: ConnectionEntry = { provider, metadata };
    await setConnection(connection, entry);
    console.log(`Registered connection: ${connection} (${provider})`);
  }

  // Verify connection works with Nango
  try {
    const token = await getNangoAccessToken(connection);
    console.log(`Verified: Nango returned token (expires in ${token.expires_in}s)`);
  } catch (err) {
    console.error(`Warning: Could not verify Nango connection: ${err instanceof Error ? err.message : err}`);
    console.error('Proceeding with grant creation anyway (Nango may not be configured yet)');
  }

  // Create grant
  const grant: CredentialGrant = {
    nangoConnectionId: connection,
    pricePerAccess: price || '0',
    expiresAt: expires || null,
    active: true,
  };

  await setGrant(agent, provider, grant);
  console.log(`Granted ${provider} access to ${agent} (price: ${grant.pricePerAccess} wei, expires: ${grant.expiresAt || 'never'})`);
}

async function handleRevoke(opts: Record<string, string>) {
  const { agent, provider } = opts;

  if (!agent || !provider) {
    console.error('Required: --agent=<address> --provider=<name>');
    process.exit(1);
  }

  const success = await revokeGrant(agent, provider);
  if (success) {
    console.log(`Revoked ${provider} access for ${agent}`);
  } else {
    console.error(`No grant found for ${agent} / ${provider}`);
    process.exit(1);
  }
}

async function handleList(opts: Record<string, string>) {
  const { agent } = opts;

  if (!agent) {
    console.error('Required: --agent=<address>');
    process.exit(1);
  }

  const grants = await listGrants(agent);
  const entries = Object.entries(grants);

  if (entries.length === 0) {
    console.log(`No active grants for ${agent}`);
    return;
  }

  console.log(`Grants for ${agent}:`);
  for (const [provider, grant] of entries) {
    const conn = await getConnection(grant.nangoConnectionId);
    const meta = conn?.metadata ? ` (${Object.values(conn.metadata).join(', ')})` : '';
    console.log(`  ${provider}${meta}: connection=${grant.nangoConnectionId}, price=${grant.pricePerAccess} wei, expires=${grant.expiresAt || 'never'}`);
  }
}

async function handleHealth() {
  const healthy = await checkNangoHealth();
  if (healthy) {
    console.log('Nango: healthy');
  } else {
    console.error('Nango: unreachable');
    process.exit(1);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  switch (command) {
    case 'grant':
      await handleGrant(opts);
      break;
    case 'revoke':
      await handleRevoke(opts);
      break;
    case 'list':
      await handleList(opts);
      break;
    case 'health':
      await handleHealth();
      break;
    default:
      console.error('Usage: tsx provision.ts <grant|revoke|list|health> [options]');
      console.error('');
      console.error('Commands:');
      console.error('  grant   --agent=<addr> --provider=<name> --connection=<id> [--price=<wei>] [--expires=<iso>] [--handle=<@name>]');
      console.error('  revoke  --agent=<addr> --provider=<name>');
      console.error('  list    --agent=<addr>');
      console.error('  health');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
