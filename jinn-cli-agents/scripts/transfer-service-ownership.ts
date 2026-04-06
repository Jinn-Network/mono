#!/usr/bin/env tsx
/**
 * Transfer OLAS service NFT ownership between Safes
 *
 * Transfers a staked service from one master Safe to another:
 * 1. Unstake (via current owner Safe)
 * 2. Transfer NFT (via current owner Safe)
 * 3. Approve NFT for staking contract (via new owner Safe)
 * 4. Stake (via new owner Safe)
 * 5. Copy service config to new owner's .operate directory
 *
 * Usage:
 *   source .env && OPERATE_PASSWORD=<password> npx tsx scripts/transfer-service-ownership.ts \
 *     --service-id=359 \
 *     --from-profile=/Users/gcd/Repositories/main/jinn-node/.operate \
 *     --to-profile=olas-operate-middleware/.operate
 *
 * Environment:
 *   OPERATE_PASSWORD - Required to decrypt both master wallets
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Lazy-import keystore decryption (lives in jinn-node)
import { decryptKeystoreV3 } from 'jinn-node/env/keystore-decrypt';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_STAKING_CONTRACT = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139'; // Jinn
const SERVICE_REGISTRY = '0x3C1fF68f5aa342D296d4DEe4Bb1cACCA912D95fE';
const PUBLIC_RPC = 'https://base.publicnode.com';

// ABIs
const STAKING_ABI = [
  'function stake(uint256 serviceId) external',
  'function unstake(uint256 serviceId) external returns (uint256)',
  'function getStakingState(uint256 serviceId) view returns (uint8)',
  'function getServiceIds() view returns (uint256[])',
  'function mapServiceInfo(uint256) view returns (address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward)',
];

const SERVICE_REGISTRY_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function approve(address to, uint256 tokenId) external',
  'function transferFrom(address from, address to, uint256 tokenId) external',
];

const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
];

const STAKING_STATE_LABELS: Record<number, string> = {
  0: 'Unstaked',
  1: 'Staked',
  2: 'Evicted',
};

// ============================================================================
// Arg Parsing
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  let serviceId: number | null = null;
  let fromProfile: string | null = null;
  let toProfile: string | null = null;
  let stakingContract = DEFAULT_STAKING_CONTRACT;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith('--service-id=')) {
      serviceId = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--from-profile=')) {
      fromProfile = arg.split('=')[1];
    } else if (arg.startsWith('--to-profile=')) {
      toProfile = arg.split('=')[1];
    } else if (arg.startsWith('--staking-contract=')) {
      stakingContract = arg.split('=')[1];
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  if (!serviceId || !fromProfile || !toProfile) {
    console.error('Usage: npx tsx scripts/transfer-service-ownership.ts \\');
    console.error('  --service-id=<ID> \\');
    console.error('  --from-profile=<path-to-.operate> \\');
    console.error('  --to-profile=<path-to-.operate> \\');
    console.error('  [--staking-contract=<ADDRESS>] \\');
    console.error('  [--dry-run]');
    process.exit(1);
  }

  // Resolve relative paths from monorepo root
  const repoRoot = path.resolve(__dirname, '..');
  if (!path.isAbsolute(fromProfile)) {
    fromProfile = path.resolve(repoRoot, fromProfile);
  }
  if (!path.isAbsolute(toProfile)) {
    toProfile = path.resolve(repoRoot, toProfile);
  }

  return { serviceId, fromProfile, toProfile, stakingContract, dryRun };
}

// ============================================================================
// Profile Helpers
// ============================================================================

function loadMasterKey(operateDir: string): { privateKey: string; safe: string; eoa: string } {
  const password = process.env.OPERATE_PASSWORD;
  if (!password) {
    throw new Error('OPERATE_PASSWORD env var required');
  }

  // Load wallet config
  const walletJsonPath = path.join(operateDir, 'wallets', 'ethereum.json');
  if (!fs.existsSync(walletJsonPath)) {
    throw new Error(`Wallet config not found: ${walletJsonPath}`);
  }
  const walletConfig = JSON.parse(fs.readFileSync(walletJsonPath, 'utf-8'));
  const safe = walletConfig.safes?.base;
  const eoa = walletConfig.address;
  if (!safe) {
    throw new Error(`No Base safe found in ${walletJsonPath}`);
  }

  // Decrypt keystore
  const keystorePath = path.join(operateDir, 'wallets', 'ethereum.txt');
  if (!fs.existsSync(keystorePath)) {
    throw new Error(`Keystore not found: ${keystorePath}`);
  }
  const keystoreJson = fs.readFileSync(keystorePath, 'utf-8');
  const privateKey = decryptKeystoreV3(keystoreJson, password);

  return { privateKey, safe, eoa };
}

function findServiceConfigDir(operateDir: string, serviceId: number): string | null {
  const servicesDir = path.join(operateDir, 'services');
  if (!fs.existsSync(servicesDir)) return null;

  const dirs = fs.readdirSync(servicesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dir of dirs) {
    const configPath = path.join(servicesDir, dir, 'config.json');
    if (!fs.existsSync(configPath)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      // Check if this config is for our service ID
      for (const cc of Object.values(config.chain_configs || {})) {
        if ((cc as any).chain_data?.token === serviceId) {
          return dir;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ============================================================================
// Safe Transaction Execution
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

  const nonce = await safe.nonce();

  const txHash = await safe.getTransactionHash(
    to, 0n, data, 0, 0, 0, 0,
    ethers.ZeroAddress, ethers.ZeroAddress, nonce,
  );

  // eth_sign format: v + 4 for Safe
  const signature = await signer.signMessage(ethers.getBytes(txHash));
  const sigBytes = ethers.getBytes(signature);
  const r = ethers.hexlify(sigBytes.slice(0, 32));
  const s = ethers.hexlify(sigBytes.slice(32, 64));
  const v = sigBytes[64] + 4;
  const adjustedSig = ethers.concat([r, s, new Uint8Array([v])]);

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

async function main() {
  const { serviceId, fromProfile, toProfile, stakingContract, dryRun } = parseArgs();

  console.log('================================================================');
  console.log('  Transfer OLAS Service Ownership');
  console.log('================================================================');
  console.log(`  Service ID:        ${serviceId}`);
  console.log(`  From profile:      ${fromProfile}`);
  console.log(`  To profile:        ${toProfile}`);
  console.log(`  Staking contract:  ${stakingContract}`);
  console.log(`  Dry run:           ${dryRun}`);
  console.log();

  // Load both master keys
  console.log('  Loading source profile...');
  const source = loadMasterKey(fromProfile);
  console.log(`    EOA:  ${source.eoa}`);
  console.log(`    Safe: ${source.safe}`);

  console.log('  Loading target profile...');
  const target = loadMasterKey(toProfile);
  console.log(`    EOA:  ${target.eoa}`);
  console.log(`    Safe: ${target.safe}`);

  if (source.safe.toLowerCase() === target.safe.toLowerCase()) {
    console.log('\n  Source and target Safes are the same. Nothing to transfer.');
    return;
  }

  const provider = new ethers.JsonRpcProvider(PUBLIC_RPC);
  const staking = new ethers.Contract(stakingContract, STAKING_ABI, provider);
  const registry = new ethers.Contract(SERVICE_REGISTRY, SERVICE_REGISTRY_ABI, provider);

  // Check current state
  console.log('\n  Checking on-chain state...');
  const stakingState = Number(await staking.getStakingState(serviceId));
  console.log(`    Staking state: ${stakingState} (${STAKING_STATE_LABELS[stakingState] ?? 'Unknown'})`);

  const currentOwner = await registry.ownerOf(serviceId);
  console.log(`    NFT owner:     ${currentOwner}`);

  // Check ETH balances for gas
  const sourceBalance = await provider.getBalance(source.eoa);
  const targetBalance = await provider.getBalance(target.eoa);
  console.log(`    Source EOA balance: ${ethers.formatEther(sourceBalance)} ETH`);
  console.log(`    Target EOA balance: ${ethers.formatEther(targetBalance)} ETH`);

  const minBalance = ethers.parseEther('0.001');
  if (sourceBalance < minBalance) {
    throw new Error(`Source EOA ${source.eoa} has insufficient ETH for gas`);
  }
  if (targetBalance < minBalance) {
    throw new Error(`Target EOA ${target.eoa} has insufficient ETH for gas`);
  }

  if (dryRun) {
    console.log('\n  DRY RUN — would execute:');
    console.log(`    1. Unstake ${serviceId} via ${source.safe}`);
    console.log(`    2. Transfer NFT from ${source.safe} to ${target.safe}`);
    console.log(`    3. Approve NFT for ${stakingContract} via ${target.safe}`);
    console.log(`    4. Stake ${serviceId} via ${target.safe}`);
    console.log(`    5. Copy service config from source to target .operate`);
    return;
  }

  const stakingIface = new ethers.Interface(STAKING_ABI);
  const registryIface = new ethers.Interface(SERVICE_REGISTRY_ABI);

  // Step 1: Unstake (if staked)
  if (stakingState === 1) {
    await execSafeTx(source.safe, source.privateKey, provider, stakingContract,
      stakingIface.encodeFunctionData('unstake', [serviceId]),
      `[${serviceId}] Unstaking via source Safe ${source.safe}`);
  } else if (stakingState === 2) {
    // Evicted — still need to unstake to reclaim NFT
    await execSafeTx(source.safe, source.privateKey, provider, stakingContract,
      stakingIface.encodeFunctionData('unstake', [serviceId]),
      `[${serviceId}] Unstaking evicted service via source Safe ${source.safe}`);
  } else if (stakingState === 0) {
    // Already unstaked — check NFT owner
    if (currentOwner.toLowerCase() !== source.safe.toLowerCase()) {
      throw new Error(`Service ${serviceId} is unstaked but NFT owner ${currentOwner} != source Safe ${source.safe}`);
    }
    console.log(`\n  [${serviceId}] Already unstaked, NFT at source Safe.`);
  }

  // Verify NFT is now at source Safe
  const ownerAfterUnstake = await registry.ownerOf(serviceId);
  if (ownerAfterUnstake.toLowerCase() !== source.safe.toLowerCase()) {
    throw new Error(`After unstake, NFT owner is ${ownerAfterUnstake}, expected ${source.safe}`);
  }
  console.log(`\n  NFT owner after unstake: ${ownerAfterUnstake} ✓`);

  // Step 2: Transfer NFT to target Safe
  await execSafeTx(source.safe, source.privateKey, provider, SERVICE_REGISTRY,
    registryIface.encodeFunctionData('transferFrom', [source.safe, target.safe, serviceId]),
    `[${serviceId}] Transferring NFT to target Safe ${target.safe}`);

  // Verify transfer
  const ownerAfterTransfer = await registry.ownerOf(serviceId);
  if (ownerAfterTransfer.toLowerCase() !== target.safe.toLowerCase()) {
    throw new Error(`After transfer, NFT owner is ${ownerAfterTransfer}, expected ${target.safe}`);
  }
  console.log(`\n  NFT owner after transfer: ${ownerAfterTransfer} ✓`);

  // Step 3: Approve NFT for staking
  await execSafeTx(target.safe, target.privateKey, provider, SERVICE_REGISTRY,
    registryIface.encodeFunctionData('approve', [stakingContract, serviceId]),
    `[${serviceId}] Approving NFT for staking contract`);

  // Step 4: Stake
  await execSafeTx(target.safe, target.privateKey, provider, stakingContract,
    stakingIface.encodeFunctionData('stake', [serviceId]),
    `[${serviceId}] Staking via target Safe ${target.safe}`);

  // Verify staking
  const finalState = Number(await staking.getStakingState(serviceId));
  if (finalState !== 1) {
    throw new Error(`Expected staking state 1 (Staked) but got ${finalState}`);
  }
  console.log(`\n  Staking state: ${finalState} (Staked) ✓`);

  // Step 5: Copy service config
  console.log('\n  Copying service config...');
  const sourceConfigDir = findServiceConfigDir(fromProfile, serviceId);
  if (sourceConfigDir) {
    const srcPath = path.join(fromProfile, 'services', sourceConfigDir);
    const destPath = path.join(toProfile, 'services', sourceConfigDir);

    if (fs.existsSync(destPath)) {
      console.log(`    Target already has ${sourceConfigDir}, skipping copy.`);
    } else {
      // Copy the entire service config directory
      fs.cpSync(srcPath, destPath, { recursive: true });
      console.log(`    Copied ${sourceConfigDir} to target .operate`);
    }

    // Also copy the agent key if it exists
    const sourceKeysJson = path.join(srcPath, 'keys.json');
    if (fs.existsSync(sourceKeysJson)) {
      const keys = JSON.parse(fs.readFileSync(sourceKeysJson, 'utf-8'));
      for (const key of keys) {
        const agentAddr = key.address;
        if (agentAddr) {
          const srcKeyPath = path.join(fromProfile, 'keys', agentAddr);
          const destKeyPath = path.join(toProfile, 'keys', agentAddr);
          if (fs.existsSync(srcKeyPath) && !fs.existsSync(destKeyPath)) {
            // Ensure keys directory exists
            fs.mkdirSync(path.join(toProfile, 'keys'), { recursive: true });
            fs.copyFileSync(srcKeyPath, destKeyPath);
            console.log(`    Copied agent key ${agentAddr} to target .operate`);
          } else if (fs.existsSync(destKeyPath)) {
            console.log(`    Agent key ${agentAddr} already exists in target.`);
          } else {
            console.log(`    WARN: Agent key ${agentAddr} not found in source.`);
          }
        }
      }
    }
  } else {
    console.log(`    WARN: Could not find service config for ${serviceId} in source profile.`);
    console.log(`    You may need to manually copy the config.`);
  }

  // Summary
  console.log('\n================================================================');
  console.log('  Transfer Complete');
  console.log('================================================================');
  console.log(`  Service ${serviceId}: ownership transferred from`);
  console.log(`    ${source.safe} → ${target.safe}`);
  console.log(`  Staking state: Staked ✓`);
  console.log(`  Service config: copied ✓`);
  console.log();
  console.log('  NEXT STEPS:');
  console.log('  1. Redeploy the worker so it picks up the new service config');
  console.log('  2. Verify the worker can deliver for this service');
}

main().catch((err) => {
  console.error('\nTransfer failed:', err.message || err);
  process.exit(1);
});
