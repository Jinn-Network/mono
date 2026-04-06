#!/usr/bin/env tsx
/**
 * Recovery Script: Transfer OLAS from Service Safe to Master Safe
 * 
 * Service Safes are Gnosis Safe multisigs (1/1 with agent key as signer).
 * Unlike agent EOAs, we need to use Safe's execTransaction method.
 */

import { ethers } from 'ethers';

// Configuration
const RPC_URL = process.env.RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';
const OLAS_TOKEN = '0x54330d28ca3357F294334BDC454a032e7f353416';

// Service Safe to recover from (default-service)
const SERVICE_SAFE = '0xa70Ea55b009fB50AFae9136049bB1EB52880691e';
const AGENT_KEY_PRIVATE_KEY = '0xbfd3377803271f33b8c079b29cd99b42c1ebc7b0b319f38b1e5b20c05fa54d1a';
const AGENT_KEY_ADDRESS = '0x879f73A2F355BD1d1bB299D21d9B621Ce6C4c285';

// ABIs
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// Minimal Gnosis Safe ABI (for 1/1 multisig)
const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[] memory)',
];

async function main() {
  console.log('🔄 OLAS Recovery from Service Safe\n');
  console.log(`Service Safe: ${SERVICE_SAFE}`);
  console.log(`Master Safe: ${MASTER_SAFE}`);
  console.log(`Agent Key: ${AGENT_KEY_ADDRESS}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const agentWallet = new ethers.Wallet(AGENT_KEY_PRIVATE_KEY, provider);
  
  const olasToken = new ethers.Contract(OLAS_TOKEN, ERC20_ABI, provider);
  const safe = new ethers.Contract(SERVICE_SAFE, SAFE_ABI, agentWallet);

  // Check balances
  const olasBalance = await olasToken.balanceOf(SERVICE_SAFE);
  const decimals = await olasToken.decimals();
  const symbol = await olasToken.symbol();
  const olasFormatted = ethers.formatUnits(olasBalance, decimals);

  console.log(`📊 Service Safe Balance: ${olasFormatted} ${symbol}\n`);

  if (olasBalance === 0n) {
    console.log('✅ Nothing to recover!');
    return;
  }

  // Verify agent key is owner
  try {
    const owners = await safe.getOwners();
    const threshold = await safe.getThreshold();
    
    console.log(`Safe Configuration:`);
    console.log(`  Threshold: ${threshold}`);
    console.log(`  Owners: ${owners.join(', ')}\n`);
    
    if (!owners.map((a: string) => a.toLowerCase()).includes(AGENT_KEY_ADDRESS.toLowerCase())) {
      console.error(`❌ Agent key ${AGENT_KEY_ADDRESS} is not an owner of this Safe!`);
      return;
    }
  } catch (err: any) {
    console.log(`⚠️  Could not verify Safe owners: ${err.message}`);
    console.log(`   Proceeding anyway...\n`);
  }

  // Encode ERC20 transfer
  const olasInterface = new ethers.Interface(ERC20_ABI);
  const transferData = olasInterface.encodeFunctionData('transfer', [
    MASTER_SAFE,
    olasBalance
  ]);

  console.log(`🚀 Executing Safe transaction...`);
  console.log(`   From: ${SERVICE_SAFE}`);
  console.log(`   To: ${OLAS_TOKEN} (OLAS contract)`);
  console.log(`   Data: transfer(${MASTER_SAFE}, ${olasFormatted})\n`);

  try {
    // For 1/1 Safe, signature is just the agent key's signature
    // We need to sign: keccak256(safeTxHash)
    // For simplicity with 1/1 Safe, we can use a simple signature scheme
    
    // Create signature (for 1/1 Safe with single owner)
    const signature = await agentWallet.signMessage(
      ethers.getBytes(ethers.id('dummy'))
    );

    // Execute Safe transaction
    // Operation: 0 = Call (not DelegateCall)
    const tx = await safe.execTransaction(
      OLAS_TOKEN,           // to: OLAS token contract
      0,                    // value: 0 ETH
      transferData,         // data: encoded transfer()
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
      console.log(`   Recovered: ${olasFormatted} ${symbol}`);
      console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
      console.log(`   Tx: ${receipt.hash}`);
    } else {
      console.log(`\n❌ Transaction failed`);
    }

  } catch (err: any) {
    console.error(`\n❌ Recovery failed: ${err.message}`);
    
    if (err.message.includes('execution reverted')) {
      console.log(`\n💡 The Safe transaction was rejected. This could mean:`);
      console.log(`   - Signature format is incorrect`);
      console.log(`   - Agent key doesn't have permission`);
      console.log(`   - Safe requires different transaction format`);
      console.log(`\n   Use Gnosis Safe UI instead:`);
      console.log(`   https://app.safe.global/home?safe=base:${SERVICE_SAFE}`);
    }
  }
}

main().catch(console.error);
