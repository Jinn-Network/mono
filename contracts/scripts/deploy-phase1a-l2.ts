/**
 * Deploy the Jinn Phase 1a L2 staking infrastructure.
 *
 * This deploys the L2 side of the staking system: the StakingToken contract
 * that holds staked JINN and distributes rewards based on restoration activity.
 *
 * Components deployed:
 *   1. TestERC20 (JINN stand-in) — or accepts an existing token address
 *   2. ServiceRegistryStub — minimal service registry for testnet
 *   3. ServiceRegistryTokenUtilityStub — token deposit lookups
 *   4. RestorationActivityChecker — activity tracking for staking liveness
 *   5. StakingToken — initialized with JINN as the staking token
 *
 * Usage:
 *   npx hardhat run scripts/deploy-phase1a-l2.ts --network hardhat       # local
 *   npx hardhat run scripts/deploy-phase1a-l2.ts --network baseSepolia   # testnet
 *
 * Env vars:
 *   DEPLOYER_PRIVATE_KEY  - deployer wallet private key (required for live networks)
 *   JINN_TOKEN_ADDRESS    - address of bridged JINN token (optional; deploys test token if absent)
 *   LIVENESS_RATIO        - activity liveness ratio in 1e18 format (default: 1e15 = ~1 activity/1000s)
 *
 * Outputs:
 *   deployment-phase1a-l2-{network}.json  - JSON file with all contract addresses
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface L2DeployConfig {
  /** Existing JINN token address, or empty to deploy a test token. */
  jinnTokenAddress?: string;
  /** Liveness ratio (1e18 format). Default: 1e15 (~1 activity per 1000 seconds). */
  livenessRatio: bigint;
  /** Max number of services that can stake simultaneously. */
  maxNumServices: number;
  /** Rewards per second in token wei. */
  rewardsPerSecond: bigint;
  /** Minimum staking deposit in token wei. */
  minStakingDeposit: bigint;
  /** Min number of staking periods before unstaking. */
  minNumStakingPeriods: number;
  /** Max inactivity periods before eviction. */
  maxNumInactivityPeriods: number;
  /** Liveness period in seconds. */
  livenessPeriod: number;
  /** Time for emissions in seconds. */
  timeForEmissions: number;
  /** Number of agent instances per service. */
  numAgentInstances: number;
}

const DEFAULT_L2_CONFIG: L2DeployConfig = {
  livenessRatio: ethers.parseEther("0.001"), // 1e15
  maxNumServices: 100,
  rewardsPerSecond: ethers.parseEther("0.0001"), // ~8.64 JINN/day
  minStakingDeposit: ethers.parseEther("10"), // 10 JINN minimum
  minNumStakingPeriods: 3,
  maxNumInactivityPeriods: 2,
  livenessPeriod: 86400, // 1 day
  timeForEmissions: 2592000, // 30 days
  numAgentInstances: 1,
};

// ---------------------------------------------------------------------------
// Deployment types
// ---------------------------------------------------------------------------

export interface L2Deployment {
  jinnToken: string;
  serviceRegistry: string;
  serviceRegistryTokenUtility: string;
  activityChecker: string;
  stakingToken: string;
}

// ---------------------------------------------------------------------------
// Deploy function (exported for tests)
// ---------------------------------------------------------------------------

