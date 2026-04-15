#!/usr/bin/env ts-node

/**
 * Deploy JinnRouter and prepare Safe transactions for proxy upgrade + initialization
 *
 * Two phases:
 * 1. Deploy the JinnRouter implementation (master EOA)
 * 2. Output Safe transaction data for upgrade + initialize (to be signed by Safe owners)
 *
 * Prerequisites:
 * - Compile contracts: cd contracts && yarn compile
 * - Set OPERATE_PASSWORD in .env
 *
 * Usage:
 *   yarn tsx scripts/deploy-jinn-router.ts              # Deploy impl + output Safe tx data
 *   yarn tsx scripts/deploy-jinn-router.ts --dry-run    # Show what would happen
 *   yarn tsx scripts/deploy-jinn-router.ts --impl 0x... # Skip deploy, use existing impl
 */

import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

// ============================================================================
// CONSTANTS
// ============================================================================

const ACTIVITY_CHECKER_PROXY = "0x477C41Cccc8bd08027e40CEF80c25918C595a24d";
const PROXY_OWNER_SAFE = "0x900Db2954a6c14C011dBeBE474e3397e58AE5421";
const MECH_MARKETPLACE = "0xf24eE42edA0fc9b33B7D41B06Ee8ccD2Ef7C5020";
const LIVENESS_RATIO = 230481481481481n; // ~20 activities/day

// Proxy ABI
const PROXY_ABI = [
  "function upgrade(address newImplementation) external",
  "function implementation() external view returns (address)",
  "function owner() external view returns (address)",
];

// JinnRouter ABI (for initialize call through proxy)
const ROUTER_ABI = [
  "function initialize(address _mechMarketplace, uint256 _livenessRatio) external",
  "function initialized() external view returns (bool)",
  "function mechMarketplace() external view returns (address)",
  "function livenessRatio() external view returns (uint256)",
];

// ============================================================================
// WALLET LOADING
// ============================================================================

