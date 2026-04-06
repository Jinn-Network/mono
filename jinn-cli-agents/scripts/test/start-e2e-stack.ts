#!/usr/bin/env npx tsx
/**
 * Start local Ponder + Control API with correct env overrides for Tenderly VNet E2E testing.
 *
 * Reads RPC_URL from --rpc-url flag or .env.e2e, then starts Ponder and Control API
 * with PONDER_START_BLOCK near the VNet head to avoid slow indexing.
 *
 * Automatically:
 * - Kills existing processes on ports 42069 and 4001
 * - Cleans stale .ponder cache to avoid pglite conflicts
 * - Loads .env.e2e for RPC_URL (takes priority over .env)
 *
 * Usage:
 *   yarn test:e2e:stack --rpc-url <vnet-admin-rpc>
 *   yarn test:e2e:stack   # reads RPC_URL from .env.e2e
 *
 * Ctrl+C to stop both services.
 */

import dotenv from 'dotenv';
import { promises as fs, writeFileSync, existsSync as fsExistsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { ProcessManager } from '../lib/process-manager.js';

const MONOREPO_ROOT = resolve(import.meta.dirname, '..', '..');
const E2E_ENV_FILE = resolve(MONOREPO_ROOT, '.env.e2e');

// Load env files so child processes (Ponder, Control API) inherit creds.
// .env has Supabase creds, .env.test has Tenderly creds.
// .env.e2e has VNet RPC_URL — but we read it explicitly below, not from process.env.
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env'), quiet: true });
dotenv.config({ path: resolve(MONOREPO_ROOT, '.env.test'), override: true, quiet: true });
const PONDER_CACHE_DIR = resolve(MONOREPO_ROOT, 'ponder', '.ponder');
const PONDER_PORT = '42069';
const CONTROL_PORT = '4001';
const GATEWAY_PORT = '3001';
const GATEWAY_ACL_PATH = resolve(MONOREPO_ROOT, '.env.e2e.acl.json');
const E2E_LOG_DIR = '/tmp/jinn-e2e-logs';

// ─── Credential ACL Database (Docker Postgres) ──────────────────────────────
const E2E_POSTGRES_PORT = '5555';
const E2E_POSTGRES_DB = 'e2e_acl';
const E2E_POSTGRES_PASSWORD = 'e2e';
const E2E_POSTGRES_CONTAINER = 'jinn-e2e-postgres';
const E2E_ACL_DATABASE_URL = `postgresql://postgres:${E2E_POSTGRES_PASSWORD}@localhost:${E2E_POSTGRES_PORT}/${E2E_POSTGRES_DB}`;
// Hardhat account #1 — deterministic admin identity for E2E
const E2E_ADMIN_ADDRESS = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const E2E_ADMIN_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const MIGRATIONS_DIR = resolve(MONOREPO_ROOT, 'services', 'x402-gateway', 'migrations');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const [key, val] = args[i].split('=');
      if (val !== undefined) {
        flags[key.slice(2)] = val;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key.slice(2)] = args[++i];
      }
    }
  }
  return flags;
}

/**
 * Read RPC_URL from .env.e2e file (NOT from process.env which has .env values).
 * Priority: --rpc-url flag > .env.e2e file
 */
