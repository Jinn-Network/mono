// client/test/e2e/_daemon-harness-helpers.ts
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAbiItem,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toBytes,
  type Abi,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { SignedEnvelopeSchema, type SignedEnvelope } from '../../src/types/envelope.js';
import {
  KNOWN_INSTANCE_ID,
  KNOWN_REPO,
  KNOWN_COMMIT,
  KNOWN_MANIFEST_CID,
} from '../release/tier-2/fixtures/known-instance.js';

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = resolve(E2E_DIR, '..', '..', '..', 'contracts');
import {
  spawnAnvilFork,
  spawnAnvilFromState,
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
import { signedEnvelopeJsonFromDeliveryOrRaw } from '../../src/daemon/bridge-legacy-delivery.js';
import { MechAdapter } from '../../src/adapters/mech/adapter.js';
import { createDirectSafeBroadcaster } from '../../src/adapters/mech/direct-safe-broadcaster.js';
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
import { startApiServer } from '../../src/api/server.js';
import type { SolverNetRegistry } from '../../src/solver-nets/registry.js';
import type { Harness } from '../../src/harnesses/types.js';
import { buildOperatorComposition, type OperatorComposition } from '../../src/daemon/composition-root.js';
import type { JinnConfig } from '../../src/config.js';
import { CONFIG_SHAPE_VERSION, type ExecutionWiringConfigEntry } from '../../src/config/shape-v2.js';
import type { MarketplaceChainConfig } from '@jinn-network/marketplace-binding';
import {
  buildRepositoryWorkProfile,
  buildEvaluationTaskProfile,
  sealTaskProfile,
} from '@jinn-network/task-execution-profiles';
import type { ProfileStore } from '@jinn-network/task-execution-profiles';
export { compileContracts, ANVIL_PRIVATE_KEYS };

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
  /** Transaction that emitted TaskCreated for this task. */
  creationTxHash: `0x${string}`;
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

export interface DeliveredTask {
  /** RequestId from the daemon claim. */
  requestId: `0x${string}`;
  /** Tx hash of the Deliver event on the mock mech. */
  deliveryTxHash: `0x${string}`;
  /** Signed envelope assembled by the daemon and uploaded to mock IPFS. */
  envelope: SignedEnvelope;
  /** Solver harness name from envelope.executor.implName. */
  solverHarnessName: string;
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
  /**
   * Locally-deployed TaskActivityCheckerV3 address.
   * Used by `readActivityCount` to read `eligibleActivityWeight[safeAddress]`
   * and assert that the daemon's settle tx incremented the counter.
   */
  activityCheckerAddress: `0x${string}`;
  /**
   * Locally-deployed TaskCoordinator address (Task 18). `MarketplaceChainConfig.taskCoordinator`
   * must point at THIS locally-deployed contract, not the real Base Sepolia
   * `BASE_SEPOLIA_TODAY.taskCoordinator` — this fixture runs on an Anvil fork of Base MAINNET, so
   * the Sepolia address would resolve to unrelated (or empty) bytecode there.
   */
  coordinatorAddress: `0x${string}`;
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

/** Pick the harness from JINN_E2E_HARNESS, default `prediction-v1-baseline`. */
export function harnessSelectorFromEnv(): HarnessSelector {
  const raw = (process.env['JINN_E2E_HARNESS'] ?? 'prediction-v1-baseline').trim();
  if (raw === 'hermes-agent' || raw === 'claude-code' || raw === 'codex' || raw === 'prediction-v1-baseline') {
    return raw;
  }
  throw new Error(`JINN_E2E_HARNESS=${raw} not recognised. Use one of: hermes-agent, claude-code, codex, prediction-v1-baseline.`);
}

export type HarnessKeyCheck = { ok: true } | { ok: false; reason: string };

/**
 * Check whether the API key required by the selected harness is present in
 * the environment. Returns `{ ok: true }` for `prediction-v1-baseline` (no
 * key needed) and for every other selector when the required env var is set.
 *
 * Used at the top of daemon-harness-cycle.ts to skip cleanly (exit 0) when
 * the operator has not configured credentials for the selected harness.
 */
export function checkHarnessApiKey(sel: HarnessSelector): HarnessKeyCheck {
  switch (sel) {
    case 'prediction-v1-baseline':
      return { ok: true };
    case 'hermes-agent':
      if (!process.env['OPENROUTER_API_KEY'] && !process.env['ANTHROPIC_API_KEY']) {
        return { ok: false, reason: 'OPENROUTER_API_KEY or ANTHROPIC_API_KEY required for hermes-agent' };
      }
      return { ok: true };
    case 'claude-code':
      if (!process.env['ANTHROPIC_API_KEY']) {
        return { ok: false, reason: 'ANTHROPIC_API_KEY required for claude-code' };
      }
      return { ok: true };
    case 'codex':
      if (!process.env['OPENAI_API_KEY']) {
        return { ok: false, reason: 'OPENAI_API_KEY required for codex' };
      }
      return { ok: true };
  }
}

/**
 * Map a HarnessSelector to the canonical registered harness name used inside
 * the daemon's HarnessRegistry / envelope.executor.implName.
 *
 * Canonical names come from `client/src/harnesses/names.ts`:
 *   CLAUDE_CODE_HARNESS = 'claude-code'
 *   CODEX_HARNESS       = 'codex'
 *   HERMES_AGENT_HARNESS = 'hermes-agent'
 * PredictionV1BaselineImpl.name = 'prediction-v1-baseline' (from its index.ts).
 */
export function selectorToHarnessName(sel: HarnessSelector): string {
  switch (sel) {
    case 'hermes-agent':           return 'hermes-agent';
    case 'claude-code':            return 'claude-code';
    case 'codex':                  return 'codex';
    case 'prediction-v1-baseline': return 'prediction-v1-baseline';
  }
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
    abi: activityArtifact.abi,
    functionName: 'initialize',
    args: [parseEther('0.001'), deployer.address, 64n, 0n, 20n],
    account: deployer,
    chain: base,
  });
  await fixture.publicClient.waitForTransactionReceipt({ hash: initActivity });

  const initCoordinator = await deployerClient.writeContract({
    address: coordinator,
    abi: coordinatorArtifact.abi,
    functionName: 'initialize',
    args: [deployer.address, router],
    account: deployer,
    chain: base,
  });
  await fixture.publicClient.waitForTransactionReceipt({ hash: initCoordinator });

  const initRouter = await deployerClient.writeContract({
    address: router,
    abi: routerV3Artifact.abi,
    functionName: 'initialize',
    args: [deployer.address, marketplace, coordinator, activityChecker],
    account: deployer,
    chain: base,
  });
  await fixture.publicClient.waitForTransactionReceipt({ hash: initRouter });

  const setRouter = await deployerClient.writeContract({
    address: activityChecker,
    abi: activityArtifact.abi,
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
    activityCheckerAddress: activityChecker,
    coordinatorAddress: coordinator,
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
 * Like {@link setupAnvilFixture}, but loads the committed Anvil `--dump-state`
 * snapshot (deterministic, no live RPC) instead of forking Base. This is the
 * HERMETIC-gate variant (spec §3.1/§4): the loaded state already carries the
 * real OLAS + Safe + registry bytecode, so the full daemon loop runs without
 * touching the network. `spawnAnvilFromState` forces the snapshot's chain id.
 */
export async function setupAnvilFixtureFromState(statePath: string): Promise<DaemonHarnessFixture> {
  await compileContracts();
  const anvil = await spawnAnvilFromState({ statePath, silent: true });
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

// ── FORK-ONLY REMEDIATION (issue #2341 — NOT shipped, NOT a production fix) ────
//
// Live Base mainnet's ServiceRegistryL2 (0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE)
// has never whitelisted the stOLAS `gnosisSafeSameAddressMultisig` implementation
// (0xFbBEc0C8b13B38a9aC0499694A69a10204c5E2aB) that ExternalStakingDistributor's
// stake() path deploys services against:
//
//   cast call 0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE \
//     "mapMultisigs(address)(bool)" 0xFbBEc0C8b13B38a9aC0499694A69a10204c5E2aB \
//     --rpc-url https://mainnet.base.org
//   → false
//
// stake() reverts with UnauthorizedMultisig(0xFbBEc0C8b13B38a9aC0499694A69a10204c5E2aB)
// (selector 0x14460f20). This is a LIVE-CHAIN breakage tracked at
// https://github.com/Jinn-Network/mono/issues/2341 — Jinn does not own
// ServiceRegistryL2 and cannot fix it there. Per Ruling 3 on that issue, the
// harness MAY impersonate the registry owner on this Anvil FORK ONLY and apply
// the missing whitelist entry so the e2e loop can exercise everything
// downstream of bootstrap. This function must never run against a live chain —
// it only ever touches an in-process Anvil fork's state.
const SERVICE_REGISTRY_OWNER_ABI = parseAbi([
  'function owner() view returns (address)',
  'function mapMultisigs(address multisig) view returns (bool)',
  'function changeMultisigPermission(address multisig, bool permission) external',
]);

async function remediateStOlasMultisigAuthorizationOnFork(rpcUrl: string): Promise<void> {
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const registry = CHAIN_CONFIG.serviceRegistry as Address;
  const multisig = CHAIN_CONFIG.gnosisSafeSameAddressMultisig as Address;

  const alreadyAuthorized = await publicClient.readContract({
    address: registry,
    abi: SERVICE_REGISTRY_OWNER_ABI,
    functionName: 'mapMultisigs',
    args: [multisig],
  });
  if (alreadyAuthorized) return;

  const owner = getAddress(
    await publicClient.readContract({
      address: registry,
      abi: SERVICE_REGISTRY_OWNER_ABI,
      functionName: 'owner',
    }),
  ) as Address;

  process.stdout.write(
    `[fork-remediation #2341] ServiceRegistryL2.mapMultisigs(${multisig}) is false on the ` +
    `forked chain (mirrors live Base mainnet). Impersonating registry owner ${owner} ` +
    `INSIDE THIS ANVIL FORK ONLY to call changeMultisigPermission(${multisig}, true) — ` +
    `this is test-setup remediation for a live-chain breakage, not something Jinn ships.\n`,
  );

  await anvilJsonRpc(rpcUrl, 'anvil_setBalance', [owner, '0x56BC75E2D63100000']); // 100 ETH for gas
  await anvilJsonRpc(rpcUrl, 'anvil_impersonateAccount', [owner]);
  try {
    const ownerWallet = createWalletClient({ account: owner, chain: base, transport: http(rpcUrl) });
    const hash = await ownerWallet.writeContract({
      address: registry,
      abi: SERVICE_REGISTRY_OWNER_ABI,
      functionName: 'changeMultisigPermission',
      args: [multisig, true],
      account: owner,
      chain: base,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  } finally {
    await anvilJsonRpc(rpcUrl, 'anvil_stopImpersonatingAccount', [owner]);
  }

  const nowAuthorized = await publicClient.readContract({
    address: registry,
    abi: SERVICE_REGISTRY_OWNER_ABI,
    functionName: 'mapMultisigs',
    args: [multisig],
  });
  if (!nowAuthorized) {
    throw new Error(
      `[fork-remediation #2341] mapMultisigs(${multisig}) still false after changeMultisigPermission`,
    );
  }
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

  // FORK-ONLY: see `remediateStOlasMultisigAuthorizationOnFork` above — issue #2341.
  await remediateStOlasMultisigAuthorizationOnFork(rpcUrl);

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
 * A minimal in-process HTTP server that acts as both an IPFS gateway and
 * registry for the daemon.
 *
 * Serves task JSON at `GET /ipfs/{cid}` paths. The daemon's
 * `fetchSignedTaskFromIpfs` constructs a CID from the on-chain `taskCidDigest`
 * and fetches from `${ipfsGatewayUrl}/ipfs/{cid}`. Point `ipfsGatewayUrl` at
 * this server's `baseUrl` to intercept those fetches without network I/O.
 *
 * Also handles `POST /api/v0/add` uploads (Kubo API format) so the daemon's
 * `uploadToIpfs` call succeeds. Uploaded content is stored in the same map as
 * registered content — the CID returned is a deterministic sha256-based CIDv1
 * hex string (`f01551220{sha256hex}`).
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
  /**
   * Look up uploaded content by CID string (e.g. `f01551220{hex}`).
   * Returns the parsed JSON or undefined if not found.
   */
  getUploaded(cid: string): unknown | undefined;
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

/**
 * Read the full body of an IncomingMessage as a Buffer.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a multipart/form-data body (minimal — only extracts the first `file` part).
 * Returns the raw bytes of the file part.
 */
function parseMultipartBody(body: Buffer, contentType: string): Buffer | null {
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) return null;
  const boundary = `--${boundaryMatch[1]}`;
  const bodyStr = body.toString('binary');
  const parts = bodyStr.split(boundary);
  for (const part of parts) {
    if (!part.includes('Content-Disposition')) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    // Strip leading \r\n and trailing --\r\n
    const content = part.slice(headerEnd + 4);
    const trimmed = content.replace(/\r\n--$/, '').replace(/\r\n$/, '');
    return Buffer.from(trimmed, 'binary');
  }
  return null;
}

// RFC4648 base32 (no padding), lowercase — the multibase 'b' alphabet IPFS
// uses for CIDv1. Mirrors the inverse of `base32Decode` in
// src/adapters/mech/ipfs.ts.
const MOCK_BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32EncodeNoPad(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += MOCK_BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += MOCK_BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Build a CIDv1-raw base32 string (`b…`, e.g. `bafkrei…`) from a sha256 hex
 * digest — the same multibase form the real Autonolas registry returns and
 * the form the daemon's production CID validation (`CID_SHAPE_REGEX` in
 * api/solvernets-endpoints.ts) accepts. Bytes: version 0x01, codec 0x55 (raw),
 * multihash 0x12 (sha2-256) 0x20 (32-byte length) + digest.
 */
function cidv1RawBase32FromSha256Hex(sha256hex: string): string {
  const digest = new Uint8Array(sha256hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  const cidBytes = new Uint8Array(4 + digest.length);
  cidBytes[0] = 0x01; // CIDv1
  cidBytes[1] = 0x55; // raw codec
  cidBytes[2] = 0x12; // sha2-256
  cidBytes[3] = 0x20; // 32 bytes
  cidBytes.set(digest, 4);
  return `b${base32EncodeNoPad(cidBytes)}`;
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

        // Handle IPFS registry upload: POST /api/v0/add (Kubo API format).
        // The daemon's `uploadToIpfs` sends a multipart/form-data POST with a
        // single `file` field containing JCS-encoded JSON bytes. We:
        //   1. Parse the multipart body to extract the file bytes.
        //   2. Compute a sha256 digest of the bytes.
        //   3. Derive a CIDv1 hex key: `f01551220{sha256hex}`.
        //   4. Store the raw content under that CID path.
        //   5. Return `{"Hash": "<cidPath>"}` so the daemon can reference it.
        if (req.method === 'POST' && req.url?.startsWith('/api/v0/add')) {
          const contentType = req.headers['content-type'] ?? '';
          const body = await readBody(req);
          let fileBytes: Buffer;
          if (contentType.includes('multipart/form-data')) {
            const parsed = parseMultipartBody(body, contentType);
            fileBytes = parsed ?? body;
          } else {
            fileBytes = body;
          }
          const sha256hex = createHash('sha256').update(fileBytes).digest('hex');
          // Return a base32 CIDv1 (`bafkrei…`) — the multibase form the real
          // Autonolas registry returns and that the daemon's production CID
          // validation accepts (CID_SHAPE_REGEX only admits `Qm…`/`b…`). The
          // SolverNet launch persists this Hash as `manifestCid`; returning the
          // legacy base16 (`f01551220…`) form made `GET /v1/solvernets/registry/:cid`
          // 400 (invalid_cid) so the catalog could not enrich a fork-launched
          // SolverNet (T2.3). Store under the base32 key (what the daemon will
          // GET back) plus the legacy base16 raw/dag-pb keys so digest-derived
          // gateway fetches (T2.2 / daemon-harness-cycle, which address content
          // by on-chain digest as `f01551220{digest}`) keep resolving.
          const cidB32 = cidv1RawBase32FromSha256Hex(sha256hex);
          const serialised = fileBytes.toString('utf8');
          store.set(cidB32, serialised);
          store.set(`f01551220${sha256hex}`, serialised);
          store.set(`f01701220${sha256hex}`, serialised);
          console.log(`[mock-ipfs] uploaded cid=${cidB32} bytes=${fileBytes.length}`);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ Hash: cidB32, Size: fileBytes.length, Name: 'content.json' }));
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
    getUploaded(cid: string): unknown | undefined {
      const serialised = store.get(cid);
      if (!serialised) return undefined;
      try { return JSON.parse(serialised) as unknown; } catch { return undefined; }
    },
    close() {
      return closeServer(server);
    },
  };
}

// ── Daemon startup ─────────────────────────────────────────────────────────────

/**
 * Resolve swe-rebench-v2 substrate dir for daemon e2e harness construction.
 * Production `main.ts` threads `config.sweRebenchV2StateDir`; T2.4 and peers
 * set `JINN_SWE_REBENCH_V2_STATE_DIR` before `startDaemon` (#2097).
 */
export function sweRebenchV2StateDirFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env['JINN_SWE_REBENCH_V2_STATE_DIR'];
  return value === undefined || value === '' ? undefined : value;
}

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
 *   - rewardClaim / balanceTopup: omitted (interval 0 → loops not started).
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
  harnessSelector: HarnessSelector,
  ipfsGatewayUrl?: string,
  v3Env?: TaskV3Env,
  /**
   * When provided, used as the IPFS registry URL for uploads (POST /api/v0/add).
   * The mock IPFS server accepts uploads at its baseUrl + /api/v0/add — pass
   * mockIpfs.baseUrl here so the daemon's uploadToIpfs calls hit the mock.
   * Falls back to the real Autonolas registry when absent.
   */
  ipfsRegistryUrl?: string,
  /**
   * Optional overrides for the daemon's build. Used by multi-operator
   * scenarios (T2.2) that need to evaluate prediction.v1 solutions against a
   * deterministic, offline market-resolution source rather than the live
   * Polymarket Gamma API.
   *
   * - `polymarketGammaBaseUrl` — base URL of a Polymarket Gamma API mirror.
   *   `buildHarnesses` forwards it into `PredictionV1Evaluator`, whose
   *   `getResolution` call then hits the mock server instead of
   *   `gamma-api.polymarket.com`. Point it at a `MockPolymarketGammaServer`
   *   so the evaluator/verdict leg is deterministic and needs no network.
   * - `enableComposition` (Task 18) — build a real `OperatorComposition` via
   *   `buildOperatorComposition` and pass it on `DaemonConfig.composition`, exactly like
   *   `main.ts`'s testnet branch. Requires `v3Env` (the composition's `MarketplaceChainConfig`
   *   is built entirely from the locally-deployed V3 addresses — there is no equivalent
   *   deployment to target on production Base mainnet, which is what `v3Env`-absent callers run
   *   against). Defaults to `false` because it needs `v3Env`, not because of any process-wide
   *   collision risk: as of finding E16 / the C2 ruling, `buildOperatorComposition` returns its
   *   broadcaster on `OperatorComposition.broadcaster` instead of installing a process-global
   *   singleton, and `startDaemon` threads that instance to `mechAdapter` / `deliveryDeps` itself
   *   (see step 6.5/7 below) — two `startDaemon` calls in one process (T2.2's op-a + op-b) each
   *   get their own broadcaster bound to their own Safe and no longer race. `jinn-repo-loop.ts` /
   *   `jinn-repo-live-loop.ts` still don't pass this flag today (unrelated to this fix — see their
   *   own callers), but nothing about the broadcaster design blocks them from doing so.
   */
  opts?: {
    polymarketGammaBaseUrl?: string;
    instanceLabel?: string;
    enableComposition?: boolean;
    /**
     * D0a round-2 critical fix: threaded straight to `buildOperatorComposition`'s
     * `installDefaultEoaBroadcastLock` (composition-root.ts). Only meaningful when
     * `enableComposition` is also `true`. Defaults to `true` (unchanged behavior). A caller that
     * runs `startDaemon` with `enableComposition: true` MORE THAN ONCE in the same process must
     * pass `false` for every call after the first, or the second call's `buildOperatorComposition`
     * throws (`setDefaultEoaBroadcastLock` refuses to silently rebind a conflicting key — see
     * `tx-retry.ts`).
     */
    installDefaultEoaBroadcastLock?: boolean;
  },
  /**
   * Extra SolverType→harness-name dispatch entries merged into
   * `solverTypeHarnesses` on top of the prediction.v1 mapping derived from
   * `harnessSelector`. Used by the jinn-repo loop driver to force
   * `jinn-repo.v1` restoration onto the claude-code learner. Honored only when
   * the named harness `supports(ctx)` (see HarnessRegistry.findFor) — so an
   * entry mapping jinn-repo.v1 → claude-code does NOT capture the evaluation
   * leg (claude-code returns false for evaluation), which still first-matches
   * the JinnRepoEvaluatorHarness. Defaults to `{}` → no behavioural change for
   * the prediction consumer.
   */
  extraSolverTypeHarnesses?: Record<string, string>,
  /**
   * Optional SolverNetRegistry-like object passed straight through to the
   * TaskEngine. The engine consults it to (a) gate claims on an enabled
   * SolverNet for the task's solverType and (b) resolve the SolverNet's
   * runtime plugins so the solver harness loads the SolverType's bundled
   * runtime SKILL (e.g. jinn-repo-runtime → checkout-mono-at-base_commit).
   *
   * MUST stay undefined for the prediction consumer (daemon-harness-cycle.ts):
   * when set, the engine REJECTS any task whose solverType has no enabled net,
   * which would break the prediction flow that relies on the no-registry path.
   * Defaults to undefined → no behavioural change.
   */
  solverNetRegistry?: SolverNetRegistry,
  /**
   * Extra raw Harness instances registered directly into the HarnessRegistry
   * alongside `harnessList` (in addition to, not instead of, the named
   * harnesses `buildHarnesses` constructs). Used by the jinn-repo live-issue
   * loop driver to inject a deterministic, no-LLM synthetic restoration
   * harness for `jinn-repo.v1` (mirrors `PredictionV1BaselineImpl`'s
   * zero-credential pattern) — the mechanical evaluator under test needs a
   * candidate patch delivered on-chain through the real claim → execute →
   * deliver pipeline, not an actual solve leg. Defaults to `[]` → no
   * behavioural change for existing consumers.
   */
  extraHarnesses?: Harness[],
): Promise<RunningDaemon> {
  const rpcUrl = fixture.anvil.rpcUrl;
  const chainCfg = getChainConfig('base');

  // 1. SQLite store (Daemon owns this instance; stop() will close it).
  //    Multi-operator scenarios (T2.2) start two daemons against one fixture;
  //    `instanceLabel` keeps their SQLite files and impl-state dirs distinct so
  //    they do not collide on a shared `implStateRoot`.
  const label = opts?.instanceLabel ?? 'daemon';
  const storePath = join(fixture.implStateRoot, `${label}-jinn.db`);
  const store = new Store(storePath);

  // 2. Fix for the Task 3 latent daemonApiUrl: 0 bug.
  //
  //    The root cause: subprocess-based harnesses (hermes-agent, claude-code,
  //    codex) bake `daemonApiUrl` at construction time inside `buildHarnesses`.
  //    If we call `buildHarnesses` before `daemon.start()`, the URL contains
  //    port 0 and every harness subprocess gets `DAEMON_API_URL=http://127.0.0.1:0`.
  //
  //    Fix chosen: **option (b) — pre-start the API server** via `startApiServer`
  //    before constructing the daemon. `startApiServer({ port: 0 })` lets the OS
  //    assign a free port and returns the real bound port. We then pass this
  //    already-started server to `Daemon` via `config.apiServer` so the daemon
  //    adopts it instead of starting its own. The pre-started server is closed in
  //    `stop()` since `ownsApiServer=false` means Daemon won't close it.
  //
  //    This approach:
  //      ✓ No TOCTOU race (OS-assigned port stays bound until daemon adopts it)
  //      ✓ No production code changes needed (DaemonConfig.apiServer is the
  //        established injection mechanism used by main.ts setup-mode)
  //      ✓ Harnesses receive the real URL at construction time
  const preStartedApiServer = await startApiServer({
    port: 0,      // OS assigns a free port — actual port read from .port below
    store,
    apiToken: 'test-token-daemon-harness', // test-only; cost-mutating routes not exercised
  });
  const daemonApiUrl = `http://127.0.0.1:${preStartedApiServer.port}`;
  console.log(`[startDaemon] pre-started API server on port ${preStartedApiServer.port}`);

  // 3. Build harnesses with the real daemonApiUrl. Mirror the HarnessEnv shape
  //    from main.ts §1614. All subprocess-harness URL fields are populated so
  //    hermes-agent / claude-code / codex subprocesses get a working API URL.
  //    - runner: omitted → LegacyClaudeImpl is not constructed
  //    - storePath: wired so harnesses can hand off artifacts through SQLite
  //    - implStateDirRoot: use fixture.implStateRoot so harness state is isolated
  const claudePath = process.env['JINN_CLAUDE_PATH'] ?? 'claude';
  const claudeModel = process.env['JINN_CLAUDE_MODEL'] ?? 'claude-haiku-4-5-20251001';

  const resolvedIpfsRegistryUrl = ipfsRegistryUrl
    ?? process.env['JINN_IPFS_REGISTRY_URL']
    ?? 'https://registry.autonolas.tech';

  const sweRebenchV2StateDir = sweRebenchV2StateDirFromEnv();

  const harnessList = buildHarnesses({
    rpcUrl,
    claudePath,
    claudeModel,
    pk: operator.agentPrivateKey,
    safe: operator.safeAddress,
    // runner omitted → no LegacyClaudeImpl
    storePath,
    daemonApiUrl,
    // daemonApiToken omitted → harnesses will handle missing token gracefully
    // Label-scoped so two daemons (T2.2) do not share an impl-state dir.
    implStateDirRoot: join(fixture.implStateRoot, `${label}-impl-state`),
    // ipfsRegistryUrl wired so harnesses that upload artifacts use the mock
    ipfsRegistryUrl: resolvedIpfsRegistryUrl,
    // Codex subprocess env defaults
    codexPath: process.env['JINN_CODEX_PATH'] ?? 'codex',
    codexModel: process.env['JINN_CODEX_MODEL'] ?? 'gpt-4.1-mini',
    // Hermes subprocess env defaults
    hermesPath: process.env['JINN_HERMES_PATH'] ?? 'hermes',
    hermesModel: process.env['JINN_HERMES_MODEL'] ?? 'google/gemini-2.5-flash',
    hermesProvider: process.env['JINN_HERMES_PROVIDER'] ?? 'openrouter',
    // externalImpls omitted — no operator-supplied harnesses
    // disabledNames omitted — use production defaults
    // polymarketGammaBaseUrl: when set, the PredictionV1Evaluator resolves
    // markets against this mirror instead of the live Gamma API. T2.2 points
    // it at a MockPolymarketGammaServer so the verdict leg is deterministic.
    ...(opts?.polymarketGammaBaseUrl
      ? { polymarketGammaBaseUrl: opts.polymarketGammaBaseUrl }
      : {}),
    ...(sweRebenchV2StateDir ? { sweRebenchV2StateDir } : {}),
  });

  // 4. Wire the selected harness into HarnessRegistry dispatch.
  //
  //    HermesHarness.supports() now returns true for any restoration role,
  //    but PredictionV1BaselineImpl is registered BEFORE hermes-agent in
  //    buildHarnesses(), so prediction.v1 falls to the baseline by first-match.
  //    LearnerHarness.supports() explicitly returns false for 'prediction.v1'
  //    (because prediction.v1 has a first-party typed harness). So for
  //    hermes-agent / claude-code / codex to handle prediction.v1 tasks we
  //    must override dispatch via solverTypeHarnesses rather than first-match.
  //
  //    PredictionV1BaselineImpl.supports() returns true for prediction.v1, so
  //    that stays as first-match (no solverTypeHarnesses entry needed for it).
  //
  //    The selected harness name is the canonical name from names.ts —
  //    see `selectorToHarnessName` above.
  const selectedHarnessName = selectorToHarnessName(harnessSelector);
  const solverTypeHarnesses: Record<string, string> = {
    ...(harnessSelector === 'prediction-v1-baseline'
      ? {}
      : { 'prediction.v1': selectedHarnessName }),
    ...(extraSolverTypeHarnesses ?? {}),
  };

  const implRegistry = new HarnessRegistry({
    default: DEFAULT_HARNESS,
    disabled: [...DEFAULT_DISABLED_HARNESSES],
    solverTypeHarnesses,
  });
  for (const impl of harnessList) {
    implRegistry.register(impl);
  }
  for (const impl of extraHarnesses ?? []) {
    implRegistry.register(impl);
  }

  // 5. Build MechAdapter. Translation of main.ts §1469.
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

  const resolvedIpfsGatewayUrl = ipfsGatewayUrl
    ?? process.env['JINN_IPFS_GATEWAY_URL']
    ?? 'https://gateway.autonolas.tech';

  const mechAdapter = new MechAdapter({
    rpcUrl,
    mechMarketplaceAddress,
    routerAddress,
    mechContractAddress,
    safeAddress: operator.safeAddress,
    agentEoaPrivateKey: operator.agentPrivateKey,
    ipfsRegistryUrl: resolvedIpfsRegistryUrl,
    ipfsGatewayUrl: resolvedIpfsGatewayUrl,
    // Hermetic Anvil+mock e2es always pass mockIpfs.baseUrl as ipfsGatewayUrl.
    // Pin primary-only so a mock 404 cannot leak to public ipfs.io (#1648).
    ...(ipfsGatewayUrl !== undefined ? { ipfsFallbackGatewayUrl: false as const } : {}),
    pollIntervalMs: 300,
    chainId: 8453,
    routerClaimDeliveryVariant,
    // taskDiscovery: omitted → daemon scans from current block onwards; no manifest
    // filter (joinedManifestDigests.size === 0 → all tasks are discovered).
    // evictionRecovery: omitted — no master wallet in test
  }, store);

  // 6. Build agent viem clients for deliveryDeps (mirrors main.ts §1513 + §1699).
  //    These are required for the full delivery path (Task 5+).
  const { createClients } = await import('../../src/adapters/mech/safe.js');
  const agentClients = createClients(rpcUrl, operator.agentPrivateKey, base);

  // 6.5 (Task 18). Build the stage-1 cutover composition root, mirroring main.ts's
  //     testnet-only branch (main.ts §2164 "Stage-1 cutover composition root"). Gated on
  //     `opts.enableComposition` — see that field's doc comment above for why this is opt-in
  //     rather than automatic whenever `v3Env` is present.
  //
  //     `config` is a minimal `JinnConfig`-shaped fixture, not a fully-defaulted config
  //     (`JinnConfigSchema.parse(...)` plus `loadConfig()`'s rpcUrl/engine post-processing would
  //     be needed for that, and this rig never boots through the file-based config loader —
  //     `startDaemon` builds every dependency explicitly, matching the rest of this file's
  //     pattern). It is cast to `JinnConfig` because `buildOperatorComposition` only ever reads
  //     `config.ipfsRegistryUrl` / `config.claudePath` / `config.codexPath` / `config.hermesPath`
  //     / `config.executionWiring` / `config.claimPolicy` (verified against composition-root.ts)
  //     — every field this fixture sets is real and exercises the real code path; the cast is
  //     only standing in for the ~60 unrelated `JinnConfig` fields buildOperatorComposition never
  //     touches.
  //
  //     `configShapeVersion: 2` / `executionWiring` / `claimPolicy` are the shape-v2 keys (Task
  //     1, `src/config/shape-v2.ts`) the plan calls for. `executionWiring`'s single entry's
  //     `legacyManifestDigest` is set to the SAME digest `postPredictionV1Task` computes
  //     (`keccak256(toBytes('prediction.v1'))`) so `matchLegacyManifestDigest` (the bridge
  //     predicate composition-root.ts's `buildClaimPredicate` builds for
  //     `mode: 'match-legacy-manifest-digest'`) recognizes a legacy-bridged prediction.v1 card.
  let composition: OperatorComposition | undefined;
  if (opts?.enableComposition === true) {
    if (!v3Env) {
      throw new Error('startDaemon: opts.enableComposition requires v3Env (no local V3 stack to target)');
    }
    const PREDICTION_V1_LEGACY_MANIFEST_CID = 'prediction.v1';
    const legacyManifestDigest = keccak256(toBytes(PREDICTION_V1_LEGACY_MANIFEST_CID));

    const executionWiring: ExecutionWiringConfigEntry[] = [
      {
        workKind: 'prediction.v1',
        harness: selectedHarnessName,
        model: claudeModel,
        plugins: [],
        credentialRef: 'e2e-daemon-harness',
        isolationPolicy: 'process',
        legacyManifestDigest,
      },
    ];
    const compositionConfig = {
      configShapeVersion: CONFIG_SHAPE_VERSION,
      claimPolicy: {
        mode: 'match-legacy-manifest-digest' as const,
        spendCapWei: '1000000000000000000',
        aiUnitCap: 1000,
      },
      executionWiring,
      ipfsRegistryUrl: resolvedIpfsRegistryUrl,
      // Last-mile fix: `buildOperatorComposition`'s projector (`resolveSubmissionBytes`'s IPFS
      // fetch, `readSealedDocuments`) reads `config.ipfsGatewayUrl` via the SAME
      // `buildFetchIpfsBytes` helper the MechAdapter above already uses `resolvedIpfsGatewayUrl`
      // for -- this was an accidental omission (composition-root.ts's `fetchIpfsBytes` port always
      // failed closed with no gateway URL, which was invisible while `resolveSubmissionBytes`
      // never called it at all). Must be the SAME mock IPFS gateway the MechAdapter/creator write
      // task documents to, or the composition reads from a different (real) gateway than the one
      // this fixture's tasks are actually pinned to.
      ipfsGatewayUrl: resolvedIpfsGatewayUrl,
      claudePath,
      codexPath: process.env['JINN_CODEX_PATH'] ?? 'codex',
      hermesPath: process.env['JINN_HERMES_PATH'] ?? 'hermes',
    } as unknown as JinnConfig;

    const profileDocuments = [buildRepositoryWorkProfile(), buildEvaluationTaskProfile()];
    const profilesByDigest = new Map(profileDocuments.map((doc) => [sealTaskProfile(doc).digest, doc]));
    const profileStore: ProfileStore = { get: (digest) => profilesByDigest.get(digest) };

    // `taskCoordinator`/`activityChecker` MUST be the locally-deployed V3 addresses, not
    // `BASE_SEPOLIA_TODAY`'s real Base Sepolia addresses — this fixture runs on an Anvil fork of
    // Base MAINNET (chainId 8453; `spawnAnvilFork` forks with no `--chain-id` override), so a
    // Sepolia address would resolve to unrelated bytecode there.
    const chain: MarketplaceChainConfig = {
      chainId: 8453,
      taskCoordinator: v3Env.coordinatorAddress,
      jinnRouter: v3Env.routerAddress,
      mechMarketplace: v3Env.mockMarketplaceAddress,
      activityChecker: v3Env.activityCheckerAddress,
      generation: 'today',
    };
    const venueStartBlock = await agentClients.publicClient.getBlockNumber();

    // This full-loop fixture covers the explicit legacy bridge composition. Its delivery signer is
    // test-only and remains confined to that legacy path; production startup supplies no such
    // Ed25519 key, while native composition takes its signer from RoleIdentitySet instead.
    const deliveryKeyPair = generateKeyPairSync('ed25519');
    const legacyDeliverySigningKey = {
      keyId: `e2e-daemon-harness-${label}`,
      publicKey: deliveryKeyPair.publicKey,
      sign: (payload: Uint8Array): Uint8Array =>
        new Uint8Array(cryptoSign(null, payload, deliveryKeyPair.privateKey)),
    };

    // `legacyBridgeSigner` — real synchronous secp256k1 signer, ported from
    //    `client/test/bridge/converged-delivery-legacy-evaluator.test.ts`'s `syncSign`. Recovery
    //    format is reordered to r||s||recovery (the convention `harnesses/engine/signing.ts`
    //    uses); noble's own `'recovered'` format puts the recovery byte first.
    const legacyBridgePrivateKey = secp256k1.utils.randomSecretKey();
    const legacyBridgeSigner = (hash: `0x${string}`): `0x${string}` => {
      const message = Buffer.from(hash.slice(2), 'hex');
      const recovered = secp256k1.sign(message, legacyBridgePrivateKey, {
        prehash: false,
        format: 'recovered',
      });
      const recovery = recovered[0]!;
      const rs = Buffer.from(recovered.slice(1));
      return `0x${rs.toString('hex')}${recovery.toString(16).padStart(2, '0')}` as `0x${string}`;
    };

    composition = await buildOperatorComposition({
      mode: 'legacy',
      config: compositionConfig,
      publicClient: agentClients.publicClient,
      walletClient: agentClients.walletClient as unknown as WalletClient,
      safeAddress: operator.safeAddress,
      mechAddress: v3Env.mockMechAddress,
      chain,
      stateRoot: join(fixture.implStateRoot, `${label}-backend`),
      evidenceRoot: join(fixture.implStateRoot, `${label}-evidence`),
      venueStateDbPath: join(fixture.implStateRoot, `${label}-venue.db`),
      venueLogSource: { startBlock: venueStartBlock, finalityDepthFallback: 0n },
      profileStore,
      legacyDeliverySigningKey,
      legacyBridgeSigner,
      // C8: required — backs the projector's durable cursor/observations and the engagement
      // ledger. Its absence here (an accidental omission, not intentional) is exactly what made
      // `ProjectorLoop` crash on its first tick with `store.setConfigValue` on `undefined` —
      // `store` is this same daemon's own SQLite `Store` (built above, step 3), not a separate
      // instance.
      store,
      // Diagnostic only: surfaces composition-root.ts's own file-header gap (a) warnings
      // ("no production Submission/dispatch-context resolver exists for today-generation tasks
      // yet") on stdout so a stalled projector is diagnosable instead of silently ticking.
      logger: { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) },
      installDefaultEoaBroadcastLock: opts.installDefaultEoaBroadcastLock ?? true,
    });
  }

  // The composition owns the durable venue broadcaster when enabled. Standalone harnesses own a
  // one-shot direct broadcaster instead, matching the explicit host boundary used by CLI verbs.
  const broadcaster = composition?.broadcaster ?? createDirectSafeBroadcaster(
    agentClients.publicClient,
    agentClients.walletClient as unknown as WalletClient,
    operator.safeAddress as Address,
  );
  mechAdapter.setBroadcaster(broadcaster);

  // 7. Wire packagingDeps, envelopeDeps, deliveryDeps (Task 5).
  //    - packagingDeps: operatorEndpoint + pricing config for artifact serving.
  //      No artifact donation in tests; donation.enabled = false.
  //    - envelopeDeps: agent EOA private key + IPFS registry URL for envelope upload.
  //    - deliveryDeps: viem clients + contract addresses for on-chain delivery.
  //    The safeAddress in envelopeDeps matches the operator Safe so the
  //    envelope's participant.safeAddress is correct.
  const packagingDeps = {
    operatorEndpoint: daemonApiUrl,
    defaultPriceUsdc: '0',
    perArtifactTypePrice: {} as Record<string, string>,
    donation: {
      enabled: false,
      ipfsRegistryUrl: resolvedIpfsRegistryUrl,
    },
  };

  const envelopeDeps = {
    ipfsRegistryUrl: resolvedIpfsRegistryUrl,
    agentEoaPrivateKey: operator.agentPrivateKey,
    safeAddress: operator.safeAddress,
  };

  const deliveryDeps = {
    publicClient: agentClients.publicClient,
    walletClient: agentClients.walletClient as unknown as WalletClient,
    safeAddress: operator.safeAddress as Address,
    mechContractAddress: (v3Env ? v3Env.mockMechAddress : operator.mechAddress) as Address,
    routerAddress: (v3Env ? v3Env.routerAddress : routerAddress) as Address,
    claimDeliveryVariant: routerClaimDeliveryVariant as 'v1' | 'v2' | 'v3',
    // evictionRecovery: omitted — no master wallet in test
    // Finding E16 / the C2 ruling: the SAME host-owned broadcaster instance used by mechAdapter.
    broadcaster,
  };

  // 8. Construct Daemon. Translation of main.ts §2046.
  //    - store: injected so Daemon does NOT own it (our stop() closes it explicitly)
  //    - taskSources: omitted (no creator-side tasks in Task 5+)
  //    - peers / subgraphUrl / nodeEndpoint: omitted (test environment)
  //    - rewardClaim / balanceTopup: omitted (interval 0 → no loops)
  //    - status: omitted (GET /v1/status not exercised here)
  //    - corpusFactory: omitted (no subgraph configured)
  //    - apiServer: the pre-started server from step 2 — Daemon adopts it
  //      (ownsApiServer=false) so our stop() must close it explicitly.
  const daemon = new Daemon({
    adapter: mechAdapter,
    // runner omitted — DaemonConfig.runner is optional and only consumed by
    // LegacyClaudeImpl, which we didn't include in buildHarnesses.
    store,        // Daemon adopts (ownsStore=false); our stop() handles close
    dbPath: storePath, // used only when store is absent; kept for completeness
    pollIntervalMs: 300,  // shortened from production 5000ms for test cadence
    apiServer: preStartedApiServer, // inject pre-started server (ownsApiServer=false)
    // apiToken: not passed because we injected apiServer with its own token above
    peers: [],
    creatorSafeAddress: operator.safeAddress,
    // Step 6.5's composition (Task 18, opt-in via opts.enableComposition). Finding E36 (ruled
    // "build it"): `DaemonConfig.work` is now set alongside `composition` — `composition.archive`
    // is the real `ArchiveSubscription` over the projector's durable observation stream
    // (`archive-subscription.js`), and `composition.readSealedDocuments` mirrors main.ts's own
    // `workLoopConfig` exactly (same `estimateAiUnits`/`acceptLegacyCards` values). Without this,
    // `composition` only builds a broadcaster for `mechAdapter`/`deliveryDeps` and no loop ever
    // claims — that was true before this ruling landed a real archive feed and is no longer the
    // intended shape for a rig exercising the full claim-to-settle loop.
    ...(composition
      ? {
          composition,
          work: {
            archive: composition.archive,
            ledger: composition.engagementLedger,
            claimGate: composition.claimGate,
            estimateAiUnits: () => 0,
            readSealedDocuments: composition.readSealedDocuments,
            pollIntervalMs: 300,
            acceptLegacyCards: true,
            // Finding E39: without a logger, `WorkLoopConfig.logger` falls back to a silent
            // no-op and the per-tick outcome line (E39's fix) never reaches this rig's stdout —
            // mirrors the composition logger a few lines above and main.ts's own workLoopConfig.
            logger: { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) },
          },
        }
      : {}),
    // subgraphUrl / nodeEndpoint / signer: omitted
    // rewardClaim / balanceTopup: omitted → those loops don't start
    restorationEngine: {
      paths: {
        // Default consumer (daemon-harness-cycle.ts) calls startDaemon with no
        // opts → label === 'daemon'; keep its working dir at the fixture root
        // exactly as before. Multi-operator scenarios (T2.2) pass a distinct
        // instanceLabel and get a per-label subdir so two daemons don't collide.
        workingDirRoot:
          label === 'daemon'
            ? fixture.workingDirRoot
            : join(fixture.workingDirRoot, label),
        implStateDirRoot: join(fixture.implStateRoot, `${label}-impl-state`),
      },
      implRegistry,
      // Production (main.ts:2654) always wires operatorSafeAddress into the
      // engine so the synthetic-task claim guard (syntheticClaimBlocked,
      // engine.ts:1134) can compare `task.eligibility.syntheticProvenance`
      // against the running daemon's own Safe. This test rig previously never
      // set it, which silently no-oped that guard for every e2e daemon built
      // here. Setting it unconditionally is safe for existing consumers: the
      // guard is a no-op unless a task carries `syntheticProvenance` (only
      // task-creator-marketplace.ts does).
      operatorSafeAddress: operator.safeAddress,
      // Optional registry: undefined for the prediction consumer (no change);
      // the jinn-repo driver passes one so the engine resolves the
      // jinn-repo-runtime bundled plugin into solverPluginRoots and the solver
      // agent receives the checkout-mono SKILL.
      ...(solverNetRegistry ? { solverNetRegistry } : {}),
      packagingDeps,
      envelopeDeps,
      deliveryDeps,
      // #1827: mirrors main.ts's blockTimestamp wiring so this rig covers
      // envelope.task.createdAt resolution against the Anvil fork.
      blockTimestamp: {
        getBlockTimestamp: async (blockNumber: number): Promise<number | undefined> => {
          const block = await agentClients.publicClient.getBlock({ blockNumber: BigInt(blockNumber) });
          return Number(block.timestamp);
        },
        configuredRpcUrls: [rpcUrl],
      },
      // joinedSolverNets: omitted — engine falls back to legacy solverType gate.
      // Harness dispatch for non-baseline selectors is driven by
      // implRegistry.config.solverTypeHarnesses (wired in step 4 above).
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

  // 9. Start the daemon (kicks off all configured loops).
  await daemon.start();

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await daemon.stop();
    store.close();
    // Close the pre-started API server: the Daemon does NOT own it
    // (ownsApiServer=false when config.apiServer is injected), so we
    // are responsible for closing it here.
    await preStartedApiServer.close().catch(() => {});
    // composition.close() clears the venue broadcaster singleton (Finding E16) and closes the
    // evidence runtime + venue sqlite handle — must run so a sibling daemon (or the next e2e
    // process tick) doesn't inherit a broadcaster bound to this Safe.
    if (composition) {
      await composition.close().catch(() => {});
    }
  };

  return { daemon, store, stop };
}

/**
 * Start a producer/solver daemon whose `swe-rebench-v2.v1` solve leg is served
 * by the hermetic env-gated StubHarness (returns the canned known-good patch;
 * never calls an LLM). Sets JINN_HARNESS_STUB_INSTANCE + JINN_TEST_MODE +
 * JINN_HARNESS_STUB_FIXTURES_DIR before `startDaemon` (which builds harnesses
 * in-process via `buildHarnesses`, registering the stub by `solverType`
 * first-match) and restores the prior env once `startDaemon` returns so a
 * sibling evaluator daemon started afterwards does not pick the stub up. The
 * evaluation role is never handled by the stub (StubHarness.supports() returns
 * false for role === 'evaluation').
 */
export async function startSweRebenchSolverDaemon(
  fixture: DaemonHarnessFixture,
  operator: BootstrappedOperator,
  ipfsGatewayUrl: string,
  v3Env: TaskV3Env,
  ipfsRegistryUrl: string,
  opts: { instanceLabel?: string; fixturesDir: string; instanceMatcher: string },
): Promise<RunningDaemon> {
  const prev = {
    instance: process.env['JINN_HARNESS_STUB_INSTANCE'],
    testMode: process.env['JINN_TEST_MODE'],
    fixturesDir: process.env['JINN_HARNESS_STUB_FIXTURES_DIR'],
  };
  process.env['JINN_HARNESS_STUB_INSTANCE'] = opts.instanceMatcher;
  process.env['JINN_TEST_MODE'] = '1';
  process.env['JINN_HARNESS_STUB_FIXTURES_DIR'] = opts.fixturesDir;

  const restore = (): void => {
    if (prev.instance === undefined) delete process.env['JINN_HARNESS_STUB_INSTANCE'];
    else process.env['JINN_HARNESS_STUB_INSTANCE'] = prev.instance;
    if (prev.testMode === undefined) delete process.env['JINN_TEST_MODE'];
    else process.env['JINN_TEST_MODE'] = prev.testMode;
    if (prev.fixturesDir === undefined) delete process.env['JINN_HARNESS_STUB_FIXTURES_DIR'];
    else process.env['JINN_HARNESS_STUB_FIXTURES_DIR'] = prev.fixturesDir;
  };

  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon(
      fixture,
      operator,
      'prediction-v1-baseline',
      ipfsGatewayUrl,
      v3Env,
      ipfsRegistryUrl,
      { instanceLabel: opts.instanceLabel ?? 'op-a' },
      // HarnessRegistry.findFor() checks the configured `default` (claude-code,
      // DEFAULT_HARNESS) BEFORE falling through to first-match-by-supports() —
      // and LearnerHarness.supports() returns true for every solverType except
      // prediction.v1/prediction.apy.v0, so without this override the daemon
      // would dispatch swe-rebench-v2.v1 restoration to a real `claude` CLI
      // subprocess instead of the env-gated StubHarness, defeating the whole
      // point of this helper. `harness:stub` is StubHarness.name (stub.ts) —
      // its own supports() hardcodes solverType === 'swe-rebench-v2.v1', so
      // this mapping is unconditionally correct for every caller.
      { 'swe-rebench-v2.v1': 'harness:stub' },
    );
  } finally {
    // The stub harness is captured inside buildHarnesses synchronously during
    // startDaemon; once startDaemon returns it is safe to restore the env so a
    // sibling evaluator daemon started afterwards does not pick the stub up.
    restore();
  }
  return daemon;
}

// ── Task posting + claim detection ────────────────────────────────────────────

/**
 * Sign an unsigned task document, register it with the mock IPFS server, and
 * post it on the locally-deployed V3 JinnRouter. Shared by `postPredictionV1Task`
 * and `postSweRebenchV2Task` — everything except the task-document body is
 * identical between solver types, so the per-solverType helpers build only the
 * `unsignedTaskDoc` + `manifestCid` and delegate the rest here.
 */
async function postSignedTaskOnChain(
  fixture: DaemonHarnessFixture,
  creatorPrivKey: `0x${string}`,
  unsignedTaskDoc: Record<string, unknown>,
  manifestCid: string,
  mockIpfs: MockIpfsServer,
  v3Env: TaskV3Env,
  opts: { disallowSolverSelfEvaluation?: boolean } = {},
): Promise<PostedPredictionTask> {
  const rpcUrl = fixture.anvil.rpcUrl;
  const routerAddress = v3Env.routerAddress;
  const marketplaceAddress = v3Env.mockMarketplaceAddress;
  const creator = privateKeyToAccount(creatorPrivKey);

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

  // `taskCidDigest` MUST be a real sha256 digest of the exact posted bytes, not an arbitrary
  // lookup key: `composition-root.ts`'s `buildResolveSubmissionBytes` (the projector's TEP
  // admission path) re-derives `sha256(fetchedBytes)` and cross-checks it against this on-chain
  // value (`resolveTaskProjection`'s digest join) before admitting the event — a mismatch is a
  // correct fail-closed drop, not a bug in that path. This was previously
  // `keccak256(JSON.stringify(signedTaskDoc))` (an opaque mock-gateway lookup key, harmless while
  // nothing ever verified it, but wrong now that something does). Real production posting
  // (`adapter.ts`'s `uploadToIpfs` + `cidToDigestHex`) computes a genuine sha256-based CID digest
  // over the uploaded bytes; this mirrors that, over the same JSON bytes the mock gateway serves
  // back byte-identical (see `startMockIpfsServer`'s doc comment). The daemon still derives the
  // IPFS CID as `f01551220${digest.slice(2)}` from the on-chain event and fetches from the mock
  // gateway at that path — unchanged.
  const taskJson = JSON.stringify(signedTaskDoc);
  const taskCidDigest = `0x${createHash('sha256').update(taskJson).digest('hex')}` as `0x${string}`;
  mockIpfs.register(taskCidDigest, signedTaskDoc);

  const manifestDigest = keccak256(toBytes(manifestCid)) as `0x${string}`;

  // Use the mock mech's maxDeliveryRate so the V3 router's budget check passes.
  const deliveryRate = await getMechDeliveryRate(
    fixture.publicClient,
    v3Env.mockMechAddress as Address,
  );
  const timeoutBounds = await getTimeoutBounds(fixture.publicClient, marketplaceAddress);
  const responseTimeout = timeoutBounds.min > 0n ? timeoutBounds.min : 3600n;

  // Tokenless-OLAS pivot: the on-chain TaskCoordinator.TaskPolicy is `maxClaims`
  // plus `allowSolverSelfEvaluation` (windows / lease / quorum / EvaluationPolicy
  // removed). The off-chain scheduling intent still rides on the signed task.v1
  // `claimPolicy` field; only these two cross the wire into createTask.
  //
  // Default `allowSolverSelfEvaluation: true` — this is the single-operator
  // dogfood path (daemon-harness-cycle.ts): one daemon posts, solves, delivers,
  // then SELF-evaluates its own attempt to drive the verdict that credits the
  // solver's activity counter. Without self-eval allowed the coordinator reverts
  // `claimEvaluation` (evaluator == solver) and the verdict leg never closes, so
  // the activity counter stays at 0. Multi-operator scenarios (T2.2) pass
  // `disallowSolverSelfEvaluation: true` to restore the independent-evaluation
  // invariant so the dedicated evaluator (op-b), not the solver (op-a), settles
  // the verdict.
  const onchainPolicy = {
    maxClaims: 10,
    allowSolverSelfEvaluation: !opts.disallowSolverSelfEvaluation,
  };

  // The trimmed JinnRouterV3.createTask requires msg.value == solutionBudget +
  // verdictBudget where each side = rate * maxClaims (the per-verdict
  // requiredVerdicts multiplier is gone). With maxClaims=10: value = rate * 20.
  const MAX_CLAIMS = 10n;
  const rateArg = deliveryRate > 0n ? deliveryRate : parseEther('0.0001');
  const solutionBudget = rateArg * MAX_CLAIMS;
  const verdictBudget = rateArg * MAX_CLAIMS;
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

  return {
    taskId,
    taskCidDigest,
    manifestDigest,
    creationTxHash: created.hash,
    createdAtBlock,
  };
}

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
  /**
   * Optional on-chain policy overrides.
   *
   * - `disallowSolverSelfEvaluation` — when true, the on-chain `TaskPolicy` is
   *   built with `allowSolverSelfEvaluation: false`, so the TaskCoordinator
   *   reverts `claimEvaluation` (`TCSolverSelfEvaluation`) if the evaluator
   *   equals the solution attempt's operator. Multi-operator scenarios (T2.2)
   *   set this so the solver (op-a) cannot win the evaluation-claim race against
   *   the dedicated evaluator (op-b): with `requiredVerdicts: 1`, whichever
   *   operator claims first settles the single verdict, and if op-a wins, op-b
   *   can never settle — making `waitForVerdict(evaluator=op-b)` time out
   *   non-deterministically. Defaults to `false` so the single-operator consumer
   *   (`daemon-harness-cycle.ts`) posts with `allowSolverSelfEvaluation: true`
   *   and can solve + self-evaluate + close the loop solo (the verdict leg is
   *   what credits the solver's activity counter).
   */
  opts: {
    disallowSolverSelfEvaluation?: boolean;
    provenance?: { instanceId: string; repo: string; baseCommit: string };
  } = {},
): Promise<PostedPredictionTask> {
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
      ...(opts.provenance
        ? {
            instance_id: opts.provenance.instanceId,
            repo: opts.provenance.repo,
            base_commit: opts.provenance.baseCommit,
          }
        : {}),
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

  return postSignedTaskOnChain(
    fixture,
    creatorPrivKey,
    unsignedTaskDoc,
    MANIFEST_CID,
    mockIpfs,
    v3Env,
    opts,
  );
}

