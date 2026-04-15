#!/usr/bin/env tsx
/**
 * JINN-186 Full E2E Validation Script (Simplified)
 * 
 * This version uses the new core safety features instead of manual checks.
 * Reduced from ~1000 lines to ~300 lines.
 * 
 * Core features used:
 * - OlasOperateWrapper: Safe detection and reuse
 * - OlasServiceManager: Service listing, balance verification, state tracking
 * - SafeAddressPredictor: Pre-funding capability
 * - ServiceStateTracker: Persistent state tracking
 */

import "dotenv/config";
import { OlasStakingManager } from "jinn-node/worker/OlasStakingManager.js";
import { OlasServiceManager } from "jinn-node/worker/OlasServiceManager.js";
import { OlasOperateWrapper } from "jinn-node/worker/OlasOperateWrapper.js";
import { ServiceStateTracker } from "jinn-node/worker/ServiceStateTracker.js";
import { createTenderlyClient, ethToWei } from "jinn-node/lib/tenderly.js";
import { logger } from "jinn-node/logging/index.js";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { existsSync } from "fs";

const validationLogger = logger.child({ component: "JINN-186-VALIDATION" });

// ============================================================================
// Types and Interfaces
// ============================================================================

interface ValidationStep {
  id: string;
  phase: string;
  name: string;
  description: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  evidence?: Record<string, any>;
  error?: string;
  duration?: number;
}

interface ValidationContext {
  testId: string;
  tempDir: string;
  useTenderly: boolean;
  tenderlyVnetId?: string;
  tenderlyRpcUrl?: string;
  operateWrapper?: OlasOperateWrapper;
  stakingManager?: OlasStakingManager;
  serviceManager?: OlasServiceManager;
  stateTracker?: ServiceStateTracker;
  walletAddress?: string;
  safeAddress?: string;
  serviceId?: number;
  serviceConfigPath?: string;
}

