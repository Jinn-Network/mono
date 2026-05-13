// client/test/e2e/_daemon-harness-helpers.ts
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toBytes,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(E2E_DIR, '..', '..', '..', 'contracts');
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
  writeContractTx,
  decodeFirstEvent,
} from './task-first-helpers.js';
import { Daemon } from '../../src/daemon/daemon.js';
import { MechAdapter } from '../../src/adapters/mech/adapter.js';
import { getMechDeliveryRate, getTimeoutBounds } from '../../src/adapters/mech/contracts.js';
import { JINN_ROUTER_ABI } from '../../src/adapters/mech/types.js';
import { buildHarnesses } from '../../src/harnesses/impls/index.js';
import { Store } from '../../src/store/store.js';
import {
  HarnessRegistry,
  DEFAULT_HARNESS,
  DEFAULT_DISABLED_HARNESSES,
} from '../../src/harnesses/engine/registry.js';
import { signCanonical } from '../../src/harnesses/engine/signing.js';
export { compileContracts, ANVIL_PRIVATE_KEYS };

// ── V3 task stack ABI fragments (for deploying minimal router stack) ──────────

const ACTIVITY_CHECKER_ABI = [
  {
    name: 'initialize',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_livenessRatio', type: 'uint256' },
      { name: '_owner', type: 'address' },
      { name: '_similarityThreshold', type: 'uint256' },
      { name: '_similarDecayMultiplier', type: 'uint256' },
      { name: '_comparisonWindow', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'setAuthorizedRouter',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newAuthorizedRouter', type: 'address' }],
    outputs: [],
  },
] as const;

const TASK_COORDINATOR_ABI = [
  {
    name: 'initialize',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owner', type: 'address' },
      { name: '_authorizedRouter', type: 'address' },
    ],
    outputs: [],
  },
] as const;

const ROUTER_V3_INIT_ABI = [
  {
    name: 'initialize',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owner', type: 'address' },
      { name: '_mechMarketplace', type: 'address' },
      { name: '_taskCoordinator', type: 'address' },
      { name: '_activityChecker', type: 'address' },
    ],
    outputs: [],
  },
] as const;

