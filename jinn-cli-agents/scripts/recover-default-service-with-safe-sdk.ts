#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Recovery Script: Transfer OLAS from default-service Safe using Safe SDK
 */

import { ethers } from 'ethers';
import Safe from '@safe-global/protocol-kit';

const RPC_URL = process.env.RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';
const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';

// default-service configuration
const SERVICE_SAFE = '0xa70Ea55b009fB50AFae9136049bB1EB52880691e';
const AGENT_KEY_PRIVATE_KEY = '0xbfd3377803271f33b8c079b29cd99b42c1ebc7b0b319f38b1e5b20c05fa54d1a';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

async function main() {
  console.log('🔄 OLAS Recovery using Safe SDK\n');
  console.log(`Service Safe: ${SERVICE_SAFE}`);
  console.log(`Master Safe: ${MASTER_SAFE}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const olasToken = new ethers.Contract(OLAS_TOKEN, ERC20_ABI, provider);
  
  // Check balance
  const balance = await olasToken.balanceOf(SERVICE_SAFE);
  const balanceFormatted = ethers.formatEther(balance);
  
  console.log(`Safe OLAS Balance: ${balanceFormatted}\n`);
  
  if (balance === 0n) {
    console.log('✅ Nothing to recover!');
    return;
  }

  // Initialize Safe SDK
  console.log('📦 Initializing Safe SDK...');
  const protocolKit = await Safe.init({
    provider: RPC_URL,
    signer: AGENT_KEY_PRIVATE_KEY,
    safeAddress: SERVICE_SAFE,
  });

  console.log('✅ Safe SDK initialized\n');

  // Encode OLAS transfer
  const olasInterface = new ethers.Interface(ERC20_ABI);
  const data = olasInterface.encodeFunctionData('transfer', [MASTER_SAFE, balance]);

  // Create Safe transaction
  console.log('📝 Creating Safe transaction...');
  const safeTransaction = await protocolKit.createTransaction({
    transactions: [{
      to: OLAS_TOKEN,
      value: '0',
      data: data,
    }]
  });

  // Sign transaction
  console.log('✍️  Signing transaction...');
  const signedTx = await protocolKit.signTransaction(safeTransaction);
  
  // Execute transaction
  console.log('🚀 Executing transaction...');
  const executeTxResponse = await protocolKit.executeTransaction(signedTx);
  
  console.log(`⏳ Transaction sent: ${executeTxResponse.hash}`);
  console.log('   Waiting for confirmation...');
  
  await executeTxResponse.transactionResponse?.wait();
  
  console.log(`\n✅ Recovery Successful!`);
  console.log(`   Recovered: ${balanceFormatted} OLAS`);
  console.log(`   Tx: ${executeTxResponse.hash}`);
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message);
  console.error('\nFull error:', err);
});

