#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Update the maxDeliveryRate for a mech contract
 * 
 * Usage:
 *   yarn tsx scripts/mech/update-max-delivery-rate.ts <newRate>
 * 
 * Example:
 *   yarn tsx scripts/mech/update-max-delivery-rate.ts 99
 * 
 * Reads mech address and Safe multisig from .operate service profile
 * Submits transaction via Gnosis Safe multisig
 */

import 'dotenv/config';
import { Web3 } from 'web3';
import { getMechAddress, getServiceSafeAddress, getServicePrivateKey } from 'jinn-node/env/operate-profile.js';

// Minimal ABI for changeMaxDeliveryRate function
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

async function updateMaxDeliveryRate(newRate: string) {
  // Get mech address from service profile
  const mechAddress = getMechAddress();
  if (!mechAddress) {
    console.error('❌ Failed to read mech address from .operate service profile');
    process.exit(1);
  }

  // Get Safe address from service profile
  const safeAddress = getServiceSafeAddress();
  if (!safeAddress) {
    console.error('❌ Failed to read Safe address from .operate service profile');
    process.exit(1);
  }

  console.log(`📍 Mech Address: ${mechAddress}`);
  console.log(`🔐 Safe Multisig: ${safeAddress}\n`);

  // Get RPC URL from environment
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('❌ RPC_URL environment variable not set');
    process.exit(1);
  }

  // Connect to contract
  const web3 = new Web3(rpcUrl);
  const contract = new web3.eth.Contract(MECH_ABI as any, mechAddress);

  try {
    // Check current value
    console.log('📊 Checking current max delivery rate...');
    const currentRate = await contract.methods.maxDeliveryRate().call();
    console.log(`   Current: ${currentRate.toString()} wei\n`);

    // Check operator
    console.log('👤 Checking mech operator...');
    const operator = await contract.methods.getOperator().call();
    console.log(`   Operator: ${operator}`);
    
    if (operator.toLowerCase() !== safeAddress.toLowerCase()) {
      console.error(`\n❌ ERROR: Service Safe (${safeAddress}) is NOT the mech operator!`);
      console.error(`   The operator is: ${operator}`);
      console.error(`   You cannot update maxDeliveryRate unless you control the operator address.`);
      process.exit(1);
    }
    console.log(`   ✅ Safe matches operator\n`);

    // Parse new rate
    const newRateValue = newRate.trim();
    console.log(`🎯 New max delivery rate: ${newRateValue} wei\n`);

    // Encode the function call
    const data = contract.methods.changeMaxDeliveryRate(newRateValue).encodeABI();
    
    console.log('📝 Transaction Details:');
    console.log(`   To: ${mechAddress}`);
    console.log(`   Data: ${data}`);
    console.log(`   Value: 0`);
    console.log();

    console.log('⚠️  NEXT STEPS:');
    console.log('   1. This transaction must be submitted via your Gnosis Safe multisig');
    console.log('   2. Go to your Safe dashboard (e.g., https://app.safe.global)');
    console.log('   3. Select "New Transaction" → "Contract Interaction"');
    console.log(`   4. Enter contract address: ${mechAddress}`);
    console.log('   5. Select "changeMaxDeliveryRate" function');
    console.log(`   6. Enter newMaxDeliveryRate: ${newRateValue}`);
    console.log('   7. Sign and execute the transaction');
    console.log();
    console.log('   OR use the Safe Transaction Service API / SDK to propose this transaction');
    console.log();
    
    // Note about programmatic submission
    console.log('📚 For programmatic submission via Safe SDK:');
    console.log('   - Use @safe-global/protocol-kit');
    console.log('   - Create transaction with the encoded data above');
    console.log('   - Submit to Safe Transaction Service');
    console.log('   - Collect required signatures from Safe owners');
    console.log('   - Execute the transaction');
    
  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const newRate = process.argv[2];
  
  if (!newRate) {
    console.error('Usage: yarn tsx scripts/mech/update-max-delivery-rate.ts <newRate>');
    console.error('Example: yarn tsx scripts/mech/update-max-delivery-rate.ts 99');
    process.exit(1);
  }

  updateMaxDeliveryRate(newRate)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { updateMaxDeliveryRate };