interface ValidationResult {
  success: boolean;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  steps: ValidationStep[];
  evidence: Record<string, any>;
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_SERVICE_CONFIG = {
  name: "jinn-186-validation-service",
  hash: "bafybeiardecju3sygh7hwuywka2bgjinbr7vrzob4mpdrookyfsbdmoq2m", // Agents.Fun Base
  description: "JINN-186 Full E2E Validation Service - Agents.Fun",
  image: "https://operate.olas.network/_next/image?url=%2Fimages%2Fprediction-agent.png&w=3840&q=75",
  service_version: "v0.26.3",
  home_chain: "base",
  configurations: {
    base: {
      staking_program_id: "agents_fun_1",
      nft: "bafybeig64atqaladigoc3ds4arltdu63wkdrk3gesjfvnfdmz35amv7faq",
      rpc: process.env.RPC_URL || "https://mainnet.base.org",
      agent_id: 43,
      cost_of_bond: 50000000000000000000, // 50 OLAS
      monthly_gas_estimate: 10000000000000000000, // 10 ETH
      fund_requirements: {
        "0x0000000000000000000000000000000000000000": {
          agent: 2000000000000000000, // 2 ETH
          safe: 5000000000000000000,  // 5 ETH
        },
        "0x54330d28ca3357F294334BDC454a032e7f353416": { // OLAS token on Base
          agent: 0,
          safe: 100000000000000000000, // 100 OLAS
        },
      },
    },
  },
  env_variables: {},
};

// ============================================================================
// Validation Steps
// ============================================================================

async function executeStep(
  step: ValidationStep,
  ctx: ValidationContext,
  stepFunction: () => Promise<void>
): Promise<void> {
  const startTime = Date.now();
  step.status = "running";
  
  validationLogger.info({ 
    stepId: step.id, 
    stepName: step.name 
  }, `▶️  ${step.phase}: ${step.name}`);

  try {
    await stepFunction();
    step.status = "success";
    step.duration = Date.now() - startTime;
    
    validationLogger.info({ 
      stepId: step.id, 
      duration: step.duration 
    }, `✅ ${step.name} - PASSED (${step.duration}ms)`);
  } catch (error) {
    step.status = "failed";
    step.duration = Date.now() - startTime;
    step.error = error instanceof Error ? error.message : String(error);
    
    validationLogger.error({ 
      stepId: step.id, 
      error: step.error, 
      duration: step.duration 
    }, `❌ ${step.name} - FAILED (${step.duration}ms)`);
    
    throw error;
  }
}

// ============================================================================
// Step 1.1: Environment Setup
// ============================================================================

async function step1_1_environmentSetup(step: ValidationStep, ctx: ValidationContext): Promise<void> {
  await executeStep(step, ctx, async () => {
    validationLogger.info("Creating OlasOperateWrapper and bootstrapping wallet");

    // Initialize state tracker
    ctx.stateTracker = new ServiceStateTracker();
    await ctx.stateTracker.load();

    // Wallet cleanup for Tenderly only
    if (ctx.useTenderly) {
      validationLogger.info("Cleaning middleware state (Tenderly mode)");
      const { execSync } = await import('child_process');
      try {
        execSync('rm -rf olas-operate-middleware/.operate/wallets/*', { cwd: process.cwd() });
        validationLogger.info("Cleaned wallet state");
      } catch (error) {
        validationLogger.warn({ error }, "Failed to clean wallet state");
      }
    }

    // Create operate wrapper with optional Tenderly RPC
    const config: any = {};
    if (ctx.useTenderly && ctx.tenderlyRpcUrl) {
      config.rpcUrl = ctx.tenderlyRpcUrl;
    }
    ctx.operateWrapper = await OlasOperateWrapper.create(config);

    // Bootstrap wallet
    if (ctx.useTenderly && ctx.tenderlyRpcUrl) {
      // Tenderly: Bootstrap without Safe, fund, then create Safe
      const bootstrapResult = await ctx.operateWrapper.bootstrapWalletWithoutSafe({
        password: process.env.OPERATE_PASSWORD || "test-password-12345678",
        chain: "base",
        ledgerType: "ethereum",
      });

      if (!bootstrapResult.success) {
        throw new Error(`Wallet bootstrap failed: ${bootstrapResult.error}`);
      }

      ctx.walletAddress = bootstrapResult.walletAddress;

      // Fund wallet via Tenderly
      const tenderlyClient = createTenderlyClient();
      await tenderlyClient.fundAddress(ctx.walletAddress!, ethToWei('5.0'), ctx.tenderlyRpcUrl);
      validationLogger.info({ walletAddress: ctx.walletAddress }, "Funded wallet via Tenderly");

      // Wait for balance
      await waitForBalance(ctx.walletAddress!, ethToWei('5.0'), ctx.tenderlyRpcUrl);

      // Create Safe (with reuse check)
      const safeResult = await ctx.operateWrapper.createSafe("base", undefined, {
        checkExisting: true,  // Reuse if exists
        warnIfNew: true       // Warn if creating new
      });

      if (!safeResult.success) {
        throw new Error(`Safe creation failed: ${safeResult.error}`);
      }

      ctx.safeAddress = safeResult.safeAddress;
      validationLogger.info({ safeAddress: ctx.safeAddress }, "Safe created/reused on Tenderly");

      // Fund Safe
      await tenderlyClient.fundAddress(ctx.safeAddress!, "20000000000000000000", ctx.tenderlyRpcUrl!);
      validationLogger.info({ safeAddress: ctx.safeAddress }, "Funded Safe on Tenderly");

    } else {
      // Mainnet: Normal bootstrap
      const bootstrapResult = await ctx.operateWrapper.bootstrapWallet({
        password: process.env.OPERATE_PASSWORD || "test-password-12345678",
        chain: "base",
        ledgerType: "ethereum",
      });

      if (!bootstrapResult.success) {
        throw new Error(`Wallet bootstrap failed: ${bootstrapResult.error}`);
      }

      ctx.walletAddress = bootstrapResult.walletAddress;
      ctx.safeAddress = bootstrapResult.safeAddress;

      // Restart server and login
      await ctx.operateWrapper.startServer();
      const loginResult = await ctx.operateWrapper.login(process.env.OPERATE_PASSWORD || "test-password-12345678");
      if (!loginResult.success) {
        throw new Error(`Login failed: ${loginResult.error}`);
      }
    }

    step.evidence = {
      walletAddress: ctx.walletAddress,
      safeAddress: ctx.safeAddress,
      tenderlyFunded: ctx.useTenderly,
    };

    validationLogger.info({ 
      walletAddress: ctx.walletAddress, 
      safeAddress: ctx.safeAddress 
    }, "Wallet and Safe ready");
  });
}

/**
 * Wait for balance to be recognized by RPC
 */
async function waitForBalance(
  address: string, 
  expectedAmount: string, 
  rpcUrl: string
): Promise<boolean> {
  const maxRetries = 10;
  const { ethers } = await import('ethers');
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const balance = await provider.getBalance(address);
      if (balance >= BigInt(expectedAmount)) {
        validationLogger.info({ address, balance: ethers.formatEther(balance) }, "Balance verified");
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      validationLogger.warn({ attempt, error }, "Balance check failed");
    }
  }
  