async function getRpcUrl(flags: Record<string, string>): Promise<string> {
  if (flags['rpc-url']) return flags['rpc-url'];

  // Read directly from .env.e2e — do NOT trust process.env.RPC_URL
  // because dotenv/config would have loaded .env which has the production URL
  try {
    const envContent = await fs.readFile(E2E_ENV_FILE, 'utf-8');
    const match = envContent.match(/^RPC_URL=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* no file */ }

  throw new Error(
    'No RPC URL found.\n' +
    '  Pass --rpc-url <url>, or run "yarn test:e2e:vnet create" first (writes .env.e2e).\n' +
    '  Note: .env is NOT used (it contains production values).'
  );
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[] = []): Promise<any> {
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!resp.ok) throw new Error(`RPC ${method}: HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

/**
 * Kill any existing process on a port. Returns true if something was killed.
 */
function killPort(port: string): boolean {
  try {
    const pid = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    if (pid) {
      console.log(`  Killing existing process on :${port} (PID ${pid})`);
      execSync(`kill ${pid} 2>/dev/null`);
      // Wait briefly for process to die
      execSync('sleep 1');
      return true;
    }
  } catch { /* no process on port */ }
  return false;
}

/**
 * Clean stale Ponder cache to avoid pglite/sqlite conflicts between runs.
 */
async function cleanPonderCache(): Promise<void> {
  try {
    await fs.access(PONDER_CACHE_DIR);
    console.log('  Cleaning stale .ponder cache...');
    await fs.rm(PONDER_CACHE_DIR, { recursive: true, force: true });
  } catch { /* directory doesn't exist, nothing to clean */ }
}

// ─── Credential ACL Postgres ─────────────────────────────────────────────────

/**
 * Start a Docker Postgres container for E2E credential management tables.
 * Idempotent: reuses an existing healthy container if one is running.
 */
async function startPostgres(): Promise<void> {
  // Verify Docker is available
  try {
    execSync('docker info 2>/dev/null', { stdio: 'pipe' });
  } catch {
    throw new Error(
      'Docker is not running. Start Docker Desktop or the Docker daemon.\n' +
      'Venture permission testing requires Postgres in Docker.',
    );
  }

  // Check if container already running
  try {
    const result = execSync(
      `docker inspect --format='{{.State.Running}}' ${E2E_POSTGRES_CONTAINER} 2>/dev/null`,
      { encoding: 'utf-8' },
    ).trim();
    if (result === 'true' || result === "'true'") {
      console.log(`  Postgres already running (${E2E_POSTGRES_CONTAINER})`);
      return;
    }
  } catch { /* container doesn't exist */ }

  // Remove any stopped container with same name
  try {
    execSync(`docker rm -f ${E2E_POSTGRES_CONTAINER} 2>/dev/null`, { stdio: 'pipe' });
  } catch { /* no container to remove */ }

  console.log(`  Starting Postgres container on :${E2E_POSTGRES_PORT}...`);
  execSync(
    `docker run -d --rm ` +
    `--name ${E2E_POSTGRES_CONTAINER} ` +
    `-p ${E2E_POSTGRES_PORT}:5432 ` +
    `-e POSTGRES_PASSWORD=${E2E_POSTGRES_PASSWORD} ` +
    `-e POSTGRES_DB=${E2E_POSTGRES_DB} ` +
    `postgres:16-alpine`,
    { stdio: 'pipe' },
  );

  // Wait for pg_isready
  const pgStart = Date.now();
  const PG_TIMEOUT_MS = 30_000;
  while (Date.now() - pgStart < PG_TIMEOUT_MS) {
    try {
      execSync(
        `docker exec ${E2E_POSTGRES_CONTAINER} pg_isready -U postgres 2>/dev/null`,
        { stdio: 'pipe' },
      );
      console.log(`  Postgres ready at :${E2E_POSTGRES_PORT}`);
      return;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Postgres failed to become ready within ${PG_TIMEOUT_MS / 1000}s`);
}

/**
 * Run all SQL migrations against the E2E Postgres in order.
 * Uses psql via docker exec to avoid requiring a local psql client.
 */
