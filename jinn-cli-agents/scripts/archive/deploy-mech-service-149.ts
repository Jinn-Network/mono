/**
 * Deploy Mech Contract for Service #149
 * 
 * This script deploys a mech contract for the already-deployed and staked service #149
 * on Base mainnet using direct contract interaction via MechMarketplace.
 * 
 * Part of JINN-196: Deploy mech contract for service #149 through middleware
 */

import { OlasServiceManager } from 'jinn-node/worker/OlasServiceManager.js';
import { OlasOperateWrapper } from 'jinn-node/worker/OlasOperateWrapper.js';

const SERVICE_CONFIG_ID = 'sc-service-149-recovered';
const MIDDLEWARE_PATH = process.env.OLAS_MIDDLEWARE_PATH || './olas-operate-middleware';

async function deployMech() {
  console.log('='.repeat(80));
  console.log('JINN-196: Deploy Mech Contract for Service #149');
  console.log('='.repeat(80));
  console.log();

  try {
    // Verify environment variables
    const requiredEnvVars = [
      'BASE_LEDGER_RPC',
      'OPERATE_PASSWORD'
    ];

    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    console.log('✅ Environment variables validated');
    console.log();

    // Create operate wrapper and service manager
    console.log('📦 Initializing OLAS Service Manager...');
    const operateWrapper = await OlasOperateWrapper.create({
      middlewarePath: MIDDLEWARE_PATH
    });

    const serviceManager = new OlasServiceManager(
      operateWrapper,
      '/tmp/placeholder-config.json', // Placeholder path, not used for direct mech deployment
    );

    console.log(`   Middleware Path: ${MIDDLEWARE_PATH}`);
    console.log(`   Service Config ID: ${SERVICE_CONFIG_ID}`);
    console.log();

    // Check service config exists
    console.log('🔍 Verifying service config exists...');
    const existingServices = await serviceManager.listExistingServices();
    const service149 = existingServices.find(s => s.serviceConfigId === SERVICE_CONFIG_ID);
    
    if (!service149) {
      throw new Error(`Service config ${SERVICE_CONFIG_ID} not found in middleware`);
    }

    console.log('✅ Service config found:');
    console.log(`   Safe Address: ${service149.safeAddress}`);
    console.log(`   Token ID: ${service149.tokenId}`);
    console.log(`   Chain: ${service149.chain}`);
    console.log(`   Agent Address: ${service149.agentAddress}`);
    console.log();

    // Deploy mech directly
    console.log('🚀 Deploying mech contract via MechMarketplace...');
    console.log('   This will:');
    console.log('   1. Load service config from middleware');
    console.log('   2. Check if mech already deployed (idempotent)');
    console.log('   3. Load agent private key');
    console.log('   4. Build Safe transaction for MechMarketplace.create()');
    console.log('   5. Sign transaction with agent key (1/1 Safe signer)');
    console.log('   6. Execute Safe transaction on Base');
    console.log('   7. Wait for transaction confirmation');
    console.log('   8. Parse CreateMech event for mech address');
    console.log('   9. Verify mech contract on BaseScan');
    console.log('   10. Update service config with mech info');
    console.log();

    const result = await serviceManager.deployMechDirect(SERVICE_CONFIG_ID, {
      chain: 'base',
      mechType: 'Native',
      requestPrice: '10000000000000000', // 0.01 ETH
      marketplaceAddress: '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020' // Base mainnet from ai-registry-mech
    });

    console.log();
    console.log('='.repeat(80));
    console.log('✅ MECH DEPLOYMENT SUCCESSFUL');
    console.log('='.repeat(80));
    console.log();
    console.log('Service Information:');
    console.log(`   Service ID: ${result.serviceId}`);
    console.log(`   Service Name: ${result.serviceName}`);
    console.log(`   Mech Address: ${result.mechAddress}`);
    console.log(`   Agent ID: ${result.agentId}`);
    console.log(`   Staked: ${result.isStaked}`);
    console.log(`   Running: ${result.isRunning}`);
    console.log();

    console.log('🔗 Verification Links:');
    console.log(`   Mech Contract: https://basescan.org/address/${result.mechAddress}`);
    console.log(`   Service Safe: ${service149.safeAddress && `https://basescan.org/address/${service149.safeAddress}`}`);
    console.log();

    console.log('📝 Next Steps:');
    console.log('   1. Verify mech contract on BaseScan');
    console.log('   2. Check service config updated with MECH_TO_CONFIG and AGENT_ID');
    console.log('   3. Test mech request/response flow');
    console.log();

  } catch (error) {
    console.error();
    console.error('='.repeat(80));
    console.error('❌ MECH DEPLOYMENT FAILED');
    console.error('='.repeat(80));
    console.error();
    console.error('Error:', error instanceof Error ? error.message : String(error));
    
    if (error instanceof Error && error.stack) {
      console.error();
      console.error('Stack Trace:');
      console.error(error.stack);
    }
    
    process.exit(1);
  }
}

// Run deployment
deployMech().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
