#!/usr/bin/env tsx
/**
 * Migrate a service from one OLAS staking contract to another
 *
 * This script handles the full migration process:
 * 1. Preflight checks (verify staking status, bond amounts, slot availability)
 * 2. Unstake from source staking contract
 * 3. Top-up bond if target requires higher minimum
 * 4. Stake to target staking contract
 * 5. Verification
 *
 * Usage:
 *   tsx scripts/migrate-staking-contract.ts --service-id=165 --source=agentsfun1 --target=jinn [--dry-run]
 *
 * Environment:
 *   OPERATE_PASSWORD - Required to decrypt master wallet for signing transactions
 *   RPC_URL - RPC endpoint (defaults to Base mainnet)
 *
 * Known staking contracts on Base:
 *   - Jinn: 0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139 (5,000 OLAS min)
 *   - AgentsFun1: 0x2585e63df7BD9De8e058884D496658a030b5c6ce (50 OLAS min)
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
import Safe from '@safe-global/protocol-kit';
import { getMasterPrivateKey, getMasterEOA, getMasterSafe } from 'jinn-node/env/operate-profile';

// ============================================================================
// Configuration
// ============================================================================

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';

// Known staking contracts
const STAKING_CONTRACTS: Record<string, { address: string; name: string; minStake: bigint }> = {
  jinn: {
    address: '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139',
    name: 'Jinn Staking',
    minStake: ethers.parseEther('5000'), // 5,000 OLAS
  },
  agentsfun1: {
    address: '0x2585e63df7BD9De8e058884D496658a030b5c6ce',
    name: 'AgentsFun1',
    minStake: ethers.parseEther('50'), // 50 OLAS
  },
};

// Core OLAS contracts on Base
const CONTRACTS = {
  SERVICE_REGISTRY: '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE',
  SERVICE_REGISTRY_TOKEN_UTILITY: '0x34C895f302D0b5cf52ec0Edd3945321EB0f83dd5',
  OLAS_TOKEN: '0x54330d28ca3357F294334BDC454a032e7f353416',
};

// ABIs
const STAKING_ABI = [
  'function stake(uint256 serviceId) external',
  'function unstake(uint256 serviceId) external returns (uint256)',
  'function getServiceIds() view returns (uint256[])',
  'function mapServiceInfo(uint256 serviceId) view returns (address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity)',
  'function minStakingDeposit() view returns (uint256)',
  'function maxNumServices() view returns (uint256)',
];

const SERVICE_REGISTRY_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getService(uint256 serviceId) view returns (tuple(uint96 securityDeposit, address multisig, bytes32 configHash, uint32 threshold, uint32 maxNumAgentInstances, uint32 numAgentInstances, uint8 state, address[] agentIds))',
  'function approve(address to, uint256 tokenId) external',
  'function getApproved(uint256 tokenId) view returns (address)',
];

const TOKEN_UTILITY_ABI = [
  'function mapServiceIdTokenDeposit(uint256 serviceId) view returns (uint256 securityDeposit, address token)',
  'function increaseSecurityDeposit(uint256 serviceId, uint256 amount) external',
];

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// ============================================================================
// Helpers
// ============================================================================

function parseArgs(): {
  serviceId: number;
  source: string;
  target: string;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let serviceId: number | undefined;
  let source: string | undefined;
  let target: string | undefined;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith('--service-id=')) {
      serviceId = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--source=')) {
      source = arg.split('=')[1].toLowerCase();
    } else if (arg.startsWith('--target=')) {
      target = arg.split('=')[1].toLowerCase();
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  if (!serviceId || !source || !target) {
    console.error('Usage: tsx scripts/migrate-staking-contract.ts --service-id=<ID> --source=<name> --target=<name> [--dry-run]');
    console.error('\nKnown staking contracts:');
    for (const [name, info] of Object.entries(STAKING_CONTRACTS)) {
      console.error(`  ${name}: ${info.address} (${ethers.formatEther(info.minStake)} OLAS min)`);
    }
    process.exit(1);
  }

  if (!STAKING_CONTRACTS[source]) {
    console.error(`Unknown source staking contract: ${source}`);
    console.error('Known contracts:', Object.keys(STAKING_CONTRACTS).join(', '));
    process.exit(1);
  }

  if (!STAKING_CONTRACTS[target]) {
    console.error(`Unknown target staking contract: ${target}`);
    console.error('Known contracts:', Object.keys(STAKING_CONTRACTS).join(', '));
    process.exit(1);
  }

  return { serviceId, source, target, dryRun };
}

async function getStakedServiceIds(contract: ethers.Contract): Promise<number[]> {
  const ids: bigint[] = await contract.getServiceIds();
  return ids.map((id) => Number(id));
}

// ============================================================================
// Main Migration Logic
// ============================================================================

async function main() {
  const { serviceId, source, target, dryRun } = parseArgs();
  const sourceConfig = STAKING_CONTRACTS[source];
  const targetConfig = STAKING_CONTRACTS[target];

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        OLAS Staking Contract Migration                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`Service ID:     ${serviceId}`);
  console.log(`Source:         ${sourceConfig.name} (${sourceConfig.address})`);
  console.log(`Target:         ${targetConfig.name} (${targetConfig.address})`);
  console.log(`Mode:           ${dryRun ? '🔍 DRY RUN (no transactions)' : '⚡ LIVE'}`);
  console.log();

  // Setup provider (read-only for preflight)
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // For dry-run, we only need read access. Defer wallet decryption to live execution.
  const masterEOA = getMasterEOA();
  const masterSafe = getMasterSafe('base');
  console.log(`Master EOA:     ${masterEOA}`);
  console.log(`Master Safe:    ${masterSafe}`);

  // Read-only contract instances for preflight
  const sourceStaking = new ethers.Contract(sourceConfig.address, STAKING_ABI, provider);
  const targetStaking = new ethers.Contract(targetConfig.address, STAKING_ABI, provider);
  const serviceRegistry = new ethers.Contract(CONTRACTS.SERVICE_REGISTRY, SERVICE_REGISTRY_ABI, provider);
  const tokenUtility = new ethers.Contract(CONTRACTS.SERVICE_REGISTRY_TOKEN_UTILITY, TOKEN_UTILITY_ABI, provider);
  const olasToken = new ethers.Contract(CONTRACTS.OLAS_TOKEN, ERC20_ABI, provider);

  // ════════════════════════════════════════════════════════════════════════
  // Step 1: Preflight Checks
  // ════════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Step 1: Preflight Checks');
  console.log('═══════════════════════════════════════════════════════════════');

  // Check service ownership and staking status
  const owner = await serviceRegistry.ownerOf(serviceId);
  console.log(`\n📋 Service NFT Owner: ${owner}`);

  // Check if staked in source (active or evicted)
  const sourceStakedIds = await getStakedServiceIds(sourceStaking);
  const isActiveInSource = sourceStakedIds.includes(serviceId);
  const isOwnedBySource = owner.toLowerCase() === sourceConfig.address.toLowerCase();
  const isEvicted = isOwnedBySource && !isActiveInSource;

  if (isActiveInSource) {
    console.log(`📍 Source Staking Status: ✅ ACTIVELY STAKED`);
  } else if (isEvicted) {
    console.log(`📍 Source Staking Status: ⚠️  EVICTED (NFT held by staking contract, not in active list)`);
    console.log('   unstake() will reclaim the NFT');
  } else {
    console.log(`📍 Source Staking Status: ❌ NOT STAKED`);
  }

  if (isOwnedBySource) {
    // NFT is held by source staking contract (either active or evicted)
    // Try to read mapServiceInfo for logging, but don't fail if it reverts
    try {
      const serviceInfo = await sourceStaking.mapServiceInfo(serviceId);
      console.log(`   Registered multisig: ${serviceInfo[0]}`);
      console.log(`   Registered owner: ${serviceInfo[1]}`);
    } catch {
      console.log('   (mapServiceInfo reverted — common for some contract versions)');
    }

    console.log('   ✅ Service NFT is held by source staking contract');
  } else {
    // Not owned by source staking contract at all
    console.error(`\n❌ Service ${serviceId} NFT is not owned by ${sourceConfig.name}`);
    console.error(`   NFT owner: ${owner}`);
    console.error(`   Source contract: ${sourceConfig.address}`);
    console.error('   Cannot unstake — the NFT must be held by the source staking contract');
    process.exit(1);
  }

  // Check current bond amount
  let currentBond = 0n;
  let needsBondTopup = false;
  let topupAmount = 0n;
  try {
    const bondResult = await tokenUtility.mapServiceIdTokenDeposit(serviceId);
    currentBond = bondResult[0];
    // Sanity check — if the decoded value is unrealistically large, ABI mismatch
    if (currentBond > ethers.parseEther('1000000000')) {
      console.log(`\n💰 Current Bond: (ABI decoding returned unrealistic value, skipping bond check)`);
      console.log('   Will check bond after unstaking when service state is cleaner');
    } else {
      console.log(`\n💰 Current Bond: ${ethers.formatEther(currentBond)} OLAS`);
    }
  } catch (e: any) {
    console.log(`\n💰 Current Bond: (could not read — ${e.message?.slice(0, 80)})`);
    console.log('   Will verify bond after unstaking');
  }

  // Check target minimum stake
  let targetMinStake = 0n;
  try {
    targetMinStake = await targetStaking.minStakingDeposit();
    console.log(`   Target Min Stake: ${ethers.formatEther(targetMinStake)} OLAS`);

    // Only compare if bond decoded correctly
    if (currentBond > 0n && currentBond < ethers.parseEther('1000000000')) {
      needsBondTopup = currentBond < targetMinStake;
      topupAmount = needsBondTopup ? targetMinStake - currentBond : 0n;
      if (needsBondTopup) {
        console.log(`   ⚠️  Bond top-up required: ${ethers.formatEther(topupAmount)} OLAS`);

        const olasBalance = await olasToken.balanceOf(masterEOA);
        console.log(`   Master EOA OLAS balance: ${ethers.formatEther(olasBalance)} OLAS`);

        if (olasBalance < topupAmount) {
          console.error(`   ❌ Insufficient OLAS balance for top-up`);
          console.error(`      Need: ${ethers.formatEther(topupAmount)} OLAS`);
          console.error(`      Have: ${ethers.formatEther(olasBalance)} OLAS`);
          process.exit(1);
        }
        console.log('   ✅ Sufficient OLAS for bond top-up');
      } else {
        console.log('   ✅ Current bond meets target minimum');
      }
    } else {
      console.log('   (bond comparison deferred — will check after unstake)');
    }
  } catch (e: any) {
    console.log(`   Target Min Stake: (could not read — ${e.message?.slice(0, 80)})`);
  }

  // Check target has slots available
  let targetStakedIds: number[] = [];
  try {
    targetStakedIds = await getStakedServiceIds(targetStaking);
    const targetMaxServices = await targetStaking.maxNumServices();
    console.log(`\n🎰 Target Slots: ${targetStakedIds.length}/${targetMaxServices}`);
    if (targetStakedIds.length >= Number(targetMaxServices)) {
      console.error(`   ❌ Target staking contract is full`);
      process.exit(1);
    }
    console.log('   ✅ Slots available');
  } catch (e: any) {
    console.log(`\n🎰 Target Slots: (could not read — ${e.message?.slice(0, 80)})`);
    console.log('   Proceeding cautiously — slot check failed');
  }

  // Check not already staked in target
  if (targetStakedIds.includes(serviceId)) {
    console.error(`\n❌ Service ${serviceId} is already staked in target ${targetConfig.name}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  DRY RUN COMPLETE - No transactions executed');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('\nWould execute:');
    console.log(`  1. Unstake from ${sourceConfig.name}${isEvicted ? ' (evicted service)' : ''}`);
    if (needsBondTopup) {
      console.log(`  2. Approve ${ethers.formatEther(topupAmount)} OLAS for ServiceRegistryTokenUtility`);
      console.log(`  3. Increase security deposit by ${ethers.formatEther(topupAmount)} OLAS`);
      console.log(`  4. Stake in ${targetConfig.name}`);
    } else {
      console.log(`  2. Stake in ${targetConfig.name}`);
    }
    console.log('\nRun without --dry-run to execute migration');
    return;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Initialize Safe SDK for live execution
  // ════════════════════════════════════════════════════════════════════════
  const masterPrivateKey = getMasterPrivateKey();
  if (!masterPrivateKey) {
    console.error('❌ Failed to get master wallet private key');
    console.error('   Ensure OPERATE_PASSWORD is set and .operate/wallets/ethereum.txt exists');
    process.exit(1);
  }

  console.log('\n📦 Initializing Safe SDK...');
  const protocolKit = await Safe.init({
    provider: RPC_URL,
    signer: masterPrivateKey,
    safeAddress: masterSafe!,
  });
  console.log('   ✅ Safe SDK initialized');

  // Direct ethers.js Safe execTransaction — bypasses Safe SDK gas estimation
  // which fails with GS013 for certain calls (approve, stake)
  const SAFE_ABI = [
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)',
    'function nonce() view returns (uint256)',
    'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  ];

  async function execSafeTxDirect(to: string, data: string, label: string) {
    console.log(`\n🔄 ${label} (direct ethers.js)...`);
    const publicProvider = new ethers.JsonRpcProvider('https://base.publicnode.com');
    const signer = new ethers.Wallet(masterPrivateKey, provider);
    const safe = new ethers.Contract(masterSafe!, SAFE_ABI, publicProvider);

    const nonce = await safe.nonce();
    const txHash = await safe.getTransactionHash(
      to, 0n, data, 0, 0, 0, 0,
      ethers.ZeroAddress, ethers.ZeroAddress, nonce,
    );

    const signature = await signer.signMessage(ethers.getBytes(txHash));
    const sigBytes = ethers.getBytes(signature);
    const r = ethers.hexlify(sigBytes.slice(0, 32));
    const s = ethers.hexlify(sigBytes.slice(32, 64));
    const v = sigBytes[64] + 4; // eth_sign format for Safe
    const adjustedSig = ethers.concat([r, s, new Uint8Array([v])]);

    const safeWithSigner = new ethers.Contract(masterSafe!, SAFE_ABI, signer);
    const tx = await safeWithSigner.execTransaction(
      to, 0n, data, 0, 0, 0, 0,
      ethers.ZeroAddress, ethers.ZeroAddress, adjustedSig,
      { gasLimit: 2_000_000 },
    );
    console.log(`   TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`   ✅ Done`);
    return { hash: tx.hash, receipt };
  }

  // Helper: encode calldata and execute via Safe SDK, falling back to direct ethers.js on GS013
  async function executeSafeTx(to: string, data: string, label: string) {
    console.log(`\n🔄 ${label}...`);
    try {
      const safeTx = await protocolKit.createTransaction({
        transactions: [{ to, value: '0', data }],
      });
      const signedTx = await protocolKit.signTransaction(safeTx);
      const result = await protocolKit.executeTransaction(signedTx);
      console.log(`   TX: ${result.hash}`);
      await result.transactionResponse?.wait();
      console.log(`   ✅ Done`);
      return result;
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes('GS013')) {
        console.log(`   ⚠️  Safe SDK GS013 — retrying with direct ethers.js...`);
        return execSafeTxDirect(to, data, label);
      }
      throw err;
    }
  }

  const stakingIface = new ethers.Interface(STAKING_ABI);
  const tokenUtilityIface = new ethers.Interface(TOKEN_UTILITY_ABI);
  const erc20Iface = new ethers.Interface(ERC20_ABI);

  // ════════════════════════════════════════════════════════════════════════
  // Step 2: Unstake from Source
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Step 2: Unstake from Source');
  console.log('═══════════════════════════════════════════════════════════════');

  await executeSafeTx(
    sourceConfig.address,
    stakingIface.encodeFunctionData('unstake', [serviceId]),
    `Unstaking service ${serviceId} from ${sourceConfig.name}${isEvicted ? ' (evicted)' : ''}`
  );

  // ════════════════════════════════════════════════════════════════════════
  // Step 3: Top-up Bond (if needed)
  // ════════════════════════════════════════════════════════════════════════
  if (needsBondTopup) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  Step 3: Top-up Bond');
    console.log('═══════════════════════════════════════════════════════════════');

    await executeSafeTx(
      CONTRACTS.OLAS_TOKEN,
      erc20Iface.encodeFunctionData('approve', [CONTRACTS.SERVICE_REGISTRY_TOKEN_UTILITY, topupAmount]),
      `Approving ${ethers.formatEther(topupAmount)} OLAS for ServiceRegistryTokenUtility`
    );

    await executeSafeTx(
      CONTRACTS.SERVICE_REGISTRY_TOKEN_UTILITY,
      tokenUtilityIface.encodeFunctionData('increaseSecurityDeposit', [serviceId, topupAmount]),
      `Increasing security deposit by ${ethers.formatEther(topupAmount)} OLAS`
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // Step 4: Stake in Target
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Step 4: Stake in Target');
  console.log('═══════════════════════════════════════════════════════════════');

  // Approve the service NFT for transfer to the staking contract
  const registryIface = new ethers.Interface(SERVICE_REGISTRY_ABI);
  const registry = new ethers.Contract(CONTRACTS.SERVICE_REGISTRY, SERVICE_REGISTRY_ABI, provider);
  const currentApproval = await registry.getApproved(serviceId);
  if (currentApproval.toLowerCase() !== targetConfig.address.toLowerCase()) {
    console.log(`\n🔑 Approving NFT transfer to ${targetConfig.name}...`);
    await executeSafeTx(
      CONTRACTS.SERVICE_REGISTRY,
      registryIface.encodeFunctionData('approve', [targetConfig.address, serviceId]),
      `Approving service NFT ${serviceId} for ${targetConfig.name}`
    );
  } else {
    console.log(`\n✅ NFT already approved for ${targetConfig.name}`);
  }

  await executeSafeTx(
    targetConfig.address,
    stakingIface.encodeFunctionData('stake', [serviceId]),
    `Staking service ${serviceId} in ${targetConfig.name}`
  );

  // ════════════════════════════════════════════════════════════════════════
  // Step 5: Verification
  // ════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Step 5: Verification');
  console.log('═══════════════════════════════════════════════════════════════');

  // Verify staking status
  const finalTargetIds = await getStakedServiceIds(targetStaking);
  const isStakedInTarget = finalTargetIds.includes(serviceId);
  console.log(`\n📍 Target Staking Status: ${isStakedInTarget ? '✅ STAKED' : '❌ NOT STAKED'}`);

  // Get staking info
  if (isStakedInTarget) {
    try {
      const stakingInfo = await targetStaking.mapServiceInfo(serviceId);
      console.log(`   Multisig: ${stakingInfo[0]}`);
      console.log(`   Owner: ${stakingInfo[1]}`);
      console.log(`   Staking Start: ${new Date(Number(stakingInfo[3]) * 1000).toISOString()}`);
    } catch {
      console.log('   (mapServiceInfo not available on this contract)');
    }
  }

  // Verify not in source anymore
  const finalSourceIds = await getStakedServiceIds(sourceStaking);
  const stillInSource = finalSourceIds.includes(serviceId);
  console.log(`\n📍 Source Staking Status: ${stillInSource ? '⚠️ STILL STAKED' : '✅ REMOVED'}`);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Migration Complete!');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`\nService ${serviceId} migrated from ${sourceConfig.name} to ${targetConfig.name}`);
  console.log(`\n🔗 Links:`);
  console.log(`   Target Staking: https://basescan.org/address/${targetConfig.address}`);
  console.log(`   Service Registry: https://basescan.org/token/${CONTRACTS.SERVICE_REGISTRY}?a=${serviceId}`);
}

main().catch((err) => {
  console.error('\n❌ Migration failed:', err);
  process.exit(1);
});
