#!/usr/bin/env npx tsx
/**
 * Local Dev Stack — Anvil Fork + Ponder + Control API
 *
 * Starts a local development environment for fast template iteration
 * without touching the public chain. Forks Base mainnet into Anvil,
 * starts a local Ponder indexer watching the fork, and starts Control API.
 *
 * Architecture:
 *   Anvil (port 8545) ← fork of Base mainnet
 *   Ponder (port 42070) ← indexes events from Anvil
 *   Control API (port 4001) ← job management (uses Supabase)
 *
 * Usage:
 *   yarn dev:local-stack
 *   yarn dev:local-stack --fork-url https://my-private-rpc.example.com
 *   yarn dev:local-stack --anvil-port 8546 --ponder-port 42071
 *
 * Then in another terminal:
 *   source .env.local-stack && yarn dev:mech --single
 *
 * Or explicitly:
 *   RPC_URL=http://127.0.0.1:8545 \
 *   PONDER_GRAPHQL_URL=http://localhost:42070/graphql \
 *   CONTROL_API_URL=http://localhost:4001/graphql \
 *   yarn dev:mech --single
 */

import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { ProcessManager } from './lib/process-manager.js';

const MONOREPO_ROOT = resolve(import.meta.dirname, '..');
const PONDER_CACHE_DIR = resolve(MONOREPO_ROOT, 'ponder', '.ponder');
const LOCAL_STACK_ENV_FILE = resolve(MONOREPO_ROOT, '.env.local-stack');
const LOG_DIR = '/tmp/jinn-local-stack-logs';

// Default ports
const DEFAULT_ANVIL_PORT = '8545';
const DEFAULT_PONDER_PORT = '42070'; // Different from dev default 42069 to avoid conflicts
const DEFAULT_CONTROL_PORT = '4001';

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
      } else {
        flags[key.slice(2)] = 'true';
      }
    }
  }
  return flags;
}

function checkAnvilInstalled(): void {
  try {
    execSync('anvil --version', { encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    throw new Error(
      'Anvil is not installed.\n' +
      '  Install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup\n' +
      '  Docs: https://book.getfoundry.sh/getting-started/installation'
    );
  }
}

function getBaseForkUrl(flags: Record<string, string>): string {
  if (flags['fork-url']) return flags['fork-url'];
  if (process.env.RPC_URL) return process.env.RPC_URL;
  if (process.env.BASE_RPC_URL) return process.env.BASE_RPC_URL;
  return 'https://mainnet.base.org';
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[] = []): Promise<any> {
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`RPC ${method} failed: HTTP ${resp.status} — ${text}`);
  }
  const json = await resp.json();
  if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  return json.result;
}

function killPort(port: string): boolean {
  try {
    const pid = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    if (pid) {
      console.log(`  Killing existing process on :${port} (PID ${pid})`);
      execSync(`kill ${pid} 2>/dev/null`);
      execSync('sleep 1');
      return true;
    }
  } catch { /* no process on port */ }
  return false;
}

async function cleanPonderCache(): Promise<void> {
  try {
    await fs.access(PONDER_CACHE_DIR);
    console.log('  Cleaning stale .ponder cache...');
    await fs.rm(PONDER_CACHE_DIR, { recursive: true, force: true });
  } catch { /* directory doesn't exist */ }
}