async function loadMasterWallet(
  provider: ethers.JsonRpcProvider
): Promise<ethers.Wallet> {
  // Try DEPLOYER_PRIVATE_KEY first
  if (process.env.DEPLOYER_PRIVATE_KEY) {
    return new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  }

  // Fall back to .operate keystore
  const password = process.env.OPERATE_PASSWORD;
  if (!password) {
    throw new Error(
      "Set DEPLOYER_PRIVATE_KEY or OPERATE_PASSWORD in .env"
    );
  }

  const keystorePath = path.resolve(
    process.cwd(),
    ".operate/wallets/ethereum.txt"
  );
  if (!fs.existsSync(keystorePath)) {
    throw new Error(`Keystore not found at ${keystorePath}`);
  }

  const keystore = fs.readFileSync(keystorePath, "utf8");
  console.log("  Decrypting master wallet (this takes a moment)...");
  const wallet = await ethers.Wallet.fromEncryptedJson(keystore, password);
  return wallet.connect(provider);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const implFlag = process.argv.find((a) => a.startsWith("--impl="));
  const existingImpl = implFlag ? implFlag.split("=")[1] : null;

  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";

  console.log("🔧 JinnRouter Deployment");
  console.log("═".repeat(60));
  console.log(`  Network:      Base mainnet`);
  console.log(`  Proxy:        ${ACTIVITY_CHECKER_PROXY}`);
  console.log(`  Proxy owner:  ${PROXY_OWNER_SAFE} (Safe — requires multisig)`);
  console.log(`  Marketplace:  ${MECH_MARKETPLACE}`);
  console.log(`  Liveness:     ${LIVENESS_RATIO}`);
  if (existingImpl) console.log(`  Existing impl:${existingImpl}`);
  console.log(`  Dry run:      ${dryRun}`);
  console.log();

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // Verify proxy state
  const proxy = new ethers.Contract(ACTIVITY_CHECKER_PROXY, PROXY_ABI, provider);
  const currentImpl = await proxy.implementation();
  const currentOwner = await proxy.owner();
  console.log(`  Current impl:   ${currentImpl}`);
  console.log(`  Current owner:  ${currentOwner}`);

  if (currentOwner.toLowerCase() !== PROXY_OWNER_SAFE.toLowerCase()) {
    throw new Error(
      `Proxy owner mismatch: expected ${PROXY_OWNER_SAFE}, got ${currentOwner}`
    );
  }

  // ── Step 1: Deploy JinnRouter implementation ──

  let implAddress: string;

  if (existingImpl) {
    implAddress = existingImpl;
    console.log(`\n📋 Step 1: Using existing implementation: ${implAddress}`);
  } else {
    console.log("\n📋 Step 1: Deploy JinnRouter implementation");
    console.log("─".repeat(60));

    const artifactPath = path.resolve(
      process.cwd(),
      "contracts/staking/artifacts/staking/JinnRouter.sol/JinnRouter.json"
    );

    if (!fs.existsSync(artifactPath)) {
      throw new Error(
        `Artifact not found at ${artifactPath}\nRun: cd contracts && yarn compile`
      );
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

    if (dryRun) {
      console.log("  Would deploy JinnRouter implementation");
      implAddress = "0x" + "0".repeat(40);
    } else {
      const wallet = await loadMasterWallet(provider);
      console.log(`  Deployer: ${wallet.address}`);

      const balance = await provider.getBalance(wallet.address);
      console.log(
        `  Balance:  ${ethers.formatEther(balance)} ETH`
      );

      if (balance === 0n) {
        throw new Error("Deployer has zero ETH balance");
      }

      const factory = new ethers.ContractFactory(
        artifact.abi,
        artifact.bytecode,
        wallet
      );

      console.log("  Deploying...");
      const routerImpl = await factory.deploy();
      await routerImpl.waitForDeployment();
      implAddress = await routerImpl.getAddress();
      console.log(`  ✅ JinnRouter deployed: ${implAddress}`);
      console.log(
        `     BaseScan: https://basescan.org/address/${implAddress}`
      );
    }
  }

  // ── Step 2: Build Safe transactions ──

  console.log("\n📋 Step 2: Safe transactions for upgrade + initialize");
  console.log("─".repeat(60));
  console.log(
    "  The proxy owner is a Safe. The following transactions need to be"
  );
  console.log("  signed by Safe owners and executed.\n");

  // Transaction 1: proxy.upgrade(newImplementation)
  const proxyIface = new ethers.Interface(PROXY_ABI);
  const upgradeTxData = proxyIface.encodeFunctionData("upgrade", [implAddress]);

  console.log("  Transaction 1: Upgrade proxy implementation");
  console.log(`    To:   ${ACTIVITY_CHECKER_PROXY}`);
  console.log(`    Data: ${upgradeTxData}`);
  console.log(`    Value: 0`);
  console.log(
    `    Safe TX URL: https://app.safe.global/transactions/queue?safe=base:${PROXY_OWNER_SAFE}`
  );

  // Transaction 2: router.initialize(marketplace, livenessRatio)
  const routerIface = new ethers.Interface(ROUTER_ABI);
  const initTxData = routerIface.encodeFunctionData("initialize", [
    MECH_MARKETPLACE,
    LIVENESS_RATIO,
  ]);

  console.log("\n  Transaction 2: Initialize JinnRouter");
  console.log(`    To:   ${ACTIVITY_CHECKER_PROXY}`);
  console.log(`    Data: ${initTxData}`);
  console.log(`    Value: 0`);

  // Can be batched
  console.log("\n  These can be batched in a single Safe transaction using");
  console.log("  the Transaction Builder app in Safe UI.");

  // ── Save deployment info ──

  const deploymentInfo = {
    network: "base",
    chainId: 8453,
    timestamp: new Date().toISOString(),
    contracts: {
      jinnRouterImplementation: implAddress,
      activityCheckerProxy: ACTIVITY_CHECKER_PROXY,
      proxyOwnerSafe: PROXY_OWNER_SAFE,
    },
    config: {
      mechMarketplace: MECH_MARKETPLACE,
      livenessRatio: LIVENESS_RATIO.toString(),
    },
    safeTransactions: {
      upgrade: {
        to: ACTIVITY_CHECKER_PROXY,
        data: upgradeTxData,
        value: "0",
      },
      initialize: {
        to: ACTIVITY_CHECKER_PROXY,
        data: initTxData,
        value: "0",
      },
    },
  };

  const outPath = path.resolve(
    process.cwd(),
    "contracts/staking/deployment-router.json"
  );
  fs.writeFileSync(outPath, JSON.stringify(deploymentInfo, null, 2));

  console.log("\n" + "═".repeat(60));
  if (dryRun) {
    console.log("✅ Dry run complete — no transactions sent");
  } else {
    console.log("✅ Implementation deployed!");
    console.log("   Next: sign the Safe transactions above to upgrade + initialize.");
  }
  console.log(`  Saved to: ${outPath}`);
}

main().catch((err) => {
  console.error("\n❌ Deployment failed:", err.message || err);
  process.exit(1);
});
