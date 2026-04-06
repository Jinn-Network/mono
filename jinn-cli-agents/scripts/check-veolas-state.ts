#!/usr/bin/env ts-node

import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');

const VE_OLAS = '0x7e01A500805f8A52Fad229b3015AD130A332B7b3';
const SAFE_ADDRESS = process.argv[2] || '0xFb752162a2EfFd235130dF67d5094E6ECB5f2891';

const veOlas = new ethers.Contract(
  VE_OLAS,
  [
    'function lockedEnd(address) view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function getLastUserPoint(address) view returns (tuple(int128 bias, int128 slope, uint64 ts, uint64 blockNumber, uint128 balance))',
    'function mapLockedBalances(address) view returns (uint128 amount, uint64 endTime)',
    'function totalSupply() view returns (uint256)',
    'function totalSupplyLocked() view returns (uint256)',
  ],
  provider
);

async function main() {
  console.log('=== veOLAS State for Safe ===\n');
  console.log('Safe:', SAFE_ADDRESS);
  console.log('');

  const [lockedEnd, balance, lastPoint, lockedBalance, totalSupply, totalSupplyLocked] = await Promise.all([
    veOlas.lockedEnd(SAFE_ADDRESS),
    veOlas.balanceOf(SAFE_ADDRESS),
    veOlas.getLastUserPoint(SAFE_ADDRESS),
    veOlas.mapLockedBalances(SAFE_ADDRESS),
    veOlas.totalSupply(),
    veOlas.totalSupplyLocked(),
  ]);

  console.log('Lock End:', new Date(Number(lockedEnd) * 1000).toISOString());
  console.log('Current veOLAS Balance:', ethers.formatEther(balance));
  console.log('');
  console.log('Locked Balance:');
  console.log('  Amount:', ethers.formatEther(lockedBalance.amount), 'OLAS');
  console.log('  End Time:', new Date(Number(lockedBalance.endTime) * 1000).toISOString());
  console.log('');
  console.log('Last User Point:');
  console.log('  Bias:', ethers.formatEther(lastPoint.bias));
  console.log('  Slope:', ethers.formatEther(lastPoint.slope));
  console.log('  Timestamp:', new Date(Number(lastPoint.ts) * 1000).toISOString());
  console.log('  Balance:', ethers.formatEther(lastPoint.balance), 'OLAS');
  console.log('');
  console.log('Global:');
  console.log('  Total veOLAS Supply:', ethers.formatEther(totalSupply));
  console.log('  Total OLAS Locked:', ethers.formatEther(totalSupplyLocked));
  console.log('');

  // Check if lock has expired
  const now = Math.floor(Date.now() / 1000);
  if (Number(lockedEnd) < now) {
    console.log('⚠️  LOCK HAS EXPIRED! Need to withdraw first before creating new lock.');
  } else if (Number(lockedEnd) > 0) {
    const daysRemaining = (Number(lockedEnd) - now) / 86400;
    console.log(`Lock active, ${daysRemaining.toFixed(1)} days remaining`);
  }
}

main().catch(console.error);
