/**
 * e2e-portfolio-v0.ts — End-to-end test for the portfolio.v0 pipeline.
 *
 * Scenario (spec §10 step 7):
 *   1. Bootstrap a fleet on Anvil-forked Base (same bootstrap as e2e-validate.ts)
 *   2. Operator posts a portfolio.v0 intent on-chain
 *   3. Engine claims + runs claude-mcp-hyperliquid with MOCKED Claude (runSession noop)
 *      and MOCKED HL client (stub → 0 fills, 0 trades)
 *   4. Engine packages + signs + delivers manifest (real IPFS upload)
 *   5. DeliveryWatcher claims → creates evaluation job on-chain
 *   6. portfolio-v0-evaluator runs with injected _testDeps (in-memory IPFS, mocked HL)
 *   7. Evaluator delivers verdict on-chain
 *   8. Assert verdict === REJECTED (0 trades < 20 eligibility threshold)
 *
 * Architecture decisions:
 *   - Option (c) hybrid: real IPFS uploads, mocked Claude (runSession noop), mocked HL
 *   - 24h window: startTs = now-1000, endTs = startTs + 86_400_000 (satisfies Zod refine)
 *   - Expected verdict: REJECTED (eligibility.minClosedTrades = 20, actual = 0)
 *
 * Usage: yarn e2e-portfolio-v0
 */

