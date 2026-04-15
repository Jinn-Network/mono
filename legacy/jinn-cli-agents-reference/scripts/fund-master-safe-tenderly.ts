import { ethers } from 'ethers';

const RPC_URL = process.argv[2] || 'https://virtual.base.eu.rpc.tenderly.co/65f2bb50-f25e-42ac-b0e3-36e552e9b672';
const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';
const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';

async function fundMasterSafe() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  
  // Use Tenderly's default test account (has unlimited ETH)
  const wallet = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
  
  console.log('Funder address:', wallet.address);
  console.log('Master Safe:', MASTER_SAFE);
  console.log('');
  
  // OLAS token contract
  const olasAbi = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)'
  ];
  const olas = new ethers.Contract(OLAS_TOKEN, olasAbi, wallet);
  
  // Transfer 50 OLAS (more than the 34.68 required)
  const amount = ethers.parseEther('50');
  console.log('💰 Transferring 50 OLAS to Master Safe...');
  
  const tx = await olas.transfer(MASTER_SAFE, amount);
  console.log('📝 Transaction hash:', tx.hash);
  
  console.log('⏳ Waiting for confirmation...');
  await tx.wait();
  console.log('✅ Transfer confirmed!');
  console.log('');
  
  // Verify balance
  const balance = await olas.balanceOf(MASTER_SAFE);
  console.log('🔍 Master Safe OLAS balance:', ethers.formatEther(balance), 'OLAS');
}

fundMasterSafe().catch(console.error);

