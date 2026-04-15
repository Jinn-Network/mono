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
 * Canonical operator command:
 *   npx jinn run
 */

import { config as dotenvConfig } from 'dotenv';
import { JsonRpcProvider } from 'ethers';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, getConfigPathFromArgs } from './config.js';
import { formatBootstrapOperatorMessage } from './operator-errors.js';
import { emitEnvelope } from './errors/envelope.js';
import { checkClaudeBinary } from './preflight/claude-binary.js';
import { emitClaudeBinaryPreflightFailure } from './preflight/claude-invocation-envelope.js';
import { FleetBootstrapper } from './earning/bootstrap.js';
import { getChainConfig } from './earning/contracts.js';
import { FleetStateStore } from './earning/store.js';
import type { FleetState, ServiceState, ServiceStep } from './earning/types.js';
import { decryptMnemonic, deriveAgentSigner, deriveMasterSigner } from './earning/wallet.js';
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
  testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
});
const MARKETPLACE_ADDRESS = CHAIN_CONFIG.mechMarketplace as `0x${string}`;
const ROUTER_ADDRESS = (CHAIN_CONFIG.jinnRouter ?? '0xfFa7118A3D820cd4E820010837D65FAfF463181B') as `0x${string}`;

const STANDARD_SERVICE_PROGRESSION: readonly ServiceStep[] = [
  'awaiting_stake',
  'staked',
  'mech_deployed',
  'complete',
];

const SELF_BOND_SERVICE_PROGRESSION: readonly ServiceStep[] = [
  'awaiting_stake',
  'service_created',
  'service_activated',
  'agents_registered',
  'service_deployed',
  'service_staked',
  'mech_deployed',
  'complete',
];

