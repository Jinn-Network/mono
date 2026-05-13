// client/test/e2e/_daemon-harness-helpers.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  spawnAnvilFork,
  jsonRpc as anvilJsonRpc,
  type AnvilHarness,
} from '../_support/chain/anvil.js';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import {
  SERVICE_REGISTRY_L2_ABI,
  getChainConfig,
} from '../../src/earning/contracts.js';
import { FleetStateStore } from '../../src/earning/store.js';
import { decryptMnemonic, walletPrivateKeyAtIndex } from '../../src/earning/wallet.js';
import {
  ANVIL_PRIVATE_KEYS,
  compileContracts,
} from './task-first-helpers.js';
import { Daemon } from '../../src/daemon/daemon.js';
import { MechAdapter } from '../../src/adapters/mech/adapter.js';
import { buildHarnesses } from '../../src/harnesses/impls/index.js';
import { Store } from '../../src/store/store.js';
import {
  HarnessRegistry,
  DEFAULT_HARNESS,
  DEFAULT_DISABLED_HARNESSES,
} from '../../src/harnesses/engine/registry.js';
export { compileContracts };

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';

const CHAIN_CONFIG = getChainConfig('base');

const PASSWORD = 'test-password';

// ── Types ─────────────────────────────────────────────────────────────────────

export type HarnessSelector = 'hermes-agent' | 'claude-code' | 'codex' | 'prediction-v1-baseline';

export interface DaemonHarnessFixture {
  anvil: AnvilHarness;
  publicClient: PublicClient;
  operatorEoa: ReturnType<typeof privateKeyToAccount>;
  workingDirRoot: string;
  implStateRoot: string;
  /** Disposes anvil, deletes scratch dirs, etc. */
  teardown: () => Promise<void>;
}

