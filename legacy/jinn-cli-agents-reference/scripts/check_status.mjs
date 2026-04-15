import { ethers } from 'ethers';
import 'dotenv/config';

const MECH_MARKETPLACE = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';
const MECH = '0x8c083Dfe9bee719a05Ba3c75A9B16BE4ba52c299';
const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

const abi = [
  'function getUndeliveredRequests(address mech, uint256 offset, uint256 limit) view returns (uint256[])'
];

async function main() {
  console.log('Connecting to RPC:', RPC);
  const provider = new ethers.JsonRpcProvider(RPC);
  const contract = new ethers.Contract(MECH_MARKETPLACE, abi, provider);

  console.log('Checking on-chain undelivered requests...');
  console.log('Mech:', MECH);
  
  try {
    const undelivered = await contract.getUndeliveredRequests(MECH, 0, 0);
    console.log('Undelivered IDs (on-chain):', undelivered.length);
    
    const targetIds = [
      '0x5dc57dcc54ebaa0fb3a78782f271935e139238a3245e34529d6b987819c470cd',
      '0x060bcf0b0e3a369aaaf3eae3565be8aa70058a83005b1b4347c20e9d3d0dd259'
    ];
    
    const onChainSet = new Set(undelivered.map(id => '0x' + BigInt(id).toString(16).toLowerCase()));

    for (const target of targetIds) {
        const found = onChainSet.has(target.toLowerCase());
        console.log(`${target}: ${found ? 'FOUND (Undelivered)' : 'NOT FOUND (Delivered or Cancelled)'}`);
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

main().catch(console.error);
