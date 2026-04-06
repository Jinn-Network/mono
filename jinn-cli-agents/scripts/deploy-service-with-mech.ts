#!/usr/bin/env ts-node

/**
 * Deploy OLAS Service with Mech on Base Mainnet
 * 
 * This script deploys a new OLAS service with mech deployment enabled.
 * It will prompt you to fund the Safe when it's created.
 * 
 * Usage:
 *   yarn deploy:service-with-mech
 */

import path from 'path';
import dotenv from 'dotenv';
import { OlasServiceManager } from 'jinn-node/worker/OlasServiceManager.js';
import { OlasOperateWrapper } from 'jinn-node/worker/OlasOperateWrapper.js';
import { createDefaultServiceConfig } from 'jinn-node/worker/config/ServiceConfig.js';
import { promises as fs } from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Mech configuration for Base mainnet
// Use the marketplace address that middleware recognizes for Base
const MECH_CONFIG = {
  MECH_TYPE: 'Native' as const,
  MECH_REQUEST_PRICE: '99', // Must match ecosystem standard (99 wei)
  MECH_MARKETPLACE_ADDRESS: '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020', // Base mainnet
  // Now using CLI instead of HTTP API which has a bug preventing service creation
  DEPLOY_MECH: true
};

async function main() {
  console.log('🚀 OLAS Service Deployment with Mech\n');
  console.log('═'.repeat(60));
  console.log('⚠️  MAINNET DEPLOYMENT');
  console.log('═'.repeat(60));
  console.log('\n📋 Configuration:');
  console.log(`   Chain: Base`);
  console.log(`   Mech Type: ${MECH_CONFIG.MECH_TYPE}`);
  console.log(`   Request Price: ${MECH_CONFIG.MECH_REQUEST_PRICE} wei (0.01 ETH)`);
  console.log(`   Marketplace: ${MECH_CONFIG.MECH_MARKETPLACE_ADDRESS}`);
  console.log('\n');

  try {
    // Validate environment
    if (!process.env.OPERATE_PASSWORD) {
      throw new Error('OPERATE_PASSWORD environment variable is required');
    }

    // Create service config
    const timestamp = Date.now();
    const serviceName = `jinn-mech-service-${timestamp}`;
    const tempDir = `/tmp/${serviceName}`;
    await fs.mkdir(tempDir, { recursive: true });

    const serviceConfig = createDefaultServiceConfig({
      name: serviceName,
      home_chain: 'base'
    });

    // Update RPC URL to Base mainnet
    const baseRpcUrl = process.env.RPC_URL || 'https://mainnet.base.org';
    serviceConfig.configurations.base.rpc = baseRpcUrl;

    const serviceConfigPath = path.join(tempDir, 'service-config.json');
    await fs.writeFile(serviceConfigPath, JSON.stringify(serviceConfig, null, 2));

    console.log(`✅ Service config created: ${serviceConfigPath}\n`);

    // Initialize service manager
    const middlewarePath = path.resolve(process.cwd(), 'olas-operate-middleware');
    const operateWrapper = await OlasOperateWrapper.create({
      middlewarePath,
      rpcUrl: baseRpcUrl
    });

    const serviceManager = new OlasServiceManager(operateWrapper, serviceConfigPath);

    console.log('📦 Deploying service with mech using CLI...\n');
    console.log('⚠️  You will be prompted to fund the Safe when it\'s created\n');

    // Deploy service (mech deployment options removed - API simplified)
    const serviceInfo = await serviceManager.deployAndStakeService();

    // Display results
    console.log('\n' + '═'.repeat(60));
    console.log('✅ DEPLOYMENT SUCCESSFUL');
    console.log('═'.repeat(60));
    console.log(`\n📊 Service Information:`);
    console.log(`   Service Name: ${serviceInfo.serviceName}`);
    console.log(`   Service ID: ${serviceInfo.serviceId}`);
    console.log(`   Config Path: ${serviceInfo.configPath}`);
    console.log(`   Is Staked: ${serviceInfo.isStaked}`);
    console.log(`   Is Running: ${serviceInfo.isRunning}`);
    
    if (serviceInfo.stakingContract) {
      console.log(`   Staking Contract: ${serviceInfo.stakingContract}`);
    }

    if (serviceInfo.mechAddress) {
      console.log(`\n🤖 Mech Deployment:`);
      console.log(`   Mech Address: ${serviceInfo.mechAddress}`);
      console.log(`   Agent ID: ${serviceInfo.agentId}`);
      console.log(`\n🔍 Verify on BaseScan:`);
      console.log(`   https://basescan.org/address/${serviceInfo.mechAddress}`);
    } else {
      console.log(`\n⚠️  Warning: Mech address not found in response`);
    }

    console.log('\n' + '═'.repeat(60));
    console.log('✅ Service deployed and ready to accept mech requests');
    console.log('═'.repeat(60));

    // Cleanup
    await operateWrapper.stopServer();

    process.exit(0);

  } catch (error) {
    console.error('\n❌ Deployment failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
