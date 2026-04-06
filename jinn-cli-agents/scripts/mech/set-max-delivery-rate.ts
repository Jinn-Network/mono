#!/usr/bin/env tsx
/**
 * Set maxDeliveryRate for mech contract via Gnosis Safe transaction
 * 
 * Usage:
 *   yarn tsx scripts/mech/set-max-delivery-rate.ts <newRateInWei>
 * 
 * Example:
 *   yarn tsx scripts/mech/set-max-delivery-rate.ts 99
 * 
 * IMPORTANT: maxDeliveryRate is the payment amount in wei, not time in seconds
 * Current: 5000000000000 wei (0.000005 ETH per delivery)
 * Setting to 99 wei = 0.000000000000000099 ETH per delivery
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { getMechAddress, getServiceSafeAddress, getServicePrivateKey } from 'jinn-node/env/operate-profile.js';

// Minimal ABIs
const MECH_ABI = [
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "newMaxDeliveryRate",
        "type": "uint256"
      }
    ],
    "name": "changeMaxDeliveryRate",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "maxDeliveryRate",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getOperator",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) public view returns (bytes32)',
  'function nonce() public view returns (uint256)',
] as const;

async function setMaxDeliveryRate(newRate: string) {
  // Get configuration from .operate profile
  const mechAddress = getMechAddress();
  if (!mechAddress) {
    console.error('❌ Failed to read mech address from .operate service profile');
    process.exit(1);
  }

  const safeAddress = getServiceSafeAddress();
  if (!safeAddress) {
    console.error('❌ Failed to read Safe address from .operate service profile');
    process.exit(1);
  }

  const agentPrivateKey = getServicePrivateKey();
  if (!agentPrivateKey) {
    console.error('❌ Failed to read agent private key from .operate service profile');
    process.exit(1);
  }

  console.log(`📍 Mech Address: ${mechAddress}`);
  console.log(`🔐 Safe Multisig: ${safeAddress}\n`);

  // Get RPC URL
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('❌ RPC_URL environment variable not set');
    process.exit(1);
  }

  // Setup provider and signer
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const agentWallet = new ethers.Wallet(agentPrivateKey, provider);
  
  console.log(`👤 Agent Key: ${agentWallet.address}\n`);

  // Connect to contracts
  const mechContract = new ethers.Contract(mechAddress, MECH_ABI, provider);
  const safeContract = new ethers.Contract(safeAddress, SAFE_ABI, agentWallet);

  try {
    // 1. Check current value
    console.log('📊 Checking current max delivery rate...');
    const currentRate = await mechContract.maxDeliveryRate();
    console.log(`   Current: ${currentRate.toString()} wei (${ethers.formatEther(currentRate)} ETH)\n`);

    // 2. Verify operator
    console.log('👤 Checking mech operator...');
    const operator = await mechContract.getOperator();
    console.log(`   Operator: ${operator}`);
    
    if (operator.toLowerCase() !== safeAddress.toLowerCase()) {
      console.error(`\n❌ ERROR: Service Safe (${safeAddress}) is NOT the mech operator!`);
      console.error(`   The operator is: ${operator}`);
      console.error(`   Cannot update maxDeliveryRate.`);
      process.exit(1);
    }
    console.log(`   ✅ Safe matches operator\n`);

    // 3. Encode transaction data
    const newRateValue = newRate.trim();
    console.log(`🎯 New max delivery rate: ${newRateValue} wei (${ethers.formatEther(newRateValue)} ETH)\n`);
    
    const iface = new ethers.Interface(MECH_ABI);
    const txData = iface.encodeFunctionData('changeMaxDeliveryRate', [newRateValue]);

    // 4. Get Safe nonce
    console.log('📝 Preparing Safe transaction...');
    const nonce = await safeContract.nonce();
    console.log(`   Safe nonce: ${nonce}\n`);

    // 5. Transaction parameters
    const to = mechAddress;
    const value = 0;
    const operation = 0; // CALL
    const safeTxGas = 0;
    const baseGas = 0;
    const gasPrice = 0;
    const gasToken = ethers.ZeroAddress;
    const refundReceiver = ethers.ZeroAddress;

    // 6. Get transaction hash to sign
    const txHash = await safeContract.getTransactionHash(
      to,
      value,
      txData,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      nonce
    );

    console.log('✍️  Signing transaction...');
    console.log(`   Tx hash: ${txHash}\n`);

    // 7. Sign transaction (eth_sign format for Safe)
    const signature = await agentWallet.signMessage(ethers.getBytes(txHash));
    
    // Adjust v for eth_sign format (Safe expects v + 4)
    const sigBytes = ethers.getBytes(signature);
    const v = sigBytes[64] + 4; // Add 4 for eth_sign marker
    const adjustedSignature = ethers.concat([
      sigBytes.slice(0, 64),
      new Uint8Array([v])
    ]);

    console.log('   ✅ Signature generated\n');

    // 8. Execute Safe transaction
    console.log('🚀 Executing Safe transaction...\n');

    const tx = await safeContract.execTransaction(
      to,
      value,
      txData,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      adjustedSignature
    );

    console.log(`📡 Transaction sent: ${tx.hash}`);
    console.log(`   Waiting for confirmation...\n`);

    const receipt = await tx.wait();

    if (receipt?.status === 1) {
      console.log('✅ SUCCESS! Max delivery rate updated.\n');
      
      // Verify the change
      const newRateOnChain = await mechContract.maxDeliveryRate();
      console.log('📊 Verification:');
      console.log(`   Old: ${currentRate.toString()} wei (${ethers.formatEther(currentRate)} ETH)`);
      console.log(`   New: ${newRateOnChain.toString()} wei (${ethers.formatEther(newRateOnChain)} ETH)`);
      console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
      console.log(`   Block: ${receipt.blockNumber}`);
      console.log(`   Tx: ${receipt.hash}\n`);
      
      console.log('🔍 View on BaseScan:');
      console.log(`   https://basescan.org/tx/${receipt.hash}\n`);
    } else {
      console.error('❌ Transaction failed');
      process.exit(1);
    }

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    if (error.data) {
      console.error('Error data:', error.data);
    }
    throw error;
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const newRate = process.argv[2];
  
  if (!newRate) {
    console.error('Usage: yarn tsx scripts/mech/set-max-delivery-rate.ts <newRateInWei>');
    console.error('Example: yarn tsx scripts/mech/set-max-delivery-rate.ts 99');
    console.error('');
    console.error('IMPORTANT: maxDeliveryRate is a payment amount in wei, not time in seconds');
    console.error('Current: 5000000000000 wei (0.000005 ETH per delivery)');
    console.error('Setting to 99 wei = 0.000000000000000099 ETH per delivery');
    process.exit(1);
  }

  setMaxDeliveryRate(newRate)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { setMaxDeliveryRate };