const MOCK_MARKETPLACE_ABI = [
  {
    name: 'minResponseTimeout',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'maxResponseTimeout',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';

const CHAIN_CONFIG = getChainConfig('base');

const PASSWORD = 'test-password';

// ── Types ─────────────────────────────────────────────────────────────────────

export type HarnessSelector = 'hermes-agent' | 'claude-code' | 'codex' | 'prediction-v1-baseline';

export interface PostedPredictionTask {
  taskId: bigint;
  taskCidDigest: `0x${string}`;
  manifestDigest: `0x${string}`;
  /**
   * Block number containing the TaskCreated event. waitForDaemonClaim uses
   * this as the initial scan floor so the claim event cannot be missed by a
   * scan that starts at the tip and races forward — if the daemon claims
   * within the same block as the post (possible on Anvil's instant-mine),
   * scanning from the current tip would skip the event permanently.
   */
  createdAtBlock: bigint;
}

export interface DaemonClaim {
  requestId: `0x${string}`;
  txHash: `0x${string}`;
}

/**
 * Locally-deployed V3 task stack.
 *
 * The production JinnRouter on Base mainnet is V1 and does not support the
 * new `createTask(taskCidDigest, manifestDigest, policy, ...)` interface.
 * We deploy a V3 stack locally on the Anvil fork so we can post tasks and
 * have the daemon claim them.
 *
 * The mock mech's `isOperator(safeAddress)` returns true for the bootstrapped
 * operator's Safe so the V3 router's `claimTask` validation passes.
 */
export interface TaskV3Env {
  /** Locally-deployed JinnRouterV3 address. */
  routerAddress: `0x${string}`;
  /** MockTaskMechWithDelivery deployed with `operator = safeAddress`. */
  mockMechAddress: `0x${string}`;
  /** MockTaskMarketplace address used by the V3 router. */
  mockMarketplaceAddress: `0x${string}`;
}

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

// ── Contract deployment helpers ───────────────────────────────────────────────

async function loadContractArtifact(pathFromContracts: string): Promise<{ abi: Abi; bytecode: Hex }> {
  const raw = JSON.parse(
    await readFile(join(CONTRACTS_DIR, pathFromContracts), 'utf8'),
  ) as { abi: Abi; bytecode: Hex };
  return { abi: raw.abi, bytecode: raw.bytecode };
}

async function deployContractFromArtifact(
  publicClient: PublicClient,
  rpcUrl: string,
  account: ReturnType<typeof privateKeyToAccount>,
  artifact: { abi: Abi; bytecode: Hex },
  args: readonly unknown[] = [],
): Promise<Address> {
  const client = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
  const hash = await client.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
    account,
    chain: base,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`deploy failed: ${hash}`);
  if (!receipt.contractAddress) throw new Error(`deploy returned no address: ${hash}`);
  return getAddress(receipt.contractAddress) as Address;
}

/**
 * Deploy a minimal V3 task stack on the Anvil fork.
 *
 * The production JinnRouter V1 at `0xfFa7118A3D820cd4E820010837D65FAfF463181B`
 * does NOT have the `createTask(taskCidDigest, manifestDigest, policy, ...)` interface
 * (it uses the older OLAS request-first flow). We deploy a fresh V3 stack:
 *   JinnRouterV3 + TaskCoordinator + TaskActivityCheckerV3 + MockTaskMarketplace
 * and one MockTaskMechWithDelivery with `operator = safeAddress` so the daemon's
 * Safe-mediated `claimTask` call passes the `isOperator` check.
 *
 * The daemon's MechAdapter is then pointed at the V3 router + mock mech.
 */
export async function deployMinimalV3Stack(
  fixture: DaemonHarnessFixture,
  operator: BootstrappedOperator,
  deployerPrivKey: `0x${string}`,
): Promise<TaskV3Env> {
  const rpcUrl = fixture.anvil.rpcUrl;
  const deployer = privateKeyToAccount(deployerPrivKey);

  const NATIVE_PAYMENT_TYPE = '0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1' as Hex;

  // 1. Load compiled artifacts.
  const [coordinatorArtifact, routerV3Artifact, marketplaceArtifact, activityArtifact, mechArtifact] =
    await Promise.all([
      loadContractArtifact('artifacts/src/tasks/TaskCoordinator.sol/TaskCoordinator.json'),
      loadContractArtifact('artifacts/src/staking/JinnRouterV3.sol/JinnRouterV3.json'),
      loadContractArtifact('artifacts/src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMarketplace.json'),
      loadContractArtifact('artifacts/src/staking/TaskActivityCheckerV3.sol/TaskActivityCheckerV3.json'),
      loadContractArtifact('artifacts/src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMechWithDelivery.json'),
    ]);

  // 2. Deploy coordinator, marketplace, activity checker, router (uninitialized).
  const coordinator = await deployContractFromArtifact(
    fixture.publicClient, rpcUrl, deployer, coordinatorArtifact,
  );
  const marketplace = await deployContractFromArtifact(
    fixture.publicClient, rpcUrl, deployer, marketplaceArtifact,
  );
  const activityChecker = await deployContractFromArtifact(
    fixture.publicClient, rpcUrl, deployer, activityArtifact,
  );
  const router = await deployContractFromArtifact(
    fixture.publicClient, rpcUrl, deployer, routerV3Artifact,
  );

  // 3. Initialize in dependency order.
  const deployerClient = createWalletClient({ account: deployer, chain: base, transport: http(rpcUrl) });

  const initActivity = await deployerClient.writeContract({
    address: activityChecker,
    abi: ACTIVITY_CHECKER_ABI,
    functionName: 'initialize',
    args: [parseEther('0.001'), deployer.address, 64n, 0n, 20n],
    account: deployer,
    chain: base,
  });
  await fixture.publicClient.waitForTransactionReceipt({ hash: initActivity });

  const initCoordinator = await deployerClient.writeContract({
    address: coordinator,
    abi: TASK_COORDINATOR_ABI,
    functionName: 'initialize',
    args: [deployer.address, router],
    account: deployer,
    chain: base,
  });
  await fixture.publicClient.waitForTransactionReceipt({ hash: initCoordinator });

  const initRouter = await deployerClient.writeContract({
    address: router,
    abi: ROUTER_V3_INIT_ABI,
    functionName: 'initialize',
    args: [deployer.address, marketplace, coordinator, activityChecker],
    account: deployer,
    chain: base,
  });
  await fixture.publicClient.waitForTransactionReceipt({ hash: initRouter });

  const setRouter = await deployerClient.writeContract({
    address: activityChecker,
    abi: ACTIVITY_CHECKER_ABI,
    functionName: 'setAuthorizedRouter',
    args: [router],
    account: deployer,
    chain: base,
  });
  await fixture.publicClient.waitForTransactionReceipt({ hash: setRouter });

  // 4. Deploy mock mech with operator = safeAddress.
  //    The V3 router calls `IMechV3(priorityMech).isOperator(msg.sender)` where
  //    msg.sender is the Safe (since claimTask is called via executeSafeTransaction).
  const MOCK_MECH_RATE = parseEther('0.0001');
  const mockMech = await deployContractFromArtifact(
    fixture.publicClient, rpcUrl, deployer, mechArtifact,
    [MOCK_MECH_RATE, NATIVE_PAYMENT_TYPE, operator.safeAddress, marketplace],
  );

  return {
    routerAddress: router,
    mockMechAddress: mockMech,
    mockMarketplaceAddress: marketplace,
  };
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

// ── Mock IPFS server ───────────────────────────────────────────────────────────

/**
 * A minimal in-process HTTP server that acts as an IPFS gateway for the daemon.
 *
 * Serves task JSON at `GET /ipfs/{cid}` paths. The daemon's
 * `fetchSignedTaskFromIpfs` constructs a CID from the on-chain `taskCidDigest`
 * and fetches from `${ipfsGatewayUrl}/ipfs/{cid}`. Point `ipfsGatewayUrl` at
 * this server's `baseUrl` to intercept those fetches without network I/O.
 *
 * Also exposes `register(digest, json)` so you can pre-populate the store
 * before posting a task on-chain.
 */
export interface MockIpfsServer {
  /** Base URL of the server (e.g. `http://127.0.0.1:PORT`). */
  baseUrl: string;
  /**
   * Pre-populate: store `json` at the digest path so the daemon can fetch it.
   * `digest` is the 32-byte hex string (with `0x` prefix) used as the on-chain
   * `taskCidDigest`; the server serves it at `/ipfs/f01551220{digest.slice(2)}`.
   */
  register(digest: `0x${string}`, json: unknown): void;
  /** Tear down the HTTP server. */
  close(): Promise<void>;
}

function listenServer(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('mock IPFS server did not bind to a TCP port'));
        return;
      }
      resolve(addr.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  // Drop keep-alive connections immediately so server.close() doesn't hang
  // waiting for the daemon's undici HTTP/1.1 pool to time out. Node ≥18.2
  // exposes closeAllConnections; we require Node ≥20 per package.json.
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

export async function startMockIpfsServer(): Promise<MockIpfsServer> {
  // Map from CID path (e.g. `f01551220{hex}`) → serialised JSON string.
  const store = new Map<string, string>();

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === 'GET' && req.url?.startsWith('/ipfs/')) {
          const cidPath = decodeURIComponent(req.url.slice('/ipfs/'.length).split('?')[0] ?? '');
          if (store.has(cidPath)) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(store.get(cidPath));
            return;
          }
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end(`not found: ${cidPath}`);
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(err instanceof Error ? err.message : String(err));
      }
    })();
  });

  const port = await listenServer(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    register(digest: `0x${string}`, json: unknown) {
      const hex = digest.startsWith('0x') ? digest.slice(2) : digest;
      // Register under both codec variants the daemon tries (raw f015 and dag-pb f017).
      const raw = `f01551220${hex}`;
      const dagPb = `f01701220${hex}`;
      const serialised = JSON.stringify(json);
      store.set(raw, serialised);
      store.set(dagPb, serialised);
    },
    close() {
      return closeServer(server);
    },
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
 *
 * @param ipfsGatewayUrl - Override the IPFS gateway URL (default: env var or Autonolas
 *   gateway). Pass the `baseUrl` of a `MockIpfsServer` so the daemon's task-fetch
 *   calls hit the in-process server instead of the real Autonolas gateway.
 * @param v3Env - When provided, the daemon uses the locally-deployed V3 router and
 *   mock mech instead of the production V1 JinnRouter. Required for Task 4+ so that
 *   tasks posted via `postPredictionV1Task` are actually claimable.
 */
export async function startDaemon(
  fixture: DaemonHarnessFixture,
  operator: BootstrappedOperator,
  _harnessSelector: HarnessSelector,
  ipfsGatewayUrl?: string,
  v3Env?: TaskV3Env,
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
  //    - routerClaimDeliveryVariant: 'v3' when v3Env is provided (local stack);
  //      'v1' otherwise (production router).
  //    - routerAddress / mechContractAddress: use v3Env addresses when provided;
  //      fall back to production addresses for Task 3 (no-v3Env path).
  //    - taskDiscovery.onchainFromBlock: set to 0 when using the local V3 stack so
  //      the daemon scans from genesis of the fork (block 0) — otherwise it would
  //      default to block ~25M and miss our freshly-deployed router's events.
  //    - evictionRecovery: omitted — no master wallet in test
  //    - pollIntervalMs: 300ms (shortened for test cadence)
  const routerAddress = v3Env
    ? v3Env.routerAddress
    : (chainCfg.jinnRouter ?? '0xfFa7118A3D820cd4E820010837D65FAfF463181B') as `0x${string}`;
  const mechContractAddress = v3Env
    ? v3Env.mockMechAddress
    : operator.mechAddress;
  const mechMarketplaceAddress = v3Env
    ? v3Env.mockMarketplaceAddress
    : chainCfg.mechMarketplace as `0x${string}`;
  const routerClaimDeliveryVariant = v3Env ? 'v3' : chainCfg.routerClaimDeliveryVersion;

  const mechAdapter = new MechAdapter({
    rpcUrl,
    mechMarketplaceAddress,
    routerAddress,
    mechContractAddress,
    safeAddress: operator.safeAddress,
    agentEoaPrivateKey: operator.agentPrivateKey,
    ipfsRegistryUrl: process.env['JINN_IPFS_REGISTRY_URL'] ?? 'https://registry.autonolas.tech',
    ipfsGatewayUrl: ipfsGatewayUrl ?? process.env['JINN_IPFS_GATEWAY_URL'] ?? 'https://gateway.autonolas.tech',
    pollIntervalMs: 300,
    chainId: 8453,
    routerClaimDeliveryVariant,
    // taskDiscovery: omitted → daemon scans from current block onwards; no manifest
    // filter (joinedManifestDigests.size === 0 → all tasks are discovered).
    // evictionRecovery: omitted — no master wallet in test
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

// ── Task posting + claim detection ────────────────────────────────────────────

/**
 * Build, sign, and register a prediction.v1 task with the mock IPFS server,
 * then post it on the locally-deployed V3 JinnRouter.
 *
 * The task uses `solverNetManifestCid = 'prediction.v1'` (the legacy string
 * form); `manifestDigest = keccak256(toBytes('prediction.v1'))`. The daemon's
 * MechAdapter discovers the task via on-chain log scan (no joinedSolverNets
 * filter needed — the filter is skipped when the set is empty), fetches the
 * signed task from the mock IPFS server, and claims it via the Safe.
 *
 * @param fixture        - Anvil harness + scratch dirs.
 * @param operator       - Bootstrapped operator (Safe address used as creator).
 * @param creatorPrivKey - EOA private key that funds + posts the task. Must
 *   have ETH on the fork (fund via `anvil_setBalance` before calling).
 * @param mockIpfs       - Mock IPFS server to register the signed task with.
 * @param v3Env          - Locally-deployed V3 stack addresses (from `deployMinimalV3Stack`).
 */
export async function postPredictionV1Task(
  fixture: DaemonHarnessFixture,
  operator: BootstrappedOperator,
  creatorPrivKey: `0x${string}`,
  mockIpfs: MockIpfsServer,
  v3Env: TaskV3Env,
): Promise<PostedPredictionTask> {
  const rpcUrl = fixture.anvil.rpcUrl;
  const routerAddress = v3Env.routerAddress;
  const marketplaceAddress = v3Env.mockMarketplaceAddress;

  const creator = privateKeyToAccount(creatorPrivKey);
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  // ── Step 1: Build the signed task document ────────────────────────────────
  // The SignedTaskV1 schema requires: schemaVersion, id, solverType,
  // solverNetManifestCid, contractId, contractVersion, role, description,
  // window, spec, eligibility, claimPolicy, creator, createdAt, signature.
  const MANIFEST_CID = 'prediction.v1'; // legacy string form
  const unsignedTaskDoc = {
    schemaVersion: 'task.v1' as const,
    id: 'daemon-harness-e2e-task-4',
    solverType: 'prediction.v1',
    solverNetManifestCid: MANIFEST_CID,
    contractId: 'prediction',
    contractVersion: 'v1',
    role: 'restoration' as const,
    description: 'Will the daemon-harness e2e Task 4 claim succeed? YES.',
    window: {
      startTs: now - 5_000,
      endTs: now + 600_000,
    },
    spec: {
      question: {
        kind: 'binary' as const,
        text: 'Will the daemon-harness e2e Task 4 claim succeed?',
        yesLabel: 'YES' as const,
        noLabel: 'NO' as const,
      },
      source: {
        type: 'prediction-market' as const,
        venue: 'polymarket' as const,
        url: 'https://polymarket.com/event/jinn-daemon-harness-e2e-task4',
        identifiers: {
          marketId: 'jinn-daemon-harness-e2e-task4',
          conditionId: '0xcondition-daemon-harness-e2e-task4',
          yesTokenId: 'yes-token-daemon-harness-e2e-task4',
          noTokenId: 'no-token-daemon-harness-e2e-task4',
        },
      },
      resolution: {
        expectedResolutionTime: new Date(now + 3_600_000).toISOString(),
        rulesText: 'Daemon harness e2e Task 4 fixture resolves YES.',
        rulesUrl: 'https://example.com/jinn-daemon-harness-e2e-task4-rules',
      },
      consensusSnapshot: {
        sampledAt: new Date(now - 10_000).toISOString(),
        probabilityYes: '0.75',
        method: 'best-bid-ask-midpoint' as const,
        bestBidYes: '0.74',
        bestAskYes: '0.76',
        spread: '0.02',
        source: 'polymarket-clob' as const,
      },
      eligibilitySnapshot: {
        sampledAt: new Date(now - 10_000).toISOString(),
        timeToResolutionHours: 1,
        liquidityUsd: '50000',
        volume24hUsd: '20000',
        orderbookAgeSeconds: 5,
        selectionReason: 'deterministic daemon-harness e2e Task 4 fixture',
      },
    },
    eligibility: {},
    claimPolicy: {
      mode: 'parallel' as const,
      maxClaims: 10,
      maxClaimsPerOperator: 1,
      claimLeaseTtlSeconds: 600,
      claimWindowStartTs: nowSec - 5,
      claimWindowEndTs: nowSec + 300,
      submissionDeadlineTs: nowSec + 900,
    },
    creator: {
      safeAddress: operator.safeAddress as `0x${string}`,
      agentEoa: operator.agentAddress as `0x${string}`,
    },
    createdAt: now,
  };

  // Sign the task document with the creator's key (any secp256k1 key works;
  // the daemon does not validate the creator signature at claim time).
  const signed = await signCanonical(unsignedTaskDoc, creatorPrivKey, creator.address);
  const signedTaskDoc = {
    ...unsignedTaskDoc,
    signature: {
      algo: 'secp256k1' as const,
      signer: creator.address,
      hash: signed.hash,
      sig: signed.sig,
    },
  };

  // ── Step 2: Compute on-chain digest and register with mock IPFS ────────────
  // `taskCidDigest` = keccak256(JSON.stringify(signedTaskDoc)).
  // The daemon derives the IPFS CID as `f01551220${digest.slice(2)}` from the
  // on-chain event and fetches from the mock gateway at that path.
  const taskJson = JSON.stringify(signedTaskDoc);
  const taskCidDigest = keccak256(toBytes(taskJson)) as `0x${string}`;
  mockIpfs.register(taskCidDigest, signedTaskDoc);

  // ── Step 3: Compute manifestDigest ────────────────────────────────────────
  const manifestDigest = keccak256(toBytes(MANIFEST_CID)) as `0x${string}`;

  // ── Step 4: Get delivery rate + timeout from the mock mech/marketplace ──────
  // Use the mock mech's maxDeliveryRate so the V3 router's budget check passes.
  const deliveryRate = await getMechDeliveryRate(
    fixture.publicClient,
    v3Env.mockMechAddress as Address,
  );
  const timeoutBounds = await getTimeoutBounds(fixture.publicClient, marketplaceAddress);
  const responseTimeout = timeoutBounds.min > 0n ? timeoutBounds.min : 3600n;

  // ── Step 5: Build claim policy matching the task doc ──────────────────────
  const latestBlock = await fixture.publicClient.getBlock();
  const chainNowSec = Number(latestBlock.timestamp);
  const onchainPolicy = {
    claimWindowStart: BigInt(chainNowSec - 5),
    claimWindowEnd: BigInt(chainNowSec + 300),
    submissionDeadline: BigInt(chainNowSec + 900),
    claimLeaseTtlSeconds: 600,
    maxClaims: 10,
    maxClaimsPerOperator: 1,
    policyHook: zeroAddress,
    evaluationPolicy: {
      requiredVerdicts: 1,
      passThreshold: 1,
      evaluationDeadline: BigInt(chainNowSec + 1_200),
      maxVerdictsPerEvaluator: 1,
      disallowSolverSelfEvaluation: false,
    },
  };

  // ── Step 6: Post task on-chain via the locally-deployed V3 JinnRouter ───────
  // The V3 router's createTask requires: msg.value == solutionBudget + verdictBudget
  // where solutionBudget = rate * maxClaims and verdictBudget = rate * maxClaims * requiredVerdicts.
  // With maxClaims=10 and requiredVerdicts=1: value = rate * 10 + rate * 10 * 1 = rate * 20.
  const MAX_CLAIMS = 10n;
  const REQUIRED_VERDICTS = 1n;
  const rateArg = deliveryRate > 0n ? deliveryRate : parseEther('0.0001');
  const solutionBudget = rateArg * MAX_CLAIMS;
  const verdictBudget = rateArg * MAX_CLAIMS * REQUIRED_VERDICTS;
  const value = solutionBudget + verdictBudget;

  const created = await writeContractTx({
    publicClient: fixture.publicClient,
    rpcUrl,
    account: creator,
    address: routerAddress,
    abi: JINN_ROUTER_ABI,
    functionName: 'createTask',
    args: [taskCidDigest, manifestDigest, onchainPolicy, rateArg, rateArg, responseTimeout],
    value,
  });

  const taskCreated = decodeFirstEvent(created.receipt, JINN_ROUTER_ABI, 'TaskCreated');
  const taskId = BigInt(String(taskCreated['taskId']));
  const createdAtBlock = BigInt(created.receipt.blockNumber ?? 0n);

  return { taskId, taskCidDigest, manifestDigest, createdAtBlock };
}

/**
 * Poll the locally-deployed V3 JinnRouter for a `TaskAttemptCreated` event
 * matching `task.taskId` and `operator.safeAddress` (the operator that the daemon
 * claims with). The daemon claims via its Safe, so the `operator` field in the
 * event is the Safe address.
 *
 * Resolves when the daemon has claimed, or rejects after `timeoutMs`.
 */
export async function waitForDaemonClaim(
  fixture: DaemonHarnessFixture,
  task: PostedPredictionTask,
  operator: BootstrappedOperator,
  v3Env: TaskV3Env,
  timeoutMs = 120_000,
): Promise<DaemonClaim> {
  const routerAddress = v3Env.routerAddress;

  const deadline = Date.now() + timeoutMs;
  // First scan must cover the block containing TaskCreated — Anvil's
  // instant-mine could already have the claim in the same block as the post,
  // and starting from the tip would skip it permanently.
  let scannedUpTo: bigint = task.createdAtBlock > 0n ? task.createdAtBlock - 1n : 0n;

  while (Date.now() < deadline) {
    const currentBlock = await fixture.publicClient.getBlockNumber();
    const fromBlock = scannedUpTo + 1n;
    scannedUpTo = currentBlock;

    if (fromBlock <= currentBlock) {
      const logs = await fixture.publicClient.getLogs({
        address: routerAddress,
        fromBlock,
        toBlock: currentBlock,
      });

      for (const log of logs as Log[]) {
        try {
          const decoded = decodeEventLog({
            abi: JINN_ROUTER_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName !== 'TaskAttemptCreated') continue;
          const args = decoded.args as {
            taskId: bigint;
            attemptIndex: number;
            requestId: Hex;
            operator: `0x${string}`;
            priorityMech: `0x${string}`;
          };
          // Filter by taskId and operator (Safe address).
          if (args.taskId !== task.taskId) continue;
          if (getAddress(args.operator) !== getAddress(operator.safeAddress)) continue;
          return {
            requestId: args.requestId,
            txHash: (log.transactionHash ?? '0x') as `0x${string}`,
          };
        } catch {
          // Not a TaskAttemptCreated event for our ABI — skip.
        }
      }
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `waitForDaemonClaim: timed out after ${timeoutMs}ms waiting for TaskAttemptCreated ` +
    `(taskId=${task.taskId}, operator=${operator.safeAddress})`,
  );
}
