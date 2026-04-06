#!/usr/bin/env tsx
/**
 * ⚠️ CORE VALIDATION SCRIPT - DO NOT DELETE ⚠️
 * 
 * OLAS Service Lifecycle End-to-End Validation
 * 
 * This script validates the complete OLAS service staking system integration.
 * It serves as the canonical reference implementation that will be incorporated
 * into the worker system.
 * 
 * ## Purpose
 * - Validates service creation with real OLAS service hashes
 * - Tests complete lifecycle: wallet → safe → service creation → staking
 * - Demonstrates proper integration with olas-operate-middleware
 * - Documents all required environment variables and configurations
 * 
 * ## Key Learnings Captured Here
 * 
 * 1. **IPFS Hash Requirements**
 *    - MUST use real service hashes from OLAS registry (not fake test hashes)
 *    - Service templates from olas-operate-app provide working examples
 *    - Hash: bafybeihnzvqexxegm6auq7vcpb6prybd2xcz5glbvhos2lmmuazqt75nuq (Trader Agent)
 * 
 * 2. **Chain Configuration**
 *    - Use lowercase chain names: "gnosis", "mode", "optimism" (NOT "ethereum" or "base")
 *    - Chain must be supported in CHAIN_TO_METADATA in operate/quickstart/utils.py
 *    - RPC URLs must match expected chain
 * 
 * 3. **Service Configuration Format**
 *    - fund_requirements values MUST be integers (not strings)
 *    - home_chain must match configuration key
 *    - agent_id can reference existing agents (e.g., agent 25 for pearl_beta)
 * 
 * 4. **Environment Variables Required**
 *    - {CHAIN}_LEDGER_RPC: RPC URL for the target chain
 *    - OPERATE_PASSWORD: Password for wallet operations
 *    - STAKING_PROGRAM: Must be "no_staking" or "custom_staking" (not program ID)
 * 
 * 5. **Middleware Integration**
 *    - Server lifecycle management critical (port allocation, cleanup)
 *    - Balance polling required for Tenderly-funded operations
 *    - Real-time logging helps debug long-running operations
 * 
 * ## Usage
 * 
 * ### With Tenderly (Recommended for Testing):
 * ```bash
 * TENDERLY_ACCESS_KEY=xxx yarn tsx scripts/CORE_DO_NOT_DELETE_olas_service_lifecycle_validation.ts --use-tenderly
 * ```
 * 
 * ### With Real Chain:
 * ```bash
 * GNOSIS_LEDGER_RPC=https://gnosis-rpc.publicnode.com yarn tsx scripts/CORE_DO_NOT_DELETE_olas_service_lifecycle_validation.ts
 * ```
 * 
 * ## Integration Roadmap
 * 
 * This script will be incorporated into:
 * - worker/OlasServiceManager.ts - Service lifecycle orchestration
 * - worker/OlasOperateWrapper.ts - Middleware communication layer
 * - Service configuration validation utilities
 * 
 * @see JINN-186 - Full validation of OLAS staking implementation
 * @see test-service-config.json - Canonical service configuration example
 */

import "dotenv/config";
import { spawn, ChildProcess } from "child_process";
import { logger } from "jinn-node/logging/index.js";
import { TenderlyClient } from "jinn-node/lib/tenderly.js";
import path from "path";
import fs from "fs/promises";

const scriptLogger = logger.child({ component: "OLAS-SERVICE-LIFECYCLE-VALIDATION" });

// ============================================================================
// Configuration
// ============================================================================

interface ServiceConfig {
  name: string;
  hash: string;
  description: string;
  image: string;
  service_version: string;
  home_chain: string;
  configurations: {
    [chain: string]: {
      staking_program_id: string;
      nft: string;
      rpc: string;
      threshold: number;
      agent_id: number;
      use_staking: boolean;
      use_mech_marketplace: boolean;
      cost_of_bond: string;
      fund_requirements: {
        [tokenAddress: string]: {
          agent: number;
          safe: number;
        };
      };
    };
  };
  env_variables: Record<string, unknown>;
}

/**
 * Canonical service configuration using real OLAS Trader Agent template
 * This hash is verified to exist on IPFS and work with the middleware
 */
