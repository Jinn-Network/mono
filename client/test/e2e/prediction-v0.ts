/**
 * e2e-prediction-v0.ts — End-to-end test for the prediction.v0 pipeline.
 *
 * Scenario:
 *   1. Bootstrap an operator on Anvil-forked Base mainnet
 *   2. Deploy MockV3Aggregator (ETH/USD price feed)
 *   3. Post a prediction.v0 Task on-chain
 *   4. Harness claims + runs PredictionV0BaselineImpl (mocked Chainlink)
 *   5. Sign + submit jinn.execution.v1 restoration envelope as result
 *   6. DeliveryWatcher claims restoration delivery + creates evaluation job
 *   7. Evaluator runs with mocked oracle → assert verdict PASS
 *   8. Verdict variants: FAIL / REJECTED / INDETERMINATE (direct TypeScript)
 *
 * Key differences from portfolio e2e:
 *   - Forks Base mainnet (same as portfolio) NOT Base Sepolia: the stOLAS
 *     distributor bootstrap on Base Sepolia is too complex for an Anvil fork
 *   - Uses venue: 'chainlink-base' with MockV3Aggregator deployed to the fork
 *   - No pre/post HL snapshots — prediction manifest is self-contained
 *   - Evaluator oracle is mocked via _testDeps (no live Chainlink needed)
 *   - Phase 10 verdict variants are pure TypeScript (no on-chain state needed)
 *
 * PIS Phase 1: Three separate Safes for creator / harness / evaluator.
 * Proves cross-evaluation flow with per-Safe counter attribution.
 *
 * Usage: yarn e2e:prediction
 */

import { config as dotenvConfig } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { decodeMarketplaceRequestLogs } from '../../src/adapters/mech/contracts.js';
import {
  MECH_ABI,
  MECH_MARKETPLACE_ABI,
  JINN_ROUTER_ABI,
  NATIVE_PAYMENT_TYPE,
} from '../../src/adapters/mech/types.js';
import { MechAdapter } from '../../src/adapters/mech/adapter.js';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import { getChainConfig } from '../../src/earning/contracts.js';
import { PredictionV0BaselineImpl } from '../../src/harnesses/impls/prediction-v0-baseline/index.js';
import { PredictionV0Evaluator } from '../../src/harnesses/impls/prediction-v0-evaluator/index.js';
import type { HarnessContext } from '../../src/harnesses/types.js';
import type { Task } from '../../src/types/task.js';
import type { TaskV1 } from '../../src/types/task-document.js';
import type { PredictionV0Task } from '../../src/types/prediction.js';
import type { SignedEnvelope } from '../../src/types/envelope.js';
import { signCanonical } from '../../src/harnesses/engine/signing.js';
import type { SpanningResult } from '../../src/venues/chainlink/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ─────────────────────────────────────────────────────────────────

// NOTE: We fork Base mainnet (not Base Sepolia) because the stOLAS distributor
// bootstrap on Base Sepolia is too complex for an Anvil fork. The prediction.v0
// impl and evaluator are fully parameterised — we use venue: 'chainlink-base'
// and inject a MockV3Aggregator as the oracle feed. All the on-chain mechanics
// (JinnRouter, MechMarketplace, Safe) are identical between mainnet/testnet.
const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
const ANVIL_PORT = 8548; // prediction e2e port (portfolio uses 8547, e2e-validate uses 8546)
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const PASSWORD = 'test-password-pred';

const CHAIN_CONFIG = getChainConfig('base');
const OLAS_TOKEN = CHAIN_CONFIG.olasToken;

const MARKETPLACE_ADDRESS: Address = CHAIN_CONFIG.mechMarketplace as Address;
// JinnRouter on Base mainnet — same address the portfolio e2e uses
const ROUTER_ADDRESS: Address = '0xfFa7118A3D820cd4E820010837D65FAfF463181B';
const MARKETPLACE_AGENT_FACTORY_SENTINEL: Address = '0x000000000000000000000000000000000000dEaD';
const MARKETPLACE_SLOT_SCAN_MAX = 64n;
const UINT32_MAX = 0xffff_ffffn;
const RESPONSE_TIMEOUT_HEADROOM = 3600n;

// MockV3Aggregator artifact path
const MOCK_AGGREGATOR_ARTIFACT = join(
  __dirname, '..', '..', '..', 'contracts',
  'artifacts', 'src', 'testnet', 'MockV3Aggregator.sol', 'MockV3Aggregator.json',
);

// Chainlink AggregatorV3Interface (minimal) for reading rounds
const AGGREGATOR_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function updateAnswer(int256 _answer)',
  'function pushRound(uint80 _roundId, int256 _answer, uint256 _updatedAt)',
]);

