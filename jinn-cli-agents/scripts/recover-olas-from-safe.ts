#!/usr/bin/env tsx
/**
 * EMERGENCY: Recover OLAS tokens from incorrectly created Safe
 * 
 * This script uses the middleware to transfer OLAS from the new Safe
 * back to a recovery address.
 */

import { OlasOperateWrapper } from "jinn-node/worker/OlasOperateWrapper.js";
import { logger } from "jinn-node/logging/index.js";

const recoveryLogger = logger.child({ component: "OLAS-RECOVERY" });

const FROM_SAFE = "0x61e2B89477f62E4A98aFd0491D0E1A8b0e8BDfCB"; // Safe with OLAS
const OLAS_TOKEN = "0x54330d28ca3357F294334BDC454a032e7f353416";
const AMOUNT = "100000000000000000000"; // 100 OLAS
const TO_ADDRESS = "0x15aDF0eD29b6D76DB365670DfEeD8F9C5dAD4645"; // Original Safe (or your EOA)

async function recoverOLAS() {
  recoveryLogger.info("⚠️  OLAS RECOVERY SCRIPT");
  recoveryLogger.info(`From Safe: ${FROM_SAFE}`);
  recoveryLogger.info(`To Address: ${TO_ADDRESS}`);
  recoveryLogger.info(`Amount: ${AMOUNT} wei (100 OLAS)`);
  
  const wrapper = await OlasOperateWrapper.create();
  
  try {
    // Login
    const password = process.env.OPERATE_PASSWORD || "test-password-12345678";
    const loginResult = await wrapper.login(password);
    if (!loginResult.success) {
      throw new Error(`Login failed: ${loginResult.error}`);
    }
    recoveryLogger.info("✅ Logged in");
    
    // TODO: The middleware doesn't expose a direct "send ERC20 from Safe" API
    // You'll need to either:
    // 1. Use the Safe's Gnosis Safe UI with your backed up keys
    // 2. Write a custom ethers.js script
    // 3. Or delete the new service and start over
    
    recoveryLogger.warn("⚠️  The middleware doesn't have a direct API to transfer tokens from a Safe.");
    recoveryLogger.warn("⚠️  Recommended recovery:");
    recoveryLogger.warn("   1. Delete the problematic service directory:");
    recoveryLogger.warn("      rm -rf olas-operate-middleware/.operate/services/sc-cb5453f2-aa70-4a3d-a22a-31ea4d0c200d");
    recoveryLogger.warn("   2. Delete the temp config:");
    recoveryLogger.warn("      rm -rf /tmp/jinn-186-mainnet");
    recoveryLogger.warn("   3. The next run will bootstrap from scratch with the original wallet");
    recoveryLogger.warn("   4. The OLAS is in the Safe which is controlled by your backed up EOA wallet");
    recoveryLogger.warn("   5. You can recover later using the backed up keys in ~/Downloads/olas-wallet-backup/");
    
  } finally {
    await wrapper.stopServer();
  }
}

recoverOLAS().catch(console.error);
