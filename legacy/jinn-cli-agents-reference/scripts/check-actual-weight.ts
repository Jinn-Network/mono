#!/usr/bin/env ts-node

import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');

const JINN_CONTRACT = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';
const BASE_CHAIN_ID = 8453;

const voteWeighting = new ethers.Contract(
  '0x95418b46d5566D3d1ea62C12Aea91227E566c5c1',
  [
    'function timeSum() view returns (uint256)',
    'function getWeightsSum() view returns (uint256)',
    'function getNomineeWeight(bytes32 account, uint256 chainId) view returns (uint256)',
    'function nomineeRelativeWeight(bytes32 account, uint256 chainId, uint256 time) view returns (uint256 relativeWeight, uint256 totalSum)',
    'function pointsWeight(bytes32, uint256) view returns (uint256 bias, uint256 slope)',
    'function timeWeight(bytes32) view returns (uint256)',
  ],
  provider
);

// Also check tokenomics for projected inflation
const tokenomics = new ethers.Contract(
  '0xc096362fa6f4A4B1a9ea68b1043416f3381ce300', // Tokenomics address
  [
    'function epochCounter() view returns (uint32)',
    'function epochLen() view returns (uint32)',
    'function inflationPerSecond() view returns (uint96)',
    'function mapEpochStakingPoints(uint256) view returns (uint96 stakingIncentive, uint96 maxStakingIncentive, uint16 minStakingWeight, uint8 stakingFraction)',
  ],
  provider
);

async function main() {
  // Convert address to bytes32
  const nomineeBytes32 = ethers.zeroPadValue(JINN_CONTRACT.toLowerCase(), 32);
  const nomineeHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256'],
      [nomineeBytes32, BASE_CHAIN_ID]
    )
  );

  console.log('Jinn Contract:', JINN_CONTRACT);
  console.log('Nominee bytes32:', nomineeBytes32);
  console.log('Nominee hash:', nomineeHash);
  console.log('');

  const [timeSum, weightsSum, nomineeWeight] = await Promise.all([
    voteWeighting.timeSum(),
    voteWeighting.getWeightsSum(),
    voteWeighting.getNomineeWeight(nomineeBytes32, BASE_CHAIN_ID),
  ]);

  console.log('=== VoteWeighting Contract State ===');
  console.log('Current timeSum (next checkpoint):', new Date(Number(timeSum) * 1000).toISOString());
  console.log('Total weights sum:', ethers.formatEther(weightsSum), 'veOLAS');
  console.log('Jinn nominee raw weight:', ethers.formatEther(nomineeWeight), 'veOLAS');
  console.log('');

  // Get the time when weight was last updated
  const timeWeight = await voteWeighting.timeWeight(nomineeHash);
  console.log('Jinn timeWeight:', new Date(Number(timeWeight) * 1000).toISOString());

  // Get points at that time
  const points = await voteWeighting.pointsWeight(nomineeHash, timeWeight);
  console.log('Points at timeWeight - bias:', ethers.formatEther(points.bias), 'veOLAS');
  console.log('Points at timeWeight - slope:', ethers.formatEther(points.slope), 'veOLAS/week');
  console.log('');

  // Get relative weight for next week
  const [relWeight, totalSum] = await voteWeighting.nomineeRelativeWeight(
    nomineeBytes32,
    BASE_CHAIN_ID,
    timeSum
  );
  console.log('=== Relative Weight (for next week) ===');
  console.log('Relative weight (raw):', relWeight.toString());
  console.log('Relative weight (%):', Number(relWeight) / 1e16, '%');
  console.log('Total sum at that time:', ethers.formatEther(totalSum), 'veOLAS');
  console.log('');

  // Check tokenomics
  console.log('=== Tokenomics (for projected inflation) ===');
  try {
    const [epoch, epochLen, inflationPerSecond] = await Promise.all([
      tokenomics.epochCounter(),
      tokenomics.epochLen(),
      tokenomics.inflationPerSecond(),
    ]);
    console.log('Current epoch:', epoch);
    console.log('Epoch length:', epochLen, 'seconds');
    console.log('Inflation per second:', ethers.formatEther(inflationPerSecond), 'OLAS');
    
    const stakingPoint = await tokenomics.mapEpochStakingPoints(epoch);
    console.log('Staking incentive:', ethers.formatEther(stakingPoint.stakingIncentive), 'OLAS');
    console.log('Staking fraction:', stakingPoint.stakingFraction, '%');
    
    // Calculate projected inflation
    const projectedInflation = 
      BigInt(stakingPoint.stakingIncentive) +
      (BigInt(epochLen) * BigInt(inflationPerSecond) * BigInt(stakingPoint.stakingFraction)) / 100n;
    console.log('Projected staking inflation:', ethers.formatEther(projectedInflation), 'OLAS');
    console.log('');
    
    // Calculate what the UI would show
    const totalSumMultiplier = projectedInflation < totalSum ? projectedInflation : totalSum;
    const displayValue = (Number(relWeight) / 1e18) * Number(ethers.formatEther(totalSumMultiplier));
    console.log('=== UI Display Calculation ===');
    console.log('totalSumMultiplier:', ethers.formatEther(totalSumMultiplier));
    console.log('UI "veOLAS" value would be:', displayValue.toFixed(3));
  } catch (e) {
    console.log('Could not fetch tokenomics:', e);
  }
}

main().catch(console.error);
