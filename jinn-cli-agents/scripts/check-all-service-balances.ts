import { ethers } from 'ethers';

const RPC = process.env.RPC_URL || 'https://mainnet.base.org';
const OLAS = '0x54330d28ca3357F294334BDC454a032e7f353416';
const abi = ['function balanceOf(address) view returns (uint256)'];

const services = [
  {name: 'Service 146 Safe 1', safe: '0x39c7fA5DF192493da10f4e334551069388c67Aa2', agent: '0x73844EBF1a39B71440750a2576464d17f49F1385'},
  {name: 'Service 146 Safe 2', safe: '0xacAB913dfa38687f52e028da90c9b08CD0c920e1', agent: '0xC32d4Bc509e52D04c39A5a1b2D4fA0c95c473550'},
  {name: 'Service 146 Safe 3', safe: '0x45a46df69cb88755F7D3026897f125e214E8e04E', agent: '0x4454Cc6c3C5823De93E3002e3bc8b1203300E166'},
  {name: 'Service 150', safe: '0xbcE25403FE17Cc0C41F334A07ca26cd8890090d9', agent: '0x676FB16B08f59B7570163194CD80E07Ca7fa2621'},
  {name: 'Service 149', safe: '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645', agent: '0xd36f1C72268d97af2D16426c060646Ec9aBB74F9'},
  {name: 'Service 158', safe: '0x85cCa19f096cdaE00057c1CB1a26281bB47Cd5CE', agent: '0xbE83DB66b6Ffe1eD9791792Bb89fC55490306cea'},
];

// Rate limiting: QuickNode free tier = 15 req/sec
// 4 calls per service in Promise.all = burst of 4 calls
// Need 1 second between services to avoid rate limit (15 req/sec sustained)
const RATE_LIMIT_DELAY_MS = 1000;

async function checkAll() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const token = new ethers.Contract(OLAS, abi, provider);
  
  console.log('🔍 Checking all service balances...\n');
  console.log(`RPC: ${RPC}`);
  console.log(`Rate limiting: ${RATE_LIMIT_DELAY_MS}ms delay between services (QuickNode: 15 req/sec)\n`);
  
  let totalOlas = 0n;
  let totalEth = 0n;
  
  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    
    // Rate limit: wait between services (except first)
    if (i > 0) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }
    
    try {
      // 4 RPC calls per service (batched in Promise.all, but still count against rate limit)
      const [safeOlas, safeEth, agentOlas, agentEth] = await Promise.all([
        token.balanceOf(svc.safe),
        provider.getBalance(svc.safe),
        token.balanceOf(svc.agent),
        provider.getBalance(svc.agent),
      ]);
      
      const hasOlas = safeOlas > 0n || agentOlas > 0n;
      const hasEth = safeEth > 0n || agentEth > 0n;
      
      if (hasOlas || hasEth) {
        console.log(`📦 ${svc.name}:`);
        if (safeOlas > 0n) {
          console.log(`  Safe OLAS: ${ethers.formatEther(safeOlas)}`);
          totalOlas += safeOlas;
        }
        if (safeEth > 0n) {
          console.log(`  Safe ETH: ${ethers.formatEther(safeEth)}`);
          totalEth += safeEth;
        }
        if (agentOlas > 0n) {
          console.log(`  Agent OLAS: ${ethers.formatEther(agentOlas)}`);
          totalOlas += agentOlas;
        }
        if (agentEth > 0n) {
          console.log(`  Agent ETH: ${ethers.formatEther(agentEth)}`);
          totalEth += agentEth;
        }
        console.log('');
      }
    } catch (err: any) {
      console.error(`❌ Error checking ${svc.name}: ${err.message}`);
    }
  }
  
  console.log('═══════════════════════════════════');
  console.log(`Total OLAS in services: ${ethers.formatEther(totalOlas)}`);
  console.log(`Total ETH in services: ${ethers.formatEther(totalEth)}`);
  console.log('═══════════════════════════════════\n');
}

checkAll().catch(console.error);

