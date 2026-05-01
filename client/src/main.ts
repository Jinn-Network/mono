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
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, getConfigPathFromArgs } from './config.js';
import { formatBootstrapOperatorMessage } from './operator-errors.js';
import { emitEnvelope } from './errors/envelope.js';
import { checkClaudeBinary } from './preflight/claude-binary.js';
import { emitClaudeBinaryPreflightFailure } from './preflight/claude-invocation-envelope.js';
import { detectAuthContext, probeClaudeAuth } from './preflight/claude-auth.js';
import { FleetBootstrapper } from './earning/bootstrap.js';
import { DEFAULT_TESTNET_ARTIFACTS, applyChainGasOverrides, getChainConfig, loadJinnMviConfig } from './earning/contracts.js';
import { runLegacyAgentIdMigration } from './earning/migrate-agent-id.js';
import { FleetStateStore } from './earning/store.js';
import type { FleetState, ServiceState, ServiceStep } from './earning/types.js';
import { decryptMnemonic, deriveMasterSigner, walletPrivateKeyAtIndex } from './earning/wallet.js';
import { MechAdapter } from './adapters/mech/adapter.js';
import { ClaudeRunner } from './runner/claude.js';
import type { RunnerContext } from './runner/runner.js';
import { Daemon } from './daemon/daemon.js';
import { createJinnPublicClient, createJinnWalletClient, createJinnL1PublicClient, createJinnL1WalletClient } from './earning/viem-clients.js';
import { privateKeyToAccount } from 'viem/accounts';
import { RestorerImplRegistry } from './restorer/engine/registry.js';
import { buildRestorerImpls } from './restorer/impls/index.js';
import { loadExternalImpl } from './restorer/external-impls/index.js';
import type { RestorerImpl } from './restorer/types.js';
import { ClaimRegistryClient } from './adapters/claim-registry/client.js';
import { createClients } from './adapters/mech/safe.js';
import { collectTestnetAutoIntentGenerators } from './intents/kinds/index.js';
import { createCorpus } from './corpus/index.js';
import { Store } from './store/store.js';
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

const CONFIG_PATH = getConfigPathFromArgs();
const config = loadConfig(CONFIG_PATH);

const NETWORK_CHAIN = config.network === 'testnet' ? 'base-sepolia' : 'base';
const CHAIN_CONFIG = applyChainGasOverrides(getChainConfig(NETWORK_CHAIN, {
  testnetL2DeploymentPath: config.testnetL2DeploymentPath,
  testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
  testnetMechDeploymentPath: config.testnetMechDeploymentPath,
  testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
  testnetClaimRegistryDeploymentPath: config.testnetClaimRegistryDeploymentPath,
}), {
  minEoaGasWei: config.minEoaGasWei,
  minSafeEthWei: config.minSafeEthWei,
});
const MESSENGER_MODE_EXPLICIT =
  process.env['JINN_MESSENGER_MODE'] !== undefined ||
  configFileHasTopLevelKey(CONFIG_PATH, 'jinnMessengerMode');
const JINN_MVI_CONFIG = loadJinnMviConfig({
  l1ArtifactPath:
    config.jinnMviL1DeploymentPath ??
    (config.network === 'testnet' ? DEFAULT_TESTNET_ARTIFACTS.jinnMviL1 : undefined),
  l2ArtifactPath:
    config.jinnMviL2DeploymentPath ??
    (config.network === 'testnet' ? DEFAULT_TESTNET_ARTIFACTS.jinnMviL2 : undefined),
  distributorAddress: config.jinnDistributorAddress,
  messengerAddress: config.jinnMessengerAddress,
  claimEmitterAddress: config.jinnClaimEmitterAddress,
  messengerMode: MESSENGER_MODE_EXPLICIT ? config.jinnMessengerMode : undefined,
});
const JINN_CLAIM_MESSENGER_MODE = JINN_MVI_CONFIG.messengerMode ?? config.jinnMessengerMode;
const MARKETPLACE_ADDRESS = CHAIN_CONFIG.mechMarketplace as `0x${string}`;
const ROUTER_ADDRESS = (CHAIN_CONFIG.jinnRouter ?? '0xfFa7118A3D820cd4E820010837D65FAfF463181B') as `0x${string}`;

