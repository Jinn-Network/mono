#!/usr/bin/env tsx
/**
 * Recovery Script: Transfer ETH from Service #150 Safe and Agent to Master Safe
 */

import { ethers } from 'ethers';

// Configuration
const RPC_URL = process.env.BASE_LEDGER_RPC || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';

// Service #150 configuration
const SERVICE_SAFE = '0xbcE25403FE17Cc0C41F334A07ca26cd8890090d9';
const AGENT_KEY_PRIVATE_KEY = '0x19ffde679ebf4fa0d4710f995abf81238789fb697c6e4082081d3983fed1f1bb';
const AGENT_KEY_ADDRESS = '0x676FB16B08f59B7570163194CD80E07Ca7fa2621';

async function main() {
  console.log('💰 Service #150 Fund Recovery\n');
  console.log(`Service Safe: ${SERVICE_SAFE}`);
  console.log(`Agent Key: ${AGENT_KEY_ADDRESS}`);
  console.log(`Master Safe: ${MASTER_SAFE}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const agentWallet = new ethers.Wallet(AGENT_KEY_PRIVATE_KEY, provider);

  // Check balances
  const safeEthBalance = await provider.getBalance(SERVICE_SAFE);
  const agentEthBalance = await provider.getBalance(AGENT_KEY_ADDRESS);
  
  console.log(`Safe ETH: ${ethers.formatEther(safeEthBalance)}`);
  console.log(`Agent ETH: ${ethers.formatEther(agentEthBalance)}\n`);

  let totalRecovered = 0n;

  // Recover from agent EOA first (if any)
  if (agentEthBalance > 0n) {
    console.log('📤 Recovering ETH from agent EOA...');
    const feeData = await provider.getFeeData();
    const gasLimit = 21000n;
    const gasCost = gasLimit * (feeData.gasPrice || 1000000000n);
    const amountToSend = agentEthBalance - gasCost;
    
    if (amountToSend > 0n) {
      console.log(`   Sending ${ethers.formatEther(amountToSend)} ETH`);
      const tx = await agentWallet.sendTransaction({
        to: MASTER_SAFE,
        value: amountToSend,
        gasLimit
      });
      console.log(`   Tx: ${tx.hash}`);
      await tx.wait();
      console.log(`   ✅ Recovered ${ethers.formatEther(amountToSend)} ETH from agent EOA\n`);
      totalRecovered += amountToSend;
    }
  }

  // For Safe recovery, need to use Safe UI
  if (safeEthBalance > 0n) {
    console.log('⚠️  Service Safe has ETH. Use Safe UI to recover:');
    console.log(`\n   Manual Recovery Instructions:`);
    console.log(`   1. Import agent key to MetaMask:`);
    console.log(`      ${AGENT_KEY_PRIVATE_KEY}`);
    console.log(`\n   2. Go to Safe UI:`);
    console.log(`      https://app.safe.global/home?safe=base:${SERVICE_SAFE}`);
    console.log(`\n   3. New Transaction → Send funds`);
    console.log(`      - Token: ETH`);
    console.log(`      - Amount: ${ethers.formatEther(safeEthBalance)} ETH`);
    console.log(`      - Recipient: ${MASTER_SAFE}`);
    console.log(`\n   4. Sign and execute with MetaMask (agent key)`);
  }

  console.log(`\n📊 Recovery Summary:`);
  console.log(`   Recovered: ${ethers.formatEther(totalRecovered)} ETH`);
  console.log(`   Remaining in Safe: ${ethers.formatEther(safeEthBalance)} ETH (requires manual recovery)`);
}

main().catch(console.error);

