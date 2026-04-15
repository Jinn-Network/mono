#!/usr/bin/env tsx
/**
 * Check vesting state and build Safe Transaction Builder JSON for claiming
 * vested tokens from the Doppler DERC20 token contract.
 *
 * Usage:
 *   yarn tsx scripts/ventures/claim-vesting.ts --token <address> --safe <address>
 *   yarn tsx scripts/ventures/claim-vesting.ts --token 0x01ba54... --safe 0x900Db2...
 */

import { createPublicClient, http, parseAbi, formatEther, encodeFunctionData, type Address } from 'viem';
import { base } from 'viem/chains';
import { writeFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const abi = parseAbi([
  'function vestingDuration() view returns (uint256)',
  'function vestingStart() view returns (uint256)',
  'function vestedTotalAmount() view returns (uint256)',
  'function getVestingDataOf(address) view returns (uint256 totalAmount, uint256 releasedAmount)',
  'function computeAvailableVestedAmount(address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function release()',
]);

async function main() {
  const args = process.argv.slice(2);
  let tokenAddress: Address | undefined;
  let safeAddress: Address | undefined;
  let outputPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--token': tokenAddress = args[++i] as Address; break;
      case '--safe': safeAddress = args[++i] as Address; break;
      case '--output': outputPath = args[++i]; break;
    }
  }

  if (!tokenAddress || !safeAddress) {
    console.log('Usage: yarn tsx scripts/ventures/claim-vesting.ts --token <address> --safe <address> [--output <path>]');
    process.exit(1);
  }

  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const pc = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
  const read = async (fn: string, args?: any[]) => {
    await delay(500);
    return pc.readContract({ address: tokenAddress!, abi, functionName: fn, args } as any);
  };

  const duration = await read('vestingDuration') as bigint;
  const start = await read('vestingStart') as bigint;
  const totalVested = await read('vestedTotalAmount') as bigint;
  const vestingData = await read('getVestingDataOf', [safeAddress]) as [bigint, bigint];
  const available = await read('computeAvailableVestedAmount', [safeAddress]) as bigint;
  const tokenHeldBalance = await read('balanceOf', [tokenAddress]) as bigint;
  const safeBalance = await read('balanceOf', [safeAddress]) as bigint;

  console.log('=== Vesting State ===');
  console.log(`  Duration: ${Number(duration)}${duration === 0n ? ' (immediate)' : ''}`);
  console.log(`  Start: ${new Date(Number(start) * 1000).toISOString()}`);
  console.log(`  Total vested amount: ${formatEther(totalVested)}`);
  console.log('');
  console.log('=== Safe Vesting Data ===');
  console.log(`  Total allocated: ${formatEther(vestingData[0])}`);
  console.log(`  Already released: ${formatEther(vestingData[1])}`);
  console.log(`  Available to claim: ${formatEther(available)}`);
  console.log('');
  console.log('=== Current Balances ===');
  console.log(`  Token contract holds: ${formatEther(tokenHeldBalance)}`);
  console.log(`  Safe balance: ${formatEther(safeBalance)}`);
  console.log('');

  if (available === 0n) {
    console.log('Nothing to claim — either already released or no vesting allocation.');
    return;
  }

  // Build the Safe Transaction Builder JSON
  const releaseCalldata = encodeFunctionData({ abi, functionName: 'release' });

  const safeTx = {
    version: '1.0',
    chainId: '8453',
    createdAt: Date.now(),
    meta: {
      name: 'Claim Vested Tokens',
      description: `Claim ${formatEther(available)} tokens from Doppler vesting on token ${tokenAddress}`,
      txBuilderVersion: '1.16.5',
    },
    transactions: [
      {
        to: tokenAddress,
        value: '0',
        data: releaseCalldata,
        contractMethod: {
          inputs: [],
          name: 'release',
          payable: false,
        },
        contractInputsValues: {},
      },
    ],
  };

  const outFile = outputPath || './safe-tx-claim-vesting.json';
  writeFileSync(outFile, JSON.stringify(safeTx, null, 2));

  console.log('=== Claim Transaction ===');
  console.log(`  To: ${tokenAddress}`);
  console.log(`  Data: ${releaseCalldata}`);
  console.log(`  Safe TX Builder JSON: ${outFile}`);
  console.log('');
  console.log('Import this JSON in Safe UI → Apps → Transaction Builder → upload file');
}

main();