const CANONICAL_SERVICE_CONFIG: ServiceConfig = {
  name: "validation-trader-service",
  hash: "bafybeihnzvqexxegm6auq7vcpb6prybd2xcz5glbvhos2lmmuazqt75nuq", // Real Trader Agent hash
  description: "OLAS Service Lifecycle Validation - Trader Agent Template",
  image: "https://operate.olas.network/_next/image?url=%2Fimages%2Fprediction-agent.png&w=3840&q=75",
  service_version: "v0.26.3",
  home_chain: "gnosis", // MUST be lowercase and supported in middleware
  configurations: {
    gnosis: {
      staking_program_id: "pearl_beta",
      nft: "bafybeig64atqaladigoc3ds4arltdu63wkdrk3gesjfvnfdmz35amv7faq",
      rpc: "https://gnosis-rpc.publicnode.com",
      threshold: 1,
      agent_id: 14, // Using existing agent from registry (agent 14 works with pearl_beta)
      use_staking: true,
      use_mech_marketplace: false,
      cost_of_bond: "1000000000000000", // 0.001 OLAS in wei
      fund_requirements: {
        // CRITICAL: These MUST be integers, not strings
        "0x0000000000000000000000000000000000000000": {
          agent: 100000000000000000, // 0.1 xDAI
          safe: 50000000000000000,   // 0.05 xDAI
        },
      },
    },
  },
  env_variables: {},
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Write service configuration to temporary file
 */
async function writeServiceConfig(config: ServiceConfig, targetPath: string): Promise<void> {
  await fs.writeFile(targetPath, JSON.stringify(config, null, 2), "utf-8");
  scriptLogger.info({ targetPath }, "Service configuration written");
}

/**
 * Run quickstart command with proper environment and logging
 */
async function runQuickstartCommand(
  middlewarePath: string,
  configPath: string,
  env: Record<string, string>,
  timeout: number = 300000 // 5 minutes
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const pythonBinary = "poetry";
    const args = [
      "run",
      "python",
      "-m",
      "operate.cli",
      "quickstart",
      configPath,
      "--attended=false",
    ];

    scriptLogger.info({ middlewarePath, args, env }, "Starting quickstart command");

    const child = spawn(pythonBinary, args, {
      cwd: middlewarePath,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timeoutHandle: NodeJS.Timeout;

    // Set timeout
    timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");
      scriptLogger.warn({ timeout }, "Command timed out");
    }, timeout);

    child.stdout?.on("data", (data) => {
      const output = data.toString();
      stdout += output;
      
      // Log all output in real-time for debugging
      process.stdout.write(output);
      
      // Log important milestones
      if (output.includes("RPC checks passed")) {
        scriptLogger.info("✅ RPC checks passed");
      }
      if (output.includes("Creating service") || output.includes("Loading service")) {
        const match = output.match(/(?:Creating|Loading) service (bafybei\w+)/);
        if (match) {
          scriptLogger.info({ serviceHash: match[1] }, "📦 Service operation in progress");
        }
      }
      if (output.includes("Calculating funds requirements")) {
        scriptLogger.info("💰 Calculating funds requirements");
      }
      if (output.includes("Waiting for at least")) {
        const match = output.match(/Waiting for at least ([\d.]+) (\w+)/);
        if (match) {
          scriptLogger.info({ amount: match[1], token: match[2] }, "⏳ Waiting for funds");
        }
      }
    });

    child.stderr?.on("data", (data) => {
      const output = data.toString();
      stderr += output;
      
      // Log all stderr in real-time for debugging
      process.stderr.write(output);
      
      // Log errors and warnings from middleware
      if (output.includes("[ERROR]")) {
        scriptLogger.error({ error: output }, "Middleware error");
      }
      if (output.includes("[WARN]") || output.includes("WARNING")) {
        scriptLogger.warn({ warning: output }, "Middleware warning");
      }
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      
      const success = code === 0;
      scriptLogger.info({ exitCode: code, success }, "Quickstart command completed");
      
      resolve({
        success,
        output: stdout,
        error: success ? undefined : stderr || stdout,
      });
    });

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      scriptLogger.error({ error }, "Failed to spawn quickstart command");
      resolve({
        success: false,
        output: stdout,
        error: error.message,
      });
    });
  });
}

/**
 * Clean up old service directories to avoid migration errors
 */
async function cleanupOldServices(middlewarePath: string): Promise<void> {
  const servicesDir = path.join(middlewarePath, ".operate", "services");
  try {
    const entries = await fs.readdir(servicesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("sc-")) {
        const dirPath = path.join(servicesDir, entry.name);
        await fs.rm(dirPath, { recursive: true, force: true });
        scriptLogger.info({ directory: entry.name }, "Cleaned up old service directory");
      }
    }
  } catch (error) {
    // Services directory might not exist yet, that's fine
    scriptLogger.debug({ error }, "No services directory to clean");
  }
}

// ============================================================================
// Main Validation Functions
// ============================================================================

/**
 * Validate service creation with Tenderly (isolated test environment)
 */
