#!/usr/bin/env tsx
import { ethers } from 'ethers';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const RPC_URL = process.env.BASE_RPC_URL || process.env.RPC_URL || 'https://mainnet.base.org';
const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';
const KEYS_DIR = 'olas-operate-middleware/.operate/keys';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

async function main() {
  console.log('🔍 Checking OLAS balances in agent keys...\n');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`OLAS Token: ${OLAS_TOKEN}\n`);
  
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const olasToken = new ethers.Contract(OLAS_TOKEN, ERC20_ABI, provider);
  const decimals = await olasToken.decimals();
  
  // Get all key files (non-backup)
  const keyFiles = readdirSync(KEYS_DIR).filter(f => 
    f.startsWith('0x') && !f.endsWith('.bak')
  );
  
  console.log(`Found ${keyFiles.length} agent keys\n`);
  console.log('═'.repeat(80));
  
  const agentsWithOLAS = [];
  let totalOLAS = 0n;
  
  for (let i = 0; i < keyFiles.length; i++) {
    const address = keyFiles[i];
    
    // Rate limiting: 15 req/sec = 66ms per request minimum
    // We'll use 150ms per address (2 calls per address = 300ms total = 3.3 req/sec)
    if (i > 0) {
      await new Promise(r => setTimeout(r, 150));
    }
    
    // Progress update every 5 addresses
    if (i > 0 && i % 5 === 0) {
      console.log(`⏸️  Progress: ${i}/${keyFiles.length} checked...`);
    }
    
    try {
      // Retry logic for rate limiting
      let balance = 0n;
      let ethBalance = 0n;
      let retries = 3;
      
      while (retries > 0) {
        try {
          balance = await olasToken.balanceOf(address);
          ethBalance = await provider.getBalance(address);
          break; // Success
        } catch (retryErr: any) {
          retries--;
          if (retries === 0) throw retryErr;
          // Wait longer before retry
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      
      if (balance > 0n) {
        const olasFormatted = ethers.formatUnits(balance, decimals);
        const ethFormatted = ethers.formatEther(ethBalance);
        
        // Read private key
        const keyPath = join(KEYS_DIR, address);
        const keyData = JSON.parse(readFileSync(keyPath, 'utf-8'));
        const privateKey = keyData.private_key || keyData.privateKey;
        
        console.log(`✅ ${address}`);
        console.log(`   OLAS: ${olasFormatted}, ETH: ${ethFormatted}`);
        
        agentsWithOLAS.push({
          address,
          privateKey,
          olasBalance: olasFormatted,
          olasBalanceWei: balance,
          ethBalance: ethFormatted,
        });
        
        totalOLAS += balance;
      }
    } catch (err: any) {
      if (err.message.includes('429') || err.message.includes('Too Many Requests')) {
        console.log(`⚠️  ${address}: Rate limited, skipping`);
      } else {
        console.log(`❌ ${address}: ${err.message.substring(0, 80)}`);
      }
    }
  }
  
  console.log('\n' + '═'.repeat(80));
  console.log(`\n📊 Summary:`);
  console.log(`   Agents with OLAS: ${agentsWithOLAS.length}/${keyFiles.length}`);
  console.log(`   Total OLAS: ${ethers.formatUnits(totalOLAS, decimals)}`);
  
  if (agentsWithOLAS.length > 0) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log('\n📝 Add these to scripts/recover-stranded-olas.ts:\n');
    console.log('const AGENTS = [');
    agentsWithOLAS.forEach(agent => {
      console.log(`  {`);
      console.log(`    address: '${agent.address}',`);
      console.log(`    privateKey: '${agent.privateKey}',`);
      console.log(`    // ${agent.olasBalance} OLAS, ${agent.ethBalance} ETH`);
      console.log(`  },`);
    });
    console.log('];\n');
    
    // Check which agents have ETH for gas
    const canRecover = agentsWithOLAS.filter(a => parseFloat(a.ethBalance) > 0);
    const needsETH = agentsWithOLAS.filter(a => parseFloat(a.ethBalance) === 0);
    
    if (needsETH.length > 0) {
      console.log(`⚠️  ${needsETH.length} agents need ETH for gas:`);
      needsETH.forEach(a => {
        console.log(`   ${a.address}: ${a.olasBalance} OLAS (needs ~0.0001 ETH for gas)`);
      });
      console.log('');
    }
    
    if (canRecover.length > 0) {
      console.log(`✅ ${canRecover.length} agents ready to recover (have ETH for gas)`);
    }
  } else {
    console.log('\n✨ No stranded OLAS found!');
  }
}

main().catch(console.error);

