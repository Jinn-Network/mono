import { isRunEntry } from "./lib/run-entry.js";
/**
 * Clean-break stOLAS staking re-wire: deploy a fresh StakingToken proxy that
 * reads the TaskActivityCheckerV3 from the V3 router stack, register it on the
 * stOLAS distributor, and optionally fund reward headroom.
 *
 * The legacy Phase 1b proxy (0xf358…) is immutable-wired to ActivityCheckerV2;
 * loop activity recorded by JinnRouterV3 lands on the V3 checker instead. This
 * script closes that gap without touching the V2 checker or the old proxy.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... \
 *   npx hardhat run scripts/rewire-stolas-staking-for-v3.ts --network baseSepolia
 *
 * Optional env:
 *   TASK_V3_DEPLOYMENT_PATH — V3 artifact (default: deployment-task-coordinator-router-v3-baseSepolia-fast.json)
 *   STOLAS_L2_DEPLOYMENT_PATH — stOLAS artifact (default: deployment-stolas-l2-baseSepolia-fast.json)
 *   PHASE1A_L2_DEPLOYMENT_PATH — Phase 1a L2 artifact for factory/impl (default: deployment-phase1a-l2-baseSepolia-fast.json)
 *   LEGACY_STAKING_PROXY — proxy to copy distributor config from (default: 0xf358…)
 *   STAKING_FUND_WEI — JINN-as-OLAS to transfer into fresh proxy (default: 100e18)
 *   SKIP_FUND=1 — skip the reward-pool transfer
 */

import { network } from "hardhat";
import type { TransactionRequest } from "ethers";
import { ethers as ethersLib, Interface, JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  getPhase1aArtifactSuffix,
  resolvePhase1aTimingProfile,
} from "./lib/phase1a-rollout-helpers.js";

type HardhatEthers = Awaited<ReturnType<typeof network.connect>>["ethers"];

const LEGACY_STAKING_PROXY_DEFAULT = "0xf358b5c1ac4ddc4e807b5baf008826bf193eab3b";

const STAKING_FACTORY_ABI = [
  "function createStakingInstance(address implementation, bytes initPayload) returns (address)",
  "event InstanceCreated(address indexed instance, address indexed implementation)",
];

const DISTRIBUTOR_ABI = [
  "function owner() view returns (address)",
  "function stakingProxyConfigs(address stakingProxy) view returns (uint256)",
  "function setStakingProxyConfigs(address[] stakingProxies, uint256[] configs) external",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

function normalizeNetworkName(networkName: string): string {
  return networkName === "base-sepolia" ? "baseSepolia" : networkName;
}

function liveL2TxOverrides(): TransactionRequest {
  return {
    maxFeePerGas: ethersLib.parseUnits(process.env.BASE_SEPOLIA_MAX_FEE_GWEI ?? "2", "gwei"),
    maxPriorityFeePerGas: ethersLib.parseUnits(process.env.BASE_SEPOLIA_PRIORITY_FEE_GWEI ?? "1", "gwei"),
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

async function getDeployer(ethers: HardhatEthers) {
  const net = await ethers.provider.getNetwork();
  const networkName = net.name === "unknown" ? "hardhat" : net.name;
  if (networkName === "hardhat" || networkName === "localhost") {
    const [deployer] = await ethers.getSigners();
    return deployer;
  }
  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("DEPLOYER_PRIVATE_KEY is required for live re-wire.");
  }
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
  return new Wallet(process.env.DEPLOYER_PRIVATE_KEY, new JsonRpcProvider(rpcUrl));
}

function readArtifact(filePath: string): Record<string, unknown> {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Artifact not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8")) as Record<string, unknown>;
}

function requireContractAddress(
  artifact: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const contracts = artifact.contracts as Record<string, string | undefined> | undefined;
  const value = contracts?.[key];
  if (!value || !ethersLib.isAddress(value)) {
    throw new Error(`${label} missing contracts.${key} in artifact`);
  }
  return value;
}

/**
 * Pack staking proxy config for setStakingProxyConfigs().
 * Bit layout: stakingGuard(160) | collector(16) | protocol(16) | curating(16) | type(8)
 */
function packStakingConfig(
  stakingGuard: string,
  collectorRewardFactor: number,
  protocolRewardFactor: number,
  curatingAgentRewardFactor: number,
  stakingType: number,
): bigint {
  return (
    BigInt(stakingType) |
    (BigInt(curatingAgentRewardFactor) << 8n) |
    (BigInt(protocolRewardFactor) << 24n) |
    (BigInt(collectorRewardFactor) << 40n) |
    (BigInt(stakingGuard) << 56n)
  );
}

function parseStakingInstanceAddress(
  receipt: { logs: Array<{ address?: string; topics: string[]; data: string }> },
  factoryAddress: string,
  factory: { interface: Interface },
): string | null {
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed?.name === "InstanceCreated") {
        return String(parsed.args[0]);
      }
    } catch {
      // not our event
    }
  }
  const factoryLower = factoryAddress.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== factoryLower) continue;
    if (log.topics.length >= 3) {
      const topic = log.topics[2];
      if (topic && topic.length === 66) {
        return ethersLib.getAddress(`0x${topic.slice(-40)}`);
      }
    }
  }
  return null;
}

