#!/usr/bin/env tsx
/**
 * Claim Rewards for Service #165 via Master Safe
 * 
 * Generates transaction data for the Master Safe to claim rewards.
 * The Master Safe owner can use this data to:
 * 1. Create a transaction on https://app.safe.global
 * 2. Or execute via this script if they have signer access
 */

import { ethers } from 'ethers';

// Configuration
const RPC_URL = process.env.BASE_LEDGER_RPC || process.env.BASE_RPC_URL || 'https://base.llamarpc.com';

// Service #165
const SERVICE_ID = 165;
const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';

// Staking contract
const STAKING_CONTRACT = '0x2585e63df7BD9De8e058884D496658a030b5c6ce'; // AgentsFun1

// ABIs
const STAKING_ABI = [
  'function claim(uint256 serviceId) external returns (uint256)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
];

async function main() {
  console.log('💰 Generate Claim Transaction for Service #165\n');
  console.log(`Service ID: ${SERVICE_ID}`);
  console.log(`Master Safe: ${MASTER_SAFE}`);
  console.log(`Staking Contract: ${STAKING_CONTRACT}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const stakingContract = new ethers.Contract(STAKING_CONTRACT, STAKING_ABI, provider);

  // Get current service info
  console.log('📊 Fetching service info...\n');
  const serviceInfo = await stakingContract.getServiceInfo(SERVICE_ID);
  
  console.log(`Service Owner: ${serviceInfo.owner}`);
  console.log(`Service Multisig: ${serviceInfo.multisig}`);
  console.log(`Reward Available: ${ethers.formatEther(serviceInfo.reward)} OLAS\n`);

  if (serviceInfo.reward === 0n) {
    console.error('❌ No rewards to claim!');
    console.error('   Call checkpoint() first to allocate rewards\n');
    process.exit(1);
  }

  // Verify ownership
  if (serviceInfo.owner.toLowerCase() !== MASTER_SAFE.toLowerCase()) {
    console.error(`❌ Service owner mismatch!`);
    console.error(`   Expected: ${MASTER_SAFE}`);
    console.error(`   Got: ${serviceInfo.owner}`);
    process.exit(1);
  }

  // Encode the claim() call
  const claimData = stakingContract.interface.encodeFunctionData('claim', [SERVICE_ID]);

  console.log('📦 Transaction Data for Master Safe:\n');
  console.log('='.repeat(70));
  console.log('TO (Staking Contract):');
  console.log(STAKING_CONTRACT);
  console.log('\nVALUE:');
  console.log('0 ETH');
  console.log('\nDATA:');
  console.log(claimData);
  console.log('='.repeat(70));
  
  console.log('\n📝 Instructions:\n');
  console.log('Option 1: Use Safe Web UI');
  console.log('  1. Go to https://app.safe.global/home?safe=base:' + MASTER_SAFE);
  console.log('  2. Click "New Transaction" > "Transaction Builder"');
  console.log('  3. Enter:');
  console.log('     To: ' + STAKING_CONTRACT);
  console.log('     Value: 0');
  console.log('     Data: ' + claimData);
  console.log('  4. Review and execute\n');

  console.log('Option 2: Use Safe CLI');
  console.log('  safe-cli tx send --to ' + STAKING_CONTRACT + ' --value 0 --data ' + claimData + '\n');

  console.log('💰 Expected Result:');
  console.log(`  ${ethers.formatEther(serviceInfo.reward)} OLAS will be sent to:`);
  console.log(`  ${serviceInfo.multisig} (Service #165 Safe)\n`);

  // Save transaction data to file
  const txData = {
    to: STAKING_CONTRACT,
    value: '0',
    data: claimData,
    metadata: {
      serviceId: SERVICE_ID,
      masterSafe: MASTER_SAFE,
      serviceSafe: serviceInfo.multisig,
      rewardAmount: ethers.formatEther(serviceInfo.reward),
      description: `Claim ${ethers.formatEther(serviceInfo.reward)} OLAS rewards for Service #165`,
    }
  };

  const fs = await import('fs');
  const path = await import('path');
  const outputPath = path.join(process.cwd(), 'claim-tx-165.json');
  fs.writeFileSync(outputPath, JSON.stringify(txData, null, 2));
  console.log(`✅ Transaction data saved to: ${outputPath}\n`);
}

main().catch(console.error);

