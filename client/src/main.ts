#!/usr/bin/env node
/**
 * jinn-client production entry point.
 *
 * Bootstraps earning (wallet → Safe → service → staking → mech),
 * then starts the daemon with MechAdapter + ClaudeRunner on Base.
 *
 * Config resolution (highest priority wins):
 *   1. Environment variables (JINN_*, BASE_RPC_URL, BASE_SEPOLIA_RPC_URL)
 *   2. Config file (~/.jinn-client/config.json or --config <path>)
 *   3. Built-in defaults
 *
 * JINN_PASSWORD (env-only) is required for keystore encryption.
 *
 * Usage:
 *   JINN_PASSWORD=secret npm start
 *   JINN_PASSWORD=secret npm start -- --config ./my-config.json
 */

import { config as dotenvConfig } from 'dotenv';
import { Wallet } from 'ethers';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfigPathFromArgs } from './config.js';
import { EarningBootstrapper } from './earning/bootstrap.js';
import { getChainConfig } from './earning/contracts.js';
import { EarningStateStore } from './earning/store.js';
import { MechAdapter } from './adapters/mech/adapter.js';
import { ClaudeRunner } from './runner/claude.js';
import { Daemon } from './daemon/daemon.js';

dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

// ── Password (env-only — never in config files) ────────────────────────────

const PASSWORD: string = (() => {
  const p = process.env['JINN_PASSWORD'];
  if (!p) {
    console.error('Fatal: JINN_PASSWORD environment variable is required.');
    console.error('This password encrypts your agent keystore.');
    process.exit(1);
  }
  return p;
})();

// ── Load config ─────────────────────────────────────────────────────────────

const config = loadConfig(getConfigPathFromArgs());

const NETWORK_CHAIN = config.network === 'testnet' ? 'base-sepolia' : 'base';
const CHAIN_CONFIG = getChainConfig(NETWORK_CHAIN, {
  testnetL2DeploymentPath: config.testnetL2DeploymentPath,
  testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
  testnetMechDeploymentPath: config.testnetMechDeploymentPath,
});
const MARKETPLACE_ADDRESS = CHAIN_CONFIG.mechMarketplace as `0x${string}`;
const ROUTER_ADDRESS = (CHAIN_CONFIG.jinnRouter ?? '0xfFa7118A3D820cd4E820010837D65FAfF463181B') as `0x${string}`;

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function bootstrap(): Promise<{
  agentPrivateKey: `0x${string}`;
  safeAddress: `0x${string}`;
  mechAddress?: `0x${string}`;
}> {
  console.log('[main] Running earning bootstrap...');

  const bootstrapper = new EarningBootstrapper({
    earningDir: config.earningDir,
    chain: NETWORK_CHAIN,
    rpcUrl: config.rpcUrl,
    stakingMode: config.stakingMode,
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    stopAt: (config.network === 'testnet' && CHAIN_CONFIG.mechMarketplace === '0x0000000000000000000000000000000000000000')
      ? 'service_staked'
      : 'complete',
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
  if (!state.safe_address || !state.agent_address) {
    console.error('[main] Bootstrap completed but missing addresses in state.');
    process.exit(1);
  }

  // Load the private key from the keystore
  const store = new EarningStateStore(config.earningDir);
  const keystoreJson = await store.loadKeystore();
  const wallet = await Wallet.fromEncryptedJson(keystoreJson, PASSWORD);

  console.log(`[main] Bootstrap complete.`);
  console.log(`  Agent:   ${state.agent_address}`);
  console.log(`  Safe:    ${state.safe_address}`);
  if (state.mech_address) {
    console.log(`  Mech:    ${state.mech_address}`);
  }
  console.log(`  Service: ${state.service_id}`);

  return {
    agentPrivateKey: wallet.privateKey as `0x${string}`,
    safeAddress: state.safe_address as `0x${string}`,
    mechAddress: state.mech_address ? (state.mech_address as `0x${string}`) : undefined,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[main] jinn-client starting on ${NETWORK_CHAIN}`);

  const { agentPrivateKey, safeAddress, mechAddress } = await bootstrap();

  if (!mechAddress) {
    if (config.network === 'testnet') {
      console.log('[main] No mech marketplace configured for testnet. Bootstrap complete, daemon not started.');
      console.log('[main] To run the daemon, deploy the mech marketplace and set JINN_TESTNET_MECH_DEPLOYMENT.');
      return;
    }
    throw new Error('Bootstrap completed without a mech address. Re-run to deploy the mech.');
  }

  const adapter = new MechAdapter({
    rpcUrl: config.rpcUrl,
    mechMarketplaceAddress: MARKETPLACE_ADDRESS,
    routerAddress: ROUTER_ADDRESS,
    mechContractAddress: mechAddress,
    safeAddress,
    agentEoaPrivateKey: agentPrivateKey,
    ipfsRegistryUrl: config.ipfsRegistryUrl,
    ipfsGatewayUrl: config.ipfsGatewayUrl,
    pollIntervalMs: config.pollIntervalMs,
    chainId: config.network === 'testnet' ? 84532 : 8453,
  });

  const runner = new ClaudeRunner({
    claudePath: config.claudePath,
    model: config.claudeModel,
  });

  const daemon = new Daemon({
    adapter,
    runner,
    desiredStates: config.desiredStates,
    dbPath: config.dbPath,
    apiPort: config.apiPort,
    peers: config.peers.length > 0 ? config.peers : undefined,
    subgraphUrl: config.subgraphUrl,
    nodeEndpoint: config.nodeEndpoint,
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