async function runMigrations(): Promise<void> {
  console.log('  Running credential ACL migrations...');

  const migrationFiles = [
    'create_credential_acl_tables.sql',
    '002_create_audit_log.sql',
    '003_add_audit_attribution_columns.sql',
    '004_credential_management.sql',
    '005_seed_credential_policies.sql',
    '006_simplify_trust_tiers.sql',
    '007_add_allowed_index.sql',
    '008_remove_whitelisted_columns.sql',
  ];

  for (const file of migrationFiles) {
    const filePath = resolve(MIGRATIONS_DIR, file);
    const sql = await fs.readFile(filePath, 'utf-8');
    try {
      execSync(
        `docker exec -i ${E2E_POSTGRES_CONTAINER} ` +
        `psql -U postgres -d ${E2E_POSTGRES_DB} -v ON_ERROR_STOP=1`,
        { input: sql, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err: any) {
      const stderr = err.stderr?.toString() || '';
      // Don't fail on idempotent statements (IF NOT EXISTS, ON CONFLICT, etc.)
      if (stderr.includes('ERROR') && !stderr.includes('already exists')) {
        throw new Error(`Migration ${file} failed: ${stderr.slice(0, 500)}`);
      }
    }
  }
  console.log(`  ${migrationFiles.length} migrations applied`);
}

/**
 * Stop and remove the E2E Postgres container.
 */
function stopPostgres(): void {
  try {
    execSync(`docker rm -f ${E2E_POSTGRES_CONTAINER} 2>/dev/null`, { stdio: 'pipe' });
    console.log('  Postgres container stopped');
  } catch { /* already gone */ }
}

// ─── Exported Library Function ───────────────────────────────────────────────

export interface StartStackResult {
  pm: ProcessManager;
  pids: Map<string, number>;
}

/**
 * Start the E2E local stack (Ponder, Control API, Gateway) and wait for health checks.
 * Returns the ProcessManager and PIDs — caller decides whether to keep-alive or proceed.
 *
 * Can be called directly from e2e-bootstrap.ts or via the CLI entrypoint below.
 */
export async function startStack(rpcUrl: string): Promise<StartStackResult> {
  // Get current VNet block
  console.log('Querying VNet block number...');
  const blockHex = await rpcCall(rpcUrl, 'eth_blockNumber');
  const currentBlock = parseInt(blockHex, 16);
  const startBlock = Math.max(0, currentBlock - 100);

  console.log(`  Current block: ${currentBlock}`);
  console.log(`  Ponder start block: ${startBlock}`);
  console.log(`  RPC URL: ${rpcUrl}`);

  // Pre-flight: kill existing processes, clean cache
  console.log('\nPre-flight checks...');
  killPort(PONDER_PORT);
  killPort(CONTROL_PORT);
  killPort(GATEWAY_PORT);
  stopPostgres(); // Clean up any stale container from previous run
  await cleanPonderCache();

  // Prepare log directory for crash diagnostics
  try {
    await fs.rm(E2E_LOG_DIR, { recursive: true, force: true });
  } catch { /* doesn't exist */ }
  await fs.mkdir(E2E_LOG_DIR, { recursive: true });
  console.log(`  Log dir: ${E2E_LOG_DIR}`);

  // Ensure ACL file exists for the credential gateway (empty grants by default)
  if (!fsExistsSync(GATEWAY_ACL_PATH)) {
    writeFileSync(GATEWAY_ACL_PATH, JSON.stringify({ grants: {}, connections: {} }, null, 2) + '\n');
    console.log(`  Created empty ACL file: ${GATEWAY_ACL_PATH}`);
  }

  // Start Postgres for credential management tables (venture permissions, operators, etc.)
  let postgresReady = false;
  console.log('\nStarting credential ACL database...');
  try {
    await startPostgres();
    await runMigrations();
    postgresReady = true;
  } catch (e: any) {
    console.warn(`  Postgres setup failed: ${e.message}`);
    console.warn('  Venture permission testing will not work (global ACL still available)');
  }

  // Build env overrides for Ponder + Control API
  // Start from a clean env — don't inherit .env values that conflict
  const ponderGraphqlUrl = `http://localhost:${PONDER_PORT}/graphql`;

  const envOverrides: Record<string, string | undefined> = {
    RPC_URL: rpcUrl,
    PONDER_START_BLOCK: String(startBlock),
    PONDER_FACTORY_START_BLOCK: String(startBlock),
    PONDER_PORT: PONDER_PORT,
    PONDER_GRAPHQL_URL: ponderGraphqlUrl,
    PONDER_DATABASE_URL: undefined, // Force SQLite (unset any Railway Postgres)
    BASE_RPC_URL: undefined,        // Unset — Ponder should use RPC_URL
    PONDER_RPC_URL: undefined,      // Unset — Ponder should use RPC_URL
  };

  console.log('\nStarting local stack...\n');

  const pm = new ProcessManager({
    onCrash: (name, code) => {
      console.error(`\n[${name}] crashed with exit code ${code}`);
    },
    onQuotaError: () => {
      console.error('\n[QUOTA] Tenderly quota exhausted — create a new VNet');
    },
  });

  // Start Ponder (uses yarn ponder:dev which handles predev + ponder dev)
  pm.startService({
    name: 'ponder',
    command: 'yarn',
    args: ['ponder:dev'],
    cwd: MONOREPO_ROOT,
    env: envOverrides,
    logDir: E2E_LOG_DIR,
  });

  // Start Control API
  pm.startService({
    name: 'control-api',
    command: 'npx',
    args: ['tsx', 'control-api/server.ts'],
    cwd: MONOREPO_ROOT,
    env: {
      ...envOverrides,
      PORT: CONTROL_PORT,
    },
    logDir: E2E_LOG_DIR,
  });

  // Start x402 Gateway (credential bridge)
  const gatewayEnv: Record<string, string | undefined> = {
    ...envOverrides,
    PORT: GATEWAY_PORT,
    CREDENTIAL_ACL_PATH: GATEWAY_ACL_PATH,    // JSON backend for global grants
    CREDENTIAL_BRIDGE_CONTROL_API_PRIVATE_KEY: E2E_ADMIN_PRIVATE_KEY,  // Signs claim-verification requests to Control API
    PONDER_GRAPHQL_URL: ponderGraphqlUrl,
    // x402 payment verification — production path via CDP facilitator
    GATEWAY_PAYMENT_ADDRESS: process.env.GATEWAY_PAYMENT_ADDRESS || '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    X402_NETWORK: 'base',
    // CDP_API_KEY_ID and CDP_API_KEY_SECRET inherited from process.env (.env file)
    // NOTE: UMAMI_HOST/USERNAME/PASSWORD are intentionally NOT listed here.
    // They reach the gateway via ProcessManager's process.env inheritance,
    // which is the same path production uses. The E2E validates this works.
  };

  // When Postgres is available, enable venture permission tables + admin endpoints
  if (postgresReady) {
    gatewayEnv.ACL_DATABASE_URL = E2E_ACL_DATABASE_URL;
    gatewayEnv.ADMIN_ADDRESSES = E2E_ADMIN_ADDRESS;
  }

  pm.startService({
    name: 'gateway',
    command: 'npx',
    args: ['tsx', 'services/x402-gateway/index.ts'],
    cwd: MONOREPO_ROOT,
    env: gatewayEnv,
    logDir: E2E_LOG_DIR,
  });

  // Wait for Ponder to be healthy
  console.log('Waiting for Ponder to be healthy...');
  try {
    await pm.waitForGraphql({
      url: ponderGraphqlUrl,
      query: '{ _meta { status } }',
      expectedResponse: (data) => !!data?.data,
      timeoutMs: 120_000,
      intervalMs: 3000,
    });
    console.log(`  Ponder ready at :${PONDER_PORT}`);
  } catch (e: any) {
    console.error(`  Ponder failed to start: ${e.message}`);
    await pm.killAll();
    throw e;
  }

  // Wait for Control API to be healthy
  console.log('Waiting for Control API to be healthy...');
  try {
    await pm.waitForGraphql({
      url: `http://localhost:${CONTROL_PORT}/graphql`,
      query: '{ __typename }',
      expectedResponse: (data) => !!data?.data,
      timeoutMs: 30_000,
      intervalMs: 2000,
    });
    console.log(`  Control API ready at :${CONTROL_PORT}`);
  } catch (e: any) {
    console.error(`  Control API failed to start: ${e.message}`);
    await pm.killAll();
    throw e;
  }

  // Wait for Gateway to be healthy
  console.log('Waiting for Gateway to be healthy...');
  try {
    const gatewayUrl = `http://localhost:${GATEWAY_PORT}/health`;
    const gwStart = Date.now();
    while (Date.now() - gwStart < 30_000) {
      try {
        const res = await fetch(gatewayUrl);
        if (res.ok) {
          console.log(`  Gateway ready at :${GATEWAY_PORT}`);
          break;
        }
      } catch { /* not ready yet */ }
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (e: any) {
    console.error(`  Gateway failed to start: ${e.message}`);
    // Non-fatal — gateway is optional for non-credential sessions
    console.log('  (Credential bridge unavailable — credential session will not work)');
  }

  const gwPayAddr = process.env.GATEWAY_PAYMENT_ADDRESS || '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const hasCdp = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);

  // Write service PIDs and log dir to .env.e2e so cleanup can find orphaned processes
  const pids = pm.getPids();
  const pidLines = Array.from(pids.entries())
    .map(([name, pid]) => `E2E_PID_${name.toUpperCase().replace(/-/g, '_')}=${pid}`)
    .join('\n');
  if (pidLines) {
    await fs.appendFile(E2E_ENV_FILE, pidLines + '\n');
  }
  await fs.appendFile(E2E_ENV_FILE, `E2E_LOG_DIR=${E2E_LOG_DIR}\n`);

  // Write credential ACL DB + admin key so permission matrix test can auto-discover them
  if (postgresReady) {
    await fs.appendFile(E2E_ENV_FILE, `E2E_ACL_DATABASE_URL=${E2E_ACL_DATABASE_URL}\n`);
    await fs.appendFile(E2E_ENV_FILE, `E2E_ADMIN_ADDRESS=${E2E_ADMIN_ADDRESS}\n`);
    await fs.appendFile(E2E_ENV_FILE, `E2E_ADMIN_PRIVATE_KEY=${E2E_ADMIN_PRIVATE_KEY}\n`);
  }

  console.log(`\nLocal stack ready.`);
  console.log(`  Ponder:      http://localhost:${PONDER_PORT}/graphql`);
  console.log(`  Control API: http://localhost:${CONTROL_PORT}/graphql`);
  console.log(`  Gateway:     http://localhost:${GATEWAY_PORT} (credential bridge)`);
  console.log(`  ACL file:    ${GATEWAY_ACL_PATH}`);
  if (postgresReady) {
    console.log(`  ACL DB:      ${E2E_ACL_DATABASE_URL}`);
    console.log(`  Admin addr:  ${E2E_ADMIN_ADDRESS}`);
  }
  console.log(`  Payment:     ${gwPayAddr} (CDP: ${hasCdp ? 'enabled' : 'NOT configured — set CDP_API_KEY_ID/SECRET in .env'})`);
  console.log(`  Logs:        ${E2E_LOG_DIR}/`);
  for (const [name, pid] of pids) {
    console.log(`  ${name} PID:  ${pid}`);
  }

  return { pm, pids };
}

// ─── CLI Entrypoint ─────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const rpcUrl = await getRpcUrl(flags);

  const { pm } = await startStack(rpcUrl);

  // SIGINT (Ctrl+C): full cleanup — kill all children and exit
  process.on('SIGINT', async () => {
    console.log('\nShutting down (SIGINT)...');
    await pm.killAll();
    stopPostgres();
    process.exit(0);
  });

  // SIGTERM (Bash tool cleanup, etc.): let detached children survive.
  // Just exit the parent — children keep running on their ports.
  // Next "yarn test:e2e:stack" start kills by port (killPort).
  process.on('SIGTERM', () => {
    console.log('\nParent exiting (SIGTERM) — services continue on their ports.');
    process.exit(0);
  });

  console.log('\nPress Ctrl+C to stop.\n');

  // Keep alive
  await new Promise(() => {});
}

// Only run CLI when executed directly (not when imported as library)
const isDirectRun = process.argv[1]?.includes('start-e2e-stack');
if (isDirectRun) {
  main().catch(e => {
    console.error('FAILED:', e.message || e);
    process.exit(1);
  });
}
