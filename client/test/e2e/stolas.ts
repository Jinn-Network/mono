/**
 * Anvil-based validation script for the stOLAS bootstrap flow.
 *
 * Validates the complete stOLAS earning bootstrap on a Base mainnet fork:
 *   wallet -> awaiting_funding (ETH only) -> stOLAS stake() -> mech_deployed -> complete
 *
 * The stOLAS ExternalStakingDistributor funds the OLAS bond from LemonTree
 * capital — the operator only needs ETH for gas.
 *
 * Usage: yarn stolas   (or `yarn exec tsx scripts/stolas-validate.ts`)
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
  STOLAS_DISTRIBUTOR,
  STOLAS_DISTRIBUTOR_ABI,
  STOLAS_STAKING_SLOTS_ABI,
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
  console.log('\n=== stOLAS Bootstrap Validation (Anvil Fork) ===\n');

  let chain: AnvilHarness | null = null;
  let tmpDir: string | null = null;
  const results: PhaseResult[] = [];

  let bootstrapper: FleetBootstrapper | undefined;
  let eoaAddress: string | undefined;
  let serviceId: number | undefined;
  let safeAddress: string | undefined;

  try {
    // ── Phase 1: Infrastructure ──────────────────────────────────────────────

    results.push(
      await runPhase('Phase 1: Spawn Anvil fork', async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'jinn-stolas-'));
        console.log(`    Temp dir: ${tmpDir}`);

        chain = await spawnAnvilFork({ forkUrl: BASE_RPC_URL, silent: true });
        ANVIL_PORT = chain.port;
        ANVIL_RPC = chain.rpcUrl;

        const blockNum = await anvilJsonRpc(ANVIL_RPC, 'eth_blockNumber');
        console.log(`    Anvil forked at block ${parseInt(blockNum as string, 16)}`);
      }),
    );

    // ── Phase 2: Preflight — verify stOLAS is configured ─────────────────────

    results.push(
      await runPhase('Phase 2: stOLAS preflight check', async () => {
        const publicClient = createPublicClient({ chain: base, transport: http(ANVIL_RPC) });

        // Check distributor is configured for our staking contract
        const proxyConfig = await publicClient.readContract({
          address: STOLAS_DISTRIBUTOR as Address,
          abi: STOLAS_DISTRIBUTOR_ABI,
          functionName: 'mapStakingProxyConfigs',
          args: [CHAIN_CONFIG.stakingContract as Address],
        });
        console.log(`    Distributor config for ${CHAIN_CONFIG.stakingContract}: ${proxyConfig}`);

        if (proxyConfig === 0n) {
          throw new Error(
            `stOLAS distributor is NOT configured for staking contract ${CHAIN_CONFIG.stakingContract}. ` +
            `This means the contract hasn't been whitelisted yet.`,
          );
        }

        // Check staking slots
        const serviceIds = await publicClient.readContract({
          address: CHAIN_CONFIG.stakingContract as Address,
          abi: STOLAS_STAKING_SLOTS_ABI,
          functionName: 'getServiceIds',
        });
        const maxServices = await publicClient.readContract({
          address: CHAIN_CONFIG.stakingContract as Address,
          abi: STOLAS_STAKING_SLOTS_ABI,
          functionName: 'maxNumServices',
        });
        const slotsRemaining = Number(maxServices) - serviceIds.length;
        console.log(`    Staking slots: ${serviceIds.length}/${maxServices} used, ${slotsRemaining} remaining`);

        if (slotsRemaining <= 0) {
          throw new Error('No staking slots available');
        }
      }),
    );

    // ── Phase 3: Bootstrap to awaiting_funding ───────────────────────────────

    results.push(
      await runPhase('Phase 3: Bootstrap to awaiting_funding (ETH only)', async () => {
        if (!tmpDir) throw new Error('No temp dir from Phase 1');

        bootstrapper = new FleetBootstrapper({
          earningDir: tmpDir,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
          stakingMode: 'standard',
        });

        const result = await bootstrapper.bootstrap(PASSWORD);

        // Fleet bootstrap returns funding requirement when master needs ETH
        if (!result.funding) {
          throw new Error(`Expected funding requirement, got ok=${result.ok}`);
        }

        eoaAddress = result.funding.master_address;

        console.log(`    Master EOA: ${eoaAddress}`);
        console.log(`    ETH required: ${result.funding.eth_required} wei`);
      }),
    );

    // ── Phase 4: Fund EOA with ETH (no OLAS needed!) ─────────────────────────

    results.push(
      await runPhase('Phase 4: Fund agent EOA with ETH only', async () => {
        if (!eoaAddress) throw new Error('Missing EOA from Phase 3');

        // Fund with 1 ETH — way more than needed but ensures no gas issues
        await anvilJsonRpc(ANVIL_RPC, 'anvil_setBalance', [
          eoaAddress,
          '0xDE0B6B3A7640000', // 1 ETH in hex
        ]);

        const fundClient = createPublicClient({ chain: base, transport: http(ANVIL_RPC) });
        const balance = await fundClient.getBalance({ address: eoaAddress as Address });
        console.log(`    Funded EOA with 1 ETH — balance: ${balance}`);

        if (balance === 0n) {
          throw new Error('EOA ETH balance is still 0 after anvil_setBalance');
        }
      }),
    );

    // ── Phase 5: Bootstrap to completion via stOLAS ──────────────────────────

    results.push(
      await runPhase('Phase 5: Bootstrap to completion (stOLAS stake)', async () => {
        if (!tmpDir) throw new Error('No temp dir');

        await anvilJsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Re-create bootstrapper with fresh provider
        bootstrapper = new FleetBootstrapper({
          earningDir: tmpDir,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
          stakingMode: 'standard',
        });

        const result = await bootstrapper.bootstrap(PASSWORD);

        if (!result.ok) {
          throw new Error(
            `Expected bootstrap complete, got: ${result.message}`,
          );
        }

        const firstService = result.fleet_state.services[0];
        serviceId = firstService?.service_id ?? undefined;
        safeAddress = firstService?.safe_address ?? undefined;

        console.log(`    Bootstrap complete!`);
        console.log(`    Service ID: ${serviceId}`);
        console.log(`    Safe address: ${safeAddress}`);
        console.log(`    Mech address: ${firstService?.mech_address}`);
        console.log(`    Staking mode: ${result.fleet_state.staking_mode}`);
      }),
    );

    // ── Phase 6: Verify on-chain state ───────────────────────────────────────

    results.push(
      await runPhase('Phase 6: Verify on-chain state', async () => {
        if (serviceId === undefined || !safeAddress) {
          throw new Error('Missing serviceId or safeAddress from Phase 5');
        }

        const publicClient = createPublicClient({ chain: base, transport: http(ANVIL_RPC) });

        // Service state should be Deployed (4)
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

        // Service should be staked
        const stakingAbi = parseAbi([
          'function getServiceIds() view returns (uint256[])',
          'function getStakingState(uint256) view returns (uint8)',
        ]);
        const stakedIds = await publicClient.readContract({
          address: CHAIN_CONFIG.stakingContract as Address,
          abi: stakingAbi,
          functionName: 'getServiceIds',
        });
        const isStaked = stakedIds.map(Number).includes(serviceId);
        console.log(`    Staked services: [${stakedIds.join(', ')}]`);
        console.log(`    Our service ${serviceId} is staked: ${isStaked}`);

        if (!isStaked) {
          throw new Error(`Service ${serviceId} not found in staked services`);
        }

        const stakingState = await publicClient.readContract({
          address: CHAIN_CONFIG.stakingContract as Address,
          abi: stakingAbi,
          functionName: 'getStakingState',
          args: [BigInt(serviceId)],
        });
        console.log(`    Staking state: ${stakingState} (1=Staked)`);

        if (Number(stakingState) !== 1) {
          throw new Error(`Staking state is ${stakingState}, expected 1 (Staked)`);
        }
      }),
    );

  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────────

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
