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
 *      `operator/test/e2e/_daemon-harness-helpers.ts deployMinimalV3Stack(...)`
 *      and `contracts/scripts/deploy-task-coordinator-router-v3.ts`:
 *        ActivityChecker.initialize
 *        -> Coordinator.initialize
 *        -> Router.initialize
 *        -> ActivityChecker.setAuthorizedRouter
 *      then deploy MockTaskMechWithDelivery(rate, paymentType, operator, market).
 *   3. Seed: fund the deployer EOA + operator EOA with ETH and seed the
 *      operator EOA with OLAS (via the ERC-20 balance-mapping slot — same
 *      trick `operator/test/_support/chain/olas-funding.ts` uses, no whale
 *      impersonation dance).
 *   4. `anvil --dump-state` → `operator/test/_support/fixtures/anvil-base-v3-state/state.json`.
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
 * (`operator/src/earning/contracts.ts` getChainConfig('base')) — never inlined
 * here — so a chain-config change flows through automatically.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { getChainConfig } from '../src/earning/contracts.js';
import { FleetBootstrapper } from '../src/earning/bootstrap.js';
// CJS package; keep it as a direct client dependency because this builder runs
// inside the client dependency boundary.
import * as safeDeployments from '@safe-global/safe-deployments';

// ── Configuration (env-overridable; CHAIN_CONFIG-derived addresses) ────────────

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(SCRIPT_DIR, '..');
const CONTRACTS_DIR = path.resolve(CLIENT_DIR, '..', 'contracts');

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
 *
 * MUST be ≥ the deployment block of every Jinn contract the warm-up bootstrap
 * touches — notably the ERC-8004 IdentityRegistry (0x8004…), which deployed on
 * Base mainnet between blocks 40M and 44M. An earlier pin leaves register() a
 * no-op (no code → "Registered event missing") and the warm-up fails. 46M is
 * comfortably past every Jinn deploy and is archive-served by public RPCs.
 */
const DEFAULT_FORK_BLOCK = 46_000_000;

const CHAIN_CONFIG = getChainConfig('base');

