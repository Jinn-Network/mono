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
 *   jinn run
 */

import { config as dotenvConfig } from 'dotenv';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, getConfigPathFromArgs } from './config.js';
import { formatBootstrapOperatorMessage } from './operator-errors.js';
import { emitEnvelope } from './errors/envelope.js';
import { checkClaudeBinary } from './preflight/claude-binary.js';
import { emitClaudeBinaryPreflightFailure } from './preflight/claude-invocation-envelope.js';
import { detectAuthContext, probeClaudeAuth } from './preflight/claude-auth.js';
import { FleetBootstrapper } from './earning/bootstrap.js';
import { getChainConfig } from './earning/contracts.js';
import { FleetStateStore } from './earning/store.js';
import type { FleetState, ServiceState, ServiceStep } from './earning/types.js';
import { decryptMnemonic, deriveMasterSigner, walletPrivateKeyAtIndex } from './earning/wallet.js';
import { MechAdapter } from './adapters/mech/adapter.js';
import { ClaudeRunner } from './runner/claude.js';
import { Daemon } from './daemon/daemon.js';
import { createJinnPublicClient, createJinnWalletClient } from './earning/viem-clients.js';
import { RestorerImplRegistry } from './restorer/engine/registry.js';
import { buildRestorerImpls } from './restorer/impls/index.js';
import { ClaimRegistryClient } from './adapters/claim-registry/client.js';
import { createClients } from './adapters/mech/safe.js';
import { collectTestnetAutoIntentGenerators } from './intents/kinds/index.js';
import { BASE_FEEDS } from './venues/chainlink/feeds.js';
import { GeneratedIntentSource, StaticConfiguredIntentSource } from './intents/sources.js';
import { checkRpcNetwork, logRpcLocalDevToStderr, rpcNetworkFailureHint } from './preflight/rpc-network.js';
import { apiPortFailureMessage, checkApiPortAvailable } from './preflight/api-port.js';

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
  testnetClaimRegistryDeploymentPath: config.testnetClaimRegistryDeploymentPath,
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
  /** ERC-8004 agent NFT id (decimal string). null if bootstrap mint not yet complete. */
  agentId: string | null;
  /** ERC-8004 IdentityRegistry contract used for the mint. null if unknown. */
  identityRegistryAddress: `0x${string}` | null;
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
    testnetClaimRegistryDeploymentPath: config.testnetClaimRegistryDeploymentPath,
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
  const agentPrivateKey = walletPrivateKeyAtIndex(mnemonic, firstComplete.index);

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
    agentPrivateKey: agentPrivateKey as `0x${string}`,
    safeAddress: firstComplete.safe_address as `0x${string}`,
    mechAddress: firstComplete.mech_address ? (firstComplete.mech_address as `0x${string}`) : undefined,
    agentId: firstComplete.agent_id ?? null,
    identityRegistryAddress: firstComplete.identity_registry_address
      ? (firstComplete.identity_registry_address as `0x${string}`)
      : null,
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

  const rpcPreflight = await checkRpcNetwork(config);
  if (!rpcPreflight.ok) {
    emitEnvelope({
      code: 'invalid_invocation',
      message: rpcPreflight.message,
      hint: rpcNetworkFailureHint(rpcPreflight),
      exampleCli: 'jinn doctor --human',
      details: {
        field: 'rpcUrl',
        network: rpcPreflight.network,
        expectedChainId: rpcPreflight.expectedChainId,
        actualChainId: rpcPreflight.actualChainId ?? null,
        rpcHost: rpcPreflight.rpcHost,
        reason: rpcPreflight.reason,
      },
    });
  } else {
    logRpcLocalDevToStderr(rpcPreflight);
  }

  const portPreflight = await checkApiPortAvailable(config.apiPort);
  if (!portPreflight.ok) {
    emitEnvelope({
      code: 'invalid_invocation',
      message: apiPortFailureMessage(portPreflight),
      hint: 'Stop the other daemon or set JINN_API_PORT / apiPort to a free port.',
      exampleCli: 'JINN_API_PORT=7332 jinn run',
      details: {
        field: 'apiPort',
        port: portPreflight.port,
        reason: portPreflight.code ?? 'unavailable',
      },
    });
  }

  const {
    agentPrivateKey,
    masterAddress,
    safeAddress,
    mechAddress,
    serviceIndex,
    serviceId,
    agentId,
    identityRegistryAddress,
  } = await bootstrap();

  if (!mechAddress) {
    emitEnvelope({
      code: 'fatal',
      message: 'Bootstrap completed without a runnable mech deployment.',
      hint: 'Set a valid mech deployment and re-run `jinn run`.',
      exampleCli: 'jinn doctor',
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

  const authContext = detectAuthContext({ cwd: process.cwd(), configuredMode: config.runtimeMode });
  const authProbe = probeClaudeAuth({ context: authContext, cwd: process.cwd() });
  if (!authProbe.authenticated) {
    emitEnvelope({
      code: 'invalid_invocation',
      message: 'Claude is not authenticated. Run `jinn auth` in an interactive terminal before starting the daemon.',
      hint: `Detected context: ${authContext}. The daemon cannot function without Claude authentication.`,
      exampleCli: 'jinn auth',
      details: {
        field: 'claude_auth',
        context: authContext,
        authenticated: false,
      },
    });
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
  const masterAccount = deriveMasterSigner(mnemonicForMaster);
  const publicClient = createJinnPublicClient(config.rpcUrl, NETWORK_CHAIN);
  const masterWallet = createJinnWalletClient(config.rpcUrl, NETWORK_CHAIN, masterAccount);

  // ── RestorationEngine wiring ─────────────────────────────────────────────────

  // Build agent viem clients (same creds as MechAdapter uses internally).
  const agentChain = config.network === 'testnet'
    ? (await import('viem/chains')).baseSepolia
    : (await import('viem/chains')).base;
  const agentClients = createClients(config.rpcUrl, agentPrivateKey, agentChain);

  // ── Impl registry ────────────────────────────────────────────────────────────

  // Default-disable impls with external dependencies the operator must opt
  // into (see cli/intent-registry-access.ts). The user's
  // `config.restorers.disabled[]` fully overrides this default when present,
  // so `jinn intents enable <kind>` persists the opt-in by writing to that
  // list in ~/.jinn-client/config.json.
  const { DEFAULT_DISABLED_IMPLS, DEFAULT_BY_KIND } = await import('./cli/intent-registry-access.js');
  const implRegistry = new RestorerImplRegistry({
    byKind: { ...DEFAULT_BY_KIND },
    default: 'legacy-claude',
    disabled: [...DEFAULT_DISABLED_IMPLS],
    ...(config.restorers ?? {}),
  });

  // legacy-claude: wraps ClaudeRunner; handles spec=undefined (health-check) intents
  for (const impl of buildRestorerImpls({
    rpcUrl: config.rpcUrl,
    archiveRpcUrl: config.archiveRpcUrl,
    claudePath: config.claudePath,
    claudeModel: config.claudeModel,
    pk: agentPrivateKey,
    safe: safeAddress,
    runner,
    storePath: config.dbPath,
    daemonApiUrl: `http://127.0.0.1:${config.apiPort}`,
    implStateDirRoot: config.engine.implStateDirRoot,
  })) {
    implRegistry.register(impl);
  }

  console.log(`[main] RestorerImplRegistry: ${implRegistry.list().map(i => i.name).join(', ')}`);

  // ── Engine deps ───────────────────────────────────────────────────────────────

  // Packaging deps: IPFS upload + optional artifact registration (wired in daemon via registerArtifact)
  const packagingDeps = {
    ipfsRegistryUrl: config.ipfsRegistryUrl,
  };

  // Manifest assembly deps: sign manifests with agent EOA private key
  const manifestDeps = {
    ipfsRegistryUrl: config.ipfsRegistryUrl,
    agentEoaPrivateKey: agentPrivateKey,
    safeAddress,
  };

  // Delivery deps: deliver to marketplace + claimDelivery via JinnRouter
  const deliveryDeps = {
    publicClient: agentClients.publicClient,
    walletClient: agentClients.walletClient,
    safeAddress,
    mechContractAddress: mechAddress,
    routerAddress: ROUTER_ADDRESS,
    claimDeliveryVariant: CHAIN_CONFIG.routerClaimDeliveryVersion,
  };

  // Claim deps: use the network default when bundled, with env override for
  // emergency redeploys or custom test deployments.
  const claimRegistryAddress = (
    process.env['JINN_CLAIM_REGISTRY_ADDRESS']
    ?? CHAIN_CONFIG.claimRegistry
    ?? ''
  ) as `0x${string}` | '';
  const claimDeps = claimRegistryAddress
    ? {
        registryClient: new ClaimRegistryClient(
          agentClients.publicClient,
          agentClients.walletClient,
          claimRegistryAddress as `0x${string}`,
          safeAddress,
        ),
        marketplaceClaimer: adapter,
      }
    : undefined;

  if (claimRegistryAddress) {
    console.log(`[main] ClaimRegistry: ${claimRegistryAddress}`);
  } else {
    console.log('[main] ClaimRegistry: not configured (claim step will use NotImplementedError fallback)');
  }

  // ── IdentityPublisher (jinn-mono-3zk) ───────────────────────────────────────
  //
  // When the bootstrap has minted an ERC-8004 IdentityRegistry NFT for the
  // active service (agent_id non-null) AND we know the registry address, wire
  // an IdentityPublisher so the engine anchors each envelope under the
  // operator's agent NFT via setMetadata. Otherwise log a warning — publishing
  // is disabled until bootstrap completes that step (jinn-mono-j07).
  let identityPublisher: import('./discovery/identity-publisher.js').IdentityPublisher | undefined;
  if (agentId && identityRegistryAddress) {
    const { IdentityPublisher } = await import('./discovery/identity-publisher.js');
    identityPublisher = new IdentityPublisher({
      identityRegistryAddress,
      agentId: BigInt(agentId),
      walletClient: agentClients.walletClient,
      publicClient: agentClients.publicClient,
    });
    console.log(
      `[main] IdentityPublisher: agentId=${agentId} registry=${identityRegistryAddress}`,
    );
  } else {
    console.log(
      '[main] IdentityPublisher: disabled (no agent_id on active service — re-run bootstrap to mint the operator agent NFT)',
    );
  }

  // ── Auto-intent generators (testnet only, opt-out via env) ─────────────────
  const autoIntentsDisabled = process.env['JINN_DISABLE_AUTO_INTENTS'] === '1';
  const { generators: autoIntentGenerators, logLines: autoIntentLogLines } = collectTestnetAutoIntentGenerators({
    network: config.network,
    rpcUrl: config.rpcUrl,
    autoIntentsDisabled,
    env: process.env,
  });
  for (const line of autoIntentLogLines) {
    console.log(line);
  }
  if (config.network === 'mainnet' && !autoIntentsDisabled && BASE_FEEDS['ETH / USD']) {
    // Mainnet auto-intent opt-in only; default is OFF. Reserved for a future flag.
  }
  const intentSources = [
    new StaticConfiguredIntentSource(config.desiredStates),
    ...autoIntentGenerators.map(({ kind, generator }) =>
      new GeneratedIntentSource(`generated:${kind}`, generator)),
  ];

  const daemon = new Daemon({
    adapter,
    runner,
    intentSources,
    dbPath: config.dbPath,
    pollIntervalMs: config.pollIntervalMs,
    apiPort: config.apiPort,
    peers: config.peers.length > 0 ? config.peers : undefined,
    subgraphUrl: config.subgraphUrl,
    nodeEndpoint: config.nodeEndpoint,
    creatorSafeAddress: safeAddress,
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
      testnetClaimRegistryDeploymentPath: config.testnetClaimRegistryDeploymentPath,
      engine: config.engine,
    },
    rewardClaim:
      config.rewardClaimIntervalMs > 0
        ? {
            intervalMs: config.rewardClaimIntervalMs,
            publicClient,
            masterWallet,
            store: earningStore,
            chain: NETWORK_CHAIN,
            distributorAddress: CHAIN_CONFIG.distributorAddress,
          }
        : undefined,
    restorationEngine: {
      // TODO(jinn-mono-cy4): RestorationEngineOptions has redundant registry+implRegistry
      // fields. Engine refactor should consolidate to one. Locked in this PR.
      registry: implRegistry,
      paths: {
        workingDirRoot: config.engine.workingDirRoot,
        implStateDirRoot: config.engine.implStateDirRoot,
      },
      claimDeps,
      packagingDeps,
      manifestDeps,
      deliveryDeps,
      implRegistry,
      identityPublisher,
    },
    balanceTopup:
      config.balanceTopupIntervalMs > 0
        ? {
            intervalMs: config.balanceTopupIntervalMs,
            publicClient,
            masterWallet,
            store: earningStore,
            chain: NETWORK_CHAIN,
            eoaTopupTrigger: CHAIN_CONFIG.eoaTopupTrigger,
            eoaTopupTarget: CHAIN_CONFIG.minEoaGasEth,
            safeTopupTrigger: CHAIN_CONFIG.safeTopupTrigger,
            safeTopupTarget: CHAIN_CONFIG.minSafeEth,
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

  try {
    await daemon.start();
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'EADDRINUSE') {
      emitEnvelope({
        code: 'invalid_invocation',
        message: `Port ${config.apiPort} is already in use. Stop the other daemon or set JINN_API_PORT / apiPort to another port.`,
        hint: 'Set JINN_API_PORT to a free port, or stop the process currently listening on the dashboard/API port.',
        exampleCli: 'JINN_API_PORT=7332 jinn run',
        details: {
          field: 'apiPort',
          port: config.apiPort,
          reason: 'EADDRINUSE',
        },
      });
    }
    throw error;
  }
  console.log(`[main] Daemon running. Dashboard: http://127.0.0.1:${config.apiPort}`);
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