export interface BootstrappedOperator {
  /** Agent EOA private key — held in the test process, not on disk. */
  agentPrivateKey: `0x${string}`;
  agentAddress: `0x${string}`;
  safeAddress: `0x${string}`;
  mechAddress: `0x${string}`;
  serviceId: bigint;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pick the harness from JINN_E2E_HARNESS, default `hermes-agent`. */
export function harnessSelectorFromEnv(): HarnessSelector {
  const raw = (process.env['JINN_E2E_HARNESS'] ?? 'hermes-agent').trim();
  if (raw === 'hermes-agent' || raw === 'claude-code' || raw === 'codex' || raw === 'prediction-v1-baseline') {
    return raw;
  }
  throw new Error(`JINN_E2E_HARNESS=${raw} not recognised. Use one of: hermes-agent, claude-code, codex, prediction-v1-baseline.`);
}

/**
 * Spawns an Anvil fork of Base mainnet, funds Anvil-deterministic accounts,
 * and assembles scratch dirs. Does NOT run earning bootstrap — that's a
 * separate helper because the production Daemon path uses FleetBootstrapper
 * instead.
 */
export async function setupAnvilFixture(): Promise<DaemonHarnessFixture> {
  await compileContracts();
  const anvil = await spawnAnvilFork({ forkUrl: BASE_RPC_URL, silent: true });
  const operatorEoa = privateKeyToAccount(ANVIL_PRIVATE_KEYS[1]!); // skip deployer
  const publicClient = createPublicClient({
    chain: base,
    transport: http(anvil.rpcUrl),
  }) as unknown as PublicClient;

  await anvilJsonRpc(anvil.rpcUrl, 'anvil_setBalance', [
    operatorEoa.address,
    '0x56bc75e2d63100000', // 100 ETH
  ]);

  const workingDirRoot = mkdtempSync(join(tmpdir(), 'jinn-daemon-harness-work-'));
  const implStateRoot = mkdtempSync(join(tmpdir(), 'jinn-daemon-harness-state-'));

  return {
    anvil,
    publicClient,
    operatorEoa,
    workingDirRoot,
    implStateRoot,
    async teardown() {
      try { await anvil.teardown(); } catch {}
      try { rmSync(workingDirRoot, { recursive: true, force: true }); } catch {}
      try { rmSync(implStateRoot, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Run the FleetBootstrapper 11-step lifecycle to `complete` on the Anvil fork.
 * Funds the EOA via Anvil's anvil_setBalance (stOLAS mode — the distributor
 * funds the OLAS bond on-chain, so only ETH is required on the master EOA).
 *
 * Pattern lifted from `client/test/e2e/staking.ts` — see that file for the
 * canonical funding sequence.
 *
 * Returns the on-chain identifiers downstream Daemon construction needs.
 */
export async function bootstrapStakedOperator(
  fixture: DaemonHarnessFixture,
): Promise<BootstrappedOperator> {
  const rpcUrl = fixture.anvil.rpcUrl;

  // Step 1: Create a temp earning dir under implStateRoot.
  const earningDir = await mkdtemp(join(fixture.implStateRoot, 'earning-'));

  // Step 2: Construct bootstrapper — run to awaiting_funding to learn the EOA address.
  const bootstrapper = new FleetBootstrapper({
    earningDir,
    chain: 'base',
    rpcUrl,
  });

  const firstResult = await bootstrapper.bootstrap(PASSWORD);

  if (!firstResult.funding) {
    // Unexpectedly completed on first pass (shouldn't happen with a fresh earningDir).
    if (!firstResult.ok) {
      throw new Error(`FleetBootstrapper failed before funding gate: ${firstResult.message}`);
    }
    // Already complete — unlikely but handle it below.
  }

  // Step 3: Fund master EOA with 100 ETH so it can pay gas for all 11 steps.
  // stOLAS mode: the distributor handles OLAS bond — only ETH is needed on the EOA.
  const masterAddress = firstResult.funding?.master_address ?? firstResult.fleet_state.master_address;
  if (!masterAddress) {
    throw new Error('FleetBootstrapper did not expose a master EOA address');
  }

  await anvilJsonRpc(rpcUrl, 'anvil_setBalance', [
    getAddress(masterAddress) as Address,
    '0x56BC75E2D63100000', // 100 ETH in hex — exact value from staking.ts
  ]);

  // Mine a block so the provider sees the new balance.
  await anvilJsonRpc(rpcUrl, 'evm_mine', []);

  // Step 4: Re-create bootstrapper with a fresh provider (avoids stale balance cache)
  // and run to completion.
  const bootstrapper2 = new FleetBootstrapper({
    earningDir,
    chain: 'base',
    rpcUrl,
  });

  const result = await bootstrapper2.bootstrap(PASSWORD);

  if (!result.ok) {
    throw new Error(`FleetBootstrapper did not reach complete: ${result.message}`);
  }

  // Step 5: Extract per-service state.
  const service = result.fleet_state.services.find(
    (svc) => svc.safe_address && svc.mech_address,
  );
  if (!service?.safe_address || !service.mech_address || service.service_id == null) {
    throw new Error(
      `Bootstrap completed but missing required service fields: ` +
      `safe=${service?.safe_address ?? 'null'} ` +
      `mech=${service?.mech_address ?? 'null'} ` +
      `serviceId=${service?.service_id ?? 'null'}`,
    );
  }

  // Step 6: Decrypt mnemonic to derive agent private key.
  const store = new FleetStateStore(earningDir);
  const mnemonic = await decryptMnemonic(
    await store.loadMnemonicKeystore(),
    PASSWORD,
  );
  const agentPrivateKey = walletPrivateKeyAtIndex(mnemonic, service.index);
  const agentAddress = getAddress(service.agent_address) as `0x${string}`;

  const serviceId = BigInt(service.service_id);

  // Step 7 (sanity check): verify service is staked on-chain — mirrors staking.ts Phase 5.
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const serviceState = await publicClient.readContract({
    address: CHAIN_CONFIG.serviceRegistry as Address,
    abi: SERVICE_REGISTRY_L2_ABI,
    functionName: 'getService',
    args: [serviceId],
  });
  if (Number(serviceState.state) !== 4) {
    throw new Error(
      `Expected service state 4 (Deployed), got ${serviceState.state} for serviceId=${serviceId}`,
    );
  }

  const stakingAbi = parseAbi([
    'function getServiceIds() view returns (uint256[])',
  ]);
  const stakedIds = await publicClient.readContract({
    address: CHAIN_CONFIG.stakingContract as Address,
    abi: stakingAbi,
    functionName: 'getServiceIds',
  });
  if (!stakedIds.includes(serviceId)) {
    throw new Error(
      `Service ${serviceId} not found in staking contract's getServiceIds()`,
    );
  }

  return {
    agentPrivateKey: agentPrivateKey as `0x${string}`,
    agentAddress,
    safeAddress: getAddress(service.safe_address) as `0x${string}`,
    mechAddress: getAddress(service.mech_address) as `0x${string}`,
    serviceId,
  };
}

// ── Daemon startup ─────────────────────────────────────────────────────────────

export interface RunningDaemon {
  daemon: Daemon;
  store: Store;
  /** Stop all loops + close store. Idempotent. */
  stop: () => Promise<void>;
}

/**
 * Instantiate the production Daemon class with MechAdapter pointed at the
 * Anvil fork + the bootstrapped operator's credentials. Start all long-running
 * loops.
 *
 * Polling intervals are shortened (300ms vs production 5000ms) so the test
 * does not sit idle. Increase if the fork RPC starts struggling.
 *
 * SolverNet selection (which harness handles which task) is configured in
 * Task 6 via JINN_E2E_HARNESS. Task 3 just proves the daemon starts cleanly.
 *
 * Translation notes vs main.ts:
 *   - No shared setupApiServer: Daemon owns and starts its own API server.
 *   - apiPort: 0 → OS assigns a free port at daemon-startup time (no TOCTOU race).
 *   - peers: empty (no peer discovery in the test).
 *   - subgraphUrl: omitted (no-subgraph mode is supported).
 *   - rewardClaim / balanceTopup / jinnClaim: omitted (interval 0 → loops not started).
 *   - packagingDeps / envelopeDeps / deliveryDeps: omitted → pack() falls back
 *     to NotImplementedError (Task 4+ will wire delivery deps as needed).
 *   - identityPublisher / reputationFeedback: omitted (no ERC-8004 in test).
 *   - operatorConfig: minimal synthetic value (no donation, no price).
 *   - harnessMode: 'train' (default learning mode, same as production default).
 *   - taskSources: empty (no creator-side tasks; daemon waits for on-chain claims).
 *   - creatorSafeAddress: set from operator.safeAddress so CreatorLoop scopes correctly.
 */
export async function startDaemon(
  fixture: DaemonHarnessFixture,
  operator: BootstrappedOperator,
  _harnessSelector: HarnessSelector,
): Promise<RunningDaemon> {
  const rpcUrl = fixture.anvil.rpcUrl;
  const chainCfg = getChainConfig('base');

  // 1. SQLite store (Daemon owns this instance; stop() will close it).
  const storePath = join(fixture.implStateRoot, 'daemon-jinn.db');
  const store = new Store(storePath);

  // 2. Let the OS allocate a free port at daemon-startup time (apiPort: 0).
  //    Using 0 avoids a TOCTOU race — no pre-allocation window where another
  //    process could grab the port between our close() and the daemon's bind.
  const apiPort = 0;
  // WARNING — TASK 5+: this URL is http://127.0.0.1:0, which is NOT a usable
  // endpoint. Harnesses constructed below will bake this value into their
  // adapter env at construction time. Task 3 is safe because no harness is
  // invoked. Before Task 5 spawns a harness, the URL must be rebuilt from the
  // ACTUAL bound port after `daemon.start()` returns — read it from
  // `daemon.apiServer?.port` (see src/api/server.ts:683-687) and rebuild the
  // URL, or restructure to build harnesses post-daemon-start.
  const daemonApiUrl = `http://127.0.0.1:${apiPort}`;
  // API token: Daemon will generate a random one when not supplied; match that
  // by not supplying one here — the test doesn't call cost-mutating routes.

  // 3. Build harnesses. Mirror the HarnessEnv shape from main.ts §1614.
  //    - claudePath / claudeModel: use env vars with production defaults
  //      (harnesses just need valid path strings; they won't be invoked in Task 3)
  //    - runner: omitted → LegacyClaudeImpl is not constructed (OK for Task 3)
  //    - storePath: wired so harnesses can hand off artifacts through SQLite
  //    - implStateDirRoot: use fixture.implStateRoot so harness state is isolated
  const claudePath = process.env['JINN_CLAUDE_PATH'] ?? 'claude';
  const claudeModel = process.env['JINN_CLAUDE_MODEL'] ?? 'claude-haiku-4-5-20251001';

  const harnessList = buildHarnesses({
    rpcUrl,
    claudePath,
    claudeModel,
    pk: operator.agentPrivateKey,
    safe: operator.safeAddress,
    // runner omitted → no LegacyClaudeImpl (acceptable for Task 3)
    storePath,
    daemonApiUrl,
    // daemonApiToken omitted → harnesses will handle missing token gracefully
    implStateDirRoot: join(fixture.implStateRoot, 'impl-state'),
    // ipfsRegistryUrl omitted — harnesses that need IPFS won't be invoked in Task 3
    // externalImpls omitted — no operator-supplied harnesses
    // disabledNames omitted — use production defaults
  });

  const implRegistry = new HarnessRegistry({
    default: DEFAULT_HARNESS,
    disabled: [...DEFAULT_DISABLED_HARNESSES],
  });
  for (const impl of harnessList) {
    implRegistry.register(impl);
  }

  // 4. Build MechAdapter. Translation of main.ts §1469.
  //    - routerClaimDeliveryVariant: 'v1' (Base mainnet canonical variant)
  //    - taskDiscovery: omitted — no joined SolverNets in Task 3; daemon
  //      still discovers tasks via on-chain log scanning from DEFAULT_TASK_DISCOVERY_FROM_BLOCK
  //    - evictionRecovery: omitted — no master wallet in the test context
  //    - pollIntervalMs: 300ms (shortened for test cadence)
  const mechAdapter = new MechAdapter({
    rpcUrl,
    mechMarketplaceAddress: chainCfg.mechMarketplace as `0x${string}`,
    routerAddress: (chainCfg.jinnRouter ?? '0xfFa7118A3D820cd4E820010837D65FAfF463181B') as `0x${string}`,
    mechContractAddress: operator.mechAddress,
    safeAddress: operator.safeAddress,
    agentEoaPrivateKey: operator.agentPrivateKey,
    ipfsRegistryUrl: process.env['JINN_IPFS_REGISTRY_URL'] ?? 'https://registry.autonolas.tech',
    ipfsGatewayUrl: process.env['JINN_IPFS_GATEWAY_URL'] ?? 'https://gateway.autonolas.tech',
    pollIntervalMs: 300,
    chainId: 8453,
    routerClaimDeliveryVariant: chainCfg.routerClaimDeliveryVersion,
    // evictionRecovery: omitted — no master wallet in test
    // taskDiscovery: omitted — no joined SolverNets yet (Task 4+ will add them)
  }, store);

  // 5. Build agent viem clients for deliveryDeps (mirrors main.ts §1513 + §1699).
  //    Omitting packagingDeps / envelopeDeps / deliveryDeps in Task 3 because:
  //    - pack() falls back to NotImplementedError (acceptable — no deliveries yet)
  //    - Task 4+ will wire these as needed for the full delivery path

  // 6. Construct Daemon. Translation of main.ts §2046.
  //    - store: injected so Daemon does NOT own it (our stop() closes it explicitly)
  //    - taskSources: omitted (no creator-side tasks in Task 3)
  //    - peers / subgraphUrl / nodeEndpoint: omitted (test environment)
  //    - rewardClaim / balanceTopup / jinnClaim: omitted (interval 0 → no loops)
  //    - status: omitted (GET /v1/status not exercised in Task 3)
  //    - corpusFactory: omitted (no subgraph configured)
  const daemon = new Daemon({
    adapter: mechAdapter,
    // runner not passed — Daemon accepts undefined runner; LegacyClaudeImpl
    // was not constructed since runner was omitted from buildHarnesses above
    runner: undefined as unknown as import('../../src/runner/runner.js').Runner,
    store,        // Daemon adopts (ownsStore=false); our stop() handles close
    dbPath: storePath, // used only when store is absent; kept for completeness
    pollIntervalMs: 300,  // shortened from production 5000ms for test cadence
    apiPort,
    // apiBindHost: default 127.0.0.1 is fine
    // apiToken: omitted → Daemon generates a random per-process token
    peers: [],
    creatorSafeAddress: operator.safeAddress,
    // subgraphUrl / nodeEndpoint / x402 / signer: omitted
    // rewardClaim / balanceTopup / jinnClaim: omitted → those loops don't start
    // corpusFactory / apiServer: omitted → Daemon starts its own API server
    restorationEngine: {
      paths: {
        workingDirRoot: fixture.workingDirRoot,
        implStateDirRoot: join(fixture.implStateRoot, 'impl-state'),
      },
      implRegistry,
      // packagingDeps / envelopeDeps / deliveryDeps: omitted in Task 3
      // joinedSolverNets: omitted — engine falls back to legacy solverType gate
      // manifestResolver / identityPublisher / reputationFeedback: omitted
      operatorConfig: {
        publicEndpoint: daemonApiUrl,
        defaultPriceUsdc: '0',
        perArtifactTypePrice: {},
        donation: { enabled: false },
      },
      harnessMode: 'train',
    },
  });

  // 7. Start the daemon (kicks off all configured loops).
  await daemon.start();

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await daemon.stop();
    store.close();
  };

  return { daemon, store, stop };
}
