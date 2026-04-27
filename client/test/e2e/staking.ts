/**
 * Anvil-based validation script for the earning bootstrap.
 *
 * Validates the complete earning bootstrap lifecycle on a Base mainnet fork:
 *   wallet -> safe_predicted -> awaiting_funding -> safe_deployed ->
 *   service_created -> service_activated -> agents_registered ->
 *   service_deployed -> service_staked -> complete
 *
 * Funds the EOA (ETH) and Safe (OLAS) on Anvil to unblock the funding gate,
 * then verifies on-chain state after the bootstrap completes.
 *
 * Usage: yarn staking   (or `yarn exec tsx scripts/staking-validate.ts`)
 */

import { spawnAnvilFork, jsonRpc as anvilJsonRpc, type AnvilHarness } from '../_support/chain/anvil.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { base } from 'viem/chains';
import { FleetBootstrapper } from '../../src/earning/bootstrap.js';
import {
  SERVICE_REGISTRY_L2_ABI,
  getChainConfig,
} from '../../src/earning/contracts.js';

// ── Constants ────────────────────────────────────────────────────────────────

const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
let ANVIL_PORT = 0;
let ANVIL_RPC = '';
const PASSWORD = 'test-password';

const CHAIN_CONFIG = getChainConfig('base');

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== Earning Bootstrap Staking Validation (Anvil Fork) ===\n');

  let chain: AnvilHarness | null = null;
  let tmpDir: string | null = null;
  const results: PhaseResult[] = [];

  // Shared state populated across phases
  let bootstrapper: FleetBootstrapper | undefined;
  let eoaAddress: string | undefined;
  let safeAddress: string | undefined;
  let serviceId: number | undefined;

  try {
    // ── Phase 1: Infrastructure ──────────────────────────────────────────────

    results.push(
      await runPhase('Phase 1: Infrastructure — spawn Anvil fork, create temp dir', async () => {
        // Create temp directory for earning store
        tmpDir = await mkdtemp(join(tmpdir(), 'jinn-staking-'));
        console.log(`    Temp dir: ${tmpDir}`);

        chain = await spawnAnvilFork({ forkUrl: BASE_RPC_URL, silent: true });
        ANVIL_PORT = chain.port;
        ANVIL_RPC = chain.rpcUrl;

        const blockNum = await anvilJsonRpc(ANVIL_RPC, 'eth_blockNumber');
        console.log(`    Anvil forked at block ${parseInt(blockNum as string, 16)}`);
      }),
    );

    // ── Phase 2: Bootstrap to awaiting_funding ───────────────────────────────

    results.push(
      await runPhase('Phase 2: Bootstrap to awaiting_funding', async () => {
        if (!tmpDir) throw new Error('No temp dir from Phase 1');

        bootstrapper = new FleetBootstrapper({
          earningDir: tmpDir,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
        });

        const result = await bootstrapper.bootstrap(PASSWORD);

        if (!result.funding) {
          throw new Error(`Expected funding requirement, got ok=${result.ok}`);
        }

        eoaAddress = result.funding.master_address;
        // Safe address is predicted but not yet deployed — get from fleet state if available
        safeAddress = result.fleet_state.services[0]?.safe_address ?? undefined;

        console.log(`    Master EOA: ${eoaAddress}`);
        console.log(`    Safe address (predicted): ${safeAddress}`);
        console.log(`    ETH required: ${result.funding.eth_required} wei`);
      }),
    );

    // ── Phase 3: Fund accounts on Anvil ──────────────────────────────────────

    results.push(
      await runPhase('Phase 3: Fund accounts on Anvil', async () => {
        if (!eoaAddress) throw new Error('Missing master EOA address from Phase 2');

        // Fund EOA with 100 ETH — stOLAS mode, OLAS bond is funded by distributor
        await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [
          eoaAddress,
          '0x56BC75E2D63100000', // 100 ETH in hex
        ]);
        // Verify ETH balance
        const ethCheckClient = createPublicClient({ chain: base, transport: http(ANVIL_RPC) });
        const eoaEthBalance = await ethCheckClient.getBalance({ address: eoaAddress as Address });
        console.log(`    Funded master EOA (${eoaAddress}) with 100 ETH — balance: ${eoaEthBalance}`);
        if (eoaEthBalance === 0n) {
          throw new Error('Master EOA ETH balance is still 0 after anvil_setBalance');
        }
      }),
    );

    // ── Phase 4: Bootstrap to completion ──────────────────────────────────────

    results.push(
      await runPhase('Phase 4: Bootstrap to completion', async () => {
        if (!bootstrapper) throw new Error('No bootstrapper from Phase 2');

        // Mine a block so the provider sees the new balances
        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Re-create bootstrapper with fresh provider to avoid caching
        bootstrapper = new FleetBootstrapper({
          earningDir: tmpDir!,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
        });

        const result = await bootstrapper.bootstrap(PASSWORD);

        if (!result.ok) {
          throw new Error(
            `Expected bootstrap complete, got: ${result.message}`,
          );
        }

        const firstService = result.fleet_state.services[0];
        serviceId = firstService?.service_id ?? undefined;
        safeAddress = firstService?.safe_address ?? safeAddress;

        console.log(`    Bootstrap complete!`);
        console.log(`    Service ID: ${serviceId}`);
        console.log(`    Safe address: ${safeAddress}`);
        console.log(`    Staking contract: ${firstService?.staking_address}`);
      }),
    );

    // ── Phase 5: Verify on-chain state ───────────────────────────────────────

    results.push(
      await runPhase('Phase 5: Verify on-chain state', async () => {
        if (serviceId === undefined || !safeAddress) {
          throw new Error('Missing serviceId or safeAddress from Phase 4');
        }

        const publicClient = createPublicClient({ chain: base, transport: http(ANVIL_RPC) });

        // 5a: Service state should be Deployed (4)
        const service = await publicClient.readContract({
          address: CHAIN_CONFIG.serviceRegistry as Address,
          abi: SERVICE_REGISTRY_L2_ABI,
          functionName: 'getService',
          args: [BigInt(serviceId)],
        });
        const serviceState = Number(service.state);
        console.log(`    Service state: ${serviceState} (expected 4 = Deployed)`);

        if (serviceState !== 4) {
          throw new Error(`Service state is ${serviceState}, expected 4 (Deployed)`);
        }

        // 5b: Service should be staked — getServiceIds includes our service
        const stakingAbi = parseAbi([
          'function getServiceIds() view returns (uint256[])',
          'function getStakingState(uint256) view returns (uint8)',
        ]);
        const serviceIds = await publicClient.readContract({
          address: CHAIN_CONFIG.stakingContract as Address,
          abi: stakingAbi,
          functionName: 'getServiceIds',
        });
        const isStaked = serviceIds.map(Number).includes(serviceId);
        console.log(`    Staked services: [${serviceIds.join(', ')}]`);
        console.log(`    Our service ${serviceId} is staked: ${isStaked}`);

        if (!isStaked) {
          throw new Error(`Service ${serviceId} not found in staked services`);
        }

        // 5c: Check staking state
        const stakingState = await publicClient.readContract({
          address: CHAIN_CONFIG.stakingContract as Address,
          abi: stakingAbi,
          functionName: 'getStakingState',
          args: [BigInt(serviceId)],
        });
        console.log(`    Staking state: ${stakingState} (1=Staked)`);

        // 5d: Read activity checker getMultisigNonces
        // First, get the activity checker address from the staking contract
        const activityChecker = await publicClient.readContract({
          address: CHAIN_CONFIG.stakingContract as Address,
          abi: parseAbi(['function activityChecker() view returns (address)']),
          functionName: 'activityChecker',
        });
        console.log(`    Activity checker: ${activityChecker}`);

        const nonces = await publicClient.readContract({
          address: activityChecker,
          abi: parseAbi(['function getMultisigNonces(address) view returns (uint256[])']),
          functionName: 'getMultisigNonces',
          args: [safeAddress as Address],
        });
        console.log(`    Multisig nonces: [${nonces.map(String).join(', ')}]`);
      }),
    );

  } finally {
    // ── Phase 7: Cleanup ─────────────────────────────────────────────────────

    results.push(
      await runPhase('Cleanup', async () => {
        if (chain) {
          await chain.teardown();
          console.log('    Anvil process terminated');
        }
        if (tmpDir) {
          await rm(tmpDir, { recursive: true, force: true });
          console.log(`    Removed temp dir: ${tmpDir}`);
        }
      }),
    );
  }

  // ── Summary ────────────────────────────────────────────────────────────────

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
