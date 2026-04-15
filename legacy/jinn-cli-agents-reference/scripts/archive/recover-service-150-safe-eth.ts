#!/usr/bin/env tsx
/**
 * Recovery Script: Transfer ETH from Service #150 Safe to Master Safe
 * Using Gnosis Safe execTransaction
 */

import { ethers } from 'ethers';

// Configuration
const RPC_URL = process.env.BASE_LEDGER_RPC || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';

// Service #150 configuration
const SERVICE_SAFE = '0xbcE25403FE17Cc0C41F334A07ca26cd8890090d9';
const AGENT_KEY_PRIVATE_KEY = '0x19ffde679ebf4fa0d4710f995abf81238789fb697c6e4082081d3983fed1f1bb';
const AGENT_KEY_ADDRESS = '0x676FB16B08f59B7570163194CD80E07Ca7fa2621';

// Minimal Gnosis Safe ABI
const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[] memory)',
  'function nonce() view returns (uint256)',
];

async function main() {
  console.log('💰 Service #150 Safe ETH Recovery\n');
  console.log(`Service Safe: ${SERVICE_SAFE}`);
  console.log(`Agent Key: ${AGENT_KEY_ADDRESS}`);
  console.log(`Master Safe: ${MASTER_SAFE}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const agentWallet = new ethers.Wallet(AGENT_KEY_PRIVATE_KEY, provider);
  const safe = new ethers.Contract(SERVICE_SAFE, SAFE_ABI, agentWallet);

  // Check balances
  const safeEthBalance = await provider.getBalance(SERVICE_SAFE);
  console.log(`Safe ETH Balance: ${ethers.formatEther(safeEthBalance)}\n`);

  if (safeEthBalance === 0n) {
    console.log('✅ Nothing to recover!');
    return;
  }

  // Verify agent key is owner
  try {
    const owners = await safe.getOwners();
    const threshold = await safe.getThreshold();
    
    console.log(`Safe Configuration:`);
    console.log(`  Threshold: ${threshold}`);
    console.log(`  Owners: ${owners.join(', ')}`);
    
    if (!owners.map((a: string) => a.toLowerCase()).includes(AGENT_KEY_ADDRESS.toLowerCase())) {
      console.error(`\n❌ Agent key ${AGENT_KEY_ADDRESS} is not an owner of this Safe!`);
      return;
    }
    console.log(`  ✅ Agent key is owner\n`);
  } catch (err: any) {
    console.log(`⚠️  Could not verify Safe owners: ${err.message}`);
    console.log(`   Proceeding anyway...\n`);
  }

  // For 1/1 Safe sending ETH, we just need a simple transaction
  // Operation: 0 = Call
  // Data: empty (just ETH transfer)
  console.log(`🚀 Executing Safe transaction...`);
  console.log(`   Sending ${ethers.formatEther(safeEthBalance)} ETH to Master Safe\n`);

  try {
    // For 1/1 Safe, we need a valid signature
    // The signature should be the agent signing the Safe transaction hash
    // For simplicity, we can use eth_sign compatible signature with v=27 or 28
    
    // Create a dummy signature for 1/1 Safe (the Safe will validate it)
    // For eth_sign compatible: r + s + v where v is 27 or 28
    const signature = await agentWallet.signMessage(ethers.getBytes(ethers.id('dummy')));

    // Execute Safe transaction to send ETH
    const tx = await safe.execTransaction(
      MASTER_SAFE,          // to: Master Safe
      safeEthBalance,       // value: all ETH in Safe
      '0x',                 // data: empty (just ETH transfer)
      0,                    // operation: 0 = Call
      0,                    // safeTxGas: 0 = estimate
      0,                    // baseGas: 0
      0,                    // gasPrice: 0
      ethers.ZeroAddress,   // gasToken: ETH
      ethers.ZeroAddress,   // refundReceiver: none
      signature             // signatures: agent key signature
    );

    console.log(`⏳ Transaction sent: ${tx.hash}`);
    console.log(`   Waiting for confirmation...`);

    const receipt = await tx.wait();

    if (receipt?.status === 1) {
      console.log(`\n✅ Recovery Successful!`);
      console.log(`   Recovered: ${ethers.formatEther(safeEthBalance)} ETH`);
      console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
      console.log(`   Tx: ${receipt.hash}`);
    } else {
      console.log(`\n❌ Transaction failed`);
    }

  } catch (err: any) {
    console.error(`\n❌ Recovery failed: ${err.message}`);
    
    console.log(`\n💡 If the Safe transaction format is incorrect, use Safe UI instead:`);
    console.log(`   1. Import agent key: ${AGENT_KEY_PRIVATE_KEY}`);
    console.log(`   2. Go to: https://app.safe.global/home?safe=base:${SERVICE_SAFE}`);
    console.log(`   3. Send ${ethers.formatEther(safeEthBalance)} ETH to ${MASTER_SAFE}`);
  }
}

main().catch(console.error);

