import { ethers } from 'ethers';

const RPC_URL = 'https://mainnet.base.org';
const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

const services = [
  { name: 'default-service', safe: '0xa70Ea55b009fB50AFae9136049bB1EB52880691e' },
  { name: 'jinn-mech-service (Service #150)', safe: '0xbcE25403FE17Cc0C41F334A07ca26cd8890090d9' },
  { name: 'service-149-recovered (Master Safe)', safe: '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645' },
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const olas = new ethers.Contract(OLAS_TOKEN, ERC20_ABI, provider);
  
  console.log('🔍 Checking all mainnet services...\n');
  
  let total = 0n;
  
  for (const svc of services) {
    await new Promise(r => setTimeout(r, 1000)); // Rate limit
    
    const olasBalance = await olas.balanceOf(svc.safe);
    const ethBalance = await provider.getBalance(svc.safe);
    
    console.log(`📦 ${svc.name}`);
    console.log(`   Safe: ${svc.safe}`);
    console.log(`   OLAS: ${ethers.formatEther(olasBalance)}`);
    console.log(`   ETH: ${ethers.formatEther(ethBalance)}\n`);
    
    total += olasBalance;
  }
  
  console.log('═══════════════════════════════════');
  console.log(`Total OLAS across all Safes: ${ethers.formatEther(total)}`);
  console.log('═══════════════════════════════════');
}

main().catch(console.error);
