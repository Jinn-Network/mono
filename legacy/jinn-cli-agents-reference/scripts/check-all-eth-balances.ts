#!/usr/bin/env tsx
/**
 * Check ETH balances across all known addresses
 * Find available ETH that can be moved to Service Safe
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

const RPC_URL = process.env.RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// Known addresses
const ADDRESSES = {
  'Service #164 Safe': '0xdB225C794218b1f5054dffF3462c84A30349B182',
  'Service #164 Agent': '0x3944aB4EbAe6F9CA96430CaE97B71FB878E1e100',
  'Master Safe': '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645',
  'Master EOA': '0xB1517bB7C0932f1154Fa4b17DeC2a6a4a3d02CC2',
  'Service #149 Safe': '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645', // Same as Master Safe
  'Service #150 Safe': '0xbcE25403FE17Cc0C41F334A07ca26cd8890090d9',
};

async function main() {
  console.log('🔍 Checking ETH Balances on Base Mainnet\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const balances: { address: string; name: string; balance: bigint }[] = [];

  // Check known addresses
  for (const [name, address] of Object.entries(ADDRESSES)) {
    try {
      const balance = await provider.getBalance(address);
      balances.push({ address, name, balance });
      console.log(`${name}:`);
      console.log(`  Address: ${address}`);
      console.log(`  Balance: ${ethers.formatEther(balance)} ETH\n`);
      
      // Add small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 100));
    } catch (error: any) {
      console.log(`${name}: Error - ${error.message}\n`);
    }
  }

  // Check all agent keys in .operate/keys/
  console.log('📂 Checking agent keys in olas-operate-middleware/.operate/keys/...\n');

  const keysDir = path.join(process.cwd(), 'olas-operate-middleware', '.operate', 'keys');
  
  if (fs.existsSync(keysDir)) {
    const keyFiles = fs.readdirSync(keysDir);
    
    for (const file of keyFiles) {
      if (file.startsWith('0x') && !file.endsWith('.txt')) {
        const address = file.replace('.json', '');
        
        // Skip if already checked
        if (Object.values(ADDRESSES).includes(address)) {
          continue;
        }

        try {
          const balance = await provider.getBalance(address);
          balances.push({ address, name: `Agent Key ${address.slice(0, 10)}...`, balance });
          
          console.log(`Agent Key: ${address}`);
          console.log(`  Balance: ${ethers.formatEther(balance)} ETH\n`);
          
          // Add delay
          await new Promise(r => setTimeout(r, 100));
        } catch (error: any) {
          console.log(`Agent Key ${address}: Error - ${error.message}\n`);
        }
      }
    }
  } else {
    console.log('⚠️  Keys directory not found\n');
  }

  // Summary
  console.log('='.repeat(70));
  console.log('📊 SUMMARY');
  console.log('='.repeat(70));

  const totalEth = balances.reduce((sum, b) => sum + b.balance, 0n);
  console.log(`Total ETH across all addresses: ${ethers.formatEther(totalEth)} ETH\n`);

  // Find addresses with movable ETH (excluding Service Safe which needs funding)
  const movableBalances = balances.filter(b => 
    b.balance > 0n && 
    b.address !== '0xdB225C794218b1f5054dffF3462c84A30349B182' // Exclude Service #164 Safe
  );

  if (movableBalances.length > 0) {
    console.log('💰 Addresses with ETH that could be moved:\n');
    for (const { name, address, balance } of movableBalances) {
      console.log(`  ${name}: ${ethers.formatEther(balance)} ETH`);
      console.log(`    Address: ${address}\n`);
    }

    const movableTotal = movableBalances.reduce((sum, b) => sum + b.balance, 0n);
    console.log(`Total movable: ${ethers.formatEther(movableTotal)} ETH\n`);

    // Calculate what we need
    const needed = ethers.parseEther('0.02');
    const serviceSafeBalance = balances.find(b => b.address === '0xdB225C794218b1f5054dffF3462c84A30349B182')?.balance || 0n;
    const shortfall = needed - serviceSafeBalance;

    console.log(`Service Safe needs: ${ethers.formatEther(shortfall)} ETH more\n`);

    if (movableTotal >= shortfall) {
      console.log(`✅ We have enough ETH to cover the shortfall!`);
      console.log(`   Can move ${ethers.formatEther(shortfall)} ETH from available addresses.\n`);
    } else {
      console.log(`⚠️  Available ETH (${ethers.formatEther(movableTotal)} ETH) is less than needed (${ethers.formatEther(shortfall)} ETH)`);
      console.log(`   Still need ${ethers.formatEther(shortfall - movableTotal)} ETH from external source.\n`);
    }
  } else {
    console.log('⚠️  No movable ETH found in checked addresses.\n');
  }

  console.log('='.repeat(70) + '\n');
}

main().catch(console.error);

