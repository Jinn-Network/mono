/**
 * Fund agent key for service #149 mech deployment
 * 
 * This script sends 0.001 ETH to the agent key to cover gas costs
 */

import { ethers } from 'ethers';

const AGENT_ADDRESS = '0xd36f1C72268d97af2D16426c060646Ec9aBB74F9';
const AMOUNT = '0.001'; // 0.001 ETH for gas

async function fundAgentKey() {
  console.log('Funding agent key for mech deployment...\n');
  
  const rpcUrl = process.env.RPC_URL;
  const fundingPrivateKey = process.env.FUNDING_PRIVATE_KEY || process.env.WORKER_PRIVATE_KEY;

  if (!rpcUrl) {
    throw new Error('RPC_URL environment variable required');
  }
  
  if (!fundingPrivateKey) {
    throw new Error('FUNDING_PRIVATE_KEY or WORKER_PRIVATE_KEY environment variable required');
  }
  
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(fundingPrivateKey, provider);
  
  console.log('Funding from:', wallet.address);
  console.log('To:', AGENT_ADDRESS);
  console.log('Amount:', AMOUNT, 'ETH');
  console.log();
  
  // Check funding wallet balance
  const balance = await provider.getBalance(wallet.address);
  console.log('Funding wallet balance:', ethers.formatEther(balance), 'ETH');
  
  const amountWei = ethers.parseEther(AMOUNT);
  if (balance < amountWei) {
    throw new Error(`Insufficient balance in funding wallet. Have: ${ethers.formatEther(balance)} ETH, Need: ${AMOUNT} ETH`);
  }
  
  console.log('\nSending transaction...');
  const tx = await wallet.sendTransaction({
    to: AGENT_ADDRESS,
    value: amountWei
  });
  
  console.log('Transaction sent:', tx.hash);
  console.log('Waiting for confirmation...');
  
  const receipt = await tx.wait();
  console.log('Transaction confirmed in block:', receipt?.blockNumber);
  console.log();
  
  // Verify new balance
  const newBalance = await provider.getBalance(AGENT_ADDRESS);
  console.log('Agent key new balance:', ethers.formatEther(newBalance), 'ETH');
  console.log('✅ Funding complete');
}

fundAgentKey().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
