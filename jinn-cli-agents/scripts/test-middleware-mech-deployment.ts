// @ts-nocheck
/**
 * Test Mech Deployment via Middleware for Service #149
 * 
 * Tests the middleware's built-in deployMechForExistingService() method
 * which now supports Base chain after adding factory addresses.
 */

import { OlasServiceManager } from 'jinn-node/worker/OlasServiceManager.js';
import { OlasOperateWrapper } from 'jinn-node/worker/OlasOperateWrapper.js';

const SERVICE_CONFIG_ID = 'sc-service-149-recovered';
const MIDDLEWARE_PATH = process.env.OLAS_MIDDLEWARE_PATH || './olas-operate-middleware';

async function testMechDeployment() {
  console.log('='.repeat(80));
  console.log('JINN-196: Deploy Mech via Middleware for Service #149');
  console.log('='.repeat(80));
  console.log();

  try {
    // Verify environment
    const requiredEnvVars = ['BASE_LEDGER_RPC', 'OPERATE_PASSWORD'];
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    console.log('✅ Environment variables validated');
    console.log();

    // Initialize
    console.log('📦 Initializing OLAS Service Manager...');
    const operateWrapper = await OlasOperateWrapper.create({
      middlewarePath: MIDDLEWARE_PATH
    });

    const serviceManager = new OlasServiceManager(
      operateWrapper,
      '/tmp/placeholder-config.json'
    );

    console.log(`   Middleware Path: ${MIDDLEWARE_PATH}`);
    console.log(`   Service Config ID: ${SERVICE_CONFIG_ID}`);
    console.log();

    // Verify service exists
    console.log('🔍 Verifying service config...');
    const services = await serviceManager.listExistingServices();
    const service149 = services.find(s => s.serviceConfigId === SERVICE_CONFIG_ID);
    
    if (!service149) {
      throw new Error(`Service ${SERVICE_CONFIG_ID} not found`);
    }

    console.log('✅ Service found:');
    console.log(`   Safe: ${service149.safeAddress}`);
    console.log(`   Token ID: ${service149.tokenId}`);
    console.log(`   Chain: ${service149.chain}`);
    console.log();

    // Deploy mech using middleware
    console.log('🚀 Deploying mech via middleware...');
    console.log('   Using middleware\'s EthSafeTxBuilder for Safe transactions');
    console.log('   Factory addresses loaded from updated MECH_FACTORY_ADDRESS config');
    console.log();

    const result = await serviceManager.deployMechForExistingService(SERVICE_CONFIG_ID);

    console.log();
    console.log('='.repeat(80));
    console.log('✅ MECH DEPLOYMENT SUCCESSFUL');
    console.log('='.repeat(80));
    console.log();
    console.log('Results:');
    console.log(`   Service ID: ${result.serviceId}`);
    console.log(`   Mech Address: ${result.mechAddress}`);
    console.log(`   Agent ID: ${result.agentId}`);
    console.log(`   Staked: ${result.isStaked}`);
    console.log();
    console.log('🔗 Verification:');
    console.log(`   Mech: https://basescan.org/address/${result.mechAddress}`);
    console.log(`   Safe: https://basescan.org/address/${service149.safeAddress}`);
    console.log();

  } catch (error) {
    console.error();
    console.error('='.repeat(80));
    console.error('❌ DEPLOYMENT FAILED');
    console.error('='.repeat(80));
    console.error();
    console.error('Error:', error instanceof Error ? error.message : String(error));
    
    if (error instanceof Error && error.stack) {
      console.error();
      console.error('Stack:');
      console.error(error.stack);
    }
    
    process.exit(1);
  }
}

testMechDeployment().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