async function waitForAnvil(url: string, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const blockHex = await rpcCall(url, 'eth_blockNumber');
      return parseInt(blockHex, 16);
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Anvil failed to start within ${timeoutMs / 1000}s`);
}

async function fundAddress(anvilUrl: string, address: string, ethAmount: number): Promise<void> {
  const weiHex = `0x${(BigInt(ethAmount) * BigInt(10 ** 18)).toString(16)}`;
  await rpcCall(anvilUrl, 'anvil_setBalance', [address, weiHex]);
  console.log(`  Funded ${address} with ${ethAmount} ETH`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const anvilPort = flags['anvil-port'] || DEFAULT_ANVIL_PORT;
  const ponderPort = flags['ponder-port'] || DEFAULT_PONDER_PORT;
  const controlPort = flags['control-port'] || DEFAULT_CONTROL_PORT;

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║              Local Dev Stack (Anvil Fork)               ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // ── Pre-flight ─────────────────────────────────────────────────────────
  console.log('Pre-flight checks...');
  checkAnvilInstalled();
  console.log('  Anvil: installed');

  // Load .env for Supabase creds (Control API needs them)
  dotenv.config({ path: resolve(MONOREPO_ROOT, '.env'), quiet: true });

  const forkUrl = getBaseForkUrl(flags);
  console.log(`  Fork URL: ${forkUrl}`);

  // ── Cleanup ────────────────────────────────────────────────────────────
  console.log('\nCleaning up...');
  killPort(anvilPort);
  killPort(ponderPort);
  killPort(controlPort);
  await cleanPonderCache();

  // Prepare log directory
  try { await fs.rm(LOG_DIR, { recursive: true, force: true }); } catch { /* doesn't exist */ }
  await fs.mkdir(LOG_DIR, { recursive: true });
  console.log(`  Log dir: ${LOG_DIR}`);

  // ── Start ProcessManager ───────────────────────────────────────────────
  const pm = new ProcessManager({
    onCrash: (name, code) => {
      console.error(`\n[${name}] crashed with exit code ${code}`);
      console.error(`  Check logs: ${LOG_DIR}/${name}.log`);
    },
  });

  // ── Start Anvil ────────────────────────────────────────────────────────
  console.log('\nStarting Anvil fork...');
  pm.startService({
    name: 'anvil',
    command: 'anvil',
    args: [
      '--fork-url', forkUrl,
      '--chain-id', '8453',
      '--port', anvilPort,
      '--accounts', '0',
      '--block-time', '2',
      '--silent',
    ],
    cwd: MONOREPO_ROOT,
    env: {},
    logDir: LOG_DIR,
  });

  const anvilUrl = `http://127.0.0.1:${anvilPort}`;
  const currentBlock = await waitForAnvil(anvilUrl, 30_000);
  const startBlock = Math.max(0, currentBlock - 100);
  console.log(`  Anvil ready at :${anvilPort}`);
  console.log(`  Fork block: ${currentBlock}`);
  console.log(`  Ponder start block: ${startBlock}`);

  // ── Fund Safe ──────────────────────────────────────────────────────────
  const safeAddress = flags['safe-address'] || process.env.MECH_SAFE_ADDRESS;
  if (safeAddress) {
    console.log(`\nFunding Safe: ${safeAddress}`);
    await fundAddress(anvilUrl, safeAddress, 100);
  } else {
    console.log('\n  No Safe address provided (use --safe-address or MECH_SAFE_ADDRESS env)');
    console.log('  Fund manually: cast rpc anvil_setBalance <address> 0x56BC75E2D63100000 --rpc-url ' + anvilUrl);
  }

  // ── Start Ponder ───────────────────────────────────────────────────────
  console.log('\nStarting Ponder...');
  const ponderGraphqlUrl = `http://localhost:${ponderPort}/graphql`;

  const envOverrides: Record<string, string | undefined> = {
    RPC_URL: anvilUrl,
    PONDER_START_BLOCK: String(startBlock),
    PONDER_FACTORY_START_BLOCK: '0',  // Bypass factory pattern (indexes all mech addresses)
    PONDER_STAKING_START_BLOCK: String(startBlock), // Skip full staking history scan
    PONDER_FINALITY_BLOCK_COUNT: '0', // Instant indexing (no finality delay on Anvil)
    PONDER_PORT: ponderPort,
    PONDER_GRAPHQL_URL: ponderGraphqlUrl,
    PONDER_DATABASE_URL: undefined,   // Force SQLite (unset any Postgres)
    BASE_RPC_URL: undefined,          // Unset — Ponder should use RPC_URL
    PONDER_RPC_URL: undefined,        // Unset — Ponder should use RPC_URL
  };

  pm.startService({
    name: 'ponder',
    command: 'yarn',
    args: ['ponder:dev'],
    cwd: MONOREPO_ROOT,
    env: envOverrides,
    logDir: LOG_DIR,
  });

  // ── Start Control API ──────────────────────────────────────────────────
  console.log('Starting Control API...');
  pm.startService({
    name: 'control-api',
    command: 'npx',
    args: ['tsx', 'control-api/server.ts'],
    cwd: MONOREPO_ROOT,
    env: {
      ...envOverrides,
      PORT: controlPort,
    },
    logDir: LOG_DIR,
  });

  // ── Health Checks ──────────────────────────────────────────────────────
  console.log('\nWaiting for Ponder to be healthy...');
  try {
    await pm.waitForGraphql({
      url: ponderGraphqlUrl,
      query: '{ _meta { status } }',
      expectedResponse: (data) => !!data?.data,
      timeoutMs: 120_000,
      intervalMs: 3000,
    });
    console.log(`  Ponder ready at :${ponderPort}`);
  } catch (e: any) {
    console.error(`  Ponder failed to start: ${e.message}`);
    console.error(`  Check logs: ${LOG_DIR}/ponder.log`);
    await pm.killAll();
    throw e;
  }

  console.log('Waiting for Control API to be healthy...');
  try {
    await pm.waitForGraphql({
      url: `http://localhost:${controlPort}/graphql`,
      query: '{ __typename }',
      expectedResponse: (data) => !!data?.data,
      timeoutMs: 30_000,
      intervalMs: 2000,
    });
    console.log(`  Control API ready at :${controlPort}`);
  } catch (e: any) {
    console.error(`  Control API failed to start: ${e.message}`);
    console.error(`  Check logs: ${LOG_DIR}/control-api.log`);
    await pm.killAll();
    throw e;
  }

  // ── Write .env.local-stack ─────────────────────────────────────────────
  const controlApiUrl = `http://localhost:${controlPort}/graphql`;
  const envContent = [
    `# Generated by local-dev-stack.ts — ${new Date().toISOString()}`,
    `RPC_URL=${anvilUrl}`,
    `PONDER_GRAPHQL_URL=${ponderGraphqlUrl}`,
    `CONTROL_API_URL=${controlApiUrl}`,
    `PONDER_START_BLOCK=${startBlock}`,
    `PONDER_FACTORY_START_BLOCK=0`,
    `CHAIN_ID=8453`,
  ].join('\n') + '\n';
  await fs.writeFile(LOCAL_STACK_ENV_FILE, envContent);

  // ── Print Summary ──────────────────────────────────────────────────────
  const pids = pm.getPids();

  console.log('\n' + '═'.repeat(60));
  console.log(' Local dev stack ready!');
  console.log('═'.repeat(60));
  console.log(`  Anvil:       ${anvilUrl} (fork block ${currentBlock})`);
  console.log(`  Ponder:      ${ponderGraphqlUrl}`);
  console.log(`  Control API: ${controlApiUrl}`);
  console.log(`  Logs:        ${LOG_DIR}/`);
  console.log(`  Env file:    ${LOCAL_STACK_ENV_FILE}`);
  for (const [name, pid] of pids) {
    console.log(`  ${name} PID:  ${pid}`);
  }

  console.log('\n── 1. Dispatch a Job ───────────────────────────────────');
  console.log(`  RPC_URL=${anvilUrl} CHAIN_ID=8453 \\`);
  console.log(`  PONDER_GRAPHQL_URL=${ponderGraphqlUrl} \\`);
  console.log(`  CONTROL_API_URL=${controlApiUrl} \\`);
  console.log('  tsx scripts/redispatch-job.ts \\');
  console.log('    --jobName "<name>" --jobId "$(uuidgen)" \\');
  console.log('    --template blueprints/<template>.json \\');
  console.log('    --input configs/<config>.json --cyclic');

  console.log('\n── 2. Run Worker ───────────────────────────────────────');
  console.log('  # Target a specific request to bypass staking gate:');
  console.log(`  RPC_URL=${anvilUrl} CHAIN_ID=8453 \\`);
  console.log(`  PONDER_GRAPHQL_URL=${ponderGraphqlUrl} \\`);
  console.log(`  CONTROL_API_URL=${controlApiUrl} \\`);
  console.log('  MECH_TARGET_REQUEST_ID=<request-id-from-dispatch> \\');
  console.log('  yarn dev:mech --single');

  if (safeAddress) {
    console.log('\n── Fund More Addresses ─────────────────────────────────');
    console.log(`  cast rpc anvil_setBalance <address> 0x56BC75E2D63100000 --rpc-url ${anvilUrl}`);
  }

  console.log('\n── Notes ───────────────────────────────────────────────');
  console.log('  Ponder finality is disabled — events appear instantly.');
  console.log('  Staking gate blocks pickup on forked state; use');
  console.log('  MECH_TARGET_REQUEST_ID=<id> to bypass it.');
  console.log('');
  console.log('Press Ctrl+C to stop all services.\n');

  // ── Signal Handling ────────────────────────────────────────────────────
  process.on('SIGINT', async () => {
    console.log('\nShutting down local stack...');
    await pm.killAll();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\nParent exiting — services continue on their ports.');
    console.log(`To stop: kill ${Array.from(pids.values()).join(' ')}`);
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

main().catch(e => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
