/**
 * Hard-upgrade the deployed TaskCoordinator + JinnRouterV3 stack in-place.
 *
 * This preserves the public proxy addresses in
 * deployment-task-coordinator-router-v3-{network}{-fast}.json and updates only
 * the implementation pointers. It is the release path after the initial V3
 * proxy deployment.
 */

import { ethers } from "hardhat";
import type { TransactionRequest } from "ethers";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  getPhase1aArtifactSuffix,
  resolvePhase1aTimingProfile,
} from "./lib/phase1a-rollout-helpers";

const PROXY_ABI = [
  "function getAdmin() view returns (address)",
  "function getImplementation() view returns (address)",
  "function upgradeTo(address newImplementation) external",
];

const TASK_COORDINATOR_ABI = [
  "function authorizedRouter() view returns (address)",
  "function owner() view returns (address)",
];

const ROUTER_V3_ABI = [
  "function taskCoordinator() view returns (address)",
  "function mechMarketplace() view returns (address)",
  "function activityChecker() view returns (address)",
];

const CHECKER_ABI = [
  "function owner() view returns (address)",
  "function authorizedRouter() view returns (address)",
  "function setAuthorizedRouter(address newAuthorizedRouter) external",
  "function changeImplementation(address newImplementation) external",
  "function taskCreationWeight(address operator) view returns (uint256)",
];

function normalizeNetworkName(networkName: string): string {
  return networkName === "base-sepolia" ? "baseSepolia" : networkName;
}

function liveL2TxOverrides(): TransactionRequest {
  return {
    maxFeePerGas: ethers.parseUnits(process.env.BASE_SEPOLIA_MAX_FEE_GWEI ?? "2", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits(process.env.BASE_SEPOLIA_PRIORITY_FEE_GWEI ?? "1", "gwei"),
  };
}

function deployGasLimit(kind: "standard" | "call"): bigint {
  if (kind === "call") {
    return BigInt(process.env.BASE_SEPOLIA_CALL_GAS_LIMIT ?? "500000");
  }
  return BigInt(process.env.BASE_SEPOLIA_DEPLOY_GAS_LIMIT ?? "2500000");
}

function withGas(tx: TransactionRequest, kind: "standard" | "call"): TransactionRequest {
  return { ...tx, gasLimit: deployGasLimit(kind) };
}

async function getDeployer() {
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  if (networkName === "hardhat" || networkName === "localhost") {
    const [deployer] = await ethers.getSigners();
    return deployer;
  }

  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("DEPLOYER_PRIVATE_KEY is required for live upgrades.");
  }
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
  return new Wallet(process.env.DEPLOYER_PRIVATE_KEY, new JsonRpcProvider(rpcUrl));
}

function deploymentPath(networkName: string): string {
  const explicit = process.env.TASK_V3_DEPLOYMENT_PATH?.trim();
  if (explicit) return path.resolve(process.cwd(), explicit);

  const timingProfile = resolvePhase1aTimingProfile();
  const suffix = getPhase1aArtifactSuffix(timingProfile);
  return path.resolve(
    process.cwd(),
    `deployment-task-coordinator-router-v3-${normalizeNetworkName(networkName)}${suffix}.json`,
  );
}

