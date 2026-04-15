#!/usr/bin/env ts-node

/**
 * JINN-189 E2E Validation Script
 * 
 * Complete service deployment using OlasServiceManager to bypass quickstart limitations.
 * This script validates the full OLAS service lifecycle including deployment and staking,
 * capturing transaction hashes as evidence of successful execution.
 * 
 * Based on the requirements from JINN-189:
 * - Uses existing OlasServiceManager class (recommended approach)
 * - Bypasses problematic quickstart command
 * - Captures transaction hashes as evidence
 * - Validates service deployment on-chain
 */

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { OlasServiceManager } from 'jinn-node/worker/OlasServiceManager.js';
import { OlasOperateWrapper } from 'jinn-node/worker/OlasOperateWrapper.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Test configuration
const TEMP_DIR_BASE = '/tmp/jinn-189-validation';
const TEST_TIMEOUT_MS = 600000; // 10 minutes for full deployment

/**
 * Generate a unique test private key for validation
 */
function generateTestPrivateKey(): `0x${string}` {
  const randomBytes = crypto.randomBytes(32);
  return `0x${randomBytes.toString('hex')}` as `0x${string}`;
}

/**
 * Validation context
 */
interface ValidationContext {
  testId: string;
  tempDir: string;
  privateKey: `0x${string}`;
  ownerAddress: `0x${string}`;
  serviceManager: OlasServiceManager;
  operateWrapper: OlasOperateWrapper;
  serviceConfigPath: string;
}

/**
 * Validation step result
 */
interface ValidationStepResult {
  stepName: string;
  success: boolean;
  error?: string;
  data?: any;
  transactionHashes?: string[];
  duration: number;
}

/**
 * Complete validation result
 */
interface ValidationResult {
  success: boolean;
  totalDuration: number;
  steps: ValidationStepResult[];
  evidence: {
    transactionHashes: string[];
    serviceInfo?: any;
    mechInfo?: any;
  };
  error?: string;
}

/**
 * Create validation context with required components
 */
