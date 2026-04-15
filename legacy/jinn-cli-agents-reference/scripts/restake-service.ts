#!/usr/bin/env tsx
/**
 * Restake an evicted service in a staking contract
 *
 * This script handles the full restake flow:
 * 1. Check staking state (skip if already staked, error if not evicted)
 * 2. Unstake evicted service (reclaims NFT)
 * 3. Approve NFT transfer to staking contract
 * 4. Stake service
 * 5. Verify staking state
 *
 * Usage:
 *   # Service 165 (olas-operate-middleware profile):
 *   source .env && OPERATE_PROFILE_DIR=olas-operate-middleware/.operate \
 *     npx tsx scripts/restake-service.ts --service-id=165
 *
 *   # Service 359 (jinn-node profile):
 *   source .env && OPERATE_PROFILE_DIR=/Users/gcd/Repositories/main/jinn-node/.operate \
 *     npx tsx scripts/restake-service.ts --service-id=359
 *
 *   # Custom staking contract:
 *   npx tsx scripts/restake-service.ts --service-id=165 --staking-contract=0x...
 *
 * Environment:
 *   OPERATE_PASSWORD - Required to decrypt master wallet for signing transactions
 *   OPERATE_PROFILE_DIR - Path to .operate directory containing wallet keystore
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Load root .env before jinn-node/env (which resolves repoRoot to jinn-node/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import 'jinn-node/env';
import { ethers } from 'ethers';
import { getMasterPrivateKey, getMasterSafe } from 'jinn-node/env/operate-profile';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_STAKING_CONTRACT = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139'; // Jinn
const SERVICE_REGISTRY = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE';

// Use public RPC for both reads and tx sending (Tenderly hangs on sends)
const PUBLIC_RPC = 'https://base.publicnode.com';

// ABIs — ethers v6 human-readable format
const STAKING_ABI = [
  'function stake(uint256 serviceId) external',
  'function unstake(uint256 serviceId) external returns (uint256)',
  'function getServiceIds() view returns (uint256[])',
  'function getStakingState(uint256 serviceId) view returns (uint8)',
];

const SERVICE_REGISTRY_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function approve(address to, uint256 tokenId) external',
  'function getApproved(uint256 tokenId) view returns (address)',
];

const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
];

// Staking state enum: 0=Unstaked, 1=Staked, 2=Evicted
const STAKING_STATE_LABELS: Record<number, string> = {
  0: 'Unstaked',
  1: 'Staked',
  2: 'Evicted',
};

// ============================================================================
// Arg Parsing
// ============================================================================

function parseArgs(): { serviceIds: number[]; stakingContract: string } {
  const args = process.argv.slice(2);
  const serviceIds: number[] = [];
  let stakingContract = DEFAULT_STAKING_CONTRACT;

  for (const arg of args) {
    if (arg.startsWith('--service-id=')) {
      // Support comma-separated: --service-id=387,388,389,390
      const ids = arg.split('=')[1].split(',').map(s => parseInt(s.trim(), 10));
      serviceIds.push(...ids);
    } else if (arg.startsWith('--staking-contract=')) {
      stakingContract = arg.split('=')[1];
    }
  }

  if (serviceIds.length === 0) {
    console.error('Usage: npx tsx scripts/restake-service.ts --service-id=<ID>[,ID2,ID3] [--staking-contract=<ADDRESS>]');
    console.error(`\nDefault staking contract: ${DEFAULT_STAKING_CONTRACT} (Jinn)`);
    process.exit(1);
  }

  return { serviceIds, stakingContract };
}

// ============================================================================
// Safe Transaction Execution (direct ethers.js, NOT Safe SDK)
// ============================================================================

async function execSafeTx(
  masterSafe: string,
  masterPrivateKey: string,
  provider: ethers.JsonRpcProvider,
  to: string,
  data: string,
  label: string,
): Promise<{ hash: string }> {
  console.log(`\n  ${label}...`);

  const signer = new ethers.Wallet(masterPrivateKey, provider);
  const safe = new ethers.Contract(masterSafe, SAFE_ABI, provider);

  // Read nonce from public RPC
  const nonce = await safe.nonce();

  // Get the Safe transaction hash
  const txHash = await safe.getTransactionHash(
    to, 0n, data, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, nonce,
  );

  // Sign with eth_sign format: v + 4 for Safe
  const signature = await signer.signMessage(ethers.getBytes(txHash));
  const sigBytes = ethers.getBytes(signature);
  const r = ethers.hexlify(sigBytes.slice(0, 32));
  const s = ethers.hexlify(sigBytes.slice(32, 64));
  const v = sigBytes[64] + 4; // eth_sign format for Safe signatures
  const adjustedSig = ethers.concat([r, s, new Uint8Array([v])]);

  // Execute with explicit gasLimit
  const safeWithSigner = new ethers.Contract(masterSafe, SAFE_ABI, signer);
  const tx = await safeWithSigner.execTransaction(
    to, 0n, data, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, adjustedSig,
    { gasLimit: 2_000_000 },
  );
  console.log(`    TX: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status === 0) {
    throw new Error(`Transaction reverted: ${tx.hash}`);
  }
  console.log(`    Confirmed in block ${receipt.blockNumber}`);
  return { hash: tx.hash };
}

// ============================================================================
// Main
// ============================================================================

async function restakeService(
  serviceId: number,
  stakingContract: string,
  masterSafe: string,
  masterPrivateKey: string,
  provider: ethers.JsonRpcProvider,
  staking: ethers.Contract,
  registry: ethers.Contract,
): Promise<boolean> {
  const stakingIface = new ethers.Interface(STAKING_ABI);
  const registryIface = new ethers.Interface(SERVICE_REGISTRY_ABI);

  console.log(`\n  [${serviceId}] Checking staking state...`);
  const stakingState = Number(await staking.getStakingState(serviceId));
  const stateLabel = STAKING_STATE_LABELS[stakingState] ?? `Unknown(${stakingState})`;
  console.log(`  [${serviceId}] State: ${stakingState} (${stateLabel})`);

  if (stakingState === 1) {
    console.log(`  [${serviceId}] Already staked. Skipping.`);
    return true;
  }

  if (stakingState !== 2) {
    console.error(`  [${serviceId}] ERROR: Not evicted (state=${stakingState}). Skipping.`);
    return false;
  }

  // Unstake
  console.log(`  [${serviceId}] Unstaking...`);
  await execSafeTx(masterSafe, masterPrivateKey, provider, stakingContract,
    stakingIface.encodeFunctionData('unstake', [serviceId]),
    `[${serviceId}] Unstaking evicted service`);

  // Approve
  console.log(`  [${serviceId}] Approving NFT...`);
  await execSafeTx(masterSafe, masterPrivateKey, provider, SERVICE_REGISTRY,
    registryIface.encodeFunctionData('approve', [stakingContract, serviceId]),
    `[${serviceId}] Approving NFT transfer`);

  // Stake
  console.log(`  [${serviceId}] Staking...`);
  await execSafeTx(masterSafe, masterPrivateKey, provider, stakingContract,
    stakingIface.encodeFunctionData('stake', [serviceId]),
    `[${serviceId}] Staking service`);

  // Verify
  const finalState = Number(await staking.getStakingState(serviceId));
  if (finalState !== 1) {
    console.error(`  [${serviceId}] ERROR: Expected state=1 but got ${finalState}`);
    return false;
  }
  console.log(`  [${serviceId}] Restaked successfully.`);
  return true;
}

async function main() {
  const { serviceIds, stakingContract } = parseArgs();

  console.log('================================================================');
  console.log('  Restake Evicted Services');
  console.log('================================================================');
  console.log(`  Service IDs:       ${serviceIds.join(', ')}`);
  console.log(`  Staking Contract:  ${stakingContract}`);
  console.log();

  const provider = new ethers.JsonRpcProvider(PUBLIC_RPC);
  const staking = new ethers.Contract(stakingContract, STAKING_ABI, provider);
  const registry = new ethers.Contract(SERVICE_REGISTRY, SERVICE_REGISTRY_ABI, provider);

  // Check slot availability
  const currentIds: bigint[] = await staking.getServiceIds();
  const maxServices = Number(await new ethers.Contract(stakingContract, [
    'function maxNumServices() view returns (uint256)',
  ], provider).maxNumServices());
  const availableSlots = maxServices - currentIds.length;
  console.log(`  Slots: ${currentIds.length}/${maxServices} used, ${availableSlots} available`);
  console.log(`  Currently staked: [${currentIds.map(Number).join(', ')}]`);

  if (serviceIds.length > availableSlots) {
    console.error(`\n  ERROR: Need ${serviceIds.length} slots but only ${availableSlots} available.`);
    process.exit(1);
  }

  // Initialize wallet
  const masterPrivateKey = getMasterPrivateKey();
  if (!masterPrivateKey) {
    console.error('\n  ERROR: Failed to get master wallet private key.');
    console.error('  Ensure OPERATE_PASSWORD is set and OPERATE_PROFILE_DIR points to the .operate directory.');
    process.exit(1);
  }

  const masterSafe = getMasterSafe('base');
  if (!masterSafe) {
    console.error('\n  ERROR: Failed to get master Safe address for Base.');
    process.exit(1);
  }
  console.log(`  Master Safe: ${masterSafe}`);

  // Restake each service sequentially
  const results: { id: number; ok: boolean }[] = [];
  for (const serviceId of serviceIds) {
    console.log(`\n================================================================`);
    console.log(`  Restaking service ${serviceId} (${results.length + 1}/${serviceIds.length})`);
    console.log(`================================================================`);
    try {
      const ok = await restakeService(serviceId, stakingContract, masterSafe, masterPrivateKey, provider, staking, registry);
      results.push({ id: serviceId, ok });
    } catch (err: any) {
      console.error(`  [${serviceId}] FAILED: ${err.message}`);
      results.push({ id: serviceId, ok: false });
    }
  }

  // Final summary
  console.log('\n================================================================');
  console.log('  Summary');
  console.log('================================================================');
  const finalIds: bigint[] = await staking.getServiceIds();
  console.log(`  Staked services: [${finalIds.map(Number).join(', ')}]`);
  for (const r of results) {
    console.log(`  Service ${r.id}: ${r.ok ? 'OK' : 'FAILED'}`);
  }
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    console.error(`\n  ${failed.length} service(s) failed to restake.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nRestake failed:', err);
  process.exit(1);
});