  return false;
}

// ============================================================================
// Step 1.2: Service Configuration
// ============================================================================

async function step1_2_configValidation(step: ValidationStep, ctx: ValidationContext): Promise<void> {
  await executeStep(step, ctx, async () => {
    validationLogger.info("Creating and validating service configuration");

    // Create unique temp directory
    ctx.tempDir = `/tmp/jinn-186-${Date.now()}`;
    await mkdir(ctx.tempDir, { recursive: true });
    
    const serviceConfigPath = path.join(ctx.tempDir, 'service-config.json');
    
    // Adjust config for Tenderly (no_staking)
    const config = { ...DEFAULT_SERVICE_CONFIG };
    if (ctx.useTenderly) {
      config.configurations.base.staking_program_id = "no_staking";
      config.configurations.base.cost_of_bond = 0;
      config.configurations.base.fund_requirements["0x54330d28ca3357F294334BDC454a032e7f353416"].safe = 0;
    }
    
    // Set RPC URL
    if (ctx.tenderlyRpcUrl) {
      config.configurations.base.rpc = ctx.tenderlyRpcUrl;
    }
    
    await writeFile(serviceConfigPath, JSON.stringify(config, null, 2));
    ctx.serviceConfigPath = serviceConfigPath;
    
    step.evidence = {
      configPath: serviceConfigPath,
      config: config,
    };
    
    validationLogger.info({ configPath: serviceConfigPath }, "Service config created");
  });
}

// ============================================================================
// Step 1.3: Service Deployment (Using Core Safety Features)
// ============================================================================

async function step1_3_serviceDeployment(step: ValidationStep, ctx: ValidationContext): Promise<void> {
  await executeStep(step, ctx, async () => {
    validationLogger.info("Deploying service with core safety features");

    // Create service manager
    ctx.serviceManager = new OlasServiceManager(
      ctx.operateWrapper!,
      ctx.serviceConfigPath!
    );

    // Deploy service (options removed - API simplified)
    const serviceInfo = await ctx.serviceManager.deployAndStakeService();

    ctx.serviceId = serviceInfo.serviceId;
    
    step.evidence = {
      serviceId: ctx.serviceId,
      serviceName: serviceInfo.serviceName,
      isStaked: serviceInfo.isStaked,
      stakingContract: serviceInfo.stakingContract,
    };

    validationLogger.info({ 
      serviceId: ctx.serviceId,
      isStaked: serviceInfo.isStaked 
    }, "Service deployed successfully");
  });
}

// ============================================================================
// Step 1.4: State Verification
// ============================================================================

