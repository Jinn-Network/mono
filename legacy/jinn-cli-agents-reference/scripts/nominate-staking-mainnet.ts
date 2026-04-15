#!/usr/bin/env ts-node

/**
 * Nominate JIN Staking Contract on Ethereum Mainnet
 * 
 * This script nominates a staking contract deployed on Base for veOLAS voting.
 * After nomination, veOLAS holders can vote to direct emissions to this contract.
 * 
 * Uses the master EOA from .operate/wallets/ethereum.txt for Ethereum mainnet.
 * 
 * Prerequisites:
 * - JIN staking contract deployed on Base (run deploy-jin-staking.ts first)
 * - OPERATE_PASSWORD set in .env
 * - Master EOA must have ETH for gas on Ethereum mainnet
 * 
 * Environment Variables:
 *   OPERATE_PASSWORD - Password to decrypt the master wallet keystore
 *   ETHEREUM_RPC_URL - Ethereum mainnet RPC URL
 *   JIN_STAKING_ADDRESS - Address of deployed JIN staking contract on Base (optional, reads from deployment.json)
 * 
 * Usage:
 *   yarn tsx scripts/nominate-staking-mainnet.ts
 *   yarn tsx scripts/nominate-staking-mainnet.ts --dry-run
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Import operate profile helpers
import { getMasterEOA } from 'jinn-node/env/operate-profile.js';

// ============================================================================
// CONTRACT ADDRESSES - Ethereum Mainnet
// ============================================================================

const MAINNET_ADDRESSES = {
  // VoteWeighting contract for nominating staking contracts
  // This contract allows veOLAS holders to add nominees and vote on staking weights
  // Address from: autonolas-frontend-mono/libs/util-contracts/src/lib/abiAndAddresses/voteWeighting.ts
  VoteWeighting: '0x95418b46d5566D3d1ea62C12Aea91227E566c5c1',
  
  // veOLAS token for checking voting power
  veOLAS: '0x7e01A500805f8A52Fad229b3015AD130A332B7b3',
  
  // OLAS token
  OLAS: '0x0001A500A6B18995B03f44bb040A5fFc28E45CB0',
} as const;

// Base chain ID for nomination
const BASE_CHAIN_ID = 8453;

// ============================================================================
// ABIs
// ============================================================================

const VOTE_WEIGHTING_ABI = [
  // Add nominee to the list of votable staking contracts (EVM chains)
  'function addNomineeEVM(address account, uint256 chainId)',
  
  // Get nominee ID by account and chain
  'function getNomineeId(bytes32 account, uint256 chainId) view returns (uint256)',
  
  // Get all nominees
  'function getAllNominees() view returns (tuple(bytes32 account, uint256 chainId)[])',
  
  // Get total number of nominees
  'function getNumNominees() view returns (uint256)',
  
  // Events
  'event AddNominee(bytes32 indexed account, uint256 chainId, uint256 id)',
];

const VE_OLAS_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function locked(address account) view returns (int128 amount, uint256 end)',
];

// ============================================================================
// NOMINATION FUNCTIONS
// ============================================================================

interface NominationConfig {
  rpcUrl: string;
  nominatorPrivateKey: string;
  stakingContractAddress: string;
  masterEOA: string;
  dryRun: boolean;
}

async function loadMasterWalletPrivateKey(): Promise<string> {
  // Check for direct private key first
  if (process.env.NOMINATOR_PRIVATE_KEY) {
    console.log('Using NOMINATOR_PRIVATE_KEY from environment');
    return process.env.NOMINATOR_PRIVATE_KEY;
  }

  const password = process.env.OPERATE_PASSWORD;
  if (!password) {
    throw new Error('Either NOMINATOR_PRIVATE_KEY or OPERATE_PASSWORD must be set');
  }

  // Find the keystore file
  const keystorePath = path.resolve(
    process.cwd(),
    'olas-operate-middleware/.operate/wallets/ethereum.txt'
  );

  if (!fs.existsSync(keystorePath)) {
    throw new Error(`Master wallet keystore not found at ${keystorePath}`);
  }

  // Use Python to decrypt (ethers v6 has scrypt parameter constraints)
  console.log('Decrypting master wallet keystore via Python...');
  const { execSync } = await import('child_process');
  
  try {
    const privateKey = execSync(
      `python3 -c "
from eth_account import Account
import json
with open('${keystorePath}') as f:
    keystore = json.load(f)
private_key = Account.decrypt(keystore, '${password}')
h = private_key.hex()
print(h if h.startswith('0x') else '0x' + h)
"`,
      { encoding: 'utf8', cwd: process.cwd() }
    ).trim();
    
    const wallet = new ethers.Wallet(privateKey);
    console.log(`✅ Master wallet decrypted: ${wallet.address}`);
    
    return privateKey;
  } catch (error) {
    throw new Error(`Failed to decrypt keystore: ${error}`);
  }
}

async function getNominationConfig(): Promise<NominationConfig> {
  // Load master EOA from operate profile
  const masterEOA = getMasterEOA();
  if (!masterEOA) {
    throw new Error('Master EOA not found in .operate/wallets/ethereum.json');
  }

  console.log(`Master EOA: ${masterEOA}`);

  // Try to load from deployment file first
  let stakingContractAddress = process.env.JIN_STAKING_ADDRESS;
  
  if (!stakingContractAddress) {
    const deploymentPath = path.resolve(process.cwd(), 'contracts/staking/deployment.json');
    if (fs.existsSync(deploymentPath)) {
      const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
      stakingContractAddress = deployment.contracts?.stakingContract;
    }
  }
  
  if (!stakingContractAddress || !ethers.isAddress(stakingContractAddress)) {
    throw new Error(
      'JIN_STAKING_ADDRESS must be set or deployment.json must exist.\n' +
      'Run deploy-jin-staking.ts first to deploy the staking contract.'
    );
  }

  const dryRun = process.argv.includes('--dry-run');

  // Load the private key (only if not dry run)
  let nominatorPrivateKey = '';
  if (!dryRun) {
    nominatorPrivateKey = await loadMasterWalletPrivateKey();
  }

  return {
    rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com',
    nominatorPrivateKey,
    stakingContractAddress,
    masterEOA,
    dryRun,
  };
}

async function checkVotingPower(
  provider: ethers.Provider,
  address: string
): Promise<{ balance: bigint; locked: { amount: bigint; end: bigint } }> {
  const veOlas = new ethers.Contract(MAINNET_ADDRESSES.veOLAS, VE_OLAS_ABI, provider);
  
  const balance = await veOlas.balanceOf(address);
  const locked = await veOlas.locked(address);
  
  return {
    balance,
    locked: {
      amount: BigInt(locked.amount),
      end: BigInt(locked.end),
    },
  };
}

async function nominateStakingContract(
  wallet: ethers.Wallet,
  config: NominationConfig
): Promise<void> {
  console.log('\n📋 Nominating JIN Staking Contract');
  console.log('═'.repeat(60));
  
  const voteWeighting = new ethers.Contract(
    MAINNET_ADDRESSES.VoteWeighting,
    VOTE_WEIGHTING_ABI,
    wallet
  );
  
  console.log(`Staking Contract (Base): ${config.stakingContractAddress}`);
  console.log(`Chain ID: ${BASE_CHAIN_ID}`);
  
  // Check if already nominated using getNomineeId
  // Convert address to bytes32 (left-padded with zeros)
  const accountBytes32 = ethers.zeroPadValue(config.stakingContractAddress.toLowerCase(), 32);
  
  try {
    const nomineeId = await voteWeighting.getNomineeId(accountBytes32, BASE_CHAIN_ID);
    
    if (nomineeId > 0n) {
      console.log('\n✅ Contract is already nominated!');
      console.log(`   Nominee ID: ${nomineeId}`);
      return;
    }
  } catch (e) {
    // Continue with nomination if check fails
    console.log('Could not verify nomination status, proceeding...');
  }
  
  if (config.dryRun) {
    console.log('\n⚠️  DRY RUN - Skipping nomination transaction');
    return;
  }
  
  console.log('\nSubmitting nomination transaction...');
  
  // Use addNomineeEVM for EVM-compatible chains
  const tx = await voteWeighting.addNomineeEVM(
    config.stakingContractAddress,
    BASE_CHAIN_ID
  );
  
  console.log(`Transaction hash: ${tx.hash}`);
  console.log(`Etherscan: https://etherscan.io/tx/${tx.hash}`);
  
  const receipt = await tx.wait();
  console.log(`✅ Nomination confirmed in block ${receipt.blockNumber}`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('🚀 JIN Staking Contract Nomination (Ethereum Mainnet)');
  console.log('═'.repeat(60));
  
  try {
    const config = await getNominationConfig();
    
    console.log('\n📋 Configuration:');
    console.log(`   Network: Ethereum Mainnet`);
    console.log(`   RPC URL: ${config.rpcUrl}`);
    console.log(`   Dry Run: ${config.dryRun}`);
    console.log(`   Master EOA (Nominator): ${config.masterEOA}`);
    console.log(`   Staking Contract: ${config.stakingContractAddress}`);
    console.log(`   Target Chain: Base (${BASE_CHAIN_ID})`);
    
    // Setup provider and wallet
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);
    
    let wallet: ethers.Wallet | null = null;
    if (!config.dryRun) {
      wallet = new ethers.Wallet(config.nominatorPrivateKey, provider);
      console.log(`\n   Nominator Address: ${wallet.address}`);
      
      const balance = await provider.getBalance(wallet.address);
      console.log(`   Nominator ETH Balance: ${ethers.formatEther(balance)} ETH`);
      
      if (balance === 0n) {
        throw new Error('Nominator has no ETH for gas. Please fund the nominator address.');
      }
      
      // Check veOLAS voting power
      console.log('\n📊 Checking veOLAS Voting Power...');
      try {
        const votingPower = await checkVotingPower(provider, wallet.address);
        console.log(`   veOLAS Balance: ${ethers.formatEther(votingPower.balance)}`);
        console.log(`   Locked OLAS: ${ethers.formatEther(votingPower.locked.amount)}`);
        
        if (votingPower.locked.end > 0n) {
          const lockEndDate = new Date(Number(votingPower.locked.end) * 1000);
          console.log(`   Lock End Date: ${lockEndDate.toISOString()}`);
        }
      } catch (e) {
        console.log(`   ⚠️  Could not check veOLAS balance (${e instanceof Error ? e.message : 'error'})`);
        console.log(`   Note: veOLAS is not required for nomination, only for voting`);
      }
    } else {
      console.log(`\n   Nominator Address: ${config.masterEOA} (dry run - not connected)`);
    }
    
    // Nominate the staking contract
    await nominateStakingContract(wallet!, config);
    
    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('✅ NOMINATION PROCESS COMPLETE');
    console.log('═'.repeat(60));
    
    console.log('\n📋 Next Steps:');
    console.log('   1. Wait for the nomination to be confirmed');
    console.log('   2. veOLAS holders can now vote for this staking contract');
    console.log('   3. Use the OLAS Govern app to allocate votes:');
    console.log('      https://govern.olas.network/');
    console.log('   4. Emissions will flow based on vote weight');
    
  } catch (error) {
    console.error('\n❌ Nomination failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
