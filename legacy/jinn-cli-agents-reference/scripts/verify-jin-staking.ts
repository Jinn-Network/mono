#!/usr/bin/env ts-node

/**
 * Verify JIN Staking Contract on Base
 * 
 * Checks:
 * - Contract deployment and code
 * - Activity checker configuration
 * - Staking parameters match expected values
 * - Contract ownership
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

async function main() {
  console.log('=== Verify JIN Staking Contract ===\n');

  // Load deployment info
  const deploymentPath = path.resolve(process.cwd(), 'contracts/staking/deployment.json');
  if (!fs.existsSync(deploymentPath)) {
    throw new Error('deployment.json not found. Run deploy-jin-staking.ts first.');
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf-8'));
  
  const { stakingContract, activityChecker } = deployment.contracts;
  const { whitelistAddress1, whitelistAddress2, livenessRatio, stakingParams } = deployment.config;

  console.log('Deployment Info:');
  console.log('  Staking Contract:', stakingContract);
  console.log('  Activity Checker:', activityChecker);
  console.log('  Network:', deployment.network);
  console.log('  Chain ID:', deployment.chainId);
  console.log('');

  const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);

  // Check staking contract exists
  console.log('Checking staking contract...');
  const stakingCode = await provider.getCode(stakingContract);
  if (stakingCode === '0x') {
    throw new Error('Staking contract not found at address');
  }
  console.log('✅ Staking contract code present');

  // Check activity checker exists
  console.log('Checking activity checker...');
  const activityCheckerCode = await provider.getCode(activityChecker);
  if (activityCheckerCode === '0x') {
    throw new Error('Activity checker not found at address');
  }
  console.log('✅ Activity checker code present');

  // Read staking contract parameters
  const stakingContractInterface = new ethers.Contract(
    stakingContract,
    [
      'function minStakingDeposit() view returns (uint256)',
      'function rewardsPerSecond() view returns (uint256)',
      'function maxNumServices() view returns (uint256)',
      'function livenessPeriod() view returns (uint256)',
      'function timeForEmissions() view returns (uint256)',
      'function livenessRatio() view returns (uint256)',
      'function activityChecker() view returns (address)',
    ],
    provider
  );

  console.log('\nReading staking contract parameters...');
  const [
    minStakingDeposit,
    rewardsPerSecond,
    maxNumServices,
    livenessPeriod,
    timeForEmissions,
    onChainLivenessRatio,
    onChainActivityChecker,
  ] = await Promise.all([
    stakingContractInterface.minStakingDeposit(),
    stakingContractInterface.rewardsPerSecond(),
    stakingContractInterface.maxNumServices(),
    stakingContractInterface.livenessPeriod(),
    stakingContractInterface.timeForEmissions(),
    stakingContractInterface.livenessRatio(),
    stakingContractInterface.activityChecker(),
  ]);

  console.log('');
  console.log('=== Staking Parameters ===');
  console.log('minStakingDeposit:', ethers.formatEther(minStakingDeposit), 'OLAS');
  console.log('rewardsPerSecond:', ethers.formatEther(rewardsPerSecond), 'OLAS');
  console.log('maxNumServices:', maxNumServices.toString());
  console.log('livenessPeriod:', livenessPeriod.toString(), 'seconds');
  console.log('timeForEmissions:', timeForEmissions.toString(), 'seconds');
  console.log('livenessRatio:', onChainLivenessRatio.toString());
  console.log('activityChecker:', onChainActivityChecker);

  // Verify parameters match expected
  console.log('\n=== Parameter Verification ===');
  
  const checks = [
    {
      name: 'minStakingDeposit',
      expected: ethers.parseEther(stakingParams.minStakingDeposit).toString(),
      actual: minStakingDeposit.toString(),
    },
    {
      name: 'rewardsPerSecond',
      expected: stakingParams.rewardsPerSecond,
      actual: rewardsPerSecond.toString(),
    },
    {
      name: 'maxNumServices',
      expected: stakingParams.maxNumServices.toString(),
      actual: maxNumServices.toString(),
    },
    {
      name: 'livenessPeriod',
      expected: stakingParams.livenessPeriod.toString(),
      actual: livenessPeriod.toString(),
    },
    {
      name: 'timeForEmissions',
      expected: stakingParams.timeForEmissions.toString(),
      actual: timeForEmissions.toString(),
    },
    {
      name: 'livenessRatio',
      expected: livenessRatio,
      actual: onChainLivenessRatio.toString(),
    },
    {
      name: 'activityChecker',
      expected: activityChecker.toLowerCase(),
      actual: onChainActivityChecker.toLowerCase(),
    },
  ];

  let allMatch = true;
  for (const check of checks) {
    const match = check.expected === check.actual;
    const status = match ? '✅' : '❌';
    console.log(`${status} ${check.name}: ${match ? 'MATCH' : 'MISMATCH'}`);
    if (!match) {
      console.log(`   Expected: ${check.expected}`);
      console.log(`   Actual: ${check.actual}`);
      allMatch = false;
    }
  }

  // Check activity checker whitelist
  console.log('\n=== Activity Checker Configuration ===');
  const activityCheckerInterface = new ethers.Contract(
    activityChecker,
    [
      'function isWhitelisted(address) view returns (bool)',
      'function owner() view returns (address)',
    ],
    provider
  );

  const [isWhitelisted1, isWhitelisted2, owner] = await Promise.all([
    activityCheckerInterface.isWhitelisted(whitelistAddress1),
    activityCheckerInterface.isWhitelisted(whitelistAddress2),
    activityCheckerInterface.owner(),
  ]);

  console.log('Owner:', owner);
  console.log('Whitelist Address 1:', whitelistAddress1, isWhitelisted1 ? '✅' : '❌');
  console.log('Whitelist Address 2:', whitelistAddress2, isWhitelisted2 ? '✅' : '❌');

  if (!isWhitelisted1 || !isWhitelisted2) {
    console.log('\n⚠️  WARNING: Not all addresses are whitelisted!');
    allMatch = false;
  }

  console.log('');
  if (allMatch) {
    console.log('✅ All verifications passed!');
  } else {
    console.log('❌ Some verifications failed. Check output above.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
