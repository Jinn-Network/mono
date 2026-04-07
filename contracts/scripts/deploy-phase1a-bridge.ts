/**
 * Deploy the Jinn Phase 1a bridge contracts (L1 ↔ L2).
 *
 * Deploys:
 *   - OptimismDepositProcessorL1  on Sepolia (L1 side)
 *   - OptimismTargetDispenserL2   on Base Sepolia (L2 side)
 *
 * The two contracts are linked after deployment by calling
 * setL2TargetDispenser() on the L1 processor.
 *
 * Usage:
 *   # Local (both contracts on the same Hardhat network — config only, no real bridging)
 *   npx hardhat run scripts/deploy-phase1a-bridge.ts --network hardhat
 *
 *   # Live testnet (requires funded deployer + env vars set)
 *   npx hardhat run scripts/deploy-phase1a-bridge.ts --network sepolia
 *
 * Env vars:
 *   DEPLOYER_PRIVATE_KEY        - deployer private key (required for live networks)
 *
 *   -- L1 inputs (Sepolia) --
 *   JINN_TOKEN_L1               - JINN token address on Sepolia
 *   JINN_TOKEN_L2               - JINN token address on Base Sepolia (bridged/synthetic)
 *   DISPENSER_ADDRESS           - Dispenser contract address on Sepolia
 *
 *   -- L2 inputs (Base Sepolia) --
 *   STAKING_FACTORY_ADDRESS     - StakingFactory address on Base Sepolia
 *
 * OP Stack bridge addresses (Sepolia / Base Sepolia) are hardcoded as
 * well-known constants but can be overridden with env vars if needed.
 *
 * Outputs:
 *   deployment-phase1a-bridge-{network}.json
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// OP Stack canonical bridge addresses
// ---------------------------------------------------------------------------
//
// These are the official OP Stack proxy addresses for Sepolia / Base Sepolia.
// Source: https://docs.base.org/docs/base-contracts
//         https://docs.optimism.io/chain/addresses
//
// L1 (Sepolia) — Base Sepolia bridge contracts
const OP_STACK_SEPOLIA = {
  // Base Sepolia L1StandardBridgeProxy on Sepolia
  // Source: https://docs.base.org/docs/base-contracts#base-testnet-sepolia
  L1StandardBridgeProxy: "0xfd0Bf71F60660E2f608ed56e1659C450eB113120",
  // Base Sepolia L1CrossDomainMessengerProxy on Sepolia
  L1CrossDomainMessengerProxy: "0xC34855F4De64F1840e5686e64278da901e261f20",
};

// L2 (Base Sepolia) — predeploy address, same on all OP Stack L2s
const OP_STACK_BASE_SEPOLIA = {
  // L2CrossDomainMessenger is a predeploy at a fixed address on all OP chains
  // Source: https://docs.optimism.io/stack/differences#predeployed-contracts
  L2CrossDomainMessengerProxy: "0x4200000000000000000000000000000000000007",
};

// Chain IDs
const SEPOLIA_CHAIN_ID = 11155111;
const BASE_SEPOLIA_CHAIN_ID = 84532;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeDeployConfig {
  /** JINN token address on L1 (Sepolia). */
  jinnL1: string;
  /** JINN token address on L2 (Base Sepolia) — bridged representation. */
  jinnL2: string;
  /** Dispenser contract address on L1. */
  dispenserL1: string;
  /** StakingFactory address on L2. */
  stakingFactoryL2: string;
  /** L1StandardBridgeProxy address on L1. */
  l1TokenRelayer: string;
  /** L1CrossDomainMessengerProxy address on L1. */
  l1MessageRelayer: string;
  /** L2CrossDomainMessengerProxy address on L2. */
  l2MessageRelayer: string;
  /** L2 chain ID that the L1 deposit processor targets. */
  l2ChainId: number;
  /** L1 chain ID that the L2 dispenser reports back to. */
  l1ChainId: number;
}

export interface BridgeDeployment {
  depositProcessorL1: string;
  targetDispenserL2: string;
}

// ---------------------------------------------------------------------------
// Deploy function (exported for tests)
// ---------------------------------------------------------------------------

