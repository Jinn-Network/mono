/**
 * Deploy the clean-break TaskCoordinator + JinnRouterV3 stack.
 *
 * Local Anvil/Hardhat:
 *   - Deploys a mock marketplace and a real TaskActivityCheckerV3 so the proxy
 *     wiring can be exercised without a full OLAS stack.
 *
 * Live Base Sepolia:
 *   - Reuses the already deployed Mech marketplace.
 *   - Upgrades/reuses the deployed activity checker proxy as TaskActivityCheckerV3.
 *   - Resolve addresses by direct env first, then deployment artifacts.
 *
 * Optional env:
 *   JINN_V3_OWNER                  final owner/admin; defaults to deployer
 *   MECH_MARKETPLACE_ADDRESS       direct marketplace address
 *   JINN_MECH_MARKETPLACE_ADDRESS  alias for MECH_MARKETPLACE_ADDRESS
 *   MECH_DEPLOYMENT_PATH           artifact with contracts.mechMarketplace
 *   ACTIVITY_CHECKER_ADDRESS       direct activity checker address
 *   JINN_ACTIVITY_CHECKER_ADDRESS  alias for ACTIVITY_CHECKER_ADDRESS
 *   ROUTER_CHECKER_DEPLOYMENT_PATH artifact with contracts.activityChecker
 *   BASE_SEPOLIA_RPC_URL           live RPC
 *   DEPLOYER_PRIVATE_KEY           live deployer
 */

import { ethers } from "hardhat";
import type { Signer, TransactionRequest } from "ethers";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  getPhase1aArtifactSuffix,
  resolvePhase1aTimingProfile,
} from "./lib/phase1a-rollout-helpers";

const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);
const DEFAULT_MECH_ARTIFACT = "deployment-phase1b-mech-baseSepolia-fast.json";
const DEFAULT_ROUTER_CHECKER_ARTIFACT = "deployment-phase1b-router-checker-baseSepolia-fast.json";
const TASK_ACTIVITY_CHECKER_V3_ROUTER_ABI = [
  "function owner() view returns (address)",
  "function authorizedRouter() view returns (address)",
  "function taskCreationWeight(address) view returns (uint256)",
  "function setAuthorizedRouter(address newAuthorizedRouter) external",
  "function changeImplementation(address newImplementation) external",
];

function isLocalNetwork(networkName: string): boolean {
  return LOCAL_NETWORKS.has(networkName);
}

async function getDeployerSigner(networkName: string): Promise<Signer> {
  if (isLocalNetwork(networkName)) {
    const [deployer] = await ethers.getSigners();
    return deployer;
  }

  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY is required for live deployments.");
  }

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
  return new Wallet(privateKey, new JsonRpcProvider(rpcUrl));
}

function liveL2TxOverrides(): TransactionRequest {
  const maxFeeGwei = process.env.BASE_SEPOLIA_MAX_FEE_GWEI ?? "2";
  const prioGwei = process.env.BASE_SEPOLIA_PRIORITY_FEE_GWEI ?? "1";
  return {
    maxFeePerGas: ethers.parseUnits(maxFeeGwei, "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits(prioGwei, "gwei"),
  };
}

function deployGasLimit(kind: "standard" | "large" | "call"): bigint {
  if (kind === "large") {
    const raw = process.env.BASE_SEPOLIA_STAKING_TOKEN_DEPLOY_GAS?.trim();
    return raw ? BigInt(raw) : 5_000_000n;
  }
  if (kind === "call") {
    const raw = process.env.BASE_SEPOLIA_CALL_GAS_LIMIT?.trim();
    return raw ? BigInt(raw) : 500_000n;
  }
  const raw = process.env.BASE_SEPOLIA_DEPLOY_GAS_LIMIT?.trim();
  return raw ? BigInt(raw) : 2_500_000n;
}

function withGas(
  tx: TransactionRequest,
  kind: "standard" | "large" | "call",
  local = false,
): TransactionRequest {
  if (local) return tx;
  return { ...tx, gasLimit: deployGasLimit(kind) };
}

function normalizeNetworkName(networkName: string): string {
  if (networkName === "base-sepolia") return "baseSepolia";
  return networkName;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryRpcRead<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < 8) {
        console.log(`  ${label} read not settled yet; retrying (${attempt}/8)...`);
        await sleep(3_000);
      }
    }
  }
  throw lastError;
}

