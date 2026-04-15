#!/usr/bin/env tsx
/**
 * Execute Claim for Service #165 via Master Safe
 * 
 * This script builds and executes a Safe transaction to claim rewards.
 * Uses the same proven deliverViaSafe() pattern from marketplace requests.
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
const RPC_URL = process.env.BASE_LEDGER_RPC || process.env.BASE_RPC_URL || 'https://base.llamarpc.com';

// Master Safe and signers
const MASTER_SAFE = '0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645';

// Service #165
const SERVICE_ID = 165;

// Staking contract
const STAKING_CONTRACT = '0x2585e63df7BD9De8e058884D496658a030b5c6ce'; // AgentsFun1

// ABIs
const STAKING_ABI = [
  'function claim(uint256 serviceId) external returns (uint256)',
  'function getServiceInfo(uint256 serviceId) view returns (tuple(address multisig, address owner, uint256[] nonces, uint256 tsStart, uint256 reward, uint256 inactivity))',
];

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[] memory)',
];

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const dryRun = process.env.DRY_RUN === 'true';
  
  console.log('💰 Execute Claim for Service #165 via Master Safe\n');
  console.log(`Master Safe: ${MASTER_SAFE}`);
  console.log(`Service ID: ${SERVICE_ID}`);
  console.log(`Staking Contract: ${STAKING_CONTRACT}`);
  console.log(`Dry Run: ${dryRun ? 'YES (no transaction sent)' : 'NO (will execute)'}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // 1. Find a signer key from the Master Safe owners
  console.log('🔑 Loading Master Safe signer key...\n');
  
  const masterSafe = new ethers.Contract(MASTER_SAFE, SAFE_ABI, provider);
  const owners = await masterSafe.getOwners();
  const threshold = await masterSafe.getThreshold();
  
  console.log(`Master Safe owners: ${owners.length}`);
  console.log(`Master Safe threshold: ${threshold}`);
  console.log(`Owners: ${owners.join(', ')}\n`);

  // Try to find a key for one of the owners
  let signerWallet: ethers.Wallet | null = null;
  let signerAddress: string | null = null;

  // First, check if MASTER_SAFE_SIGNER_KEY is provided via environment
  if (process.env.MASTER_SAFE_SIGNER_KEY) {
    console.log('✅ Using MASTER_SAFE_SIGNER_KEY from environment\n');
    signerWallet = new ethers.Wallet(process.env.MASTER_SAFE_SIGNER_KEY, provider);
    
    // Verify the signer is an owner
    if (!owners.map(o => o.toLowerCase()).includes(signerWallet.address.toLowerCase())) {
      console.error(`❌ Provided key is not an owner of the Master Safe`);
      console.error(`   Key address: ${signerWallet.address}`);
      console.error(`   Safe owners: ${owners.join(', ')}\n`);
      process.exit(1);
    }
    
    signerAddress = signerWallet.address;
  } else {
    // Try to find a key in middleware
    for (const owner of owners) {
      const keyPath = path.join(process.cwd(), 'olas-operate-middleware', '.operate', 'keys', owner);
      if (fs.existsSync(keyPath)) {
        console.log(`✅ Found key for owner: ${owner}\n`);
        const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
        signerWallet = new ethers.Wallet(keyData.private_key, provider);
        signerAddress = owner;
        break;
      }
    }

    if (!signerWallet || !signerAddress) {
      console.error('❌ No signer key found for Master Safe owners');
      console.error('   Available keys in middleware do not match Safe owners');
      console.error(`   Safe owners: ${owners.join(', ')}\n`);
      console.error('💡 Solution: Provide private key via environment variable:');
      console.error('   MASTER_SAFE_SIGNER_KEY=0x... yarn tsx scripts/execute-claim-via-master-safe-165.ts\n');
      process.exit(1);
    }
  }

  console.log(`Using signer: ${signerWallet.address}`);

  if (Number(threshold) > 1) {
    console.error('❌ This Safe requires multiple signatures');
    console.error(`   Threshold: ${threshold}`);
    console.error('   This script only supports 1-of-N Safes\n');
    console.error('💡 Options:');
    console.error('   1. Use Safe Transaction Service API to propose transaction');
    console.error('   2. Change Safe threshold to 1 temporarily');
    console.error('   3. Use Safe web UI with all required signers\n');
    process.exit(1);
  }

  // 2. Check signer balance
  const signerBalance = await provider.getBalance(signerAddress);
  console.log(`Signer balance: ${ethers.formatEther(signerBalance)} ETH\n`);

  if (signerBalance < ethers.parseEther('0.0001')) {
    console.error(`❌ Signer has insufficient balance for gas`);
    console.error(`   Available: ${ethers.formatEther(signerBalance)} ETH`);
    console.error(`   Recommended: At least 0.0001 ETH`);
    process.exit(1);
  }

  // 3. Get service info and verify reward
  console.log('📊 Checking service info...\n');
  const stakingContract = new ethers.Contract(STAKING_CONTRACT, STAKING_ABI, provider);
  const serviceInfo = await stakingContract.getServiceInfo(SERVICE_ID);

  console.log(`Service Owner: ${serviceInfo.owner}`);
  console.log(`Service Multisig: ${serviceInfo.multisig}`);
  console.log(`Reward Available: ${ethers.formatEther(serviceInfo.reward)} OLAS\n`);

  if (serviceInfo.reward === 0n) {
    console.error('❌ No rewards to claim!');
    console.error('   Call checkpoint() first\n');
    process.exit(1);
  }

  if (serviceInfo.owner.toLowerCase() !== MASTER_SAFE.toLowerCase()) {
    console.error(`❌ Service owner mismatch!`);
    console.error(`   Expected: ${MASTER_SAFE}`);
    console.error(`   Got: ${serviceInfo.owner}`);
    process.exit(1);
  }

  // 4. Encode claim() call
  console.log('📦 Encoding claim transaction...\n');
  const claimCallData = stakingContract.interface.encodeFunctionData('claim', [SERVICE_ID]);
  console.log(`Claim call data: ${claimCallData.slice(0, 66)}...\n`);

  // 5. Build Safe transaction
  console.log('🔒 Building Safe transaction...\n');
  await sleep(500);
  const safeNonce = await masterSafe.nonce();
  console.log(`Safe nonce: ${safeNonce}`);

  const txParams = {
    to: STAKING_CONTRACT,
    value: 0n,
    data: claimCallData,
    operation: 0, // CALL
    safeTxGas: 0,
    baseGas: 0,
    gasPrice: 0,
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
    nonce: safeNonce,
  };

  // 6. Get transaction hash to sign
  await sleep(500);
  const txHash = await masterSafe.getTransactionHash(
    txParams.to,
    txParams.value,
    txParams.data,
    txParams.operation,
    txParams.safeTxGas,
    txParams.baseGas,
    txParams.gasPrice,
    txParams.gasToken,
    txParams.refundReceiver,
    txParams.nonce
  );

  console.log(`Transaction hash: ${txHash}\n`);

  // 7. Sign transaction (eth_sign format for Safe)
  console.log('✍️  Signing transaction...\n');
  
  const signature = await signerWallet.signMessage(ethers.getBytes(txHash));
  
  // Adjust v for eth_sign format (Safe expects v + 4)
  const sigBytes = ethers.getBytes(signature);
  const r = ethers.hexlify(sigBytes.slice(0, 32));
  const s = ethers.hexlify(sigBytes.slice(32, 64));
  const v = sigBytes[64] + 4; // Add 4 for eth_sign marker

  const adjustedSignature = ethers.concat([r, s, new Uint8Array([v])]);

  console.log(`Signature: ${ethers.hexlify(adjustedSignature).slice(0, 66)}...\n`);

  if (dryRun) {
    console.log('🧪 DRY RUN - Transaction details:\n');
    console.log(JSON.stringify({
      from: signerWallet.address,
      to: MASTER_SAFE,
      data: {
        to: txParams.to,
        value: '0',
        data: txParams.data.slice(0, 66) + '...',
        operation: txParams.operation,
        signatures: ethers.hexlify(adjustedSignature).slice(0, 66) + '...',
      }
    }, null, 2));
    console.log('\n✅ Dry run complete. No transaction sent.\n');
    console.log('To execute for real, run without DRY_RUN=true');
    return;
  }

  // 8. Execute Safe transaction
  console.log('🚀 Executing Safe transaction...\n');

  const safeWithSigner = new ethers.Contract(MASTER_SAFE, SAFE_ABI, signerWallet);

  try {
    const tx = await safeWithSigner.execTransaction(
      txParams.to,
      txParams.value,
      txParams.data,
      txParams.operation,
      txParams.safeTxGas,
      txParams.baseGas,
      txParams.gasPrice,
      txParams.gasToken,
      txParams.refundReceiver,
      adjustedSignature
    );

    console.log(`Transaction sent: ${tx.hash}`);
    console.log(`View on BaseScan: https://basescan.org/tx/${tx.hash}\n`);
    console.log('⏳ Waiting for confirmation...\n');

    const receipt = await tx.wait();

    if (receipt?.status === 1) {
      console.log('✅ REWARDS CLAIMED SUCCESSFULLY!\n');
      console.log(`Gas used: ${receipt.gasUsed.toString()}`);
      console.log(`Block: ${receipt.blockNumber}\n`);

      // Wait for state update
      await sleep(2000);

      // Verify claim
      const updatedServiceInfo = await stakingContract.getServiceInfo(SERVICE_ID);
      console.log('💰 Verification:');
      console.log(`   Remaining reward: ${ethers.formatEther(updatedServiceInfo.reward)} OLAS`);
      console.log(`   Claimed: ~${ethers.formatEther(serviceInfo.reward)} OLAS`);
      console.log(`   Sent to: ${serviceInfo.multisig} (Service Safe)\n`);

      console.log('='.repeat(70));
      console.log('📋 SUMMARY');
      console.log('='.repeat(70));
      console.log(`Transaction: ${receipt.hash}`);
      console.log(`Service ID: ${SERVICE_ID}`);
      console.log(`Rewards Claimed: ~${ethers.formatEther(serviceInfo.reward)} OLAS`);
      console.log(`Recipient: ${serviceInfo.multisig}`);
      console.log(`Gas Used: ${receipt.gasUsed.toString()}`);
      console.log('='.repeat(70) + '\n');

    } else {
      console.error('❌ Transaction failed');
      process.exit(1);
    }

  } catch (error: any) {
    console.error('❌ Error executing Safe transaction:', error.message);
    
    if (error.code === 'CALL_EXCEPTION') {
      console.error('\n💡 Common issues:');
      console.error('   - Signature format incorrect (GS026)');
      console.error('   - Safe nonce incorrect');
      console.error('   - Threshold requires multiple signatures');
      console.error('\n   Error data:', error.data);
    }
    
    process.exit(1);
  }
}

main().catch(console.error);