/**
 * Build, sign, and register a `swe-rebench-v2.v1` task with the mock IPFS server,
 * then post it on the locally-deployed V3 JinnRouter. The returned shape matches
 * `postPredictionV1Task` so `waitForDaemonClaim` / `waitForDelivery` /
 * `waitForVerdict` consume it unchanged.
 *
 * The task's `spec` carries the SweRebenchV2TaskSchema fields for the
 * known-solvable instance `sympy__sympy-27510` (fixtures/known-instance.ts) —
 * the same field set T3.1 writes (T3.1-producer-evaluator-real.ts:648-663). The
 * producer daemon's StubHarness injects the canned patch for the solve leg.
 */
export async function postSweRebenchV2Task(
  fixture: DaemonHarnessFixture,
  operator: BootstrappedOperator,
  creatorPrivKey: `0x${string}`,
  mockIpfs: MockIpfsServer,
  v3Env: TaskV3Env,
  opts: { disallowSolverSelfEvaluation?: boolean } = {},
): Promise<PostedPredictionTask> {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  // SWE-rebench v2 task document. spec fields mirror the schema T3.1 writes
  // (T3.1-producer-evaluator-real.ts:648-663). manifestDigest uses the
  // SWE-rebench v2 mainline manifest CID so the on-chain manifest cross-check
  // is consistent.
  const MANIFEST_CID = KNOWN_MANIFEST_CID;
  const unsignedTaskDoc = {
    schemaVersion: 'task.v1' as const,
    id: 'daemon-harness-e2e-swe-rebench-v2-1',
    solverType: 'swe-rebench-v2.v1',
    solverNetManifestCid: MANIFEST_CID,
    contractId: 'swe-rebench-v2',
    contractVersion: 'v1',
    role: 'restoration' as const,
    description: `SWE-rebench v2 instance ${KNOWN_INSTANCE_ID}`,
    window: {
      startTs: now - 5_000,
      endTs: now + 600_000,
    },
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      solverType: 'swe-rebench-v2.v1',
      instance_id: KNOWN_INSTANCE_ID,
      repo: KNOWN_REPO,
      base_commit: KNOWN_COMMIT,
      language: 'python',
      problem_statement: `SWE-rebench v2 instance: ${KNOWN_INSTANCE_ID}`,
      interface: '',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2025_01',
      deadline_unix: nowSec + 60 * 60,
      round_month: '2025-01',
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

  return postSignedTaskOnChain(
    fixture,
    creatorPrivKey,
    unsignedTaskDoc,
    MANIFEST_CID,
    mockIpfs,
    v3Env,
    opts,
  );
}

// ── Deliver event ABI for MockTaskMechWithDelivery ───────────────────────────

/**
 * Minimal ABI covering the Deliver event emitted by MockTaskMechWithDelivery.
 *
 * event Deliver(
 *   address indexed mech,
 *   address indexed mechServiceMultisig,
 *   bytes32 requestId,       ← non-indexed
 *   uint256 deliveryRate,    ← non-indexed
 *   bytes data               ← non-indexed (contains the delivery digest)
 * )
 */
const MOCK_MECH_DELIVER_ABI = [
  {
    name: 'Deliver',
    type: 'event',
    anonymous: false,
    inputs: [
      { name: 'mech', type: 'address', indexed: true },
      { name: 'mechServiceMultisig', type: 'address', indexed: true },
      { name: 'requestId', type: 'bytes32', indexed: false },
      { name: 'deliveryRate', type: 'uint256', indexed: false },
      { name: 'data', type: 'bytes', indexed: false },
    ],
  },
] as const;

/**
 * Poll the MockTaskMechWithDelivery for a `Deliver` event matching
 * `claim.requestId`. When found, fetches the signed envelope from the
 * mock IPFS server (the daemon uploads on settle) and parses it via
 * `SignedEnvelopeSchema`.
 *
 * The delivery tx hash comes from the on-chain Deliver event. The
 * envelope CID is derived from the event's `data` field: the daemon
 * uploads via `POST /api/v0/add` and the returned CID is
 * `f01551220{sha256hex}`; `deliverToMarketplace` passes
 * `cidToDigestHex(manifestCid)` = `0x{sha256hex}` as the delivery digest,
 * so the CID path is `f01551220${deliveryDigest.slice(2)}`.
 *
 * Resolves when delivery is on-chain and the envelope is parsed.
 * Rejects after `timeoutMs` (default 180s).
 */
export async function waitForDelivery(
  fixture: DaemonHarnessFixture,
  claim: DaemonClaim,
  v3Env: TaskV3Env,
  mockIpfs: MockIpfsServer,
  timeoutMs = 180_000,
): Promise<DeliveredTask> {
  const mechAddress = v3Env.mockMechAddress;
  const deadline = Date.now() + timeoutMs;

  // Floor the scan at the CLAIM's block, not the current tip. The daemon can
  // deliver in the same instant it claims (Anvil instant-mine + a fast loop),
  // so by the time this function is called the Deliver event may already sit a
  // few blocks BELOW the current tip. Anchoring to the current tip would put
  // that floor above the Deliver block and miss it permanently — the daemon
  // delivered, yet waitForDelivery spins until timeout (the CI symptom). Deliver
  // can only occur at or after the claim, so the claim block is a sound, race-
  // free lower bound; the claim→now span is tiny on a locally-mined snapshot
  // chain, well within the getLogs range limit.
  let claimBlock: bigint;
  if (claim.txHash && claim.txHash !== '0x') {
    claimBlock = (await fixture.publicClient.getTransactionReceipt({ hash: claim.txHash })).blockNumber;
  } else {
    // No claim tx hash (shouldn't happen on a mined chain) — fall back to the
    // current tip rather than throwing.
    claimBlock = await fixture.publicClient.getBlockNumber();
  }
  let scannedUpTo = claimBlock > 0n ? claimBlock - 1n : 0n;

  while (Date.now() < deadline) {
    const currentBlock = await fixture.publicClient.getBlockNumber();
    const fromBlock = scannedUpTo + 1n;

    if (fromBlock <= currentBlock) {
      const logs = await fixture.publicClient.getLogs({
        address: mechAddress,
        fromBlock,
        toBlock: currentBlock,
      });

      let foundDeliverButNoEnvelope = false;

      for (const log of logs as Log[]) {
        try {
          const decoded = decodeEventLog({
            abi: MOCK_MECH_DELIVER_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName !== 'Deliver') continue;
          const args = decoded.args as {
            requestId: `0x${string}`;
            deliveryRate: bigint;
            data: `0x${string}`;
          };
          // Filter: the non-indexed requestId must match our claim.
          if (args.requestId.toLowerCase() !== claim.requestId.toLowerCase()) continue;

          // Found the Deliver event for our requestId.
          const deliveryTxHash = (log.transactionHash ?? '0x') as `0x${string}`;

          // Derive the envelope CID from the delivery data field.
          // The daemon calls cidToDigestHex(manifestCid) = 0x{sha256hex} as the
          // delivery data. But `deliverToMarketplace` passes it as a `bytes` arg,
          // so `args.data` is the ABI-encoded bytes value which is exactly the
          // 32-byte sha256 digest when the daemon passes bytes32 cast to bytes.
          // The CID in mock IPFS is `f01551220{sha256hex}` where sha256hex =
          // args.data.slice(2) (the raw 32-byte hex, no leading 0x).
          const deliveryDataHex = (args.data ?? '').startsWith('0x')
            ? (args.data as string).slice(2)
            : (args.data as string);

          // args.data is the decoded hex of the 32-byte delivery digest
          // (viem's decodeEventLog already ABI-decoded the bytes parameter).
          // Slice the last 64 hex chars to defensively recover the digest even
          // if a future contract change wraps it in additional padding.
          const digestHex = deliveryDataHex.length >= 64
            ? deliveryDataHex.slice(-64)
            : deliveryDataHex;

          const candidateCids = [
            `f01551220${digestHex}`,
            `f01701220${digestHex}`,
          ];

          let envelopeJson: unknown | undefined;
          for (const cid of candidateCids) {
            const found = mockIpfs.getUploaded(cid);
            if (found !== undefined) {
              envelopeJson = found;
              break;
            }
          }

          if (envelopeJson === undefined) {
            // Envelope not yet in mock IPFS store — daemon may still be uploading.
            // Mark so we don't advance scannedUpTo past this block (we need to re-check).
            foundDeliverButNoEnvelope = true;
            break;
          }

          // Parse and validate as SignedEnvelope. E43: IPFS may hold a sealed TEP Delivery
          // with the legacy envelope nested under the bridge extension — unwrap first.
          const envelope = SignedEnvelopeSchema.parse(
            signedEnvelopeJsonFromDeliveryOrRaw(envelopeJson),
          );
          const solverHarnessName = envelope.executor.implName;

          return {
            requestId: claim.requestId,
            deliveryTxHash,
            envelope,
            solverHarnessName,
          };
        } catch (err) {
          // If the event matched our ABI (i.e. we got past decodeEventLog and
          // the requestId comparison) but envelope parsing failed, that's a
          // hard error — re-throw rather than silently advancing the scan
          // floor past the only block where the event will ever exist.
          // ZodError detection: check name, not message (message holds the
          // JSON-formatted issues array, never literally "ZodError").
          if (err instanceof Error && err.name === 'ZodError') {
            throw new Error(
              `waitForDelivery: envelope failed SignedEnvelopeSchema for requestId=${claim.requestId}: ${err.message.slice(0, 400)}`,
            );
          }
          // Otherwise: not our event (different ABI) — keep scanning.
        }
      }

      // Only advance the scan floor when we fully processed all logs in range.
      // If we found the event but IPFS isn't ready yet, keep the same floor so
      // the next iteration re-scans the same range (harmless: Deliver is idempotent).
      if (!foundDeliverButNoEnvelope) {
        scannedUpTo = currentBlock;
      }
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `waitForDelivery: timed out after ${timeoutMs}ms waiting for Deliver event ` +
    `(requestId=${claim.requestId}, mechAddress=${mechAddress})`,
  );
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

/**
 * Read the operator's on-chain activity counter from the locally-deployed
 * TaskActivityCheckerV3. The counter (`eligibleActivityWeight`) increments
 * when the V3 router calls `recordSolutionDelivery(safeAddress, solutionDigest)`
 * — and per the tokenless-OLAS loop-completion gate that call fires on
 * `claimVerdictDelivery` (the first verdict finalizes the attempt), NOT at
 * `claimSolutionDelivery`. So crediting the solver's activity requires the
 * verdict leg to close: in the single-operator dogfood the operator must
 * self-evaluate its own attempt, which the on-chain policy permits only when
 * `allowSolverSelfEvaluation: true` (set by `postSignedTaskOnChain`'s default).
 * We compare before/after values to assert the loop actually closed.
 *
 * Note: this reads from our locally-deployed TaskActivityCheckerV3 (in the V3
 * stack deployed by `deployMinimalV3Stack`), NOT from the production OLAS
 * staking contract. The production staking contract tracks the production
 * JinnRouter and is unaware of our locally-deployed V3 stack — but the local
 * activity checker IS wired to the local V3 router via `setAuthorizedRouter`,
 * so deliveries through our test stack increment the local counter correctly.
 *
 * Returns the raw `eligibleActivityWeight` as a bigint.
 */
export async function readActivityCount(
  fixture: DaemonHarnessFixture,
  operator: BootstrappedOperator,
  v3Env: TaskV3Env,
): Promise<bigint> {
  const activityArtifact = await loadContractArtifact(
    'artifacts/src/staking/TaskActivityCheckerV3.sol/TaskActivityCheckerV3.json',
  );
  const result = await fixture.publicClient.readContract({
    address: v3Env.activityCheckerAddress as Address,
    abi: activityArtifact.abi,
    functionName: 'eligibleActivityWeight',
    args: [operator.safeAddress as Address],
  });
  return result as bigint;
}

// ── Multi-operator evaluator/verdict leg (T2.2) ───────────────────────────────
//
// The single-operator daemon-harness cycle stops at solution delivery. T2.2
// (`client/test/release/tier-2/T2.2-producer-evaluator.ts`) drives the full
// producer → solve → deliver → evaluate → verdict loop the real way: a second
// operator's daemon claims the evaluation request, runs the real
// PredictionV1Evaluator, and settles a verdict on-chain. The helpers below are
// the genuinely-new pieces that leg needs — they compose with the existing
// `deployMinimalV3Stack` / `postPredictionV1Task` / `waitForDaemonClaim` /
// `waitForDelivery` machinery rather than duplicating it.

/**
 * Deploy a second `MockTaskMechWithDelivery` whose `operator` is the *evaluator*
 * operator's Safe, so the V3 router's `claimEvaluation` →
 * `_validateMechOperator(evaluatorMech, msg.sender)` check passes when the
 * evaluator daemon claims an evaluation request via its Safe.
 *
 * The V3 router validates that `msg.sender` (the evaluator's Safe) is an
 * operator of `evaluatorMech`. The solver's mech (deployed by
 * `deployMinimalV3Stack` with `operator = solver.safeAddress`) would fail that
 * check for the evaluator. Each operator therefore needs its own mech against
 * the shared V3 router + marketplace + activity checker.
 *
 * Returns a `TaskV3Env` view scoped to the evaluator operator: identical
 * router/marketplace/activityChecker, but `mockMechAddress` is the evaluator's
 * mech. Pass it as the evaluator daemon's `v3Env` so the daemon claims
 * evaluation requests through the mech it operates.
 */
export async function deployOperatorMech(
  fixture: DaemonHarnessFixture,
  evaluator: BootstrappedOperator,
  baseV3Env: TaskV3Env,
  deployerPrivKey: `0x${string}`,
): Promise<TaskV3Env> {
  const rpcUrl = fixture.anvil.rpcUrl;
  const deployer = privateKeyToAccount(deployerPrivKey);
  const NATIVE_PAYMENT_TYPE =
    '0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1' as Hex;
  const MOCK_MECH_RATE = parseEther('0.0001');

  const mechArtifact = await loadContractArtifact(
    'artifacts/src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMechWithDelivery.json',
  );
  const evaluatorMech = await deployContractFromArtifact(
    fixture.publicClient,
    rpcUrl,
    deployer,
    mechArtifact,
    [
      MOCK_MECH_RATE,
      NATIVE_PAYMENT_TYPE,
      evaluator.safeAddress,
      baseV3Env.mockMarketplaceAddress,
    ],
  );

  return {
    routerAddress: baseV3Env.routerAddress,
    mockMechAddress: evaluatorMech,
    mockMarketplaceAddress: baseV3Env.mockMarketplaceAddress,
    activityCheckerAddress: baseV3Env.activityCheckerAddress,
  };
}

// ── Mock Polymarket Gamma server ──────────────────────────────────────────────

/**
 * A minimal in-process HTTP server that mimics the one Polymarket Gamma API
 * endpoint the prediction.v1 evaluator depends on: `GET /markets/{marketId}`.
 *
 * `PredictionV1Evaluator.run` calls `getResolution({ marketId, ... })` which
 * issues a single `GET ${gammaBaseUrl}/markets/{marketId}` request. The live
 * Gamma API would make the verdict leg network-dependent and non-deterministic
 * (a market's resolution state can change). Pointing the daemon's evaluator at
 * this mock — via `startDaemon`'s `opts.polymarketGammaBaseUrl` — makes the
 * verdict deterministic, offline, and free.
 *
 * The served market record is `closed: true` with `outcomePrices: ['1','0']`,
 * which `getResolution` normalises to `status: 'resolved', outcome: 'YES'` →
 * the evaluator derives `verdict: 'SCORED'` → on-chain `verdictCode = 1` (Pass).
 */
export interface MockPolymarketGammaServer {
  /** Base URL of the server (e.g. `http://127.0.0.1:PORT`). */
  baseUrl: string;
  /** Tear down the HTTP server. */
  close(): Promise<void>;
}

/**
 * Spawn the mock Gamma server. The `marketId` / `conditionId` / `slug` must
 * match the prediction.v1 task fixture's `spec.source.identifiers` so the
 * evaluator's `market.identity` check passes.
 */
export async function startMockPolymarketGammaServer(args: {
  marketId: string;
  conditionId: string;
  slug: string;
  /** Resolved binary outcome. Default `'YES'`. */
  outcome?: 'YES' | 'NO';
}): Promise<MockPolymarketGammaServer> {
  const outcome = args.outcome ?? 'YES';
  // outcomePrices: index 0 = YES, index 1 = NO. A price >= 0.999 marks the
  // winner (see outcomeFromRecord in client/src/venues/polymarket/client.ts).
  const outcomePrices = outcome === 'YES' ? ['1', '0'] : ['0', '1'];
  const marketRecord = {
    id: args.marketId,
    conditionId: args.conditionId,
    slug: args.slug,
    question: 'Will the daemon-harness e2e task claim succeed?',
    description: 'Deterministic T2.2 fixture market.',
    active: false,
    closed: true,
    archived: false,
    outcomes: JSON.stringify(['Yes', 'No']),
    outcomePrices: JSON.stringify(outcomePrices),
    clobTokenIds: JSON.stringify(['yes-token', 'no-token']),
    resolutionStatus: 'resolved',
    endDate: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    liquidity: '50000',
    volume24hr: '20000',
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? '';
        // GET /markets/{marketId} — single-market resolution lookup.
        if (req.method === 'GET' && /^\/markets\/[^/?]+/.test(url)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(marketRecord));
          return;
        }
        // GET /markets?... — list query; return the single fixture market so a
        // conditionId-keyed lookup also resolves.
        if (req.method === 'GET' && url.startsWith('/markets')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([marketRecord]));
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
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close() {
      return closeServer(server);
    },
  };
}

// ── Verdict event ─────────────────────────────────────────────────────────────

export interface SettledVerdict {
  /** Verdict request id from the EvaluationAttemptCreated event. */
  verdictRequestId: `0x${string}`;
  /** Tx hash of the VerdictDeliveryClaimed event on the V3 router. */
  verdictTxHash: `0x${string}`;
  /** taskId the verdict settled against. */
  taskId: bigint;
  /** On-chain verdict code: 1=Pass, 2=Fail, 3=Invalid, 4=Unresolved. */
  verdictCode: number;
  /** Evaluator Safe address that settled the verdict. */
  evaluator: `0x${string}`;
}

/**
 * Poll the locally-deployed V3 JinnRouter for a `VerdictDeliveryClaimed` event
 * matching `taskId` and the evaluator operator's Safe address.
 *
 * This is the evaluator/verdict leg that no prior e2e exercised end-to-end
 * through a real daemon. `waitForDelivery` stops at the *solution* `Deliver`
 * event; `waitForVerdict` continues to the *verdict* settlement: the evaluator
 * daemon claims the evaluation request (`claimEvaluation`), runs the
 * `PredictionV1Evaluator`, and settles the verdict (`claimVerdictDelivery`),
 * which the V3 router surfaces as `VerdictDeliveryClaimed`.
 *
 * Resolves when the verdict is on-chain; rejects after `timeoutMs`.
 */
export async function waitForVerdict(
  fixture: DaemonHarnessFixture,
  task: PostedPredictionTask,
  evaluator: BootstrappedOperator,
  v3Env: TaskV3Env,
  timeoutMs = 240_000,
): Promise<SettledVerdict> {
  const routerAddress = v3Env.routerAddress;
  const deadline = Date.now() + timeoutMs;
  // Topic-filter the getLogs scan to just the VerdictDeliveryClaimed event so
  // the node returns only matching logs (~1 per task) instead of every router
  // log — keeps RPC payloads small over a worst-case 300s poll window.
  const verdictEvent = getAbiItem({
    abi: JINN_ROUTER_ABI,
    name: 'VerdictDeliveryClaimed',
  });
  // First scan must cover the block containing TaskCreated — the whole loop
  // (claim → solve → deliver → claimEvaluation → verdict) can race forward on
  // Anvil's instant-mine, so start the floor at the task's creation block.
  let scannedUpTo: bigint =
    task.createdAtBlock > 0n ? task.createdAtBlock - 1n : 0n;

  while (Date.now() < deadline) {
    const currentBlock = await fixture.publicClient.getBlockNumber();
    const fromBlock = scannedUpTo + 1n;
    scannedUpTo = currentBlock;

    if (fromBlock <= currentBlock) {
      const logs = await fixture.publicClient.getLogs({
        address: routerAddress,
        event: verdictEvent,
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
          if (decoded.eventName !== 'VerdictDeliveryClaimed') continue;
          const args = decoded.args as {
            evaluator: `0x${string}`;
            requestId: `0x${string}`;
            taskId: bigint;
            attemptIndex: number;
            verdictIndex: number;
            verdictCode: number;
          };
          // Filter by taskId and evaluator (the evaluator's Safe address).
          if (args.taskId !== task.taskId) continue;
          if (getAddress(args.evaluator) !== getAddress(evaluator.safeAddress)) {
            continue;
          }
          return {
            verdictRequestId: args.requestId,
            verdictTxHash: (log.transactionHash ?? '0x') as `0x${string}`,
            taskId: args.taskId,
            verdictCode: Number(args.verdictCode),
            evaluator: args.evaluator,
          };
        } catch {
          // Not a VerdictDeliveryClaimed event for our ABI — skip.
        }
      }
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `waitForVerdict: timed out after ${timeoutMs}ms waiting for VerdictDeliveryClaimed ` +
      `(taskId=${task.taskId}, evaluator=${evaluator.safeAddress})`,
  );
}
