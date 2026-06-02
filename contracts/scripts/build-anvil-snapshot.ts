/**
 * Build the committed Anvil `--dump-state` snapshot the hermetic gate loads.
 *
 * Spec: docs/superpowers/specs/2026-05-31-release-pipeline-two-gate-redesign.md
 * §4 (snapshot, not fork) + §5 (fidelity — real bytecode driven into state).
 *
 * This is an OFFLINE build step, NOT run in CI. It needs a real Base RPC
 * (`BASE_RPC_URL`) because the only network access in the whole pipeline lives
 * here: forking Base once to capture the real OLAS Mech Marketplace, service
 * registries, Safe factory, and OLAS token bytecode + state. Everything
 * downstream (the per-PR hermetic gate) loads the resulting JSON off local
 * disk via `anvil --load-state` and never touches the network again.
 *
 * What it does:
 *   1. Spawn `anvil --fork-url <Base>` pinned at a deterministic block.
 *   2. Deploy the V3 stack reusing the SAME init order as
 *      `client/test/e2e/_daemon-harness-helpers.ts deployMinimalV3Stack(...)`
 *      and `contracts/scripts/deploy-task-coordinator-router-v3.ts`:
 *        ActivityChecker.initialize
 *        -> Coordinator.initialize
 *        -> Router.initialize
 *        -> ActivityChecker.setAuthorizedRouter
 *      then deploy MockTaskMechWithDelivery(rate, paymentType, operator, market).
 *   3. Seed: fund the deployer EOA + operator EOA with ETH and seed the
 *      operator EOA with OLAS (via the ERC-20 balance-mapping slot — same
 *      trick `client/test/_support/chain/olas-funding.ts` uses, no whale
 *      impersonation dance).
 *   4. `anvil --dump-state` → `client/test/_support/fixtures/anvil-base-v3-state/state.json`.
 *
 * Refresh it deliberately whenever our V3 contracts change (see
 * docs/snapshots/base-v3-snapshot.md). Staleness relative to the live chain is
 * a deterministic-gate FEATURE; live-chain drift is covered by the env suite
 * (spec §14).
 *
 * Configurable via env (all optional — sensible defaults):
 *   BASE_RPC_URL                     fork source (required to actually run)
 *   JINN_SNAPSHOT_FORK_BLOCK         pinned Base block (default below)
 *   JINN_SNAPSHOT_OUT_DIR            output dir (default: the committed fixture path)
 *   JINN_SNAPSHOT_ANVIL_PORT         anvil port (default: 8545)
 *   JINN_SNAPSHOT_READY_TIMEOUT_MS   readiness poll timeout (default: 60_000)
 *
 * Addresses (OLAS, mech marketplace) come from CHAIN_CONFIG
 * (`client/src/earning/contracts.ts` getChainConfig('base')) — never inlined
 * here — so a chain-config change flows through automatically.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  numberToHex,
  pad,
  parseEther,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { getChainConfig } from '../../client/src/earning/contracts';

// ── Configuration (env-overridable; CHAIN_CONFIG-derived addresses) ────────────

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.resolve(SCRIPT_DIR, '..');
const CLIENT_DIR = path.resolve(CONTRACTS_DIR, '..', 'client');

/** Committed fixture directory the hermetic gate loads via `anvil --load-state`. */
const DEFAULT_OUT_DIR = path.join(
  CLIENT_DIR,
  'test',
  '_support',
  'fixtures',
  'anvil-base-v3-state',
);

/**
 * Pinned Base block. A deterministic pin makes the deploy reproducible and the
 * fixture identical run-to-run. Bump deliberately when refreshing; OLAS
 * on-chain contracts are effectively fixed so the exact pin is not load-bearing
 * for the gate (spec §4).
 */
const DEFAULT_FORK_BLOCK = 33_400_000;

const CHAIN_CONFIG = getChainConfig('base');

/**
 * Deployer + operator EOAs — deterministic keys that match the e2e helpers
 * (`ANVIL_PRIVATE_KEYS` in `client/test/e2e/task-first-helpers.ts`): key[0] is
 * the deployer/creator, key[1] is the operator EOA (as in `setupAnvilFixture`).
 * Keeping the same key indices lets the hermetic gate's bootstrap-from-snapshot
 * derive the same accounts the fixture was seeded with.
 */
const DEPLOYER_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex;
const OPERATOR_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000002' as Hex;

/** Native-payment type — same constant `deployMinimalV3Stack` uses for the mock mech. */
const NATIVE_PAYMENT_TYPE =
  '0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1' as Hex;

const MOCK_MECH_RATE = parseEther('0.0001');

// ── Helpers ────────────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonRpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`RPC error (${method}): ${body.error.message}`);
  return body.result;
}

