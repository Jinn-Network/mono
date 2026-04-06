#!/usr/bin/env tsx
/**
 * Query Activity Requirements for Service #164
 * 
 * Queries on-chain contracts to determine:
 * 1. Liveness ratio from activity checker
 * 2. Liveness period from staking contract
 * 3. Last checkpoint timestamp
 * 4. Current request count for Service Safe
 * 5. Calculate required requests to satisfy activity checker
 */

import { ethers } from 'ethers';

// Configuration
const RPC_URL = process.env.BASE_LEDGER_RPC || process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// Service #164 addresses
const SERVICE_SAFE = '0xdB225C794218b1f5054dffF3462c84A30349B182';
const SERVICE_ID = 164;

// Contract addresses
const STAKING_CONTRACT = '0x2585e63df7BD9De8e058884D496658a030b5c6ce'; // AgentsFun1
const ACTIVITY_CHECKER = '0x87C9922A099467E5A80367553e7003349FE50106'; // RequesterActivityChecker
const MECH_MARKETPLACE = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';

// ABIs
const STAKING_ABI = [
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
  'function livenessPeriod() view returns (uint256)',
  'function tsCheckpoint() view returns (uint256)',
  'function rewardsPerSecond() view returns (uint256)',
  'function calculateStakingReward(uint256 serviceId) view returns (uint256)',
  'function minStakingDeposit() view returns (uint256)',
];

const ACTIVITY_CHECKER_ABI = [
  'function livenessRatio() view returns (uint256)',
  'function getMultisigNonces(address multisig) view returns (uint256[] memory)',
];

const MECH_MARKETPLACE_ABI = [
  'function mapRequestCounts(address requester) view returns (uint256)',
];

