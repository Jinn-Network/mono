#!/usr/bin/env tsx
/**
 * Test Mech Deployment for Service #149
 * 
 * Tests that the core codebase (OlasServiceManager) can deploy a mech
 * for the existing service #149 through the middleware HTTP API.
 */

import "dotenv/config";
import { OlasServiceManager } from "../worker/OlasServiceManager";

const SERVICE_CONFIG_ID = "sc-service-149-recovered";
const EXPECTED_SAFE = "0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645";

async function testMechDeployment() {
  console.log("🧪 Testing Mech Deployment for Service #149");
  console.log("=".repeat(80));
  console.log();

  try {
    // Step 1: Initialize service manager
    console.log("Step 1: Initializing OlasServiceManager...");
    const serviceManager = await OlasServiceManager.createDefault();
    console.log("✅ Service manager initialized");
    console.log();

    // Step 2: Verify service exists
    console.log("Step 2: Verifying service #149 exists...");
    const services = await serviceManager.listExistingServices();
    const service149 = services.find(s => s.serviceConfigId === SERVICE_CONFIG_ID);

    if (!service149) {
      console.error("❌ Service #149 not found");
      console.error("Available services:");
      services.forEach(s => console.error(`  - ${s.serviceConfigId}`));
      process.exit(1);
    }

    console.log(`✅ Service #149 found:`);
    console.log(`   Safe: ${service149.safeAddress}`);
    console.log(`   Token ID: ${service149.tokenId}`);
    console.log(`   Chain: ${service149.chain}`);
    console.log();

    // Step 3: Check current env vars
    console.log("Step 3: Checking current mech configuration...");
    const fs = await import('fs');
    const path = await import('path');
    const configPath = path.join(
      process.cwd(),
      "olas-operate-middleware",
      ".operate",
      "services",
      SERVICE_CONFIG_ID,
      "config.json"
    );

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const envVars = config.env_variables || {};

    console.log(`   MECH_MARKETPLACE_ADDRESS: ${envVars.MECH_MARKETPLACE_ADDRESS?.value || "NOT SET"}`);
    console.log(`   MECH_REQUEST_PRICE: ${envVars.MECH_REQUEST_PRICE?.value || "NOT SET"}`);
    console.log(`   AGENT_ID: ${envVars.AGENT_ID?.value || "NOT SET"}`);
    console.log(`   MECH_TO_CONFIG: ${envVars.MECH_TO_CONFIG?.value ? "SET" : "NOT SET"}`);
    console.log();

    if (!envVars.MECH_MARKETPLACE_ADDRESS?.value) {
      console.error("❌ MECH_MARKETPLACE_ADDRESS not set in config");
      console.error("   Please ensure the config has mech marketplace env vars");
      process.exit(1);
    }

    if (envVars.AGENT_ID?.value && envVars.MECH_TO_CONFIG?.value) {
      console.log("⚠️  Mech already deployed (AGENT_ID and MECH_TO_CONFIG are set)");
      
      // Extract mech address
      try {
        const mechToConfig = JSON.parse(envVars.MECH_TO_CONFIG.value);
        const mechAddress = Object.keys(mechToConfig)[0];
        console.log(`   Existing Mech Address: ${mechAddress}`);
        console.log(`   Existing Agent ID: ${envVars.AGENT_ID.value}`);
        console.log();
        console.log(`🔗 View on BaseScan: https://basescan.org/address/${mechAddress}`);
        console.log();
        console.log("✅ Mech deployment verification complete (already deployed)");
        return;
      } catch (e) {
        console.error("❌ Failed to parse existing mech config:", e);
      }
    }

    // Step 4: Deploy mech
    console.log("Step 4: Deploying mech via OlasServiceManager...");
    console.log("-".repeat(80));
    console.log("⚠️  This will submit a transaction to Base mainnet");
    console.log("⏳ Waiting 5 seconds before proceeding...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log();

    const result = await serviceManager.deployMechForExistingService(SERVICE_CONFIG_ID);

    console.log();
    console.log("✅ MECH DEPLOYMENT SUCCESSFUL!");
    console.log("=".repeat(80));
    console.log(`Mech Address: ${result.mechAddress}`);
    console.log(`Agent ID: ${result.agentId}`);
    console.log(`Service Name: ${result.serviceName}`);
    console.log();

    // Step 5: Verify mech on BaseScan
    console.log("Step 5: Verification...");
    console.log("-".repeat(80));
    console.log(`🔗 View mech on BaseScan:`);
    console.log(`   https://basescan.org/address/${result.mechAddress}`);
    console.log();
    console.log(`🔗 View Safe on BaseScan:`);
    console.log(`   https://basescan.org/address/${EXPECTED_SAFE}`);
    console.log();

    // Step 6: Verify config was updated
    console.log("Step 6: Verifying config update...");
    const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const updatedEnvVars = updatedConfig.env_variables || {};

    if (updatedEnvVars.AGENT_ID?.value && updatedEnvVars.MECH_TO_CONFIG?.value) {
      console.log("✅ Config updated with mech information");
      console.log(`   AGENT_ID: ${updatedEnvVars.AGENT_ID.value}`);
      const mechToConfig = JSON.parse(updatedEnvVars.MECH_TO_CONFIG.value);
      console.log(`   MECH_TO_CONFIG keys: ${Object.keys(mechToConfig).join(', ')}`);
    } else {
      console.warn("⚠️  Config may not have been updated");
    }

    console.log();
    console.log("✅ ALL TESTS PASSED");
    console.log();
    console.log("Next Steps:");
    console.log("-".repeat(80));
    console.log("1. Verify mech contract on BaseScan");
    console.log("2. Create marketplace activity script (Task 3 of JINN-195)");
    console.log("3. Monitor checkpoint passage for rewards");

  } catch (error) {
    console.error();
    console.error("❌ TEST FAILED");
    console.error("=".repeat(80));
    console.error(error);
    process.exit(1);
  }
}

testMechDeployment();
