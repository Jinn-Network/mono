#!/usr/bin/env tsx
/**
 * Recover all OLAS from Service #150 (agent EOA + Safe)
 * 
 * Service #150:
 * - Safe: 0xbcE25403FE17Cc0C41F334A07ca26cd8890090d9 (50 OLAS)
 * - Agent: 0x676FB16B08f59B7570163194CD80E07Ca7fa2621 (50 OLAS)
 * 
 * Target: Master Safe 0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645
 * Total Recovery: 100 OLAS
 */

import { ethers } from 'ethers';
import Safe from '@safe-global/protocol-kit';

const RPC_URL = process.env.BASE_LEDGER_RPC || 'https://mainnet.base.org';
const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';
const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';

const SERVICE_150_SAFE = '0xbcE25403FE17Cc0C41F334A07ca26cd8890090d9';
const SERVICE_150_AGENT_KEY = '0x19ffde679ebf4fa0d4710f995abf81238789fb697c6e4082081d3983fed1f1bb';
const SERVICE_150_AGENT_ADDRESS = '0x676FB16B08f59B7570163194CD80E07Ca7fa2621';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

async function main() {
  console.log('💰 Service #150 OLAS Recovery\n');
  console.log('═══════════════════════════════════════════════════════\n');
  
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const olasToken = new ethers.Contract(OLAS_TOKEN, ERC20_ABI, provider);
  
  // Step 1: Check balances
  console.log('📊 Checking balances...\n');
  
  const agentOlasBalance = await olasToken.balanceOf(SERVICE_150_AGENT_ADDRESS);
  const safeOlasBalance = await olasToken.balanceOf(SERVICE_150_SAFE);
  const agentEthBalance = await provider.getBalance(SERVICE_150_AGENT_ADDRESS);
  const safeEthBalance = await provider.getBalance(SERVICE_150_SAFE);
  
  console.log(`Agent (${SERVICE_150_AGENT_ADDRESS}):`);
  console.log(`  OLAS: ${ethers.formatEther(agentOlasBalance)}`);
  console.log(`  ETH: ${ethers.formatEther(agentEthBalance)}\n`);
  
  console.log(`Safe (${SERVICE_150_SAFE}):`);
  console.log(`  OLAS: ${ethers.formatEther(safeOlasBalance)}`);
  console.log(`  ETH: ${ethers.formatEther(safeEthBalance)}\n`);
  
  const totalOlas = agentOlasBalance + safeOlasBalance;
  console.log(`Total OLAS to recover: ${ethers.formatEther(totalOlas)}\n`);
  
  if (totalOlas === 0n) {
    console.log('❌ No OLAS to recover!');
    return;
  }
  
  // Step 2: Recover from Agent EOA (if any)
  if (agentOlasBalance > 0n) {
    console.log('═══════════════════════════════════════════════════════');
    console.log('Step 1: Recover OLAS from Agent EOA\n');
    
    const agentWallet = new ethers.Wallet(SERVICE_150_AGENT_KEY, provider);
    const olasWithSigner = olasToken.connect(agentWallet) as ethers.Contract;
    
    console.log(`Transferring ${ethers.formatEther(agentOlasBalance)} OLAS to Master Safe...`);
    
    const tx = await olasWithSigner.transfer(MASTER_SAFE, agentOlasBalance);
    console.log(`Transaction sent: ${tx.hash}`);
    console.log(`BaseScan: https://basescan.org/tx/${tx.hash}\n`);
    
    console.log('⏳ Waiting for confirmation...');
    const receipt = await tx.wait();
    
    if (receipt?.status === 1) {
      console.log('✅ Agent OLAS recovered successfully!\n');
    } else {
      console.log('❌ Agent OLAS recovery failed!\n');
    }
  } else {
    console.log('ℹ️  No OLAS in agent EOA, skipping...\n');
  }
  
  // Step 3: Recover from Service Safe (if any)
  if (safeOlasBalance > 0n) {
    console.log('═══════════════════════════════════════════════════════');
    console.log('Step 2: Recover OLAS from Service Safe\n');
    
    const agentWallet = new ethers.Wallet(SERVICE_150_AGENT_KEY, provider);
    
    console.log('Initializing Safe SDK...');
    const safeSdk = await Safe.init({
      provider: RPC_URL,
      signer: SERVICE_150_AGENT_KEY,
      safeAddress: SERVICE_150_SAFE,
    });
    
    console.log('Creating Safe transaction...');
    const olasInterface = new ethers.Interface(ERC20_ABI);
    const transferData = olasInterface.encodeFunctionData('transfer', [
      MASTER_SAFE,
      safeOlasBalance
    ]);
    
    const safeTransaction = await safeSdk.createTransaction({
      transactions: [{
        to: OLAS_TOKEN,
        value: '0',
        data: transferData,
      }]
    });
    
    console.log('Signing transaction...');
    const signedSafeTransaction = await safeSdk.signTransaction(safeTransaction);
    
    console.log(`Executing transaction to transfer ${ethers.formatEther(safeOlasBalance)} OLAS...`);
    const txResponse = await safeSdk.executeTransaction(signedSafeTransaction);
    
    console.log(`Transaction hash: ${txResponse.hash}`);
    console.log(`BaseScan: https://basescan.org/tx/${txResponse.hash}\n`);
    
    console.log('⏳ Waiting for confirmation...');
    const receipt = await txResponse.wait();
    
    if (receipt?.status === 1) {
      console.log('✅ Safe OLAS recovered successfully!\n');
    } else {
      console.log('❌ Safe OLAS recovery failed!\n');
    }
  } else {
    console.log('ℹ️  No OLAS in Service Safe, skipping...\n');
  }
  
  // Step 4: Verify Master Safe balance
  console.log('═══════════════════════════════════════════════════════');
  console.log('Final Balance Check\n');
  
  const masterOlasBalance = await olasToken.balanceOf(MASTER_SAFE);
  console.log(`Master Safe OLAS: ${ethers.formatEther(masterOlasBalance)}`);
  console.log(`\n✅ Recovery complete!`);
  console.log(`\nView Master Safe: https://basescan.org/address/${MASTER_SAFE}`);
}

main().catch(console.error);

