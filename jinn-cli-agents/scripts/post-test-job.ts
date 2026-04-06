#!/usr/bin/env tsx
/**
 * Post Test Job to Mech Marketplace
 * 
 * Submits a simple test request to the marketplace that will be picked up
 * by the running mech worker.
 * 
 * Usage:
 *   yarn post:job                    # Default: "What is 2+2?"
 *   yarn post:job "Custom prompt"    # Custom prompt
 */

import '../env/index.js';
import { readServiceConfig } from 'jinn-node/worker/ServiceConfigReader.js';
import { submitMarketplaceRequest, loadAgentPrivateKey } from 'jinn-node/worker/MechMarketplaceRequester.js';
import { join } from 'path';

const MIDDLEWARE_PATH = process.env.MIDDLEWARE_PATH || join(process.cwd(), 'olas-operate-middleware');
const RPC_URL = process.env.RPC_URL || process.env.BASE_RPC_URL || 'https://base.llamarpc.com';
const MECH_MARKETPLACE_ADDRESS = process.env.MECH_MARKETPLACE_ADDRESS_BASE || '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';

async function main() {
  // Get prompt from CLI or use default
  const prompt = process.argv[2] || 'What is 2+2? Please explain the calculation step by step.';
  
  console.log('📮 Posting Test Job to Mech Marketplace\n');
  console.log('='.repeat(70));
  
  // Read service config (auto-discovers latest service)
  console.log('📋 Reading service configuration...\n');
  const serviceInfo = await readServiceConfig(MIDDLEWARE_PATH);
  
  if (!serviceInfo) {
    console.error('❌ No service found');
    console.error('   Run: yarn setup:service --chain=base --with-mech\n');
    process.exit(1);
  }
  
  console.log(`✅ Using service: ${serviceInfo.serviceName}`);
  console.log(`   Safe: ${serviceInfo.serviceSafeAddress}`);
  console.log(`   Mech: ${serviceInfo.mechContractAddress}\n`);
  
  // Validate
  if (!serviceInfo.serviceSafeAddress || !serviceInfo.mechContractAddress) {
    console.error('❌ Service not fully configured');
    console.error('   Missing Safe address or Mech contract\n');
    process.exit(1);
  }
  
  // Load agent key
  console.log('🔑 Loading agent private key...\n');
  const agentPrivateKey = await loadAgentPrivateKey(MIDDLEWARE_PATH, serviceInfo.agentEoaAddress!);
  
  if (!agentPrivateKey) {
    console.error('❌ Failed to load agent private key\n');
    process.exit(1);
  }
  
  // Submit request
  console.log('='.repeat(70));
  console.log('SUBMITTING REQUEST');
  console.log('='.repeat(70));
  console.log(`Prompt: "${prompt}"`);
  console.log(`To Mech: ${serviceInfo.mechContractAddress}`);
  console.log(`From Safe: ${serviceInfo.serviceSafeAddress}\n`);
  
  try {
    const result = await submitMarketplaceRequest({
      prompt,
      mechContractAddress: serviceInfo.mechContractAddress!,
      serviceSafeAddress: serviceInfo.serviceSafeAddress!,
      agentEoaPrivateKey: agentPrivateKey,
      mechMarketplaceAddress: MECH_MARKETPLACE_ADDRESS,
      rpcUrl: RPC_URL,
    });
    
    console.log('='.repeat(70));
    console.log('✅ REQUEST SUBMITTED SUCCESSFULLY');
    console.log('='.repeat(70));
    console.log(`Transaction Hash: ${result.transactionHash}`);
    console.log(`Block Number: ${result.blockNumber}`);
    console.log(`Gas Used: ${result.gasUsed}`);
    
    console.log('\n📊 Next Steps:');
    console.log('   1. Watch your mech worker logs for pickup');
    console.log('   2. Worker will process and deliver response');
    console.log('   3. Check Ponder for indexed request/delivery\n');
    
    console.log('🔍 Monitor:');
    console.log(`   Ponder GraphQL: http://localhost:42070/graphql`);
    console.log(`   BaseScan: https://basescan.org/tx/${result.transactionHash}\n`);
    
  } catch (error: any) {
    console.error('\n❌ REQUEST FAILED');
    console.error('='.repeat(70));
    console.error(error.message || error);
    console.error('\n💡 Common issues:');
    console.error('   - Insufficient ETH in Safe for gas');
    console.error('   - Insufficient ETH in Safe for request price');
    console.error('   - RPC connection issues');
    console.error('   - Agent key not authorized on Safe\n');
    process.exit(1);
  }
}

main();