export async function deployBridgeContracts(
  deployer: ethers.Signer,
  config: BridgeDeployConfig
): Promise<BridgeDeployment> {
  // -----------------------------------------------------------------------
  // Step 1: Deploy OptimismDepositProcessorL1
  //
  //   constructor(
  //     address _olas,              <- JINN token on L1
  //     address _l1Dispenser,       <- Dispenser on L1
  //     address _l1TokenRelayer,    <- L1StandardBridgeProxy
  //     address _l1MessageRelayer,  <- L1CrossDomainMessengerProxy
  //     uint256 _l2TargetChainId,   <- Base Sepolia chain ID
  //     address _olasL2             <- JINN token on L2
  //   )
  // -----------------------------------------------------------------------
  console.log("  Deploying OptimismDepositProcessorL1...");
  const DepositProcessor = await ethers.getContractFactory(
    "OptimismDepositProcessorL1",
    deployer
  );
  const depositProcessor = await DepositProcessor.deploy(
    config.jinnL1,
    config.dispenserL1,
    config.l1TokenRelayer,
    config.l1MessageRelayer,
    config.l2ChainId,
    config.jinnL2
  );
  await depositProcessor.waitForDeployment();
  const depositProcessorAddress = await depositProcessor.getAddress();
  console.log(`  OptimismDepositProcessorL1: ${depositProcessorAddress}`);

  // -----------------------------------------------------------------------
  // Step 2: Deploy OptimismTargetDispenserL2
  //
  //   constructor(
  //     address _olas,                <- JINN token on L2
  //     address _proxyFactory,        <- StakingFactory on L2
  //     address _l2MessageRelayer,    <- L2CrossDomainMessengerProxy
  //     address _l1DepositProcessor,  <- address of the L1 processor above
  //     uint256 _l1SourceChainId      <- Sepolia chain ID
  //   )
  // -----------------------------------------------------------------------
  console.log("  Deploying OptimismTargetDispenserL2...");
  const TargetDispenser = await ethers.getContractFactory(
    "OptimismTargetDispenserL2",
    deployer
  );
  const targetDispenser = await TargetDispenser.deploy(
    config.jinnL2,
    config.stakingFactoryL2,
    config.l2MessageRelayer,
    depositProcessorAddress,
    config.l1ChainId
  );
  await targetDispenser.waitForDeployment();
  const targetDispenserAddress = await targetDispenser.getAddress();
  console.log(`  OptimismTargetDispenserL2: ${targetDispenserAddress}`);

  // -----------------------------------------------------------------------
  // Step 3: Link — set the L2 target dispenser address on L1 processor
  //
  // After this call the L1 processor stores l2TargetDispenser and revokes
  // the owner role (owner becomes address(0)), making the config immutable.
  // -----------------------------------------------------------------------
  console.log("  Linking: setL2TargetDispenser on L1 processor...");
  const linkTx = await depositProcessor.setL2TargetDispenser(targetDispenserAddress);
  await linkTx.wait();
  console.log("  Linked.");

  return {
    depositProcessorL1: depositProcessorAddress,
    targetDispenserL2: targetDispenserAddress,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("=== Jinn Phase 1a Bridge Deployment ===");
  console.log(`Network:  ${networkName} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(
    `Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`
  );
  console.log();

  // Build config from env vars, falling back to sensible testnet defaults
  const jinnL1 = process.env.JINN_TOKEN_L1;
  const jinnL2 = process.env.JINN_TOKEN_L2;
  const dispenserL1 = process.env.DISPENSER_ADDRESS;
  const stakingFactoryL2 = process.env.STAKING_FACTORY_ADDRESS;

  if (!jinnL1 || !jinnL2 || !dispenserL1 || !stakingFactoryL2) {
    console.error(
      "Missing required env vars. Please set:\n" +
      "  JINN_TOKEN_L1          - JINN token address on Sepolia\n" +
      "  JINN_TOKEN_L2          - JINN token address on Base Sepolia\n" +
      "  DISPENSER_ADDRESS      - Dispenser address on Sepolia\n" +
      "  STAKING_FACTORY_ADDRESS - StakingFactory address on Base Sepolia\n"
    );
    process.exit(1);
  }

  const config: BridgeDeployConfig = {
    jinnL1,
    jinnL2,
    dispenserL1,
    stakingFactoryL2,
    l1TokenRelayer: process.env.L1_STANDARD_BRIDGE_PROXY ?? OP_STACK_SEPOLIA.L1StandardBridgeProxy,
    l1MessageRelayer: process.env.L1_CDM_PROXY ?? OP_STACK_SEPOLIA.L1CrossDomainMessengerProxy,
    l2MessageRelayer: process.env.L2_CDM_PROXY ?? OP_STACK_BASE_SEPOLIA.L2CrossDomainMessengerProxy,
    l2ChainId: BASE_SEPOLIA_CHAIN_ID,
    l1ChainId: SEPOLIA_CHAIN_ID,
  };

  console.log("Bridge configuration:");
  console.log(`  L1StandardBridgeProxy:       ${config.l1TokenRelayer}`);
  console.log(`  L1CrossDomainMessengerProxy: ${config.l1MessageRelayer}`);
  console.log(`  L2CrossDomainMessengerProxy: ${config.l2MessageRelayer}`);
  console.log(`  L2 Chain ID:                 ${config.l2ChainId}`);
  console.log(`  L1 Chain ID:                 ${config.l1ChainId}`);
  console.log();

  console.log("Deploying bridge contracts...\n");
  const deployment = await deployBridgeContracts(deployer, config);

  // Print summary
  console.log("\n=== Deployment Summary ===");
  console.log(`  OptimismDepositProcessorL1:  ${deployment.depositProcessorL1}`);
  console.log(`  OptimismTargetDispenserL2:   ${deployment.targetDispenserL2}`);

  // Write output JSON
  const output = {
    network: networkName,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    config: {
      jinnL1: config.jinnL1,
      jinnL2: config.jinnL2,
      dispenserL1: config.dispenserL1,
      stakingFactoryL2: config.stakingFactoryL2,
      l1TokenRelayer: config.l1TokenRelayer,
      l1MessageRelayer: config.l1MessageRelayer,
      l2MessageRelayer: config.l2MessageRelayer,
      l2ChainId: config.l2ChainId,
      l1ChainId: config.l1ChainId,
    },
    contracts: deployment,
  };

  const outPath = path.resolve(
    process.cwd(),
    `deployment-phase1a-bridge-${networkName}.json`
  );
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nDeployment written to: ${outPath}`);
}

// Only run when executed directly (not when imported by tests)
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