function readArtifactAddress(
  artifactPath: string,
  contractKey: string,
): string {
  const resolved = path.resolve(process.cwd(), artifactPath);
  const artifact = JSON.parse(fs.readFileSync(resolved, "utf8")) as {
    contracts?: Record<string, string | undefined>;
  };
  const address = artifact.contracts?.[contractKey];
  if (!address || !ethers.isAddress(address)) {
    throw new Error(
      `${artifactPath} is missing a valid contracts.${contractKey}. Got: ${address}`,
    );
  }
  return address;
}

function existingArtifactPath(candidate: string): string | null {
  const resolved = path.resolve(process.cwd(), candidate);
  return fs.existsSync(resolved) ? candidate : null;
}

function resolveLiveAddress(params: {
  label: string;
  directEnvNames: string[];
  artifactEnvName: string;
  defaultArtifact: string;
  artifactKey: string;
}): { address: string; source: string } {
  for (const envName of params.directEnvNames) {
    const raw = process.env[envName]?.trim();
    if (raw) {
      if (!ethers.isAddress(raw)) {
        throw new Error(`Invalid ${envName}: ${raw}`);
      }
      return { address: raw, source: envName };
    }
  }

  const artifactPath =
    process.env[params.artifactEnvName]?.trim() ||
    existingArtifactPath(params.defaultArtifact);

  if (!artifactPath) {
    throw new Error(
      `${params.label} is required on live networks. Set ${params.directEnvNames[0]} ` +
        `or ${params.artifactEnvName}.`,
    );
  }

  return {
    address: readArtifactAddress(artifactPath, params.artifactKey),
    source: artifactPath,
  };
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const normalizedNetwork = normalizeNetworkName(networkName);
  const local = isLocalNetwork(networkName);
  const deployer = await getDeployerSigner(networkName);
  const deployerAddress = await deployer.getAddress();
  const balanceProvider =
    deployer.provider ?? (local ? ethers.provider : undefined);
  if (!balanceProvider) {
    throw new Error("Deployer signer is missing a provider; cannot read ETH balance.");
  }

  const finalOwner = process.env.JINN_V3_OWNER?.trim() || deployerAddress;
  if (!ethers.isAddress(finalOwner)) {
    throw new Error(`Invalid JINN_V3_OWNER: ${finalOwner}`);
  }

  console.log("=== TaskCoordinator + JinnRouterV3 Deployment ===");
  console.log(`Network:  ${normalizedNetwork} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Owner:    ${finalOwner}`);
  console.log(
    `Balance:  ${ethers.formatEther(await balanceProvider.getBalance(deployerAddress))} ETH`,
  );
  console.log();

  const txOverrides: TransactionRequest = local ? {} : liveL2TxOverrides();
  const gas = (tx: TransactionRequest, kind: "standard" | "large" | "call") =>
    withGas(tx, kind, local);

  let nextNonce: number | undefined;
  const withNonce = async (base: TransactionRequest): Promise<TransactionRequest> => {
    if (nextNonce === undefined) {
      nextNonce = await balanceProvider.getTransactionCount(deployerAddress, "pending");
    }
    const out = { ...base, nonce: nextNonce };
    nextNonce += 1;
    return out;
  };

  let mechMarketplaceAddress: string;
  let activityCheckerAddress: string;
  let activityCheckerImplAddress: string | null = null;
  let localMarketplaceMock: string | null = null;
  let mechMarketplaceSource: string;
  let activityCheckerSource: string;

  if (local) {
    console.log("Step 0a: Deploying local mock marketplace...");
    const MarketplaceMockFactory = await ethers.getContractFactory("MockTaskMarketplace", deployer);
    const marketplaceMock = await MarketplaceMockFactory.deploy(
      await withNonce(gas(txOverrides, "standard")),
    );
    await marketplaceMock.waitForDeployment();
    localMarketplaceMock = await marketplaceMock.getAddress();
    mechMarketplaceAddress = localMarketplaceMock;
    mechMarketplaceSource = "local mock";
    console.log(`  MockTaskMarketplace: ${localMarketplaceMock}`);

    console.log("Step 0b: Deploying local TaskActivityCheckerV3...");
    const ActivityCheckerFactory = await ethers.getContractFactory("TaskActivityCheckerV3", deployer);
    const activityChecker = await ActivityCheckerFactory.deploy(
      await withNonce(gas(txOverrides, "standard")),
    );
    await activityChecker.waitForDeployment();
    activityCheckerAddress = await activityChecker.getAddress();
    activityCheckerImplAddress = activityCheckerAddress;
    await (await activityChecker.initialize(
      ethers.parseEther("0.001"),
      deployerAddress,
      64,
      0,
      20,
      await withNonce(gas(txOverrides, "call")),
    )).wait();
    activityCheckerSource = "local TaskActivityCheckerV3";
    console.log(`  TaskActivityCheckerV3: ${activityCheckerAddress}`);
  } else {
    const mech = resolveLiveAddress({
      label: "Mech marketplace",
      directEnvNames: ["MECH_MARKETPLACE_ADDRESS", "JINN_MECH_MARKETPLACE_ADDRESS"],
      artifactEnvName: "MECH_DEPLOYMENT_PATH",
      defaultArtifact: DEFAULT_MECH_ARTIFACT,
      artifactKey: "mechMarketplace",
    });
    mechMarketplaceAddress = mech.address;
    mechMarketplaceSource = mech.source;

    const checker = resolveLiveAddress({
      label: "Activity checker",
      directEnvNames: ["ACTIVITY_CHECKER_ADDRESS", "JINN_ACTIVITY_CHECKER_ADDRESS"],
      artifactEnvName: "ROUTER_CHECKER_DEPLOYMENT_PATH",
      defaultArtifact: DEFAULT_ROUTER_CHECKER_ARTIFACT,
      artifactKey: "activityChecker",
    });
    activityCheckerAddress = checker.address;
    activityCheckerSource = checker.source;

    console.log("Step 0b: Verifying/upgrading live activity checker to TaskActivityCheckerV3...");
    const checkerContract = new ethers.Contract(
      activityCheckerAddress,
      TASK_ACTIVITY_CHECKER_V3_ROUTER_ABI,
      deployer,
    );
    const checkerOwner = await retryRpcRead("activityChecker.owner", () =>
      checkerContract.owner(),
    );
    if (checkerOwner.toLowerCase() !== deployerAddress.toLowerCase()) {
      throw new Error(
        `Activity checker owner ${checkerOwner} is not deployer ${deployerAddress}; ` +
          "TaskActivityCheckerV3 upgrade/wiring must be called by the checker owner.",
      );
    }
    let alreadyV3 = false;
    try {
      await checkerContract.taskCreationWeight(deployerAddress);
      alreadyV3 = true;
    } catch {
      alreadyV3 = false;
    }
    if (alreadyV3) {
      console.log("  Activity checker already exposes TaskActivityCheckerV3 getters.");
    } else {
      const ActivityCheckerFactory = await ethers.getContractFactory("TaskActivityCheckerV3", deployer);
      const activityCheckerImpl = await ActivityCheckerFactory.deploy(
        await withNonce(gas(txOverrides, "standard")),
      );
      await activityCheckerImpl.waitForDeployment();
      activityCheckerImplAddress = await activityCheckerImpl.getAddress();
      console.log(`  TaskActivityCheckerV3 impl: ${activityCheckerImplAddress}`);

      const upgradeTx = await checkerContract.changeImplementation(
        activityCheckerImplAddress,
        await withNonce(gas(txOverrides, "call")),
      );
      await upgradeTx.wait();
      console.log("  Activity checker proxy upgraded to TaskActivityCheckerV3.");
    }
  }

  console.log();
  console.log(`MechMarketplace: ${mechMarketplaceAddress} (${mechMarketplaceSource})`);
  console.log(`ActivityChecker: ${activityCheckerAddress} (${activityCheckerSource})`);
  console.log();

  console.log("Step 1: Deploying TaskCoordinator implementation...");
  const CoordinatorFactory = await ethers.getContractFactory("TaskCoordinator", deployer);
  const coordinatorImpl = await CoordinatorFactory.deploy(
    await withNonce(gas(txOverrides, "standard")),
  );
  await coordinatorImpl.waitForDeployment();
  const coordinatorImplAddress = await coordinatorImpl.getAddress();
  console.log(`  TaskCoordinator impl: ${coordinatorImplAddress}`);

  console.log("Step 2: Deploying TaskCoordinator proxy...");
  const ProxyFactory = await ethers.getContractFactory("JinnUpgradeableProxy", deployer);
  const coordinatorInitData = coordinatorImpl.interface.encodeFunctionData("initialize", [
    deployerAddress,
    deployerAddress,
  ]);
  const coordinatorProxy = await ProxyFactory.deploy(
    coordinatorImplAddress,
    finalOwner,
    coordinatorInitData,
    await withNonce(gas(txOverrides, "standard")),
  );
  await coordinatorProxy.waitForDeployment();
  const coordinatorProxyAddress = await coordinatorProxy.getAddress();
  const coordinator = CoordinatorFactory.attach(coordinatorProxyAddress) as typeof coordinatorImpl;
  console.log(`  TaskCoordinator proxy: ${coordinatorProxyAddress}`);

  console.log("Step 3: Deploying JinnRouterV3 implementation...");
  const RouterFactory = await ethers.getContractFactory("JinnRouterV3", deployer);
  const routerImpl = await RouterFactory.deploy(await withNonce(gas(txOverrides, "standard")));
  await routerImpl.waitForDeployment();
  const routerImplAddress = await routerImpl.getAddress();
  console.log(`  JinnRouterV3 impl: ${routerImplAddress}`);

  console.log("Step 4: Deploying JinnRouterV3 proxy...");
  const routerInitData = routerImpl.interface.encodeFunctionData("initialize", [
    finalOwner,
    mechMarketplaceAddress,
    coordinatorProxyAddress,
    activityCheckerAddress,
  ]);
  const routerProxy = await ProxyFactory.deploy(
    routerImplAddress,
    finalOwner,
    routerInitData,
    await withNonce(gas(txOverrides, "standard")),
  );
  await routerProxy.waitForDeployment();
  const routerProxyAddress = await routerProxy.getAddress();
  const router = RouterFactory.attach(routerProxyAddress) as typeof routerImpl;
  console.log(`  JinnRouterV3 proxy: ${routerProxyAddress}`);

  console.log("Step 5: Wiring TaskCoordinator authorized router...");
  const setRouterTx = await coordinator.setAuthorizedRouter(
    routerProxyAddress,
    await withNonce(gas(txOverrides, "call")),
  );
  await setRouterTx.wait();
  console.log("  TaskCoordinator authorized router set.");

  {
    console.log("Step 6: Wiring activity checker to JinnRouterV3...");
    const checker = new ethers.Contract(
      activityCheckerAddress,
      TASK_ACTIVITY_CHECKER_V3_ROUTER_ABI,
      deployer,
    );
    const checkerOwner = await retryRpcRead("activityChecker.owner", () =>
      checker.owner(),
    );
    if (checkerOwner.toLowerCase() !== deployerAddress.toLowerCase()) {
      throw new Error(
        `Activity checker owner ${checkerOwner} is not deployer ${deployerAddress}; ` +
          "setAuthorizedRouter must be called by the checker owner.",
      );
    }
    const currentAuthorizedRouter = await retryRpcRead(
      "activityChecker.authorizedRouter",
      () => checker.authorizedRouter(),
    );
    if (currentAuthorizedRouter.toLowerCase() !== routerProxyAddress.toLowerCase()) {
      const wireCheckerTx = await checker.setAuthorizedRouter(
        routerProxyAddress,
        await withNonce(gas(txOverrides, "call")),
      );
      await wireCheckerTx.wait();
      console.log("  Activity checker authorizedRouter set.");
    } else {
      console.log("  Activity checker already authorizes JinnRouterV3.");
    }
  }

  if (finalOwner.toLowerCase() !== deployerAddress.toLowerCase()) {
    console.log("Step 7: Transferring TaskCoordinator ownership to final owner...");
    const transferTx = await coordinator.transferOwnership(
      finalOwner,
      await withNonce(gas(txOverrides, "call")),
    );
    await transferTx.wait();
    console.log("  TaskCoordinator ownership transferred.");
  } else {
    console.log("Step 7: Final owner is deployer; ownership transfer skipped.");
  }

  console.log("Step 8: Verifying proxy initialization...");
  const storedRouter = await retryRpcRead("coordinator.authorizedRouter", () =>
    coordinator.authorizedRouter(),
  );
  const storedCoordinator = await retryRpcRead("router.taskCoordinator", () =>
    router.taskCoordinator(),
  );
  const storedMarketplace = await retryRpcRead("router.mechMarketplace", () =>
    router.mechMarketplace(),
  );
  const storedActivityChecker = await retryRpcRead("router.activityChecker", () =>
    router.activityChecker(),
  );
  if (storedRouter.toLowerCase() !== routerProxyAddress.toLowerCase()) {
    throw new Error(`Coordinator router mismatch: ${storedRouter}`);
  }
  if (storedCoordinator.toLowerCase() !== coordinatorProxyAddress.toLowerCase()) {
    throw new Error(`Router coordinator mismatch: ${storedCoordinator}`);
  }
  if (storedMarketplace.toLowerCase() !== mechMarketplaceAddress.toLowerCase()) {
    throw new Error(`Router marketplace mismatch: ${storedMarketplace}`);
  }
  if (storedActivityChecker.toLowerCase() !== activityCheckerAddress.toLowerCase()) {
    throw new Error(`Router activity checker mismatch: ${storedActivityChecker}`);
  }
  if (!local) {
    const checker = new ethers.Contract(
      activityCheckerAddress,
      TASK_ACTIVITY_CHECKER_V3_ROUTER_ABI,
      deployer,
    );
    const storedAuthorizedRouter = await retryRpcRead(
      "activityChecker.authorizedRouter",
      () => checker.authorizedRouter(),
    );
    if (storedAuthorizedRouter.toLowerCase() !== routerProxyAddress.toLowerCase()) {
      throw new Error(`Activity checker authorized router mismatch: ${storedAuthorizedRouter}`);
    }
  }
  console.log("  Proxy initialization verified.");

  console.log("\n=== Deployment Summary ===");
  const summary: Record<string, string> = {
    taskCoordinatorImpl: coordinatorImplAddress,
    taskCoordinator: coordinatorProxyAddress,
    jinnRouterV3Impl: routerImplAddress,
    jinnRouterV3: routerProxyAddress,
    mechMarketplace: mechMarketplaceAddress,
    activityChecker: activityCheckerAddress,
    ...(activityCheckerImplAddress ? { activityCheckerImpl: activityCheckerImplAddress } : {}),
  };
  for (const [name, value] of Object.entries(summary)) {
    console.log(`  ${name.padEnd(24)} ${value}`);
  }

  const timingProfile = resolvePhase1aTimingProfile();
  const suffix = getPhase1aArtifactSuffix(timingProfile);
  const artifactName = `deployment-task-coordinator-router-v3-${normalizedNetwork}${suffix}.json`;
  const output = {
    network: normalizedNetwork,
    chainId: Number(network.chainId),
    deployer: deployerAddress,
    owner: finalOwner,
    deployedAt: new Date().toISOString(),
    config: {
      timingProfile,
      mechMarketplaceSource,
      activityCheckerSource,
      coordinatorInitialOwner: deployerAddress,
    },
    contracts: {
      taskCoordinatorImpl: coordinatorImplAddress,
      taskCoordinator: coordinatorProxyAddress,
      jinnRouterV3Impl: routerImplAddress,
      jinnRouterV3: routerProxyAddress,
      mechMarketplace: mechMarketplaceAddress,
      activityChecker: activityCheckerAddress,
      ...(activityCheckerImplAddress ? { activityCheckerImpl: activityCheckerImplAddress } : {}),
      ...(localMarketplaceMock ? { localMarketplaceMock } : {}),
    },
  };

  const outPath = path.resolve(process.cwd(), artifactName);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nDeployment artifact written to: ${outPath}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
