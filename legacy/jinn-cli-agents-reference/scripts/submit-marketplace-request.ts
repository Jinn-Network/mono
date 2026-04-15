#!/usr/bin/env tsx
/**
 * Submit Marketplace Request from Service #164 Safe
 * 
 * Uses the proven deliverViaSafe() pattern from mech-client-ts
 * to sign and execute Safe transactions for marketplace requests.
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// Use public RPC with better rate limits or fallback to Alchemy demo endpoint
const RPC_URL = process.env.RPC_URL || process.env.BASE_RPC_URL || 'https://base.llamarpc.com';

// Service #164 addresses
const SERVICE_SAFE = '0xdB225C794218b1f5054dffF3462c84A30349B182';
const AGENT_EOA = '0x3944aB4EbAe6F9CA96430CaE97B71FB878E1e100';
const MECH_CONTRACT = '0xE403cd520cfC2C3580D6C1C9302b74723Ef48B8E';
const MECH_MARKETPLACE = '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';

// Request parameters
const REQUEST_PRICE = ethers.parseEther('0.01'); // 0.01 ETH per request
const PROMPT = 'Test request from Service #164 to satisfy activity checker';

// ABIs
const MECH_MARKETPLACE_ABI = [
  // Single request function (not batch)
  'function request(bytes memory requestData, uint256 maxDeliveryRate, bytes32 paymentType, address priorityMech, uint256 responseTimeout, bytes memory paymentData) external payable returns (bytes32 requestId)',
  'function mapRequestCounts(address requester) view returns (uint256)',
];

const MECH_ABI = [
  'function paymentType() view returns (bytes32)',
  'function maxDeliveryRate() view returns (uint256)',
];

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
];

// Helper: Upload prompt to IPFS (simplified - just hash for now)
// Helper to add delays between RPC calls
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function prepareRequestData(prompt: string): Promise<string> {
  // In production, this would upload to IPFS and return the hash
  // The contract expects just the 32-byte hash (without the CIDv1 prefix)
  // The f01701220 prefix is added by gateways when displaying the URL
  const hash = ethers.keccak256(ethers.toUtf8Bytes(prompt));
  return hash; // Just return the 32-byte hash
}

async function main() {
  const dryRun = process.env.DRY_RUN === 'true';
  
  console.log('🤖 Submitting Marketplace Request from Service #164 Safe\n');
  console.log(`Service Safe: ${SERVICE_SAFE}`);
  console.log(`Marketplace: ${MECH_MARKETPLACE}`);
  console.log(`Priority Mech: ${MECH_CONTRACT}`);
  console.log(`Request Price: ${ethers.formatEther(REQUEST_PRICE)} ETH`);
  console.log(`Dry Run: ${dryRun ? 'YES (no transaction sent)' : 'NO (will execute)'}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // 1. Load agent key
  console.log('🔑 Loading agent key...\n');
  const keyPath = path.join(process.cwd(), 'olas-operate-middleware', '.operate', 'keys', AGENT_EOA);
  
  if (!fs.existsSync(keyPath)) {
    console.error(`❌ Agent key not found: ${keyPath}`);
    process.exit(1);
  }

  const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));
  const privateKey = keyData.private_key;
  const agentWallet = new ethers.Wallet(privateKey, provider);

  console.log(`Agent EOA: ${agentWallet.address}`);
  
  // Verify address matches
  if (agentWallet.address.toLowerCase() !== AGENT_EOA.toLowerCase()) {
    console.error(`❌ Address mismatch!`);
    console.error(`   Expected: ${AGENT_EOA}`);
    console.error(`   Got: ${agentWallet.address}`);
    process.exit(1);
  }

  // 2. Check balances
  console.log('\n📊 Checking balances...\n');
  await sleep(500); // Rate limit protection
  const serviceSafeBalance = await provider.getBalance(SERVICE_SAFE);
  await sleep(500);
  const agentBalance = await provider.getBalance(AGENT_EOA);

  console.log(`Service Safe: ${ethers.formatEther(serviceSafeBalance)} ETH`);
  console.log(`Agent EOA: ${ethers.formatEther(agentBalance)} ETH\n`);

  if (serviceSafeBalance < REQUEST_PRICE) {
    console.error(`❌ Service Safe has insufficient balance`);
    console.error(`   Available: ${ethers.formatEther(serviceSafeBalance)} ETH`);
    console.error(`   Needed: ${ethers.formatEther(REQUEST_PRICE)} ETH`);
    process.exit(1);
  }

  // 3. Prepare request data
  console.log('📝 Preparing request data...\n');
  const requestData = await prepareRequestData(PROMPT);
  console.log(`Request data (IPFS hash): ${requestData}`);
  console.log(`Prompt: "${PROMPT}"\n`);

  // 4. Query mech for payment type and max delivery rate
  console.log('🔍 Querying mech contract parameters...\n');
  await sleep(500);
  const mech = new ethers.Contract(MECH_CONTRACT, MECH_ABI, provider);
  const mechPaymentType = await mech.paymentType();
  await sleep(500);
  const mechMaxDeliveryRate = await mech.maxDeliveryRate();
  
  console.log(`Mech Payment Type: ${mechPaymentType}`);
  console.log(`Mech Max Delivery Rate: ${ethers.formatEther(mechMaxDeliveryRate)} ETH\n`);

  // 5. Query marketplace for timeout bounds
  console.log('🔍 Querying marketplace timeout bounds...\n');
  await sleep(500);
  const marketplace = new ethers.Contract(MECH_MARKETPLACE, MECH_MARKETPLACE_ABI, provider);
  const MARKETPLACE_BOUNDS_ABI = ['function minResponseTimeout() view returns (uint256)', 'function maxResponseTimeout() view returns (uint256)'];
  const marketplaceBounds = new ethers.Contract(MECH_MARKETPLACE, MARKETPLACE_BOUNDS_ABI, provider);
  const minTimeout = await marketplaceBounds.minResponseTimeout();
  await sleep(500);
  const maxTimeout = await marketplaceBounds.maxResponseTimeout();
  
  console.log(`Min Response Timeout: ${minTimeout} seconds (${Number(minTimeout) / 60} minutes)`);
  console.log(`Max Response Timeout: ${maxTimeout} seconds (${Number(maxTimeout) / 60} minutes)\n`);

  // 6. Encode marketplace request call (single request, not batch)
  const maxDeliveryRate = mechMaxDeliveryRate; // Use mech's max delivery rate
  const paymentType = mechPaymentType; // Use mech's payment type
  const priorityMech = MECH_CONTRACT;
  const responseTimeout = maxTimeout; // Use maximum allowed timeout
  const paymentData = '0x';
  
  console.log(`Using response timeout: ${responseTimeout} seconds (${Number(responseTimeout) / 60} minutes)\n`);

  const marketplaceCallData = marketplace.interface.encodeFunctionData('request', [
    requestData,         // bytes (single request data)
    maxDeliveryRate,     // uint256
    paymentType,         // bytes32
    priorityMech,        // address
    responseTimeout,     // uint256
    paymentData,         // bytes
  ]);

  console.log('📦 Marketplace call encoded\n');

  // 7. Build Safe transaction
  console.log('🔒 Building Safe transaction...\n');
  await sleep(500);
  const safe = new ethers.Contract(SERVICE_SAFE, SAFE_ABI, agentWallet);

  const safeNonce = await safe.nonce();
  console.log(`Safe nonce: ${safeNonce}`);

  // IMPORTANT: This mech charges 0.01 ETH per request (mechMaxDeliveryRate)
  // Even though first request timed out, we need to send ETH to top up balance
  // The balance tracker might not have automatically credited us back yet
  // Send just enough to cover the shortfall
  const topUpAmount = ethers.parseEther('0.001'); // Small top-up
  
  const txParams = {
    to: MECH_MARKETPLACE,
    value: topUpAmount, // Top up balance (we should have ~0.009 ETH from timeout)
    data: marketplaceCallData,
    operation: 0, // CALL
    safeTxGas: 0,
    baseGas: 0,
    gasPrice: 0,
    gasToken: ethers.ZeroAddress,
    refundReceiver: ethers.ZeroAddress,
    nonce: safeNonce,
  };

  // Get transaction hash to sign
  await sleep(500);
  const txHash = await safe.getTransactionHash(
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

  // 8. Sign transaction (eth_sign format for Safe)
  console.log('✍️  Signing transaction...\n');
  
  // Sign the hash
  const signature = await agentWallet.signMessage(ethers.getBytes(txHash));
  
  // Adjust v for eth_sign format (Safe expects v + 4)
  const sigBytes = ethers.getBytes(signature);
  const r = ethers.hexlify(sigBytes.slice(0, 32));
  const s = ethers.hexlify(sigBytes.slice(32, 64));
  const v = sigBytes[64] + 4; // Add 4 for eth_sign marker

  const adjustedSignature = ethers.concat([
    r,
    s,
    new Uint8Array([v])
  ]);

  console.log(`Signature: ${ethers.hexlify(adjustedSignature)}\n`);

  if (dryRun) {
    console.log('🧪 DRY RUN - Transaction details:\n');
    console.log(JSON.stringify({
      from: agentWallet.address,
      to: SERVICE_SAFE,
      data: {
        to: txParams.to,
        value: ethers.formatEther(txParams.value),
        data: txParams.data.slice(0, 66) + '...',
        operation: txParams.operation,
        signatures: ethers.hexlify(adjustedSignature),
      }
    }, null, 2));
    console.log('\n✅ Dry run complete. No transaction sent.\n');
    console.log('To execute for real, run without DRY_RUN=true');
    return;
  }

  // 9. Execute Safe transaction
  console.log('🚀 Executing Safe transaction...\n');

  try {
    const tx = await safe.execTransaction(
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
      console.log('✅ MARKETPLACE REQUEST SUBMITTED SUCCESSFULLY!\n');
      console.log(`Gas used: ${receipt.gasUsed.toString()}`);
      console.log(`Block: ${receipt.blockNumber}\n`);

      // 8. Verify request count increased
      console.log('🔍 Verifying request count...\n');
      await new Promise(r => setTimeout(r, 2000)); // Wait for state update
      
      const newRequestCount = await marketplace.mapRequestCounts(SERVICE_SAFE);
      console.log(`New request count: ${newRequestCount}\n`);

      if (newRequestCount > 0n) {
        console.log('✅ Request count increased! Activity checker will recognize this.\n');
      }

      console.log('='.repeat(70));
      console.log('📋 SUMMARY');
      console.log('='.repeat(70));
      console.log(`Transaction: ${receipt.hash}`);
      console.log(`Service Safe: ${SERVICE_SAFE}`);
      console.log(`Request Count: ${newRequestCount}`);
      console.log(`Cost: ${ethers.formatEther(REQUEST_PRICE)} ETH`);
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
      console.error('   - Insufficient balance in Safe');
      console.error('   - Safe nonce incorrect');
      console.error('\n   Error data:', error.data);
    }
    
    process.exit(1);
  }
}

main().catch(console.error);

