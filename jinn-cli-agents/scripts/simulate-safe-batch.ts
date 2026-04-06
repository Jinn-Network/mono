#!/usr/bin/env ts-node

/**
 * Simulate Safe Transaction Builder batch before execution.
 * 
 * Pre-flight checks:
 * - OLAS balance sufficient
 * - Existing veOLAS lock status (createLock fails if lock exists)
 * - VoteWeighting cooldown status (10-day wait between votes)
 * 
 * Then simulates each transaction via eth_call or Tenderly API.
 * 
 * Usage: yarn tsx scripts/simulate-safe-batch.ts <SAFE_ADDRESS> <JSON_FILE>
 * Example: yarn tsx scripts/simulate-safe-batch.ts 0xFb75... scripts/safe-batch-increase-40000-olas.json
 * 
 * Set TENDERLY_API_KEY for detailed Tenderly simulations (optional, falls back to eth_call).
 */

import { ethers } from 'ethers';
import * as fs from 'fs';

const TENDERLY_API_KEY = process.env.TENDERLY_API_KEY;
const TENDERLY_ACCOUNT = process.env.TENDERLY_ACCOUNT || 'valory';
const TENDERLY_PROJECT = process.env.TENDERLY_PROJECT || 'autonolas';

interface BatchTransaction {
  to: string;
  value: string;
  contractMethod: {
    name: string;
    inputs: { name: string; type: string }[];
  };
  contractInputsValues: Record<string, string>;
}

interface BatchJson {
  chainId: string;
  transactions: BatchTransaction[];
}

async function encodeTransaction(tx: BatchTransaction): Promise<string> {
  const iface = new ethers.Interface([
    {
      type: 'function',
      name: tx.contractMethod.name,
      inputs: tx.contractMethod.inputs,
      outputs: [],
    },
  ]);

  const args = tx.contractMethod.inputs.map((input) => tx.contractInputsValues[input.name]);
  return iface.encodeFunctionData(tx.contractMethod.name, args);
}

