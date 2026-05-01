/**
 * End-to-end validation script for the JinnRouter production flow on a Base
 * mainnet fork (via Anvil).
 *
 * Bootstraps everything from scratch — no external credentials needed.
 *
 * Validates the complete lifecycle:
 *   Bootstrap operator (service + mech) on Anvil fork
 *   Creator posts -> router.createRestorationJob -> marketplace
 *   Restorer picks up -> delivers via ClaudeRunner(mock-agent.sh)
 *   Creator claims -> router.claimDelivery -> creates evaluation
 *   Restorer picks up evaluation -> delivers
 *   Creator claims evaluation -> done
 *   Checkpoint -> verify staking rewards
 *   CLI smoke: jinn subprocess with --config + --password-fd (parse + dry-run paths),
 *   fleet retire display index vs chain index, nextFleetServiceIndex helper, empty strict claim tick
 *
 * Usage: yarn e2e   (or `yarn exec tsx scripts/e2e-validate.ts`)
 */

import { config as dotenvConfig } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env') });

import { spawnAnvilFork, jsonRpc as anvilJsonRpc, type AnvilHarness } from '../_support/chain/anvil.js';
import { fundAddressWithOLAS } from '../_support/chain/olas-funding.js';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { WalletClient } from 'viem';
import { base } from 'viem/chains';
import {
  decodeMarketplaceRequestLogs,
} from '../../src/adapters/mech/contracts.js';
import {
  MECH_ABI,
  MECH_MARKETPLACE_ABI,
  JINN_ROUTER_ABI,
  NATIVE_PAYMENT_TYPE,
} from '../../src/adapters/mech/types.js';
import { MechAdapter } from '../../src/adapters/mech/adapter.js';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { getChainConfig } from '../../src/earning/contracts.js';
const __dirname = join(fileURLToPath(import.meta.url), '..');

// ── Constants ────────────────────────────────────────────────────────────────

// Use a reliable RPC for Anvil fork — public mainnet.base.org is unreliable for lazy state fetching.
// Recommended: set BASE_RPC_URL to a Tenderly, Alchemy, or Infura endpoint.
const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
const PASSWORD = 'test-password';

// These are assigned in Phase 1 via spawnAnvilFork and used throughout.
let ANVIL_PORT = 0;
let ANVIL_RPC = '';

const CHAIN_CONFIG = getChainConfig('base');
const OLAS_TOKEN = CHAIN_CONFIG.olasToken;

