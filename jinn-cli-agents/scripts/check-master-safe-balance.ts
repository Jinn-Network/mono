#!/usr/bin/env tsx
import { ethers } from 'ethers';

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';
const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const olas = new ethers.Contract(OLAS_TOKEN, ERC20_ABI, provider);
  
  const balance = await olas.balanceOf(MASTER_SAFE);
  const decimals = await olas.decimals();
  const symbol = await olas.symbol();
  const ethBalance = await provider.getBalance(MASTER_SAFE);
  
  console.log('🔍 Master Safe Balance Check\n');
  console.log(`Master Safe: ${MASTER_SAFE}\n`);
  console.log(`Current Balances:`);
  console.log(`  OLAS: ${ethers.formatUnits(balance, decimals)} ${symbol}`);
  console.log(`  ETH: ${ethers.formatEther(ethBalance)} ETH`);
  
  console.log(`\n📊 Check Transaction History:`);
  console.log(`  BaseScan: https://basescan.org/address/${MASTER_SAFE}`);
  console.log(`  OLAS Transfers: https://basescan.org/token/${OLAS_TOKEN}?a=${MASTER_SAFE}`);
  console.log(`  Safe UI: https://app.safe.global/home?safe=base:${MASTER_SAFE}`);
}

main().catch(console.error);

