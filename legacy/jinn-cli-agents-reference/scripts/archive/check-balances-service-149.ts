/**
 * Check balances for service #149 addresses
 */

import { ethers } from 'ethers';

const AGENT_ADDRESS = '0xd36f1C72268d97af2D16426c060646Ec9aBB74F9';
const SAFE_ADDRESS_WRONG = '0x61e2B89477f62E4A98aFd0491D0E1A8b0e8BDfCB'; // Wrong Safe
const SAFE_ADDRESS = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645'; // Correct Safe per JINN-186
const RPC_URL = process.env.BASE_LEDGER_RPC || 'https://mainnet.base.org';

async function checkBalances() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  
  console.log('Checking balances on Base mainnet...\n');
  
  const agentBalance = await provider.getBalance(AGENT_ADDRESS);
  const safeBalance = await provider.getBalance(SAFE_ADDRESS);
  
  console.log('Agent Key:', AGENT_ADDRESS);
  console.log('Balance:', ethers.formatEther(agentBalance), 'ETH');
  console.log('Wei:', agentBalance.toString());
  console.log();
  
  console.log('Safe Address:', SAFE_ADDRESS);
  console.log('Balance:', ethers.formatEther(safeBalance), 'ETH');
  console.log('Wei:', safeBalance.toString());
  console.log();
  
  console.log('Required for mech deployment: ~0.00072 ETH (gas)');
  console.log('Agent has sufficient funds:', agentBalance > ethers.parseEther('0.001'));
}

checkBalances().catch(console.error);
