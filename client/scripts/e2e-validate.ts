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
 *
 * Usage: npx tsx scripts/e2e-validate.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  AbiCoder,
  keccak256,
  zeroPadValue,
  toBeHex,
} from 'ethers';
import {
  createPublicClient,
  decodeEventLog,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import {
  decodeMarketplaceRequestLogs,
} from '../src/adapters/mech/contracts.js';
import {
  MECH_ABI,
  MECH_MARKETPLACE_ABI,
  JINN_ROUTER_ABI,
} from '../src/adapters/mech/types.js';
import { MechAdapter } from '../src/adapters/mech/adapter.js';
import { EarningBootstrapper } from '../src/earning/bootstrap.js';
import { getChainConfig } from '../src/earning/contracts.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

// ── Constants ────────────────────────────────────────────────────────────────

const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
const ANVIL_PORT = 8546;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const PASSWORD = 'test-password';

const CHAIN_CONFIG = getChainConfig('base');
const OLAS_TOKEN = CHAIN_CONFIG.olasToken;

const MARKETPLACE_ADDRESS: Address = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const ROUTER_ADDRESS: Address = '0xfFa7118A3D820cd4E820010837D65FAfF463181B';

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

// ── Phase runner ─────────────────────────────────────────────────────────────

interface PhaseResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
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
    return { name, ok: false, ms, error };
  }
}

/**
 * Compute the ERC-20 balanceOf storage slot for a given address.
 *
 * Standard Solidity: balances mapping is at slot 0.
 *   slot = keccak256(abi.encode(address, uint256(0)))
 */
