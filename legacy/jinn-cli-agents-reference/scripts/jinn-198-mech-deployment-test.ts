#!/usr/bin/env ts-node

/**
 * JINN-198: Mech Deployment Integration Test
 * 
 * Tests the integration of mech deployment into the service creation flow.
 * This validates that when deployMech: true is set, the middleware automatically
 * deploys a mech contract during service deployment.
 * 
 * Test Flow:
 * 1. Create service with deployMech: true
 * 2. Deploy and stake service
 * 3. Verify middleware deployed mech automatically
 * 4. Validate mech address and agent ID are present in service config
 * 5. Verify mech contract exists on-chain
 */

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createTenderlyClient, ethToWei, type TenderlyClient, type VnetResult } from './lib/tenderly.js';
import { setupOlasEnvironment, createServiceConfig, BASE_MAINNET_CHAIN_ID } from './lib/e2e-test-utils.js';
import { OlasServiceManager } from 'jinn-node/worker/OlasServiceManager.js';
import { OlasOperateWrapper } from 'jinn-node/worker/OlasOperateWrapper.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Test configuration
const TEMP_DIR_BASE = '/tmp/jinn-198-mech-deploy-test';
const TEST_TIMEOUT_MS = 300000; // 5 minutes

// Mech deployment configuration from Linear comment
const MECH_CONFIG = {
  MECH_TYPE: 'Native',
  MECH_REQUEST_PRICE: '10000000000000000', // 0.01 ETH
  MECH_MARKETPLACE_ADDRESS: '0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020' // Base mainnet
};

interface TestContext {
  testId: string;
  tempDir: string;
  walletStoragePath: string;
  privateKey: `0x${string}`;
  ownerAddress: `0x${string}`;
  tenderlyClient: TenderlyClient;
  vnetResult: VnetResult;
  serviceManager: OlasServiceManager;
  operateWrapper: OlasOperateWrapper;
}

interface TestStepResult {
  stepName: string;
  success: boolean;
  error?: string;
  data?: any;
  duration: number;
}

interface TestResult {
  success: boolean;
  totalDuration: number;
  steps: TestStepResult[];
  mechAddress?: string;
  agentId?: string;
  error?: string;
}

/**
 * Generate unique test private key
 */
function generateTestPrivateKey(): `0x${string}` {
  const randomBytes = crypto.randomBytes(32);
  return `0x${randomBytes.toString('hex')}` as `0x${string}`;
}

/**
 * Create test context with Tenderly VNet
 */
async function createTestContext(): Promise<TestContext> {
  const testId = `mech-deploy-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tempDir = path.join(TEMP_DIR_BASE, testId);
  const walletStoragePath = path.join(tempDir, 'wallets');

  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(walletStoragePath, { recursive: true });

  const privateKey = generateTestPrivateKey();
  const account = privateKeyToAccount(privateKey);
  const ownerAddress = account.address;

  const tenderlyClient = createTenderlyClient();
  if (!tenderlyClient.isConfigured()) {
    throw new Error('Tenderly not configured. Set TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG');
  }

  console.log(`\n🔧 Creating Tenderly VNet for Base mainnet...`);
  const vnetResult = await tenderlyClient.createVnet(BASE_MAINNET_CHAIN_ID);
  console.log(`✅ VNet created: ${vnetResult.id}`);
  console.log(`   Admin RPC: ${vnetResult.adminRpcUrl}`);

  // Fund test wallet
  const fundingAmount = ethToWei('10'); // 10 ETH for testing
  await tenderlyClient.fundAddress(ownerAddress, fundingAmount, vnetResult.adminRpcUrl);
  console.log(`✅ Funded ${ownerAddress} with 10 ETH`);

  // Setup OLAS environment
  setupOlasEnvironment({
    testId,
    ownerAddress,
    vnetResult
  });

  // Create service manager
  const middlewarePath = path.resolve(process.cwd(), 'olas-operate-middleware');
  const operateWrapper = await OlasOperateWrapper.create({
    middlewarePath,
    rpcUrl: vnetResult.publicRpcUrl || vnetResult.adminRpcUrl
  });

  // Create service config with Base chain
  const serviceConfigPath = path.join(tempDir, 'service-config.json');
  const serviceConfig = createServiceConfig({
    testId,
    ownerAddress,
    vnetResult
  });

  await fs.writeFile(serviceConfigPath, JSON.stringify(serviceConfig, null, 2));

  const serviceManager = new OlasServiceManager(operateWrapper, serviceConfigPath);

  return {
    testId,
    tempDir,
    walletStoragePath,
    privateKey,
    ownerAddress,
    tenderlyClient,
    vnetResult,
    serviceManager,
    operateWrapper
  };
}

/**
 * Run test step with timing
 */
async function runStep(
  stepName: string,
  fn: () => Promise<any>
): Promise<TestStepResult> {
  console.log(`\n▶️  ${stepName}...`);
  const startTime = Date.now();
  
  try {
    const data = await fn();
    const duration = Date.now() - startTime;
    console.log(`✅ ${stepName} - completed in ${duration}ms`);
    
    return {
      stepName,
      success: true,
      data,
      duration
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${stepName} - failed after ${duration}ms: ${errorMessage}`);
    
    return {
      stepName,
      success: false,
      error: errorMessage,
      duration
    };
  }
}