function configFileHasTopLevelKey(configPath: string | undefined, key: string): boolean {
  const filePath = configPath ?? join(process.env['HOME'] ?? '', '.jinn-client', 'config.json');
  if (!filePath || !existsSync(filePath)) return false;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return !!raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, key);
  } catch {
    return false;
  }
}

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
  stakingAddress: `0x${string}` | null;
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
    minEoaGasWei: config.minEoaGasWei,
    minSafeEthWei: config.minSafeEthWei,
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

  // Legacy migration (jinn-mono-jgp): backfill `agent_id` on `complete`
  // services that pre-date j07. Idempotent + per-service failure-isolated;
  // a failure here does not abort daemon startup, but we surface counts so
  // operators notice. Disabled via `runLegacyMigrations: false` /
  // JINN_RUN_LEGACY_MIGRATIONS=0 — operators can run `jinn migrate-agent-id`
  // explicitly instead.
  let state = result.fleet_state;
  if (config.runLegacyMigrations) {
    try {
      const migration = await runLegacyAgentIdMigration({
        earningDir: config.earningDir,
        network: NETWORK_CHAIN,
        rpcUrl: config.rpcUrl,
        password: PASSWORD,
        testnetL2DeploymentPath: config.testnetL2DeploymentPath,
        testnetL2TokenDeploymentPath: config.testnetL2TokenDeploymentPath,
        testnetMechDeploymentPath: config.testnetMechDeploymentPath,
        testnetStolasDeploymentPath: config.testnetStolasDeploymentPath,
        testnetClaimRegistryDeploymentPath: config.testnetClaimRegistryDeploymentPath,
      });
      if (migration.migrated.length > 0 || migration.failed.length > 0) {
        console.log(
          `[main] Legacy agent_id migration: migrated=${migration.migrated.length} ` +
          `skipped=${migration.skipped.length} failed=${migration.failed.length}`,
        );
        for (const f of migration.failed) {
          console.log(
            `[main]   service ${f.service.index} (agent ${f.service.agent_address}): ${f.error}`,
          );
        }
        // Reload state so downstream wiring (agent_id, identityRegistry)
        // sees the migrated rows.
        state = await new FleetStateStore(config.earningDir).load(NETWORK_CHAIN);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[main] Legacy agent_id migration failed (non-fatal): ${message}`);
    }
  }

  // Use the first complete service for the daemon
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
    stakingAddress: firstComplete.staking_address ? (firstComplete.staking_address as `0x${string}`) : null,
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

  // ── Daemon API bearer token (jinn-mono-pr64 hardening) ───────────────────
  //
  // Cost-mutating API routes (`POST /v1/artifacts/acquire`, `POST /artifacts`)
  // require an `Authorization: Bearer <token>` header. Read from env when
  // operators want a stable token (e.g. multi-process tools); otherwise
  // generate a fresh one per daemon process. Logged only as an 8-char prefix.
  // The token is forwarded to the MCP subprocess via `DAEMON_API_TOKEN` env
  // so `acquire_artifact` and `submit_restoration_result` can authenticate
  // their calls back to the daemon.
  const envToken = process.env['DAEMON_API_TOKEN']?.trim();
  const apiToken = envToken && envToken.length > 0
    ? envToken
    : randomBytes(32).toString('hex');
  if (!envToken) {
    console.log(`[main] Generated DAEMON_API_TOKEN (prefix=${apiToken.slice(0, 8)}...)`);
  }

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
    stakingAddress,
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

  const evictionRecovery =
    config.stakingMode === 'standard' &&
    serviceId !== null &&
    stakingAddress &&
    CHAIN_CONFIG.distributorAddress
      ? {
          serviceId,
          stakingProxyAddress: stakingAddress,
          distributorAddress: CHAIN_CONFIG.distributorAddress as `0x${string}`,
          masterWalletClient: masterWallet,
        }
      : undefined;

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
    evictionRecovery,
  });

  // ── RestorationEngine wiring ─────────────────────────────────────────────────

  // Build agent viem clients (same creds as MechAdapter uses internally).
  const viemChains = await import('viem/chains');
  const agentChain = config.network === 'testnet'
    ? viemChains.baseSepolia
    : viemChains.base;
  const l1Chain = config.jinnL1Network === 'sepolia' ? viemChains.sepolia : viemChains.mainnet;
  const agentChainContracts = agentChain.contracts as {
    portal?: Record<number, { address: `0x${string}` }>;
    disputeGameFactory?: Record<number, { address: `0x${string}` }>;
  } | undefined;
  const optimismPortalAddress =
    agentChainContracts?.portal?.[l1Chain.id]?.address;
  const disputeGameFactoryAddress =
    agentChainContracts?.disputeGameFactory?.[l1Chain.id]?.address;
  const l2ProofClient = config.l2ProofRpcUrl
    ? createJinnPublicClient(config.l2ProofRpcUrl, NETWORK_CHAIN)
    : undefined;
  const agentClients = createClients(config.rpcUrl, agentPrivateKey, agentChain);

  // ── L1 (Sepolia / Ethereum mainnet) clients for cross-chain JINN claim loop ──
  // Uses the agent EOA because MockMessenger.owner is the agent on testnet.
  // Same key as L2; only the chain differs.
  const l1ClientsForJinnClaim =
    JINN_MVI_CONFIG.distributor && config.ethereumRpcUrl
      ? {
          public: createJinnL1PublicClient(config.ethereumRpcUrl, config.jinnL1Network),
          wallet: createJinnL1WalletClient(
            config.ethereumRpcUrl,
            config.jinnL1Network,
            privateKeyToAccount(agentPrivateKey),
          ),
        }
      : undefined;
  if (l1ClientsForJinnClaim) {
    console.log(
      `[main] JinnClaimLoop: enabled (mode=${JINN_CLAIM_MESSENGER_MODE}, ` +
      `interval=${config.jinnClaimLoopIntervalMs}ms, distributor=${JINN_MVI_CONFIG.distributor}, ` +
      `emitter=${JINN_MVI_CONFIG.claimEmitter})`,
    );
  } else {
    console.log(
      `[main] JinnClaimLoop: disabled (JinnDistributor artifact/override or JINN_ETHEREUM_RPC_URL not set)`,
    );
  }

  // ── Impl registry ────────────────────────────────────────────────────────────

  // Default-disable impls with external dependencies the operator must opt
  // into (see cli/intent-registry-access.ts). The user's
  // `config.restorers.disabled[]` fully overrides this default when present,
  // so `jinn intents enable <kind>` persists the opt-in by writing to that
  // list in ~/.jinn-client/config.json.
  //
  // wrapWith: defaults to 'claude-code-learner' so the learning envelope
  // wraps every restoration kind out of the box (jinn-mono-0k2). Operators
  // benchmarking or running raw specialist behaviour set
  // `restorers.wrapWith: null` (or omit, when no other restorers config
  // exists) to dispatch directly to specialists.
  const { DEFAULT_DISABLED_IMPLS, DEFAULT_BY_KIND, DEFAULT_WRAP_WITH } = await import(
    './cli/intent-registry-access.js'
  );
  const implRegistry = new RestorerImplRegistry({
    byKind: { ...DEFAULT_BY_KIND },
    default: 'legacy-claude',
    disabled: [...DEFAULT_DISABLED_IMPLS],
    wrapWith: DEFAULT_WRAP_WITH,
    ...(config.restorers ?? {}),
  });

  // Load operator-supplied external restorer impls (Path 2 plug-in surface).
  // Each entry in `config.restorers.externalImpls` is verified against
  // `config.trustedImplSigners` before its factory is invoked. Failed loads
  // are logged + skipped — they don't bring down the daemon.
  const externalImpls: RestorerImpl[] = [];
  const trustedSigners = config.trustedImplSigners ?? [];
  const externalEntries = config.restorers?.externalImpls ?? [];
  if (externalEntries.length > 0) {
    for (const entry of externalEntries) {
      const result = await loadExternalImpl({
        entry: {
          name: entry.name,
          entry: entry.entry,
          package: entry.package,
          version: entry.version,
        },
        trustedSigners,
        env: {
          implName: entry.name,
          implVersion: '0.0.0', // overridden by manifest validation below
          network: config.network,
          implStateDir: join(config.engine.implStateDirRoot, entry.name),
          secrets: Object.freeze({}),
          log: ({ level, msg, data }) =>
            console.log(`[external-impl:${entry.name}] [${level}] ${msg}`, data ?? ''),
          stub: false,
        },
      });
      if (result.kind === 'ok') {
        externalImpls.push(result.impl);
        console.log(`[main] Loaded external impl: ${result.impl.name}@${result.impl.version}`);
      } else {
        console.warn(
          `[main] Failed to load external impl ${entry.name}: ${result.reason}` +
            (result.detail ? ` (${result.detail})` : ''),
        );
      }
    }
  }

  // ── Path 1 plug-ins (claude-code-learner slot registry) ──────────────────────
  // Load operator-installed Path 1 plug-ins from `config.learnerPlugIns[]`,
  // assemble the in-memory slot registry, and serialise it for hand-off to
  // the learner shim (which forwards via env to the spawned harness).
  // See spec/2026-04-30-plug-in-surface.md §4.
  let slotRegistryJson: string | undefined;
  const learnerPlugIns = config.learnerPlugIns ?? [];
  if (learnerPlugIns.length > 0) {
    const { loadPlugIns, serialiseRegistry } = await import(
      './restorer/plug-ins/index.js'
    );
    // Read the bundled claude-code-learner version from its plugin.json.
    // main.ts is at client/src/main.ts (src) or client/dist/main.js (compiled);
    // probe both relative locations so the same code works in both contexts.
    const __mainDir = dirname(fileURLToPath(import.meta.url));
    const pluginJsonSrc = join(__mainDir, '../plugins/claude-code-learner/.claude-plugin/plugin.json');
    const pluginJsonDist = join(__mainDir, '../../plugins/claude-code-learner/.claude-plugin/plugin.json');
    const pluginJsonPath = existsSync(pluginJsonSrc) ? pluginJsonSrc : pluginJsonDist;
    const learnerVersion = (
      JSON.parse(readFileSync(pluginJsonPath, 'utf8')) as { version: string }
    ).version;
    const result = await loadPlugIns({
      entries: learnerPlugIns,
      learnerVersion,
    });
    for (const w of result.warnings) console.warn(`[plug-ins] ${w}`);
    for (const e of result.errors)
      console.error(`[plug-ins] ${e.plugInName}: ${e.reason}`);
    slotRegistryJson = JSON.stringify(
      serialiseRegistry(result.registry, learnerVersion),
    );
    console.log(
      `[main] Loaded ${learnerPlugIns.length - result.errors.length}/${learnerPlugIns.length} Path 1 plug-in(s)`,
    );
  }

  // legacy-claude: wraps ClaudeRunner; handles spec=undefined (health-check) intents
  const corpusEnv: RunnerContext['corpusEnv'] | undefined =
    config.subgraphUrl?.trim()
      ? {
          subgraphUrl: config.subgraphUrl,
          ipfsGatewayUrl: config.ipfsGatewayUrl,
        }
      : undefined;

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
    daemonApiToken: apiToken,
    implStateDirRoot: config.engine.implStateDirRoot,
    externalImpls,
    disabledNames: config.restorers?.disabled,
    slotRegistryJson,
    corpusEnv,
  })) {
    implRegistry.register(impl);
  }

  console.log(`[main] RestorerImplRegistry: ${implRegistry.list().map(i => i.name).join(', ')}`);

  // ── Engine deps ───────────────────────────────────────────────────────────────

  // Packaging deps: artifact bytes are written to served_artifacts (operator-local
  // SQLite) and served via the operator's HTTP server with x402 gating per
  // spec/2026-04-30-phase-a-umbrella.md §1. IPFS only holds the manifest envelope.
  // The `store` field is filled by Daemon (which owns the SQLite handle); here
  // we just configure the endpoint + price defaults from `config.operator`
  // (Phase 3, jinn-mono-vy37.1.3). Operators who don't declare an operator
  // block fall back to the daemon's local API port so dev/test runs still work
  // — but the resulting envelopes won't be reachable from outside the host.
  const operatorPublicEndpoint =
    config.operator?.publicEndpoint ?? `http://localhost:${config.apiPort}`;
  const operatorDefaultPrice = config.operator?.defaultPriceUsdc ?? '0';
  const operatorPerTypePrice = config.operator?.perArtifactTypePrice ?? {};
  if (!config.operator?.publicEndpoint) {
    console.warn(
      '[main] config.operator.publicEndpoint not set; defaulting to local API port. ' +
        'External evaluators will not be able to fetch artifacts from this operator. ' +
        'Set operator.publicEndpoint (or JINN_OPERATOR_PUBLIC_ENDPOINT) before going live.',
    );
  }
  const packagingDeps = {
    operatorEndpoint: operatorPublicEndpoint,
    defaultPriceUsdc: operatorDefaultPrice,
    perArtifactTypePrice: operatorPerTypePrice,
  };
  const operatorConfig = {
    publicEndpoint: operatorPublicEndpoint,
    defaultPriceUsdc: operatorDefaultPrice,
    perArtifactTypePrice: operatorPerTypePrice,
  };

  // Envelope assembly deps: sign envelopes with agent EOA private key
  const envelopeDeps = {
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
    evictionRecovery,
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
  let identityPublisher: import('./erc8004/index.js').IdentityPublisher | undefined;
  if (agentId && identityRegistryAddress) {
    const { IdentityPublisher } = await import('./erc8004/index.js');
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

  // ── Reputation feedback hook (jinn-mono-yg4) ──────────────────────────────
  //
  // After the evaluator's claimDelivery succeeds, the engine fires
  // `ReputationRegistry.giveFeedback(restorerAgentId, …)` so the restorer's
  // agent NFT accrues a rating (DR §4.3). This requires:
  //
  //   1. A `ReputationRegistryClient` for the active chain. We use the
  //      canonical 0x8004… deployment; writes route through the operator's
  //      Safe so `msg.sender` matches the OLAS staking + 8004 IdentityRegistry
  //      identity.
  //   2. An agentId resolver — looks up the restorer's agentId from the
  //      parent manifest's evidenceHash via the subgraph. When `subgraphUrl`
  //      is unconfigured the resolver returns null cleanly and the hook
  //      becomes a no-op (defensive: feedback is non-fatal).
  //
  // Skipped when the operator hasn't minted an agent NFT yet (matches the
  // IdentityPublisher gating above).
  let reputationFeedback:
    | NonNullable<import('./restorer/engine/engine.js').RestorationEngineOptions['reputationFeedback']>
    | undefined;
  if (agentId) {
    const { getReputationRegistryAddress, ReputationRegistryClient } = await import(
      './erc8004/index.js'
    );
    const chainId = config.network === 'testnet' ? 84532 : 8453;
    const reputationRegistryAddress = getReputationRegistryAddress(chainId);
    if (reputationRegistryAddress) {
      const reputationClient = new ReputationRegistryClient({
        reputationRegistryAddress,
        publicClient: agentClients.publicClient,
        walletClient: agentClients.walletClient,
        safeAddress,
      });
      const { resolveAgentIdForManifest } = await import(
        './erc8004/index.js'
      );
      const subgraphUrl = config.subgraphUrl;
      reputationFeedback = {
        client: reputationClient,
        resolveAgentId: (manifestHash) =>
          resolveAgentIdForManifest({ manifestHash, subgraphUrl }),
      };
      console.log(
        `[main] ReputationFeedback: registry=${reputationRegistryAddress}${subgraphUrl ? ` subgraph=${subgraphUrl}` : ' (no subgraph configured — resolver always null)'}`,
      );
    } else {
      console.log(
        `[main] ReputationFeedback: disabled (no canonical ReputationRegistry deployed on chainId=${chainId})`,
      );
    }
  } else {
    console.log(
      '[main] ReputationFeedback: disabled (no agent_id on active service — same gating as IdentityPublisher)',
    );
  }

  // ── Auto-intent generators (testnet only, opt-out via env) ─────────────────
  const autoIntentsDisabled = process.env['JINN_DISABLE_AUTO_INTENTS'] === '1';
  const { privateKeyToAccount: _pkToAccount } = await import('viem/accounts');
  const agentEoaAddress = _pkToAccount(agentPrivateKey).address as `0x${string}`;
  const { generators: autoIntentGenerators, logLines: autoIntentLogLines } = collectTestnetAutoIntentGenerators({
    network: config.network,
    rpcUrl: config.rpcUrl,
    autoIntentsDisabled,
    env: process.env,
    agentEoa: agentEoaAddress,
    safeAddress,
    agentPrivateKey,
    predictionV0WindowMs: config.predictionV0WindowMs,
    predictionV0ResolveGapMs: config.predictionV0ResolveGapMs,
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

  // ── Corpus (daemon-side, jinn-mono-vy37.1.6) ─────────────────────────────
  //
  // Built once per daemon lifetime; the agent EOA private key stays in this
  // process's memory and never crosses into the MCP subprocess. The MCP
  // tool `acquire_artifact` proxies to `POST /v1/artifacts/acquire` instead.
  // Disabled when subgraphUrl is unset — the API route is then absent and
  // MCP falls back to local-only behaviour with a warning.
  const corpusFactory = config.subgraphUrl?.trim()
    ? (store: Store) =>
        createCorpus({
          subgraphUrl: config.subgraphUrl!,
          ipfsGatewayUrl: config.ipfsGatewayUrl,
          store,
          signer: { privateKey: agentPrivateKey },
          selfSafeAddress: safeAddress,
        })
    : undefined;
  if (!corpusFactory) {
    console.warn(
      '[main] Corpus disabled (config.subgraphUrl not set); ' +
        'MCP acquire_artifact / search_artifacts network branches will be unavailable.',
    );
  }

  const daemon = new Daemon({
    adapter,
    runner,
    intentSources,
    dbPath: config.dbPath,
    pollIntervalMs: config.pollIntervalMs,
    apiPort: config.apiPort,
    apiBindHost: config.apiBindHost ?? '127.0.0.1',
    apiToken,
    peers: config.peers.length > 0 ? config.peers : undefined,
    subgraphUrl: config.subgraphUrl,
    nodeEndpoint: config.nodeEndpoint,
    creatorSafeAddress: safeAddress,
    corpusFactory,
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
    jinnClaim:
      l1ClientsForJinnClaim &&
      JINN_MVI_CONFIG.claimEmitter &&
      JINN_MVI_CONFIG.messenger &&
      JINN_MVI_CONFIG.distributor &&
      config.jinnClaimLoopIntervalMs > 0
        ? {
            intervalMs: config.jinnClaimLoopIntervalMs,
            l2Client: agentClients.publicClient,
            l2ProofClient,
            l2Wallet: agentClients.walletClient,
            l1Client: l1ClientsForJinnClaim.public,
            l1Wallet: l1ClientsForJinnClaim.wallet,
            store: earningStore,
            chain: NETWORK_CHAIN,
            claimEmitterAddress: JINN_MVI_CONFIG.claimEmitter as `0x${string}`,
            distributorAddress: JINN_MVI_CONFIG.distributor as `0x${string}`,
            messengerAddress: JINN_MVI_CONFIG.messenger as `0x${string}`,
            messengerMode: JINN_CLAIM_MESSENGER_MODE,
            optimismPortalAddress,
            disputeGameFactoryAddress,
          }
        : undefined,
    restorationEngine: {
      paths: {
        workingDirRoot: config.engine.workingDirRoot,
        implStateDirRoot: config.engine.implStateDirRoot,
      },
      claimDeps,
      packagingDeps,
      envelopeDeps,
      deliveryDeps,
      implRegistry,
      identityPublisher,
      reputationFeedback,
      operatorConfig,
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
