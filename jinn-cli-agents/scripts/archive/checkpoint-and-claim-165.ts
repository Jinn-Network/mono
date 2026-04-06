#!/usr/bin/env tsx
/**
 * Checkpoint and Claim Rewards for Service #165
 * 
 * This script calls checkpointAndClaim() on the staking contract.
 * 
 * Since the service owner is a Safe (0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645),
 * we have two options:
 * 
 * Option 1: Call checkpoint() first (anyone can call this)
 *          Then the Safe can call claim() separately
 * 
 * Option 2: Execute checkpointAndClaim() through the Safe
 * 
 * This script uses Option 1 (simpler - anyone can trigger checkpoint)
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const RPC_URL = process.env.BASE_LEDGER_RPC || process.env.BASE_RPC_URL || 'https://base.llamarpc.com';

// Service #165
const SERVICE_ID = 165;
const SERVICE_OWNER = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645'; // Master Safe (multisig)

// Staking contract
const STAKING_CONTRACT = '0x2585e63df7BD9De8e058884D496658a030b5c6ce'; // AgentsFun1

// ABIs
const STAKING_ABI = [
  'function checkpoint() external returns (uint256[] memory serviceIds, uint256[] memory eligibleServiceIds, uint256[] memory eligibleServiceRewards, uint256[] memory evictServiceIds)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
  'function calculateStakingReward(uint256 serviceId) view returns (uint256)',
  'function tsCheckpoint() view returns (uint256)',
  'function epochCounter() view returns (uint256)',
];

async function main() {
  const dryRun = process.env.DRY_RUN === 'true';

  console.log('🔄 Checkpoint Staking Contract for Service #165\n');
  console.log(`Service ID: ${SERVICE_ID}`);
  console.log(`Service Owner: ${SERVICE_OWNER} (Master Safe)`);
  console.log(`Staking Contract: ${STAKING_CONTRACT}`);
  console.log(`Dry Run: ${dryRun ? 'YES (no transaction sent)' : 'NO (will execute)'}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // We can use ANY EOA to call checkpoint() - it's a public function
  // Let's use one of the agent EOAs we have available
  console.log('🔑 Loading EOA for checkpoint call...\n');
  
  // Use Service #165 agent EOA (we have this key)
  const AGENT_EOA = '0x62fb5FC6ab3206b3C817b503260B90075233f7dD';
  const keyPath = path.join(process.cwd(), 'olas-operate-middleware', '.operate', 'keys', AGENT_EOA);
  
  if (!fs.existsSync(keyPath)) {
    console.error(`❌ Agent key not found: ${keyPath}`);
    process.exit(1);
  }

  const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
  const privateKey = keyData.private_key;
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log(`Caller EOA: ${wallet.address}`);
  console.log(`ℹ️  checkpoint() can be called by anyone - it's a public function\n`);
  
  // Check caller balance
  const callerBalance = await provider.getBalance(wallet.address);
  console.log(`Caller Balance: ${ethers.formatEther(callerBalance)} ETH\n`);

  if (callerBalance < ethers.parseEther('0.0001')) {
    console.error(`❌ Caller has insufficient balance for gas`);
    console.error(`   Available: ${ethers.formatEther(callerBalance)} ETH`);
    console.error(`   Recommended: At least 0.0001 ETH`);
    process.exit(1);
  }

  // Connect to staking contract
  const stakingContract = new ethers.Contract(STAKING_CONTRACT, STAKING_ABI, wallet);

  // Get current service info
  console.log('📊 Fetching current service info...\n');
  const serviceInfo = await stakingContract.getServiceInfo(SERVICE_ID);
  console.log(`Service Multisig: ${serviceInfo.multisig}`);
  console.log(`Service Owner: ${serviceInfo.owner}`);
  console.log(`Current Reward: ${ethers.formatEther(serviceInfo.reward)} OLAS\n`);

  // Get last checkpoint time
  const tsCheckpoint = await stakingContract.tsCheckpoint();
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const timeSinceCheckpoint = nowInSeconds - Number(tsCheckpoint);
  console.log(`Last Checkpoint: ${new Date(Number(tsCheckpoint) * 1000).toISOString()}`);
  console.log(`Time Since Checkpoint: ${(timeSinceCheckpoint / 3600).toFixed(2)} hours\n`);

  // Calculate expected reward after checkpoint
  let expectedReward: bigint = 0n;
  try {
    expectedReward = await stakingContract.calculateStakingReward(SERVICE_ID);
    console.log(`📈 Expected Reward (after checkpoint): ${ethers.formatEther(expectedReward)} OLAS\n`);
  } catch (error) {
    console.log(`⚠️  Could not calculate expected reward\n`);
  }

  // Get current epoch
  let epochCounter: bigint = 0n;
  try {
    epochCounter = await stakingContract.epochCounter();
    console.log(`Current Epoch: ${epochCounter}\n`);
  } catch (error) {
    console.log(`⚠️  Could not get epoch counter\n`);
  }

  if (dryRun) {
    console.log('🧪 DRY RUN - Would execute:\n');
    console.log('1. checkpoint() - allocates rewards to eligible services');
    console.log(`   Called by: ${wallet.address} (but can be called by anyone)`);
    console.log(`   Will update rewards for Service #${SERVICE_ID}\n`);
    console.log('2. After checkpoint succeeds:');
    console.log(`   Service owner (${SERVICE_OWNER}) can claim rewards by calling:`);
    console.log(`   - claim(${SERVICE_ID}) through the Master Safe\n`);
    console.log(`\n✅ Dry run complete. No transaction sent.\n`);
    console.log('To execute for real, run without DRY_RUN=true');
    return;
  }

  try {
    // Call checkpoint()
    console.log('🔄 Calling checkpoint()...\n');
    console.log('ℹ️  This will allocate rewards to all eligible services in this epoch\n');
    
    const checkpointTx = await stakingContract.checkpoint();
    console.log(`Transaction sent: ${checkpointTx.hash}`);
    console.log(`View on BaseScan: https://basescan.org/tx/${checkpointTx.hash}\n`);
    console.log('⏳ Waiting for confirmation...\n');

    const checkpointReceipt = await checkpointTx.wait();

    if (checkpointReceipt?.status === 1) {
      console.log('✅ CHECKPOINT SUCCESSFUL!\n');
      console.log(`Gas used: ${checkpointReceipt.gasUsed.toString()}`);
      console.log(`Block: ${checkpointReceipt.blockNumber}\n`);

      // Wait a bit for state to update
      await new Promise(r => setTimeout(r, 2000));

      // Query updated service info
      const updatedServiceInfo = await stakingContract.getServiceInfo(SERVICE_ID);
      const allocatedReward = updatedServiceInfo.reward;
      
      console.log('💰 Updated Service Info:');
      console.log(`   Reward Available: ${ethers.formatEther(allocatedReward)} OLAS`);
      console.log(`   Inactivity: ${updatedServiceInfo.inactivity}\n`);

      if (allocatedReward > 0n) {
        console.log('🎉 Rewards have been allocated to Service #165!\n');
        console.log('📝 Next Steps:');
        console.log('   1. The Master Safe owner needs to call claim() to collect rewards');
        console.log(`   2. Rewards will be sent to Service Safe: ${updatedServiceInfo.multisig}`);
        console.log(`   3. Use the Master Safe UI or create a Safe transaction script\n`);
        console.log('='.repeat(70));
        console.log('📋 SUMMARY');
        console.log('='.repeat(70));
        console.log(`Transaction: ${checkpointReceipt.hash}`);
        console.log(`Service ID: ${SERVICE_ID}`);
        console.log(`Rewards Allocated: ${ethers.formatEther(allocatedReward)} OLAS`);
        console.log(`Ready to Claim: YES`);
        console.log(`Claimable by: ${SERVICE_OWNER} (Master Safe)`);
        console.log(`Will be sent to: ${updatedServiceInfo.multisig} (Service Safe)`);
        console.log('='.repeat(70) + '\n');
      } else {
        console.log('⚠️  No rewards were allocated to Service #165');
        console.log('   This could mean:');
        console.log('   - Service did not meet activity requirements');
        console.log('   - Rewards were already claimed');
        console.log('   - Not enough time has passed since last checkpoint\n');
      }

    } else {
      console.error('❌ Checkpoint transaction failed');
      process.exit(1);
    }

  } catch (error: any) {
    console.error('❌ Error executing transaction:', error.message);
    
    if (error.code === 'CALL_EXCEPTION') {
      console.error('\n💡 Common issues:');
      console.error('   - Not enough time passed since last checkpoint');
      console.error('   - No services eligible for rewards in this epoch');
      console.error('   - Contract paused or in invalid state');
      console.error('\n   Error data:', error.data);
    }
    
    process.exit(1);
  }
}

main().catch(console.error);
