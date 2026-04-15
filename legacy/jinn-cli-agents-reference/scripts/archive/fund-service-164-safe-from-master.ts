#!/usr/bin/env tsx
/**
 * Transfer ETH from Master Safe to Service #164 Safe
 * 
 * Master Safe can send ETH directly to Service #164 Safe.
 * We need ~0.02 ETH for marketplace requests.
 * Master Safe has 0.018 ETH, so we'll transfer that amount.
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

const RPC_URL = process.env.BASE_LEDGER_RPC || process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// Addresses
const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';
const SERVICE_SAFE = '0xdB225C794218b1f5054dffF3462c84A30349B182';

// Amount to transfer (all available from Master Safe)
const TRANSFER_AMOUNT = ethers.parseEther('0.017'); // Leave small buffer for gas

// Master Safe agent key (signs transactions for Master Safe)
const MASTER_SAFE_AGENT_ADDRESSES = [
  '0x52c25D37D9765BC0799CCdf69AdD2d83bCa3012e',
  '0x879f73A2F355BD1d1bB299D21d9B621Ce6C4c285',
  '0x7b36577165d344F359D198D5F25c9E037ad39Fbf',
  '0x5718BF6Fa41E97f127F1F6208f25A9d5c085b5bC',
  '0xb2f50d7DAE5a3E3c0B26d7aAd044720081F6f90A',
  '0xddfc1160D8f09b42C16A27E702dF4104a652e4FE',
];

// Safe ABI (minimal for execTransaction)
const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[] memory)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
];

async function findAgentKey(): Promise<{ address: string; privateKey: string } | null> {
  const keysDir = path.join(process.cwd(), 'olas-operate-middleware', '.operate', 'keys');
  
  if (!fs.existsSync(keysDir)) {
    console.error('❌ Keys directory not found');
    return null;
  }

  // Check which agent key is an owner of Master Safe
  for (const agentAddress of MASTER_SAFE_AGENT_ADDRESSES) {
    const keyFilePath = path.join(keysDir, agentAddress);
    
    if (fs.existsSync(keyFilePath)) {
      try {
        const keyData = JSON.parse(fs.readFileSync(keyFilePath, 'utf-8'));
        const privateKey = keyData.private_key;
        
        console.log(`✅ Found agent key for Master Safe: ${agentAddress}`);
        return { address: agentAddress, privateKey };
      } catch (error) {
        console.log(`⚠️  Could not read key file for ${agentAddress}`);
      }
    }
  }

  console.error('❌ No Master Safe agent key found');
  return null;
}

async function main() {
  console.log('💸 Transfer ETH from Master Safe to Service #164 Safe\n');
  console.log(`From: ${MASTER_SAFE}`);
  console.log(`To: ${SERVICE_SAFE}`);
  console.log(`Amount: ${ethers.formatEther(TRANSFER_AMOUNT)} ETH\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // 1. Check balances
  const masterBalance = await provider.getBalance(MASTER_SAFE);
  const serviceBalance = await provider.getBalance(SERVICE_SAFE);

  console.log('📊 Current Balances:');
  console.log(`  Master Safe: ${ethers.formatEther(masterBalance)} ETH`);
  console.log(`  Service Safe: ${ethers.formatEther(serviceBalance)} ETH\n`);

  if (masterBalance < TRANSFER_AMOUNT) {
    console.error(`❌ Master Safe has insufficient balance`);
    console.error(`   Available: ${ethers.formatEther(masterBalance)} ETH`);
    console.error(`   Needed: ${ethers.formatEther(TRANSFER_AMOUNT)} ETH\n`);
    process.exit(1);
  }

  // 2. Find agent key
  const agentKey = await findAgentKey();
  if (!agentKey) {
    console.error('❌ Cannot proceed without agent key');
    process.exit(1);
  }

  const agentWallet = new ethers.Wallet(agentKey.privateKey, provider);
  const agentBalance = await provider.getBalance(agentKey.address);

  console.log(`\n🔑 Agent Key (will sign transaction):`);
  console.log(`   Address: ${agentKey.address}`);
  console.log(`   Balance: ${ethers.formatEther(agentBalance)} ETH\n`);

  if (agentBalance < ethers.parseEther('0.0001')) {
    console.error(`⚠️  Agent key has very low ETH balance for gas`);
    console.error(`   This transaction may fail due to insufficient gas`);
    console.error(`   Consider funding agent key first\n`);
  }

  // 3. Create Safe transaction
  console.log('📝 Creating Safe transaction...\n');

  const safe = new ethers.Contract(MASTER_SAFE, SAFE_ABI, agentWallet);

  try {
    // Get Safe nonce
    const nonce = await safe.nonce();
    console.log(`Safe nonce: ${nonce}`);

    // Transaction parameters
    const to = SERVICE_SAFE;
    const value = TRANSFER_AMOUNT;
    const data = '0x'; // Empty data for ETH transfer
    const operation = 0; // CALL
    const safeTxGas = 0;
    const baseGas = 0;
    const gasPrice = 0;
    const gasToken = ethers.ZeroAddress;
    const refundReceiver = ethers.ZeroAddress;

    // Get transaction hash to sign
    const txHash = await safe.getTransactionHash(
      to,
      value,
      data,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      nonce
    );

    console.log(`Transaction hash: ${txHash}\n`);

    // Sign the transaction hash (eth_sign format for Safe)
    const signature = await agentWallet.signMessage(ethers.getBytes(txHash));
    // Adjust v for eth_sign format (Safe expects v + 4)
    const sigBytes = ethers.getBytes(signature);
    const v = sigBytes[64];
    const vAdjusted = v + 4;
    const adjustedSig = ethers.concat([
      sigBytes.slice(0, 64),
      new Uint8Array([vAdjusted])
    ]);

    console.log('✍️  Transaction signed\n');

    // 4. Execute Safe transaction
    console.log('🚀 Executing Safe transaction...\n');

    const tx = await safe.execTransaction(
      to,
      value,
      data,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      adjustedSig
    );

    console.log(`Transaction sent: ${tx.hash}`);
    console.log(`Waiting for confirmation...\n`);

    const receipt = await tx.wait();

    if (receipt?.status === 1) {
      console.log('✅ Transfer Successful!\n');

      // Check new balances
      const newMasterBalance = await provider.getBalance(MASTER_SAFE);
      const newServiceBalance = await provider.getBalance(SERVICE_SAFE);

      console.log('📊 New Balances:');
      console.log(`  Master Safe: ${ethers.formatEther(newMasterBalance)} ETH`);
      console.log(`  Service Safe: ${ethers.formatEther(newServiceBalance)} ETH\n`);

      console.log(`💰 Transferred: ${ethers.formatEther(TRANSFER_AMOUNT)} ETH`);
      console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`);
      console.log(`🔗 Transaction: https://basescan.org/tx/${receipt.hash}\n`);

      // Check if Service Safe now has enough for requests
      const needed = ethers.parseEther('0.02');
      if (newServiceBalance >= needed) {
        console.log('✅ Service Safe now has sufficient ETH for marketplace requests!');
        console.log('   Ready to proceed with request submission.\n');
      } else {
        const shortfall = needed - newServiceBalance;
        console.log(`⚠️  Service Safe still needs ${ethers.formatEther(shortfall)} ETH more`);
        console.log('   Consider transferring from Master EOA or external wallet\n');
      }

    } else {
      console.error('❌ Transaction failed');
      process.exit(1);
    }

  } catch (error: any) {
    console.error('❌ Error executing Safe transaction:', error.message);
    
    if (error.message.includes('nonce')) {
      console.error('\n💡 Tip: Safe transaction nonce might be incorrect');
      console.error('   This can happen if there are pending transactions');
    }
    
    if (error.message.includes('signature')) {
      console.error('\n💡 Tip: Signature format might be incorrect');
      console.error('   Try using Safe UI for manual transfer:');
      console.error(`   https://app.safe.global/home?safe=base:${MASTER_SAFE}`);
    }

    process.exit(1);
  }
}

main().catch(console.error);