async function main() {
  console.log('🔍 Querying Activity Requirements for Service #164\n');
  console.log(`Service Safe: ${SERVICE_SAFE}`);
  console.log(`Service ID: ${SERVICE_ID}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // Initialize contracts
  const stakingContract = new ethers.Contract(STAKING_CONTRACT, STAKING_ABI, provider);
  const activityChecker = new ethers.Contract(ACTIVITY_CHECKER, ACTIVITY_CHECKER_ABI, provider);
  const mechMarketplace = new ethers.Contract(MECH_MARKETPLACE, MECH_MARKETPLACE_ABI, provider);

  console.log('📊 Fetching on-chain data...\n');

  try {
    // 1. Get service info from staking contract
    const serviceInfo = await stakingContract.getServiceInfo(SERVICE_ID);
    console.log('✅ Service Info:');
    console.log(`   Multisig: ${serviceInfo.multisig}`);
    console.log(`   Owner: ${serviceInfo.owner}`);
    console.log(`   Nonces: [${serviceInfo.nonces.join(', ')}]`);
    console.log(`   Staking Start: ${serviceInfo.tsStart} (${new Date(Number(serviceInfo.tsStart) * 1000).toISOString()})`);
    console.log(`   Reward: ${ethers.formatEther(serviceInfo.reward)} OLAS`);
    console.log(`   Inactivity: ${serviceInfo.inactivity}\n`);

    // 2. Get liveness period from staking contract
    const livenessPeriod = await stakingContract.livenessPeriod();
    console.log('✅ Liveness Period:');
    console.log(`   ${livenessPeriod} seconds (${Number(livenessPeriod) / 3600} hours)\n`);

    // 3. Get last checkpoint timestamp
    const tsCheckpoint = await stakingContract.tsCheckpoint();
    console.log('✅ Last Checkpoint:');
    console.log(`   ${tsCheckpoint} (${new Date(Number(tsCheckpoint) * 1000).toISOString()})`);
    console.log(`   ${Math.floor((Date.now() / 1000) - Number(tsCheckpoint))} seconds ago\n`);

    // 4. Get liveness ratio from activity checker
    const livenessRatio = await activityChecker.livenessRatio();
    console.log('✅ Liveness Ratio:');
    console.log(`   ${livenessRatio} (${Number(livenessRatio) / 1e18} in 1e18 format)\n`);

    // 5. Get current multisig nonces from activity checker
    const currentNonces = await activityChecker.getMultisigNonces(SERVICE_SAFE);
    console.log('✅ Current Multisig Nonces (from Activity Checker):');
    console.log(`   Safe Nonce: ${currentNonces[0]}`);
    console.log(`   Request Count: ${currentNonces[1]}\n`);

    // 6. Get request count from marketplace directly (may not be available on all marketplace versions)
    let marketplaceRequestCount: bigint = 0n;
    try {
      marketplaceRequestCount = await mechMarketplace.mapRequestCounts(SERVICE_SAFE);
      console.log('✅ Marketplace Request Count (Direct):');
      console.log(`   ${marketplaceRequestCount}\n`);
    } catch (error) {
      console.log('⚠️  Marketplace Request Count (Direct): Not available on this marketplace version');
      console.log('   Using activity checker request count instead\n');
      marketplaceRequestCount = currentNonces[1];
    }

    // 7. Get rewards info (some methods may not be available)
    let rewardsPerSecond: bigint = 0n;
    let accruedReward: bigint = 0n;
    let minStakingDeposit: bigint = 0n;

    try {
      rewardsPerSecond = await stakingContract.rewardsPerSecond();
      console.log('✅ Rewards per Second:');
      console.log(`   ${ethers.formatEther(rewardsPerSecond)} OLAS/sec\n`);
    } catch (error) {
      console.log('⚠️  Rewards per Second: Not available\n');
    }

    try {
      accruedReward = await stakingContract.calculateStakingReward(SERVICE_ID);
      console.log('✅ Accrued Reward:');
      console.log(`   ${ethers.formatEther(accruedReward)} OLAS\n`);
    } catch (error) {
      console.log('⚠️  Accrued Reward: Not available\n');
    }

    try {
      minStakingDeposit = await stakingContract.minStakingDeposit();
      console.log('✅ Min Staking Deposit:');
      console.log(`   ${ethers.formatEther(minStakingDeposit)} OLAS\n`);
    } catch (error) {
      console.log('⚠️  Min Staking Deposit: Not available\n');
    }

    // ========================================
    // Calculate Required Requests
    // ========================================
    console.log('🧮 Calculating Required Activity...\n');

    const nowInSeconds = Math.floor(Date.now() / 1000);
    const timeSinceCheckpoint = nowInSeconds - Number(tsCheckpoint);
    const effectivePeriod = Math.max(Number(livenessPeriod), timeSinceCheckpoint);

    console.log(`Time since checkpoint: ${timeSinceCheckpoint} seconds (${(timeSinceCheckpoint / 3600).toFixed(2)} hours)`);
    console.log(`Effective period: ${effectivePeriod} seconds (${(effectivePeriod / 3600).toFixed(2)} hours)\n`);

    // Formula from AgentsFunService.ts:
    // requiredRequests = (effectivePeriod * livenessRatio) / 1e18 + REQUESTS_SAFETY_MARGIN
    const REQUESTS_SAFETY_MARGIN = 1;
    const requiredRequests = Math.ceil(
      (effectivePeriod * Number(livenessRatio)) / 1e18
    ) + REQUESTS_SAFETY_MARGIN;

    console.log(`Required requests (formula): ${requiredRequests}`);
    console.log(`   = ceil((${effectivePeriod} * ${livenessRatio}) / 1e18) + ${REQUESTS_SAFETY_MARGIN}\n`);

    // Baseline: nonces at staking time
    const baselineNonce = serviceInfo.nonces[0];
    const baselineRequestCount = serviceInfo.nonces[1];

    console.log(`Baseline (at staking time):`);
    console.log(`   Safe Nonce: ${baselineNonce}`);
    console.log(`   Request Count: ${baselineRequestCount}\n`);

    // Eligible requests: current - baseline
    const eligibleRequests = Number(currentNonces[1]) - Number(baselineRequestCount);

    console.log(`Eligible requests: ${eligibleRequests}`);
    console.log(`   = ${currentNonces[1]} (current) - ${baselineRequestCount} (baseline)\n`);

    // Check eligibility
    const isEligibleForRewards = eligibleRequests >= requiredRequests;

    console.log('🎯 Eligibility Status:\n');
    if (isEligibleForRewards) {
      console.log(`✅ ELIGIBLE for rewards!`);
      console.log(`   Required: ${requiredRequests} requests`);
      console.log(`   Eligible: ${eligibleRequests} requests`);
      console.log(`   Surplus: ${eligibleRequests - requiredRequests} requests\n`);
    } else {
      console.log(`❌ NOT ELIGIBLE for rewards yet`);
      console.log(`   Required: ${requiredRequests} requests`);
      console.log(`   Current: ${eligibleRequests} requests`);
      console.log(`   Needed: ${requiredRequests - eligibleRequests} more requests\n`);
    }

    // ========================================
    // Projections
    // ========================================
    console.log('📈 Projections:\n');

    const secondsPerDay = 86400;
    const requestsPerDay = (secondsPerDay * Number(livenessRatio)) / 1e18;
    console.log(`Requests needed per day (average): ${requestsPerDay.toFixed(2)}`);

    const secondsPerWeek = secondsPerDay * 7;
    const requestsPerWeek = (secondsPerWeek * Number(livenessRatio)) / 1e18;
    console.log(`Requests needed per week (average): ${requestsPerWeek.toFixed(2)}`);

    const secondsUntilCheckpoint = Number(livenessPeriod) - timeSinceCheckpoint;
    if (secondsUntilCheckpoint > 0) {
      console.log(`\nTime until next checkpoint: ${(secondsUntilCheckpoint / 3600).toFixed(2)} hours`);
      const requestsNeededByCheckpoint = Math.max(0, requiredRequests - eligibleRequests);
      console.log(`Requests needed by checkpoint: ${requestsNeededByCheckpoint}`);
      
      if (requestsNeededByCheckpoint > 0) {
        const hoursPerRequest = secondsUntilCheckpoint / (3600 * requestsNeededByCheckpoint);
        console.log(`Rate needed: 1 request every ${hoursPerRequest.toFixed(2)} hours`);
      }
    } else {
      console.log(`\n⚠️  Checkpoint time has passed! Next checkpoint may happen soon.`);
    }

    // ========================================
    // Summary
    // ========================================
    console.log('\n' + '='.repeat(70));
    console.log('📋 SUMMARY');
    console.log('='.repeat(70));
    console.log(`Service #164 Safe: ${SERVICE_SAFE}`);
    console.log(`Staking Contract: ${STAKING_CONTRACT}`);
    console.log(`Activity Checker: ${ACTIVITY_CHECKER}`);
    console.log(`\nActivity Status:`);
    console.log(`  Current Requests: ${eligibleRequests}`);
    console.log(`  Required Requests: ${requiredRequests}`);
    console.log(`  Status: ${isEligibleForRewards ? '✅ ELIGIBLE' : '❌ NOT ELIGIBLE'}`);
    console.log(`\nLiveness Parameters:`);
    console.log(`  Liveness Period: ${Number(livenessPeriod) / 3600} hours`);
    console.log(`  Liveness Ratio: ${Number(livenessRatio) / 1e18}`);
    console.log(`  Time Since Checkpoint: ${(timeSinceCheckpoint / 3600).toFixed(2)} hours`);
    console.log('='.repeat(70) + '\n');

  } catch (error: any) {
    console.error('❌ Error querying contracts:', error.message);
    if (error.data) {
      console.error('Error data:', error.data);
    }
    process.exit(1);
  }
}

main().catch(console.error);