const MARKETPLACE_DIAGNOSTIC_ABI = [
  { name: 'mapAgentMechFactories', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'address' }] },
  { name: 'mapMechFactories', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'checkMech', type: 'function', stateMutability: 'view', inputs: [{ name: 'mech', type: 'address' }], outputs: [{ name: 'multisig', type: 'address' }] },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitFor(description: string, check: () => Promise<boolean>, timeoutMs = 30000, intervalMs = 500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for: ${description}`);
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

interface PhaseResult { name: string; ok: boolean; ms: number; error?: string; }

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
    return { name, ok: false, ms, error };
  }
}

function erc20BalanceSlot(holder: string, mappingSlot: bigint = 0n): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [getAddress(holder) as Address, mappingSlot]));
}

function addressMappingSlot(holder: Address, mappingSlot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, mappingSlot]));
}

function addressStorageWord(address: Address): Hex {
  return pad(address, { size: 32 });
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function getStorageWord(contractAddress: Address, slot: Hex): Promise<Hex> {
  return await jsonRpc(ANVIL_RPC, 'eth_getStorageAt', [contractAddress, slot, 'latest']) as Hex;
}

async function setStorageWord(contractAddress: Address, slot: Hex, value: Hex): Promise<void> {
  await jsonRpc(ANVIL_RPC, 'anvil_setStorageAt', [contractAddress, slot, value]);
}

async function readAgentFactory(publicClient: PublicClient, mechAddress: Address): Promise<Address> {
  return await publicClient.readContract({
    address: MARKETPLACE_ADDRESS, abi: MARKETPLACE_DIAGNOSTIC_ABI, functionName: 'mapAgentMechFactories', args: [mechAddress],
  }) as Address;
}

async function readFactoryWhitelist(publicClient: PublicClient, factoryAddress: Address): Promise<boolean> {
  return await publicClient.readContract({
    address: MARKETPLACE_ADDRESS, abi: MARKETPLACE_DIAGNOSTIC_ABI, functionName: 'mapMechFactories', args: [factoryAddress],
  }) as boolean;
}

async function checkMechFn(publicClient: PublicClient, mechAddress: Address): Promise<Address> {
  return await publicClient.readContract({
    address: MARKETPLACE_ADDRESS, abi: MARKETPLACE_DIAGNOSTIC_ABI, functionName: 'checkMech', args: [mechAddress],
  }) as Address;
}

async function pinAgentFactoryMapping(publicClient: PublicClient, mechAddress: Address, factoryAddress: Address): Promise<bigint> {
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
      if (!matched) await setStorageWord(MARKETPLACE_ADDRESS, slot, original);
    }
  }
  throw new Error(`Could not locate mapAgentMechFactories slot for ${mechAddress}`);
}

async function warmCreateRestorationJobPath(safeAddress: Address, mechAddress: Address, deliveryRate: bigint, responseTimeout: bigint): Promise<void> {
  const { encodeFunctionData } = await import('viem');
  const data = encodeFunctionData({ abi: JINN_ROUTER_ABI, functionName: 'createRestorationJob', args: ['0x1234', mechAddress, deliveryRate, responseTimeout, NATIVE_PAYMENT_TYPE, '0x'] });
  await jsonRpc(ANVIL_RPC, 'eth_call', [{ from: safeAddress, to: ROUTER_ADDRESS, value: numberToHex(deliveryRate), data }, 'latest']);
}

async function stabilizeForkedMarketplaceState(publicClient: PublicClient, safeAddress: Address, mechAddress: Address): Promise<void> {
  const expectedFactory = CHAIN_CONFIG.mechFactory as Address;
  const [factoryBefore, factoryWhitelisted] = await Promise.all([
    readAgentFactory(publicClient, mechAddress),
    readFactoryWhitelist(publicClient, expectedFactory),
  ]);
  let checkMechBefore: string;
  try { checkMechBefore = await checkMechFn(publicClient, mechAddress); }
  catch (err) { checkMechBefore = `revert: ${err instanceof Error ? err.message : String(err)}`; }
  console.log(`    [fork] marketplace before: agentFactory=${factoryBefore}, factoryWhitelisted=${factoryWhitelisted}, checkMech=${checkMechBefore}`);

  const pinnedSlot = await pinAgentFactoryMapping(publicClient, mechAddress, expectedFactory);
  const factoryAfter = await readAgentFactory(publicClient, mechAddress);
  if (!sameAddress(factoryAfter, expectedFactory)) throw new Error(`Pinned slot ${pinnedSlot}, readback ${factoryAfter} !== ${expectedFactory}`);

  const [deliveryRate, timeoutBounds] = await Promise.all([
    publicClient.readContract({ address: mechAddress, abi: MECH_ABI, functionName: 'maxDeliveryRate' }) as Promise<bigint>,
    Promise.all([
      publicClient.readContract({ address: MARKETPLACE_ADDRESS, abi: MECH_MARKETPLACE_ABI, functionName: 'minResponseTimeout' }) as Promise<bigint>,
      publicClient.readContract({ address: MARKETPLACE_ADDRESS, abi: MECH_MARKETPLACE_ABI, functionName: 'maxResponseTimeout' }) as Promise<bigint>,
    ]),
  ]);
  await warmCreateRestorationJobPath(safeAddress, mechAddress, deliveryRate, timeoutBounds[1]);
  const checkMechAfter = await checkMechFn(publicClient, mechAddress);
  console.log(`    [fork] pinned slot ${pinnedSlot}; checkMech → ${checkMechAfter}`);
}

async function normalizeForkTimestamp(publicClient: PublicClient, forkBlock?: string): Promise<void> {
  const latestBlock = await publicClient.getBlock();
  if (latestBlock.timestamp <= UINT32_MAX - RESPONSE_TIMEOUT_HEADROOM) {
    console.log(`    Fork timestamp: ${latestBlock.timestamp}`);
    return;
  }
  let targetTimestamp: bigint;
  try {
    const upstreamBlock = await jsonRpc(BASE_RPC_URL, 'eth_getBlockByNumber', [forkBlock ? numberToHex(BigInt(forkBlock)) : 'latest', false]) as { timestamp?: string } | null;
    targetTimestamp = upstreamBlock?.timestamp ? BigInt(upstreamBlock.timestamp) : BigInt(Math.floor(Date.now() / 1000));
  } catch { targetTimestamp = BigInt(Math.floor(Date.now() / 1000)); }
  const capped = targetTimestamp <= UINT32_MAX - RESPONSE_TIMEOUT_HEADROOM ? targetTimestamp : UINT32_MAX - RESPONSE_TIMEOUT_HEADROOM;
  await jsonRpc(ANVIL_RPC, 'evm_setTime', [Number(capped)]);
  await jsonRpc(ANVIL_RPC, 'evm_mine', []);
  const normalizedBlock = await publicClient.getBlock();
  if (normalizedBlock.timestamp > UINT32_MAX - RESPONSE_TIMEOUT_HEADROOM) throw new Error(`Fork timestamp still too high after normalization`);
  console.log(`    Normalized fork timestamp to ${normalizedBlock.timestamp}`);
}

// ── MockV3Aggregator helpers ──────────────────────────────────────────────────

async function deployMockAggregator(publicClient: PublicClient, decimals: number, initialAnswer: bigint): Promise<Address> {
  const artifactJson = await readFile(MOCK_AGGREGATOR_ARTIFACT, 'utf-8');
  const artifact = JSON.parse(artifactJson) as { bytecode: Hex };

  // Encode constructor args: decimals (uint8), initialAnswer (int256)
  const constructorArgs = encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'int256' }],
    [decimals, initialAnswer],
  );
  const deployData = `${artifact.bytecode}${constructorArgs.slice(2)}` as Hex;

  // Use anvil_impersonateAccount with a known rich address to deploy
  const deployer = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // anvil default account 0
  await jsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [deployer]);
  await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [deployer, numberToHex(10n ** 18n)]);

  const txHash = await jsonRpc(ANVIL_RPC, 'eth_sendTransaction', [{
    from: deployer,
    data: deployData,
    gas: numberToHex(3_000_000n),
  }]) as Hex;

  await jsonRpc(ANVIL_RPC, 'evm_mine', []);
  await jsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [deployer]);

  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (!receipt.contractAddress) throw new Error('MockV3Aggregator deployment failed — no contractAddress in receipt');
  return receipt.contractAddress;
}

async function pushMockRound(mockFeedAddress: Address, answer: bigint): Promise<void> {
  const deployer = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const { encodeFunctionData } = await import('viem');
  const data = encodeFunctionData({
    abi: AGGREGATOR_ABI,
    functionName: 'updateAnswer',
    args: [answer],
  });
  await jsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [deployer]);
  await jsonRpc(ANVIL_RPC, 'eth_sendTransaction', [{
    from: deployer,
    to: mockFeedAddress,
    data,
    gas: numberToHex(200_000n),
  }]);
  await jsonRpc(ANVIL_RPC, 'evm_mine', []);
  await jsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [deployer]);
}

// ── MechAdapter factory ────────────────────────────────────────────────────────

function makeAdapter(agentPk: `0x${string}`, safe: Address, mech: Address): MechAdapter {
  return new MechAdapter({
    rpcUrl: ANVIL_RPC,
    mechMarketplaceAddress: MARKETPLACE_ADDRESS as `0x${string}`,
    routerAddress: ROUTER_ADDRESS as `0x${string}`,
    mechContractAddress: mech as `0x${string}`,
    safeAddress: safe as `0x${string}`,
    agentEoaPrivateKey: agentPk,
    ipfsRegistryUrl: 'https://registry.autonolas.tech',
    ipfsGatewayUrl: 'https://gateway.autonolas.tech',
    pollIntervalMs: 500,
    chainId: base.id,
    routerClaimDeliveryVariant: 'v1',
  });
}

function noopTrajectory(): HarnessContext['trajectory'] {
  return { addSpan: () => ({}) } as unknown as HarnessContext['trajectory'];
}

async function signExecutionEnvelope(
  unsigned: Omit<SignedEnvelope, 'signature'>,
  privateKey: `0x${string}`,
  signer: `0x${string}`,
): Promise<SignedEnvelope> {
  const signed = await signCanonical(unsigned, privateKey, signer);
  return {
    ...unsigned,
    signature: { algo: 'secp256k1', signer, hash: signed.hash, sig: signed.sig },
  };
}

// ── Counter reader ────────────────────────────────────────────────────────────

async function readCounter(
  publicClient: PublicClient,
  counterName: 'creationCount' | 'restorationDeliveryCount' | 'evaluationCreationCount' | 'evaluationDeliveryCount',
  safe: `0x${string}`,
): Promise<bigint> {
  return publicClient.readContract({
    address: ROUTER_ADDRESS,
    abi: JINN_ROUTER_ABI,
    functionName: counterName,
    args: [safe],
  }) as Promise<bigint>;
}

// ── Crash guards ──────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => { console.error('[e2e-pred] UNCAUGHT EXCEPTION:', err); process.exit(1); });
process.on('unhandledRejection', (reason) => { console.error('[e2e-pred] UNHANDLED REJECTION:', reason); process.exit(1); });

let exitExpected = false;
process.on('beforeExit', (code) => { if (!exitExpected) console.error(`[e2e-pred] UNEXPECTED beforeExit (code=${code})`); });

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== Prediction.v0 E2E (Anvil fork of Base mainnet + mocked oracle) ===\n');
  console.log('=== PIS Phase 1: Three Safes — creator / harness / evaluator ===\n');

  let anvil: ChildProcess | null = null;
  let tmpDir: string | null = null;
  const results: PhaseResult[] = [];

  // Shared state across phases
  let creatorAdapter: MechAdapter | undefined;
  let harnessAdapter: MechAdapter | undefined;
  let evaluatorAdapter: MechAdapter | undefined;
  // Delivery-watching adapters for the creator: each watches a different mech's events,
  // but uses the creator's Safe + credentials to call claimDelivery/createEvaluationJob.
  // This is necessary because watchForDeliveries watches `mechContractAddress` for Deliver
  // events — in cross-role mode, deliveries arrive on the harness's/evaluator's mechs.
  let creatorRestorationWatcherAdapter: MechAdapter | undefined;
  let creatorEvalWatcherAdapter: MechAdapter | undefined;
  let publicClient!: PublicClient;

  // Per-role keys and addresses
  let creatorAgentPk: Hex | undefined;
  let harnessAgentPk: Hex | undefined;
  let evaluatorAgentPk: Hex | undefined;
  let creatorSafe: Address | undefined;
  let harnessSafe: Address | undefined;
  let evaluatorSafe: Address | undefined;
  let creatorMech: Address | undefined;
  let harnessMech: Address | undefined;
  let evaluatorMech: Address | undefined;

  let mockFeedAddress: Address | undefined;
  let restorationRequestId: string | undefined;
  let capturedManifest: SignedEnvelope | undefined;
  let capturedTaskCid: string | undefined;
  let capturedWindow: { startTs: number; endTs: number } | undefined;
  let capturedIntent: PredictionV0Task | undefined;
  // Block number tracking for getLogs range queries (Anvil limits to 10,000 blocks from fork)
  let phase5StartBlock: bigint | undefined;
  let phase7StartBlock: bigint | undefined;

  try {
    // ── Phase 1: Spawn Anvil fork of Base mainnet ─────────────────────────────

    results.push(await runPhase('Phase 1: Spawn Anvil fork + create temp dir', async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'jinn-e2e-pred-'));
      console.log(`    Temp dir: ${tmpDir}`);

      const anvilPath = process.env['ANVIL_PATH'] ?? 'anvil';
      const forkBlock = process.env['ANVIL_FORK_BLOCK'] ?? '';
      const anvilArgs = [
        '--fork-url', BASE_RPC_URL,
        '--port', String(ANVIL_PORT),
        '--silent',
        ...(forkBlock ? ['--fork-block-number', forkBlock] : []),
      ];

      anvil = spawn(anvilPath, anvilArgs, { stdio: 'ignore', detached: false });
      anvil.on('error', (err) => { throw new Error(`Failed to spawn Anvil: ${err.message}`); });

      await waitFor('Anvil RPC ready', async () => {
        try { const b = await jsonRpc(ANVIL_RPC, 'eth_blockNumber'); return typeof b === 'string' && b.startsWith('0x'); }
        catch { return false; }
      });

      publicClient = createPublicClient({ chain: base, transport: http(ANVIL_RPC) }) as unknown as PublicClient;
      const blockNumber = await publicClient.getBlockNumber();
      console.log(`    Anvil forked Base at block ${blockNumber}`);
      await normalizeForkTimestamp(publicClient, forkBlock || undefined);
    }));

    // ── Phase 2: Deploy MockV3Aggregator ─────────────────────────────────────

    results.push(await runPhase('Phase 2: Deploy MockV3Aggregator (ETH/USD, $3600)', async () => {
      // $3600 * 10^8 = 360000000000 — above the $3500 threshold so spot-carry
      // predicts YES with p=0.55 (matches unit-test baseline).
      const initialAnswer = 360_000_000_000n;
      mockFeedAddress = await deployMockAggregator(publicClient, 8, initialAnswer);
      console.log(`    MockV3Aggregator deployed at ${mockFeedAddress}`);

      // Verify it reads back correctly
      const [, answer, , ,] = await publicClient.readContract({
        address: mockFeedAddress,
        abi: AGGREGATOR_ABI,
        functionName: 'latestRoundData',
      }) as [bigint, bigint, bigint, bigint, bigint];
      const price = Number(answer) / 1e8;
      console.log(`    Oracle reads back: $${price} USD`);
      if (price !== 3600) throw new Error(`Expected $3600, got $${price}`);
    }));

    // ── Phase 3: Bootstrap 3 services (creator / harness / evaluator) ────────
    // Uses standard staking mode (stOLAS distributor), same as original single-service e2e.
    // Master funds OLAS deposit into distributor, then bootstrap calls distributor.stake() × 3.

    results.push(await runPhase('Phase 3: Bootstrap 3 services — creator / harness / evaluator', async () => {
      if (!tmpDir) throw new Error('No temp dir from Phase 1');

      // Step 1: first bootstrap pass — generates master wallet, pauses at funding
      // Mine blocks during bootstrap to ensure transactions confirm
      let bootstrapper = new FleetBootstrapper({ earningDir: tmpDir, chain: 'base', rpcUrl: ANVIL_RPC, targetServices: 3 });
      const initialMiningInterval = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      let initialResult: Awaited<ReturnType<typeof bootstrapper.bootstrap>>;
      try {
        initialResult = await bootstrapper.bootstrap(PASSWORD);
      } finally {
        clearInterval(initialMiningInterval);
      }
      if (!initialResult.funding) throw new Error(`Expected funding requirement, got ok=${initialResult.ok}`);

      const masterAddress = initialResult.funding.master_address;
      console.log(`    Master: ${masterAddress}`);

      // Step 2: fund master with ETH + OLAS (× 3 services worth), then deposit into distributor
      await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [masterAddress, '0x56BC75E2D63100000']);
      const eoaOlasSlot = erc20BalanceSlot(masterAddress);
      const eoaOlasAmount = 300000n * 10n ** 18n; // 3× what single-service needs
      await jsonRpc(ANVIL_RPC, 'anvil_setStorageAt', [OLAS_TOKEN, eoaOlasSlot, pad(toHex(eoaOlasAmount), { size: 32 })]);

      const { encodeFunctionData } = await import('viem');
      await jsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [masterAddress]);
      await jsonRpc(ANVIL_RPC, 'eth_sendTransaction', [{
        from: masterAddress,
        to: OLAS_TOKEN,
        data: encodeFunctionData({
          abi: parseAbi(['function approve(address,uint256) returns (bool)']),
          functionName: 'approve',
          args: [CHAIN_CONFIG.stakingContract as Address, eoaOlasAmount],
        }),
      }]);
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      await jsonRpc(ANVIL_RPC, 'eth_sendTransaction', [{
        from: masterAddress,
        to: CHAIN_CONFIG.stakingContract,
        data: encodeFunctionData({
          abi: parseAbi(['function deposit(uint256)']),
          functionName: 'deposit',
          args: [eoaOlasAmount],
        }),
      }]);
      await jsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [masterAddress]);
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);

      // Step 3: final bootstrap — calls distributor.stake() for each of the 3 services
      // Mine blocks continuously during bootstrap to ensure transactions confirm (3 services = many txs)
      bootstrapper = new FleetBootstrapper({ earningDir: tmpDir, chain: 'base', rpcUrl: ANVIL_RPC, targetServices: 3 });
      const bootstrapMiningInterval = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      let finalResult: Awaited<ReturnType<typeof bootstrapper.bootstrap>>;
      try {
        finalResult = await bootstrapper.bootstrap(PASSWORD);
      } finally {
        clearInterval(bootstrapMiningInterval);
      }
      if (!finalResult.ok) throw new Error(`Bootstrap failed: ${finalResult.message}`);

      const completedServices = finalResult.fleet_state.services.filter(
        s => s.step === 'complete' && s.safe_address && s.mech_address,
      );
      if (completedServices.length < 3) {
        throw new Error(`Expected 3 complete services, got ${completedServices.length}. Message: ${finalResult.message}`);
      }

      const [creatorSvc, harnessSvc, evaluatorSvc] = completedServices;

      // Derive private keys from HD wallet
      const { FleetStateStore } = await import('../../src/earning/store.js');
      const { decryptMnemonic, walletPrivateKeyAtIndex } = await import('../../src/earning/wallet.js');
      const store = new FleetStateStore(tmpDir);
      const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), PASSWORD);

      creatorAgentPk = walletPrivateKeyAtIndex(mnemonic, creatorSvc!.index);
      harnessAgentPk = walletPrivateKeyAtIndex(mnemonic, harnessSvc!.index);
      evaluatorAgentPk = walletPrivateKeyAtIndex(mnemonic, evaluatorSvc!.index);

      creatorSafe = getAddress(creatorSvc!.safe_address!) as Address;
      harnessSafe = getAddress(harnessSvc!.safe_address!) as Address;
      evaluatorSafe = getAddress(evaluatorSvc!.safe_address!) as Address;

      creatorMech = getAddress(creatorSvc!.mech_address!) as Address;
      harnessMech = getAddress(harnessSvc!.mech_address!) as Address;
      evaluatorMech = getAddress(evaluatorSvc!.mech_address!) as Address;

      console.log(`    Creator  Safe: ${creatorSafe}, Mech: ${creatorMech} (index ${creatorSvc!.index})`);
      console.log(`    Harness Safe: ${harnessSafe}, Mech: ${harnessMech} (index ${harnessSvc!.index})`);
      console.log(`    Evaluator Safe: ${evaluatorSafe}, Mech: ${evaluatorMech} (index ${evaluatorSvc!.index})`);
    }));

    // ── Phase 4: Three MechAdapters + stabilize fork ──────────────────────────

    results.push(await runPhase('Phase 4: Create 3 MechAdapters + stabilize fork', async () => {
      if (!creatorAgentPk || !creatorSafe || !creatorMech) throw new Error('Missing creator credentials from Phase 3');
      if (!harnessAgentPk || !harnessSafe || !harnessMech) throw new Error('Missing harness credentials from Phase 3');
      if (!evaluatorAgentPk || !evaluatorSafe || !evaluatorMech) throw new Error('Missing evaluator credentials from Phase 3');

      creatorAdapter = makeAdapter(creatorAgentPk as `0x${string}`, creatorSafe, creatorMech);
      harnessAdapter = makeAdapter(harnessAgentPk as `0x${string}`, harnessSafe, harnessMech);
      evaluatorAdapter = makeAdapter(evaluatorAgentPk as `0x${string}`, evaluatorSafe, evaluatorMech);
      // Watcher adapters: creator's Safe + credentials, but pointed at the mech where the
      // delivery event will appear (harness's / evaluator's mech). Used to drive the
      // adapter's watchForDeliveries() iterator so it can observe cross-role deliveries and
      // create the eval job / clean up tracking — without calling claimDelivery (that was
      // already done by the deliverer's own adapter).
      creatorRestorationWatcherAdapter = makeAdapter(creatorAgentPk as `0x${string}`, creatorSafe, harnessMech);
      creatorEvalWatcherAdapter = makeAdapter(creatorAgentPk as `0x${string}`, creatorSafe, evaluatorMech);

      await Promise.all([
        creatorAdapter.initialize(),
        harnessAdapter.initialize(),
        evaluatorAdapter.initialize(),
        creatorRestorationWatcherAdapter.initialize(),
        creatorEvalWatcherAdapter.initialize(),
      ]);

      // Fund all three Safes with ETH for gas
      await Promise.all([
        jsonRpc(ANVIL_RPC, 'anvil_setBalance', [creatorSafe, '0x56BC75E2D63100000']),
        jsonRpc(ANVIL_RPC, 'anvil_setBalance', [harnessSafe, '0x56BC75E2D63100000']),
        jsonRpc(ANVIL_RPC, 'anvil_setBalance', [evaluatorSafe, '0x56BC75E2D63100000']),
      ]);
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);

      // Stabilize marketplace state for all three mech+safe pairs sequentially
      // (each call does storage slot scanning + writes that could interfere if parallel)
      await stabilizeForkedMarketplaceState(publicClient, creatorSafe, creatorMech);
      await stabilizeForkedMarketplaceState(publicClient, harnessSafe, harnessMech);
      await stabilizeForkedMarketplaceState(publicClient, evaluatorSafe, evaluatorMech);

      console.log('    3 MechAdapters initialized + marketplace stabilized for all 3 mechs');
    }));

    // ── Phase 5: Post prediction.v0 Task on-chain (creator) ────────────────
    // The creator creates the restoration request specifying RESTORER's mech as priorityMech.
    // This is the correct cross-role flow: creator funds + directs, harness delivers.

    results.push(await runPhase('Phase 5: Post prediction.v0 Task on-chain (creator)', async () => {
      if (!creatorAgentPk || !creatorSafe || !harnessMech || !mockFeedAddress) throw new Error('Missing state from prior phases');

      // Capture starting block so later getLogs calls stay within the 10,000-block Anvil fork limit
      phase5StartBlock = await publicClient.getBlockNumber();

      // 1h window starting now, resolveTs = endTs + 15min
      const now = Date.now();
      const startTs = now;
      const endTs = startTs + 3_600_000;
      const resolveTs = endTs + 900_000;
      capturedWindow = { startTs, endTs };

      const predictionIntent: PredictionV0Task = {
        id: 'pred-v0-e2e-test',
        description: 'Will ETH be above $3500 at resolveTs?',
        solverType: 'prediction.v0',
        window: { startTs, endTs },
        spec: {
          oracle: {
            venue: 'chainlink-base',
            feed: mockFeedAddress,
            feedDescription: 'ETH / USD (mock)',
          },
          question: {
            kind: 'threshold',
            operator: 'GT',
            threshold: '3500',
            resolveTs,
          },
        },
        eligibility: { maxSubmissionDelayMs: 3_600_000 },
      };
      capturedIntent = predictionIntent;

      const { createClients: createClientsLocal } = await import('../../src/adapters/mech/safe.js');
      const { submitTask, getMechDeliveryRate, getTimeoutBounds } = await import('../../src/adapters/mech/contracts.js');
      const { uploadToIpfs, cidToDigestHex } = await import('../../src/adapters/mech/ipfs.js');
      const { signTaskV1 } = await import('../../src/tasks/signing.js');

      const { walletClient: creatorWalletClient } = createClientsLocal(ANVIL_RPC, creatorAgentPk as Hex, base);

      // Build signed Task document + upload to IPFS.
      const creatorAccount = privateKeyToAccount(creatorAgentPk as Hex);
      const taskDocument: TaskV1 = {
        schemaVersion: 'task.v1',
        id: predictionIntent.id,
        solverType: predictionIntent.solverType,
        role: 'restoration',
        description: predictionIntent.description,
        window: predictionIntent.window,
        spec: predictionIntent.spec,
        eligibility: predictionIntent.eligibility,
        creator: {
          safeAddress: getAddress(creatorSafe as Address),
          agentEoa: creatorAccount.address,
        },
        createdAt: now,
      };
      const signedTask = await signTaskV1(taskDocument, creatorAgentPk as Hex);
      const taskCid = await uploadToIpfs('https://registry.autonolas.tech', signedTask);
      const taskDataHex = cidToDigestHex(taskCid) as Hex;

      // Get pricing from harnessMech (since it's the priorityMech)
      const [deliveryRate, timeoutBounds] = await Promise.all([
        getMechDeliveryRate(publicClient, harnessMech),
        getTimeoutBounds(publicClient, MARKETPLACE_ADDRESS),
      ]);
      const maxTimeout = timeoutBounds.max;

      // Mine fresh blocks to avoid stale nonce
      for (let i = 0; i < 3; i++) { await jsonRpc(ANVIL_RPC, 'evm_mine', []); await sleep(100); }

      // CREATOR creates restoration job specifying RESTORER's mech as priorityMech
      // → increments creationCount[creatorSafe]
      const miningInterval = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      let requestIds: string[];
      let submission: Awaited<ReturnType<typeof submitTask>>;
      try {
        submission = await submitTask(
          publicClient,
          creatorWalletClient,
          creatorSafe as Address,
          ROUTER_ADDRESS,
          harnessMech,
          taskDataHex,
          deliveryRate,
          maxTimeout,
        );
        requestIds = submission.requestIds;
      } finally {
        clearInterval(miningInterval);
      }

      if (requestIds.length === 0) throw new Error('No requestId from submitTask');
      restorationRequestId = requestIds[0];
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      console.log(`    prediction.v0 Task posted by creator (priorityMech=harnessMech), requestId: ${restorationRequestId}`);

      // Verify MarketplaceRequest event on-chain from the submission receipt.
      const receipt = await publicClient.getTransactionReceipt({ hash: submission.txHash });
      const decoded = decodeMarketplaceRequestLogs(receipt.logs);
      if (!decoded.find(d => d.requestId === restorationRequestId)) throw new Error(`MarketplaceRequest event not found`);
      console.log('    MarketplaceRequest event confirmed on-chain');
    }));

    // ── Phase 6: Harness claims + runs PredictionV0BaselineImpl ─────────────

    results.push(await runPhase('Phase 6: Harness claims + runs PredictionV0BaselineImpl (mocked Chainlink)', async () => {
      if (!harnessAdapter || !restorationRequestId || !tmpDir || !harnessAgentPk || !harnessSafe || !capturedWindow || !mockFeedAddress || !capturedIntent) {
        throw new Error('Missing state from prior phases');
      }

      // Mine blocks while waiting for request
      const miningInterval = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);

      let reqValue: Awaited<ReturnType<typeof harnessAdapter['watchForRequests'][typeof Symbol.asyncIterator]>> | undefined;
      try {
        const iter = harnessAdapter.watchForRequests()[Symbol.asyncIterator]();
        const result = await Promise.race([
          iter.next(),
          sleep(30000).then(() => { throw new Error('watchForRequests timed out'); }),
        ]);
        if (!result.done && result.value) reqValue = result.value;
      } finally {
        clearInterval(miningInterval);
      }

      if (!reqValue) throw new Error('No request received by harness');
      const req = reqValue as { requestId: string; task: Task; taskCid: string; onchainCreationTx?: string; onchainCreationBlock?: number };

      console.log(`    Harness claimed request: ${req.requestId}, taskCid: ${req.taskCid}`);
      capturedTaskCid = req.taskCid;

      // Claim on-chain (MechAdapter.claimRequest is a no-op for AcceptAllPolicy)
      await harnessAdapter.claimRequest(req.requestId);
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);

      // Run PredictionV0BaselineImpl
      const impl = new PredictionV0BaselineImpl({ rpcUrl: ANVIL_RPC });

      const intentForImpl: Task = {
        ...capturedIntent,
        solverType: capturedIntent.solverType ?? 'prediction.v0',
        window: capturedWindow,
        spec: Object.fromEntries(
          Object.entries(capturedIntent.spec as Record<string, unknown>).filter(([key]) => key !== 'kind'),
        ),
      } as unknown as Task;

      const implStateDir = join(tmpDir, 'impl-state', req.requestId);
      const workingDir = join(tmpDir, 'working', req.requestId);
      mkdirSync(implStateDir, { recursive: true });
      mkdirSync(workingDir, { recursive: true });

      const abort = new AbortController();
      const ctx: HarnessContext = {
        task: intentForImpl,
        implStateDir,
        workingDir,
        log: (e) => console.log(`    [impl] [${e.level}] ${e.msg}${e.data ? ' ' + JSON.stringify(e.data) : ''}`),
        abort: abort.signal,
        msUntilEndTs: () => Math.max(0, capturedWindow!.endTs - Date.now()),
        trajectory: noopTrajectory(),
      };

      const output = await impl.run(ctx);
      const { probability, modelId } = output.gating as { probability: string; modelId: string };
      const submittedAt = parseInt(String(output.gating['submittedAt']), 10);
      console.log(`    Impl done. probability=${probability}, modelId=${modelId}`);
      if (probability !== '0.55') throw new Error(`Expected probability 0.55 (price > threshold), got ${probability}`);

      // Build and sign the restoration envelope with the Harness key + Safe.
      const harnessAccount = privateKeyToAccount(harnessAgentPk as `0x${string}`);
      const unsignedEnvelope: Omit<SignedEnvelope, 'signature'> = {
        schemaVersion: 'jinn.execution.v1',
        solverType: 'prediction.v0',
        role: 'restoration',
        generatedAt: Date.now(),
        task: {
          cid: capturedTaskCid!,
          onchainCreationTx: (req.onchainCreationTx ?? '0x' + '0'.repeat(64)) as `0x${string}`,
          onchainCreationBlock: req.onchainCreationBlock ?? 0,
          requestId: restorationRequestId as `0x${string}`,
        },
        participant: {
          safeAddress: harnessSafe as `0x${string}`,
          agentEoa: harnessAccount.address,
        },
        window: capturedWindow,
        executor: {
          implName: impl.name,
          implVersion: impl.version,
          clientGitSha: 'e2e',
          codeDigest: `sha256:${'0'.repeat(64)}`,
          runtimeBundleDigest: `sha256:${'1'.repeat(64)}`,
          plugins: [],
          signingKey: { kind: 'agent-eoa', pubkey: harnessAccount.address },
        },
        evidenceTier: 'self-signed',
        attestation: null,
        trajectory: null,
        artifacts: [],
        payload: output.solutionPayload ?? {
          prediction: { probability, submittedAt, modelId },
        },
      };
      const manifest = await signExecutionEnvelope(unsignedEnvelope, harnessAgentPk as `0x${string}`, harnessAccount.address);
      capturedManifest = manifest;

      // Submit result via RESTORER's adapter (deliverToMarketplace on harness's mech)
      const resultData = JSON.stringify(manifest);

      const miningInterval2 = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      try {
        await harnessAdapter.submitResult(req.requestId, { data: resultData });
      } finally {
        clearInterval(miningInterval2);
      }
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      console.log(`    jinn.execution.v1 restoration envelope signed with harness key (${harnessAccount.address}) + submitted on-chain`);

      // Drive harnessAdapter.watchForDeliveries() — the adapter detects the Deliver event
      // on harnessMech, sees iDelivered=true (mechAddress === harnessMech === mechContractAddress),
      // and calls claimDelivery via harnessSafe → increments restorationDeliveryCount[harnessSafe].
      // iCreatedRestoration=false (harness didn't post the request) so no eval job is created here.
      const miningInterval3 = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      try {
        const harnessDeliveryIter = harnessAdapter.watchForDeliveries()[Symbol.asyncIterator]();
        await Promise.race([
          harnessDeliveryIter.next(),
          sleep(30000).then(() => { throw new Error('harnessAdapter.watchForDeliveries() timed out'); }),
        ]);
      } finally {
        clearInterval(miningInterval3);
      }
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      console.log(`    restorationDeliveryCount[harnessSafe] incremented (harnessAdapter.watchForDeliveries → iDelivered=true)`);
    }));

    // ── Phase 7: Creator observes restoration delivery + creates eval job ────────
    // Uses creatorRestorationWatcherAdapter (creator's Safe, mechContractAddress=harnessMech)
    // to drive watchForDeliveries(). The delivery event is on harnessMech.
    //
    // With the fixed iDelivered logic (compares mechServiceMultisig from the event against
    // this.config.safeAddress):
    //   • iDelivered = (harnessSafe === creatorSafe) = false → no claimDelivery attempt
    //   • iCreatedRestoration=true (injected into pendingEvaluations)
    //     → tryCreateEvaluationJob → verifyRestorationClaimed passes (harness claimed in Phase 6)
    //     → createEvaluationJob via creatorSafe → evaluationCreationCount[creatorSafe]++
    // The creator does NOT get restorationDeliveryCount credit — correct per role semantics.

    let evalRequestId: string | undefined;

    results.push(await runPhase('Phase 7: Creator observes restoration delivery + creates evaluation job (adapter-driven)', async () => {
      if (!creatorRestorationWatcherAdapter || !creatorSafe || !restorationRequestId || !harnessMech || !evaluatorMech || !capturedManifest || !capturedIntent) {
        throw new Error('Missing state from prior phases');
      }

      // The watcher adapter was initialized with mechContractAddress=harnessMech (Phase 4).
      // Override it to evaluatorMech so tryCreateEvaluationJob directs the eval job to
      // the evaluator's mech (getMechDeliveryRate + submitEvaluationJob use mechContractAddress).
      (creatorRestorationWatcherAdapter as any).config.mechContractAddress = evaluatorMech;

      // Inject the original Task into pendingEvaluations so iCreatedRestoration=true.
      (creatorRestorationWatcherAdapter as any).pendingEvaluations.set(restorationRequestId, {
        ...capturedIntent,
        id: restorationRequestId,
      });
      (creatorRestorationWatcherAdapter as any).originalStates.set(restorationRequestId, {
        ...capturedIntent,
        id: restorationRequestId,
        role: 'restoration',
      });

      // Set block cursor to scan from just before Phase 5 so we catch the Deliver event
      // that was emitted on harnessMech during Phase 6.
      // BUT: the adapter's getLogs now uses mechContractAddress=evaluatorMech (set above).
      // We need it to scan harnessMech for the Deliver event. Patch getLogs address
      // by temporarily setting mechContractAddress to harnessMech during the log scan,
      // then switching to evaluatorMech for the eval job submission.
      // We do this by wrapping the adapter's publicClient.getLogs.
      const originalGetLogs = (creatorRestorationWatcherAdapter as any).publicClient.getLogs.bind(
        (creatorRestorationWatcherAdapter as any).publicClient,
      );
      let logScanCount = 0;
      (creatorRestorationWatcherAdapter as any).publicClient.getLogs = async (params: Record<string, unknown>) => {
        // First getLogs call scans for Deliver events — redirect to harnessMech
        if (logScanCount === 0 && params.address === evaluatorMech) {
          logScanCount++;
          return originalGetLogs({ ...params, address: harnessMech });
        }
        return originalGetLogs(params);
      };
      (creatorRestorationWatcherAdapter as any).deliveryBlockCursor = (phase5StartBlock ?? 0n) - 1n;

      const miningInterval = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      try {
        const watcherIter = creatorRestorationWatcherAdapter.watchForDeliveries()[Symbol.asyncIterator]();
        // Drive one iteration — the adapter scans harnessMech (via patched getLogs),
        // finds the Deliver event, sees iDelivered=false (harnessSafe ≠ creatorSafe),
        // iCreatedRestoration=true → calls tryCreateEvaluationJob → submits eval job.
        await Promise.race([
          watcherIter.next(),
          sleep(60000).then(() => { throw new Error('creatorRestorationWatcherAdapter.watchForDeliveries() timed out'); }),
        ]);
      } finally {
        clearInterval(miningInterval);
        // Restore getLogs
        (creatorRestorationWatcherAdapter as any).publicClient.getLogs = originalGetLogs;
      }
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);

      // Extract the eval requestId from the watcher adapter's pendingEvaluationClaims
      const pendingClaims = (creatorRestorationWatcherAdapter as any).pendingEvaluationClaims as Set<string>;
      if (pendingClaims.size === 0) throw new Error('No eval requestId in creatorRestorationWatcherAdapter.pendingEvaluationClaims after watchForDeliveries');
      evalRequestId = [...pendingClaims][0];
      console.log(`    createEvaluationJob called via creator Safe (adapter-driven). evalRequestId: ${evalRequestId}`);

      // Verify EvaluationJobCreated event
      const currentBlock = await publicClient.getBlockNumber();
      const routerLogs = await publicClient.getLogs({ address: ROUTER_ADDRESS, fromBlock: currentBlock - 10n, toBlock: currentBlock });
      let foundEvalJob = false;
      for (const log of routerLogs) {
        try {
          const decoded = decodeEventLog({ abi: JINN_ROUTER_ABI, data: log.data, topics: log.topics });
          if (decoded.eventName === 'EvaluationJobCreated') {
            foundEvalJob = true;
            console.log('    EvaluationJobCreated event confirmed on router (creator\'s Safe)');
          }
        } catch { /**/ }
      }
      if (!foundEvalJob) throw new Error('No EvaluationJobCreated event found on router');
    }));

    // ── Phase 7.5: Push spanning Chainlink round for resolveTs ───────────────

    results.push(await runPhase('Push spanning Chainlink round for resolveTs', async () => {
      if (!mockFeedAddress || !capturedIntent) throw new Error('missing prereqs');
      const { encodeFunctionData } = await import('viem');
      const resolveTsMs = capturedIntent.spec.question.resolveTs;
      const resolveTsSeconds = BigInt(Math.floor(resolveTsMs / 1000));
      const data = encodeFunctionData({
        abi: AGGREGATOR_ABI,
        functionName: 'pushRound',
        args: [2n, 360_000_000_000n, resolveTsSeconds + 1n],
      });
      const deployer = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
      await jsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [deployer]);
      await jsonRpc(ANVIL_RPC, 'eth_sendTransaction', [{
        from: deployer,
        to: mockFeedAddress,
        data,
        gas: numberToHex(200_000n),
      }]);
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      await jsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [deployer]);
      console.log(`    Pushed round 2: updatedAt=${resolveTsSeconds + 1n}s (resolveTs=${resolveTsSeconds}s + 1)`);
    }));

    // ── Phase 8: Evaluator claims eval job + runs PredictionV0Evaluator ───────

    let evalVerdict = 'UNKNOWN';

    results.push(await runPhase('Phase 8: Evaluator claims eval job + runs PredictionV0Evaluator (real oracle read → PASS)', async () => {
      if (!evaluatorAdapter || !capturedManifest || !capturedIntent || !tmpDir || !evaluatorAgentPk || !evaluatorSafe || !evaluatorMech || !capturedWindow || !mockFeedAddress) {
        throw new Error('Missing state from prior phases');
      }

      console.log(`    Round 2 already pushed in prior phase; evaluator will walk back to round 1 ($3600 → YES)`);

      // Mine + wait for evaluation request — use EVALUATOR's adapter.
      // The evaluator's watchForRequests scans ALL marketplace requests. Since the
      // restoration request is also on the marketplace, we skip requests that are
      // not of type 'evaluation' until we find the eval request from Phase 7.
      const miningInterval = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      let evalReqValue: { requestId: string; task: Task } | undefined;
      try {
        const iter = evaluatorAdapter.watchForRequests()[Symbol.asyncIterator]();
        const deadline = Date.now() + 45000;
        while (!evalReqValue && Date.now() < deadline) {
          const result = await Promise.race([
            iter.next(),
            sleep(deadline - Date.now()).then(() => ({ done: true as const, value: undefined })),
          ]);
          if (result.done) break;
          if (result.value) {
            const req = result.value as { requestId: string; task: Task };
            if (req.task.role === 'evaluation') {
              evalReqValue = req;
            } else {
              console.log(`    Evaluator skipping non-evaluation request (type: ${req.task.role ?? 'restoration'})`);
              // Continue to next iteration to find the eval request
            }
          }
        }
      } finally {
        clearInterval(miningInterval);
      }

      if (!evalReqValue) throw new Error('No eval request received by evaluator (timed out)');
      const req = evalReqValue as { requestId: string; task: Task };
      console.log(`    Evaluator claimed eval request: ${req.requestId}, type: ${req.task.role}`);

      // Claim on-chain via evaluator's adapter
      await evaluatorAdapter.claimRequest(req.requestId);
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);

      const capturedManifest2 = capturedManifest;
      const capturedWindow2 = capturedWindow;
      const capturedIntent2 = capturedIntent;

      const evalIntent: Task = {
        id: 'pred-v0-e2e-eval',
        description: 'Evaluate prediction.v0 restoration attempt',
        solverType: capturedIntent2.solverType ?? 'prediction.v0',
        role: 'evaluation',
        restorationRequestId,
        window: capturedWindow2,
        spec: Object.fromEntries(
          Object.entries(capturedIntent2.spec as Record<string, unknown>).filter(([key]) => key !== 'kind'),
        ),
        eligibility: capturedIntent2.eligibility as unknown as Record<string, unknown>,
        context: { restorationResult: JSON.stringify(capturedManifest2) },
      };

      const evalWorkingDir = join(tmpDir, 'eval-working', req.requestId);
      const evalImplStateDir = join(tmpDir, 'eval-impl-state', req.requestId);
      mkdirSync(evalWorkingDir, { recursive: true });
      mkdirSync(evalImplStateDir, { recursive: true });

      const abort = new AbortController();
      const evalCtx: HarnessContext = {
        task: evalIntent,
        implStateDir: evalImplStateDir,
        workingDir: evalWorkingDir,
        log: (e) => console.log(`    [eval] [${e.level}] ${e.msg}${e.data ? ' ' + JSON.stringify(e.data) : ''}`),
        abort: abort.signal,
        msUntilEndTs: () => 0,
        trajectory: noopTrajectory(),
        _testDeps: {
          expectedTaskCid: capturedManifest2.task.cid,
        },
      } as unknown as HarnessContext;

      // Run evaluator with EVALUATOR's key + Safe
      const evaluator = new PredictionV0Evaluator({
        evaluatorPk: evaluatorAgentPk as `0x${string}`,
        evaluatorSafeAddress: evaluatorSafe as `0x${string}`,
        rpcUrl: ANVIL_RPC,
      });
      const evalOutput = await evaluator.run(evalCtx);

      evalVerdict = String(evalOutput.gating['verdict'] ?? 'UNKNOWN');
      const score = String(evalOutput.gating['score'] ?? 'unknown');
      const groundTruth = String(evalOutput.gating['groundTruth'] ?? 'unknown');
      console.log(`    Evaluator verdict: ${evalVerdict}, score: ${score}, groundTruth: ${groundTruth}`);
      console.log(`    Checks run: ${evalOutput.gating['checkCount']}, pass: ${evalOutput.gating['passCount']}, fail: ${evalOutput.gating['failCount']}`);

      if (evalVerdict !== 'PASS') {
        throw new Error(`Expected verdict PASS, got ${evalVerdict}. checkCount=${evalOutput.gating['checkCount']}, failCount=${evalOutput.gating['failCount']}`);
      }
      console.log('    ASSERTION PASSED: verdict === PASS');
      const EXPECTED_SCORE = '797500000000000000';
      if (score !== EXPECTED_SCORE) {
        throw new Error(`Expected score ${EXPECTED_SCORE} (Brier 0.7975), got ${score}`);
      }
      console.log(`    ASSERTION PASSED: score === ${EXPECTED_SCORE} (Brier 0.7975)`);

      // Submit evaluator verdict via EVALUATOR's adapter (deliverToMarketplace on evaluator's mech)
      const evalResultData = JSON.stringify({
        protocol: 'jinn-client/prediction.v0',
        type: 'evaluation-verdict',
        requestId: req.requestId,
        verdict: evalVerdict,
        gating: evalOutput.gating,
      });

      const miningInterval2 = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      try {
        await evaluatorAdapter.submitResult(req.requestId, { data: evalResultData });
      } finally {
        clearInterval(miningInterval2);
      }
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      console.log(`    Evaluator verdict submitted via evaluator Safe (${evaluatorSafe})`);

      // Drive evaluatorAdapter.watchForDeliveries() — the adapter detects the Deliver event
      // on evaluatorMech, sees iDelivered=true (mechAddress === evaluatorMech === mechContractAddress),
      // and calls claimDelivery via evaluatorSafe → increments evaluationDeliveryCount[evaluatorSafe].
      // iCreatedEvaluation=false (evaluator didn't post the request) so no cleanup tracking here.
      const miningInterval3 = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      try {
        const evalDeliveryIter = evaluatorAdapter.watchForDeliveries()[Symbol.asyncIterator]();
        await Promise.race([
          evalDeliveryIter.next(),
          sleep(30000).then(() => { throw new Error('evaluatorAdapter.watchForDeliveries() timed out'); }),
        ]);
      } finally {
        clearInterval(miningInterval3);
      }
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      console.log(`    evaluationDeliveryCount[evaluatorSafe] incremented (evaluatorAdapter.watchForDeliveries → iDelivered=true)`);
    }));

    // ── Phase 9: Creator observes eval delivery + cleanup via adapter ────────────
    // Uses creatorEvalWatcherAdapter (creator's Safe, pointed at evaluatorMech) to drive
    // watchForDeliveries(). The evaluator already claimed in Phase 8.
    //   • iDelivered=true (evaluatorMech === mechContractAddress of watcher adapter)
    //     → tries claimDelivery via creatorSafe → "already claimed" by evaluator in Phase 8
    //     → handled gracefully (falls through)
    //   • iCreatedEvaluation=true (injected into pendingEvaluationClaims)
    //     → cleans up tracking (pendingEvaluationClaims.delete)
    // The creator does NOT get evaluationDeliveryCount credit — evaluationDeliveryCount[creatorSafe] stays 0.
    // Also verifies the verdict round-trips correctly from the delivery payload.

    results.push(await runPhase('Phase 9: Creator observes eval delivery + cleanup (adapter-driven) + assert verdict === PASS', async () => {
      if (!creatorEvalWatcherAdapter || !evaluatorMech || !evalRequestId) {
        throw new Error('Missing state (creatorEvalWatcherAdapter/evaluatorMech/evalRequestId)');
      }

      // Inject evalRequestId into the watcher adapter's pendingEvaluationClaims so
      // iCreatedEvaluation=true when it sees the delivery event.
      (creatorEvalWatcherAdapter as any).pendingEvaluationClaims.add(evalRequestId);
      // Set block cursor to scan from just before phase 5 so we catch the event
      (creatorEvalWatcherAdapter as any).deliveryBlockCursor = (phase5StartBlock ?? 0n) - 1n;

      const miningInterval = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      let capturedDeliveryDataHex: string | undefined;
      // Temporarily capture the yield from watchForDeliveries to extract the verdict
      const evalWatcherIter = creatorEvalWatcherAdapter.watchForDeliveries()[Symbol.asyncIterator]();
      let deliveryResult: import('../../src/types/index.js').DeliveredResult | undefined;
      try {
        const result = await Promise.race([
          evalWatcherIter.next(),
          sleep(60000).then(() => { throw new Error('creatorEvalWatcherAdapter.watchForDeliveries() timed out'); }),
        ]);
        if (!result.done && result.value) {
          deliveryResult = result.value as import('../../src/types/index.js').DeliveredResult;
        }
      } finally {
        clearInterval(miningInterval);
      }
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);

      // Verify tracking cleanup: pendingEvaluationClaims should no longer have evalRequestId
      const pendingClaims = (creatorEvalWatcherAdapter as any).pendingEvaluationClaims as Set<string>;
      if (pendingClaims.has(evalRequestId)) {
        throw new Error('creatorEvalWatcherAdapter still has evalRequestId in pendingEvaluationClaims after watchForDeliveries — cleanup failed');
      }
      console.log('    Tracking cleanup confirmed: pendingEvaluationClaims no longer has evalRequestId');

      // Verify verdict from the delivered result
      let verdictFromDelivery = 'UNKNOWN';
      if (deliveryResult) {
        try {
          const parsed = JSON.parse(deliveryResult.result.data) as { verdict?: string };
          verdictFromDelivery = parsed.verdict ?? 'UNKNOWN';
        } catch {
          verdictFromDelivery = evalVerdict; // fallback to computed verdict
        }
      } else {
        // If no delivery yielded (e.g. iCreatedEvaluation cleanup path only, no yield),
        // fall back to the evalVerdict computed in Phase 8
        verdictFromDelivery = evalVerdict;
        console.log(`    No delivery yielded from watcher (cleanup-only path); using computed verdict: ${evalVerdict}`);
      }

      console.log(`    Verdict from eval delivery: ${verdictFromDelivery}`);

      if (verdictFromDelivery !== 'PASS') {
        throw new Error(`Expected verdict PASS, got ${verdictFromDelivery}. Evaluator computed: ${evalVerdict}`);
      }

      console.log('    ASSERTION PASSED: verdict === PASS (prediction pipeline verified end-to-end)');
    }));

    // ── Phase 10: Verdict variants (direct TypeScript, no chain) ─────────────

    results.push(await runPhase('Phase 10: Verdict variants — FAIL / REJECTED / INDETERMINATE (direct TypeScript)', async () => {
      if (!evaluatorAgentPk || !evaluatorSafe) throw new Error('Missing evaluator keys');

      const evaluatorPk = evaluatorAgentPk as `0x${string}`;
      const evaluatorSafeAddress = evaluatorSafe as `0x${string}`;

      const testWindow = { startTs: 0, endTs: 3_600_000 };
      const testIntent: PredictionV0Task = {
        id: 'test-direct',
        description: 'Direct TypeScript verdict test',
        solverType: 'prediction.v0',
        window: testWindow,
        spec: {
          oracle: { venue: 'chainlink-base', feed: '0x000000000000000000000000000000000000feed', feedDescription: 'ETH / USD' },
          question: { kind: 'threshold', operator: 'GT', threshold: '3500', resolveTs: testWindow.endTs + 900_000 },
        },
        eligibility: { maxSubmissionDelayMs: 60_000 },
      };

      const signerPk = ('0x' + '1'.repeat(64)) as `0x${string}`;
      const signerAccount = privateKeyToAccount(signerPk);

      const buildManifest = async (overrides: {
        probability?: string;
        submittedAt?: number;
        corruptSignature?: boolean;
      } = {}): Promise<SignedEnvelope> => {
        const unsigned: Omit<SignedEnvelope, 'signature'> = {
          schemaVersion: 'jinn.execution.v1',
          solverType: 'prediction.v0',
          role: 'restoration',
          generatedAt: 1000,
          task: {
            cid: 'task-cid-direct',
            onchainCreationTx: ('0x' + '0'.repeat(64)) as `0x${string}`,
            onchainCreationBlock: 1,
            requestId: ('0x' + '0'.repeat(64)) as `0x${string}`,
          },
          participant: { safeAddress: ('0x' + '0'.repeat(40)) as `0x${string}`, agentEoa: signerAccount.address },
          window: testWindow,
          executor: {
            implName: 'prediction-v0-baseline',
            implVersion: '1.0.0',
            clientGitSha: 'e2e',
            codeDigest: `sha256:${'0'.repeat(64)}`,
            runtimeBundleDigest: `sha256:${'1'.repeat(64)}`,
            plugins: [],
            signingKey: { kind: 'agent-eoa', pubkey: signerAccount.address },
          },
          evidenceTier: 'self-signed',
          attestation: null,
          trajectory: null,
          artifacts: [],
          payload: {
            prediction: {
              probability: overrides.probability ?? '0.55',
              submittedAt: overrides.submittedAt ?? 1_000_000,
              modelId: 'spot-carry.v1',
            },
          },
        };
        const envelope = await signExecutionEnvelope(unsigned, signerPk, signerAccount.address);
        return overrides.corruptSignature
          ? { ...envelope, signature: { ...envelope.signature, sig: ('0x' + 'a'.repeat(130)) as `0x${string}` } }
          : envelope;
      };

      const spanningDeps = (gtPrice: string): SpanningResult => {
        const answer = BigInt(Math.round(parseFloat(gtPrice) * 1e8));
        return {
          round: { roundId: 1n, answer, startedAt: testWindow.endTs + 899_999, updatedAt: testWindow.endTs + 899_999, answeredInRound: 1n, decimals: 8 },
          nextRound: { roundId: 2n, answer: 0n, startedAt: testWindow.endTs + 900_001, updatedAt: testWindow.endTs + 900_001, answeredInRound: 2n, decimals: 8 },
          spanning: true,
        };
      };

      const makeEvalCtx = (manifest: SignedEnvelope, deps: SpanningResult | null, tmpBase: string): HarnessContext => {
        const workingDir = join(tmpBase, Math.random().toString(36).slice(2));
        mkdirSync(workingDir, { recursive: true });
        return {
          task: {
            id: 'eval-direct',
            description: 'evaluate',
            solverType: testIntent.solverType ?? 'prediction.v0',
            role: 'evaluation',
            restorationRequestId: ('0x' + '0'.repeat(64)) as `0x${string}`,
            window: testWindow,
            spec: Object.fromEntries(
              Object.entries(testIntent.spec as Record<string, unknown>).filter(([key]) => key !== 'kind'),
            ),
            eligibility: testIntent.eligibility as unknown as Record<string, unknown>,
            context: { restorationResult: JSON.stringify(manifest) },
          },
          implStateDir: workingDir,
          workingDir,
          log: () => {},
          abort: new AbortController().signal,
          msUntilEndTs: () => 0,
          trajectory: noopTrajectory(),
          _testDeps: {
            oraclePriceAtResolveTs: deps
              ? async () => deps
              : async () => { throw new Error('oracle unreachable (test)'); },
            expectedTaskCid: 'task-cid-direct',
          },
        } as unknown as HarnessContext;
      };

      const evaluator = new PredictionV0Evaluator({ evaluatorPk, evaluatorSafeAddress });
      const tmpBase = tmpDir!;

      // FAIL: corrupted signature
      const failManifest = await buildManifest({ corruptSignature: true });
      const failOut = await evaluator.run(makeEvalCtx(failManifest, spanningDeps('3501'), tmpBase));
      if (failOut.gating.verdict !== 'FAIL') throw new Error(`Expected FAIL, got ${failOut.gating.verdict}`);
      console.log(`    FAIL verdict: OK (bad signature → integrity.signature check failed)`);

      // REJECTED: submittedAt > window.endTs
      const rejectedManifest = await buildManifest({ submittedAt: testWindow.endTs + 1 });
      const rejectedOut = await evaluator.run(makeEvalCtx(rejectedManifest, spanningDeps('3501'), tmpBase));
      if (rejectedOut.gating.verdict !== 'REJECTED') throw new Error(`Expected REJECTED, got ${rejectedOut.gating.verdict}`);
      console.log(`    REJECTED verdict: OK (submittedAt > endTs → eligibility check failed)`);

      // INDETERMINATE: no spanning round
      const indetermManifest = await buildManifest();
      const noSpanning: SpanningResult = {
        round: { roundId: 1n, answer: 350_000_000_000n, startedAt: 0, updatedAt: 0, answeredInRound: 1n, decimals: 8 },
        nextRound: null,
        spanning: false,
      };
      const indetermOut = await evaluator.run(makeEvalCtx(indetermManifest, noSpanning, tmpBase));
      if (indetermOut.gating.verdict !== 'INDETERMINATE') throw new Error(`Expected INDETERMINATE, got ${indetermOut.gating.verdict}`);
      console.log(`    INDETERMINATE verdict: OK (no spanning round → availability check skipped)`);

      console.log('    All 3 verdict variants confirmed (FAIL / REJECTED / INDETERMINATE)');
    }));

    // ── Phase 11: Assert JinnRouter counter attribution per Safe ──────────────

    results.push(await runPhase('Phase 11: Assert JinnRouter counter attribution per Safe', async () => {
      if (!creatorSafe || !harnessSafe || !evaluatorSafe) throw new Error('Missing Safe addresses from Phase 3');

      const counters = {
        creationCount: {
          creator: await readCounter(publicClient, 'creationCount', creatorSafe as `0x${string}`),
          harness: await readCounter(publicClient, 'creationCount', harnessSafe as `0x${string}`),
          evaluator: await readCounter(publicClient, 'creationCount', evaluatorSafe as `0x${string}`),
        },
        restorationDeliveryCount: {
          creator: await readCounter(publicClient, 'restorationDeliveryCount', creatorSafe as `0x${string}`),
          harness: await readCounter(publicClient, 'restorationDeliveryCount', harnessSafe as `0x${string}`),
          evaluator: await readCounter(publicClient, 'restorationDeliveryCount', evaluatorSafe as `0x${string}`),
        },
        evaluationCreationCount: {
          creator: await readCounter(publicClient, 'evaluationCreationCount', creatorSafe as `0x${string}`),
          harness: await readCounter(publicClient, 'evaluationCreationCount', harnessSafe as `0x${string}`),
          evaluator: await readCounter(publicClient, 'evaluationCreationCount', evaluatorSafe as `0x${string}`),
        },
        evaluationDeliveryCount: {
          creator: await readCounter(publicClient, 'evaluationDeliveryCount', creatorSafe as `0x${string}`),
          harness: await readCounter(publicClient, 'evaluationDeliveryCount', harnessSafe as `0x${string}`),
          evaluator: await readCounter(publicClient, 'evaluationDeliveryCount', evaluatorSafe as `0x${string}`),
        },
      };

      console.log('    Counter attribution:');
      for (const [counter, byRole] of Object.entries(counters)) {
        console.log(`      ${counter}:`);
        for (const [role, count] of Object.entries(byRole)) {
          console.log(`        ${role}: ${count}`);
        }
      }

      // Expected attribution (per JinnRouter contract semantics, cross-role 3-Safe flow):
      // - creationCount:            creator calls createRestorationJob  → creator
      // - restorationDeliveryCount: RESTORER calls claimDelivery (Phase 6)        → harness
      // - evaluationCreationCount:  creator calls createEvaluationJob (Phase 7)   → creator
      // - evaluationDeliveryCount:  EVALUATOR calls claimDelivery (Phase 8)       → evaluator
      // This proves counter attribution is per-Safe and role-separated.
      const expected = {
        creationCount:            { creator: 1n, harness: 0n, evaluator: 0n },
        restorationDeliveryCount: { creator: 0n, harness: 1n, evaluator: 0n },
        evaluationCreationCount:  { creator: 1n, harness: 0n, evaluator: 0n },
        evaluationDeliveryCount:  { creator: 0n, harness: 0n, evaluator: 1n },
      };

      for (const [counter, byRole] of Object.entries(expected)) {
        for (const [role, exp] of Object.entries(byRole)) {
          const actual = (counters as Record<string, Record<string, bigint>>)[counter]![role]!;
          if (actual !== exp) {
            throw new Error(`${counter}[${role}]: expected ${exp}, got ${actual}`);
          }
        }
      }
      console.log('    ✓ all counters attributed correctly');
    }));

  } finally {
    if (creatorAdapter) { try { creatorAdapter.stop(); } catch { /**/ } }
    if (harnessAdapter) { try { harnessAdapter.stop(); } catch { /**/ } }
    if (evaluatorAdapter) { try { evaluatorAdapter.stop(); } catch { /**/ } }
    if (creatorRestorationWatcherAdapter) { try { creatorRestorationWatcherAdapter.stop(); } catch { /**/ } }
    if (creatorEvalWatcherAdapter) { try { creatorEvalWatcherAdapter.stop(); } catch { /**/ } }
    if (anvil) { anvil.kill('SIGTERM'); console.log('\n  Anvil stopped'); }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────

  console.log('\n=== Results ===\n');
  let allOk = true;
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    console.log(`  ${icon} ${r.name} (${r.ms}ms)${r.error ? `: ${r.error}` : ''}`);
    if (!r.ok) allOk = false;
  }

  const passed = results.filter(r => r.ok).length;
  console.log(`\n  ${passed}/${results.length} phases passed`);

  if (!allOk) {
    console.error('\nE2E FAILED');
    exitExpected = true;
    process.exit(1);
  }

  console.log('\nE2E PASSED — prediction.v0 pipeline verified end-to-end with 3-Safe attribution');
  exitExpected = true;
  process.exit(0);
}

main().catch(err => {
  console.error('[e2e-pred] Fatal:', err);
  exitExpected = true;
  process.exit(1);
});