async function simulateOnTenderly(
  safeAddress: string,
  to: string,
  data: string,
  description: string
): Promise<{ success: boolean; error?: string; gasUsed?: number }> {
  if (!TENDERLY_API_KEY) {
    // Fallback to eth_call simulation
    const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');
    try {
      await provider.call({
        from: safeAddress,
        to,
        data,
      });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  const response = await fetch(
    `https://api.tenderly.co/api/v1/account/${TENDERLY_ACCOUNT}/project/${TENDERLY_PROJECT}/simulate`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Key': TENDERLY_API_KEY,
      },
      body: JSON.stringify({
        network_id: '1',
        from: safeAddress,
        to,
        input: data,
        value: '0',
        save: false,
        save_if_fails: false,
        simulation_type: 'quick',
      }),
    }
  );

  const result = await response.json();
  
  if (result.simulation?.status) {
    return {
      success: result.simulation.status,
      gasUsed: result.simulation.gas_used,
    };
  }
  
  return {
    success: false,
    error: result.error?.message || JSON.stringify(result),
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: yarn tsx scripts/simulate-safe-batch.ts <SAFE_ADDRESS> <JSON_FILE>');
    console.log('Example: yarn tsx scripts/simulate-safe-batch.ts 0x1234... scripts/safe-batch-40000-olas-15m.json');
    process.exit(1);
  }

  const safeAddress = args[0];
  const jsonFile = args[1];

  if (!ethers.isAddress(safeAddress)) {
    console.error('Invalid Safe address');
    process.exit(1);
  }

  const batchJson: BatchJson = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
  const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');

  console.log('=== Safe Batch Transaction Simulation ===\n');
  console.log(`Safe Address: ${safeAddress}`);
  console.log(`Chain ID: ${batchJson.chainId}`);
  console.log(`Transactions: ${batchJson.transactions.length}`);
  console.log('');

  // Pre-flight checks
  console.log('=== Pre-flight Checks ===\n');

  // Check OLAS balance
  const olasContract = new ethers.Contract(
    '0x0001A500A6B18995B03f44bb040A5fFc28E45CB0',
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );
  const olasBalance = await olasContract.balanceOf(safeAddress);
  const requiredAmount = BigInt(batchJson.transactions[0].contractInputsValues.amount);
  
  console.log(`OLAS Balance: ${ethers.formatEther(olasBalance)} OLAS`);
  console.log(`Required:     ${ethers.formatEther(requiredAmount)} OLAS`);
  console.log(`Sufficient:   ${olasBalance >= requiredAmount ? '✅ YES' : '❌ NO'}`);
  console.log('');

  // Check if Safe already has a veOLAS lock
  const veOlasContract = new ethers.Contract(
    '0x7e01A500805f8A52Fad229b3015AD130A332B7b3',
    ['function lockedEnd(address) view returns (uint256)'],
    provider
  );
  const lockedEnd = await veOlasContract.lockedEnd(safeAddress);
  const hasExistingLock = Number(lockedEnd) > 0;
  
  console.log(`Existing veOLAS Lock: ${hasExistingLock ? `Yes (expires ${new Date(Number(lockedEnd) * 1000).toISOString()})` : 'None'}`);
  if (hasExistingLock) {
    console.log('⚠️  WARNING: Safe already has a veOLAS lock. createLock will FAIL.');
    console.log('   Use increaseAmount or increaseUnlockTime instead.');
  }
  console.log('');

  // Check VoteWeighting cooldown
  const voteWeightingContract = new ethers.Contract(
    '0x95418b46d5566D3d1ea62C12Aea91227E566c5c1',
    ['function lastUserVote(address, bytes32) view returns (uint256)'],
    provider
  );
  const nomineeHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256'],
      [batchJson.transactions[2].contractInputsValues.account, 8453]
    )
  );
  const lastVote = await voteWeightingContract.lastUserVote(safeAddress, nomineeHash);
  const cooldownEnd = Number(lastVote) + 10 * 24 * 60 * 60;
  const now = Math.floor(Date.now() / 1000);
  
  if (Number(lastVote) > 0) {
    console.log(`Last Vote for Jinn: ${new Date(Number(lastVote) * 1000).toISOString()}`);
    console.log(`Cooldown Ends:      ${new Date(cooldownEnd * 1000).toISOString()}`);
    console.log(`Can Vote Now:       ${now >= cooldownEnd ? '✅ YES' : '❌ NO (wait ' + Math.ceil((cooldownEnd - now) / 86400) + ' days)'}`);
  } else {
    console.log('No previous vote for Jinn from this Safe: ✅ OK');
  }
  console.log('');

  // Simulate each transaction
  console.log('=== Transaction Simulations ===\n');

  const descriptions = [
    'OLAS.approve(veOLAS, 40000 OLAS)',
    'veOLAS.createLock(40000 OLAS, April 2027)',
    'VoteWeighting.voteForNomineeWeights(Jinn, Base, 100%)',
  ];

  let allSuccess = true;

  for (let i = 0; i < batchJson.transactions.length; i++) {
    const tx = batchJson.transactions[i];
    const data = await encodeTransaction(tx);
    
    console.log(`Transaction ${i + 1}: ${descriptions[i]}`);
    console.log(`  To: ${tx.to}`);
    console.log(`  Data: ${data.slice(0, 66)}...`);
    
    const result = await simulateOnTenderly(safeAddress, tx.to, data, descriptions[i]);
    
    if (result.success) {
      console.log(`  Result: ✅ SUCCESS${result.gasUsed ? ` (gas: ${result.gasUsed})` : ''}`);
    } else {
      console.log(`  Result: ❌ FAILED`);
      console.log(`  Error: ${result.error}`);
      allSuccess = false;
    }
    console.log('');
  }

  console.log('=== Summary ===\n');
  if (allSuccess) {
    console.log('✅ All transactions simulated successfully!');
    console.log('   Safe to proceed with batch execution.');
  } else {
    console.log('❌ Some transactions failed simulation.');
    console.log('   Review errors above before proceeding.');
  }
}

main().catch(console.error);