import { config as dotenvConfig } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
dotenvConfig({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
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
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { decodeMarketplaceRequestLogs } from '../src/adapters/mech/contracts.js';
import {
  MECH_ABI,
  MECH_MARKETPLACE_ABI,
  JINN_ROUTER_ABI,
  NATIVE_PAYMENT_TYPE,
} from '../src/adapters/mech/types.js';
import { MechAdapter } from '../src/adapters/mech/adapter.js';
import { FleetBootstrapper } from '../src/earning/bootstrap.js';
import { getChainConfig } from '../src/earning/contracts.js';
import { assembleAndSignManifest } from '../src/restorer/engine/manifest-assembly.js';
import { ClaudeMcpHyperliquidImpl } from '../src/restorer/impls/claude-mcp-hyperliquid/index.js';
import { PortfolioV0Evaluator } from '../src/restorer/impls/portfolio-v0-evaluator/index.js';
import type { RestorationContext } from '../src/restorer/types.js';
import type { HlClearinghouseState, HlFill, HlGridPoint } from '../src/venues/hyperliquid/types.js';
import type { DesiredState } from '../src/types/desired-state.js';
import type { RestorationManifest } from '../src/types/portfolio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
const ANVIL_PORT = 8547; // Separate port from e2e-validate.ts (8546) to avoid conflicts
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const PASSWORD = 'test-password-pf';

const CHAIN_CONFIG = getChainConfig('base');
const OLAS_TOKEN = CHAIN_CONFIG.olasToken;

const MARKETPLACE_ADDRESS: Address = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const ROUTER_ADDRESS: Address = '0xfFa7118A3D820cd4E820010837D65FAfF463181B';
const MARKETPLACE_AGENT_FACTORY_SENTINEL: Address = '0x000000000000000000000000000000000000dEaD';
const MARKETPLACE_SLOT_SCAN_MAX = 64n;
const UINT32_MAX = 0xffff_ffffn;
const RESPONSE_TIMEOUT_HEADROOM = 3600n;

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

// ── Mock HL client ────────────────────────────────────────────────────────────

/**
 * Stub HyperliquidClient for the ClaudeMcpHyperliquidImpl restorer.
 * Returns $1000 constant equity + empty fills — ensures 0 closed trades.
 */
class MockHlClient {
  readonly baseUrl = 'mock://';
  readonly timeoutMs = 1000;

  async clearinghouseState(_user: string): Promise<HlClearinghouseState> {
    return {
      marginSummary: { accountValue: '1000.00', totalNtlPos: '0', totalRawUsd: '1000.00', totalMarginUsed: '0' },
      crossMarginSummary: { accountValue: '1000.00', totalNtlPos: '0', totalRawUsd: '1000.00', totalMarginUsed: '0' },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '1000.00',
      assetPositions: [],
      time: Date.now(),
    };
  }

  async userFillsByTime(_user: string, _startTime: number, _endTime?: number): Promise<{ fills: HlFill[]; startTimeClamped: boolean }> {
    return { fills: [], startTimeClamped: false };
  }

  async allMids(): Promise<Record<string, string>> {
    return { BTC: '50000', ETH: '3000' };
  }

  async portfolioPeriod(_user: string, _period: string): Promise<{ accountValueHistory: HlGridPoint[] } | null> {
    const now = Date.now();
    return { accountValueHistory: [[now - 30 * 24 * 3600 * 1000, '1000'], [now, '1000']] as HlGridPoint[] };
  }
}

// ── Crash guards ──────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => { console.error('[e2e-pf] UNCAUGHT EXCEPTION:', err); process.exit(1); });
process.on('unhandledRejection', (reason) => { console.error('[e2e-pf] UNHANDLED REJECTION:', reason); process.exit(1); });

let exitExpected = false;
process.on('beforeExit', (code) => { if (!exitExpected) console.error(`[e2e-pf] UNEXPECTED beforeExit (code=${code})`); });

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== Portfolio.v0 E2E (Anvil fork + mocked Claude + mocked HL) ===\n');

  let anvil: ChildProcess | null = null;
  let tmpDir: string | null = null;
  const results: PhaseResult[] = [];

  // Shared state across phases
  let adapter: MechAdapter | undefined;
  let publicClient!: PublicClient;
  let agentEoaPrivateKey: Hex | undefined;
  let safeAddress: Address | undefined;
  let mechAddress: Address | undefined;
  let intentCid: string | undefined;
  let restorationRequestId: string | undefined;
  let capturedManifest: Record<string, unknown> | undefined;
  let capturedManifestCid: string | undefined;
  let capturedWindow: { startTs: number; endTs: number } | undefined;

  try {
    // ── Phase 1: Infrastructure ───────────────────────────────────────────────

    results.push(await runPhase('Phase 1: Spawn Anvil fork + create temp dir', async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'jinn-e2e-pf-'));
      console.log(`    Temp dir: ${tmpDir}`);

      const anvilPath = process.env['ANVIL_PATH'] ?? 'anvil';
      const forkBlock = process.env['ANVIL_FORK_BLOCK'] ?? '';
      const anvilArgs = ['--fork-url', BASE_RPC_URL, '--port', String(ANVIL_PORT), '--silent', ...(forkBlock ? ['--fork-block-number', forkBlock] : [])];

      anvil = spawn(anvilPath, anvilArgs, { stdio: 'ignore', detached: false });
      anvil.on('error', (err) => { throw new Error(`Failed to spawn Anvil: ${err.message}`); });

      await waitFor('Anvil RPC ready', async () => {
        try { const b = await jsonRpc(ANVIL_RPC, 'eth_blockNumber'); return typeof b === 'string' && b.startsWith('0x'); }
        catch { return false; }
      });

      publicClient = createPublicClient({ chain: base, transport: http(ANVIL_RPC) }) as unknown as PublicClient;
      const blockNumber = await publicClient.getBlockNumber();
      console.log(`    Anvil forked at block ${blockNumber}`);
      await normalizeForkTimestamp(publicClient, forkBlock || undefined);
    }));

    // ── Phase 2: Bootstrap operator ───────────────────────────────────────────

    results.push(await runPhase('Phase 2: Bootstrap operator — create service + mech', async () => {
      if (!tmpDir) throw new Error('No temp dir from Phase 1');

      let bootstrapper = new FleetBootstrapper({ earningDir: tmpDir, chain: 'base', rpcUrl: ANVIL_RPC });
      const initialResult = await bootstrapper.bootstrap(PASSWORD);
      if (!initialResult.funding) throw new Error(`Expected funding requirement, got ok=${initialResult.ok}`);

      const masterAddress = initialResult.funding.master_address;
      console.log(`    Master: ${masterAddress}`);

      // Fund master with ETH + OLAS for staking deposit
      await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [masterAddress, '0x56BC75E2D63100000']);
      const eoaOlasSlot = erc20BalanceSlot(masterAddress);
      const eoaOlasAmount = 100000n * 10n ** 18n;
      await jsonRpc(ANVIL_RPC, 'anvil_setStorageAt', [OLAS_TOKEN, eoaOlasSlot, pad(toHex(eoaOlasAmount), { size: 32 })]);

      await jsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [masterAddress]);
      await jsonRpc(ANVIL_RPC, 'eth_sendTransaction', [{ from: masterAddress, to: OLAS_TOKEN, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: 'approve', args: [CHAIN_CONFIG.stakingContract as Address, eoaOlasAmount] }) }]);
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      await jsonRpc(ANVIL_RPC, 'eth_sendTransaction', [{ from: masterAddress, to: CHAIN_CONFIG.stakingContract, data: encodeFunctionData({ abi: parseAbi(['function deposit(uint256)']), functionName: 'deposit', args: [eoaOlasAmount] }) }]);
      await jsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [masterAddress]);
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);

      bootstrapper = new FleetBootstrapper({ earningDir: tmpDir, chain: 'base', rpcUrl: ANVIL_RPC });
      const finalResult = await bootstrapper.bootstrap(PASSWORD);
      if (!finalResult.ok) throw new Error(`Bootstrap failed: ${finalResult.message}`);

      const firstComplete = finalResult.fleet_state.services.find(s => s.step === 'complete');
      safeAddress = firstComplete?.safe_address as Address | undefined;
      mechAddress = firstComplete?.mech_address as Address | undefined;
      if (!safeAddress || !mechAddress) throw new Error('Bootstrap completed but missing safe/mech address');

      const { FleetStateStore } = await import('../src/earning/store.js');
      const { decryptMnemonic, walletPrivateKeyAtIndex } = await import('../src/earning/wallet.js');
      const store = new FleetStateStore(tmpDir);
      const mnemonic = await decryptMnemonic(await store.loadMnemonicKeystore(), PASSWORD);
      agentEoaPrivateKey = walletPrivateKeyAtIndex(mnemonic, firstComplete!.index);

      console.log(`    Bootstrap complete! Safe: ${safeAddress}, Mech: ${mechAddress}`);
    }));

    // ── Phase 3: MechAdapter + stabilize fork ─────────────────────────────────

    results.push(await runPhase('Phase 3: Create MechAdapter + stabilize fork', async () => {
      if (!agentEoaPrivateKey || !safeAddress || !mechAddress) throw new Error('Missing credentials from Phase 2');

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

      await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [safeAddress, '0x56BC75E2D63100000']);
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);

      await stabilizeForkedMarketplaceState(publicClient, safeAddress, mechAddress);
      console.log('    MechAdapter initialized + marketplace stabilized');
    }));

    // ── Phase 4: Post portfolio.v0 intent on-chain ────────────────────────────

    results.push(await runPhase('Phase 4: Post portfolio.v0 intent on-chain', async () => {
      if (!adapter) throw new Error('No adapter from Phase 3');

      // 24h window — satisfies Zod refine (endTs - startTs === 86_400_000)
      const startTs = Date.now() - 1000;
      const endTs = startTs + 86_400_000;
      capturedWindow = { startTs, endTs };

      // Dummy masterAddress — HL is mocked so no real account needed
      const masterAddress = '0x0000000000000000000000000000000000000001';

      const portfolioIntent: DesiredState = {
        id: 'pf-v0-e2e-test',
        description: 'portfolio.v0 e2e: grow equity by 1% over 24h window on Hyperliquid testnet',
        type: 'restoration',
        attemptId: 'pf-v0-e2e-test/1',
        attemptNumber: 1,
        window: { startTs, endTs },
        spec: {
          kind: 'portfolio.v0',
          account: { venue: 'hyperliquid-testnet', masterAddress },
          target: { metric: 'equity_return_pct', minReturnPct: 1.0 },
          constraint: { maxDrawdownPct: 10.0 },
        },
        eligibility: { minClosedTrades: 20, minTradedNotionalMultiple: 5.0 },
      };

      // Mine fresh blocks to avoid stale nonce
      for (let i = 0; i < 3; i++) { await jsonRpc(ANVIL_RPC, 'evm_mine', []); await sleep(100); }

      restorationRequestId = await adapter.postDesiredState(portfolioIntent);
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      console.log(`    portfolio.v0 intent posted, requestId: ${restorationRequestId}`);

      // Verify MarketplaceRequest event on-chain
      const currentBlock = await publicClient.getBlockNumber();
      const logs = await publicClient.getLogs({ address: MARKETPLACE_ADDRESS, fromBlock: currentBlock - 5n, toBlock: currentBlock });
      const decoded = decodeMarketplaceRequestLogs(logs);
      if (!decoded.find(d => d.requestId === restorationRequestId)) throw new Error(`MarketplaceRequest event not found`);
      console.log('    MarketplaceRequest event confirmed on-chain');
    }));

    // ── Phase 5: Claim + run ClaudeMcpHyperliquidImpl (mocked) ───────────────

    results.push(await runPhase('Phase 5: Claim + run claude-mcp-hyperliquid (mocked Claude + mocked HL)', async () => {
      if (!adapter || !restorationRequestId || !tmpDir || !agentEoaPrivateKey || !safeAddress || !capturedWindow) {
        throw new Error('Missing state from prior phases');
      }

      // Mine blocks while waiting for request
      const miningInterval = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);

      let reqValue: Awaited<ReturnType<typeof adapter['watchForRequests'][typeof Symbol.asyncIterator]>> | undefined;
      try {
        const iter = adapter.watchForRequests()[Symbol.asyncIterator]();
        const result = await Promise.race([
          iter.next(),
          sleep(30000).then(() => { throw new Error('watchForRequests timed out'); }),
        ]);
        if (!result.done && result.value) reqValue = result.value;
      } finally {
        clearInterval(miningInterval);
      }

      if (!reqValue) throw new Error('No request received');
      const req = reqValue as { requestId: string; desiredState: DesiredState; intentCid: string; onchainCreationTx?: string; onchainCreationBlock?: number };

      console.log(`    Claimed request: ${req.requestId}, intentCid: ${req.intentCid}`);
      intentCid = req.intentCid;

      // Claim on-chain
      await adapter.claimRequest(req.requestId);
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);

      // Build impl with mocked HL + noop runSession
      const mockHlClient = new MockHlClient() as unknown as import('../src/venues/hyperliquid/client.js').HyperliquidClient;
      const impl = new ClaudeMcpHyperliquidImpl({
        _testDeps: {
          runSession: async (_sessionId: string, _prompt: string) => ({ stdout: '' }),
          hlClient: mockHlClient,
        },
      });

      // Provision working dirs
      const implStateDir = join(tmpDir, 'impl-state', req.requestId);
      const workingDir = join(tmpDir, 'working', req.requestId);
      mkdirSync(implStateDir, { recursive: true });
      mkdirSync(workingDir, { recursive: true });

      // Restore spec + window from context (they may not be in desiredState parsed from legacy IPFS payload)
      const intentWithSpec: DesiredState = {
        ...req.desiredState,
        window: req.desiredState.window ?? capturedWindow,
        spec: req.desiredState.spec ?? {
          kind: 'portfolio.v0',
          account: { venue: 'hyperliquid-testnet', masterAddress: '0x0000000000000000000000000000000000000001' },
          target: { metric: 'equity_return_pct', minReturnPct: 1.0 },
          constraint: { maxDrawdownPct: 10.0 },
        },
        eligibility: req.desiredState.eligibility ?? { minClosedTrades: 20, minTradedNotionalMultiple: 5.0 },
      };

      const abort = new AbortController();
      const ctx: RestorationContext = {
        intent: intentWithSpec,
        implStateDir,
        workingDir,
        log: (e) => console.log(`    [impl] [${e.level}] ${e.msg}${e.data ? ' ' + JSON.stringify(e.data) : ''}`),
        abort: abort.signal,
        msUntilEndTs: () => Math.max(0, capturedWindow!.endTs - Date.now()),
      };

      // Run impl (returns 0 fills — mocked Claude noop, mocked HL empty fills)
      const output = await impl.run(ctx);
      console.log(`    Impl done. fills=${output.fills?.length ?? 0}, gating=${JSON.stringify(output.gating)}`);

      // Assemble + sign + upload manifest
      const agentAccount = privateKeyToAccount(agentEoaPrivateKey);
      const now2 = Date.now();
      const preSnapshot = output.preSnapshot ?? { capturedAt: now2 - 1000, hlTime: now2 - 1000, payload: { marginSummary: { accountValue: '1000' } } };
      const postSnapshot = output.postSnapshot ?? { capturedAt: now2, hlTime: now2, payload: { marginSummary: { accountValue: '1000' } } };

      const { manifest, manifestCid } = await assembleAndSignManifest(
        {
          intentCid: intentCid!,
          onchainCreationTx: req.onchainCreationTx ?? '0x',
          onchainCreationBlock: req.onchainCreationBlock ?? 0,
          requestId: req.requestId,
          safeAddress: safeAddress as string,
          agentEoa: agentAccount.address as string,
          windowStartTs: capturedWindow.startTs,
          windowEndTs: capturedWindow.endTs,
        },
        { preSnapshot, postSnapshot, fills: output.fills ?? [], gating: output.gating, informational: output.informational, rationale: output.rationale },
        [],
        { ipfsRegistryUrl: 'https://registry.autonolas.tech', agentEoaPrivateKey, safeAddress: safeAddress as `0x${string}` },
      );

      capturedManifest = manifest;
      capturedManifestCid = manifestCid;
      console.log(`    Manifest assembled + uploaded. CID: ${manifestCid}`);

      // Submit result (uploads JSON to IPFS + delivers on-chain)
      const resultData = JSON.stringify({
        protocol: 'jinn-client/portfolio.v0',
        type: 'restoration-result',
        requestId: req.requestId,
        manifestCid,
        gating: output.gating,
      });

      const miningInterval2 = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      try {
        await adapter.submitResult(req.requestId, { data: resultData });
      } finally {
        clearInterval(miningInterval2);
      }

      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      console.log('    Result submitted on-chain');
    }));

    // ── Phase 6: Creator claims delivery + creates eval job ───────────────────

    const deliveryIter = adapter!.watchForDeliveries()[Symbol.asyncIterator]();

    results.push(await runPhase('Phase 6: Creator claims restoration delivery + creates evaluation job', async () => {
      if (!adapter || !restorationRequestId) throw new Error('Missing state');

      const miningInterval = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      let delivery: Awaited<ReturnType<typeof deliveryIter.next>>;
      try {
        delivery = await Promise.race([
          deliveryIter.next(),
          sleep(60000).then(() => { throw new Error('watchForDeliveries timed out (60s)'); }),
        ]);
      } finally {
        clearInterval(miningInterval);
      }

      if (delivery.done || !delivery.value) throw new Error('watchForDeliveries ended unexpectedly');
      const del = delivery.value;
      if (del.requestId !== restorationRequestId) throw new Error(`Expected requestId ${restorationRequestId}, got ${del.requestId}`);
      console.log(`    Restoration delivery claimed. requestId: ${del.requestId}`);

      // Wait for evaluation creation tx to confirm
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      const currentBlock = await publicClient.getBlockNumber();
      const routerLogs = await publicClient.getLogs({ address: ROUTER_ADDRESS, fromBlock: currentBlock - 10n, toBlock: currentBlock });
      let foundEvalJob = false;
      for (const log of routerLogs) {
        try {
          const decoded = decodeEventLog({ abi: JINN_ROUTER_ABI, data: log.data, topics: log.topics });
          if (decoded.eventName === 'EvaluationJobCreated') { foundEvalJob = true; console.log('    EvaluationJobCreated event confirmed on router'); }
        } catch { /**/ }
      }
      if (!foundEvalJob) throw new Error('No EvaluationJobCreated event found on router');
    }));

    // ── Phase 7: Claim eval job + run PortfolioV0Evaluator (mocked deps) ─────

    let evalVerdict = 'UNKNOWN';

    results.push(await runPhase('Phase 7: Claim eval job + run PortfolioV0Evaluator (mocked IPFS + mocked HL)', async () => {
      if (!adapter || !capturedManifest || !tmpDir || !agentEoaPrivateKey || !safeAddress || !capturedWindow) {
        throw new Error('Missing state from prior phases');
      }

      // Mine + wait for evaluation request
      const miningInterval = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      let evalReqValue: Awaited<ReturnType<typeof adapter['watchForRequests'][typeof Symbol.asyncIterator]>> | undefined;
      try {
        const iter = adapter.watchForRequests()[Symbol.asyncIterator]();
        const result = await Promise.race([
          iter.next(),
          sleep(45000).then(() => { throw new Error('watchForRequests (eval) timed out'); }),
        ]);
        if (!result.done && result.value) evalReqValue = result.value;
      } finally {
        clearInterval(miningInterval);
      }

      if (!evalReqValue) throw new Error('No eval request received');
      const req = evalReqValue as { requestId: string; desiredState: DesiredState };

      console.log(`    Eval request: ${req.requestId}, type: ${req.desiredState.type}`);

      // Claim on-chain
      await adapter.claimRequest(req.requestId);
      await jsonRpc(ANVIL_RPC, 'evm_mine', []);

      // Build evaluator context using the unified-payload model (Task 10 migration).
      // The restorer's manifest is inlined at context.restorationResult; the original
      // portfolio.v0 spec is carried directly on the evalIntent.spec — no IPFS fetch.
      const capturedWindow2 = capturedWindow;
      const capturedManifest2 = capturedManifest;

      const evalIntent: DesiredState = {
        id: 'pf-v0-e2e-eval',
        description: 'Evaluate portfolio.v0 restoration attempt',
        type: 'evaluation',
        restorationRequestId,
        window: capturedWindow2,
        spec: {
          kind: 'portfolio.v0',
          account: { venue: 'hyperliquid-testnet', masterAddress: '0x0000000000000000000000000000000000000001' },
          target: { metric: 'equity_return_pct', minReturnPct: 1.0 },
          constraint: { maxDrawdownPct: 10.0 },
        } as unknown as Record<string, unknown>,
        eligibility: { minClosedTrades: 20, minTradedNotionalMultiple: 5.0 } as unknown as Record<string, unknown>,
        context: { restorationResult: JSON.stringify(capturedManifest2) },
      };

      const evalWorkingDir = join(tmpDir, 'eval-working', req.requestId);
      const evalImplStateDir = join(tmpDir, 'eval-impl-state', req.requestId);
      mkdirSync(evalWorkingDir, { recursive: true });
      mkdirSync(evalImplStateDir, { recursive: true });

      const abort = new AbortController();
      const evalCtx: RestorationContext = {
        intent: evalIntent,
        implStateDir: evalImplStateDir,
        workingDir: evalWorkingDir,
        log: (e) => console.log(`    [eval] [${e.level}] ${e.msg}${e.data ? ' ' + JSON.stringify(e.data) : ''}`),
        abort: abort.signal,
        msUntilEndTs: () => 0,
      };

      // Pass test deps via constructor config (unified-payload pattern).
      // HL calls are mocked to return 0 fills — triggers REJECTED verdict (eligibility.minClosedTrades = 20).
      const evaluator = new PortfolioV0Evaluator({
        safeAddress,
        agentEoa: privateKeyToAccount(agentEoaPrivateKey).address,
        agentEoaPrivateKey,
        _testDeps: {
          hlPortfolioPeriod: async (_user: string) => {
            const { startTs, endTs } = capturedWindow2;
            const grid: HlGridPoint[] = [[startTs - 3_600_000, '1000'], [startTs + 1000, '1000'], [endTs - 1000, '1000'], [endTs + 3_600_000, '1000']];
            return { accountValueHistory: grid };
          },
          hlUserFillsByTime: async (_user: string, _startTime: number, _endTime?: number) => ({
            fills: [] as HlFill[],
            startTimeClamped: false,
          }),
        },
      });
      const evalOutput = await evaluator.run(evalCtx);

      evalVerdict = String(evalOutput.gating['verdict'] ?? 'UNKNOWN');
      console.log(`    Evaluator verdict: ${evalVerdict}`);
      console.log(`    Checks run: ${evalOutput.gating['checkCount']}, pass: ${evalOutput.gating['passCount']}, fail: ${evalOutput.gating['failCount']}`);

      // Submit evaluator verdict on-chain
      const evalResultData = JSON.stringify({
        protocol: 'jinn-client/portfolio.v0',
        type: 'evaluation-verdict',
        requestId: req.requestId,
        verdict: evalVerdict,
        gating: evalOutput.gating,
      });

      const miningInterval2 = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      try {
        await adapter.submitResult(req.requestId, { data: evalResultData });
      } finally {
        clearInterval(miningInterval2);
      }

      await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      console.log('    Evaluator verdict submitted on-chain');
    }));

    // ── Phase 8: Creator claims eval delivery + assert verdict ────────────────

    results.push(await runPhase('Phase 8: Creator claims eval delivery + assert verdict === REJECTED', async () => {
      if (!adapter) throw new Error('Missing adapter');

      const miningInterval = setInterval(async () => { try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /**/ } }, 1000);
      let delivery: Awaited<ReturnType<typeof deliveryIter.next>>;
      try {
        delivery = await Promise.race([
          deliveryIter.next(),
          sleep(60000).then(() => { throw new Error('watchForDeliveries (eval) timed out (60s)'); }),
        ]);
      } finally {
        clearInterval(miningInterval);
      }

      if (delivery.done || !delivery.value) throw new Error('watchForDeliveries ended unexpectedly');
      const del = delivery.value;
      if (del.desiredState.type !== 'evaluation') throw new Error(`Expected type 'evaluation', got '${del.desiredState.type}'`);
      console.log(`    Eval delivery claimed. requestId: ${del.requestId}`);

      // Parse + assert verdict
      let verdictFromDelivery = 'UNKNOWN';
      try {
        const parsed = JSON.parse(del.result.data) as { verdict?: string };
        verdictFromDelivery = parsed.verdict ?? 'UNKNOWN';
      } catch { console.log('    Could not parse evaluation result as JSON'); }

      console.log(`    Verdict from on-chain delivery: ${verdictFromDelivery}`);

      if (verdictFromDelivery !== 'REJECTED') {
        throw new Error(
          `Expected verdict REJECTED (0 closed trades < 20 eligibility threshold), got ${verdictFromDelivery}. ` +
          `Evaluator computed verdict: ${evalVerdict}`,
        );
      }

      console.log('    ASSERTION PASSED: verdict === REJECTED (0 closed trades < 20 eligibility threshold)');
      console.log('    Full portfolio.v0 pipeline verified end-to-end.');
    }));

  } finally {
    if (adapter) { try { adapter.stop(); } catch { /**/ } }
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

  console.log('\nE2E PASSED — portfolio.v0 pipeline verified end-to-end');
  exitExpected = true;
  process.exit(0);
}

main().catch(err => {
  console.error('[e2e-pf] Fatal:', err);
  exitExpected = true;
  process.exit(1);
});