/** §6.2 `bootstrap_incomplete` — `{ currentStep, nextStep }` from persisted fleet state. */
function bootstrapIncompleteSteps(state: FleetState): { currentStep: string; nextStep: string } {
  const progression =
    state.staking_mode === 'self-bond'
      ? SELF_BOND_SERVICE_PROGRESSION
      : STANDARD_SERVICE_PROGRESSION;
  const byIndex = [...state.services].sort((a, b) => a.index - b.index);
  const focus: ServiceState | undefined =
    byIndex.find(s => s.step === 'complete' && !s.safe_address) ??
    byIndex.find(s => s.step !== 'complete') ??
    byIndex[0];

  if (!focus) {
    return { currentStep: 'awaiting_service', nextStep: 'awaiting_stake' };
  }
  if (focus.step === 'complete' && !focus.safe_address) {
    return { currentStep: 'complete', nextStep: 'bootstrap' };
  }
  const i = progression.indexOf(focus.step);
  if (i === -1) {
    return { currentStep: focus.step, nextStep: 'bootstrap' };
  }
  if (i < progression.length - 1) {
    return { currentStep: focus.step, nextStep: progression[i + 1]! };
  }
  return { currentStep: focus.step, nextStep: 'bootstrap' };
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function bootstrap(): Promise<{
  masterAddress: `0x${string}`;
  serviceIndex: number;
  serviceId: number | null;
  agentPrivateKey: `0x${string}`;
  safeAddress: `0x${string}`;
  mechAddress?: `0x${string}`;
}> {
  console.log('[main] Running fleet bootstrap...');

  const bootstrapper = new FleetBootstrapper({
    earningDir: config.earningDir,
    chain: NETWORK_CHAIN,
    rpcUrl: config.rpcUrl,
    stakingMode: config.stakingMode,
    targetServices: config.targetServices,
    testnetL2DeploymentPath: config.testnetL2DeploymentPath,
    testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
    testnetMechDeploymentPath: config.testnetMechDeploymentPath,
    testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    debug: config.debug,
    masterEthDailyEstimateWei: config.masterEthDailyEstimateWei,
    pollIntervalMs: config.pollIntervalMs,
  });

  const result = await bootstrapper.bootstrap(PASSWORD);

  if (result.funding) {
    emitEnvelope({
      code: 'funding_required',
      message: result.message,
      hint: 'Fund the listed address and re-run this command.',
      exampleCli: 'jinn fund-requirements --json',
      details: {
        role: 'master',
        address: result.funding.master_address,
        asset: 'native',
        needWei: result.funding.eth_required,
        haveWei: result.funding.eth_balance,
      },
    });
  }

  if (!result.ok) {
    emitEnvelope({
      code: 'fatal',
      message: result.message,
      hint: 'Bootstrap failed before the fleet reached a runnable state.',
      details: { cause: result.message },
    });
  }

  // Use the first complete service for the daemon
  const state = result.fleet_state;
  const firstComplete = state.services.find(s => s.step === 'complete');
  if (!firstComplete || !firstComplete.safe_address) {
    emitEnvelope({
      code: 'bootstrap_incomplete',
      message: 'Bootstrap completed but no service is ready.',
      hint: 'Re-run to continue the state machine toward a running fleet.',
      exampleCli: 'jinn bootstrap --json',
      details: bootstrapIncompleteSteps(state),
    });
  }

  // Derive agent private key from mnemonic
  const store = new FleetStateStore(config.earningDir);
  const mnemonic = await decryptMnemonic(
    await store.loadMnemonicKeystore(),
    PASSWORD,
  );
  const agentSigner = deriveAgentSigner(mnemonic, firstComplete.index);

  console.log(`[main] Fleet bootstrap complete.`);
  console.log(`  Master:  ${state.master_address}`);
  console.log(`  Services: ${state.services.filter(s => s.step === 'complete').length}/${config.targetServices}`);
  console.log(`  Active:  service ${firstComplete.service_id} (agent ${firstComplete.agent_address})`);
  if (firstComplete.mech_address) {
    console.log(`  Mech:    ${firstComplete.mech_address}`);
  }

  return {
    masterAddress: state.master_address as `0x${string}`,
    serviceIndex: firstComplete.index,
    serviceId: firstComplete.service_id ?? null,
    agentPrivateKey: agentSigner.privateKey as `0x${string}`,
    safeAddress: firstComplete.safe_address as `0x${string}`,
    mechAddress: firstComplete.mech_address ? (firstComplete.mech_address as `0x${string}`) : undefined,
  };
}

export interface DaemonStartupInfo {
  schemaVersion: 1;
  generatedAt: string;
  kind: 'daemon_started';
  pid: number;
  network: 'testnet' | 'mainnet';
  phase: 'phase-1b' | 'phase-0';
  apiPort: number;
  masterAddress: `0x${string}`;
  safeAddress: `0x${string}`;
  mechAddress: `0x${string}`;
  serviceIndex: number;
  serviceId: number | null;
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function main(): Promise<DaemonStartupInfo> {
  console.log(`[main] jinn-client starting on ${NETWORK_CHAIN}`);

  const { agentPrivateKey, masterAddress, safeAddress, mechAddress, serviceIndex, serviceId } =
    await bootstrap();

  if (!mechAddress) {
    emitEnvelope({
      code: 'fatal',
      message: 'Bootstrap completed without a runnable mech deployment.',
      hint: 'Set a valid mech deployment and re-run `npx jinn run`.',
      exampleCli: 'npx jinn doctor',
      details: {
        network: config.network,
        expected: 'configured mech deployment with a non-zero mech marketplace address',
      },
    });
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
    routerClaimDeliveryVariant: CHAIN_CONFIG.routerClaimDeliveryVersion,
  });

  const preflight = await checkClaudeBinary(config.claudePath);
  if (!preflight.ok) {
    emitClaudeBinaryPreflightFailure(preflight.detail, config.claudePath);
  }

  const runner = new ClaudeRunner({
    claudePath: config.claudePath,
    model: config.claudeModel,
  });

  const earningStore = new FleetStateStore(config.earningDir);
  const mnemonicForMaster = await decryptMnemonic(
    await earningStore.loadMnemonicKeystore(),
    PASSWORD,
  );
  const masterSigner = deriveMasterSigner(mnemonicForMaster).connect(
    new JsonRpcProvider(config.rpcUrl),
  );

  const daemon = new Daemon({
    adapter,
    runner,
    desiredStates: config.desiredStates,
    dbPath: config.dbPath,
    apiPort: config.apiPort,
    peers: config.peers.length > 0 ? config.peers : undefined,
    subgraphUrl: config.subgraphUrl,
    nodeEndpoint: config.nodeEndpoint,
    status: {
      earningDir: config.earningDir,
      rpcUrl: config.rpcUrl,
      network: config.network,
      pollIntervalMs: config.pollIntervalMs,
      masterEthDailyEstimateWei: config.masterEthDailyEstimateWei,
      rewardClaimIntervalMs: config.rewardClaimIntervalMs,
      testnetL2DeploymentPath: config.testnetL2DeploymentPath,
      testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
      testnetMechDeploymentPath: config.testnetMechDeploymentPath,
      testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
    },
    rewardClaim:
      config.rewardClaimIntervalMs > 0
        ? {
            intervalMs: config.rewardClaimIntervalMs,
            provider: masterSigner.provider as JsonRpcProvider,
            masterSigner,
            store: earningStore,
            chain: NETWORK_CHAIN,
            distributorAddress: CHAIN_CONFIG.distributorAddress,
          }
        : undefined,
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

  // Write pidfile so `jinn stop` can find us.
  const pidPath = join(config.earningDir, 'daemon.pid');
  const { writeFileSync, unlinkSync } = await import('node:fs');
  writeFileSync(pidPath, String(process.pid) + '\n', 'utf-8');
  const removePidfile = () => {
    try {
      unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
  };
  process.on('exit', removePidfile);

  await daemon.start();
  console.log('[main] Daemon running. Press Ctrl+C to stop.');
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    kind: 'daemon_started',
    pid: process.pid,
    network: config.network,
    phase: config.network === 'testnet' ? 'phase-1b' : 'phase-0',
    apiPort: config.apiPort,
    masterAddress,
    safeAddress,
    mechAddress,
    serviceIndex,
    serviceId,
  };
}

function isMainScriptEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return false;
  try {
    const here = pathToFileURL(fileURLToPath(import.meta.url)).href;
    const invoked = pathToFileURL(resolve(entry)).href;
    return here === invoked;
  } catch {
    return false;
  }
}

if (isMainScriptEntry()) {
  main().catch((err) => {
    const { summary, hint } = formatBootstrapOperatorMessage(err);
    const cause = err instanceof Error ? err.message : String(err);
    const details: Record<string, unknown> = { cause };
    if (config.debug && err instanceof Error && err.stack) {
      details.stack = err.stack;
    }
    emitEnvelope({
      code: 'fatal',
      message: summary,
      ...(hint !== undefined ? { hint } : {}),
      details,
    });
  });
}
