#!/usr/bin/env tsx
/**
 * Comprehensive Safe Balance Check
 * Checks all known Safes including backed up services
 */

import { ethers } from 'ethers';

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

// All known Safes (current services + backups)
const safes = [
  { name: 'Master Safe (Service #149)', address: '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645', agent: '0xd36f1C72268d97af2D16426c060646Ec9aBB74F9' },
  { name: 'Service #150', address: '0xbcE25403FE17Cc0C41F334A07ca26cd8890090d9', agent: '0x676FB16B08f59B7570163194CD80E07Ca7fa2621' },
  { name: 'default-service', address: '0xa70Ea55b009fB50AFae9136049bB1EB52880691e', agent: '0x879f73A2F355BD1d1bB299D21d9B621Ce6C4c285' },
  { name: 'Service #158 (backed up)', address: '0x85cCa19f096cdaE00057c1CB1a26281bB47Cd5CE', agent: '0xbE83DB66b6Ffe1eD9791792Bb89fC55490306cea' },
  { name: 'Service backup (sc-d31271dd)', address: '0x7Dfe44b1626b556d142fE9b58EB6f5A43Bf9248a', agent: '0xAE23236c417895715469eE13bbB74d729bBdd5f5' },
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const olas = new ethers.Contract(OLAS_TOKEN, ERC20_ABI, provider);
  
  console.log('🔍 Comprehensive Safe Balance Check\n');
  console.log('Checking all known Safes (including backups)...\n');
  
  let totalOlas = 0n;
  let totalEth = 0n;
  const recoverable: Array<{name: string, address: string, agent: string, olas: string, eth: string}> = [];
  
  for (let i = 0; i < safes.length; i++) {
    const safe = safes[i];
    
    // Rate limit
    if (i > 0) {
      await new Promise(r => setTimeout(r, 1000));
    }
    
    try {
      const [olasBalance, ethBalance, agentOlas, agentEth] = await Promise.all([
        olas.balanceOf(safe.address),
        provider.getBalance(safe.address),
        olas.balanceOf(safe.agent),
        provider.getBalance(safe.agent),
      ]);
      
      const hasOlas = olasBalance > 0n || agentOlas > 0n;
      const hasEth = ethBalance > 0n || agentEth > 0n;
      
      if (hasOlas || hasEth) {
        console.log(`📦 ${safe.name}`);
        console.log(`   Safe: ${safe.address}`);
        console.log(`   Agent: ${safe.agent}`);
        
        if (olasBalance > 0n) {
          const formatted = ethers.formatEther(olasBalance);
          console.log(`   Safe OLAS: ${formatted}`);
          totalOlas += olasBalance;
          recoverable.push({
            name: safe.name,
            address: safe.address,
            agent: safe.agent,
            olas: formatted,
            eth: '0'
          });
        }
        
        if (ethBalance > 0n) {
          const formatted = ethers.formatEther(ethBalance);
          console.log(`   Safe ETH: ${formatted}`);
          totalEth += ethBalance;
        }
        
        if (agentOlas > 0n) {
          const formatted = ethers.formatEther(agentOlas);
          console.log(`   Agent OLAS: ${formatted}`);
          totalOlas += agentOlas;
        }
        
        if (agentEth > 0n) {
          const formatted = ethers.formatEther(agentEth);
          console.log(`   Agent ETH: ${formatted}`);
          totalEth += agentEth;
        }
        
        console.log('');
      }
    } catch (err: any) {
      console.error(`❌ Error checking ${safe.name}: ${err.message}\n`);
    }
  }
  
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Total OLAS across all Safes: ${ethers.formatEther(totalOlas)}`);
  console.log(`Total ETH across all Safes: ${ethers.formatEther(totalEth)}`);
  console.log('═══════════════════════════════════════════════════════\n');
  
  if (recoverable.length > 0) {
    console.log('💰 Recoverable Safes:\n');
    recoverable.forEach(s => {
      console.log(`${s.name}: ${s.olas} OLAS`);
      console.log(`  Safe: ${s.address}`);
      console.log(`  Agent: ${s.agent}`);
      console.log('');
    });
  }
  
  console.log('\n📊 View transaction history:');
  console.log('  Master Safe: https://basescan.org/address/0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645');
  console.log('  OLAS Transfers: https://basescan.org/token/0x54330d28ca3357F294334BDC454a032e7f353416?a=0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645');
}

main().catch(console.error);

