#!/usr/bin/env ts-node

/**
 * Generate Safe Transaction Builder JSON for EXISTING veOLAS lock holders.
 * 
 * Creates batch transaction to:
 * 1. Approve OLAS to veOLAS contract
 * 2. Increase lock amount (increaseAmount)
 * 3. Optionally extend lock duration (increaseUnlockTime)
 * 4. Vote for Jinn staking contract on Base
 * 
 * Usage: yarn tsx scripts/generate-safe-batch-increase.ts <OLAS_AMOUNT> [NEW_UNLOCK_MONTHS]
 * Example: yarn tsx scripts/generate-safe-batch-increase.ts 40000        # Add OLAS, keep current expiry
 * Example: yarn tsx scripts/generate-safe-batch-increase.ts 40000 15     # Add OLAS AND extend to 15mo
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

function generateBatchJson(olasAmount: string, newUnlockMonths?: number): object {
  const amountWei = ethers.parseEther(olasAmount).toString();
  
  // Convert Jinn address to bytes32
  const jinnBytes32 = ethers.zeroPadValue(JINN_CONTRACT.toLowerCase(), 32);
  
  const transactions: any[] = [];
  
  // Transaction 1: Approve OLAS
  transactions.push({
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
  });
  
  // Transaction 2: Increase amount
  transactions.push({
    to: VE_OLAS,
    value: '0',
    data: null,
    contractMethod: {
      inputs: [
        { name: 'amount', type: 'uint256', internalType: 'uint256' },
      ],
      name: 'increaseAmount',
      payable: false,
    },
    contractInputsValues: {
      amount: amountWei,
    },
  });
  
  // Transaction 3 (optional): Extend unlock time
  let unlockTime: number | undefined;
  if (newUnlockMonths) {
    const WEEK = 7 * 24 * 60 * 60;
    const lockSeconds = newUnlockMonths * 30 * 24 * 60 * 60;
    unlockTime = Math.floor((Date.now() / 1000 + lockSeconds) / WEEK) * WEEK;
    
    transactions.push({
      to: VE_OLAS,
      value: '0',
      data: null,
      contractMethod: {
        inputs: [
          { name: 'unlockTime', type: 'uint256', internalType: 'uint256' },
        ],
        name: 'increaseUnlockTime',
        payable: false,
      },
      contractInputsValues: {
        unlockTime: unlockTime.toString(),
      },
    });
  }
  
  // Transaction 4: Vote for Jinn
  transactions.push({
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
  });
  
  console.log('=== Safe Batch Transaction Parameters ===\n');
  console.log(`OLAS Amount to Add: ${olasAmount} OLAS`);
  if (unlockTime) {
    console.log(`New Unlock Time: ${new Date(unlockTime * 1000).toISOString()}`);
  } else {
    console.log(`Unlock Time: Unchanged (using existing lock expiry)`);
  }
  console.log(`Jinn Contract (bytes32): ${jinnBytes32}`);
  console.log(`Transactions: ${transactions.length}`);
  console.log('');
  
  const description = newUnlockMonths
    ? `Batch: 1) Approve, 2) Add ${olasAmount} OLAS to lock, 3) Extend to ${newUnlockMonths}m, 4) Vote 100% for Jinn`
    : `Batch: 1) Approve, 2) Add ${olasAmount} OLAS to lock, 3) Vote 100% for Jinn`;
  
  return {
    version: '1.0',
    chainId: '1',
    createdAt: Date.now(),
    meta: {
      name: `Add ${olasAmount} OLAS to veOLAS + Vote for Jinn`,
      description,
      txBuilderVersion: '1.16.5',
    },
    transactions,
  };
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('Usage: yarn tsx scripts/generate-safe-batch-increase.ts <OLAS_AMOUNT> [NEW_UNLOCK_MONTHS]');
    console.log('');
    console.log('Examples:');
    console.log('  yarn tsx scripts/generate-safe-batch-increase.ts 40000');
    console.log('    → Add 40k OLAS to existing lock, keep current unlock time');
    console.log('');
    console.log('  yarn tsx scripts/generate-safe-batch-increase.ts 40000 15');
    console.log('    → Add 40k OLAS AND extend lock to 15 months from now');
    console.log('');
    console.log('For accounts WITH existing veOLAS locks. Use generate-safe-batch.ts for new locks.');
    process.exit(1);
  }
  
  const olasAmount = args[0];
  const newUnlockMonths = args[1] ? parseInt(args[1], 10) : undefined;
  
  if (newUnlockMonths && (isNaN(newUnlockMonths) || newUnlockMonths < 1 || newUnlockMonths > 48)) {
    console.error('Unlock months must be between 1 and 48');
    process.exit(1);
  }
  
  const batchJson = generateBatchJson(olasAmount, newUnlockMonths);
  
  const suffix = newUnlockMonths ? `-extend-${newUnlockMonths}m` : '';
  const outputPath = `scripts/safe-batch-increase-${olasAmount}-olas${suffix}.json`;
  fs.writeFileSync(outputPath, JSON.stringify(batchJson, null, 2));
  
  console.log(`Generated: ${outputPath}`);
  console.log('');
  console.log('To use:');
  console.log('1. Go to your Safe app → Transaction Builder');
  console.log('2. Click "Load" and select the generated JSON file');
  console.log('3. Review and execute the batch transaction');
}

main();