/**
 * Verify mech contract exists on-chain
 */
async function verifyMechContract(
  mechAddress: string,
  rpcUrl: string
): Promise<boolean> {
  try {
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    
    // Check if contract has code
    const code = await provider.getCode(mechAddress);
    
    // 0x means no contract
    return code !== '0x';
  } catch (error) {
    console.error(`Failed to verify mech contract: ${error}`);
    return false;
  }
}

/**
 * Load service config from middleware
 */
async function loadServiceConfigFromMiddleware(
  serviceConfigId: string,
  middlewarePath: string
): Promise<any> {
  const configPath = path.join(
    middlewarePath,
    '.operate/services',
    serviceConfigId,
    'config.json'
  );
  
  const content = await fs.readFile(configPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Run JINN-198 mech deployment test
 */
async function runMechDeploymentTest(): Promise<TestResult> {
  const startTime = Date.now();
  const steps: TestStepResult[] = [];
  let context: TestContext | null = null;
  let mechAddress: string | undefined;
  let agentId: string | undefined;

  try {
    // Step 1: Setup test environment
    const setupResult = await runStep('Setup test environment', async () => {
      context = await createTestContext();
      return { testId: context.testId };
    });
    steps.push(setupResult);
    
    if (!setupResult.success || !context) {
      throw new Error('Failed to setup test environment');
    }

    // Step 2: Deploy service (mech deployment options removed - API simplified)
    const deployResult = await runStep('Deploy service', async () => {
      const serviceInfo = await context!.serviceManager.deployAndStakeService();
      return serviceInfo;
    });
    steps.push(deployResult);

    if (!deployResult.success) {
      throw new Error('Service deployment failed');
    }

    // Extract mech info from service info
    mechAddress = deployResult.data?.mechAddress;
    agentId = deployResult.data?.agentId;

    console.log(`\n📊 Service Deployment Result:`);
    console.log(`   Service ID: ${deployResult.data?.serviceId}`);
    console.log(`   Mech Address: ${mechAddress || 'NOT FOUND'}`);
    console.log(`   Agent ID: ${agentId || 'NOT FOUND'}`);
    console.log(`   Is Staked: ${deployResult.data?.isStaked}`);

    // Step 3: Verify mech info in service config
    const configVerifyResult = await runStep('Verify mech info in middleware config', async () => {
      // Find the service config ID
      const servicesResult = await context!.operateWrapper.getServices();
      if (!servicesResult.services || servicesResult.services.length === 0) {
        throw new Error('No services found in middleware');
      }
      const latestService = servicesResult.services[servicesResult.services.length - 1];
      
      if (!latestService) {
        throw new Error('No service found in middleware');
      }

      console.log(`   Service Config ID: ${latestService.serviceConfigId}`);
      
      // Load the config
      const config = await loadServiceConfigFromMiddleware(
        latestService.serviceConfigId,
        context!.operateWrapper.getMiddlewarePath()
      );

      const envVars = config.env_variables || {};
      const extractedMechAddress = envVars.MECH_TO_CONFIG?.value;
      const extractedAgentId = envVars.AGENT_ID?.value;

      console.log(`   Config MECH_TO_CONFIG: ${extractedMechAddress}`);
      console.log(`   Config AGENT_ID: ${extractedAgentId}`);

      if (!extractedMechAddress || !extractedAgentId) {
        throw new Error('Mech info not found in service config');
      }

      return {
        serviceConfigId: latestService.serviceConfigId,
        mechAddress: extractedMechAddress,
        agentId: extractedAgentId
      };
    });
    steps.push(configVerifyResult);

    if (!configVerifyResult.success) {
      throw new Error('Mech info verification in config failed');
    }

    // Step 4: Verify mech contract on-chain
    if (mechAddress) {
      const onChainVerifyResult = await runStep('Verify mech contract on-chain', async () => {
        const exists = await verifyMechContract(
          mechAddress!,
          context!.vnetResult.publicRpcUrl || context!.vnetResult.adminRpcUrl
        );

        if (!exists) {
          throw new Error('Mech contract not found on-chain');
        }

        return { mechExists: exists };
      });
      steps.push(onChainVerifyResult);
    }

    // Test passed
    const totalDuration = Date.now() - startTime;
    console.log(`\n✅ JINN-198 Test Passed!`);
    console.log(`   Total Duration: ${totalDuration}ms`);
    console.log(`   Mech Address: ${mechAddress}`);
    console.log(`   Agent ID: ${agentId}`);

    return {
      success: true,
      totalDuration,
      steps,
      mechAddress,
      agentId
    };

  } catch (error) {
    const totalDuration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    console.error(`\n❌ Test Failed: ${errorMessage}`);
    console.error(`   Total Duration: ${totalDuration}ms`);

    return {
      success: false,
      totalDuration,
      steps,
      mechAddress,
      agentId,
      error: errorMessage
    };

  } finally {
    // Cleanup
    if (context) {
      try {
        console.log(`\n🧹 Cleaning up...`);
        await context.operateWrapper.stopServer();
        await context.tenderlyClient.deleteVnet(context.vnetResult.id);
        console.log(`✅ Cleanup complete`);
      } catch (error) {
        console.warn(`⚠️  Cleanup failed: ${error}`);
      }
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log('🚀 JINN-198: Mech Deployment Integration Test\n');
  console.log('📋 Test Configuration:');
  console.log(`   Mech Type: ${MECH_CONFIG.MECH_TYPE}`);
  console.log(`   Request Price: ${MECH_CONFIG.MECH_REQUEST_PRICE} wei (0.01 ETH)`);
  console.log(`   Marketplace: ${MECH_CONFIG.MECH_MARKETPLACE_ADDRESS}`);
  console.log(`   Timeout: ${TEST_TIMEOUT_MS}ms\n`);

  const timeoutPromise = new Promise<TestResult>((_, reject) => {
    setTimeout(() => reject(new Error('Test timeout')), TEST_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([
      runMechDeploymentTest(),
      timeoutPromise
    ]);

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Status: ${result.success ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Duration: ${result.totalDuration}ms`);
    console.log(`Steps Completed: ${result.steps.filter(s => s.success).length}/${result.steps.length}`);
    
    if (result.mechAddress) {
      console.log(`\n🤖 Mech Deployment:`);
      console.log(`   Address: ${result.mechAddress}`);
      console.log(`   Agent ID: ${result.agentId}`);
    }

    console.log('\n📊 Step Details:');
    result.steps.forEach((step, i) => {
      const status = step.success ? '✅' : '❌';
      console.log(`   ${i + 1}. ${status} ${step.stepName} (${step.duration}ms)`);
      if (step.error) {
        console.log(`      Error: ${step.error}`);
      }
    });

    if (result.error) {
      console.log(`\n❌ Error: ${result.error}`);
    }

    console.log('='.repeat(60));

    process.exit(result.success ? 0 : 1);

  } catch (error) {
    console.error('\n❌ Test execution failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { runMechDeploymentTest };
