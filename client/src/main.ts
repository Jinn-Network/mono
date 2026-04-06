#!/usr/bin/env node
/**
 * jinn-client production entry point.
 *
 * Bootstraps earning (wallet → Safe → service → staking → mech),
 * then starts the daemon with MechAdapter + ClaudeRunner on Base.
 *
 * Required env:
 *   JINN_PASSWORD          — keystore encryption password
 *
 * Optional env:
 *   BASE_RPC_URL           — Base RPC endpoint (default: https://mainnet.base.org)
 *   JINN_EARNING_DIR       — earning state directory (default: ~/.jinn-client/earning)
 *   JINN_DB_PATH           — SQLite database path (default: ~/.jinn-client/jinn.db)
 *   JINN_POLL_INTERVAL_MS  — chain poll interval in ms (default: 5000)
 *   JINN_API_PORT          — HTTP API port (default: 7331)
 *   JINN_CLAUDE_PATH       — path to claude CLI (default: claude)
 *   JINN_CLAUDE_MODEL      — model to use for restoration/evaluation
 *   JINN_PEERS             — comma-separated peer URLs
 *   JINN_SUBGRAPH_URL      — The Graph subgraph for artifact discovery
 *   JINN_DESIRED_STATES    — path to JSON file with desired states array
 *
 * Usage:
 *   JINN_PASSWORD=secret npx tsx src/main.ts
 *   JINN_PASSWORD=secret npm start
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { EarningBootstrapper } from './earning/bootstrap.js';
import { getChainConfig } from './earning/contracts.js';
import { EarningStateStore } from './earning/store.js';
import { MechAdapter } from './adapters/mech/adapter.js';
import { ClaudeRunner } from './runner/claude.js';
import { Daemon } from './daemon/daemon.js';
import { Store } from './store/store.js';
import type { DesiredState } from './types/index.js';

// ── Config from env ─────────────────────────────────────────────────────────

const PASSWORD: string = (() => {
  const p = process.env['JINN_PASSWORD'];
  if (!p) {
    console.error('Fatal: JINN_PASSWORD environment variable is required.');
    console.error('This password encrypts your agent keystore.');
    process.exit(1);
  }
  return p;
})();

const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
const DEFAULT_DIR = join(homedir(), '.jinn-client');
const EARNING_DIR = process.env['JINN_EARNING_DIR'] ?? join(DEFAULT_DIR, 'earning');
const DB_PATH = process.env['JINN_DB_PATH'] ?? join(DEFAULT_DIR, 'jinn.db');
const POLL_INTERVAL_MS = parseInt(process.env['JINN_POLL_INTERVAL_MS'] ?? '5000', 10);
const CLAUDE_PATH = process.env['JINN_CLAUDE_PATH'] ?? 'claude';
const CLAUDE_MODEL = process.env['JINN_CLAUDE_MODEL'] ?? 'claude-haiku-4-5-20251001';

const CHAIN_CONFIG = getChainConfig('base');
const MARKETPLACE_ADDRESS = CHAIN_CONFIG.mechMarketplace as `0x${string}`;
const ROUTER_ADDRESS = '0xfFa7118A3D820cd4E820010837D65FAfF463181B' as const;

// ── Desired states ──────────────────────────────────────────────────────────

function loadDesiredStates(): DesiredState[] {
  const statesPath = process.env['JINN_DESIRED_STATES'];
  if (statesPath) {
    if (!existsSync(statesPath)) {
      console.error(`Fatal: JINN_DESIRED_STATES file not found: ${statesPath}`);
      process.exit(1);
    }
    const raw = readFileSync(statesPath, 'utf-8');
    const parsed = JSON.parse(raw) as DesiredState[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.error('Fatal: JINN_DESIRED_STATES must be a non-empty JSON array.');
      process.exit(1);
    }
    console.log(`[main] Loaded ${parsed.length} desired state(s) from ${statesPath}`);
    return parsed;
  }

  // Default: a single health-check desired state
  return [
    {
      id: 'health-check',
      description: 'The service is running and participating in the Jinn protocol loop.',
    },
  ];
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function bootstrap(): Promise<{
  agentPrivateKey: `0x${string}`;
  safeAddress: `0x${string}`;
  mechAddress: `0x${string}`;
}> {
  console.log('[main] Running earning bootstrap...');

  const bootstrapper = new EarningBootstrapper({
    earningDir: EARNING_DIR,
    chain: 'base',
    rpcUrl: BASE_RPC_URL,
  });

  const result = await bootstrapper.bootstrap(PASSWORD);

  if (result.step === 'awaiting_funding') {
    console.log('\n' + result.message);
    console.log('\nFund the addresses above, then re-run.');
    process.exit(0);
  }

  if (!result.ok) {
    console.error(`[main] Bootstrap failed: ${result.message}`);
    process.exit(1);
  }

  const state = result.earning_state;
  if (!state.safe_address || !state.mech_address || !state.agent_address) {
    console.error('[main] Bootstrap completed but missing addresses in state.');
    process.exit(1);
  }

  // Load the private key from the keystore
  const store = new EarningStateStore(EARNING_DIR);
  const keystoreJson = await store.loadKeystore();
  const wallet = await Wallet.fromEncryptedJson(keystoreJson, PASSWORD);

  console.log(`[main] Bootstrap complete.`);
  console.log(`  Agent:   ${state.agent_address}`);
  console.log(`  Safe:    ${state.safe_address}`);
  console.log(`  Mech:    ${state.mech_address}`);
  console.log(`  Service: ${state.service_id}`);

  return {
    agentPrivateKey: wallet.privateKey as `0x${string}`,
    safeAddress: state.safe_address as `0x${string}`,
    mechAddress: state.mech_address as `0x${string}`,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[main] jinn-client starting on Base');

  const { agentPrivateKey, safeAddress, mechAddress } = await bootstrap();
  const desiredStates = loadDesiredStates();

  const adapter = new MechAdapter({
    rpcUrl: BASE_RPC_URL,
    mechMarketplaceAddress: MARKETPLACE_ADDRESS,
    routerAddress: ROUTER_ADDRESS,
    mechContractAddress: mechAddress,
    safeAddress,
    agentEoaPrivateKey: agentPrivateKey,
    ipfsRegistryUrl: 'https://registry.autonolas.tech',
    ipfsGatewayUrl: 'https://gateway.autonolas.tech',
    pollIntervalMs: POLL_INTERVAL_MS,
    chainId: 8453,
  });

  const runner = new ClaudeRunner({
    claudePath: CLAUDE_PATH,
    model: CLAUDE_MODEL,
  });

  const daemon = new Daemon({
    adapter,
    runner,
    desiredStates,
    dbPath: DB_PATH,
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[main] Received ${signal}, shutting down...`);
    await daemon.stop();
    console.log('[main] Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await daemon.start();
  console.log('[main] Daemon running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});