/**
 * Deployer + operator EOAs — deterministic keys that match the e2e helpers
 * (`ANVIL_PRIVATE_KEYS` in `operator/test/e2e/task-first-helpers.ts`): key[0] is
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
const STALE_PRE_TRIM_ROUTER = '0xbB126c57DEfBD673FB5d94BB50ffD21A931Ba72D';
const SNAPSHOT_DEPLOYER_NONCE_OFFSET = 4n;

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

export async function buildAnvilSnapshot(): Promise<void> {
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

    // The stale pre-trim snapshot deployed the router at the default key[0]
    // nonce-3 CREATE address. Advance the local-only deployer nonce so a real
    // refresh cannot silently reuse that sentinel address.
    const deployerNonce = await publicClient.getTransactionCount({ address: deployer.address });
    const deploymentNonce = BigInt(deployerNonce) + SNAPSHOT_DEPLOYER_NONCE_OFFSET;
    await jsonRpc(rpcUrl, 'anvil_setNonce', [deployer.address, numberToHex(deploymentNonce)]);
    console.log(
      `  deployer nonce advanced: ${deployerNonce} → ${deploymentNonce.toString()} ` +
        '(avoids stale pre-trim router sentinel)',
    );

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
    if (router.toLowerCase() === STALE_PRE_TRIM_ROUTER.toLowerCase()) {
      throw new Error(`snapshot refresh produced stale pre-trim router address ${router}`);
    }

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

    // 5.5 Write the address manifest next to the snapshot. The deployer EOA is a
    //     forked account whose nonce is its real Base nonce (NOT 0), so deploy
    //     CREATE addresses are NOT derivable from a low nonce — consumers must
    //     read them from here, never re-derive. Self-describing fixture.
    const addresses = {
      coordinator,
      marketplace,
      activityChecker,
      router,
      mockMech,
      deployer: deployer.address,
      operator: operator.address,
      forkBlock,
      nativePaymentType: NATIVE_PAYMENT_TYPE,
    };
    writeFileSync(path.join(outDir, 'addresses.json'), JSON.stringify(addresses, null, 2) + '\n');
    console.log(`Step 6.5: wrote address manifest → ${path.join(outDir, 'addresses.json')}`);

    // 5.6 Warm the OLAS service stack + Safe contracts into the dump (spec §4 —
    //     "seed the Safe factory, registries"). `--dump-state` only persists
    //     accounts TOUCHED this session; the per-PR gate loads it with NO fork
    //     fallback, so anything bootstrap reads must already be cached. Rather
    //     than guess which registry/factory/distributor slots the 11-step flow
    //     reads, run the REAL FleetBootstrapper once here (offline, against the
    //     fork) — it touches exactly the transitive closure, caching every
    //     account + slot into the dump. This warm-up operator is a throwaway; the
    //     hermetic bootstrap-from-scratch test bootstraps its OWN fresh operator
    //     at load time and benefits from the cached infra.
    console.log('Step 6.6: warm-up bootstrap (caches OLAS/Safe stack into the dump)...');
    const warmDir = await mkdtemp(path.join(tmpdir(), 'jinn-snapshot-warm-'));
    try {
      const WARM_PASSWORD = 'snapshot-warmup';
      const b1 = new FleetBootstrapper({ earningDir: warmDir, chain: 'base', rpcUrl });
      const phase1 = await b1.bootstrap(WARM_PASSWORD);
      if (!phase1.funding) {
        throw new Error(`warm-up: expected awaiting_funding, got ok=${phase1.ok} message=${phase1.message}`);
      }
      await jsonRpc(rpcUrl, 'anvil_setBalance', [phase1.funding.master_address, numberToHex(parseEther('100'))]);
      await jsonRpc(rpcUrl, 'evm_mine', []);
      const b2 = new FleetBootstrapper({ earningDir: warmDir, chain: 'base', rpcUrl });
      const phase2 = await b2.bootstrap(WARM_PASSWORD);
      if (!phase2.ok) {
        throw new Error(`warm-up bootstrap did not complete: ${phase2.message}`);
      }
      console.log(`  warm-up bootstrap complete (service_id=${phase2.fleet_state.services[0]?.service_id ?? '?'}) — OLAS/Safe stack now in the dump`);
    } finally {
      await rm(warmDir, { recursive: true, force: true }).catch(() => {});
    }

    // 5.7 Persist Safe singletons the SDK *validates* (read-only getCode) but the
    //     warm-up deploy never *executes*. `anvil --dump-state` only journals
    //     accounts touched by TRANSACTIONS, not fork accounts merely read via
    //     eth_getCode — so a read-validated singleton is absent on --load-state
    //     and Safe SDK init fails with "MultiSend contract is not deployed on the
    //     current network". Copy their fork bytecode into local state (read →
    //     setCode = a journaled write) so the hermetic gate, which loads with NO
    //     fork fallback, sees them. Resolve the addresses from
    //     @safe-global/safe-deployments — the SAME source @safe-global/protocol-kit
    //     uses — so we get Base's actual (EIP-155, non-canonical) deployment
    //     addresses, not the chainId-0 canonical ones.
    console.log('Step 6.7: persisting read-validated Safe singletons into the dump...');
    const chainKey = String(base.id);
    const sd: any = (safeDeployments as any).default ?? safeDeployments;
    const SAFE_GETTERS = [
      'getMultiSendDeployment',
      'getMultiSendCallOnlyDeployment',
      'getProxyFactoryDeployment',
      'getSafeSingletonDeployment',
      'getSafeL2SingletonDeployment',
      'getCompatibilityFallbackHandlerDeployment',
      'getFallbackHandlerDeployment',
      'getSignMessageLibDeployment',
      'getCreateCallDeployment',
      'getSimulateTxAccessorDeployment',
    ];
    const SAFE_VERSIONS = ['1.4.1', '1.3.0'];
    const safeAddrs = new Set<string>();
    for (const getter of SAFE_GETTERS) {
      const fn = sd[getter];
      if (typeof fn !== 'function') continue;
      for (const version of SAFE_VERSIONS) {
        let deployment: any;
        try {
          deployment = fn({ network: chainKey, version });
        } catch {
          continue;
        }
        if (!deployment) continue;
        const raw = deployment.networkAddresses?.[chainKey] ?? deployment.defaultAddress;
        for (const a of Array.isArray(raw) ? raw : [raw]) {
          if (a) safeAddrs.add(getAddress(a as string));
        }
      }
    }
    let persisted = 0;
    for (const addr of safeAddrs) {
      const code = (await jsonRpc(rpcUrl, 'eth_getCode', [addr as Address, 'latest'])) as string;
      if (code && code !== '0x') {
        await jsonRpc(rpcUrl, 'anvil_setCode', [addr as Address, code]);
        persisted++;
      }
    }
    await jsonRpc(rpcUrl, 'evm_mine', []);
    console.log(`  persisted ${persisted}/${safeAddrs.size} Safe-deployment contracts for chain ${chainKey} from the fork`);

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

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  buildAnvilSnapshot()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