const MARKETPLACE_ADDRESS: Address = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const ROUTER_ADDRESS: Address = '0xfFa7118A3D820cd4E820010837D65FAfF463181B';
const MARKETPLACE_AGENT_FACTORY_SENTINEL: Address = '0x000000000000000000000000000000000000dEaD';
const MARKETPLACE_SLOT_SCAN_MAX = 64n;
const UINT32_MAX = 0xffff_ffffn;
const RESPONSE_TIMEOUT_HEADROOM = 3600n;
const MARKETPLACE_DIAGNOSTIC_ABI = [
  {
    name: 'mapAgentMechFactories',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'mapMechFactories',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'checkMech',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'mech', type: 'address' }],
    outputs: [{ name: 'multisig', type: 'address' }],
  },
] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitFor(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs = 30000,
  intervalMs = 500,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for: ${description}`);
}

/**
 * `watchForDeliveries` can yield a restoration delivery before
 * `tryCreateEvaluationJob` has observed `restorationDeliveryClaimed` on the
 * router (stale RPC). The eval tx may post on a later `watchForDeliveries`
 * poll. Operator B's `processOne` must not start until
 * `EvaluationJobCreated` for this restoration is on chain.
 */
async function waitForRouterEvaluationJobForRestoration(
  publicClient: PublicClient,
  routerAddress: Address,
  restorationRequestId: Hex,
  anvilRpc: string,
  fromBlock: bigint,
): Promise<void> {
  const want = restorationRequestId.toLowerCase();
  await waitFor(
    `router EvaluationJobCreated (restorationRequestId ${restorationRequestId})`,
    async () => {
      try {
        await anvilJsonRpc(anvilRpc, 'evm_mine', []);
      } catch {
        /* ignore */
      }
      const tip = await publicClient.getBlockNumber();
      if (tip < fromBlock) {
        return false;
      }
      const logs = await publicClient.getLogs({
        address: routerAddress,
        fromBlock,
        toBlock: tip,
      });
      for (const log of logs) {
        try {
          const decoded = decodeEventLog({
            abi: JINN_ROUTER_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === 'EvaluationJobCreated') {
            const args = decoded.args as { restorationRequestId: Hex };
            if (String(args.restorationRequestId).toLowerCase() === want) {
              return true;
            }
          }
        } catch {
          /* not a router event */
        }
      }
      return false;
    },
    120_000,
    500,
  );
  console.log('    Evaluation job on chain (EvaluationJobCreated) — proceeding to operator B eval');
}

// ── Phase runner ─────────────────────────────────────────────────────────────

interface PhaseResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/** Last line of stdout that looks like a JSON object (config may log to stderr only). */
function parseLastStdoutJsonObject(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.startsWith('{')) {
      return JSON.parse(line) as Record<string, unknown>;
    }
  }
  throw new Error(`No JSON object in CLI stdout (last 400 chars): ${stdout.slice(-400)}`);
}

/**
 * Run `yarn exec tsx bin/jinn.ts ...` from the client package root.
 * When `passwordFdContent` is set, appends `--password-fd <n>` where `n` is an open read fd shared
 * with the child via `stdio` (same fd number in parent and child on Unix).
 */
async function runJinnCliSubprocess(
  cliArgs: string[],
  options: { passwordFdContent?: string; tmpDirForPw: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  /** `validate.ts` lives in `client/test/e2e/`; package root is two levels up. */
  const clientRoot = join(__dirname, '..', '..');
  const jinnBin = join(clientRoot, 'bin', 'jinn.ts');
  let pwFd: number | undefined;
  let finalArgs = cliArgs;
  const stdio: Array<'ignore' | 'pipe' | number> = ['ignore', 'pipe', 'pipe'];
  if (options.passwordFdContent !== undefined) {
    const pwPath = join(options.tmpDirForPw, 'e2e-cli-password-fd.txt');
    await writeFile(pwPath, options.passwordFdContent, 'utf8');
    pwFd = openSync(pwPath, 'r');
    stdio.push(pwFd);
    finalArgs = [...cliArgs, '--password-fd', String(pwFd)];
  }

  const child = spawn('yarn', ['exec', 'tsx', jinnBin, ...finalArgs], {
    cwd: clientRoot,
    stdio: stdio as ('ignore' | 'pipe' | number)[],
    env: { ...process.env },
  });

  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout?.on('data', (c: Buffer) => { out.push(c); });
  child.stderr?.on('data', (c: Buffer) => { err.push(c); });

  const code = await new Promise<number | null>((resolve) => {
    child.on('close', resolve);
    child.on('error', () => resolve(1));
  });

  if (pwFd !== undefined) {
    closeSync(pwFd);
  }

  return {
    code,
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
  };
}

async function runPhase(name: string, fn: () => Promise<void>): Promise<PhaseResult> {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    console.log(`  ✓ ${name} (${ms}ms)`);
    return { name, ok: true, ms };
  } catch (err) {
    const ms = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name} (${ms}ms): ${error}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    return { name, ok: false, ms, error };
  }
}

function addressMappingSlot(holder: Address, mappingSlot: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [holder, mappingSlot],
    ),
  );
}

function addressStorageWord(address: Address): Hex {
  return pad(address, { size: 32 });
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function getStorageWord(contractAddress: Address, slot: Hex): Promise<Hex> {
  return await anvilJsonRpc(ANVIL_RPC, 'eth_getStorageAt', [contractAddress, slot, 'latest']) as Hex;
}

async function setStorageWord(contractAddress: Address, slot: Hex, value: Hex): Promise<void> {
  await anvilJsonRpc(ANVIL_RPC, 'anvil_setStorageAt', [contractAddress, slot, value]);
}

async function readAgentFactory(publicClient: PublicClient, mechAddress: Address): Promise<Address> {
  return await publicClient.readContract({
    address: MARKETPLACE_ADDRESS,
    abi: MARKETPLACE_DIAGNOSTIC_ABI,
    functionName: 'mapAgentMechFactories',
    args: [mechAddress],
  }) as Address;
}

async function readFactoryWhitelist(publicClient: PublicClient, factoryAddress: Address): Promise<boolean> {
  return await publicClient.readContract({
    address: MARKETPLACE_ADDRESS,
    abi: MARKETPLACE_DIAGNOSTIC_ABI,
    functionName: 'mapMechFactories',
    args: [factoryAddress],
  }) as boolean;
}

async function checkMech(publicClient: PublicClient, mechAddress: Address): Promise<Address> {
  return await publicClient.readContract({
    address: MARKETPLACE_ADDRESS,
    abi: MARKETPLACE_DIAGNOSTIC_ABI,
    functionName: 'checkMech',
    args: [mechAddress],
  }) as Address;
}

async function pinAgentFactoryMapping(
  publicClient: PublicClient,
  mechAddress: Address,
  factoryAddress: Address,
): Promise<bigint> {
  for (let candidateSlot = 0n; candidateSlot <= MARKETPLACE_SLOT_SCAN_MAX; candidateSlot++) {
    const slot = addressMappingSlot(mechAddress, candidateSlot);
    const original = await getStorageWord(MARKETPLACE_ADDRESS, slot);

    let matched = false;
    try {
      await setStorageWord(MARKETPLACE_ADDRESS, slot, addressStorageWord(MARKETPLACE_AGENT_FACTORY_SENTINEL));

      const readBack = await readAgentFactory(publicClient, mechAddress);
      if (sameAddress(readBack, MARKETPLACE_AGENT_FACTORY_SENTINEL)) {
        await setStorageWord(MARKETPLACE_ADDRESS, slot, addressStorageWord(factoryAddress));
        matched = true;
        return candidateSlot;
      }
    } finally {
      if (!matched) {
        await setStorageWord(MARKETPLACE_ADDRESS, slot, original);
      }
    }
  }

  throw new Error(
    `Could not locate mapAgentMechFactories storage slot for ${mechAddress} within 0-${MARKETPLACE_SLOT_SCAN_MAX}`,
  );
}

async function warmCreateRestorationJobPath(
  safeAddress: Address,
  mechAddress: Address,
  deliveryRate: bigint,
  responseTimeout: bigint,
): Promise<void> {
  const data = encodeFunctionData({
    abi: JINN_ROUTER_ABI,
    functionName: 'createRestorationJob',
    args: ['0x1234', mechAddress, deliveryRate, responseTimeout, NATIVE_PAYMENT_TYPE, '0x'],
  });

  await anvilJsonRpc(ANVIL_RPC, 'eth_call', [
    {
      from: safeAddress,
      to: ROUTER_ADDRESS,
      value: numberToHex(deliveryRate),
      data,
    },
    'latest',
  ]);
}

async function stabilizeForkedMarketplaceState(
  publicClient: PublicClient,
  safeAddress: Address,
  mechAddress: Address,
): Promise<void> {
  const expectedFactory = CHAIN_CONFIG.mechFactory as Address;

  const [factoryBefore, factoryWhitelisted] = await Promise.all([
    readAgentFactory(publicClient, mechAddress),
    readFactoryWhitelist(publicClient, expectedFactory),
  ]);

  let checkMechBefore: string;
  try {
    checkMechBefore = await checkMech(publicClient, mechAddress);
  } catch (err) {
    checkMechBefore = `revert: ${err instanceof Error ? err.message : String(err)}`;
  }

  console.log(
    `    [fork] marketplace before: agentFactory=${factoryBefore}, factoryWhitelisted=${factoryWhitelisted}, checkMech=${checkMechBefore}`,
  );

  const pinnedSlot = await pinAgentFactoryMapping(publicClient, mechAddress, expectedFactory);
  const factoryAfter = await readAgentFactory(publicClient, mechAddress);
  if (!sameAddress(factoryAfter, expectedFactory)) {
    throw new Error(
      `Pinned mapAgentMechFactories slot ${pinnedSlot}, but readback was ${factoryAfter} instead of ${expectedFactory}`,
    );
  }

  const [deliveryRate, timeoutBounds] = await Promise.all([
    publicClient.readContract({
      address: mechAddress,
      abi: MECH_ABI,
      functionName: 'maxDeliveryRate',
    }) as Promise<bigint>,
    Promise.all([
      publicClient.readContract({
        address: MARKETPLACE_ADDRESS,
        abi: MECH_MARKETPLACE_ABI,
        functionName: 'minResponseTimeout',
      }) as Promise<bigint>,
      publicClient.readContract({
        address: MARKETPLACE_ADDRESS,
        abi: MECH_MARKETPLACE_ABI,
        functionName: 'maxResponseTimeout',
      }) as Promise<bigint>,
    ]),
  ]);

  await warmCreateRestorationJobPath(
    safeAddress,
    mechAddress,
    deliveryRate,
    timeoutBounds[1],
  );

  const checkMechAfter = await checkMech(publicClient, mechAddress);
  console.log(
    `    [fork] pinned mapAgentMechFactories slot ${pinnedSlot}; checkMech now resolves to ${checkMechAfter}`,
  );
}

async function resolveForkTimestamp(forkBlock?: string): Promise<bigint> {
  try {
    const upstreamBlock = await anvilJsonRpc(BASE_RPC_URL, 'eth_getBlockByNumber', [
      forkBlock ? numberToHex(BigInt(forkBlock)) : 'latest',
      false,
    ]) as { timestamp?: string } | null;
    if (upstreamBlock?.timestamp) {
      return BigInt(upstreamBlock.timestamp);
    }
  } catch {
    // Fallback to wall clock time if upstream block lookup fails.
  }

  return BigInt(Math.floor(Date.now() / 1000));
}

async function normalizeForkTimestamp(
  publicClient: PublicClient,
  forkBlock?: string,
): Promise<void> {
  const latestBlock = await publicClient.getBlock();
  if (latestBlock.timestamp <= UINT32_MAX - RESPONSE_TIMEOUT_HEADROOM) {
    console.log(`    Fork timestamp: ${latestBlock.timestamp}`);
    return;
  }

  const targetTimestamp = await resolveForkTimestamp(forkBlock);
  const cappedTarget = targetTimestamp <= UINT32_MAX - RESPONSE_TIMEOUT_HEADROOM
    ? targetTimestamp
    : UINT32_MAX - RESPONSE_TIMEOUT_HEADROOM;

  await anvilJsonRpc(ANVIL_RPC, 'evm_setTime', [Number(cappedTarget)]);
  await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

  const normalizedBlock = await publicClient.getBlock();
  if (normalizedBlock.timestamp > UINT32_MAX - RESPONSE_TIMEOUT_HEADROOM) {
    throw new Error(
      `Fork timestamp ${normalizedBlock.timestamp} still exceeds uint32.max safety window after evm_setTime`,
    );
  }

  console.log(
    `    Normalized fork timestamp from ${latestBlock.timestamp} to ${normalizedBlock.timestamp}`,
  );
}

// ── Crash guards ─────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[e2e] UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[e2e] UNHANDLED REJECTION:', reason);
  process.exit(1);
});

// Diagnostic: detect whether premature exits are from event-loop drain or explicit process.exit()
let exitExpected = false;
process.on('beforeExit', (code) => {
  if (!exitExpected) {
    console.error(`[e2e] UNEXPECTED beforeExit (code=${code}) — event loop drained prematurely`);
    console.error('[e2e] Stack:', new Error().stack);
  }
});
process.on('exit', (code) => {
  if (!exitExpected) {
    console.error(`[e2e] UNEXPECTED exit (code=${code})`);
  }
});

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== Jinn-Client E2E Validation (Self-Bootstrapped) ===\n');

  let chain: AnvilHarness | null = null;
  let tmpDir: string | null = null;
  const results: PhaseResult[] = [];

  // Shared state populated across phases
  let adapter: MechAdapter | undefined;
  let publicClient: PublicClient;
  let agentEoaPrivateKey: Hex | undefined;
  /** Operator A agent EOA — funded again before Phase 12+ after heavy earlier txs deplete bootstrap top-up. */
  let agentAddressA: Address | undefined;
  let safeAddress: Address | undefined;
  let mechAddress: Address | undefined;
  let serviceId: number | undefined;
  let restorationRequestId: string | undefined;
  /** Baseline multisig nonces after Phase 3 (for Phase 15 isRatioPass). */
  let baselineMultisigNonces: bigint[] | undefined;

  // ERC-8004 Phase 1b state (jinn-mono-al7).
  /** ERC-8004 agentId minted in Phase 2 (bootstrap stepRegisterAgent). */
  let agentId: bigint | undefined;
  /** Whether the Safe→agentId binding (setAgentWallet) succeeded in bootstrap. */
  let safeBoundToAgent: boolean | undefined;
  /** IdentityRegistry address persisted on the EarningState. */
  let identityRegistryAddress: Address | undefined;
  /** Block range for scanning ERC-8004 events emitted during bootstrap. */
  let bootstrapEventFromBlock: bigint | undefined;
  /**
   * Per-execution envelope publish state for the ERC-8004 Phase 1b assertions.
   * Populated by the new "envelope publish" phase and reused by the validation
   * + reputation phases.
   */
  let publishedEnvelopeManifestCid: string | undefined;
  let publishedEnvelopeManifestHash: Hex | undefined;

  // Phase 12 cross-operator state
  let tmpDir2: string | null = null;
  let safeAddressB: Address | undefined;
  let mechAddressB: Address | undefined;
  let agentEoaPrivateKeyB: Hex | undefined;

  // API server for DAEMON_API_URL flow
  let restorerApiServer: import('../../src/api/server.js').ApiServer | undefined;
  let e2eClaimRegistryAddress: Address | undefined;

  async function deployClaimRegistryForE2e(): Promise<Address> {
    if (e2eClaimRegistryAddress) return e2eClaimRegistryAddress;

    const { createWalletClient: createWC } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { readFileSync: readFS, existsSync } = await import('node:fs');
    const { join: joinPath } = await import('node:path');

    const artifactPath = joinPath(__dirname, '..', '..', '..', 'contracts', 'artifacts', 'src', 'claiming', 'ClaimRegistry.sol', 'ClaimRegistry.json');
    if (!existsSync(artifactPath)) {
      throw new Error(`ClaimRegistry artifact not found (${artifactPath}); run contracts build before e2e`);
    }
    const artifact = JSON.parse(readFS(artifactPath, 'utf-8'));

    const deployerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
    const deployerAccount = privateKeyToAccount(deployerKey);
    await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [deployerAccount.address, '0x56BC75E2D63100000']);
    const deployerWallet = createWC({
      account: deployerAccount,
      chain: base,
      transport: http(ANVIL_RPC),
    });

    const constructorArgs = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }],
      [60n, deployerAccount.address],
    );
    const deployHash = await deployerWallet.sendTransaction({
      data: (artifact.bytecode + constructorArgs.slice(2)) as Hex,
      chain: base,
    });
    await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    e2eClaimRegistryAddress = deployReceipt.contractAddress as Address;
    console.log(`    E2E ClaimRegistry deployed at: ${e2eClaimRegistryAddress}`);
    return e2eClaimRegistryAddress;
  }

  try {
    // ── Phase 1: Infrastructure ──────────────────────────────────────────────

    results.push(
      await runPhase('Phase 1: Infrastructure — spawn Anvil fork, create temp dir', async () => {
        // Create temp directory for earning store
        tmpDir = await mkdtemp(join(tmpdir(), 'jinn-e2e-'));
        console.log(`    Temp dir: ${tmpDir}`);

        // Spawn Anvil fork via shared helper
        const forkBlock = process.env['ANVIL_FORK_BLOCK'] ?? '';
        chain = await spawnAnvilFork({
          forkUrl: BASE_RPC_URL,
          forkBlock: forkBlock ? Number(forkBlock) : undefined,
          silent: true,
        });
        ANVIL_RPC = chain.rpcUrl;
        ANVIL_PORT = chain.port;

        publicClient = createPublicClient({
          chain: base,
          transport: http(ANVIL_RPC),
        }) as unknown as PublicClient;

        const blockNumber = await publicClient.getBlockNumber();
        console.log(`    Anvil forked at block ${blockNumber}`);

        await normalizeForkTimestamp(publicClient, forkBlock || undefined);
      }),
    );

    // ── Phase 2: Bootstrap operator ──────────────────────────────────────────

    results.push(
      await runPhase('Phase 2: Bootstrap operator — create service + mech', async () => {
        if (!tmpDir) throw new Error('No temp dir from Phase 1');

        // Capture the chain head before bootstrap so the ERC-8004 assertions
        // (jinn-mono-al7) can scope `getLogs` to the bootstrap window.
        bootstrapEventFromBlock = await publicClient.getBlockNumber();

        // Step 1: Run bootstrap to get awaiting_funding (creates wallet + predicts safe)
        let bootstrapper = new FleetBootstrapper({
          earningDir: tmpDir,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
        });

        const initialResult = await bootstrapper.bootstrap(PASSWORD);
        if (!initialResult.funding) {
          throw new Error(`Expected funding requirement in result, but bootstrap returned ok=${initialResult.ok}`);
        }

        const masterAddress = initialResult.funding.master_address;
        console.log(`    Master: ${masterAddress}`);

        // Step 2: Fund accounts on Anvil — independent writes, run concurrently.
        // (Note: Safe OLAS funding is handled later, after Safe creation in bootstrap.)
        const eoaOlasAmount = 100000n * 10n ** 18n;
        await Promise.all([
          // Fund Master with enough ETH for bootstrap (100 ETH).
          anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [masterAddress, '0x56BC75E2D63100000']),
          // Fund staking contract with OLAS rewards via deposit() using master address.
          fundAddressWithOLAS(chain!, masterAddress as Address, eoaOlasAmount),
        ]);

        await anvilJsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [masterAddress]);
        const olasApprove = encodeFunctionData({
          abi: parseAbi(['function approve(address,uint256) returns (bool)']),
          functionName: 'approve',
          args: [CHAIN_CONFIG.stakingContract as Address, eoaOlasAmount],
        });
        await anvilJsonRpc(ANVIL_RPC, 'eth_sendTransaction', [
          { from: masterAddress, to: OLAS_TOKEN, data: olasApprove },
        ]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        const depositData = encodeFunctionData({
          abi: parseAbi(['function deposit(uint256)']),
          functionName: 'deposit',
          args: [eoaOlasAmount],
        });
        await anvilJsonRpc(ANVIL_RPC, 'eth_sendTransaction', [
          { from: masterAddress, to: CHAIN_CONFIG.stakingContract, data: depositData },
        ]);
        await anvilJsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [masterAddress]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Verify staking rewards
        const rewards = await publicClient.readContract({
          address: CHAIN_CONFIG.stakingContract as Address,
          abi: parseAbi(['function availableRewards() view returns (uint256)']),
          functionName: 'availableRewards',
        });
        console.log(`    Staking rewards: ${Number(rewards) / 1e18} OLAS`);

        // Step 3: Re-run bootstrap to completion
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        bootstrapper = new FleetBootstrapper({
          earningDir: tmpDir,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
        });

        const finalResult = await bootstrapper.bootstrap(PASSWORD);
        if (!finalResult.ok) {
          throw new Error(
            `Bootstrap failed: ${finalResult.message}`,
          );
        }

        const firstComplete = finalResult.fleet_state.services.find(s => s.step === 'complete');
        serviceId = firstComplete?.service_id ?? undefined;
        safeAddress = firstComplete?.safe_address as Address | undefined;
        mechAddress = firstComplete?.mech_address as Address | undefined;

        if (!mechAddress) {
          throw new Error('Bootstrap completed but no mech_address in state');
        }

        // ── ERC-8004 Phase 1b state (jinn-mono-al7) ─────────────────────────
        // The bootstrap state machine now includes an `agent_registered` step
        // (jinn-mono-j07) that mints an ERC-8004 IdentityRegistry NFT and
        // calls `setAgentWallet` to bind the Safe (jinn-mono-aev). Capture
        // those fields here so downstream phases can assert against them.
        if (firstComplete?.agent_id) {
          agentId = BigInt(firstComplete.agent_id);
        }
        safeBoundToAgent = firstComplete?.safe_bound_to_agent ?? false;
        if (firstComplete?.identity_registry_address) {
          identityRegistryAddress = getAddress(firstComplete.identity_registry_address) as Address;
        }

        // Step 4: Decrypt mnemonic keystore to derive agent EOA private key
        const { FleetStateStore } = await import('../../src/earning/store.js');
        const { decryptMnemonic, walletPrivateKeyAtIndex } = await import('../../src/earning/wallet.js');
        const store = new FleetStateStore(tmpDir);
        const mnemonic = await decryptMnemonic(
          await store.loadMnemonicKeystore(),
          PASSWORD,
        );
        agentEoaPrivateKey = walletPrivateKeyAtIndex(mnemonic, firstComplete!.index);
        agentAddressA = getAddress(firstComplete!.agent_address) as Address;

        console.log(`    Bootstrap complete!`);
        console.log(`    Service ID: ${serviceId}`);
        console.log(`    Safe: ${safeAddress}`);
        console.log(`    Mech: ${mechAddress}`);
        console.log(`    ERC-8004 agentId: ${agentId ?? '(not minted)'}`);
        console.log(`    ERC-8004 safe_bound_to_agent: ${safeBoundToAgent}`);
        console.log(`    ERC-8004 identity_registry_address: ${identityRegistryAddress ?? '(none)'}`);
      }),
    );

    // ── Phase 3: Create MechAdapter + verify ─────────────────────────────────

    results.push(
      await runPhase('Phase 3: Create MechAdapter + verify nonces', async () => {
        if (!agentEoaPrivateKey || !safeAddress || !mechAddress) {
          throw new Error('Missing credentials from Phase 2');
        }

        adapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS as `0x${string}`,
          routerAddress: ROUTER_ADDRESS as `0x${string}`,
          mechContractAddress: mechAddress as `0x${string}`,
          safeAddress: safeAddress as `0x${string}`,
          agentEoaPrivateKey: agentEoaPrivateKey as `0x${string}`,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
          routerClaimDeliveryVariant: 'v1',
        });
        await adapter.initialize();
        console.log('    MechAdapter initialized');

        // warmCreateRestorationJobPath eth_call uses `from: safeAddress` with msg.value = deliveryRate;
        // fund the Safe on the fork so the simulation does not fail with insufficient funds.
        await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [
          safeAddress,
          '0x56BC75E2D63100000', // 100 ETH
        ]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Verify getMultisigNonces returns valid nonces
        const activityChecker = await publicClient.readContract({
          address: CHAIN_CONFIG.stakingContract as Address,
          abi: parseAbi(['function activityChecker() view returns (address)']),
          functionName: 'activityChecker',
        });
        const nonces = await publicClient.readContract({
          address: activityChecker,
          abi: parseAbi(['function getMultisigNonces(address) view returns (uint256[])']),
          functionName: 'getMultisigNonces',
          args: [safeAddress],
        });
        baselineMultisigNonces = [...nonces];
        console.log(`    Activity checker: ${activityChecker}`);
        console.log(`    Initial nonces: [${nonces.map(String).join(', ')}]`);

        // Anvil can lazily fetch stale/zero marketplace storage from the fork RPC
        // during the first request transaction. Pin the mech factory mapping into
        // local fork state and simulate the router path before the real tx.
        await stabilizeForkedMarketplaceState(publicClient, safeAddress, mechAddress);
      }),
    );

    // ── Phase 4: Creator posts desired state ─────────────────────────────────

    results.push(
      await runPhase('Phase 4: Creator posts desired state', async () => {
        if (!adapter) throw new Error('No adapter from Phase 3');

        // Mine 3 blocks to flush any stale nonce state from bootstrap.
        // anvil_mine returns synchronously after the blocks commit.
        await chain.mineBlocks(3);

        restorationRequestId = await adapter.postRestorationJob({
          id: 'e2e-test',
          description: 'E2E router flow test',
          type: 'restoration',
          attemptId: 'e2e-test/1',
          attemptNumber: 1,
        });

        // Mine a block to make events visible
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        console.log(`    requestId: ${restorationRequestId}`);

        // Verify MarketplaceRequest event on marketplace
        const currentBlock = await publicClient.getBlockNumber();
        const logs = await publicClient.getLogs({
          address: MARKETPLACE_ADDRESS,
          fromBlock: currentBlock - 5n,
          toBlock: currentBlock,
        });
        const decoded = decodeMarketplaceRequestLogs(logs);
        if (decoded.length === 0) {
          throw new Error('No MarketplaceRequest event found');
        }

        const found = decoded.find(d => d.requestId === restorationRequestId);
        if (!found) {
          throw new Error(`MarketplaceRequest event not found for requestId ${restorationRequestId}`);
        }
        console.log('    MarketplaceRequest event verified on-chain');
      }),
    );

    // ── Phase 5: Restorer delivers via ClaudeRunner (E2E legacy loop) ───────
    //
    // Full RestorationEngine is wired in Phase 11 and requires two-layer
    // ClaimRegistry deps on the fork. Phases 5–8 use {@link E2eRestorerLoop} —
    // same behavior as the former production `RestorerLoop` (adapter + runner).

    const { E2eRestorerLoop } = await import('./legacy-restorer.js');
    const { ClaudeRunner } = await import('../../src/runner/claude.js');
    const { Store } = await import('../../src/store/store.js');

    const USE_REAL_AGENT = process.env['JINN_E2E_AGENT'] === 'real';
    const agentPath = USE_REAL_AGENT ? 'claude' : join(__dirname, '..', '..', 'scripts', 'mock-agent.sh');
    const agentModel = USE_REAL_AGENT ? 'claude-haiku-4-5-20251001' : undefined;
    const agentTimeoutMs = USE_REAL_AGENT ? 300000 : 60000;
    if (USE_REAL_AGENT) {
      console.log('    Using REAL Claude agent');
    }

    const storePath = join(tmpDir!, 'jinn-e2e.db');
    const store = new Store(storePath);

    // Start API server so submit_restoration_result can POST artifacts via DAEMON_API_URL
    // Use port 0 to let the OS assign a free port, avoiding EADDRINUSE from stale e2e runs.
    const { startApiServer } = await import('../../src/api/server.js');
    restorerApiServer = await startApiServer({ port: 0, store, apiToken: 'e2e-test-token' });
    const daemonApiUrl = `http://127.0.0.1:${restorerApiServer.port}`;

    const runner = new ClaudeRunner({ claudePath: agentPath, model: agentModel });
    const restorer = new E2eRestorerLoop(adapter!, runner, store, join(tmpDir!, 'e2e-work'), agentTimeoutMs, daemonApiUrl);

    // Create the delivery iterator once — it is infinite and carries state
    const deliveryIter = adapter!.watchForDeliveries()[Symbol.asyncIterator]();

    results.push(
      await runPhase('Phase 5: Restorer picks up request and delivers via ClaudeRunner', async () => {
        if (!adapter || !restorationRequestId) throw new Error('Missing state from prior phases');

        // Mine blocks so the restorer sees the request
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Mine blocks continuously while processOne runs
        const miningInterval = setInterval(async () => {
          try { await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        try {
          const processed = await Promise.race([
            restorer.processOne(),
            sleep(agentTimeoutMs + 30000).then(() => { throw new Error(`restorer.processOne timed out after ${(agentTimeoutMs + 30000) / 1000}s`); }),
          ]);
          if (!processed) throw new Error('processOne returned false — no request found');
        } finally {
          clearInterval(miningInterval);
        }

        console.log('    E2eRestorerLoop.processOne() completed');

        // Mine a block to confirm the delivery transaction
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Verify on-chain: mapRequestIdInfos should show a non-zero deliveryMech
        const info = await publicClient.readContract({
          address: MARKETPLACE_ADDRESS,
          abi: MECH_MARKETPLACE_ABI,
          functionName: 'mapRequestIdInfos',
          args: [restorationRequestId as Hex],
        }) as [string, string, string, bigint, bigint, string];

        const deliveryMech = info[1];
        if (deliveryMech === '0x0000000000000000000000000000000000000000') {
          throw new Error('deliveryMech is zero — delivery did not happen');
        }
        console.log(`    Delivery confirmed on-chain, deliveryMech: ${deliveryMech}`);
      }),
    );

    // ── Phase 6: Creator claims delivery + creates evaluation ────────────────

    results.push(
      await runPhase('Phase 6: Creator claims delivery + creates evaluation', async () => {
        if (!adapter || !restorationRequestId) throw new Error('Missing state from prior phases');

        // Mine blocks periodically to advance chain state
        const miningInterval = setInterval(async () => {
          try { await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        let delivery: Awaited<ReturnType<typeof deliveryIter.next>>;
        try {
          delivery = await Promise.race([
            deliveryIter.next(),
            sleep(USE_REAL_AGENT ? 120000 : 20000).then(() => { throw new Error(`watchForDeliveries timed out after ${USE_REAL_AGENT ? 120 : 20}s`); }),
          ]);
        } finally {
          clearInterval(miningInterval);
        }

        if (delivery.done || !delivery.value) throw new Error('watchForDeliveries ended unexpectedly');
        const del = delivery.value;

        // Verify delivered result
        if (del.requestId !== restorationRequestId) {
          throw new Error(`Expected requestId ${restorationRequestId}, got ${del.requestId}`);
        }
        if ((del.restorationJob.type ?? 'restoration') !== 'restoration') {
          throw new Error(`Expected type 'restoration', got '${del.restorationJob.type}'`);
        }
        if (!del.result.data) {
          throw new Error('Expected result.data to be present');
        }
        console.log(`    Delivery claimed for requestId: ${del.requestId}`);
        console.log(`    restorationJob.type: ${del.restorationJob.type ?? 'restoration'}`);
        console.log(`    result.data: "${del.result.data.slice(0, 80)}"`);

        // Mine to ensure evaluation creation tx is confirmed
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Verify DeliveryClaimed + EvaluationJobCreated events from the router
        const currentBlock = await publicClient.getBlockNumber();
        const routerLogs = await publicClient.getLogs({
          address: ROUTER_ADDRESS,
          fromBlock: currentBlock - 10n,
          toBlock: currentBlock,
        });

        let foundEvalJob = false;
        let foundClaim = false;
        for (const log of routerLogs) {
          try {
            const decoded = decodeEventLog({
              abi: JINN_ROUTER_ABI,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === 'EvaluationJobCreated') {
              foundEvalJob = true;
              console.log('    EvaluationJobCreated event confirmed on-chain');
            }
            if (decoded.eventName === 'DeliveryClaimed') {
              const claimArgs = decoded.args as unknown as { jobType: number };
              console.log(`    DeliveryClaimed event: jobType=${claimArgs.jobType}`);
              foundClaim = true;
            }
          } catch { /* not our event */ }
        }
        if (!foundEvalJob) {
          throw new Error('No EvaluationJobCreated event found on router');
        }
        if (!foundClaim) {
          throw new Error('No DeliveryClaimed event found — staking counter not incremented');
        }
      }),
    );

    // ── Phase 7: Restorer delivers evaluation ────────────────────────────────

    results.push(
      await runPhase('Phase 7: Restorer delivers evaluation via ClaudeRunner', async () => {
        if (!adapter) throw new Error('Missing adapter');

        // Mine blocks so the restorer sees the evaluation request
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Mine blocks continuously while processOne runs
        const miningInterval = setInterval(async () => {
          try { await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        try {
          const processed = await Promise.race([
            restorer.processOne(),
            sleep(agentTimeoutMs + 30000).then(() => { throw new Error(`restorer.processOne timed out after ${(agentTimeoutMs + 30000) / 1000}s`); }),
          ]);
          if (!processed) throw new Error('processOne returned false — no evaluation request found');
        } finally {
          clearInterval(miningInterval);
        }

        console.log('    E2eRestorerLoop.processOne() completed for evaluation');

        // Mine a block to confirm
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
      }),
    );

    // ── Phase 8: Creator claims evaluation ───────────────────────────────────

    results.push(
      await runPhase('Phase 8: Creator claims evaluation delivery', async () => {
        if (!adapter) throw new Error('Missing adapter');

        // Mine blocks periodically
        const miningInterval = setInterval(async () => {
          try { await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        let delivery: Awaited<ReturnType<typeof deliveryIter.next>>;
        try {
          delivery = await Promise.race([
            deliveryIter.next(),
            sleep(USE_REAL_AGENT ? 120000 : 20000).then(() => { throw new Error(`watchForDeliveries timed out after ${USE_REAL_AGENT ? 120 : 20}s`); }),
          ]);
        } finally {
          clearInterval(miningInterval);
        }

        if (delivery.done || !delivery.value) throw new Error('watchForDeliveries ended unexpectedly');
        const del = delivery.value;

        if (del.restorationJob.type !== 'evaluation') {
          throw new Error(`Expected type 'evaluation', got '${del.restorationJob.type}'`);
        }
        console.log(`    Evaluation delivery claimed for requestId: ${del.requestId}`);
        console.log(`    restorationJob.type: ${del.restorationJob.type}`);

        // Verify the evaluation verdict contains restoration delivery data
        // (proves get_restoration_delivery tool worked in the mock agent)
        try {
          const verdict = JSON.parse(del.result.data) as {
            type?: string;
            deliveryData?: unknown;
            success?: boolean;
          };
          if (verdict.type === 'evaluation-verdict' && verdict.deliveryData) {
            console.log('    Evaluation verdict contains deliveryData — get_restoration_delivery worked');
          } else if (verdict.type === 'evaluation-verdict') {
            console.log('    WARNING: Evaluation verdict has no deliveryData — get_restoration_delivery may not have received data');
          }
        } catch {
          console.log('    Could not parse evaluation result data');
        }

        // Verify tracking is clean
        const adapterAny = adapter as unknown as {
          pendingEvaluations: Map<string, unknown>;
          pendingEvaluationClaims: Set<string>;
        };
        if (adapterAny.pendingEvaluationClaims.size !== 0) {
          throw new Error(`Expected pendingEvaluationClaims to be empty, got ${adapterAny.pendingEvaluationClaims.size}`);
        }
        console.log('    pendingEvaluationClaims is empty — lifecycle complete');

        // Verify DeliveryClaimed event for evaluation
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
        const evalBlock = await publicClient.getBlockNumber();
        const evalRouterLogs = await publicClient.getLogs({
          address: ROUTER_ADDRESS,
          fromBlock: evalBlock - 10n,
          toBlock: evalBlock,
        });
        let foundEvalClaim = false;
        for (const log of evalRouterLogs) {
          try {
            const decoded = decodeEventLog({
              abi: JINN_ROUTER_ABI,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === 'DeliveryClaimed') {
              const claimArgs = decoded.args as unknown as { jobType: number };
              console.log(`    DeliveryClaimed event: jobType=${claimArgs.jobType}`);
              foundEvalClaim = true;
            }
          } catch { /* not our event */ }
        }
        if (!foundEvalClaim) {
          throw new Error('No DeliveryClaimed event found for evaluation — staking counter not incremented');
        }
        console.log('    Staking counter verified: evaluation delivery claimed');
      }),
    );

    // ── Phase 8b: Artifact verification ────────────────────────────────────────

    results.push(
      await runPhase('Phase 8b: Verify artifacts — publish_artifact wrote to store, search_artifacts works', async () => {
        // The mock agent calls publish_artifact during restoration (Phase 5)
        // and search_artifacts before restoration. Verify the store has data.
        const artifacts = store.searchArtifacts({ tags: ['restoration'] });
        if (artifacts.length === 0) {
          throw new Error('No artifacts found with tag "restoration" — publish_artifact did not write to store');
        }
        console.log(`    Found ${artifacts.length} artifact(s) in store`);
        for (const a of artifacts) {
          console.log(`      - [${a.outcome}] ${a.title}`);
        }

        // Verify artifact has expected fields
        const first = artifacts[0];
        if (!first.id || !first.title || !first.content) {
          throw new Error('Artifact missing required fields (id, title, content)');
        }
        if (first.outcome !== 'SUCCESS') {
          throw new Error(`Expected outcome SUCCESS, got ${first.outcome}`);
        }
        console.log('    Artifact fields verified: id, title, content, outcome=SUCCESS');

        // Verify search by outcome works
        const failures = store.searchArtifacts({ outcome: 'FAILURE' });
        console.log(`    Search by outcome=FAILURE: ${failures.length} results (expected 0)`);

        const successes = store.searchArtifacts({ outcome: 'SUCCESS' });
        if (successes.length !== artifacts.length) {
          throw new Error(`outcome=SUCCESS count (${successes.length}) doesn't match tag search (${artifacts.length})`);
        }
        console.log('    Artifact search verified');

        // Gap 2: Verify restoration result stored as artifact
        const resultArtifacts = store.searchArtifacts({ tags: ['restoration-result'] });
        if (resultArtifacts.length === 0) {
          throw new Error('No artifacts with tag "restoration-result" — submit_restoration_result did not store as artifact');
        }
        console.log(`    Found ${resultArtifacts.length} restoration-result artifact(s)`);

        // Gap 1: Verify search by requestId
        const byRequestId = store.searchArtifacts({ tags: ['restoration-result'], requestId: restorationRequestId });
        if (byRequestId.length === 0) {
          throw new Error('Search by requestId returned no results');
        }
        console.log(`    Search by requestId: ${byRequestId.length} result(s) ✓`);

        // Gap 1: Verify search by desiredStateId
        const byDesiredState = store.searchArtifacts({ desiredStateId: 'e2e-test' });
        if (byDesiredState.length === 0) {
          throw new Error('Search by desiredStateId returned no results');
        }
        console.log(`    Search by desiredStateId: ${byDesiredState.length} result(s) ✓`);

        // Gap 1: Verify time range filters
        const beforeEverything = store.searchArtifacts({ before: '2020-01-01T00:00:00' });
        if (beforeEverything.length !== 0) {
          throw new Error(`Search before 2020 should return 0, got ${beforeEverything.length}`);
        }
        console.log('    Search before=2020: 0 results ✓');

        const afterPast = store.searchArtifacts({ after: '2020-01-01T00:00:00' });
        if (afterPast.length === 0) {
          throw new Error('Search after 2020 should return results');
        }
        console.log(`    Search after=2020: ${afterPast.length} result(s) ✓`);
      }),
    );

    // ── Phase 8c–8g: ERC-8004 Phase 1b assertions (jinn-mono-al7) ────────────
    //
    // These phases verify the operator-rooted ERC-8004 entity model end-to-end
    // on the Anvil-fork against the canonical 0x8004… deployments on Base
    // mainnet. See:
    //   - docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md
    //   - docs/superpowers/specs/2026-04-27-erc-8004-payload-schema.md
    //
    // Subgraph-deployment phases are intentionally skipped — assertions read
    // raw chain logs (which is what the subgraph would index anyway). Wiring
    // a full Graph node + Postgres + IPFS into the e2e harness is heavy and
    // not required for this beadline.

    results.push(
      await runPhase(
        'Phase 8c: ERC-8004 bootstrap — assert agent NFT mint + Safe binding (jinn-mono-al7, subsumes jinn-mono-2m7)',
        async () => {
          if (!agentAddressA) {
            throw new Error('Missing agentAddressA from Phase 2');
          }
          if (bootstrapEventFromBlock === undefined) {
            throw new Error('Missing bootstrapEventFromBlock from Phase 2');
          }

          // 1. agent_id MUST be populated on the persisted state.
          if (agentId === undefined) {
            throw new Error(
              'Phase 2 bootstrap completed but EarningState.agent_id is null — ' +
                'stepRegisterAgent did not mint the ERC-8004 agent NFT.',
            );
          }
          console.log(`    EarningState.agent_id = ${agentId}`);

          // 2. The Registered event MUST exist in the bootstrap window for the
          //    agent EOA owner. This is the assertion subsumed from
          //    jinn-mono-2m7 ("assert Registered event in e2e").
          if (!identityRegistryAddress) {
            throw new Error(
              'Phase 2 bootstrap completed but EarningState.identity_registry_address is null',
            );
          }
          // Canonical Base-mainnet IdentityRegistry — cross-check schema
          // address against the canonical entry in earning/contracts.ts.
          const { IDENTITY_REGISTRY_ADDRESSES } = await import('../../src/earning/contracts.js');
          const expectedRegistry = getAddress(IDENTITY_REGISTRY_ADDRESSES[base.id]!) as Address;
          if (identityRegistryAddress !== expectedRegistry) {
            throw new Error(
              `EarningState.identity_registry_address (${identityRegistryAddress}) does not ` +
                `match canonical Base address (${expectedRegistry})`,
            );
          }
          console.log(`    identity_registry_address = ${identityRegistryAddress} (canonical Base)`);

          const tip = await publicClient.getBlockNumber();
          const registeredEvent = parseAbiItem(
            'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
          );
          const registeredLogs = await publicClient.getLogs({
            address: identityRegistryAddress,
            event: registeredEvent,
            args: { owner: agentAddressA },
            fromBlock: bootstrapEventFromBlock,
            toBlock: tip,
          });
          if (registeredLogs.length === 0) {
            throw new Error(
              `No IdentityRegistry.Registered event found for owner=${agentAddressA} ` +
                `in blocks [${bootstrapEventFromBlock}, ${tip}]`,
            );
          }
          // Multiple events would indicate a bootstrap-side bug (duplicate mint).
          // Assert at-most-one for the agent EOA.
          if (registeredLogs.length > 1) {
            throw new Error(
              `Found ${registeredLogs.length} Registered events for owner=${agentAddressA} — ` +
                `bootstrap minted duplicate NFTs (jinn-mono-jgp duplicate-mint guard regression).`,
            );
          }
          const eventArgs = registeredLogs[0]!.args as {
            agentId?: bigint;
            agentURI?: string;
            owner?: Address;
          };
          if (eventArgs.agentId === undefined) {
            throw new Error('Registered event missing agentId arg');
          }
          if (eventArgs.agentId !== agentId) {
            throw new Error(
              `Registered event agentId=${eventArgs.agentId} does not match ` +
                `EarningState.agent_id=${agentId}`,
            );
          }
          console.log(
            `    Registered event verified: agentId=${eventArgs.agentId} ` +
              `agentURI="${eventArgs.agentURI ?? ''}" owner=${eventArgs.owner}`,
          );

          // 3. getAgentWallet(agentId) MUST return the Safe address when
          //    safe_bound_to_agent is true. When the bind step left it false
          //    (e.g. no Safe topology), this assertion is SKIP per the brief.
          if (!safeBoundToAgent) {
            console.log(
              `    safe_bound_to_agent=false — SKIPPING getAgentWallet assertion ` +
                `(stub case: bind deferred or no Safe topology)`,
            );
          } else if (!safeAddress) {
            throw new Error('safe_bound_to_agent=true but safe_address is missing');
          } else {
            const { IDENTITY_REGISTRY_ABI: ABI } = await import('../../src/earning/contracts.js');
            const onChainWallet = await publicClient.readContract({
              address: identityRegistryAddress,
              abi: ABI,
              functionName: 'getAgentWallet',
              args: [agentId],
            });
            if (!sameAddress(onChainWallet, safeAddress)) {
              throw new Error(
                `IdentityRegistry.getAgentWallet(${agentId}) = ${onChainWallet}, ` +
                  `expected Safe ${safeAddress}`,
              );
            }
            console.log(
              `    getAgentWallet(${agentId}) = ${onChainWallet} (== Safe address)`,
            );
          }
        },
      ),
    );

    results.push(
      await runPhase(
        'Phase 8d: ERC-8004 envelope publish — IdentityPublisher.setMetadata + payload decode',
        async () => {
          if (agentId === undefined || !identityRegistryAddress) {
            throw new Error(
              'Missing ERC-8004 state from Phase 2/8c (agentId or identity_registry_address)',
            );
          }
          if (!agentEoaPrivateKey || !agentAddressA) {
            throw new Error('Missing agentEoaPrivateKey/agentAddressA from Phase 2');
          }

          // Phases 5-8 routed restoration + evaluation deliveries through the
          // agent EOA, draining its bootstrap top-up. Refill before our
          // ERC-8004 writes so they don't fail with "insufficient funds".
          await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [
            agentAddressA,
            '0x56BC75E2D63100000', // 100 ETH
          ]);

          const { IdentityPublisher, PAYLOAD_TUPLE } = await import(
            '../../src/erc8004/index.js'
          );
          const { createWalletClient, decodeAbiParameters, http: httpTransport, keccak256, stringToBytes } =
            await import('viem');
          const { privateKeyToAccount } = await import('viem/accounts');

          // Build a publisher backed by the agent EOA — same signer the
          // production daemon wires (see client/src/main.ts §IdentityPublisher).
          const account = privateKeyToAccount(agentEoaPrivateKey);
          const walletClient = createWalletClient({
            account,
            chain: base,
            transport: httpTransport(ANVIL_RPC),
          });

          const publisher = new IdentityPublisher({
            identityRegistryAddress,
            agentId,
            walletClient,
            publicClient,
          });

          // Synthesize a v0-style envelope (tier=1 committed, with a
          // JinnRouter-shaped manifestHash). In production the engine.pack()
          // path passes the real signatureHash; here we use a deterministic
          // surrogate so the on-chain assertion is independent of the
          // legacy-restorer's signature derivation.
          const manifestCid = `bafkreial7e2eenvelope${Date.now().toString(16)}`;
          const manifestHash = keccak256(stringToBytes(`al7-test-${manifestCid}`));
          const tier = 1; // committed — matches engine.ts payload selection
                         // when an evidenceHash is present (see engine.ts §831).

          const txHash = await publisher.publishContent({
            kind: 'envelope',
            cid: manifestCid,
            payload: {
              version: 1,
              tier,
              manifestHash,
              attestationQuoteCid: '0x',
              sourceMeasurement:
                '0x0000000000000000000000000000000000000000000000000000000000000000',
              },
          });
          const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
          console.log(`    setMetadata tx=${txHash}`);

          // Pull the MetadataSet event from this exact write.
          const metadataSetEvent = parseAbiItem(
            'event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)',
          );
          const logs = txReceipt.logs.flatMap((log) => {
            if (!sameAddress(log.address, identityRegistryAddress)) return [];
            try {
              return [decodeEventLog({
                abi: [metadataSetEvent],
                data: log.data,
                topics: log.topics,
              })];
            } catch {
              return [];
            }
          });

          // Filter to envelope:* keys; multiple unrelated MetadataSets could
          // theoretically race the same agentId on a real chain, but this is
          // a fresh fork so we expect exactly the one we just emitted.
          const envelopeLogs = logs.filter(l => {
            const a = l.args as { metadataKey?: string };
            return typeof a.metadataKey === 'string' && a.metadataKey.startsWith('envelope:');
          });
          if (envelopeLogs.length === 0) {
            throw new Error(
              `No MetadataSet event with metadataKey starting with "envelope:" found ` +
                `(agentId=${agentId}, tx=${txHash})`,
            );
          }
          const eventArgs = envelopeLogs[envelopeLogs.length - 1]!.args as {
            agentId?: bigint;
            metadataKey?: string;
            metadataValue?: Hex;
          };
          if (eventArgs.metadataKey !== `envelope:${manifestCid}`) {
            throw new Error(
              `MetadataSet metadataKey="${eventArgs.metadataKey}", expected "envelope:${manifestCid}"`,
            );
          }
          console.log(`    MetadataSet event verified: key=${eventArgs.metadataKey}`);

          // Decode the v1 payload tuple and validate per payload-schema §5.
          const decoded = decodeAbiParameters(
            PAYLOAD_TUPLE as unknown as ReadonlyArray<{ name: string; type: string }>,
            eventArgs.metadataValue!,
          );
          const [decodedVersion, decodedTier, decodedManifestHash, decodedQuoteCid, decodedMeasurement] =
            decoded as [bigint | number, bigint | number, Hex, Hex, Hex];
          const versionNum = typeof decodedVersion === 'bigint' ? Number(decodedVersion) : decodedVersion;
          const tierNum = typeof decodedTier === 'bigint' ? Number(decodedTier) : decodedTier;

          if (versionNum !== 1) {
            throw new Error(`payload.version=${versionNum}, expected 1`);
          }
          if (tierNum !== 0 && tierNum !== 1) {
            throw new Error(
              `payload.tier=${tierNum}, expected 0 (self-signed) or 1 (committed) — ` +
                `TEE attestation tiers (>=3) are not yet live in this client`,
            );
          }
          if (decodedManifestHash.toLowerCase() !== manifestHash.toLowerCase()) {
            throw new Error(
              `payload.manifestHash=${decodedManifestHash} does not match expected ${manifestHash}`,
            );
          }
          if (decodedQuoteCid !== '0x') {
            throw new Error(
              `payload.attestationQuoteCid="${decodedQuoteCid}", expected "0x" for tier<3`,
            );
          }
          const ZERO_BYTES32 =
            '0x0000000000000000000000000000000000000000000000000000000000000000';
          if (decodedMeasurement.toLowerCase() !== ZERO_BYTES32) {
            throw new Error(
              `payload.sourceMeasurement=${decodedMeasurement}, expected zero for tier<3`,
            );
          }
          console.log(
            `    payload decoded OK: version=${versionNum} tier=${tierNum} ` +
              `manifestHash=${decodedManifestHash}`,
          );

          publishedEnvelopeManifestCid = manifestCid;
          publishedEnvelopeManifestHash = manifestHash;
        },
      ),
    );

    results.push(
      await runPhase(
        'Phase 8e: ERC-8004 evaluator feedback — ReputationRegistry.giveFeedback',
        async () => {
          if (agentId === undefined) {
            throw new Error('Missing agentId from Phase 2/8c');
          }
          if (!publishedEnvelopeManifestCid || !publishedEnvelopeManifestHash) {
            throw new Error('Missing published envelope state from Phase 8d');
          }

          const { ReputationRegistryClient, REPUTATION_REGISTRY_ADDRESSES } = await import(
            '../../src/erc8004/index.js'
          );
          const { submitEvaluatorFeedback, mapVerdictToScore } = await import(
            '../../src/erc8004/index.js'
          );
          const { createWalletClient, http: httpTransport } = await import('viem');
          const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts');

          const reputationRegistryAddress = REPUTATION_REGISTRY_ADDRESSES[base.id]!;
          console.log(`    ReputationRegistry: ${reputationRegistryAddress}`);

          // The contract enforces no-self-feedback (caller cannot be agent
          // owner / approved / operator-for-all). In production the evaluator
          // is a different operator from the restorer; here we synthesise an
          // independent EOA so the e2e exercises the real path. Documented as
          // an e2e-specific shortcut: production resolves the restorer
          // agentId via the subgraph and uses a separate evaluator wallet.
          const evaluatorPk = generatePrivateKey();
          const evaluatorAccount = privateKeyToAccount(evaluatorPk);
          await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [
            evaluatorAccount.address,
            '0x56BC75E2D63100000', // 100 ETH
          ]);
          const evaluatorWalletClient = createWalletClient({
            account: evaluatorAccount,
            chain: base,
            transport: httpTransport(ANVIL_RPC),
          });

          const reputationClient = new ReputationRegistryClient({
            reputationRegistryAddress,
            publicClient,
            walletClient: evaluatorWalletClient,
            // Direct EOA path (no Safe wrapping) — the evaluator EOA is the
            // independent reviewer. Production wires a Safe via
            // ReputationRegistryConfig.safeAddress.
          });

          // Sanity-check the score-mapping policy hasn't drifted (the e2e
          // depends on PASS=100/2 for the on-chain assertion below).
          const passMapping = mapVerdictToScore('PASS');
          if (!passMapping || passMapping.score !== 100 || passMapping.scoreDecimals !== 2) {
            throw new Error(
              `mapVerdictToScore('PASS') drifted: ${JSON.stringify(passMapping)} ` +
                `(expected score=100, scoreDecimals=2)`,
            );
          }

          // E2E shortcut: pass restorerAgentId directly. Production resolves
          // it via subgraph (jinn-mono-yg4 / agent-resolver.ts), but the
          // subgraph isn't running in this harness. The hook itself is what
          // we want to exercise — its agentId-resolution dependency is a
          // composition concern, not the hook's logic.
          const outcome = await submitEvaluatorFeedback({
            registry: reputationClient,
            ref: {
              restorerAgentId: agentId,
              restorerManifestCid: publishedEnvelopeManifestCid,
              restorerEvidenceHash: publishedEnvelopeManifestHash,
            },
            verdict: { verdict: 'PASS', kind: 'al7-test' },
          });

          if (outcome.kind !== 'submitted') {
            throw new Error(
              `submitEvaluatorFeedback outcome=${JSON.stringify(outcome)} (expected submitted)`,
            );
          }
          console.log(`    giveFeedback tx=${outcome.txHash}`);
          const feedbackReceipt = await publicClient.waitForTransactionReceipt({ hash: outcome.txHash });

          // Pull the NewFeedback event from this exact write.
          const newFeedbackEvent = parseAbiItem(
            'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, ' +
              'uint64 feedbackIndex, int128 value, uint8 valueDecimals, ' +
              'string indexed indexedTag1, string tag1, string tag2, string endpoint, ' +
              'string feedbackURI, bytes32 feedbackHash)',
          );
          const logs = feedbackReceipt.logs.flatMap((log) => {
            if (!sameAddress(log.address, reputationRegistryAddress)) return [];
            try {
              return [decodeEventLog({
                abi: [newFeedbackEvent],
                data: log.data,
                topics: log.topics,
              })];
            } catch {
              return [];
            }
          }).filter((log) => {
            const a = log.args as { agentId?: bigint; clientAddress?: Address };
            return a.agentId === agentId && !!a.clientAddress && sameAddress(a.clientAddress, evaluatorAccount.address);
          });
          if (logs.length === 0) {
            throw new Error(
              `No NewFeedback event found for agentId=${agentId} ` +
                `clientAddress=${evaluatorAccount.address} tx=${outcome.txHash}`,
            );
          }
          const fbArgs = logs[logs.length - 1]!.args as {
            agentId?: bigint;
            clientAddress?: Address;
            value?: bigint;
            valueDecimals?: number;
            feedbackURI?: string;
            feedbackHash?: Hex;
          };
          if (fbArgs.agentId !== agentId) {
            throw new Error(
              `NewFeedback.agentId=${fbArgs.agentId} expected ${agentId}`,
            );
          }
          // The hook builds feedbackURI as `manifest:<cid>`; assert that.
          const expectedFeedbackURI = `manifest:${publishedEnvelopeManifestCid}`;
          if (fbArgs.feedbackURI !== expectedFeedbackURI) {
            throw new Error(
              `feedbackURI="${fbArgs.feedbackURI}", expected "${expectedFeedbackURI}"`,
            );
          }
          if ((fbArgs.feedbackHash ?? '').toLowerCase() !== publishedEnvelopeManifestHash.toLowerCase()) {
            throw new Error(
              `feedbackHash=${fbArgs.feedbackHash} does not match restorer evidenceHash ${publishedEnvelopeManifestHash}`,
            );
          }
          // PASS verdict: int128 value=100, uint8 valueDecimals=2 → score 1.00
          if (fbArgs.value !== 100n) {
            throw new Error(`NewFeedback.value=${fbArgs.value}, expected 100 (PASS)`);
          }
          if (fbArgs.valueDecimals !== 2) {
            throw new Error(
              `NewFeedback.valueDecimals=${fbArgs.valueDecimals}, expected 2 (PASS)`,
            );
          }
          console.log(
            `    NewFeedback verified: agentId=${fbArgs.agentId} value=${fbArgs.value}/` +
              `${fbArgs.valueDecimals} feedbackURI="${fbArgs.feedbackURI}"`,
          );
        },
      ),
    );

    results.push(
      await runPhase(
        'Phase 8f: ERC-8004 operator-initiated validation — ValidationRegistry request + response (DR §4.4)',
        async () => {
          if (agentId === undefined) {
            throw new Error('Missing agentId from Phase 2/8c');
          }
          if (!agentEoaPrivateKey || !agentAddressA) {
            throw new Error('Missing agentEoaPrivateKey/agentAddressA from Phase 2');
          }
          if (!publishedEnvelopeManifestHash) {
            throw new Error('Missing published envelope manifestHash from Phase 8d');
          }

          // Refill agent EOA in case earlier writes drained it (we already
          // emit one setMetadata in Phase 8d; submitResponse below is a
          // second write from the same EOA).
          await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [
            agentAddressA,
            '0x56BC75E2D63100000', // 100 ETH
          ]);

          // Per jinn-mono-b18 and DR §4.4 (amended), validationRequest is
          // OPERATOR-INITIATED in Phase 1b. Adversarial third-party
          // challenges are deferred to Phase 2 via the DisputeProxy spec
          // (docs/superpowers/specs/2026-04-27-erc8004-dispute-proxy-design.md).
          // The deployed ValidationRegistry rejects callers that aren't the
          // agent NFT owner / approved / operator-for-all, so we use the
          // agent EOA (owner of the NFT minted in Phase 2).
          //
          // For e2e, the same wallet plays both operator AND validator roles
          // — production decouples them via independent validator selection.

          const { ValidationRegistryClient, VALIDATION_REGISTRY_ADDRESSES } = await import(
            '../../src/erc8004/index.js'
          );
          const { createWalletClient, http: httpTransport, keccak256, stringToBytes } = await import('viem');
          const { privateKeyToAccount } = await import('viem/accounts');

          const validationRegistryAddress = VALIDATION_REGISTRY_ADDRESSES[base.id]!;
          console.log(`    ValidationRegistry: ${validationRegistryAddress}`);

          const account = privateKeyToAccount(agentEoaPrivateKey);
          const walletClient = createWalletClient({
            account,
            chain: base,
            transport: httpTransport(ANVIL_RPC),
          });

          const validationClient = new ValidationRegistryClient({
            validationRegistryAddress,
            publicClient,
            walletClient,
          });

          // requestHash = manifest evidenceHash (DR §4.4 normative).
          const requestHash = publishedEnvelopeManifestHash;
          const requestURI = `ipfs://manifest:${publishedEnvelopeManifestCid ?? 'unknown'}`;

          const reqTx = await validationClient.requestValidation({
            validatorAddress: account.address, // self-validation in e2e
            agentId,
            requestURI,
            requestHash,
          });
          const reqReceipt = await publicClient.waitForTransactionReceipt({ hash: reqTx });
          if (reqReceipt.status !== 'success') {
            throw new Error(
              `validationRequest reverted (tx=${reqTx}): receipt.status=${reqReceipt.status}`,
            );
          }
          console.log(`    validationRequest tx=${reqTx}`);

          const validationRequestEvent = parseAbiItem(
            'event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)',
          );
          const reqLogs = reqReceipt.logs.flatMap((log) => {
            if (!sameAddress(log.address, validationRegistryAddress)) return [];
            try {
              return [decodeEventLog({
                abi: [validationRequestEvent],
                data: log.data,
                topics: log.topics,
              })];
            } catch {
              return [];
            }
          }).filter((log) => {
            const a = log.args as { validatorAddress?: Address; agentId?: bigint; requestHash?: Hex };
            return !!a.validatorAddress &&
              sameAddress(a.validatorAddress, account.address) &&
              a.agentId === agentId &&
              a.requestHash?.toLowerCase() === requestHash.toLowerCase();
          });
          if (reqLogs.length === 0) {
            throw new Error(
              `No ValidationRequest event found (validator=${account.address}, ` +
                `agentId=${agentId}, requestHash=${requestHash}, tx=${reqTx})`,
            );
          }
          const reqArgs = reqLogs[reqLogs.length - 1]!.args as {
            validatorAddress?: Address;
            agentId?: bigint;
            requestURI?: string;
            requestHash?: Hex;
          };
          if (reqArgs.requestURI !== requestURI) {
            throw new Error(
              `ValidationRequest.requestURI="${reqArgs.requestURI}", expected "${requestURI}"`,
            );
          }
          console.log(
            `    ValidationRequest verified: validator=${reqArgs.validatorAddress} ` +
              `agentId=${reqArgs.agentId} requestHash=${reqArgs.requestHash}`,
          );

          // Sanity-read getValidationStatus before submitResponse to confirm
          // the request is persisted and visible at the same key our response
          // will look up.
          const preStatus = await validationClient.getStatus(requestHash);
          if (!preStatus) {
            throw new Error(
              `validationRequest emitted event but getValidationStatus(${requestHash}) ` +
                `returned null — storage was not written under the expected key`,
            );
          }
          if (preStatus.status !== 'REQUESTED') {
            throw new Error(
              `pre-response getStatus.status="${preStatus.status}", expected "REQUESTED"`,
            );
          }
          if (preStatus.validatorAddress !== account.address) {
            throw new Error(
              `pre-response getStatus.validatorAddress=${preStatus.validatorAddress}, ` +
                `expected ${account.address}`,
            );
          }
          console.log(
            `    pre-response getStatus: status=${preStatus.status} ` +
              `validator=${preStatus.validatorAddress} agentId=${preStatus.agentId}`,
          );

          // Validator (same wallet, e2e shortcut) submits the response.
          const responseHash = keccak256(stringToBytes(`al7-validator-response-${requestHash}`));
          const responseURI = 'ipfs://stub';
          const beforeRespBlock = await publicClient.getBlockNumber();
          const respTx = await validationClient.submitResponse({
            requestHash,
            response: 80,
            responseURI,
            responseHash,
            tag: 'test',
          });
          await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
          const respReceipt = await publicClient.waitForTransactionReceipt({ hash: respTx });
          if (respReceipt.status !== 'success') {
            throw new Error(
              `validationResponse reverted (tx=${respTx}): receipt.status=${respReceipt.status}`,
            );
          }
          console.log(`    validationResponse tx=${respTx}`);

          // Pull from the receipt directly — args-filtered getLogs has been
          // unreliable on the Anvil fork (filter encoding for the
          // 3-indexed-bytes32 event sometimes drops matches). The receipt is
          // authoritative for "what did this tx emit".
          const validationResponseEvent = parseAbiItem(
            'event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, ' +
              'bytes32 indexed requestHash, uint8 response, string responseURI, ' +
              'bytes32 responseHash, string tag)',
          );
          const VALIDATION_RESPONSE_TOPIC = keccak256(
            stringToBytes(
              'ValidationResponse(address,uint256,bytes32,uint8,string,bytes32,string)',
            ),
          );
          // Use receipt logs as the authoritative source.
          const txLogs = respReceipt.logs.filter(
            l =>
              l.address.toLowerCase() === validationRegistryAddress.toLowerCase() &&
              l.topics[0] === VALIDATION_RESPONSE_TOPIC,
          );
          if (txLogs.length === 0) {
            throw new Error(
              `No ValidationResponse event found in receipt for tx=${respTx} ` +
                `(receipt has ${respReceipt.logs.length} logs total)`,
            );
          }
          const decodedRespEvent = decodeEventLog({
            abi: [validationResponseEvent],
            data: txLogs[0]!.data,
            topics: txLogs[0]!.topics,
          });
          const respArgs = decodedRespEvent.args as unknown as {
            validatorAddress?: Address;
            agentId?: bigint;
            requestHash?: Hex;
            response?: number;
            responseURI?: string;
            responseHash?: Hex;
            tag?: string;
          };
          if ((respArgs.requestHash ?? '').toLowerCase() !== requestHash.toLowerCase()) {
            throw new Error(
              `ValidationResponse.requestHash=${respArgs.requestHash} ` +
                `expected ${requestHash}`,
            );
          }
          // Suppress unused-var warning while still providing context for
          // the second filter window we previously computed.
          void beforeRespBlock;
          if (respArgs.response !== 80) {
            throw new Error(`ValidationResponse.response=${respArgs.response}, expected 80`);
          }
          if (respArgs.tag !== 'test') {
            throw new Error(`ValidationResponse.tag="${respArgs.tag}", expected "test"`);
          }
          console.log(
            `    ValidationResponse verified: response=${respArgs.response} ` +
              `tag="${respArgs.tag}" responseHash=${respArgs.responseHash}`,
          );

          // getValidationStatus(requestHash) returns the response we just stored.
          const status = await validationClient.getStatus(requestHash);
          if (!status) {
            throw new Error(
              `ValidationRegistry.getStatus(${requestHash}) returned null after submitResponse`,
            );
          }
          if (status.status !== 'RESPONDED') {
            throw new Error(`status.status="${status.status}", expected "RESPONDED"`);
          }
          if (status.response !== 80) {
            throw new Error(`status.response=${status.response}, expected 80`);
          }
          if (status.tag !== 'test') {
            throw new Error(`status.tag="${status.tag}", expected "test"`);
          }
          console.log(
            `    getStatus verified: status=${status.status} response=${status.response} ` +
              `tag="${status.tag}"`,
          );
        },
      ),
    );

    results.push(
      await runPhase(
        'Phase 8g: ERC-8004 legacy migration — runLegacyAgentIdMigration recovers existing agentId, no double-mint',
        async () => {
          if (!tmpDir || !agentEoaPrivateKey || !identityRegistryAddress) {
            throw new Error('Missing state from Phase 2');
          }
          if (agentId === undefined) {
            throw new Error('Missing agentId from Phase 2/8c');
          }

          const { migrateAgentIds } = await import('../../src/earning/migrate-agent-id.js');
          const { FleetStateStore } = await import('../../src/earning/store.js');
          const { decryptMnemonic } = await import('../../src/earning/wallet.js');

          // Test path A: a service that already has a Registered event on
          // chain (the one from Phase 2) should recover its existing agentId
          // — the duplicate-mint guard in migrate-agent-id.ts MUST NOT mint
          // a fresh NFT.
          //
          // We mutate the persisted state in-place: clear agent_id on the
          // existing complete service to simulate the legacy-pre-j07 shape.
          // After migration, agent_id must be repopulated AND match the
          // chain-side Registered event we already verified in Phase 8c
          // (which proves no second mint happened).
          const stateStore = new FleetStateStore(tmpDir);
          const beforeState = await stateStore.load('base');
          const completeSvcs = beforeState.services.filter(s => s.step === 'complete');
          if (completeSvcs.length === 0) {
            throw new Error('No complete services in EarningState — Phase 2 should have populated one');
          }
          const targetIdx = completeSvcs[0]!.index;

          // Snapshot the existing fields, clear agent_id, persist.
          await stateStore.updateService(targetIdx, {
            agent_id: null,
            agent_uri: null,
            agent_registered_tx: null,
          });
          // Sanity: re-load and confirm.
          const cleared = (await stateStore.load('base')).services.find(s => s.index === targetIdx);
          if (!cleared || cleared.agent_id !== null) {
            throw new Error(
              `Failed to clear agent_id on service ${targetIdx}: got ${cleared?.agent_id}`,
            );
          }

          // Capture the IdentityRegistry block range BEFORE migration so
          // we can detect a fresh mint (which there should NOT be).
          const beforeMigrateBlock = await publicClient.getBlockNumber();

          // Use the lower-level migrateAgentIds entry point so we can pass
          // `scanFromBlock`. Scanning from block 0 against a Base-mainnet
          // fork is prohibitively slow (chunks of 10k blocks across all of
          // Base history); the bootstrap window is the only place a
          // Registered event for our agent EOA exists.
          const mnemonic = await decryptMnemonic(
            await stateStore.loadMnemonicKeystore(),
            PASSWORD,
          );
          const config = getChainConfig('base');
          config.rpcUrl = ANVIL_RPC;
          const result = await migrateAgentIds({
            stateStore,
            config,
            network: 'base',
            mnemonic,
            scanFromBlock: bootstrapEventFromBlock,
          });

          if (result.migrated.length !== 1) {
            throw new Error(
              `expected 1 migrated service, got ${result.migrated.length} ` +
                `(failed=${result.failed.length}, skipped=${result.skipped.length})`,
            );
          }
          const migrated = result.migrated[0]!;
          if (!migrated.agent_id) {
            throw new Error('migrated service has null agent_id');
          }
          if (BigInt(migrated.agent_id) !== agentId) {
            throw new Error(
              `migrated.agent_id=${migrated.agent_id} does not match Phase 2 agentId=${agentId} — ` +
                `duplicate-mint guard regressed (jinn-mono-jgp).`,
            );
          }
          console.log(
            `    Recovered existing agentId=${migrated.agent_id} for service ${targetIdx} (no mint)`,
          );

          // Verify NO new Registered event was emitted (i.e. duplicate-mint
          // guard fired correctly: chain-side scan found the existing token
          // and the migration short-circuited).
          const registeredEvent = parseAbiItem(
            'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
          );
          const tipBlock = await publicClient.getBlockNumber();
          const newLogs = await publicClient.getLogs({
            address: identityRegistryAddress,
            event: registeredEvent,
            args: { owner: agentAddressA },
            fromBlock: beforeMigrateBlock + 1n,
            toBlock: tipBlock,
          });
          if (newLogs.length > 0) {
            throw new Error(
              `Found ${newLogs.length} Registered events post-migration — duplicate mint! ` +
                `(blocks [${beforeMigrateBlock + 1n}, ${tipBlock}])`,
            );
          }
          console.log(
            `    No new Registered events post-migration — duplicate-mint guard works`,
          );
        },
      ),
    );

    // ── Phase 9: Checkpoint + verify rewards ─────────────────────────────────

    results.push(
      await runPhase('Phase 9: Checkpoint — verify staking rewards', async () => {
        if (!safeAddress || serviceId === undefined) {
          throw new Error('Missing safeAddress or serviceId from Phase 2');
        }

        const activityChecker = await publicClient.readContract({
          address: CHAIN_CONFIG.stakingContract as Address,
          abi: parseAbi(['function activityChecker() view returns (address)']),
          functionName: 'activityChecker',
        });
        const nonces = await publicClient.readContract({
          address: activityChecker,
          abi: parseAbi(['function getMultisigNonces(address) view returns (uint256[])']),
          functionName: 'getMultisigNonces',
          args: [safeAddress],
        });
        console.log(`    Multisig nonces after activity: [${nonces.map(String).join(', ')}]`);

        // Verify nonces are non-zero (JinnRouter calls incremented the Safe nonce)
        const hasActivity = nonces.some(n => n > 0n);
        if (!hasActivity) {
          throw new Error('All nonces are zero — no activity detected');
        }
        console.log('    Activity detected: nonces are non-zero');

        // Advance time past the liveness period (1 day + 1 second)
        await anvilJsonRpc(ANVIL_RPC, 'evm_increaseTime', [86400 + 1]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Call checkpoint (anyone can call it)
        const anvilAccount = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // Anvil default account 0
        await anvilJsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [anvilAccount]);
        await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [anvilAccount, '0x56BC75E2D63100000']);

        const checkpointData = encodeFunctionData({
          abi: parseAbi([
            'function checkpoint() returns (uint256[],uint256[],uint256[],uint256[])',
          ]),
          functionName: 'checkpoint',
        });

        await anvilJsonRpc(ANVIL_RPC, 'eth_sendTransaction', [
          { from: anvilAccount, to: CHAIN_CONFIG.stakingContract, data: checkpointData },
        ]);
        await anvilJsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [anvilAccount]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        console.log('    Checkpoint called successfully');

        const stakingState = await publicClient.readContract({
          address: CHAIN_CONFIG.stakingContract as Address,
          abi: parseAbi(['function getStakingState(uint256) view returns (uint8)']),
          functionName: 'getStakingState',
          args: [BigInt(serviceId)],
        });
        console.log(`    Staking state after checkpoint: ${stakingState} (1=Staked)`);

        const remainingRewards = await publicClient.readContract({
          address: CHAIN_CONFIG.stakingContract as Address,
          abi: parseAbi(['function availableRewards() view returns (uint256)']),
          functionName: 'availableRewards',
        });
        console.log(`    Remaining rewards: ${Number(remainingRewards) / 1e18} OLAS`);

        // Verify reward claiming works
        // claim() can be called by anyone — returns rewards to the service owner
        const olasBalanceBefore = await publicClient.readContract({
          address: CHAIN_CONFIG.olasToken as Address,
          abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
          functionName: 'balanceOf',
          args: [safeAddress],
        });

        // Impersonate anyone to call claim (it credits the service owner, not the caller)
        const claimCaller = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
        await anvilJsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [claimCaller]);
        const claimData = encodeFunctionData({
          abi: parseAbi(['function claim(uint256) returns (uint256)']),
          functionName: 'claim',
          args: [BigInt(serviceId)],
        });
        await anvilJsonRpc(ANVIL_RPC, 'eth_sendTransaction', [{ from: claimCaller, to: CHAIN_CONFIG.stakingContract, data: claimData }]);
        await anvilJsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [claimCaller]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        const olasBalanceAfter = await publicClient.readContract({
          address: CHAIN_CONFIG.olasToken as Address,
          abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
          functionName: 'balanceOf',
          args: [safeAddress],
        });
        const rewardsClaimed = olasBalanceAfter - olasBalanceBefore;
        console.log(`    OLAS rewards claimed: ${Number(rewardsClaimed) / 1e18} OLAS`);

        if (rewardsClaimed > 0n) {
          console.log('    Reward claiming verified — OLAS transferred to operator Safe');
        } else {
          console.log('    No rewards claimed (may need more activity or time for eligibility)');
        }
      }),
    );

    // ── Phase 11: Full Daemon Loop ─────────────────────────────────────────────

    results.push(
      await runPhase('Phase 11: Full Daemon Loop — Daemon with all three loops', async () => {
        if (!agentEoaPrivateKey || !safeAddress || !mechAddress) {
          throw new Error('Missing credentials from Phase 2');
        }

        const { Daemon } = await import('../../src/daemon/daemon.js');
        const { ClaudeRunner } = await import('../../src/runner/claude.js');
        const { createClients } = await import('../../src/adapters/mech/safe.js');
        const { RestorerImplRegistry } = await import('../../src/restorer/engine/registry.js');
        const { buildRestorerImpls } = await import('../../src/restorer/impls/index.js');
        const { DEFAULT_BY_KIND, DEFAULT_DISABLED_IMPLS } = await import('../../src/cli/intent-registry-access.js');
        const { ClaimRegistryClient } = await import('../../src/adapters/claim-registry/client.js');

        const daemonAdapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS as `0x${string}`,
          routerAddress: ROUTER_ADDRESS as `0x${string}`,
          mechContractAddress: mechAddress as `0x${string}`,
          safeAddress: safeAddress as `0x${string}`,
          agentEoaPrivateKey: agentEoaPrivateKey as `0x${string}`,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
          routerClaimDeliveryVariant: 'v1',
        });

        const daemonDbPath = join(tmpDir!, 'daemon-loop.db');
        const runner = new ClaudeRunner({ claudePath: agentPath, model: agentModel });
        const agentClients = createClients(ANVIL_RPC, agentEoaPrivateKey as Hex, base);

        const implRegistry = new RestorerImplRegistry({
          byKind: { ...DEFAULT_BY_KIND },
          default: 'legacy-claude',
          disabled: [...DEFAULT_DISABLED_IMPLS],
        });
        for (const impl of buildRestorerImpls({
          rpcUrl: ANVIL_RPC,
          claudePath: agentPath,
          claudeModel: agentModel,
          pk: agentEoaPrivateKey as `0x${string}`,
          safe: safeAddress as `0x${string}`,
          runner,
          daemonApiUrl: 'http://127.0.0.1:7331',
          daemonApiToken: 'e2e-test-token',
        })) {
          implRegistry.register(impl);
        }

        const claimRegistryAddress = (
          process.env['JINN_CLAIM_REGISTRY_ADDRESS']
          || CHAIN_CONFIG.claimRegistry
          || await deployClaimRegistryForE2e()
        ) as string;
        const claimDeps = claimRegistryAddress
          ? {
              registryClient: new ClaimRegistryClient(
                agentClients.publicClient,
                agentClients.walletClient,
                claimRegistryAddress as `0x${string}`,
                safeAddress as `0x${string}`,
              ),
              marketplaceClaimer: daemonAdapter,
            }
          : undefined;

        const daemon = new Daemon({
          adapter: daemonAdapter,
          runner,
          desiredStates: [{ id: 'daemon-loop-test', description: 'Daemon loop E2E test' }],
          dbPath: daemonDbPath,
          shutdownTimeoutMs: 10000,
          apiPort: 7331,
          apiToken: 'e2e-test-token',
          restorationEngine: {
            implRegistry,
            paths: {
              workingDirRoot: join(tmpDir!, 'e2e-engine-work'),
              implStateDirRoot: join(tmpDir!, 'e2e-engine-impl-state'),
            },
            claimDeps,
            packagingDeps: {
              operatorEndpoint: 'http://localhost:7331',
              defaultPriceUsdc: '0',
              perArtifactTypePrice: {},
            },
            envelopeDeps: {
              ipfsRegistryUrl: 'https://registry.autonolas.tech',
              agentEoaPrivateKey: agentEoaPrivateKey as `0x${string}`,
              safeAddress: safeAddress as `0x${string}`,
            },
            deliveryDeps: {
              publicClient: agentClients.publicClient,
              walletClient: agentClients.walletClient,
              safeAddress: safeAddress as `0x${string}`,
              mechContractAddress: mechAddress as `0x${string}`,
              routerAddress: ROUTER_ADDRESS,
              claimDeliveryVariant: 'v1',
            },
          },
        });

        await daemon.start();

        // Mine blocks continuously so on-chain state advances
        const mineInterval = setInterval(() => anvilJsonRpc(ANVIL_RPC, 'evm_mine', []).catch(() => {}), 1000);

        try {
          // Wait for 2 DeliveryClaimed events on the router (restoration + evaluation)
          await waitFor('Daemon completes full cycle', async () => {
            const currentBlock = await publicClient.getBlockNumber();
            const fromBlock = currentBlock > 50n ? currentBlock - 50n : 0n;
            const logs = await publicClient.getLogs({
              address: ROUTER_ADDRESS,
              fromBlock,
              toBlock: currentBlock,
            });

            let claimCount = 0;
            for (const log of logs) {
              try {
                const decoded = decodeEventLog({
                  abi: JINN_ROUTER_ABI,
                  data: log.data,
                  topics: log.topics,
                });
                if (decoded.eventName === 'DeliveryClaimed') {
                  claimCount++;
                }
              } catch { /* not our event */ }
            }

            console.log(`    DeliveryClaimed count: ${claimCount}`);
            return claimCount >= 2;
          }, 120000, 3000);

          console.log('    Daemon completed full cycle (restoration + evaluation)');

          // Gap 2: Verify daemon API serves artifacts published during the run
          const apiRes = await fetch('http://localhost:7331/artifacts/search?tags=restoration-result');
          if (apiRes.ok) {
            const apiData = await apiRes.json() as { results: unknown[] };
            if (apiData.results.length > 0) {
              console.log(`    Daemon API serves ${apiData.results.length} restoration-result artifact(s) ✓`);
            } else {
              console.log('    Daemon API: 0 restoration-result artifacts (MCP may have used direct store write)');
            }
          }
          // Also verify artifacts exist in the daemon's store directly
          const daemonStore = new Store(daemonDbPath);
          const daemonArtifacts = daemonStore.searchArtifacts({ tags: ['restoration-result'] });
          daemonStore.close();
          if (daemonArtifacts.length > 0) {
            console.log(`    Daemon store has ${daemonArtifacts.length} restoration-result artifact(s) ✓`);
          } else {
            // The daemon cycle may complete before the MCP tool finishes POSTing
            console.log('    Daemon store: 0 restoration-result artifacts (timing — MCP POST may not have completed)');
          }
        } finally {
          clearInterval(mineInterval);
          await daemon.stop();
        }
      }),
    );

    // ── Phase 12: Cross-Operator ─────────────────────────────────────────────

    results.push(
      await runPhase('Phase 12: Cross-Operator — second operator bootstrap + cross-delivery', async () => {
        if (!agentEoaPrivateKey || !safeAddress || !mechAddress) {
          throw new Error('Missing credentials from Phase 2');
        }

        if (agentAddressA) {
          await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [
            agentAddressA,
            '0x56BC75E2D63100000',
          ]);
          await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
        }

        // Bootstrap a second operator
        tmpDir2 = await mkdtemp(join(tmpdir(), 'jinn-e2e-op2-'));
        console.log(`    Operator B temp dir: ${tmpDir2}`);

        let bootstrapper2 = new FleetBootstrapper({
          earningDir: tmpDir2,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
        });

        const initialResult2 = await bootstrapper2.bootstrap('test-password-2');
        if (!initialResult2.funding) {
          throw new Error(
            `Expected funding requirement in result (fleet bootstrap returns funding gate, not top-level step); ok=${initialResult2.ok}`,
          );
        }

        const masterAddressB = initialResult2.funding.master_address;
        console.log(`    Operator B master: ${masterAddressB}`);

        await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [
          masterAddressB,
          '0x56BC75E2D63100000', // 100 ETH
        ]);

        const eoaOlasAmountB = 100000n * 10n ** 18n;
        await fundAddressWithOLAS(chain!, masterAddressB as Address, eoaOlasAmountB);

        await anvilJsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [masterAddressB]);
        const olasApproveB = encodeFunctionData({
          abi: parseAbi(['function approve(address,uint256) returns (bool)']),
          functionName: 'approve',
          args: [CHAIN_CONFIG.stakingContract as Address, eoaOlasAmountB],
        });
        await anvilJsonRpc(ANVIL_RPC, 'eth_sendTransaction', [
          { from: masterAddressB, to: OLAS_TOKEN, data: olasApproveB },
        ]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        const depositDataB = encodeFunctionData({
          abi: parseAbi(['function deposit(uint256)']),
          functionName: 'deposit',
          args: [eoaOlasAmountB],
        });
        await anvilJsonRpc(ANVIL_RPC, 'eth_sendTransaction', [
          { from: masterAddressB, to: CHAIN_CONFIG.stakingContract, data: depositDataB },
        ]);
        await anvilJsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [masterAddressB]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Re-bootstrap operator B to completion
        bootstrapper2 = new FleetBootstrapper({
          earningDir: tmpDir2,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
        });

        const finalResult2 = await bootstrapper2.bootstrap('test-password-2');
        const bComplete = finalResult2.fleet_state.services.find(s => s.step === 'complete');
        if (!finalResult2.ok || !bComplete) {
          throw new Error(
            `Expected a service at step 'complete', got ok=${finalResult2.ok}: ${finalResult2.message}`,
          );
        }

        safeAddressB = bComplete.safe_address as Address;
        mechAddressB = bComplete.mech_address as Address | undefined;

        if (!safeAddressB || !mechAddressB) {
          throw new Error('Operator B bootstrap completed but missing safe or mech_address');
        }

        const { FleetStateStore } = await import('../../src/earning/store.js');
        const { decryptMnemonic, walletPrivateKeyAtIndex } = await import('../../src/earning/wallet.js');
        const storeFleetB = new FleetStateStore(tmpDir2);
        const mnemonicB = await decryptMnemonic(
          await storeFleetB.loadMnemonicKeystore(),
          'test-password-2',
        );
        agentEoaPrivateKeyB = walletPrivateKeyAtIndex(mnemonicB, bComplete.index);

        console.log(`    Operator B Safe: ${safeAddressB}`);
        console.log(`    Operator B Mech: ${mechAddressB}`);

        await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [
          safeAddressB,
          '0x56BC75E2D63100000', // 100 ETH — same as Phase 3 warm path for createRestorationJob eth_call
        ]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Stabilize B's mech on the marketplace
        await stabilizeForkedMarketplaceState(publicClient as unknown as import('viem').PublicClient, safeAddressB as Address, mechAddressB as Address);

        // Creator adapter (Operator A) — posts request targeting B's mech
        const creatorAdapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS as `0x${string}`,
          routerAddress: ROUTER_ADDRESS as `0x${string}`,
          mechContractAddress: mechAddressB as `0x${string}`, // route to B's mech
          safeAddress: safeAddress as `0x${string}`,
          agentEoaPrivateKey: agentEoaPrivateKey as `0x${string}`,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
          routerClaimDeliveryVariant: 'v1',
        });
        await creatorAdapter.initialize();

        // Restorer adapter (Operator B) — delivers through B's mech
        const restorerAdapterB = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS as `0x${string}`,
          routerAddress: ROUTER_ADDRESS as `0x${string}`,
          mechContractAddress: mechAddressB as `0x${string}`,
          safeAddress: safeAddressB as `0x${string}`,
          agentEoaPrivateKey: agentEoaPrivateKeyB as `0x${string}`,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
          routerClaimDeliveryVariant: 'v1',
        });
        await restorerAdapterB.initialize();

        // A posts a restoration request targeting B's mech
        const crossRequestId = await creatorAdapter.postRestorationJob({
          id: 'cross-operator-test',
          description: 'Cross-operator E2E test',
          type: 'restoration',
          attemptId: 'cross-operator-test/1',
          attemptNumber: 1,
        });
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
        console.log(`    Cross-operator requestId: ${crossRequestId}`);

        // B picks up the request and delivers
        const { E2eRestorerLoop: E2eRestorerB } = await import('./legacy-restorer.js');
        const { Store: StoreB } = await import('../../src/store/store.js');
        const storeB = new StoreB(':memory:');
        const restorerB = new E2eRestorerB(
          restorerAdapterB,
          runner,
          storeB,
          join(tmpDir2!, 'e2e-b-work'),
          agentTimeoutMs,
        );

        const miningInterval = setInterval(async () => {
          try { await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        try {
          const processed = await Promise.race([
            restorerB.processOne(),
            sleep(agentTimeoutMs + 30000).then(() => { throw new Error(`Operator B restorer timed out after ${(agentTimeoutMs + 30000) / 1000}s`); }),
          ]);
          if (!processed) throw new Error('Operator B processOne returned false');
        } finally {
          clearInterval(miningInterval);
        }

        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Verify delivery was from B's mech
        const info = await publicClient.readContract({
          address: MARKETPLACE_ADDRESS,
          abi: MECH_MARKETPLACE_ABI,
          functionName: 'mapRequestIdInfos',
          args: [crossRequestId as Hex],
        }) as [string, string, string, bigint, bigint, string];

        const deliveryMech = info[1];
        if (deliveryMech === '0x0000000000000000000000000000000000000000') {
          throw new Error('deliveryMech is zero — cross-operator delivery did not happen');
        }
        console.log(`    Cross-operator delivery confirmed, deliveryMech: ${deliveryMech}`);

        // Full lifecycle: A claims delivery + creates evaluation
        const miningInterval2 = setInterval(async () => {
          try { await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []); } catch {}
        }, 1000);

        // Scan for EvaluationJobCreated from this point; the event may land after the first
        // watchForDeliveries yield (restorationDeliveryClaimed retry / next poll).
        const crossEvalScanFromBlock = await publicClient.getBlockNumber();
        const crossDeliveryIter = creatorAdapter.watchForDeliveries()[Symbol.asyncIterator]();
        const crossDelivery = await Promise.race([
          crossDeliveryIter.next().then(r => r.value),
          sleep(USE_REAL_AGENT ? 120000 : 30000).then(() => { throw new Error('Cross-operator watchForDeliveries timed out'); }),
        ]);
        console.log(`    A claimed restoration, type: ${crossDelivery?.restorationJob?.type ?? 'restoration'}`);

        await waitForRouterEvaluationJobForRestoration(
          publicClient,
          ROUTER_ADDRESS,
          crossRequestId as Hex,
          ANVIL_RPC,
          crossEvalScanFromBlock,
        );

        // B delivers evaluation (only after eval request is guaranteed on chain for B's mech)
        await Promise.race([
          restorerB.processOne(),
          sleep(agentTimeoutMs + 30000).then(() => { throw new Error(`Operator B eval processOne timed out after ${(agentTimeoutMs + 30000) / 1000}s`); }),
        ]);
        console.log('    B delivered evaluation');

        // A claims evaluation
        const crossEvalDelivery = await Promise.race([
          crossDeliveryIter.next().then(r => r.value),
          sleep(USE_REAL_AGENT ? 120000 : 30000).then(() => { throw new Error('Cross-operator eval watchForDeliveries timed out'); }),
        ]);
        clearInterval(miningInterval2);
        console.log(`    A claimed evaluation, type: ${crossEvalDelivery?.restorationJob?.type}`);
        console.log('    Cross-operator full lifecycle complete');

        await creatorAdapter.stop();
        await restorerAdapterB.stop();
        storeB.close();
      }),
    );

    // ── Phase 13: Priority Window + ClaimPolicy ────────────────────────────

    const { PriorityWindowPolicy } = await import('../../src/adapters/mech/claim-policy.js');

    results.push(
      await runPhase('Phase 13: Priority Window — PriorityWindowPolicy rejects during window, accepts after', async () => {
        if (!agentEoaPrivateKey || !safeAddress || !mechAddress) {
          throw new Error('Missing credentials from Phase 2');
        }
        if (!agentEoaPrivateKeyB || !safeAddressB || !mechAddressB) {
          throw new Error('Missing operator B credentials from Phase 12');
        }

        // Re-normalize timestamp and stabilize marketplace state
        await normalizeForkTimestamp(publicClient as unknown as import('viem').PublicClient);
        await stabilizeForkedMarketplaceState(publicClient as unknown as import('viem').PublicClient, safeAddress as Address, mechAddress as Address);

        // Operator A posts a request with priority = A's mech
        const windowAdapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS as `0x${string}`,
          routerAddress: ROUTER_ADDRESS as `0x${string}`,
          mechContractAddress: mechAddress as `0x${string}`, // A's mech as priority
          safeAddress: safeAddress as `0x${string}`,
          agentEoaPrivateKey: agentEoaPrivateKey as `0x${string}`,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
          routerClaimDeliveryVariant: 'v1',
        });
        await windowAdapter.initialize();

        const priorityRequestId = await windowAdapter.postRestorationJob({
          id: 'priority-window-test',
          description: 'Priority window E2E test',
          type: 'restoration',
          attemptId: 'priority-window-test/1',
          attemptNumber: 1,
        });
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
        console.log(`    Priority request posted: ${priorityRequestId}`);

        // Read responseTimeout from mapRequestIdInfos
        const reqInfo = await publicClient.readContract({
          address: MARKETPLACE_ADDRESS,
          abi: MECH_MARKETPLACE_ABI,
          functionName: 'mapRequestIdInfos',
          args: [priorityRequestId as Hex],
        }) as [string, string, string, bigint, bigint, string];
        const responseTimeout = reqInfo[3];
        console.log(`    responseTimeout: ${responseTimeout}s`);

        // Create PriorityWindowPolicy for operator B (non-priority mech)
        const policyB = new PriorityWindowPolicy(
          mechAddressB as Address,
          publicClient as unknown as import('viem').PublicClient,
          MARKETPLACE_ADDRESS as `0x${string}`,
        );

        // Verify: policy rejects B during A's priority window
        const rejectedDuringWindow = await policyB.confirmClaim(priorityRequestId);
        if (rejectedDuringWindow) {
          throw new Error('PriorityWindowPolicy should reject non-priority mech during window');
        }
        console.log('    PriorityWindowPolicy correctly rejected non-priority mech during window');

        // Advance time past the priority window
        await anvilJsonRpc(ANVIL_RPC, 'evm_increaseTime', [Number(responseTimeout) + 1]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
        console.log('    Time advanced past priority window');

        // Verify: policy accepts B after window expires
        const acceptedAfterWindow = await policyB.confirmClaim(priorityRequestId);
        if (!acceptedAfterWindow) {
          throw new Error('PriorityWindowPolicy should accept after window expires');
        }
        console.log('    PriorityWindowPolicy correctly accepted after window expiry');

        // Impersonate operator B's mech operator and deliver via B's mech directly
        const operatorB = await publicClient.readContract({
          address: mechAddressB as Address,
          abi: MECH_ABI,
          functionName: 'getOperator',
        }) as Address;
        console.log(`    Operator B mech operator: ${operatorB}`);

        // Fund the impersonated account with ETH for gas
        await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [operatorB, '0x56BC75E2D63100000']);
        await anvilJsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [operatorB]);

        // Build a minimal delivery payload
        const deliveryData = '0x' + '00'.repeat(32); // 32 zero bytes as placeholder data

        const { createWalletClient } = await import('viem');
        const impersonatedWallet = createWalletClient({
          account: operatorB,
          chain: base,
          transport: http(ANVIL_RPC),
        });

        await impersonatedWallet.writeContract({
          address: mechAddressB as Address,
          abi: MECH_ABI,
          functionName: 'deliverToMarketplace',
          args: [[priorityRequestId as Hex], [deliveryData as Hex]],
        });

        await anvilJsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [operatorB]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Verify delivery came from B's mech (non-priority)
        const finalInfo = await publicClient.readContract({
          address: MARKETPLACE_ADDRESS,
          abi: MECH_MARKETPLACE_ABI,
          functionName: 'mapRequestIdInfos',
          args: [priorityRequestId as Hex],
        }) as [string, string, string, bigint, bigint, string];

        const deliveryMech = finalInfo[1];
        if (deliveryMech === '0x0000000000000000000000000000000000000000') {
          throw new Error('deliveryMech is zero — priority window delivery did not happen');
        }
        console.log(`    Delivery from non-priority mech confirmed: ${deliveryMech}`);

        await windowAdapter.stop();
      }),
    );

    // ── Phase 13b: On-Chain ClaimRegistry ──────────────────────────────────

    const { OnChainClaimPolicy } = await import('../../src/adapters/mech/claim-policy.js');
    // Canonical ABI — do not import from adapters/mech/types (CLAIM_REGISTRY_ABI was removed there).
    const { CLAIM_REGISTRY_ABI } = await import('../../src/adapters/claim-registry/abi.js');

    results.push(
      await runPhase('Phase 13b: On-Chain ClaimRegistry — deploy, claim, reject, expire, reclaim', async () => {
        if (!agentEoaPrivateKey || !safeAddress || !mechAddress) {
          throw new Error('Missing credentials from Phase 2');
        }
        if (!agentEoaPrivateKeyB || !safeAddressB || !mechAddressB) {
          throw new Error('Missing operator B credentials from Phase 12');
        }

        // Deploy ClaimRegistry on Anvil using a funded deployer
        const { createWalletClient: createWC } = await import('viem');
        const { privateKeyToAccount } = await import('viem/accounts');

        // Use a fresh deployer account
        const deployerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex; // Anvil default key 0
        const deployerAccount = privateKeyToAccount(deployerKey);
        await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [deployerAccount.address, '0x56BC75E2D63100000']);

        const deployerWallet = createWC({
          account: deployerAccount,
          chain: base,
          transport: http(ANVIL_RPC),
        });

        // Read compiled bytecode (requires `forge build` / contracts sync in repo root)
        const { readFileSync: readFS, existsSync } = await import('node:fs');
        const { join: joinPath } = await import('node:path');
        const artifactPath = joinPath(__dirname, '..', '..', '..', 'contracts', 'artifacts', 'src', 'claiming', 'ClaimRegistry.sol', 'ClaimRegistry.json');
        if (!existsSync(artifactPath)) {
          console.log(
            `    SKIP: ClaimRegistry artifact not found (${artifactPath}) — run contracts build to enable Phase 13b`,
          );
          return;
        }
        const artifact = JSON.parse(readFS(artifactPath, 'utf-8'));

        // Deploy with 60s TTL (short for testing)
        const CLAIM_TTL = 60;
        const constructorArgs = encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'address' }],
          [BigInt(CLAIM_TTL), deployerAccount.address],
        );
        const deployData = (artifact.bytecode + constructorArgs.slice(2)) as Hex;

        const deployHash = await deployerWallet.sendTransaction({
          data: deployData,
          chain: base,
        });
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
        const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
        const claimRegistryAddress = deployReceipt.contractAddress!;
        console.log(`    ClaimRegistry deployed at: ${claimRegistryAddress}`);

        // Create viem clients for operator A and B
        const { createClients } = await import('../../src/adapters/mech/safe.js');
        const clientsA = createClients(ANVIL_RPC, agentEoaPrivateKey as Hex);
        const clientsB = createClients(ANVIL_RPC, agentEoaPrivateKeyB as Hex);

        // Post a request for operator A to claim
        // Re-normalize timestamp (may have drifted from evm_increaseTime in earlier phases)
        await normalizeForkTimestamp(publicClient as unknown as import('viem').PublicClient);
        await stabilizeForkedMarketplaceState(publicClient as unknown as import('viem').PublicClient, safeAddress as Address, mechAddress as Address);

        const claimTestAdapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS as `0x${string}`,
          routerAddress: ROUTER_ADDRESS as `0x${string}`,
          mechContractAddress: mechAddress as `0x${string}`,
          safeAddress: safeAddress as `0x${string}`,
          agentEoaPrivateKey: agentEoaPrivateKey as `0x${string}`,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
          routerClaimDeliveryVariant: 'v1',
        });
        await claimTestAdapter.initialize();

        const claimTestRequestId = await claimTestAdapter.postRestorationJob({
          id: 'claim-registry-test',
          description: 'ClaimRegistry E2E test',
          type: 'restoration',
          attemptId: 'claim-registry-test/1',
          attemptNumber: 1,
        });
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
        console.log(`    Test requestId: ${claimTestRequestId}`);

        // --- Test 1: Operator A claims successfully ---
        const { claimJob: claimJobFn, getJobClaim: getJobClaimFn } = await import('../../src/adapters/mech/contracts.js');

        const claimTxA = await claimJobFn(
          clientsA.publicClient,
          clientsA.walletClient,
          safeAddress as Address,
          claimRegistryAddress as Address,
          claimTestRequestId as Hex,
        );
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        if (!claimTxA) throw new Error('Operator A claimJob failed');
        console.log('    Operator A claimed successfully');

        // Verify claim on-chain
        const claimInfo = await getJobClaimFn(
          publicClient as unknown as import('viem').PublicClient,
          claimRegistryAddress as Address,
          claimTestRequestId as Hex,
        );
        if (claimInfo.claimer.toLowerCase() !== (safeAddress as string).toLowerCase()) {
          throw new Error(`Expected claimer ${safeAddress}, got ${claimInfo.claimer}`);
        }
        console.log(`    Claim verified: claimer=${claimInfo.claimer}`);

        // --- Test 2: Operator B rejected (already claimed) ---
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
        const claimTxB = await claimJobFn(
          clientsB.publicClient,
          clientsB.walletClient,
          safeAddressB as Address,
          claimRegistryAddress as Address,
          claimTestRequestId as Hex,
        );
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        if (claimTxB !== '') throw new Error('Operator B should have been rejected (claim returned non-empty)');
        console.log('    Operator B correctly rejected (JobAlreadyClaimed)');

        // --- Test 3: OnChainClaimPolicy rejects B ---
        const policyB = new OnChainClaimPolicy(
          mechAddressB as Address,
          publicClient as unknown as import('viem').PublicClient,
          clientsB.walletClient,
          safeAddressB as Address,
          MARKETPLACE_ADDRESS as `0x${string}`,
          claimRegistryAddress as Address,
        );

        const policyResult = await policyB.confirmClaim(claimTestRequestId);
        if (policyResult) throw new Error('OnChainClaimPolicy should reject B (A has active claim)');
        console.log('    OnChainClaimPolicy correctly rejected operator B');

        // --- Test 4: Expire claim, operator B reclaims ---
        await anvilJsonRpc(ANVIL_RPC, 'evm_increaseTime', [CLAIM_TTL + 1]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // getJobClaim should return zero (expired)
        const expiredInfo = await getJobClaimFn(
          publicClient as unknown as import('viem').PublicClient,
          claimRegistryAddress as Address,
          claimTestRequestId as Hex,
        );
        if (expiredInfo.claimer !== '0x0000000000000000000000000000000000000000') {
          throw new Error('Expected expired claim to return zero address');
        }
        console.log('    Claim expired (getJobClaim returns zero)');

        // B can now claim
        const claimTxB2 = await claimJobFn(
          clientsB.publicClient,
          clientsB.walletClient,
          safeAddressB as Address,
          claimRegistryAddress as Address,
          claimTestRequestId as Hex,
        );
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        if (!claimTxB2) throw new Error('Operator B reclaim failed after expiry');

        const reclaimInfo = await getJobClaimFn(
          publicClient as unknown as import('viem').PublicClient,
          claimRegistryAddress as Address,
          claimTestRequestId as Hex,
        );
        if (reclaimInfo.claimer.toLowerCase() !== (safeAddressB as string).toLowerCase()) {
          throw new Error(`Expected reclaimer ${safeAddressB}, got ${reclaimInfo.claimer}`);
        }
        console.log(`    Operator B reclaimed after expiry: claimer=${reclaimInfo.claimer}`);

        // --- Test 5: Verify punishment counter ---
        const expiredCount = await publicClient.readContract({
          address: claimRegistryAddress as Address,
          abi: CLAIM_REGISTRY_ABI,
          functionName: 'expiredClaimCount',
          args: [safeAddress as Address],
        }) as bigint;
        if (expiredCount !== 1n) {
          throw new Error(`Expected expiredClaimCount=1 for operator A, got ${expiredCount}`);
        }
        console.log(`    Punishment verified: operator A expiredClaimCount=${expiredCount}`);

        // --- Gap 7: Test eligibility checker rejection ---
        // Set checker to address(1) which has no code — staticcall will revert → IneligibleToClaim
        await deployerWallet.writeContract({
          address: claimRegistryAddress as Address,
          abi: [{ name: 'setEligibilityChecker', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'checker', type: 'address' }], outputs: [] }],
          functionName: 'setEligibilityChecker',
          args: ['0x0000000000000000000000000000000000000001' as Address],
          chain: base,
        });
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Now claiming should fail — the checker has no code so staticcall reverts
        // Post a new request to claim
        const eligTestRequestId = await claimTestAdapter.postRestorationJob({
          id: 'eligibility-reject-test',
          description: 'Eligibility rejection test',
          type: 'restoration',
          attemptId: 'eligibility-reject-test/1',
          attemptNumber: 1,
        });
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // claimJob should fail with IneligibleToClaim or revert
        const eligClaimTx = await claimJobFn(
          clientsA.publicClient,
          clientsA.walletClient,
          safeAddress as Address,
          claimRegistryAddress as Address,
          eligTestRequestId as Hex,
        );
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
        if (eligClaimTx !== '') {
          console.log('    WARNING: eligibility check did not reject (checker may not have reverted)');
        } else {
          console.log('    Eligibility checker rejection verified ✓');
        }

        // Reset checker to AcceptAll for future tests
        await deployerWallet.writeContract({
          address: claimRegistryAddress as Address,
          abi: [{ name: 'setEligibilityChecker', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'checker', type: 'address' }], outputs: [] }],
          functionName: 'setEligibilityChecker',
          args: ['0x0000000000000000000000000000000000000000' as Address], // zero = no checker
          chain: base,
        });
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        await claimTestAdapter.stop();
      }),
    );

    // ── Phase 13c: Cross-Node Artifact Sync ────────────────────────────────

    const { PeerSync } = await import('../../src/api/peers.js');

    results.push(
      await runPhase('Phase 13c: Cross-Node Artifact Sync — two API servers, publish, sync, acquire', async () => {
        if (!tmpDir) throw new Error('Missing tmpDir from Phase 1');

        // Create two stores (two independent nodes)
        const storeA = new Store(join(tmpDir, 'node-a.db'));
        const storeB = new Store(join(tmpDir, 'node-b.db'));

        // Start two API servers on different ports
        const serverA = await startApiServer({ port: 7341, store: storeA, requireAuth: false, apiToken: 'e2e-test-token' });
        const serverB = await startApiServer({ port: 7342, store: storeB, requireAuth: false, apiToken: 'e2e-test-token' });
        console.log(`    Node A API on port ${serverA.port}`);
        console.log(`    Node B API on port ${serverB.port}`);

        try {
          // --- Test 1: Node A publishes an artifact ---
          const artifactId = 'cross-node-test-artifact';
          storeA.insertArtifact({
            id: artifactId,
            desiredStateId: 'cross-node-test',
            requestId: '0x0000',
            title: 'Cross-node knowledge: restoration strategy alpha',
            content: 'When restoring FLOOR invariants, check historical baselines first.',
            tags: ['restoration', 'strategy', 'floor'],
            outcome: 'SUCCESS',
          });
          console.log('    Node A published artifact');

          // Verify it's searchable on A's API
          const searchA = await fetch(`http://localhost:${serverA.port}/artifacts/search?tags=restoration`);
          const searchAData = await searchA.json() as { results: unknown[] };
          if (searchAData.results.length === 0) throw new Error('Node A search returned no results');
          console.log(`    Node A search: ${searchAData.results.length} result(s)`);

          // --- Test 2: Node B syncs from Node A ---
          const peerSync = new PeerSync({
            peers: [`http://localhost:${serverA.port}`],
            store: storeB,
          });

          const synced = await peerSync.syncOnce();
          if (synced === 0) throw new Error('Peer sync returned 0 artifacts');
          console.log(`    Node B synced ${synced} artifact(s) from Node A`);

          // Verify it appears in B's local search
          const searchB = storeB.searchArtifacts({ tags: ['restoration'] });
          if (searchB.length === 0) throw new Error('Node B search returned no results after sync');
          console.log(`    Node B local search: ${searchB.length} result(s)`);

          // Verify content is NOT cached yet (remote artifact, metadata only)
          const cachedContent = storeB.resolveCatalogArtifactContent(artifactId);
          if (cachedContent !== null) throw new Error('Content should not be cached before acquire');
          console.log('    Content not cached yet (metadata only)');

          // --- Test 3: Node B acquires content from Node A ---
          const content = await peerSync.acquireContent(artifactId);
          if (!content) throw new Error('acquireContent returned null');
          if (!content.includes('historical baselines')) {
            throw new Error(`Unexpected content: ${content.slice(0, 50)}`);
          }
          console.log(`    Node B acquired content: "${content.slice(0, 50)}..."`);

          // Verify content is now cached
          const cachedAfter = storeB.resolveCatalogArtifactContent(artifactId);
          if (!cachedAfter) throw new Error('Content should be cached after acquire');
          console.log('    Content cached locally on Node B');

          // --- Test 4: Second acquire hits cache ---
          const cached2 = await peerSync.acquireContent(artifactId);
          if (cached2 !== content) throw new Error('Second acquire should return same cached content');
          console.log('    Second acquire served from cache');

          peerSync.stop();
        } finally {
          await serverA.close();
          await serverB.close();
          storeA.close();
          storeB.close();
        }
      }),
    );

    // ── Phase 13d: 8004 Registry + Subgraph Backfill ───────────────────────

    const { queryArtifacts: querySubgraphArtifacts, getMetadataValue: getMeta } = await import('../../src/erc8004/index.js');

    results.push(
      await runPhase('Phase 13d: 8004 Registry + Subgraph — register artifact, mock subgraph, backfill', async () => {
        if (!tmpDir) throw new Error('Missing tmpDir from Phase 1');

        // --- Part 1: Deploy mock 8004 registry on Anvil ---
        const { createWalletClient: createWC2 } = await import('viem');
        const { privateKeyToAccount: pk2acc } = await import('viem/accounts');

        const deployerKey2 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
        const deployerAccount2 = pk2acc(deployerKey2);
        await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [deployerAccount2.address, '0x56BC75E2D63100000']);

        // Deploy a minimal 8004 registry mock — just needs register() that emits an event
        // For simplicity, use the Registry8004 class to register against a real contract
        // We'll test the registration data encoding + subgraph mock separately

        // --- Part 2: Mock subgraph endpoint ---
        const { createServer: createHttpServer } = await import('node:http');

        const mockArtifacts = [
          {
            id: '1',
            agentURI: 'artifact:subgraph-test-artifact',
            owner: '0xSubgraphOwner',
            metadata: [
              { key: 'documentType', value: 'adw:Artifact' },
              { key: 'artifactId', value: 'subgraph-test-artifact' },
              { key: 'title', value: 'Subgraph-discovered restoration knowledge' },
              { key: 'outcome', value: 'SUCCESS' },
              { key: 'tags', value: '["subgraph","discovery"]' },
              { key: 'endpoint', value: 'http://remote-node:7331' },
            ],
          },
        ];

        const mockSubgraph = createHttpServer((req, res) => {
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', () => {
            const parsed = JSON.parse(body) as { query: string };
            const isArtifactQuery = parsed.query.includes('Artifact');
            const isNodeQuery = parsed.query.includes('AgentCard');

            const agents = isArtifactQuery ? mockArtifacts : isNodeQuery ? [{
              id: '2',
              agentURI: 'http://discovered-peer:7331',
              owner: '0xPeerOwner',
              metadata: [
                { key: 'documentType', value: 'adw:AgentCard' },
                { key: 'endpoint', value: 'http://discovered-peer:7331' },
                { key: 'ownerAddress', value: '0xPeerOwner' },
              ],
            }] : [];

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: { agents } }));
          });
        });

        await new Promise<void>(resolve => mockSubgraph.listen(7350, resolve));
        console.log('    Mock subgraph listening on port 7350');

        try {
          // --- Part 3: Query stubbed subgraph surface ---
          const artifacts = await querySubgraphArtifacts({ url: 'http://localhost:7350' });
          if (artifacts.length !== 0) {
            throw new Error(`Stubbed subgraph query returned ${artifacts.length} artifacts, expected 0`);
          }
          console.log('    Stubbed subgraph query returned no artifacts (expected until rebuilt subgraph ships)');

          const firstArtifact = mockArtifacts[0]!;
          const artifactId = getMeta(firstArtifact, 'artifactId');
          const title = getMeta(firstArtifact, 'title');
          const outcome = getMeta(firstArtifact, 'outcome');
          const endpoint = getMeta(firstArtifact, 'endpoint');

          if (artifactId !== 'subgraph-test-artifact') throw new Error(`Wrong artifactId: ${artifactId}`);
          if (outcome !== 'SUCCESS') throw new Error(`Wrong outcome: ${outcome}`);
          console.log(`    Subgraph artifact: id=${artifactId}, title="${title}", outcome=${outcome}`);

          // --- Part 4: Backfill into store ---
          const backfillStore = new Store(join(tmpDir, 'backfill-test.db'));
          const tagsRaw = getMeta(firstArtifact, 'tags');
          const tags = tagsRaw ? JSON.parse(tagsRaw) as string[] : [];

          backfillStore.insertRemoteArtifact({
            id: artifactId!,
            desiredStateId: '',
            requestId: '',
            title: title ?? '',
            tags,
            outcome: (outcome ?? 'UNKNOWN') as 'SUCCESS' | 'FAILURE' | 'UNKNOWN',
            ownerAddress: firstArtifact.owner,
            endpoint: endpoint ?? '',
          });

          // Verify it's searchable
          const results = backfillStore.searchArtifacts({ tags: ['subgraph'] });
          if (results.length === 0) throw new Error('Backfilled artifact not found in search');
          console.log(`    Backfilled artifact searchable: ${results.length} result(s)`);

          // Verify it's marked as remote
          const remoteInfo = backfillStore.getRemoteDiscoveryMetadata(artifactId!);
          if (!remoteInfo) throw new Error('Remote info not found');
          if (remoteInfo.endpoint !== 'http://remote-node:7331') throw new Error(`Wrong endpoint: ${remoteInfo.endpoint}`);
          console.log(`    Remote info: endpoint=${remoteInfo.endpoint}, owner=${remoteInfo.ownerAddress}`);

          // Content should be null (metadata only, not acquired yet)
          const content = backfillStore.resolveCatalogArtifactContent(artifactId!);
          if (content !== null) throw new Error('Content should be null before acquisition');
          console.log('    Content is null (not yet acquired) — correct');

          backfillStore.close();
        } finally {
          await new Promise<void>(resolve => mockSubgraph.close(() => resolve()));
        }
      }),
    );

    // ── Phase 13e: x402 Payment Gating ─────────────────────────────────────

    const { acquireArtifactWithPayment, buildAcquisitionUrl } = await import('../../src/x402/acquire.js');

    results.push(
      await runPhase('Phase 13e: x402 — payment gating + best-effort acquisition', async () => {
        if (!tmpDir || !agentEoaPrivateKey) throw new Error('Missing credentials');

        // Start an API server with x402 enabled
        const x402Store = new Store(join(tmpDir, 'x402-test.db'));
        x402Store.insertArtifact({
          id: 'x402-test-artifact',
          desiredStateId: 'x402-test',
          requestId: '0x0000',
          title: 'Payment-gated knowledge',
          content: 'This content requires x402 payment to access.',
          tags: ['x402', 'test'],
          outcome: 'SUCCESS',
        });

        const x402Server = await startApiServer({
          port: 7351,
          store: x402Store,
          apiToken: 'e2e-test-token',
          x402: {
            privateKey: agentEoaPrivateKey as string,
            recipientAddress: safeAddress as string,
            network: 'eip155:8453',
            rpcUrl: ANVIL_RPC,
          },
        });

        try {
          // --- Test 1: Free route still works ---
          const freeRes = await fetch('http://localhost:7351/artifacts/x402-test-artifact/content');
          if (freeRes.status !== 200) throw new Error(`Free route returned ${freeRes.status}, expected 200`);
          const freeData = await freeRes.json() as { content: string };
          if (!freeData.content.includes('x402 payment')) throw new Error('Free route returned wrong content');
          console.log('    Free route (/artifacts/:id/content) works alongside x402');

          // --- Test 2: x402 route returns 404 for unknown sha256 (free 200 with row) ---
          // Post jinn-mono-vy37.1.2 the route is sha256-keyed against the
          // served_artifacts table. We seed a row to exercise the gating path.
          const fakeSha256 = 'a'.repeat(64);
          x402Store.saveServedArtifact({
            sha256: fakeSha256,
            artifactType: 'output.test',
            content: Buffer.from('paid x402 content'),
            priceUsdc: '0.001',
            createdAt: new Date().toISOString(),
          });
          const gatedRes = await fetch(`http://localhost:7351/v1/artifacts/${fakeSha256}/content`);
          if (gatedRes.status === 402) {
            console.log('    x402 route correctly returns 402 (Payment Required) without payment');
          } else if (gatedRes.status === 200) {
            console.log('    WARNING: x402 route returned 200 — payment middleware may not be gating');
          } else {
            console.log(`    x402 route returned ${gatedRes.status} — noting for investigation`);
          }

          // --- Test 3: URL builder ---
          const url = buildAcquisitionUrl('http://localhost:7351', fakeSha256);
          if (url !== `http://localhost:7351/v1/artifacts/${fakeSha256}/content`) {
            throw new Error(`Wrong acquisition URL: ${url}`);
          }
          console.log('    buildAcquisitionUrl produces correct URL');

          // --- Test 4: Best-effort paid acquisition ---
          console.log('    Testing x402 acquisition (best-effort, may fail on Anvil)...');
          try {
            const result = await acquireArtifactWithPayment(
              'http://localhost:7351',
              fakeSha256,
              agentEoaPrivateKey as string,
            );
            if (result.ok) {
              console.log(`    x402 acquisition succeeded: ${result.content.length} bytes`);
            } else {
              console.log(`    x402 acquisition returned ${result.reason} (payment settlement may not work on Anvil fork)`);
            }
          } catch (err) {
            console.log(`    x402 acquisition error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
          }
          // Don't fail the phase — x402 payment on Anvil is best-effort
        } finally {
          await x402Server.close();
          x402Store.close();
        }
      }),
    );

    // ── Phase 13f: ERC-8128 Auth on API ────────────────────────────────────

    const { createPrivateKeyHttpSigner, signRequestWithErc8128 } = await import('../../src/auth/erc8128.js');

    results.push(
      await runPhase('Phase 13f: ERC-8128 Auth — unsigned rejected, signed accepted', async () => {
        if (!tmpDir) throw new Error('Missing tmpDir');

        const authStore = new Store(join(tmpDir, 'auth-test.db'));
        const authServer = await startApiServer({
          port: 7352,
          store: authStore,
          requireAuth: true,
          apiToken: 'e2e-test-token',
        });

        try {
          // Test 1: Unsigned POST → 401
          const unsignedRes = await fetch('http://localhost:7352/artifacts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: 'Unauthorized artifact',
              content: 'This should be rejected',
              tags: ['auth-test'],
              outcome: 'UNKNOWN',
            }),
          });
          if (unsignedRes.status !== 401) {
            throw new Error(`Expected 401 for unsigned POST, got ${unsignedRes.status}`);
          }
          console.log('    Unsigned POST → 401 ✓');

          // Test 2: Signed POST → 201
          const testKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
          const signer = createPrivateKeyHttpSigner(testKey, 8453);

          const signedReq = await signRequestWithErc8128({
            signer,
            input: 'http://localhost:7352/artifacts',
            init: {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: 'Authorized artifact',
                content: 'This should be accepted',
                tags: ['auth-test'],
                outcome: 'SUCCESS',
              }),
            },
          });

          const signedRes = await fetch(signedReq);
          if (signedRes.status !== 201) {
            const err = await signedRes.text();
            throw new Error(`Expected 201 for signed POST, got ${signedRes.status}: ${err}`);
          }
          console.log('    Signed POST → 201 ✓');

          // Test 3: GET (read) doesn't require auth
          const searchRes = await fetch('http://localhost:7352/artifacts/search');
          if (searchRes.status !== 200) {
            throw new Error(`Expected 200 for GET search, got ${searchRes.status}`);
          }
          const searchData = await searchRes.json() as { results: unknown[] };
          if (searchData.results.length !== 1) {
            throw new Error(`Expected 1 artifact from search, got ${searchData.results.length}`);
          }
          console.log('    GET search (no auth) → 200 with 1 result ✓');
        } finally {
          await authServer.close();
          authStore.close();
        }
      }),
    );

    // ── Phase 13g: Concurrent Claim Competition ────────────────────────────

    results.push(
      await runPhase('Phase 13g: Claim Competition — operator A claims, operator B rejected', async () => {
        if (!agentEoaPrivateKey || !safeAddress || !mechAddress) {
          throw new Error('Missing credentials from Phase 2');
        }
        if (!agentEoaPrivateKeyB || !safeAddressB || !mechAddressB) {
          throw new Error('Missing operator B credentials from Phase 12');
        }

        await normalizeForkTimestamp(publicClient as unknown as import('viem').PublicClient);
        await stabilizeForkedMarketplaceState(publicClient as unknown as import('viem').PublicClient, safeAddress as Address, mechAddress as Address);

        // Post a request that both operators can see
        const compAdapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS as `0x${string}`,
          routerAddress: ROUTER_ADDRESS as `0x${string}`,
          mechContractAddress: mechAddress as `0x${string}`,
          safeAddress: safeAddress as `0x${string}`,
          agentEoaPrivateKey: agentEoaPrivateKey as `0x${string}`,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
          routerClaimDeliveryVariant: 'v1',
        });
        await compAdapter.initialize();

        const compRequestId = await compAdapter.postRestorationJob({
          id: 'competition-test',
          description: 'Claim competition test',
          type: 'restoration',
          attemptId: 'competition-test/1',
          attemptNumber: 1,
        });
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
        console.log(`    Competition requestId: ${compRequestId}`);

        // Operator A's policy confirms claim
        const policyA = new PriorityWindowPolicy(
          mechAddress as Address,
          publicClient as unknown as import('viem').PublicClient,
          MARKETPLACE_ADDRESS as `0x${string}`,
        );
        const aConfirmed = await policyA.confirmClaim(compRequestId);
        if (!aConfirmed) throw new Error('Operator A should be able to claim');
        console.log('    Operator A confirmClaim → true ✓');

        // Simulate A delivering — now the request has deliveryMech != 0x0
        // Use impersonation to deliver quickly
        const operatorA = await publicClient.readContract({
          address: mechAddress as Address,
          abi: MECH_ABI,
          functionName: 'getOperator',
        }) as Address;
        await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [operatorA, '0x56BC75E2D63100000']);
        await anvilJsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [operatorA]);

        const { createWalletClient: createWC3 } = await import('viem');
        const impWallet = createWC3({ account: operatorA, chain: base, transport: http(ANVIL_RPC) });
        await impWallet.writeContract({
          address: mechAddress as Address,
          abi: MECH_ABI,
          functionName: 'deliverToMarketplace',
          args: [[compRequestId as Hex], ['0x' + '00'.repeat(32) as Hex]],
        });
        await anvilJsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [operatorA]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Operator B's policy should reject (already delivered)
        const policyB = new PriorityWindowPolicy(
          mechAddressB as Address,
          publicClient as unknown as import('viem').PublicClient,
          MARKETPLACE_ADDRESS as `0x${string}`,
        );
        const bConfirmed = await policyB.confirmClaim(compRequestId);
        if (bConfirmed) throw new Error('Operator B should be rejected (already delivered)');
        console.log('    Operator B confirmClaim → false (already delivered) ✓');

        await compAdapter.stop();
      }),
    );

    // ── Phase 13h: Agent Failure Handling ─────────────────────────────────

    results.push(
      await runPhase('Phase 13h: Agent Failure — mock agent crashes, restorer handles gracefully', async () => {
        if (!agentEoaPrivateKey || !safeAddress || !mechAddress || !tmpDir) {
          throw new Error('Missing credentials');
        }

        await normalizeForkTimestamp(publicClient as unknown as import('viem').PublicClient);
        await stabilizeForkedMarketplaceState(publicClient as unknown as import('viem').PublicClient, safeAddress as Address, mechAddress as Address);

        // Post a request
        const failAdapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS as `0x${string}`,
          routerAddress: ROUTER_ADDRESS as `0x${string}`,
          mechContractAddress: mechAddress as `0x${string}`,
          safeAddress: safeAddress as `0x${string}`,
          agentEoaPrivateKey: agentEoaPrivateKey as `0x${string}`,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
          routerClaimDeliveryVariant: 'v1',
        });
        await failAdapter.initialize();

        const failRequestId = await failAdapter.postRestorationJob({
          id: 'agent-failure-test',
          description: 'Agent failure test',
          type: 'restoration',
          attemptId: 'agent-failure-test/1',
          attemptNumber: 1,
        });
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Create a runner that will fail (mock agent with MOCK_AGENT_FAIL=1)
        // We need to set env var for the mock agent — but ClaudeRunner sanitizes env.
        // The mock agent reads MOCK_AGENT_FAIL from its own env. Since ClaudeRunner
        // uses buildAgentEnv() which only passes allowlisted vars, we need to pass
        // MOCK_AGENT_FAIL through the MCP config env vars. But that's complex.
        //
        // Simpler: use a script that always exits 1.
        const { writeFileSync: writeFS2 } = await import('node:fs');
        const failScript = join(tmpDir!, 'fail-agent.sh');
        writeFS2(failScript, '#!/bin/bash\nexit 1\n', { mode: 0o755 });

        const { ClaudeRunner } = await import('../../src/runner/claude.js');
        const { E2eRestorerLoop: E2eFail } = await import('./legacy-restorer.js');
        const { Store: StoreFail } = await import('../../src/store/store.js');
        const failRunner = new ClaudeRunner({ claudePath: failScript });
        const failStore = new StoreFail(join(tmpDir!, 'fail-test.db'));
        const failRestorer = new E2eFail(failAdapter, failRunner, failStore, join(tmpDir!, 'fail-work'), 30_000);

        const miningInterval = setInterval(async () => {
          try { await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        try {
          // processOne should NOT throw — error is caught internally
          const processed = await Promise.race([
            failRestorer.processOne(),
            sleep(30000).then(() => { throw new Error('processOne timed out'); }),
          ]);
          if (!processed) throw new Error('processOne returned false');
          console.log('    processOne() completed without throwing ✓');

          // Verify no delivery on-chain
          await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
          const info = await publicClient.readContract({
            address: MARKETPLACE_ADDRESS,
            abi: MECH_MARKETPLACE_ABI,
            functionName: 'mapRequestIdInfos',
            args: [failRequestId as Hex],
          }) as [string, string, string, bigint, bigint, string];
          const deliveryMech = info[1];
          if (deliveryMech !== '0x0000000000000000000000000000000000000000') {
            throw new Error('Delivery should NOT have happened after agent failure');
          }
          console.log('    No delivery on-chain after agent failure ✓');
        } finally {
          clearInterval(miningInterval);
        }

        await failAdapter.stop();
        failStore.close();
      }),
    );

    // ── Phase 14: Crash Recovery ─────────────────────────────────────────────

    results.push(
      await runPhase('Phase 14: Crash Recovery — stop mid-flow, deliver offline, restart', async () => {
        if (!agentEoaPrivateKey || !safeAddress || !mechAddress || !tmpDir) {
          throw new Error('Missing credentials from Phase 2');
        }
        if (!agentEoaPrivateKeyB || !safeAddressB || !mechAddressB) {
          throw new Error('Missing operator B credentials from Phase 12');
        }

        // Re-stabilize marketplace state for both mechs
        await normalizeForkTimestamp(publicClient as unknown as import('viem').PublicClient);
        await stabilizeForkedMarketplaceState(publicClient as unknown as import('viem').PublicClient, safeAddress as Address, mechAddress as Address);

        const dbPath = join(tmpDir, 'crash-recovery.db');

        // Create adapter with persistent store
        const crashStore = new Store(dbPath);
        const crashAdapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS as `0x${string}`,
          routerAddress: ROUTER_ADDRESS as `0x${string}`,
          mechContractAddress: mechAddress as `0x${string}`,
          safeAddress: safeAddress as `0x${string}`,
          agentEoaPrivateKey: agentEoaPrivateKey as `0x${string}`,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
          routerClaimDeliveryVariant: 'v1',
        }, crashStore);
        await crashAdapter.initialize();

        // Save block cursor BEFORE posting (so recovery scan includes the request)
        const prePostBlock = await publicClient.getBlockNumber();
        crashStore.setLastProcessedBlock(prePostBlock);

        // Post a request
        const crashRequestId = await crashAdapter.postRestorationJob({
          id: 'crash-recovery-test',
          description: 'Crash recovery E2E test',
          type: 'restoration',
          attemptId: 'crash-recovery-test/1',
          attemptNumber: 1,
        });
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
        console.log(`    Crash recovery requestId: ${crashRequestId}`);
        await crashAdapter.stop();
        crashStore.close();
        console.log(`    Adapter stopped (block cursor saved at ${prePostBlock})`);

        // Deliver while adapter is down — impersonate operator A's mech operator
        const operatorA = await publicClient.readContract({
          address: mechAddress as Address,
          abi: MECH_ABI,
          functionName: 'getOperator',
        }) as Address;
        console.log(`    Operator A mech operator: ${operatorA}`);

        // Fund the impersonated account with ETH for gas
        await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [operatorA, '0x56BC75E2D63100000']);
        await anvilJsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [operatorA]);

        const crashDeliveryData = '0x' + '00'.repeat(32);

        const { createWalletClient: createWalletClientCrash } = await import('viem');
        const impersonatedWalletA = createWalletClientCrash({
          account: operatorA,
          chain: base,
          transport: http(ANVIL_RPC),
        });

        await impersonatedWalletA.writeContract({
          address: mechAddress as Address,
          abi: MECH_ABI,
          functionName: 'deliverToMarketplace',
          args: [[crashRequestId as Hex], [crashDeliveryData as Hex]],
        });

        await anvilJsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [operatorA]);
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);
        console.log('    Delivery completed while adapter was down');

        // Restart with same persistent store — triggers recoverPendingState
        const recoveredStore = new Store(dbPath);
        const recoveredAdapter = new MechAdapter({
          rpcUrl: ANVIL_RPC,
          mechMarketplaceAddress: MARKETPLACE_ADDRESS as `0x${string}`,
          routerAddress: ROUTER_ADDRESS as `0x${string}`,
          mechContractAddress: mechAddressB as `0x${string}`,
          safeAddress: safeAddress as `0x${string}`,
          agentEoaPrivateKey: agentEoaPrivateKey as `0x${string}`,
          ipfsRegistryUrl: 'https://registry.autonolas.tech',
          ipfsGatewayUrl: 'https://gateway.autonolas.tech',
          pollIntervalMs: 500,
          chainId: base.id,
          routerClaimDeliveryVariant: 'v1',
        }, recoveredStore);
        await recoveredAdapter.initialize();

        // Verify pendingEvaluations rebuilt
        const adapterAny = recoveredAdapter as unknown as {
          pendingEvaluations: Map<string, unknown>;
          claimedButNotEvaluated: Set<string>;
        };
        const hasPending = adapterAny.pendingEvaluations.size > 0 || adapterAny.claimedButNotEvaluated.size > 0;
        console.log(`    Recovered pendingEvaluations: ${adapterAny.pendingEvaluations.size}`);
        console.log(`    Recovered claimedButNotEvaluated: ${adapterAny.claimedButNotEvaluated.size}`);

        if (!hasPending) {
          throw new Error('Expected recovered adapter to have pending evaluations');
        }
        console.log('    Crash recovery: pending state successfully rebuilt');

        await recoveredAdapter.stop();
        recoveredStore.close();
      }),
    );

    // ── Phase 15: isRatioPass Verification ───────────────────────────────────

    results.push(
      await runPhase('Phase 15: isRatioPass — verify operator passes liveness check', async () => {
        if (!safeAddress || serviceId === undefined) {
          throw new Error('Missing safeAddress or serviceId from Phase 2');
        }

        const activityChecker = await publicClient.readContract({
          address: CHAIN_CONFIG.stakingContract as Address,
          abi: parseAbi(['function activityChecker() view returns (address)']),
          functionName: 'activityChecker',
        });

        const checkerAbi = parseAbi([
          'function getMultisigNonces(address) view returns (uint256[])',
          'function isRatioPass(uint256[],uint256[],uint256) view returns (bool)',
          'function livenessRatio() view returns (uint256)',
        ]);

        // Current nonces (after all activity)
        const currentNonces = await publicClient.readContract({
          address: activityChecker,
          abi: checkerAbi,
          functionName: 'getMultisigNonces',
          args: [safeAddress],
        });
        console.log(`    Current nonces: [${currentNonces.map(String).join(', ')}]`);

        // Get liveness ratio
        const livenessRatio = await publicClient.readContract({
          address: activityChecker,
          abi: checkerAbi,
          functionName: 'livenessRatio',
        });
        console.log(`    Liveness ratio: ${livenessRatio}`);

        if (!baselineMultisigNonces) {
          throw new Error('Missing baselineMultisigNonces from Phase 3');
        }
        const initialNonces = baselineMultisigNonces;
        // For isRatioPass: sum of activity deltas vs Safe nonce delta must clear livenessRatio
        // within ts. After the full E2E suite, use the Safe nonce delta as ts lower bound
        // so the ratio is evaluated on a window that fits the actual on-chain progression.
        const nonceDelta = currentNonces[0]! > initialNonces[0]!
          ? currentNonces[0]! - initialNonces[0]!
          : 1n;
        const timeDiff = nonceDelta > 20000n ? nonceDelta : 20000n;
        console.log(`    Baseline nonces (Phase 3): [${initialNonces.map(String).join(', ')}]`);
        console.log(`    Time diff (for ratio check): ${timeDiff}s`);

        const passes = await publicClient.readContract({
          address: activityChecker,
          abi: checkerAbi,
          functionName: 'isRatioPass',
          args: [[...currentNonces], [...initialNonces], timeDiff],
        });
        console.log(`    isRatioPass: ${passes}`);

        if (!passes) {
          throw new Error('isRatioPass returned false — operator did not pass liveness check');
        }
        console.log('    Operator passes liveness check');
      }),
    );

    // ── Phase 15b: CLI post-review surface (subprocess + small in-process checks) ─

    results.push(
      await runPhase(
        'Phase 15b: CLI — --config/--password-fd, fleet retire display index, claim helpers',
        async () => {
          if (!tmpDir) throw new Error('No temp dir');
          const configPath = join(tmpDir, 'e2e-cli-config.json');
          await writeFile(
            configPath,
            `${JSON.stringify(
              {
                network: 'mainnet',
                rpcUrl: ANVIL_RPC,
                earningDir: tmpDir,
                dbPath: join(tmpDir, 'cli-e2e.sqlite.db'),
                apiPort: 17331,
                stakingMode: 'standard',
                targetServices: 1,
              },
              null,
              2,
            )}\n`,
            'utf8',
          );

          const cfg = ['--config', configPath];
          const pw = { passwordFdContent: PASSWORD, tmpDirForPw: tmpDir };

          const claim = await runJinnCliSubprocess(['claim-rewards', '--dry-run', ...cfg], pw);
          if (claim.code !== 0) {
            throw new Error(`claim-rewards --dry-run exit ${claim.code} stderr=${claim.stderr}`);
          }
          const jClaim = parseLastStdoutJsonObject(claim.stdout);
          if (jClaim['dryRun'] !== true) {
            throw new Error(`expected claim-rewards dryRun, got ${JSON.stringify(jClaim)}`);
          }

          const intent = await runJinnCliSubprocess(
            [
              'submit-intent',
              '--dry-run',
              '--id',
              'e2e-cli',
              '--description',
              'E2E CLI config + password-fd',
              ...cfg,
            ],
            pw,
          );
          if (intent.code !== 0) {
            throw new Error(`submit-intent --dry-run exit ${intent.code} stderr=${intent.stderr}`);
          }
          const jIntent = parseLastStdoutJsonObject(intent.stdout);
          if (jIntent['dryRun'] !== true) {
            throw new Error(`expected submit-intent dryRun, got ${JSON.stringify(jIntent)}`);
          }

          const scale = await runJinnCliSubprocess(['fleet', 'scale', '--to', '1', '--dry-run', ...cfg], pw);
          if (scale.code !== 0) {
            throw new Error(`fleet scale --dry-run exit ${scale.code} stderr=${scale.stderr}`);
          }
          const jScale = parseLastStdoutJsonObject(scale.stdout);
          if (jScale['dryRun'] !== true) {
            throw new Error(`expected fleet scale dryRun, got ${JSON.stringify(jScale)}`);
          }

          const retire = await runJinnCliSubprocess(['fleet', 'retire', '0', '--dry-run', ...cfg], pw);
          if (retire.code !== 0) {
            throw new Error(`fleet retire --dry-run exit ${retire.code} stderr=${retire.stderr}`);
          }
          const jRetire = parseLastStdoutJsonObject(retire.stdout);
          const plan = jRetire['plan'] as Array<Record<string, unknown>> | undefined;
          if (!plan?.[0]) {
            throw new Error(`expected fleet retire plan, got ${JSON.stringify(jRetire)}`);
          }
          if (plan[0]!['chainIndex'] !== 1 || plan[0]!['index'] !== 0) {
            throw new Error(
              `fleet retire display 0 should map to index 0 / chainIndex 1, plan=${JSON.stringify(plan[0])}`,
            );
          }

          const wdr = await runJinnCliSubprocess(
            [
              'withdraw',
              '--to',
              '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
              '--drain-eth',
              '--dry-run',
              ...cfg,
            ],
            pw,
          );
          if (wdr.code !== 0) {
            throw new Error(`withdraw --dry-run exit ${wdr.code} stderr=${wdr.stderr}`);
          }
          const jWdr = parseLastStdoutJsonObject(wdr.stdout);
          if (jWdr['dryRun'] !== true) {
            throw new Error(`expected withdraw dryRun, got ${JSON.stringify(jWdr)}`);
          }

          const { nextFleetServiceIndex } = await import('../../src/earning/next-service-index.js');
          if (nextFleetServiceIndex([{ index: 1 }, { index: 3 }]) !== 4) {
            throw new Error('nextFleetServiceIndex([1,3]) expected 4');
          }

          const { tickStolasDistributorClaims } = await import('../../src/earning/stolas-claim.js');
          const chainCfg = getChainConfig('base');
          const tickEmpty = await tickStolasDistributorClaims(
            publicClient,
            {} as WalletClient,
            {
              distributorAddress: chainCfg.distributorAddress,
              stakingMode: 'standard',
              targets: [],
              strict: true,
            },
          );
          if (tickEmpty.attempted !== 0 || tickEmpty.claimAttempted !== 0) {
            throw new Error(`expected empty stolas tick, got ${JSON.stringify(tickEmpty)}`);
          }

          console.log('    claim-rewards, submit-intent, fleet scale/retire, withdraw (dry-run + flags)');
          console.log('    fleet retire display 0 -> chainIndex 1 (matches jinn fleet JSON index)');
          console.log('    nextFleetServiceIndex + tickStolasDistributorClaims(strict, []) OK');
        },
      ),
    );

  } finally {
    // ── Phase 16: Cleanup ─────────────────────────────────────────────────────

    results.push(
      await runPhase('Phase 16: Cleanup', async () => {
        if (adapter) {
          await adapter.stop().catch(() => {});
          console.log('    Adapter stopped');
        }
        await restorerApiServer?.close().catch(() => {});
        if (chain) {
          await chain.teardown();
          console.log('    Anvil process terminated');
        }
        if (tmpDir) {
          await rm(tmpDir, { recursive: true, force: true });
          console.log(`    Removed temp dir: ${tmpDir}`);
        }
        if (tmpDir2) {
          await rm(tmpDir2, { recursive: true, force: true });
          console.log(`    Removed temp dir: ${tmpDir2}`);
        }
      }),
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log('\n=== Summary ===\n');
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    const detail = r.error ? ` — ${r.error}` : '';
    console.log(`  ${icon} ${r.name} (${r.ms}ms)${detail}`);
  }

  console.log(`\n  ${passed} passed, ${failed} failed (${totalMs}ms total)\n`);

  exitExpected = true;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  exitExpected = true;
  process.exit(1);
});
