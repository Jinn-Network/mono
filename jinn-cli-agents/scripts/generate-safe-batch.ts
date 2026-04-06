#!/usr/bin/env ts-node

/**
 * Generate Safe Transaction Builder JSON for NEW veOLAS locks.
 * 
 * Creates batch transaction to:
 * 1. Approve OLAS to veOLAS contract
 * 2. Create veOLAS lock (fails if lock already exists - use generate-safe-batch-increase.ts instead)
 * 3. Vote for Jinn staking contract on Base
 * 
 * Usage: yarn tsx scripts/generate-safe-batch.ts <OLAS_AMOUNT> <LOCK_MONTHS>
 * Example: yarn tsx scripts/generate-safe-batch.ts 100000 3
 * 
 * Generated JSON can be loaded into Safe Transaction Builder app.
 * ALWAYS simulate with simulate-safe-batch.ts before executing.
 */

import { ethers } from 'ethers';
import * as fs from 'fs';

// Contract addresses (Ethereum mainnet)
const OLAS_TOKEN = '0x0001A500A6B18995B03f44bb040A5fFc28E45CB0';
const VE_OLAS = '0x7e01A500805f8A52Fad229b3015AD130A332B7b3';
const VOTE_WEIGHTING = '0x95418b46d5566D3d1ea62C12Aea91227E566c5c1';

// Jinn staking contract on Base
const JINN_CONTRACT = '0x0dfaFbf570e9E813507aAE18aA08dFbA0aBc5139';
const BASE_CHAIN_ID = 8453;

function generateBatchJson(olasAmount: string, lockMonths: number): object {
  const amountWei = ethers.parseEther(olasAmount).toString();
  
  // Calculate unlock time (rounded to week for veOLAS)
  const WEEK = 7 * 24 * 60 * 60;
  const lockSeconds = lockMonths * 30 * 24 * 60 * 60;
  const unlockTime = Math.floor((Date.now() / 1000 + lockSeconds) / WEEK) * WEEK;
  
  // Calculate expected veOLAS (approximate)
  const MAXTIME = 4 * 365 * 24 * 60 * 60; // 4 years in seconds
  const timeToUnlock = unlockTime - Math.floor(Date.now() / 1000);
  const expectedVeOLAS = (parseFloat(olasAmount) * timeToUnlock) / MAXTIME;
  
  // Convert Jinn address to bytes32
  const jinnBytes32 = ethers.zeroPadValue(JINN_CONTRACT.toLowerCase(), 32);
  
  console.log('=== Safe Batch Transaction Parameters ===\n');
  console.log(`OLAS Amount: ${olasAmount} OLAS`);
  console.log(`Lock Duration: ${lockMonths} months`);
  console.log(`Unlock Time: ${new Date(unlockTime * 1000).toISOString()}`);
  console.log(`Expected veOLAS: ~${expectedVeOLAS.toFixed(2)} veOLAS`);
  console.log(`Jinn Contract (bytes32): ${jinnBytes32}`);
  console.log('');
  
  return {
    version: '1.0',
    chainId: '1',
    createdAt: Date.now(),
    meta: {
      name: `Lock ${olasAmount} OLAS + Vote for Jinn Staking`,
      description: `Batch transaction to: 1) Approve OLAS spending, 2) Create ${lockMonths}-month veOLAS lock, 3) Vote 100% for Jinn staking contract on Base`,
      txBuilderVersion: '1.16.5',
    },
    transactions: [
      {
        to: OLAS_TOKEN,
        value: '0',
        data: null,
        contractMethod: {
          inputs: [
            { name: 'spender', type: 'address', internalType: 'address' },
            { name: 'amount', type: 'uint256', internalType: 'uint256' },
          ],
          name: 'approve',
          payable: false,
        },
        contractInputsValues: {
          spender: VE_OLAS,
          amount: amountWei,
        },
      },
      {
        to: VE_OLAS,
        value: '0',
        data: null,
        contractMethod: {
          inputs: [
            { name: 'amount', type: 'uint256', internalType: 'uint256' },
            { name: 'unlockTime', type: 'uint256', internalType: 'uint256' },
          ],
          name: 'createLock',
          payable: false,
        },
        contractInputsValues: {
          amount: amountWei,
          unlockTime: unlockTime.toString(),
        },
      },
      {
        to: VOTE_WEIGHTING,
        value: '0',
        data: null,
        contractMethod: {
          inputs: [
            { name: 'account', type: 'bytes32', internalType: 'bytes32' },
            { name: 'chainId', type: 'uint256', internalType: 'uint256' },
            { name: 'weight', type: 'uint256', internalType: 'uint256' },
          ],
          name: 'voteForNomineeWeights',
          payable: false,
        },
        contractInputsValues: {
          account: jinnBytes32,
          chainId: BASE_CHAIN_ID.toString(),
          weight: '10000', // 100%
        },
      },
    ],
  };
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('Usage: yarn tsx scripts/generate-safe-batch.ts <OLAS_AMOUNT> <LOCK_MONTHS>');
    console.log('Example: yarn tsx scripts/generate-safe-batch.ts 100000 3');
    console.log('');
    console.log('This will generate a Safe Transaction Builder JSON to:');
    console.log('1. Approve OLAS to veOLAS contract');
    console.log('2. Create veOLAS lock');
    console.log('3. Vote 100% for Jinn staking contract on Base');
    process.exit(1);
  }
  
  const olasAmount = args[0];
  const lockMonths = parseInt(args[1], 10);
  
  if (isNaN(lockMonths) || lockMonths < 1 || lockMonths > 48) {
    console.error('Lock months must be between 1 and 48');
    process.exit(1);
  }
  
  const batchJson = generateBatchJson(olasAmount, lockMonths);
  
  const outputPath = `scripts/safe-batch-${olasAmount}-olas-${lockMonths}m.json`;
  fs.writeFileSync(outputPath, JSON.stringify(batchJson, null, 2));
  
  console.log(`Generated: ${outputPath}`);
  console.log('');
  console.log('To use:');
  console.log('1. Go to your Safe app → Transaction Builder');
  console.log('2. Click "Load" and select the generated JSON file');
  console.log('3. Review and execute the batch transaction');
}

main();