async function main() {
  const { ethers } = await network.connect();
  const net = await ethers.provider.getNetwork();
  const networkName = net.name === "unknown" ? "hardhat" : net.name;
  const normalizedNetwork = normalizeNetworkName(networkName);
  const deployer = await getDeployer(ethers);
  const deployerAddress = await deployer.getAddress();
  const provider = deployer.provider ?? ethers.provider;
  const local = networkName === "hardhat" || networkName === "localhost";

  // Safety: this script mutates on-chain state (creates a staking proxy, calls
  // setStakingProxyConfigs on the stOLAS distributor, and transfers the bond/reward
  // token). Refuse to run against anything but Base Sepolia unless on a local fork —
  // a misdirected run could send the funding transfer to mainnet.
  if (!local && net.chainId !== 84532n) {
    throw new Error(
      `Refusing to run: expected Base Sepolia (chainId 84532) but connected to chainId ` +
        `${net.chainId}. Pass --network baseSepolia or point at a Base Sepolia RPC.`,
    );
  }

  const txOverrides = local ? {} : liveL2TxOverrides();
  let nextNonce = await provider.getTransactionCount(deployerAddress, "pending");
  const withNonce = (tx: TransactionRequest): TransactionRequest => ({ ...tx, nonce: nextNonce++ });

  const timingProfile = resolvePhase1aTimingProfile();
  const suffix = getPhase1aArtifactSuffix(timingProfile);

  const v3Path =
    process.env.TASK_V3_DEPLOYMENT_PATH?.trim() ||
    `deployment-task-coordinator-router-v3-${normalizedNetwork}${suffix}.json`;
  const stolasPath =
    process.env.STOLAS_L2_DEPLOYMENT_PATH?.trim() ||
    `deployment-stolas-l2-${normalizedNetwork}${suffix}.json`;
  const l2Path =
    process.env.PHASE1A_L2_DEPLOYMENT_PATH?.trim() ||
    `deployment-phase1a-l2-${normalizedNetwork}${suffix}.json`;
  const mechPath = `deployment-phase1b-mech-${normalizedNetwork}${suffix}.json`;

  const v3Artifact = readArtifact(v3Path);
  const stolasArtifact = readArtifact(stolasPath);
  const l2Artifact = readArtifact(l2Path);

  const activityChecker = requireContractAddress(v3Artifact, "activityChecker", v3Path);
  const distributor = requireContractAddress(stolasArtifact, "distributor", stolasPath);
  const stakingFactory = requireContractAddress(l2Artifact, "stakingFactory", l2Path);
  const stakingImplementation = requireContractAddress(l2Artifact, "stakingImplementation", l2Path);
  const serviceRegistry = requireContractAddress(l2Artifact, "serviceRegistry", l2Path);
  const serviceRegistryTokenUtility = requireContractAddress(
    l2Artifact,
    "serviceRegistryTokenUtility",
    l2Path,
  );
  const l2Token = requireContractAddress(l2Artifact, "jinnToken", l2Path);

  const l2Config = (l2Artifact.config ?? {}) as Record<string, unknown>;
  const legacyStakingProxy =
    process.env.LEGACY_STAKING_PROXY?.trim() || LEGACY_STAKING_PROXY_DEFAULT;
  const existingFreshProxy = process.env.FRESH_STAKING_PROXY?.trim();
  const fundWei = process.env.STAKING_FUND_WEI?.trim()
    ? BigInt(process.env.STAKING_FUND_WEI)
    : ethersLib.parseEther("100");
  const skipFund = process.env.SKIP_FUND === "1" || process.env.SKIP_FUND === "true";

  console.log("=== stOLAS staking re-wire (V3 checker) ===");
  console.log(`Network:          ${normalizedNetwork} (chainId: ${net.chainId})`);
  console.log(`Deployer:         ${deployerAddress}`);
  console.log(`Balance:          ${ethers.formatEther(await provider.getBalance(deployerAddress))} ETH`);
  console.log(`V3 checker:       ${activityChecker}`);
  console.log(`Distributor:      ${distributor}`);
  console.log(`Legacy proxy:     ${legacyStakingProxy}`);
  console.log();

  const distributorContract = new ethers.Contract(distributor, DISTRIBUTOR_ABI, deployer);
  const distributorOwner = await distributorContract.owner();
  if (distributorOwner.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(
      `Distributor owner ${distributorOwner} is not deployer ${deployerAddress}`,
    );
  }

  let packedConfig: bigint;
  try {
    packedConfig = await distributorContract.stakingProxyConfigs(legacyStakingProxy);
  } catch {
    packedConfig = packStakingConfig(ethersLib.ZeroAddress, 2000, 0, 8000, 1);
    console.log("  Could not read legacy proxy config; using 80/0/20 type-1 default.");
  }
  if (packedConfig === 0n) {
    packedConfig = packStakingConfig(ethersLib.ZeroAddress, 2000, 0, 8000, 1);
    console.log("  Legacy proxy config was zero; using 80/0/20 type-1 default.");
  }
  console.log(`  Packed config:    ${packedConfig.toString()}`);

  console.log("Step 1: Deploying fresh StakingToken proxy...");
  let freshProxy: string;
  if (existingFreshProxy) {
    if (!ethersLib.isAddress(existingFreshProxy)) {
      throw new Error(`Invalid FRESH_STAKING_PROXY: ${existingFreshProxy}`);
    }
    freshProxy = ethersLib.getAddress(existingFreshProxy);
    console.log(`  Using existing fresh proxy: ${freshProxy}`);
  } else {
    const StakingToken = await ethers.getContractFactory("StakingToken", deployer);
    const initPayload = StakingToken.interface.encodeFunctionData("initialize", [
    {
      metadataHash: ethersLib.id("jinn-stolas-v3-checker"),
      maxNumServices: Number(l2Config.maxNumServices ?? 100),
      rewardsPerSecond: BigInt(String(l2Config.rewardsPerSecond ?? ethersLib.parseEther("0.0001"))),
      minStakingDeposit: BigInt(String(l2Config.minStakingDeposit ?? ethersLib.parseEther("10"))),
      minNumStakingPeriods: Number(l2Config.minNumStakingPeriods ?? 2),
      maxNumInactivityPeriods: Number(l2Config.maxNumInactivityPeriods ?? 1),
      livenessPeriod: Number(l2Config.livenessPeriod ?? 300),
      timeForEmissions: Number(l2Config.timeForEmissions ?? 21600),
      numAgentInstances: Number(l2Config.numAgentInstances ?? 1),
      agentIds: [] as number[],
      threshold: 0,
      configHash: ethersLib.ZeroHash,
      proxyHash: String(l2Config.proxyHash ?? "0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000"),
      serviceRegistry,
      activityChecker,
    },
    serviceRegistryTokenUtility,
    l2Token,
  ]);

  const factory = new ethers.Contract(stakingFactory, STAKING_FACTORY_ABI, deployer);
  const createTx = await factory.createStakingInstance(
    stakingImplementation,
    initPayload,
    withNonce(withGas(txOverrides, "standard")),
  );
  console.log(`  createStakingInstance tx: ${createTx.hash}`);
  const receipt = await createTx.wait();
  const created = parseStakingInstanceAddress(receipt!, stakingFactory, factory);
  if (!created) {
    throw new Error("Staking instance address not found in createStakingInstance receipt");
  }
  freshProxy = created;
  console.log(`  Fresh staking proxy: ${freshProxy}`);
  }

  const stakingRead = new ethers.Contract(
    freshProxy,
    ["function activityChecker() view returns (address)"],
    deployer,
  );
  const wiredChecker = await stakingRead.activityChecker();
  if (wiredChecker.toLowerCase() !== activityChecker.toLowerCase()) {
    throw new Error(`Fresh proxy checker mismatch: ${wiredChecker} != ${activityChecker}`);
  }
  console.log("  activityChecker wiring verified.");

  console.log("Step 2: Registering fresh proxy on stOLAS distributor...");
  const setConfigTx = await distributorContract.setStakingProxyConfigs(
    [freshProxy],
    [packedConfig],
    withNonce(withGas(txOverrides, "call")),
  );
  await setConfigTx.wait();
  console.log("  setStakingProxyConfigs complete.");

  if (!skipFund && !local) {
    console.log(`Step 3: Funding fresh proxy with ${ethers.formatEther(fundWei)} JINN-as-OLAS...`);
    const token = new ethers.Contract(l2Token, ERC20_ABI, deployer);
    const balance = await token.balanceOf(deployerAddress);
    if (balance < fundWei) {
      console.log(
        `  Skipping fund: deployer balance ${balance.toString()} < ${fundWei.toString()}`,
      );
    } else {
      const fundTx = await token.transfer(freshProxy, fundWei, withNonce(withGas(txOverrides, "call")));
      await fundTx.wait();
      console.log("  Reward pool funded.");
    }
  } else {
    console.log("Step 3: Skipping reward-pool fund (SKIP_FUND or local network).");
  }

  const now = new Date().toISOString();
  const rewireRecord = {
    rewiredAt: now,
    deployer: deployerAddress,
    legacyStakingProxy,
    freshStakingProxy: freshProxy,
    activityChecker,
    packedConfig: packedConfig.toString(),
    fundWei: skipFund ? "0" : fundWei.toString(),
  };

  stolasArtifact.deployedAt = now;
  const stolasConfig = (stolasArtifact.config ?? {}) as Record<string, unknown>;
  stolasArtifact.config = { ...stolasConfig, stakingContract: freshProxy };
  const stolasRewires = Array.isArray(stolasArtifact.rewires) ? stolasArtifact.rewires : [];
  stolasArtifact.rewires = [...stolasRewires, rewireRecord];
  fs.writeFileSync(path.resolve(process.cwd(), stolasPath), JSON.stringify(stolasArtifact, null, 2) + "\n");
  console.log(`  Updated ${stolasPath}`);

  if (fs.existsSync(path.resolve(process.cwd(), mechPath))) {
    const mechArtifact = readArtifact(mechPath);
    const mechContracts = (mechArtifact.contracts ?? {}) as Record<string, string>;
    mechArtifact.contracts = { ...mechContracts, stakingToken: freshProxy };
    mechArtifact.deployedAt = now;
    fs.writeFileSync(path.resolve(process.cwd(), mechPath), JSON.stringify(mechArtifact, null, 2) + "\n");
    console.log(`  Updated ${mechPath}`);
  }

  console.log("\n=== Re-wire Summary ===");
  console.log(`  Fresh staking proxy: ${freshProxy}`);
  console.log(`  V3 activity checker: ${activityChecker}`);
  console.log(`  Distributor:         ${distributor}`);
  console.log("\nOperators must re-stake into the fresh proxy (bootstrap stepStolasStake).");
}

if (isRunEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
