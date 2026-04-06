import { ethers } from 'ethers';

const RPC_URL = process.env.RPC_URL;
const ADDRESS = '0x2585e63df7BD9De8e058884D496658a030b5c6ce';

async function check() {
  if (!RPC_URL) {
    console.error('RPC_URL not set');
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const code = await provider.getCode(ADDRESS);
  console.log(`Code at ${ADDRESS}: ${code.slice(0, 20)}...`);
  
  if (code === '0x') {
    console.error('Contract does not exist!');
  } else {
    try {
        const contract = new ethers.Contract(ADDRESS, ['function minStakingDeposit() view returns (uint256)'], provider);
        const minDeposit = await contract.minStakingDeposit();
        console.log(`minStakingDeposit: ${minDeposit.toString()}`);
    } catch (e) {
        console.error('Failed to call minStakingDeposit:', e);
    }
  }
}

check();
