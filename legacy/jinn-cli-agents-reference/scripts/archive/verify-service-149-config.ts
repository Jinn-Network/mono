#!/usr/bin/env tsx
/**
 * Verify Service #149 Config Can Be Loaded by Worker
 * 
 * Tests that OlasServiceManager can successfully load and manage service #149
 */

import "dotenv/config";
import { OlasServiceManager } from "../worker/OlasServiceManager";

async function verifyServiceConfig() {
  console.log("🔍 Verifying Service #149 Config");
  console.log("=".repeat(80));
  console.log();

  try {
    // Initialize service manager
    console.log("Initializing OlasServiceManager...");
    const serviceManager = await OlasServiceManager.createDefault();
    console.log("✅ Service manager initialized");
    console.log();

    // List all services
    console.log("Listing all services:");
    console.log("-".repeat(80));
    const services = await serviceManager.listExistingServices();
    
    console.log(`Found ${services.length} services:`);
    services.forEach((service, i) => {
      console.log(`  [${i}] ${service.serviceConfigId}`);
      console.log(`      Safe: ${service.safeAddress || "N/A"}`);
      console.log(`      Token ID: ${service.tokenId || "N/A"}`);
      console.log(`      Chain: ${service.chain || "N/A"}`);
    });
    console.log();

    // Check if service-149-recovered exists
    const service149 = services.find(
      (s) => s.serviceConfigId === "sc-service-149-recovered"
    );

    if (!service149) {
      console.error("❌ Service #149 not found in service list");
      console.error("Available config IDs:");
      services.forEach((s) => console.error(`  - ${s.serviceConfigId}`));
      process.exit(1);
    }

    console.log("✅ Found service #149 in service list");
    console.log("Service details:");
    console.log(JSON.stringify(service149, null, 2));
    console.log();

    // Verify it matches expected values
    const expectedSafe = "0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645";
    const expectedAgent = "0xd36f1C72268d97af2D16426c060646Ec9aBB74F9";
    const expectedServiceId = 149;

    let allChecksPass = true;

    if (service149.safeAddress?.toLowerCase() !== expectedSafe.toLowerCase()) {
      console.error(`❌ Safe address mismatch`);
      console.error(`   Expected: ${expectedSafe}`);
      console.error(`   Got: ${service149.safeAddress}`);
      allChecksPass = false;
    } else {
      console.log(`✅ Safe address matches: ${expectedSafe}`);
    }

    if (service149.agentAddress?.toLowerCase() !== expectedAgent.toLowerCase()) {
      console.error(`❌ Agent instance mismatch`);
      console.error(`   Expected: ${expectedAgent}`);
      console.error(`   Got: ${service149.agentAddress}`);
      allChecksPass = false;
    } else {
      console.log(`✅ Agent instance matches: ${expectedAgent}`);
    }

    if (service149.tokenId !== expectedServiceId) {
      console.error(`❌ Service ID mismatch`);
      console.error(`   Expected: ${expectedServiceId}`);
      console.error(`   Got: ${service149.tokenId}`);
      allChecksPass = false;
    } else {
      console.log(`✅ Service ID matches: ${expectedServiceId}`);
    }

    console.log();

    if (!allChecksPass) {
      console.error("❌ Some verification checks failed");
      process.exit(1);
    }

    console.log("✅ ALL VERIFICATION CHECKS PASSED");
    console.log();
    console.log("Service #149 config is correctly loaded and ready for management");
    console.log();
    console.log("Next Steps:");
    console.log("-".repeat(80));
    console.log("1. Deploy mech contract via OlasServiceManager.deployMech()");
    console.log("2. Create marketplace activity script");
    console.log("3. Monitor checkpoint passage and rewards");

  } catch (error) {
    console.error("❌ Error verifying service config:");
    console.error(error);
    process.exit(1);
  }
}

verifyServiceConfig();
