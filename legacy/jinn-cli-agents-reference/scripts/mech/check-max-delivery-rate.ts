#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Check the current maxDeliveryRate for a mech contract
 * 
 * Usage:
 *   yarn tsx scripts/mech/check-max-delivery-rate.ts
 * 
 * Reads mech address from .operate service profile
 */

import 'dotenv/config';
import { Web3 } from 'web3';
import { getMechAddress } from 'jinn-node/env/operate-profile.js';

// Minimal ABI for maxDeliveryRate view function
const MECH_ABI = [
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
  }
] as const;

async function checkMaxDeliveryRate() {
  // Get mech address from service profile
  const mechAddress = getMechAddress();
  if (!mechAddress) {
    console.error('❌ Failed to read mech address from .operate service profile');
    process.exit(1);
  }

  console.log(`📍 Mech Address: ${mechAddress}`);

  // Get RPC URL from environment
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('❌ RPC_URL environment variable not set');
    process.exit(1);
  }
  console.log(`🔗 RPC URL: ${rpcUrl}\n`);

  // Connect to contract
  const web3 = new Web3(rpcUrl);
  const contract = new web3.eth.Contract(MECH_ABI as any, mechAddress);

  try {
    // Read maxDeliveryRate
    const maxDeliveryRate = await contract.methods.maxDeliveryRate().call();
    
    console.log('✅ Current Max Delivery Rate:');
    console.log(`   ${maxDeliveryRate.toString()} wei`);
    console.log(`   ${Number(maxDeliveryRate) / 1e18} ETH`);
    console.log(`   ${Number(maxDeliveryRate)} seconds (if interpreted as time)`);
    
    return maxDeliveryRate;
  } catch (error) {
    console.error('❌ Error reading maxDeliveryRate:', error);
    throw error;
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  checkMaxDeliveryRate()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { checkMaxDeliveryRate };

