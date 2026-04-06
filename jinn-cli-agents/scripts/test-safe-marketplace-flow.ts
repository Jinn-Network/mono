#!/usr/bin/env tsx
/**
 * Test Safe-based Mech Marketplace Request/Deliver Flow
 * 
 * Validates end-to-end Safe-based marketplace interactions:
 * 1. Read service config from middleware
 * 2. Submit marketplace request via Safe
 * 3. Worker delivers via Safe (manual verification)
 * 
 * JINN-209: Implement Safe-based Mech Marketplace Request/Deliver Flow
 */

import '../env/index.js';
import { readServiceConfig, listServiceConfigs } from 'jinn-node/worker/ServiceConfigReader.js';
import { submitMarketplaceRequest, loadAgentPrivateKey } from 'jinn-node/worker/MechMarketplaceRequester.js';
import { join } from 'path';

const MIDDLEWARE_PATH = process.env.MIDDLEWARE_PATH || join(process.cwd(), 'olas-operate-middleware');
const RPC_URL = process.env.RPC_URL || process.env.BASE_RPC_URL || 'https://base.llamarpc.com';
const MECH_MARKETPLACE_ADDRESS = process.env.MECH_MARKETPLACE_ADDRESS_BASE || '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020';

async function main() {
  console.log('🧪 Testing Safe-based Mech Marketplace Flow\n');
  console.log('=' .repeat(70));
  console.log('CONFIGURATION');
  console.log('='.repeat(70));
  console.log(`Middleware Path: ${MIDDLEWARE_PATH}`);
  console.log(`RPC URL: ${RPC_URL}`);
  console.log(`Marketplace: ${MECH_MARKETPLACE_ADDRESS}\n`);
  
  // Step 1: List available services
  console.log('📋 Step 1: Reading service configurations...\n');
  const services = await listServiceConfigs(MIDDLEWARE_PATH);
  
  if (services.length === 0) {
    console.error('❌ No services found in middleware directory');
    console.error('   Run interactive-service-setup.ts first to create a service\n');
    process.exit(1);
  }
  
  console.log(`Found ${services.length} service(s):\n`);
  services.forEach((service, idx) => {
    console.log(`  ${idx + 1}. ${service.serviceName} (${service.serviceConfigId})`);
    console.log(`     Safe: ${service.serviceSafeAddress || 'N/A'}`);
    console.log(`     Agent: ${service.agentEoaAddress || 'N/A'}`);
    console.log(`     Mech: ${service.mechContractAddress || 'N/A'}`);
    console.log(`     Service ID: ${service.serviceId || 'N/A'}`);
    console.log(`     Chain: ${service.chain}`);
    console.log('');
  });
  
  // Step 2: Use latest service (or specific one from env)
  const targetServiceId = process.env.SERVICE_CONFIG_ID;
  const selectedService = targetServiceId 
    ? services.find(s => s.serviceConfigId === targetServiceId)
    : services[0];
  
  if (!selectedService) {
    console.error(`❌ Service not found: ${targetServiceId}\n`);
    process.exit(1);
  }
  
  console.log('=' .repeat(70));
  console.log('SELECTED SERVICE');
  console.log('='.repeat(70));
  console.log(`Name: ${selectedService.serviceName}`);
  console.log(`Config ID: ${selectedService.serviceConfigId}`);
  console.log(`Safe Address: ${selectedService.serviceSafeAddress}`);
  console.log(`Agent EOA: ${selectedService.agentEoaAddress}`);
  console.log(`Mech Contract: ${selectedService.mechContractAddress}`);
  console.log(`Chain: ${selectedService.chain}\n`);
  
  // Validate required fields
  if (!selectedService.serviceSafeAddress) {
    console.error('❌ Service Safe address not found');
    console.error('   Service may not be deployed yet\n');
    process.exit(1);
  }
  
  if (!selectedService.agentEoaAddress) {
    console.error('❌ Agent EOA address not found');
    console.error('   Service may not be fully configured\n');
    process.exit(1);
  }
  
  if (!selectedService.mechContractAddress) {
    console.error('❌ Mech contract address not found');
    console.error('   Service may not have mech deployed');
    console.error('   Run with deployMech: true in service setup\n');
    process.exit(1);
  }
  
  // Step 3: Load agent private key
  console.log('🔑 Step 2: Loading agent private key...\n');
  const agentPrivateKey = await loadAgentPrivateKey(MIDDLEWARE_PATH, selectedService.agentEoaAddress);
  
  if (!agentPrivateKey) {
    console.error('❌ Failed to load agent private key');
    console.error(`   Expected path: ${MIDDLEWARE_PATH}/.operate/keys/${selectedService.agentEoaAddress}\n`);
    process.exit(1);
  }
  
  console.log('✅ Agent private key loaded\n');
  
  // Step 4: Submit marketplace request
  const testPrompt = process.env.TEST_PROMPT || 'Test request from Safe-based marketplace flow (JINN-209)';
  
  console.log('=' .repeat(70));
  console.log('MARKETPLACE REQUEST');
  console.log('='.repeat(70));
  console.log(`Prompt: "${testPrompt}"`);
  console.log(`From Safe: ${selectedService.serviceSafeAddress}`);
  console.log(`To Mech: ${selectedService.mechContractAddress}`);
  console.log(`Marketplace: ${MECH_MARKETPLACE_ADDRESS}\n`);
  
  const dryRun = process.env.DRY_RUN === 'true';
  if (dryRun) {
    console.log('🧪 DRY RUN MODE - No transaction will be sent\n');
    console.log('✅ Configuration validated successfully');
    console.log('\nTo execute for real, run without DRY_RUN=true\n');
    return;
  }
  
  console.log('🚀 Submitting request...\n');
  
  const result = await submitMarketplaceRequest({
    serviceSafeAddress: selectedService.serviceSafeAddress,
    agentEoaPrivateKey: agentPrivateKey,
    mechContractAddress: selectedService.mechContractAddress,
    mechMarketplaceAddress: MECH_MARKETPLACE_ADDRESS,
    prompt: testPrompt,
    rpcUrl: RPC_URL,
  });
  
  if (!result.success) {
    console.error('❌ MARKETPLACE REQUEST FAILED\n');
    console.error(`Error: ${result.error}\n`);
    process.exit(1);
  }
  
  console.log('✅ MARKETPLACE REQUEST SUCCESSFUL!\n');
  console.log('='.repeat(70));
  console.log('TRANSACTION DETAILS');
  console.log('='.repeat(70));
  console.log(`Transaction Hash: ${result.transactionHash}`);
  console.log(`Block Number: ${result.blockNumber}`);
  console.log(`Gas Used: ${result.gasUsed}`);
  console.log(`View on BaseScan: https://basescan.org/tx/${result.transactionHash}\n`);
  
  console.log('='.repeat(70));
  console.log('NEXT STEPS');
  console.log('='.repeat(70));
  console.log('1. Wait for request to be indexed by Ponder');
  console.log('2. Mech worker will detect and process the request');
  console.log('3. Worker will deliver via Safe using deliverViaSafe()');
  console.log('4. Check Control API for job reports\n');
  
  console.log('📊 Monitor with:');
  console.log(`   pnpm tsx scripts/query-mech-requests.ts --mech ${selectedService.mechContractAddress}`);
  console.log(`   curl http://localhost:3000/api/jobs/${result.requestId}\n`);
}

main().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});