/** keccak256(abi.encode(holder, mappingSlot)) — standard Solidity mapping layout. */
function balanceMappingSlot(holder: Address, mappingSlot: bigint): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, mappingSlot]),
  );
}

/** Run a child process to completion, inheriting stdio. Rejects on non-zero exit. */
function runChild(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.once('error', (err) => reject(err));
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`)),
    );
  });
}

async function loadArtifact(pathFromContracts: string): Promise<{ abi: Abi; bytecode: Hex }> {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(
    await readFile(path.join(CONTRACTS_DIR, pathFromContracts), 'utf8'),
  ) as { abi: Abi; bytecode: Hex };
  return { abi: raw.abi, bytecode: raw.bytecode };
}

async function deployContract(
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
  return getAddress(receipt.contractAddress);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const forkUrl = process.env['BASE_RPC_URL']?.trim();
  if (!forkUrl) {
    throw new Error(
      'BASE_RPC_URL is required — this is an OFFLINE build step that forks Base once ' +
        'to capture real OLAS bytecode. Set BASE_RPC_URL to a Base mainnet RPC and re-run.',
    );
  }

  const forkBlock = envInt('JINN_SNAPSHOT_FORK_BLOCK', DEFAULT_FORK_BLOCK);
  const port = envInt('JINN_SNAPSHOT_ANVIL_PORT', 8545);
  const readyTimeoutMs = envInt('JINN_SNAPSHOT_READY_TIMEOUT_MS', 60_000);
  const outDir = process.env['JINN_SNAPSHOT_OUT_DIR']?.trim() || DEFAULT_OUT_DIR;
  const statePath = path.join(outDir, 'state.json');
  const rpcUrl = `http://127.0.0.1:${port}`;

  mkdirSync(outDir, { recursive: true });

  console.log('=== build-anvil-snapshot ===');
  console.log(`fork url:    ${forkUrl}`);
  console.log(`fork block:  ${forkBlock}`);
  console.log(`anvil port:  ${port}`);
  console.log(`out file:    ${statePath}`);
  console.log(`OLAS token:  ${CHAIN_CONFIG.olasToken}`);
  console.log(`mech market: ${CHAIN_CONFIG.mechMarketplace}`);
  console.log();

  // 1. Compile the V3 contracts so the artifacts exist before we deploy.
  console.log('Step 0: compiling contracts...');
  await runChild('yarn', ['compile'], CONTRACTS_DIR);

  // 2. Spawn anvil --fork-url at the pinned block, with --dump-state so the
  //    state is flushed to disk on SIGINT/SIGTERM shutdown.
  const args = [
    '--fork-url',
    forkUrl,
    '--fork-block-number',
    String(forkBlock),
    '--port',
    String(port),
    '--dump-state',
    statePath,
  ];
  console.log(`Step 1: spawning anvil (${args.join(' ')})...`);
  const anvil: ChildProcess = spawn('anvil', args, { stdio: 'inherit', detached: false });

  const exitPromise = new Promise<never>((_, reject) => {
    anvil.once('error', (err) => reject(new Error(`anvil failed to spawn: ${err.message}`)));
    anvil.once('exit', (code, signal) =>
      reject(new Error(`anvil exited before becoming ready (code=${code}, signal=${signal})`)),
    );
  });
  const readyPromise = (async () => {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      try {
        await jsonRpc(rpcUrl, 'eth_chainId', []);
        return;
      } catch {
        await sleep(200);
      }
    }
    throw new Error(`anvil did not become ready within ${readyTimeoutMs}ms on port ${port}`);
  })();
  try {
    await Promise.race([readyPromise, exitPromise]);
  } catch (err) {
    if (!anvil.killed) anvil.kill('SIGKILL');
    throw err;
  }

  try {
    const deployer = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
    const operator = privateKeyToAccount(OPERATOR_PRIVATE_KEY);
    const publicClient = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    }) as unknown as PublicClient;

    // 3. Seed: fund deployer + operator EOAs with ETH so they can pay gas, and
    //    seed the operator EOA with OLAS via the ERC-20 balance mapping slot
    //    (slot 0 on the Base OLAS token — same approach as olas-funding.ts).
    console.log('Step 2: seeding ETH + OLAS...');
    await jsonRpc(rpcUrl, 'anvil_setBalance', [deployer.address, numberToHex(parseEther('1000'))]);
    await jsonRpc(rpcUrl, 'anvil_setBalance', [operator.address, numberToHex(parseEther('1000'))]);
    const olasAmount = 5000n * 10n ** 18n; // 5000 OLAS — covers the staking bond
    await jsonRpc(rpcUrl, 'anvil_setStorageAt', [
      getAddress(CHAIN_CONFIG.olasToken),
      balanceMappingSlot(operator.address, 0n),
      pad(toHex(olasAmount), { size: 32 }),
    ]);
    await jsonRpc(rpcUrl, 'evm_mine', []);
    console.log(`  deployer:  ${deployer.address} (1000 ETH)`);
    console.log(`  operator:  ${operator.address} (1000 ETH + 5000 OLAS)`);

    // 4. Deploy the V3 stack — mirrors deployMinimalV3Stack init order exactly.
    console.log('Step 3: loading V3 artifacts...');
    const [coordinatorArtifact, routerV3Artifact, marketplaceArtifact, activityArtifact, mechArtifact] =
      await Promise.all([
        loadArtifact('artifacts/src/tasks/TaskCoordinator.sol/TaskCoordinator.json'),
        loadArtifact('artifacts/src/staking/JinnRouterV3.sol/JinnRouterV3.json'),
        loadArtifact('artifacts/src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMarketplace.json'),
        loadArtifact('artifacts/src/staking/TaskActivityCheckerV3.sol/TaskActivityCheckerV3.json'),
        loadArtifact('artifacts/src/stubs/TaskCoordinatorTestMocks.sol/MockTaskMechWithDelivery.json'),
      ]);

    console.log('Step 4: deploying coordinator/marketplace/activity-checker/router...');
    const coordinator = await deployContract(publicClient, rpcUrl, deployer, coordinatorArtifact);
    const marketplace = await deployContract(publicClient, rpcUrl, deployer, marketplaceArtifact);
    const activityChecker = await deployContract(publicClient, rpcUrl, deployer, activityArtifact);
    const router = await deployContract(publicClient, rpcUrl, deployer, routerV3Artifact);

    console.log('Step 5: initializing in dependency order...');
    const deployerClient = createWalletClient({ account: deployer, chain: base, transport: http(rpcUrl) });

    const initActivity = await deployerClient.writeContract({
      address: activityChecker,
      abi: activityArtifact.abi,
      functionName: 'initialize',
      args: [parseEther('0.001'), deployer.address, 64n, 0n, 20n],
      account: deployer,
      chain: base,
    });
    await publicClient.waitForTransactionReceipt({ hash: initActivity });

    const initCoordinator = await deployerClient.writeContract({
      address: coordinator,
      abi: coordinatorArtifact.abi,
      functionName: 'initialize',
      args: [deployer.address, router],
      account: deployer,
      chain: base,
    });
    await publicClient.waitForTransactionReceipt({ hash: initCoordinator });

    const initRouter = await deployerClient.writeContract({
      address: router,
      abi: routerV3Artifact.abi,
      functionName: 'initialize',
      args: [deployer.address, marketplace, coordinator, activityChecker],
      account: deployer,
      chain: base,
    });
    await publicClient.waitForTransactionReceipt({ hash: initRouter });

    const setRouter = await deployerClient.writeContract({
      address: activityChecker,
      abi: activityArtifact.abi,
      functionName: 'setAuthorizedRouter',
      args: [router],
      account: deployer,
      chain: base,
    });
    await publicClient.waitForTransactionReceipt({ hash: setRouter });

    // 5. Deploy the mock mech with operator = the seeded operator EOA. The
    //    hermetic gate's bootstrap-from-snapshot replaces this with the real
    //    Safe; here we anchor it to a deterministic address so the fixture is
    //    self-describing.
    console.log('Step 6: deploying mock mech...');
    const mockMech = await deployContract(publicClient, rpcUrl, deployer, mechArtifact, [
      MOCK_MECH_RATE,
      NATIVE_PAYMENT_TYPE,
      operator.address,
      marketplace,
    ]);

    console.log();
    console.log('=== deployed V3 stack ===');
    console.log(`  coordinator:     ${coordinator}`);
    console.log(`  marketplace:     ${marketplace}`);
    console.log(`  activityChecker: ${activityChecker}`);
    console.log(`  router:          ${router}`);
    console.log(`  mockMech:        ${mockMech}`);
    console.log();

    // 6. Trigger the state dump: SIGTERM makes anvil flush --dump-state to disk,
    //    then exit. We resolve when the process exits cleanly.
    console.log('Step 7: dumping state (SIGTERM → anvil flushes --dump-state)...');
    const dumped = new Promise<void>((resolve, reject) => {
      anvil.once('exit', (code, signal) => {
        // anvil exits 0 on a clean SIGTERM dump; treat the SIGTERM signal as success too.
        if (code === 0 || signal === 'SIGTERM') resolve();
        else reject(new Error(`anvil exited uncleanly during dump (code=${code}, signal=${signal})`));
      });
    });
    anvil.kill('SIGTERM');
    await dumped;
  } catch (err) {
    if (!anvil.killed) anvil.kill('SIGKILL');
    throw err;
  }

  console.log();
  console.log(`Snapshot written to ${statePath}`);
  console.log('Commit the fixture and update docs/snapshots/base-v3-snapshot.md if the stack changed.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