function requireAddress(label: string, value: unknown): string {
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw new Error(`${label} is missing or invalid: ${String(value)}`);
  }
  return value;
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const normalizedNetwork = normalizeNetworkName(networkName);
  const deployer = await getDeployer();
  const deployerAddress = await deployer.getAddress();
  const provider = deployer.provider ?? ethers.provider;
  const txOverrides = networkName === "hardhat" || networkName === "localhost" ? {} : liveL2TxOverrides();
  let nextNonce = await provider.getTransactionCount(deployerAddress, "pending");
  const withNonce = (tx: TransactionRequest): TransactionRequest => ({ ...tx, nonce: nextNonce++ });

  const artifactPath = deploymentPath(normalizedNetwork);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
    contracts?: Record<string, string>;
    upgrades?: unknown[];
    [key: string]: unknown;
  };
  const contracts = artifact.contracts ?? {};
  const taskCoordinator = requireAddress("contracts.taskCoordinator", contracts.taskCoordinator);
  const router = requireAddress("contracts.jinnRouterV3", contracts.jinnRouterV3);
  const activityChecker = requireAddress("contracts.activityChecker", contracts.activityChecker);
  const marketplace = requireAddress("contracts.mechMarketplace", contracts.mechMarketplace);

  console.log("=== TaskCoordinator + JinnRouterV3 Hard Upgrade ===");
  console.log(`Network:       ${normalizedNetwork} (chainId: ${network.chainId})`);
  console.log(`Deployer:      ${deployerAddress}`);
  console.log(`Artifact:      ${artifactPath}`);
  console.log(`Coordinator:   ${taskCoordinator}`);
  console.log(`Router V3:     ${router}`);
  console.log(`Checker:       ${activityChecker}`);
  console.log(`Marketplace:   ${marketplace}`);
  console.log(`Balance:       ${ethers.formatEther(await provider.getBalance(deployerAddress))} ETH`);
  console.log();

  const coordinatorProxy = new ethers.Contract(taskCoordinator, PROXY_ABI, deployer);
  const routerProxy = new ethers.Contract(router, PROXY_ABI, deployer);
  const checker = new ethers.Contract(activityChecker, CHECKER_ABI, deployer);

  const [coordinatorAdmin, routerAdmin, checkerOwner] = await Promise.all([
    coordinatorProxy.getAdmin(),
    routerProxy.getAdmin(),
    checker.owner(),
  ]);
  for (const [label, owner] of [
    ["TaskCoordinator proxy admin", coordinatorAdmin],
    ["JinnRouterV3 proxy admin", routerAdmin],
    ["TaskActivityChecker owner", checkerOwner],
  ] as const) {
    if (owner.toLowerCase() !== deployerAddress.toLowerCase()) {
      throw new Error(`${label} ${owner} is not deployer ${deployerAddress}`);
    }
  }

  const previous = {
    taskCoordinatorImpl: String(await coordinatorProxy.getImplementation()),
    jinnRouterV3Impl: String(await routerProxy.getImplementation()),
    activityCheckerImpl: contracts.activityCheckerImpl ?? null,
  };

  console.log("Step 1: Deploying fresh implementations...");
  const CoordinatorFactory = await ethers.getContractFactory("TaskCoordinator", deployer);
  const RouterFactory = await ethers.getContractFactory("JinnRouterV3", deployer);
  const CheckerFactory = await ethers.getContractFactory("TaskActivityCheckerV3", deployer);

  const coordinatorImpl = await CoordinatorFactory.deploy(withNonce(withGas(txOverrides, "standard")));
  await coordinatorImpl.waitForDeployment();
  const coordinatorImplAddress = await coordinatorImpl.getAddress();
  console.log(`  TaskCoordinator impl: ${coordinatorImplAddress}`);

  const routerImpl = await RouterFactory.deploy(withNonce(withGas(txOverrides, "standard")));
  await routerImpl.waitForDeployment();
  const routerImplAddress = await routerImpl.getAddress();
  console.log(`  JinnRouterV3 impl:     ${routerImplAddress}`);

  const checkerImpl = await CheckerFactory.deploy(withNonce(withGas(txOverrides, "standard")));
  await checkerImpl.waitForDeployment();
  const checkerImplAddress = await checkerImpl.getAddress();
  console.log(`  Checker impl:          ${checkerImplAddress}`);

  console.log("Step 2: Upgrading proxies...");
  const upgradeCoordinator = await coordinatorProxy.upgradeTo(
    coordinatorImplAddress,
    withNonce(withGas(txOverrides, "call")),
  );
  await upgradeCoordinator.wait();
  console.log("  TaskCoordinator proxy upgraded.");

  const upgradeRouter = await routerProxy.upgradeTo(
    routerImplAddress,
    withNonce(withGas(txOverrides, "call")),
  );
  await upgradeRouter.wait();
  console.log("  JinnRouterV3 proxy upgraded.");

  const upgradeChecker = await checker.changeImplementation(
    checkerImplAddress,
    withNonce(withGas(txOverrides, "call")),
  );
  await upgradeChecker.wait();
  console.log("  Activity checker proxy upgraded.");

  console.log("Step 3: Rewiring checker authorization...");
  const currentAuthorizedRouter = await checker.authorizedRouter();
  if (currentAuthorizedRouter.toLowerCase() !== router.toLowerCase()) {
    const wire = await checker.setAuthorizedRouter(router, withNonce(withGas(txOverrides, "call")));
    await wire.wait();
    console.log("  Activity checker authorizedRouter set.");
  } else {
    console.log("  Activity checker already authorizes JinnRouterV3.");
  }

  console.log("Step 4: Verifying live wiring...");
  const coordinator = new ethers.Contract(taskCoordinator, TASK_COORDINATOR_ABI, deployer);
  const routerContract = new ethers.Contract(router, ROUTER_V3_ABI, deployer);
  const [
    storedCoordinatorImpl,
    storedRouterImpl,
    storedAuthorizedRouter,
    storedRouterCoordinator,
    storedMarketplace,
    storedActivityChecker,
    storedCheckerRouter,
  ] = await Promise.all([
    coordinatorProxy.getImplementation(),
    routerProxy.getImplementation(),
    coordinator.authorizedRouter(),
    routerContract.taskCoordinator(),
    routerContract.mechMarketplace(),
    routerContract.activityChecker(),
    checker.authorizedRouter(),
  ]);

  const assertSame = (label: string, actual: string, expected: string) => {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${label} mismatch: got ${actual}, expected ${expected}`);
    }
  };
  assertSame("Coordinator implementation", storedCoordinatorImpl, coordinatorImplAddress);
  assertSame("Router implementation", storedRouterImpl, routerImplAddress);
  assertSame("Coordinator authorizedRouter", storedAuthorizedRouter, router);
  assertSame("Router taskCoordinator", storedRouterCoordinator, taskCoordinator);
  assertSame("Router mechMarketplace", storedMarketplace, marketplace);
  assertSame("Router activityChecker", storedActivityChecker, activityChecker);
  assertSame("Checker authorizedRouter", storedCheckerRouter, router);
  await checker.taskCreationWeight(deployerAddress);
  console.log("  Live wiring verified.");

  artifact.deployedAt = new Date().toISOString();
  artifact.contracts = {
    ...contracts,
    taskCoordinatorImpl: coordinatorImplAddress,
    jinnRouterV3Impl: routerImplAddress,
    activityCheckerImpl: checkerImplAddress,
  };
  artifact.upgrades = [
    ...((Array.isArray(artifact.upgrades) ? artifact.upgrades : []) as unknown[]),
    {
      upgradedAt: artifact.deployedAt,
      deployer: deployerAddress,
      previous,
      current: {
        taskCoordinatorImpl: coordinatorImplAddress,
        jinnRouterV3Impl: routerImplAddress,
        activityCheckerImpl: checkerImplAddress,
      },
    },
  ];
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`\nUpdated deployment artifact: ${artifactPath}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