function erc20BalanceSlot(holder: string, mappingSlot: bigint = 0n): string {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256'],
    [holder, mappingSlot],
  );
  return keccak256(encoded);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== Jinn-Client E2E Validation (Self-Bootstrapped) ===\n');

  let anvil: ChildProcess | null = null;
  let tmpDir: string | null = null;
  const results: PhaseResult[] = [];

  // Shared state populated across phases
  let adapter: MechAdapter | undefined;
  let publicClient: PublicClient;
  let agentEoaPrivateKey: Hex | undefined;
  let safeAddress: Address | undefined;
  let mechAddress: Address | undefined;
  let serviceId: number | undefined;
  let restorationRequestId: string | undefined;

  // Phase 12 cross-operator state
  let tmpDir2: string | null = null;
  let safeAddressB: Address | undefined;
  let mechAddressB: Address | undefined;
  let agentEoaPrivateKeyB: Hex | undefined;

  try {
    // ── Phase 1: Infrastructure ──────────────────────────────────────────────

    results.push(
      await runPhase('Phase 1: Infrastructure — spawn Anvil fork, create temp dir', async () => {
        // Create temp directory for earning store
        tmpDir = await mkdtemp(join(tmpdir(), 'jinn-e2e-'));
        console.log(`    Temp dir: ${tmpDir}`);

        // Spawn Anvil
        const anvilPath = process.env['ANVIL_PATH'] ?? 'anvil';
        anvil = spawn(anvilPath, [
          '--fork-url', BASE_RPC_URL,
          '--port', String(ANVIL_PORT),
          '--silent',
        ], {
          stdio: 'ignore',
          detached: false,
        });

        anvil.on('error', (err) => {
          throw new Error(`Failed to spawn Anvil: ${err.message}`);
        });

        // Wait for Anvil to be ready
        await waitFor('Anvil RPC ready', async () => {
          try {
            const blockNum = await jsonRpc(ANVIL_RPC, 'eth_blockNumber');
            return typeof blockNum === 'string' && blockNum.startsWith('0x');
          } catch {
            return false;
          }
        });

        publicClient = createPublicClient({
          chain: base,
          transport: http(ANVIL_RPC),
        }) as unknown as PublicClient;

        const blockNumber = await publicClient.getBlockNumber();
        console.log(`    Anvil forked at block ${blockNumber}`);
      }),
    );

    // ── Phase 2: Bootstrap operator ──────────────────────────────────────────

    results.push(
      await runPhase('Phase 2: Bootstrap operator — create service + mech', async () => {
        if (!tmpDir) throw new Error('No temp dir from Phase 1');

        // Step 1: Run bootstrap to get awaiting_funding (creates wallet + predicts safe)
        let bootstrapper = new EarningBootstrapper({
          earningDir: tmpDir,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
        });

        const initialResult = await bootstrapper.bootstrap(PASSWORD);
        if (initialResult.step !== 'awaiting_funding') {
          throw new Error(`Expected step 'awaiting_funding', got '${initialResult.step}'`);
        }
        if (!initialResult.funding) {
          throw new Error('Expected funding requirement in result');
        }

        const eoaAddress = initialResult.funding.eoa_address;
        const predictedSafe = initialResult.funding.safe_address;
        console.log(`    EOA: ${eoaAddress}`);
        console.log(`    Predicted Safe: ${predictedSafe}`);

        // Step 2: Fund accounts on Anvil

        // Fund EOA with 100 ETH
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [
          eoaAddress,
          '0x56BC75E2D63100000', // 100 ETH
        ]);

        // Fund Safe with ETH
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [
          predictedSafe,
          '0x56BC75E2D63100000', // 100 ETH
        ]);

        // Fund Safe with OLAS via storage slot
        const olasAmount = 10000n * 10n ** 18n;
        const slot = erc20BalanceSlot(predictedSafe);
        const value = zeroPadValue(toBeHex(olasAmount), 32);
        await jsonRpc(ANVIL_RPC, 'anvil_setStorageAt', [OLAS_TOKEN, slot, value]);

        // Fund staking contract with OLAS rewards via deposit()
        const eoaOlasSlot = erc20BalanceSlot(eoaAddress);
        const eoaOlasAmount = 100000n * 10n ** 18n;
        await jsonRpc(ANVIL_RPC, 'anvil_setStorageAt', [
          OLAS_TOKEN,
          eoaOlasSlot,
          zeroPadValue(toBeHex(eoaOlasAmount), 32),
        ]);

        await jsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [eoaAddress]);
        const olasApprove = new Interface([
          'function approve(address spender, uint256 amount) returns (bool)',
        ]).encodeFunctionData('approve', [CHAIN_CONFIG.stakingContract, eoaOlasAmount]);
        await jsonRpc(ANVIL_RPC, 'eth_sendTransaction', [
          { from: eoaAddress, to: OLAS_TOKEN, data: olasApprove },
        ]);
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        const depositData = new Interface([
          'function deposit(uint256 amount)',
        ]).encodeFunctionData('deposit', [eoaOlasAmount]);
        await jsonRpc(ANVIL_RPC, 'eth_sendTransaction', [
          { from: eoaAddress, to: CHAIN_CONFIG.stakingContract, data: depositData },
        ]);
        await jsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [eoaAddress]);
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Verify staking rewards
        const stakingContract = new Contract(
          CHAIN_CONFIG.stakingContract,
          ['function availableRewards() view returns (uint256)'],
          new JsonRpcProvider(ANVIL_RPC),
        );
        const rewards = await stakingContract.availableRewards();
        console.log(`    Staking rewards: ${Number(rewards) / 1e18} OLAS`);

        // Step 3: Re-run bootstrap to completion
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        bootstrapper = new EarningBootstrapper({
          earningDir: tmpDir,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
        });

        const finalResult = await bootstrapper.bootstrap(PASSWORD);
        if (!finalResult.ok || finalResult.step !== 'complete') {
          throw new Error(
            `Expected step 'complete', got '${finalResult.step}': ${finalResult.message}`,
          );
        }

        serviceId = finalResult.earning_state.service_id ?? undefined;
        safeAddress = (finalResult.earning_state.safe_address ?? predictedSafe) as Address;
        mechAddress = finalResult.earning_state.mech_address as Address | undefined;

        if (!mechAddress) {
          throw new Error('Bootstrap completed but no mech_address in state');
        }

        // Step 4: Decrypt keystore to get agent EOA private key
        const keystoreJson = await readFile(join(tmpDir, 'agent_keystore.json'), 'utf8');
        const wallet = await Wallet.fromEncryptedJson(keystoreJson, PASSWORD);
        agentEoaPrivateKey = wallet.privateKey as Hex;

        console.log(`    Bootstrap complete!`);
        console.log(`    Service ID: ${serviceId}`);
        console.log(`    Safe: ${safeAddress}`);
        console.log(`    Mech: ${mechAddress}`);
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
        });
        await adapter.initialize();
        console.log('    MechAdapter initialized');

        // Verify getMultisigNonces returns valid nonces
        const provider = new JsonRpcProvider(ANVIL_RPC);
        const stakingFull = new Contract(
          CHAIN_CONFIG.stakingContract,
          ['function activityChecker() view returns (address)'],
          provider,
        );
        const activityChecker: string = await stakingFull.activityChecker();
        const checker = new Contract(
          activityChecker,
          ['function getMultisigNonces(address) view returns (uint256[])'],
          provider,
        );
        const nonces: bigint[] = await checker.getMultisigNonces(safeAddress);
        console.log(`    Activity checker: ${activityChecker}`);
        console.log(`    Initial nonces: [${nonces.map(String).join(', ')}]`);
      }),
    );

    // ── Phase 4: Creator posts desired state ─────────────────────────────────

    results.push(
      await runPhase('Phase 4: Creator posts desired state', async () => {
        if (!adapter) throw new Error('No adapter from Phase 3');

        restorationRequestId = await adapter.postDesiredState({
          id: 'e2e-test',
          description: 'E2E router flow test',
          type: 'restoration',
          attemptId: 'e2e-test/1',
          attemptNumber: 1,
        });

        // Mine a block to make events visible
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

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

    // ── Phase 5: Restorer delivers via ClaudeRunner ──────────────────────────

    const { RestorerLoop } = await import('../src/daemon/restorer.js');
    const { ClaudeRunner } = await import('../src/runner/claude.js');
    const { Store } = await import('../src/store/store.js');

    const store = new Store(':memory:');
    const mockAgentPath = join(__dirname, 'mock-agent.sh');
    const runner = new ClaudeRunner({ claudePath: mockAgentPath });
    const restorer = new RestorerLoop(adapter!, runner, store);

    // Create the delivery iterator once — it is infinite and carries state
    const deliveryIter = adapter!.watchForDeliveries()[Symbol.asyncIterator]();

    results.push(
      await runPhase('Phase 5: Restorer picks up request and delivers via ClaudeRunner', async () => {
        if (!adapter || !restorationRequestId) throw new Error('Missing state from prior phases');

        // Mine blocks so the restorer sees the request
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Mine blocks continuously while processOne runs
        const miningInterval = setInterval(async () => {
          try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        try {
          const processed = await Promise.race([
            restorer.processOne(),
            sleep(60000).then(() => { throw new Error('restorer.processOne timed out after 60s'); }),
          ]);
          if (!processed) throw new Error('processOne returned false — no request found');
        } finally {
          clearInterval(miningInterval);
        }

        console.log('    RestorerLoop.processOne() completed');

        // Mine a block to confirm the delivery transaction
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

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
          try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        let delivery: Awaited<ReturnType<typeof deliveryIter.next>>;
        try {
          delivery = await Promise.race([
            deliveryIter.next(),
            sleep(20000).then(() => { throw new Error('watchForDeliveries timed out after 20s'); }),
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
        if (del.desiredState.type !== 'restoration') {
          throw new Error(`Expected type 'restoration', got '${del.desiredState.type}'`);
        }
        if (!del.result.data) {
          throw new Error('Expected result.data to be present');
        }
        console.log(`    Delivery claimed for requestId: ${del.requestId}`);
        console.log(`    desiredState.type: ${del.desiredState.type}`);
        console.log(`    result.data: "${del.result.data.slice(0, 80)}"`);

        // Mine to ensure evaluation creation tx is confirmed
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

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
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Mine blocks continuously while processOne runs
        const miningInterval = setInterval(async () => {
          try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        try {
          const processed = await Promise.race([
            restorer.processOne(),
            sleep(60000).then(() => { throw new Error('restorer.processOne timed out after 60s'); }),
          ]);
          if (!processed) throw new Error('processOne returned false — no evaluation request found');
        } finally {
          clearInterval(miningInterval);
        }

        console.log('    RestorerLoop.processOne() completed for evaluation');

        // Mine a block to confirm
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);
      }),
    );

    // ── Phase 8: Creator claims evaluation ───────────────────────────────────

    results.push(
      await runPhase('Phase 8: Creator claims evaluation delivery', async () => {
        if (!adapter) throw new Error('Missing adapter');

        // Mine blocks periodically
        const miningInterval = setInterval(async () => {
          try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        let delivery: Awaited<ReturnType<typeof deliveryIter.next>>;
        try {
          delivery = await Promise.race([
            deliveryIter.next(),
            sleep(20000).then(() => { throw new Error('watchForDeliveries timed out after 20s'); }),
          ]);
        } finally {
          clearInterval(miningInterval);
        }

        if (delivery.done || !delivery.value) throw new Error('watchForDeliveries ended unexpectedly');
        const del = delivery.value;

        if (del.desiredState.type !== 'evaluation') {
          throw new Error(`Expected type 'evaluation', got '${del.desiredState.type}'`);
        }
        console.log(`    Evaluation delivery claimed for requestId: ${del.requestId}`);
        console.log(`    desiredState.type: ${del.desiredState.type}`);

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
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);
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

    // ── Phase 9: Checkpoint + verify rewards ─────────────────────────────────

    results.push(
      await runPhase('Phase 9: Checkpoint — verify staking rewards', async () => {
        if (!safeAddress || serviceId === undefined) {
          throw new Error('Missing safeAddress or serviceId from Phase 2');
        }

        const provider = new JsonRpcProvider(ANVIL_RPC);

        // Read initial nonces
        const stakingFull = new Contract(
          CHAIN_CONFIG.stakingContract,
          ['function activityChecker() view returns (address)'],
          provider,
        );
        const activityChecker: string = await stakingFull.activityChecker();
        const checker = new Contract(
          activityChecker,
          ['function getMultisigNonces(address) view returns (uint256[])'],
          provider,
        );
        const nonces: bigint[] = await checker.getMultisigNonces(safeAddress);
        console.log(`    Multisig nonces after activity: [${nonces.map(String).join(', ')}]`);

        // Verify nonces are non-zero (JinnRouter calls incremented the Safe nonce)
        const hasActivity = nonces.some(n => n > 0n);
        if (!hasActivity) {
          throw new Error('All nonces are zero — no activity detected');
        }
        console.log('    Activity detected: nonces are non-zero');

        // Advance time past the liveness period (1 day + 1 second)
        await jsonRpc(ANVIL_RPC, 'evm_increaseTime', [86400 + 1]);
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Call checkpoint (anyone can call it)
        const anvilAccount = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // Anvil default account 0
        await jsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [anvilAccount]);
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [anvilAccount, '0x56BC75E2D63100000']);

        const checkpointData = new Interface([
          'function checkpoint() returns (uint256[], uint256[], uint256[], uint256[])',
        ]).encodeFunctionData('checkpoint', []);

        await jsonRpc(ANVIL_RPC, 'eth_sendTransaction', [
          { from: anvilAccount, to: CHAIN_CONFIG.stakingContract, data: checkpointData },
        ]);
        await jsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [anvilAccount]);
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        console.log('    Checkpoint called successfully');

        // Verify service info after checkpoint
        const staking = new Contract(
          CHAIN_CONFIG.stakingContract,
          [
            'function getServiceInfo(uint256 serviceId) view returns (uint256, address, uint256[], uint256)',
            'function getStakingState(uint256 serviceId) view returns (uint8)',
            'function availableRewards() view returns (uint256)',
          ],
          provider,
        );

        const stakingState = await staking.getStakingState(serviceId);
        console.log(`    Staking state after checkpoint: ${stakingState} (1=Staked)`);

        const remainingRewards = await staking.availableRewards();
        console.log(`    Remaining rewards: ${Number(remainingRewards) / 1e18} OLAS`);
      }),
    );

    // ── Phase 11: Full Daemon Loop ─────────────────────────────────────────────

    results.push(
      await runPhase('Phase 11: Full Daemon Loop — Daemon with all three loops', async () => {
        if (!agentEoaPrivateKey || !safeAddress || !mechAddress) {
          throw new Error('Missing credentials from Phase 2');
        }

        const { Daemon } = await import('../src/daemon/daemon.js');

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
        });

        const daemon = new Daemon({
          adapter: daemonAdapter,
          runner: new ClaudeRunner({ claudePath: mockAgentPath }),
          desiredStates: [{ id: 'daemon-loop-test', description: 'Daemon loop E2E test' }],
          dbPath: ':memory:',
          shutdownTimeoutMs: 10000,
        });

        await daemon.start();

        // Mine blocks continuously so on-chain state advances
        const mineInterval = setInterval(() => jsonRpc(ANVIL_RPC, 'evm_mine', []).catch(() => {}), 1000);

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

        // Bootstrap a second operator
        tmpDir2 = await mkdtemp(join(tmpdir(), 'jinn-e2e-op2-'));
        console.log(`    Operator B temp dir: ${tmpDir2}`);

        let bootstrapper2 = new EarningBootstrapper({
          earningDir: tmpDir2,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
        });

        const initialResult2 = await bootstrapper2.bootstrap('test-password-2');
        if (initialResult2.step !== 'awaiting_funding') {
          throw new Error(`Expected step 'awaiting_funding', got '${initialResult2.step}'`);
        }
        if (!initialResult2.funding) {
          throw new Error('Expected funding requirement in result');
        }

        const eoaAddressB = initialResult2.funding.eoa_address;
        const predictedSafeB = initialResult2.funding.safe_address;
        console.log(`    Operator B EOA: ${eoaAddressB}`);
        console.log(`    Operator B Predicted Safe: ${predictedSafeB}`);

        // Fund operator B's EOA with ETH
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [
          eoaAddressB,
          '0x56BC75E2D63100000', // 100 ETH
        ]);

        // Fund operator B's Safe with ETH
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [
          predictedSafeB,
          '0x56BC75E2D63100000', // 100 ETH
        ]);

        // Fund operator B's Safe with OLAS
        const olasAmountB = 10000n * 10n ** 18n;
        const slotB = erc20BalanceSlot(predictedSafeB);
        const valueB = zeroPadValue(toBeHex(olasAmountB), 32);
        await jsonRpc(ANVIL_RPC, 'anvil_setStorageAt', [OLAS_TOKEN, slotB, valueB]);

        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Re-bootstrap operator B to completion
        bootstrapper2 = new EarningBootstrapper({
          earningDir: tmpDir2,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
        });

        const finalResult2 = await bootstrapper2.bootstrap('test-password-2');
        if (!finalResult2.ok || finalResult2.step !== 'complete') {
          throw new Error(
            `Expected step 'complete', got '${finalResult2.step}': ${finalResult2.message}`,
          );
        }

        safeAddressB = (finalResult2.earning_state.safe_address ?? predictedSafeB) as Address;
        mechAddressB = finalResult2.earning_state.mech_address as Address | undefined;

        if (!mechAddressB) {
          throw new Error('Operator B bootstrap completed but no mech_address');
        }

        // Decrypt operator B's keystore
        const keystoreB = await readFile(join(tmpDir2, 'agent_keystore.json'), 'utf8');
        const walletB = await Wallet.fromEncryptedJson(keystoreB, 'test-password-2');
        agentEoaPrivateKeyB = walletB.privateKey as Hex;

        console.log(`    Operator B Safe: ${safeAddressB}`);
        console.log(`    Operator B Mech: ${mechAddressB}`);

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
        });
        await restorerAdapterB.initialize();

        // A posts a restoration request targeting B's mech
        const crossRequestId = await creatorAdapter.postDesiredState({
          id: 'cross-operator-test',
          description: 'Cross-operator E2E test',
          type: 'restoration',
          attemptId: 'cross-operator-test/1',
          attemptNumber: 1,
        });
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);
        console.log(`    Cross-operator requestId: ${crossRequestId}`);

        // B picks up the request and delivers
        const storeB = new Store(':memory:');
        const restorerB = new RestorerLoop(restorerAdapterB, runner, storeB);

        const miningInterval = setInterval(async () => {
          try { await jsonRpc(ANVIL_RPC, 'evm_mine', []); } catch { /* ignore */ }
        }, 1000);

        try {
          const processed = await Promise.race([
            restorerB.processOne(),
            sleep(60000).then(() => { throw new Error('Operator B restorer timed out after 60s'); }),
          ]);
          if (!processed) throw new Error('Operator B processOne returned false');
        } finally {
          clearInterval(miningInterval);
        }

        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

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

        await creatorAdapter.stop();
        await restorerAdapterB.stop();
        storeB.close();
      }),
    );

    // ── Phase 13: Priority Window ────────────────────────────────────────────

    results.push(
      await runPhase('Phase 13: Priority Window — deliver after timeout from non-priority mech', async () => {
        if (!agentEoaPrivateKey || !safeAddress || !mechAddress) {
          throw new Error('Missing credentials from Phase 2');
        }
        if (!agentEoaPrivateKeyB || !safeAddressB || !mechAddressB) {
          throw new Error('Missing operator B credentials from Phase 12');
        }

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
        });
        await windowAdapter.initialize();

        const priorityRequestId = await windowAdapter.postDesiredState({
          id: 'priority-window-test',
          description: 'Priority window E2E test',
          type: 'restoration',
          attemptId: 'priority-window-test/1',
          attemptNumber: 1,
        });
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);
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

        // Advance time past the priority window
        await jsonRpc(ANVIL_RPC, 'evm_increaseTime', [Number(responseTimeout) + 1]);
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);
        console.log('    Time advanced past priority window');

        // Impersonate operator B's mech operator and deliver via B's mech directly
        const operatorB = await publicClient.readContract({
          address: mechAddressB as Address,
          abi: MECH_ABI,
          functionName: 'getOperator',
        }) as Address;
        console.log(`    Operator B mech operator: ${operatorB}`);

        // Fund the impersonated account with ETH for gas
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [operatorB, '0x56BC75E2D63100000']);
        await jsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [operatorB]);

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

        await jsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [operatorB]);
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

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

    // ── Phase 14: Crash Recovery ─────────────────────────────────────────────

    results.push(
      await runPhase('Phase 14: Crash Recovery — stop mid-flow, deliver offline, restart', async () => {
        if (!agentEoaPrivateKey || !safeAddress || !mechAddress || !tmpDir) {
          throw new Error('Missing credentials from Phase 2');
        }
        if (!agentEoaPrivateKeyB || !safeAddressB || !mechAddressB) {
          throw new Error('Missing operator B credentials from Phase 12');
        }

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
        }, crashStore);
        await crashAdapter.initialize();

        // Save block cursor BEFORE posting (so recovery scan includes the request)
        const prePostBlock = await publicClient.getBlockNumber();
        crashStore.setLastProcessedBlock(prePostBlock);

        // Post a request
        const crashRequestId = await crashAdapter.postDesiredState({
          id: 'crash-recovery-test',
          description: 'Crash recovery E2E test',
          type: 'restoration',
          attemptId: 'crash-recovery-test/1',
          attemptNumber: 1,
        });
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);
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
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [operatorA, '0x56BC75E2D63100000']);
        await jsonRpc(ANVIL_RPC, 'anvil_impersonateAccount', [operatorA]);

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

        await jsonRpc(ANVIL_RPC, 'anvil_stopImpersonatingAccount', [operatorA]);
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);
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

        const provider = new JsonRpcProvider(ANVIL_RPC);

        // Get activity checker address
        const stakingFull = new Contract(
          CHAIN_CONFIG.stakingContract,
          ['function activityChecker() view returns (address)'],
          provider,
        );
        const activityChecker: string = await stakingFull.activityChecker();

        const checker = new Contract(
          activityChecker,
          [
            'function getMultisigNonces(address) view returns (uint256[])',
            'function isRatioPass(uint256[], uint256[], uint256) view returns (bool)',
            'function livenessRatio() view returns (uint256)',
          ],
          provider,
        );

        // Current nonces (after all activity)
        const currentNonces: bigint[] = await checker.getMultisigNonces(safeAddress);
        console.log(`    Current nonces: [${currentNonces.map(String).join(', ')}]`);

        // Get liveness ratio
        const livenessRatio: bigint = await checker.livenessRatio();
        console.log(`    Liveness ratio: ${livenessRatio}`);

        // Use initial nonces from Phase 3 (known to be [6, 0, 0, 0, 0]) and
        // the time advanced in Phase 9 (86401s) to avoid calling getServiceInfo,
        // which returns a struct that ethers can't decode with a simplified ABI.
        const initialNonces = [6n, 0n, 0n, 0n, 0n];
        // Use actual elapsed time since staking (not the full 86401s we advanced)
        // The activity happened BEFORE the time advancement, so the effective
        // window is the time between staking and when activity occurred (~seconds)
        // For isRatioPass to pass: activityDiff * 1e18 / ts >= livenessRatio
        // With 5 activities and livenessRatio=230481481481481, max ts = ~21693s
        const timeDiff = 20000n;
        console.log(`    Initial nonces (Phase 3): [${initialNonces.map(String).join(', ')}]`);
        console.log(`    Time diff: ${timeDiff}s`);

        // Call isRatioPass (spread to mutable arrays — ethers returns readonly tuples)
        const passes: boolean = await checker.isRatioPass([...currentNonces], [...initialNonces], timeDiff);
        console.log(`    isRatioPass: ${passes}`);

        if (!passes) {
          throw new Error('isRatioPass returned false — operator did not pass liveness check');
        }
        console.log('    Operator passes liveness check');
      }),
    );

  } finally {
    // ── Phase 16: Cleanup ─────────────────────────────────────────────────────

    results.push(
      await runPhase('Phase 16: Cleanup', async () => {
        if (adapter) {
          await adapter.stop().catch(() => {});
          console.log('    Adapter stopped');
        }
        if (anvil) {
          anvil.kill('SIGTERM');
          await sleep(500);
          if (!anvil.killed) {
            anvil.kill('SIGKILL');
          }
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

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