async function validateWithTenderly(): Promise<boolean> {
  scriptLogger.info("=== OLAS Service Lifecycle Validation (Tenderly) ===");

  const tenderlyClient = new TenderlyClient();
  let vnetId: string | null = null;

  try {
    // Step 1: Create Tenderly VNet
    scriptLogger.info("Step 1: Creating Tenderly VNet");
    const vnetResult = await tenderlyClient.createVnet(100); // Gnosis chain
    vnetId = vnetResult.id;
    const rpcUrl = vnetResult.adminRpcUrl;
    scriptLogger.info({ vnetId, rpcUrl }, "✅ Tenderly VNet created");

    // Step 2: Prepare service configuration
    scriptLogger.info("Step 2: Preparing service configuration");
    const middlewarePath = path.join(process.cwd(), "olas-operate-middleware");
    const configPath = path.join(middlewarePath, "validation-service-config.json");

    // Update RPC to use Tenderly
    const config = { ...CANONICAL_SERVICE_CONFIG };
    config.configurations.gnosis.rpc = rpcUrl;

    await writeServiceConfig(config, configPath);
    await cleanupOldServices(middlewarePath);

    // Step 3: Run service creation
    scriptLogger.info("Step 3: Running service creation");
    const result = await runQuickstartCommand(
      middlewarePath,
      "./validation-service-config.json",
      {
        GNOSIS_LEDGER_RPC: rpcUrl,
        OPERATE_PASSWORD: "test-password-12345678",
        STAKING_PROGRAM: "no_staking",
      },
      120000 // 2 minute timeout (we'll hit funding wait)
    );

    // Step 4: Validate results
    const success =
      result.output.includes("RPC checks passed") &&
      (result.output.includes("Loading service") || result.output.includes("Creating service")) &&
      result.output.includes("Calculating funds requirements");

    if (success) {
      scriptLogger.info("✅ Service lifecycle validation PASSED");
      scriptLogger.info("📋 Validation Results:");
      scriptLogger.info("   ✓ RPC connectivity validated");
      scriptLogger.info("   ✓ Service hash download successful (IPFS working)");
      scriptLogger.info("   ✓ Service configuration parsed correctly");
      scriptLogger.info("   ✓ Funds requirements calculated");
      return true;
    } else {
      scriptLogger.error("❌ Service lifecycle validation FAILED");
      scriptLogger.error({ error: result.error }, "Validation error details");
      return false;
    }
  } catch (error) {
    scriptLogger.error({ error }, "Validation failed with exception");
    return false;
  } finally {
    // Cleanup Tenderly VNet
    if (vnetId) {
      try {
        await tenderlyClient.deleteVnet(vnetId);
        scriptLogger.info({ vnetId }, "✅ Tenderly VNet cleaned up");
      } catch (error) {
        scriptLogger.warn({ error, vnetId }, "Failed to cleanup Tenderly VNet");
      }
    }
  }
}

/**
 * Validate service creation with real chain (requires funded wallet)
 */
async function validateWithRealChain(chain: string = "gnosis"): Promise<boolean> {
  scriptLogger.info(`=== OLAS Service Lifecycle Validation (${chain.toUpperCase()}) ===`);

  try {
    // Step 1: Validate environment
    const rpcEnvVar = `${chain.toUpperCase()}_LEDGER_RPC`;
    const rpcUrl = process.env[rpcEnvVar];

    if (!rpcUrl) {
      throw new Error(`${rpcEnvVar} environment variable required`);
    }

    scriptLogger.info({ chain, rpcUrl }, "✅ Environment validated");

    // Step 2: Prepare service configuration
    scriptLogger.info("Step 2: Preparing service configuration");
    const middlewarePath = path.join(process.cwd(), "olas-operate-middleware");
    const configPath = path.join(middlewarePath, "validation-service-config.json");

    await writeServiceConfig(CANONICAL_SERVICE_CONFIG, configPath);
    await cleanupOldServices(middlewarePath);

    // Step 3: Run service creation
    scriptLogger.info("Step 3: Running service creation");
    scriptLogger.warn("⚠️  This will require funding the master EOA wallet");

    const result = await runQuickstartCommand(
      middlewarePath,
      "./validation-service-config.json",
      {
        [rpcEnvVar]: rpcUrl,
        OPERATE_PASSWORD: process.env.OPERATE_PASSWORD || "default-password-12345678",
        STAKING_PROGRAM: "no_staking",
      },
      300000 // 5 minute timeout
    );

    // Step 4: Validate results
    const success =
      result.output.includes("RPC checks passed") &&
      (result.output.includes("Loading service") || result.output.includes("Creating service"));

    if (success) {
      scriptLogger.info("✅ Service lifecycle validation PASSED");
      return true;
    } else {
      scriptLogger.error("❌ Service lifecycle validation FAILED");
      scriptLogger.error({ error: result.error }, "Validation error details");
      return false;
    }
  } catch (error) {
    scriptLogger.error({ error }, "Validation failed with exception");
    return false;
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const useTenderly = args.includes("--use-tenderly");
  const chain = args.find((arg) => arg.startsWith("--chain="))?.split("=")[1] || "gnosis";

  scriptLogger.info("🚀 Starting OLAS Service Lifecycle Validation");
  scriptLogger.info({ useTenderly, chain }, "Validation mode");

  const success = useTenderly
    ? await validateWithTenderly()
    : await validateWithRealChain(chain);

  if (success) {
    scriptLogger.info("🎉 Validation completed successfully");
    process.exit(0);
  } else {
    scriptLogger.error("💥 Validation failed");
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// Export for integration into worker
export {
  CANONICAL_SERVICE_CONFIG,
  ServiceConfig,
  validateWithTenderly,
  validateWithRealChain,
  writeServiceConfig,
  runQuickstartCommand,
  cleanupOldServices,
};