export async function deployL2Stack(
  deployer: ethers.Signer,
  config: L2DeployConfig = DEFAULT_L2_CONFIG
): Promise<L2Deployment> {
  const deployerAddress = await deployer.getAddress();

  // -----------------------------------------------------------------------
  // Step 1: JINN token (deploy test token or use existing)
  // -----------------------------------------------------------------------
  let jinnTokenAddress: string;
  if (config.jinnTokenAddress) {
    jinnTokenAddress = config.jinnTokenAddress;
    console.log(`  Using existing JINN token: ${jinnTokenAddress}`);
  } else {
    const TestERC20 = await ethers.getContractFactory("TestERC20", deployer);
    const testToken = await TestERC20.deploy("Jinn (Test)", "JINN");
    await testToken.waitForDeployment();
    jinnTokenAddress = await testToken.getAddress();
    console.log(`  Deployed test JINN token: ${jinnTokenAddress}`);
  }

  // -----------------------------------------------------------------------
  // Step 2: ServiceRegistryStub — minimal ERC721 service registry
  // -----------------------------------------------------------------------
  const ServiceRegistryStub = await ethers.getContractFactory("ServiceRegistryStub", deployer);
  const serviceRegistry = await ServiceRegistryStub.deploy();
  await serviceRegistry.waitForDeployment();
  const serviceRegistryAddress = await serviceRegistry.getAddress();
  console.log(`  Deployed ServiceRegistryStub: ${serviceRegistryAddress}`);

  // -----------------------------------------------------------------------
  // Step 3: ServiceRegistryTokenUtilityStub
  // -----------------------------------------------------------------------
  const TokenUtilityStub = await ethers.getContractFactory("ServiceRegistryTokenUtilityStub", deployer);
  const tokenUtility = await TokenUtilityStub.deploy();
  await tokenUtility.waitForDeployment();
  const tokenUtilityAddress = await tokenUtility.getAddress();
  console.log(`  Deployed ServiceRegistryTokenUtilityStub: ${tokenUtilityAddress}`);

  // -----------------------------------------------------------------------
  // Step 4: RestorationActivityChecker
  // -----------------------------------------------------------------------
  const ActivityChecker = await ethers.getContractFactory("RestorationActivityChecker", deployer);
  const activityChecker = await ActivityChecker.deploy(config.livenessRatio, deployerAddress);
  await activityChecker.waitForDeployment();
  const activityCheckerAddress = await activityChecker.getAddress();
  console.log(`  Deployed RestorationActivityChecker: ${activityCheckerAddress}`);

  // -----------------------------------------------------------------------
  // Step 5: StakingToken — deploy and initialize
  // -----------------------------------------------------------------------
  const StakingToken = await ethers.getContractFactory("StakingToken", deployer);
  const stakingToken = await StakingToken.deploy();
  await stakingToken.waitForDeployment();
  const stakingTokenAddress = await stakingToken.getAddress();
  console.log(`  Deployed StakingToken: ${stakingTokenAddress}`);

  // Build StakingParams. proxyHash is set to a dummy value for testnet since
  // we don't enforce multisig proxy verification in tests.
  // For a real deployment, this would be the codehash of the GnosisSafe proxy.
  const stakingParams = {
    metadataHash: ethers.id("jinn-l2-staking-v1"),
    maxNumServices: config.maxNumServices,
    rewardsPerSecond: config.rewardsPerSecond,
    minStakingDeposit: config.minStakingDeposit,
    minNumStakingPeriods: config.minNumStakingPeriods,
    maxNumInactivityPeriods: config.maxNumInactivityPeriods,
    livenessPeriod: config.livenessPeriod,
    timeForEmissions: config.timeForEmissions,
    numAgentInstances: config.numAgentInstances,
    agentIds: [] as number[],
    threshold: 0,
    configHash: ethers.ZeroHash,
    proxyHash: ethers.id("proxy-hash-placeholder"),
    serviceRegistry: serviceRegistryAddress,
    activityChecker: activityCheckerAddress,
  };

  const initTx = await stakingToken.initialize(
    stakingParams,
    tokenUtilityAddress,
    jinnTokenAddress
  );
  await initTx.wait();
  console.log(`  StakingToken initialized`);

  return {
    jinnToken: jinnTokenAddress,
    serviceRegistry: serviceRegistryAddress,
    serviceRegistryTokenUtility: tokenUtilityAddress,
    activityChecker: activityCheckerAddress,
    stakingToken: stakingTokenAddress,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;

  console.log("=== Jinn Phase 1a L2 Staking Deployment ===");
  console.log(`Network:  ${networkName} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(
    `Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`
  );
  console.log();

  const config: L2DeployConfig = { ...DEFAULT_L2_CONFIG };

  if (process.env.JINN_TOKEN_ADDRESS) {
    config.jinnTokenAddress = process.env.JINN_TOKEN_ADDRESS;
  }
  if (process.env.LIVENESS_RATIO) {
    config.livenessRatio = BigInt(process.env.LIVENESS_RATIO);
  }

  console.log("Deploying L2 staking stack...\n");
  const deployment = await deployL2Stack(deployer, config);

  // Print summary
  console.log("\n=== Deployment Summary ===");
  for (const [name, addr] of Object.entries(deployment)) {
    console.log(`  ${name.padEnd(35)} ${addr}`);
  }

  // Write output JSON
  const output = {
    network: networkName,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    config: {
      livenessRatio: config.livenessRatio.toString(),
      maxNumServices: config.maxNumServices,
      rewardsPerSecond: config.rewardsPerSecond.toString(),
      minStakingDeposit: config.minStakingDeposit.toString(),
      livenessPeriod: config.livenessPeriod,
      timeForEmissions: config.timeForEmissions,
    },
    contracts: deployment,
  };

  const outPath = path.resolve(
    process.cwd(),
    `deployment-phase1a-l2-${networkName}.json`
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
