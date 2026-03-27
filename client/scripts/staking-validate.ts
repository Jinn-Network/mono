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
 * Usage: npx tsx scripts/staking-validate.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Contract, JsonRpcProvider, keccak256, AbiCoder, zeroPadValue, toBeHex } from 'ethers';
import { EarningBootstrapper } from '../src/earning/bootstrap.js';
import {
  SERVICE_REGISTRY_L2_ABI,
  STAKING_ABI,
  getChainConfig,
} from '../src/earning/contracts.js';

// ── Constants ────────────────────────────────────────────────────────────────

const BASE_RPC_URL = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
const ANVIL_PORT = 8547;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const PASSWORD = 'test-password';

const CHAIN_CONFIG = getChainConfig('base');
const OLAS_TOKEN = CHAIN_CONFIG.olasToken;

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
  console.log('\n=== Earning Bootstrap Staking Validation (Anvil Fork) ===\n');

  let anvil: ChildProcess | null = null;
  let tmpDir: string | null = null;
  const results: PhaseResult[] = [];

  // Shared state populated across phases
  let bootstrapper: EarningBootstrapper | undefined;
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

        const blockNum = await jsonRpc(ANVIL_RPC, 'eth_blockNumber');
        console.log(`    Anvil forked at block ${parseInt(blockNum as string, 16)}`);
      }),
    );

    // ── Phase 2: Bootstrap to awaiting_funding ───────────────────────────────

    results.push(
      await runPhase('Phase 2: Bootstrap to awaiting_funding', async () => {
        if (!tmpDir) throw new Error('No temp dir from Phase 1');

        bootstrapper = new EarningBootstrapper({
          earningDir: tmpDir,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
        });

        const result = await bootstrapper.bootstrap(PASSWORD);

        if (result.step !== 'awaiting_funding') {
          throw new Error(`Expected step 'awaiting_funding', got '${result.step}'`);
        }

        if (!result.funding) {
          throw new Error('Expected funding requirement in result');
        }

        eoaAddress = result.funding.eoa_address;
        safeAddress = result.funding.safe_address;

        console.log(`    EOA address: ${eoaAddress}`);
        console.log(`    Safe address (predicted): ${safeAddress}`);
        console.log(`    ETH required: ${result.funding.eoa_eth_required} wei`);
        console.log(`    OLAS required: ${result.funding.safe_olas_required} wei`);
      }),
    );

    // ── Phase 3: Fund accounts on Anvil ──────────────────────────────────────

    results.push(
      await runPhase('Phase 3: Fund accounts on Anvil', async () => {
        if (!eoaAddress || !safeAddress) throw new Error('Missing addresses from Phase 2');

        // Fund EOA with 100 ETH
        await jsonRpc(ANVIL_RPC, 'anvil_setBalance', [
          eoaAddress,
          '0x56BC75E2D63100000', // 100 ETH in hex
        ]);
        // Verify ETH balance
        const ethCheckProvider = new JsonRpcProvider(ANVIL_RPC);
        const eoaEthBalance = await ethCheckProvider.getBalance(eoaAddress);
        console.log(`    Funded EOA (${eoaAddress}) with 100 ETH — balance: ${eoaEthBalance}`);
        if (eoaEthBalance === 0n) {
          throw new Error('EOA ETH balance is still 0 after anvil_setBalance');
        }

        // Fund Safe with OLAS using anvil_setStorageAt
        // OLAS on Base uses standard ERC-20 layout: balances mapping at slot 0
        const olasAmount = 10000n * 10n ** 18n; // 10,000 OLAS (2x the bond)
        const slot = erc20BalanceSlot(safeAddress);
        const value = zeroPadValue(toBeHex(olasAmount), 32);

        await jsonRpc(ANVIL_RPC, 'anvil_setStorageAt', [OLAS_TOKEN, slot, value]);

        // Verify OLAS balance
        const provider = new JsonRpcProvider(ANVIL_RPC);
        const olas = new Contract(OLAS_TOKEN, [
          'function balanceOf(address) view returns (uint256)',
        ], provider);
        const balance: bigint = await olas.balanceOf(safeAddress);

        if (balance < CHAIN_CONFIG.bondAmount) {
          throw new Error(
            `OLAS balance ${balance} is less than required bond ${CHAIN_CONFIG.bondAmount}. ` +
            `Storage slot may be wrong — try slot 1 or 2.`,
          );
        }
        console.log(`    Funded Safe (${safeAddress}) with ${balance / 10n ** 18n} OLAS`);

        // Verify EOA ETH balance
        const ethBalance = await provider.getBalance(eoaAddress);
        console.log(`    EOA ETH balance: ${ethBalance / 10n ** 18n} ETH`);
      }),
    );

    // ── Phase 4: Bootstrap to completion ──────────────────────────────────────

    results.push(
      await runPhase('Phase 4: Bootstrap to completion', async () => {
        if (!bootstrapper) throw new Error('No bootstrapper from Phase 2');

        // Mine a block so the provider sees the new balances
        await jsonRpc(ANVIL_RPC, 'evm_mine', []);

        // Re-create bootstrapper with fresh provider to avoid caching
        bootstrapper = new EarningBootstrapper({
          earningDir: tmpDir!,
          chain: 'base',
          rpcUrl: ANVIL_RPC,
        });

        const result = await bootstrapper.bootstrap(PASSWORD);

        if (!result.ok || result.step !== 'complete') {
          throw new Error(
            `Expected step 'complete', got '${result.step}': ${result.message}`,
          );
        }

        serviceId = result.earning_state.service_id ?? undefined;
        safeAddress = result.earning_state.safe_address ?? safeAddress;

        console.log(`    Bootstrap complete!`);
        console.log(`    Service ID: ${serviceId}`);
        console.log(`    Safe address: ${safeAddress}`);
        console.log(`    Staking contract: ${result.earning_state.staking_address}`);
      }),
    );

    // ── Phase 5: Verify on-chain state ───────────────────────────────────────

    results.push(
      await runPhase('Phase 5: Verify on-chain state', async () => {
        if (serviceId === undefined || !safeAddress) {
          throw new Error('Missing serviceId or safeAddress from Phase 4');
        }

        const provider = new JsonRpcProvider(ANVIL_RPC);

        // 5a: Service state should be Deployed (4)
        const registry = new Contract(
          CHAIN_CONFIG.serviceRegistry,
          SERVICE_REGISTRY_L2_ABI,
          provider,
        );
        const service = await registry.getService(serviceId);
        const serviceState = Number(service.state);
        console.log(`    Service state: ${serviceState} (expected 4 = Deployed)`);

        if (serviceState !== 4) {
          throw new Error(`Service state is ${serviceState}, expected 4 (Deployed)`);
        }

        // 5b: Service should be staked — getServiceInfo returns non-zero tsStart
        const staking = new Contract(
          CHAIN_CONFIG.stakingContract,
          STAKING_ABI,
          provider,
        );
        const serviceInfo = await staking.getServiceInfo(serviceId);
        const multisig = serviceInfo[1] as string;
        const tsStart = serviceInfo[3] as bigint;

        console.log(`    Staking multisig: ${multisig}`);
        console.log(`    Staking tsStart: ${tsStart}`);

        if (tsStart === 0n) {
          throw new Error('Service tsStart is 0 — service is not staked');
        }

        if (multisig.toLowerCase() !== safeAddress.toLowerCase()) {
          throw new Error(
            `Staking multisig ${multisig} does not match Safe ${safeAddress}`,
          );
        }

        // 5c: Read getServiceIds from staking contract — should include our service
        const stakingGetIds = new Contract(
          CHAIN_CONFIG.stakingContract,
          ['function getServiceIds() view returns (uint256[])'],
          provider,
        );
        const serviceIds: bigint[] = await stakingGetIds.getServiceIds();
        const found = serviceIds.some(id => Number(id) === serviceId);

        console.log(`    Staked service IDs: [${serviceIds.map(String).join(', ')}]`);
        if (!found) {
          throw new Error(`Service ${serviceId} not found in getServiceIds()`);
        }
        console.log(`    Service ${serviceId} confirmed in staking contract`);

        // 5d: Read activity checker getMultisigNonces
        // First, get the activity checker address from the staking contract
        const stakingFull = new Contract(
          CHAIN_CONFIG.stakingContract,
          ['function activityChecker() view returns (address)'],
          provider,
        );
        const activityChecker: string = await stakingFull.activityChecker();
        console.log(`    Activity checker: ${activityChecker}`);

        const checker = new Contract(
          activityChecker,
          ['function getMultisigNonces(address) view returns (uint256[])'],
          provider,
        );
        const nonces: bigint[] = await checker.getMultisigNonces(safeAddress);
        console.log(`    Multisig nonces: [${nonces.map(String).join(', ')}]`);
      }),
    );

  } finally {
    // ── Phase 7: Cleanup ─────────────────────────────────────────────────────

    results.push(
      await runPhase('Cleanup', async () => {
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