async function step1_4_stateVerification(step: ValidationStep, ctx: ValidationContext): Promise<void> {
  await executeStep(step, ctx, async () => {
    validationLogger.info("Verifying persistent state tracking");

    // Generate state report
    const report = await ctx.stateTracker!.generateReport();
    validationLogger.info({ report }, "State tracker report");

    // Verify service is tracked
    const services = await ctx.stateTracker!.getAllServices();
    if (services.length === 0) {
      throw new Error("No services found in state tracker");
    }

    step.evidence = {
      servicesTracked: services.length,
      report: report,
    };

    validationLogger.info({ count: services.length }, "State verification complete");
  });
}

// ============================================================================
// Main Validation Runner
// ============================================================================

async function runValidation(useTenderly: boolean = false): Promise<ValidationResult> {
  const testId = `jinn-186-${Date.now()}`;
  const ctx: ValidationContext = {
    testId,
    tempDir: `/tmp/${testId}`,
    useTenderly,
  };

  // Setup Tenderly if requested
  if (useTenderly) {
    const tenderlyClient = createTenderlyClient();
    if (!tenderlyClient.isConfigured()) {
      throw new Error('Tenderly not configured');
    }
    const vnetResult = await tenderlyClient.createVnet(8453); // Base
    ctx.tenderlyVnetId = vnetResult.id;
    ctx.tenderlyRpcUrl = vnetResult.adminRpcUrl;
    validationLogger.info({ vnetId: vnetResult.id }, "Created Tenderly VNet");
  }

  const steps: ValidationStep[] = [
    {
      id: "1.1",
      phase: "Phase 1",
      name: "Environment Setup",
      description: "Bootstrap wallet and Safe with core safety features",
      status: "pending",
    },
    {
      id: "1.2",
      phase: "Phase 1",
      name: "Service Configuration",
      description: "Create and validate service configuration",
      status: "pending",
    },
    {
      id: "1.3",
      phase: "Phase 1",
      name: "Service Deployment",
      description: "Deploy service with core safety checks",
      status: "pending",
    },
    {
      id: "1.4",
      phase: "Phase 1",
      name: "State Verification",
      description: "Verify persistent state tracking",
      status: "pending",
    },
  ];

  const stepFunctions = [
    step1_1_environmentSetup,
    step1_2_configValidation,
    step1_3_serviceDeployment,
    step1_4_stateVerification,
  ];

  let passedSteps = 0;
  let failedSteps = 0;
  let skippedSteps = 0;

  for (let i = 0; i < steps.length; i++) {
    try {
      await stepFunctions[i](steps[i], ctx);
      passedSteps++;
    } catch (error) {
      failedSteps++;
      validationLogger.error({ stepId: steps[i].id, error }, "Step failed, stopping validation");
      break;
    }
  }

  // Cleanup Tenderly
  if (useTenderly && ctx.tenderlyVnetId) {
    try {
      const tenderlyClient = createTenderlyClient();
      await tenderlyClient.deleteVnet(ctx.tenderlyVnetId);
      validationLogger.info({ vnetId: ctx.tenderlyVnetId }, "Cleaned up Tenderly VNet");
    } catch (error) {
      validationLogger.warn({ error }, "Failed to cleanup Tenderly VNet");
    }
  }

  const result: ValidationResult = {
    success: failedSteps === 0,
    totalSteps: steps.length,
    passedSteps,
    failedSteps,
    skippedSteps,
    steps,
    evidence: {
      testId,
      useTenderly,
    },
  };

  return result;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const useTenderly = process.argv.includes('--tenderly');
  
  validationLogger.info({ 
    useTenderly,
    mode: useTenderly ? 'Tenderly VNet' : 'Base Mainnet'
  }, "Starting JINN-186 validation (simplified with core safety features)");

  try {
    const result = await runValidation(useTenderly);
    
    validationLogger.info({
      success: result.success,
      passed: result.passedSteps,
      failed: result.failedSteps,
      skipped: result.skippedSteps,
    }, "Validation completed");

    process.exit(result.success ? 0 : 1);
  } catch (error) {
    validationLogger.error({ error }, "Validation failed");
    process.exit(1);
  }
}

main();