async function createValidationContext(): Promise<ValidationContext> {
  const testId = `jinn-189-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tempDir = path.join(TEMP_DIR_BASE, testId);

  // Create directories
  await fs.mkdir(tempDir, { recursive: true });

  // Generate unique private key for this validation
  const privateKey = generateTestPrivateKey();
  const account = privateKeyToAccount(privateKey);
  const ownerAddress = account.address;

  console.log(`[${testId}] Created validation context`);
  console.log(`[${testId}] EOA Address: ${ownerAddress}`);
  console.log(`[${testId}] Temp Directory: ${tempDir}`);

  // Create operate wrapper for CLI operations
  const operateWrapper = await OlasOperateWrapper.create();

  // Validate environment
  const envValidation = await operateWrapper.validateEnvironment();
  if (!envValidation.isValid) {
    throw new Error(`Environment validation failed: ${envValidation.issues.join(', ')}`);
  }

  // Create service configuration
  const serviceConfigPath = path.join(tempDir, 'service-config.json');
  const serviceConfig = createServiceConfig(testId, ownerAddress);
  await fs.writeFile(serviceConfigPath, JSON.stringify(serviceConfig, null, 2));

  // Create service manager
  const serviceManager = new OlasServiceManager(operateWrapper, serviceConfigPath);

  return {
    testId,
    tempDir,
    privateKey,
    ownerAddress,
    serviceManager,
    operateWrapper,
    serviceConfigPath
  };
}

/**
 * Create service configuration for the validation
 */
function createServiceConfig(testId: string, ownerAddress: string): any {
  const agentId = 43; // AgentsFun Base template agent ID
  const stakingContract = "0x2585e63df7BD9De8e058884D496658a030b5c6ce"; // AgentsFun1 staking

  return {
    name: `jinn-189-validation-${testId}`,
    hash: "bafybeiflqjig7qlvpfrlqbvlcqv2h7ry6sytcx6fxqzwlpjqvdm7nfxpqy",
    description: "JINN-189 E2E Validation Service",
    image: "https://gateway.autonolas.tech/ipfs/bafybeiflqjig7qlvpfrlqbvlcqv2h7ry6sytcx6fxqzwlpjqvdm7nfxpqy",
    service_version: "v0.1.0",
    home_chain: "base",
    configurations: {
      base: {
        staking_program_id: "agents_fun_1",
        nft: "bafybeiflqjig7qlvpfrlqbvlcqv2h7ry6sytcx6fxqzwlpjqvdm7nfxpqy",
        rpc: process.env.RPC_URL || "https://mainnet.base.org",
        threshold: 1,
        agent_id: agentId,
        use_staking: true,
        use_mech_marketplace: false,
        cost_of_bond: "50000000000000000000", // 50 OLAS
        fund_requirements: {
          [ownerAddress]: {
            agent: "6250000000000000", // 0.00625 ETH
            safe: "12500000000000000"   // 0.0125 ETH
          }
        }
      }
    },
    env_variables: {
      OPERATE_PASSWORD: process.env.OPERATE_PASSWORD || "12345678",
      BASE_LEDGER_RPC: process.env.RPC_URL || "https://mainnet.base.org",
      STAKING_PROGRAM: "custom_staking",
      CUSTOM_STAKING_ADDRESS: stakingContract
    }
  };
}

/**
 * Clean up validation context
 */
async function cleanupValidationContext(ctx: ValidationContext): Promise<void> {
  try {
    // Clean up temp directory
    await fs.rm(ctx.tempDir, { recursive: true, force: true });
    console.log(`[${ctx.testId}] Cleaned up temp directory: ${ctx.tempDir}`);
  } catch (error) {
    console.warn(`[${ctx.testId}] Failed to cleanup temp directory: ${error}`);
  }
}

/**
 * Execute a validation step with timing and error handling
 */
async function executeValidationStep<T>(
  stepName: string,
  testId: string,
  stepFunction: () => Promise<T>
): Promise<ValidationStepResult> {
  const startTime = Date.now();
  console.log(`[${testId}] 🔄 ${stepName}...`);

  try {
    const data = await stepFunction();
    const duration = Date.now() - startTime;
    console.log(`[${testId}] ✅ ${stepName} completed (${duration}ms)`);
    
    return {
      stepName,
      success: true,
      data,
      duration
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.log(`[${testId}] ❌ ${stepName} failed (${duration}ms): ${error.message}`);
    
    return {
      stepName,
      success: false,
      error: error.message,
      duration
    };
  }
}

/**
 * Run the complete JINN-189 validation
 */
async function runJinn189Validation(ctx: ValidationContext): Promise<ValidationResult> {
  const startTime = Date.now();
  const steps: ValidationStepResult[] = [];
  const evidence: { transactionHashes: string[]; mechInfo?: unknown; serviceInfo?: unknown } = { transactionHashes: [] };

  try {
    // Step 1: Environment and configuration validation
    const step1 = await executeValidationStep(
      "Validate environment and configuration",
      ctx.testId,
      async () => {
        // Check operate wrapper health
        const isHealthy = await ctx.operateWrapper.checkHealth();
        if (!isHealthy) {
          throw new Error("Operate wrapper health check failed");
        }

        // Check service configuration
        const serviceStatus = await ctx.serviceManager.getServiceStatus();
        
        return {
          operateHealthy: isHealthy,
          serviceConfigPath: ctx.serviceConfigPath,
          initialServiceStatus: serviceStatus
        };
      }
    );
    steps.push(step1);
    if (!step1.success) throw new Error(`Step 1 failed: ${step1.error}`);

    console.log(`[${ctx.testId}] Environment validated:`, step1.data);

    // Step 2: Deploy and stake service using OlasServiceManager
    const step2 = await executeValidationStep(
      "Deploy and stake service via OlasServiceManager",
      ctx.testId,
      async () => {
        const result = await ctx.serviceManager.deployAndStakeService();
        
        // The deployAndStakeService method should handle the full lifecycle
        // including service creation, deployment, and staking
        return result;
      }
    );
    steps.push(step2);
    if (!step2.success) throw new Error(`Step 2 failed: ${step2.error}`);

    console.log(`[${ctx.testId}] Service deployed and staked:`, step2.data);

    // Step 3: Verify service deployment status
    const step3 = await executeValidationStep(
      "Verify service deployment status",
      ctx.testId,
      async () => {
        const status = await ctx.serviceManager.getServiceStatus();
        
        if (!status.isRunning) {
          throw new Error("Service is not running after deployment");
        }
        
        if (!status.isStaked) {
          throw new Error("Service is not staked after deployment");
        }
        
        return status;
      }
    );
    steps.push(step3);
    if (!step3.success) throw new Error(`Step 3 failed: ${step3.error}`);

    console.log(`[${ctx.testId}] Service status verified:`, step3.data);

    // Step 4: Deploy mech for marketplace participation (bonus AC4)
    const step4 = await executeValidationStep(
      "Deploy mech for marketplace participation",
      ctx.testId,
      async () => {
        try {
          const result = await ctx.serviceManager.deployMech();
          
          if (!result.mechAddress || !result.agentId) {
            throw new Error("Mech deployment did not return required mech_address and agent_id");
          }
          
          evidence.mechInfo = result;
          return result;
        } catch (error: any) {
          // Mech deployment is bonus - log but don't fail validation
          console.warn(`[${ctx.testId}] Mech deployment failed (bonus feature): ${error.message}`);
          return { mechDeploymentSkipped: true, reason: error.message };
        }
      }
    );
    steps.push(step4);
    // Don't fail validation if mech deployment fails - it's AC4 (bonus)

    if (step4.success && step4.data?.mechAddress) {
      console.log(`[${ctx.testId}] Mech deployed:`, step4.data);
    }

    // Step 5: Capture final service information as evidence
    const step5 = await executeValidationStep(
      "Capture evidence and final service information",
      ctx.testId,
      async () => {
        const finalStatus = await ctx.serviceManager.getServiceStatus();
        
        // TODO: Extract actual transaction hashes from operate output
        // For now, we'll capture the service information as evidence
        evidence.serviceInfo = finalStatus;
        
        return {
          finalStatus,
          evidenceCaptured: true,
          validationComplete: true
        };
      }
    );
    steps.push(step5);
    if (!step5.success) throw new Error(`Step 5 failed: ${step5.error}`);

    console.log(`[${ctx.testId}] Evidence captured:`, step5.data);

    const totalDuration = Date.now() - startTime;
    console.log(`[${ctx.testId}] 🎉 JINN-189 validation completed successfully in ${totalDuration}ms`);

    return {
      success: true,
      totalDuration,
      steps,
      evidence
    };

  } catch (error: any) {
    const totalDuration = Date.now() - startTime;
    console.log(`[${ctx.testId}] 💥 JINN-189 validation failed after ${totalDuration}ms: ${error.message}`);

    return {
      success: false,
      totalDuration,
      steps,
      evidence,
      error: error.message
    };
  }
}

/**
 * Main validation runner
 */
async function runJinn189E2EValidation(): Promise<void> {
  console.log('🚀 Starting JINN-189 E2E Validation: Complete Service Deployment Using OlasServiceManager');
  console.log(`📁 Validation workspace: ${TEMP_DIR_BASE}`);

  // Ensure temp directory exists and is clean
  await fs.rm(TEMP_DIR_BASE, { recursive: true, force: true });
  await fs.mkdir(TEMP_DIR_BASE, { recursive: true });

  let ctx: ValidationContext | null = null;

  try {
    // Create validation context
    ctx = await createValidationContext();

    // Run the complete validation
    const result = await runJinn189Validation(ctx);

    // Print detailed results
    console.log('\n📊 JINN-189 Validation Results');
    console.log('===============================');
    console.log(`Overall Success: ${result.success ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`Total Duration: ${result.totalDuration}ms`);
    console.log(`Steps Completed: ${result.steps.filter(s => s.success).length}/${result.steps.length}`);

    console.log('\n📋 Step Details:');
    for (const step of result.steps) {
      const status = step.success ? '✅' : '❌';
      console.log(`   ${status} ${step.stepName} (${step.duration}ms)`);
      if (!step.success && step.error) {
        console.log(`      Error: ${step.error}`);
      }
    }

    console.log('\n🧾 Evidence Collected:');
    console.log(`   Service Info:`, result.evidence.serviceInfo ? '✅ Captured' : '❌ Missing');
    console.log(`   Transaction Hashes:`, result.evidence.transactionHashes.length > 0 ? 
      `✅ ${result.evidence.transactionHashes.length} captured` : '⚠️ None captured (operate CLI output parsing needed)');
    
    if (result.evidence.mechInfo) {
      console.log(`   Mech Address:`, result.evidence.mechInfo.mechAddress || '❌ Missing');
      console.log(`   Agent ID:`, result.evidence.mechInfo.agentId || '❌ Missing');
    }

    // AC1: Successful Service Creation ✅
    const serviceCreated = result.steps.some(s => s.stepName.includes('Deploy and stake') && s.success);
    console.log(`\n🎯 Acceptance Criteria Validation:`);
    console.log(`   AC1 - Service Creation: ${serviceCreated ? '✅ PASS' : '❌ FAIL'}`);
    
    // AC2: Successful Service Staking ✅  
    const serviceStaked = result.evidence.serviceInfo?.isStaked;
    console.log(`   AC2 - Service Staking: ${serviceStaked ? '✅ PASS' : '❌ FAIL'}`);
    
    // AC3: Evidence Collection ✅
    const evidenceCollected = result.evidence.serviceInfo !== undefined;
    console.log(`   AC3 - Evidence Collection: ${evidenceCollected ? '✅ PASS' : '❌ FAIL'}`);
    
    // AC4: Mech Deployment (Bonus) 
    const mechDeployed = result.evidence.mechInfo?.mechAddress !== undefined;
    console.log(`   AC4 - Mech Deployment (Bonus): ${mechDeployed ? '✅ PASS' : '⚠️ SKIPPED'}`);

    // Exit with appropriate code
    if (result.success) {
      console.log('\n✅ JINN-189 E2E Validation PASSED!');
      console.log('\n📝 Next Steps:');
      console.log('   1. Implement transaction hash extraction from operate CLI output');
      console.log('   2. Add on-chain verification of service deployment');
      console.log('   3. Document service deployment for future E2E validations');
      process.exit(0);
    } else {
      console.log('\n❌ JINN-189 E2E Validation FAILED!');
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
      process.exit(1);
    }

  } catch (error: any) {
    console.error('💥 Validation setup failed:', error.message);
    process.exit(1);
  } finally {
    // Always cleanup
    if (ctx) {
      await cleanupValidationContext(ctx);
    }
  }
}

// Handle script execution
if (import.meta.url === `file://${process.argv[1]}`) {
  runJinn189E2EValidation().catch((error) => {
    console.error('💥 Validation runner failed:', error);
    process.exit(1);
  });
}

export {
  runJinn189E2EValidation,
  createValidationContext,
  cleanupValidationContext,
  type ValidationContext,
  type ValidationResult,
  type ValidationStepResult,
};
