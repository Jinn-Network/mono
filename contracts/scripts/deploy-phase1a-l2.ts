/**
 * Deploy the Jinn Phase 1a L2 staking infrastructure.
 *
 * The live/testnet path must use an existing bridge-compatible L2 JINN token.
 * Local runs may still deploy a throwaway TestERC20 for isolated validation.
 *
 * Components deployed:
 *   1. Existing bridge-compatible JINN token or local TestERC20
 *   2. ServiceRegistryStub
 *   3. ServiceRegistryTokenUtilityStub
 *   4. RestorationActivityChecker
 *   5. StakingFactory
 *   6. StakingToken implementation
 *   7. Factory-created StakingProxy instance initialized via the implementation
 */

import { ethers } from "hardhat";
import type { ContractTransactionReceipt, Log, Signer, TransactionRequest } from "ethers";
import { JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import type { Phase1aTimingProfile } from "./lib/phase1a-rollout-helpers";
import {
  getL2DeploymentArtifactName as getProfileAwareL2DeploymentArtifactName,
  resolvePhase1aTimingProfile,
} from "./lib/phase1a-rollout-helpers";

type JinnTokenSource = "external" | "test";
type ServiceRegistrySource = "external" | "stub";
type ProxyHashSource = "external" | "placeholder";
type ActivityCheckerVersion = "v1" | "v2";

interface L2DeployConfig {
  timingProfile: Phase1aTimingProfile;
  /** Existing JINN token address, or empty to deploy a local test token. */
  jinnTokenAddress?: string;
  /** Declares whether the token was supplied externally or deployed for local-only use. */
  jinnTokenSource: JinnTokenSource;
  /** Existing OLAS ServiceRegistryL2 address for live/testnet staking. */
  serviceRegistryAddress?: string;
  /** Records whether the service registry came from OLAS infrastructure or a local stub. */
  serviceRegistrySource: ServiceRegistrySource;
  /** Existing ServiceRegistryTokenUtility address for live/testnet staking. */
  serviceRegistryTokenUtilityAddress?: string;
  /** Records whether the token utility came from OLAS infrastructure or a local stub. */
  serviceRegistryTokenUtilitySource: ServiceRegistrySource;
  /** Safe proxy bytecode hash required by the staking contract. */
  proxyHash: string;
  /** Records whether the proxy hash is live-safe or a local placeholder. */
  proxyHashSource: ProxyHashSource;
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
  /** Activity checker version: "v1" (simple counter) or "v2" (SimHash anti-farming). */
  activityCheckerVersion: ActivityCheckerVersion;
  /** V2 only: Hamming distance threshold (0-256). Default: 64. */
  similarityThreshold: number;
  /** V2 only: Weight for similar evidence (1e18 scale). Default: 0 (binary). */
  similarDecayMultiplier: bigint;
  /** V2 only: Recent hashes to compare against. Default: 20. */
  comparisonWindow: number;
}

const BASE_L2_CONFIG = {
  livenessRatio: ethers.parseEther("0.001"),
  maxNumServices: 100,
  rewardsPerSecond: ethers.parseEther("0.0001"),
  minStakingDeposit: ethers.parseEther("10"),
  minNumStakingPeriods: 3,
  maxNumInactivityPeriods: 2,
  livenessPeriod: 86400,
  timeForEmissions: 2592000,
  numAgentInstances: 1,
} as const;

export const DEFAULT_L2_CONFIG: L2DeployConfig = {
  timingProfile: "canonical",
  ...BASE_L2_CONFIG,
  jinnTokenSource: "test",
  serviceRegistrySource: "stub",
  serviceRegistryTokenUtilitySource: "stub",
  proxyHash: ethers.id("proxy-hash-placeholder"),
  proxyHashSource: "placeholder",
  activityCheckerVersion: "v1",
  similarityThreshold: 64,
  similarDecayMultiplier: 0n,
  comparisonWindow: 20,
};

export const FAST_TEST_L2_CONFIG: L2DeployConfig = {
  ...DEFAULT_L2_CONFIG,
  timingProfile: "fast-test",
  minNumStakingPeriods: 2,
  maxNumInactivityPeriods: 1,
  livenessPeriod: 300,
  timeForEmissions: 21600,
};

const LOCAL_L2_NETWORKS = new Set(["hardhat", "localhost"]);

export interface L2Deployment {
  jinnToken: string;
  jinnTokenSource: JinnTokenSource;
  serviceRegistry: string;
  serviceRegistryTokenUtility: string;
  activityChecker: string;
  stakingFactory: string;
  stakingImplementation: string;
  stakingToken: string;
}

function isLocalL2Network(networkName: string): boolean {
  return LOCAL_L2_NETWORKS.has(networkName);
}

/**
 * Hardhat's remote-network signer can reuse the same tx nonce across back-to-back
 * deploys on some JSON-RPC providers. Use a plain ethers Wallet for live Base Sepolia.
 */
async function getL2DeployerSigner(networkName: string): Promise<Signer> {
  if (isLocalL2Network(networkName)) {
    const [deployer] = await ethers.getSigners();
    return deployer;
  }

  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY is required for live L2 deployments.");
  }

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
  return new Wallet(privateKey, new JsonRpcProvider(rpcUrl));
}

/** Fee caps only — per-step gas limits avoid balance >= hugeGas*fee on small deploys. */
export function liveL2TxOverrides(): TransactionRequest {
  const maxFeeGwei = process.env.BASE_SEPOLIA_MAX_FEE_GWEI ?? "2";
  const prioGwei = process.env.BASE_SEPOLIA_PRIORITY_FEE_GWEI ?? "1";
  return {
    maxFeePerGas: ethers.parseUnits(maxFeeGwei, "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits(prioGwei, "gwei"),
  };
}

function l2DeployGasLimit(kind: "standard" | "stakingTokenImpl" | "factoryCreate"): bigint {
  if (kind === "stakingTokenImpl") {
    const raw = process.env.BASE_SEPOLIA_STAKING_TOKEN_DEPLOY_GAS?.trim();
    return raw ? BigInt(raw) : 7_500_000n;
  }
  if (kind === "factoryCreate") {
    const raw = process.env.BASE_SEPOLIA_CREATE_INSTANCE_GAS?.trim();
    return raw ? BigInt(raw) : 5_000_000n;
  }
  const raw = process.env.BASE_SEPOLIA_DEPLOY_GAS_LIMIT?.trim();
  // Keep default modest: intrinsic check is gasLimit * maxFeePerGas (full sequence still needs ~0.05+ ETH at ~5–7 gwei base).
  return raw ? BigInt(raw) : 2_500_000n;
}

function withGas(tx: TransactionRequest, kind: "standard" | "stakingTokenImpl" | "factoryCreate"): TransactionRequest {
  return { ...tx, gasLimit: l2DeployGasLimit(kind) };
}

function parseOptionalBigInt(value: string | undefined): bigint | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }

  return BigInt(value);
}

function requireLiveAddress(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required for live/testnet L2 deployments.`);
  }
  if (!ethers.isAddress(value)) {
    throw new Error(`${key} must be a valid address. Received: ${value}`);
  }
  return value;
}

function requireLiveProxyHash(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required for live/testnet L2 deployments.`);
  }
  if (!ethers.isHexString(value, 32)) {
    throw new Error(`${key} must be a 32-byte hex string. Received: ${value}`);
  }
  return value;
}

function parseInstanceCreatedAddress(
  receipt: ContractTransactionReceipt | null,
  stakingFactory: any,
): string {
  if (!receipt) {
    throw new Error("StakingFactory.createStakingInstance() did not return a transaction receipt.");
  }

  for (const log of receipt.logs) {
    try {
      const parsed = stakingFactory.interface.parseLog(log as Log);
      if (parsed?.name === "InstanceCreated") {
        return parsed.args.instance as string;
      }
    } catch {
      // Ignore unrelated logs and keep scanning.
    }
  }

  throw new Error("Unable to locate InstanceCreated event in staking factory receipt.");
}

async function verifyFactoryInstanceWithRetry(
  factoryAddress: string,
  stakingTokenAddress: string,
  provider: Signer["provider"],
  retries = 6,
): Promise<{ verified: boolean; emissionsAmount: bigint }> {
  if (!provider) {
    throw new Error("Missing provider while verifying staking factory deployment.");
  }

  const factory = new ethers.Contract(
    factoryAddress,
    [
      "function verifyInstance(address) view returns (bool)",
      "function verifyInstanceAndGetEmissionsAmount(address) view returns (uint256)",
    ],
    provider,
  );

  let lastError: string | null = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const [verified, emissionsAmount] = (await Promise.all([
        factory.verifyInstance(stakingTokenAddress) as Promise<boolean>,
        factory.verifyInstanceAndGetEmissionsAmount(stakingTokenAddress) as Promise<bigint>,
      ])) as [boolean, bigint];

      return { verified, emissionsAmount };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt + 1 < retries) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  throw new Error(
    `Unable to verify staking proxy ${stakingTokenAddress} via factory ${factoryAddress}.` +
      (lastError ? ` Last error: ${lastError}` : ""),
  );
}

export function resolveL2DeployConfig(
  networkName: string,
  env: Record<string, string | undefined> = process.env,
): L2DeployConfig {
  const timingProfile = resolvePhase1aTimingProfile(env);
  const config: L2DeployConfig = timingProfile === "fast-test"
    ? { ...FAST_TEST_L2_CONFIG }
    : { ...DEFAULT_L2_CONFIG };

  const suppliedToken = env.JINN_TOKEN_ADDRESS?.trim();
  if (suppliedToken) {
    config.jinnTokenAddress = suppliedToken;
    config.jinnTokenSource = "external";
  } else if (!isLocalL2Network(networkName)) {
    throw new Error(
      `JINN_TOKEN_ADDRESS is required on ${networkName}. ` +
        "Live/testnet L2 deployments must use an existing bridge-compatible JINN token address.",
    );
  }

  const suppliedServiceRegistry = env.SERVICE_REGISTRY_ADDRESS?.trim();
  if (suppliedServiceRegistry) {
    if (!ethers.isAddress(suppliedServiceRegistry)) {
      throw new Error(`SERVICE_REGISTRY_ADDRESS must be a valid address. Received: ${suppliedServiceRegistry}`);
    }
    config.serviceRegistryAddress = suppliedServiceRegistry;
    config.serviceRegistrySource = "external";
  } else if (!isLocalL2Network(networkName)) {
    config.serviceRegistryAddress = requireLiveAddress(env, "SERVICE_REGISTRY_ADDRESS");
    config.serviceRegistrySource = "external";
  }

  const suppliedTokenUtility = env.SERVICE_REGISTRY_TOKEN_UTILITY_ADDRESS?.trim();
  if (suppliedTokenUtility) {
    if (!ethers.isAddress(suppliedTokenUtility)) {
      throw new Error(
        "SERVICE_REGISTRY_TOKEN_UTILITY_ADDRESS must be a valid address. " +
          `Received: ${suppliedTokenUtility}`,
      );
    }
    config.serviceRegistryTokenUtilityAddress = suppliedTokenUtility;
    config.serviceRegistryTokenUtilitySource = "external";
  } else if (!isLocalL2Network(networkName)) {
    config.serviceRegistryTokenUtilityAddress = requireLiveAddress(
      env,
      "SERVICE_REGISTRY_TOKEN_UTILITY_ADDRESS",
    );
    config.serviceRegistryTokenUtilitySource = "external";
  }

  const suppliedProxyHash = env.SAFE_PROXY_HASH?.trim();
  if (suppliedProxyHash) {
    config.proxyHash = requireLiveProxyHash(env, "SAFE_PROXY_HASH");
    config.proxyHashSource = "external";
  } else if (!isLocalL2Network(networkName)) {
    config.proxyHash = requireLiveProxyHash(env, "SAFE_PROXY_HASH");
    config.proxyHashSource = "external";
  }

  const livenessRatio = parseOptionalBigInt(env.LIVENESS_RATIO);
  if (livenessRatio !== undefined) {
    config.livenessRatio = livenessRatio;
  }

  const rewardsPerSecond = parseOptionalBigInt(env.REWARDS_PER_SECOND);
  if (rewardsPerSecond !== undefined) {
    config.rewardsPerSecond = rewardsPerSecond;
  }

  const minStakingDeposit = parseOptionalBigInt(env.MIN_STAKING_DEPOSIT);
  if (minStakingDeposit !== undefined) {
    config.minStakingDeposit = minStakingDeposit;
  }

  const maxNumServices = env.MAX_NUM_SERVICES?.trim();
  if (maxNumServices) {
    config.maxNumServices = Number(maxNumServices);
  }

  const minNumStakingPeriods = env.MIN_NUM_STAKING_PERIODS?.trim();
  if (minNumStakingPeriods) {
    config.minNumStakingPeriods = Number(minNumStakingPeriods);
  }

  const maxNumInactivityPeriods = env.MAX_NUM_INACTIVITY_PERIODS?.trim();
  if (maxNumInactivityPeriods) {
    config.maxNumInactivityPeriods = Number(maxNumInactivityPeriods);
  }

  const livenessPeriod = env.LIVENESS_PERIOD?.trim();
  if (livenessPeriod) {
    config.livenessPeriod = Number(livenessPeriod);
  }

  const timeForEmissions = env.TIME_FOR_EMISSIONS?.trim();
  if (timeForEmissions) {
    config.timeForEmissions = Number(timeForEmissions);
  }

  const numAgentInstances = env.NUM_AGENT_INSTANCES?.trim();
  if (numAgentInstances) {
    config.numAgentInstances = Number(numAgentInstances);
  }

  const activityCheckerVersion = env.ACTIVITY_CHECKER_VERSION?.trim()?.toLowerCase();
  if (activityCheckerVersion === "v2") {
    config.activityCheckerVersion = "v2";
  }

  const simThreshold = env.SIMILARITY_THRESHOLD?.trim();
  if (simThreshold) {
    config.similarityThreshold = Number(simThreshold);
  }

  const simDecay = parseOptionalBigInt(env.SIMILAR_DECAY_MULTIPLIER);
  if (simDecay !== undefined) {
    config.similarDecayMultiplier = simDecay;
  }

  const compWindow = env.COMPARISON_WINDOW?.trim();
  if (compWindow) {
    config.comparisonWindow = Number(compWindow);
  }

  return config;
}

export function getL2DeploymentArtifactName(networkName: string): string {
  return getProfileAwareL2DeploymentArtifactName(resolvePhase1aTimingProfile(), networkName);
}

export async function deployL2Stack(
  deployer: Signer,
  config: L2DeployConfig = DEFAULT_L2_CONFIG,
  txOverrides: TransactionRequest = {},
): Promise<L2Deployment> {
  const deployerAddress = await deployer.getAddress();
  const provider = deployer.provider;
  let nextNonce: number | undefined;
  /** Public RPCs + Hardhat Wallet can desync nonces; pin each tx explicitly from pending count. */
  const withNonce = async (base: TransactionRequest): Promise<TransactionRequest> => {
    if (!provider) {
      return base;
    }
    if (nextNonce === undefined) {
      nextNonce = await provider.getTransactionCount(deployerAddress, "pending");
    }
    const out = { ...base, nonce: nextNonce };
    nextNonce += 1;
    return out;
  };

  let jinnTokenAddress: string;
  if (config.jinnTokenAddress) {
    jinnTokenAddress = config.jinnTokenAddress;
    console.log(`  Using existing JINN token: ${jinnTokenAddress}`);
  } else {
    const TestERC20 = await ethers.getContractFactory("TestERC20", deployer);
    const testToken = await TestERC20.deploy("Jinn (Test)", "JINN", await withNonce(withGas(txOverrides, "standard")));
    await testToken.waitForDeployment();
    jinnTokenAddress = await testToken.getAddress();
    console.log(`  Deployed test JINN token: ${jinnTokenAddress}`);
  }

  let serviceRegistryAddress: string;
  if (config.serviceRegistryAddress) {
    serviceRegistryAddress = config.serviceRegistryAddress;
    console.log(`  Using existing ServiceRegistry: ${serviceRegistryAddress}`);
  } else {
    const ServiceRegistryStub = await ethers.getContractFactory("ServiceRegistryStub", deployer);
    const serviceRegistry = await ServiceRegistryStub.deploy(await withNonce(withGas(txOverrides, "standard")));
    await serviceRegistry.waitForDeployment();
    serviceRegistryAddress = await serviceRegistry.getAddress();
    console.log(`  Deployed ServiceRegistryStub: ${serviceRegistryAddress}`);
  }

  let tokenUtilityAddress: string;
  if (config.serviceRegistryTokenUtilityAddress) {
    tokenUtilityAddress = config.serviceRegistryTokenUtilityAddress;
    console.log(`  Using existing ServiceRegistryTokenUtility: ${tokenUtilityAddress}`);
  } else {
    const TokenUtilityStub = await ethers.getContractFactory("ServiceRegistryTokenUtilityStub", deployer);
    const tokenUtility = await TokenUtilityStub.deploy(await withNonce(withGas(txOverrides, "standard")));
    await tokenUtility.waitForDeployment();
    tokenUtilityAddress = await tokenUtility.getAddress();
    console.log(`  Deployed ServiceRegistryTokenUtilityStub: ${tokenUtilityAddress}`);
  }

  let activityCheckerAddress: string;
  if (config.activityCheckerVersion === "v2") {
    const ActivityCheckerV2 = await ethers.getContractFactory("RestorationActivityCheckerV2", deployer);
    const activityChecker = await ActivityCheckerV2.deploy(
      config.livenessRatio,
      deployerAddress,
      config.similarityThreshold,
      config.similarDecayMultiplier,
      config.comparisonWindow,
      await withNonce(withGas(txOverrides, "standard")),
    );
    await activityChecker.waitForDeployment();
    activityCheckerAddress = await activityChecker.getAddress();
    console.log(`  Deployed RestorationActivityCheckerV2: ${activityCheckerAddress}`);
    console.log(`    similarityThreshold: ${config.similarityThreshold}`);
    console.log(`    similarDecayMultiplier: ${config.similarDecayMultiplier}`);
    console.log(`    comparisonWindow: ${config.comparisonWindow}`);
  } else {
    const ActivityChecker = await ethers.getContractFactory("RestorationActivityChecker", deployer);
    const activityChecker = await ActivityChecker.deploy(
      config.livenessRatio,
      deployerAddress,
      await withNonce(withGas(txOverrides, "standard")),
    );
    await activityChecker.waitForDeployment();
    activityCheckerAddress = await activityChecker.getAddress();
    console.log(`  Deployed RestorationActivityChecker: ${activityCheckerAddress}`);
  }

  const StakingToken = await ethers.getContractFactory("StakingToken", deployer);
  const stakingImplementation = await StakingToken.deploy(await withNonce(withGas(txOverrides, "stakingTokenImpl")));
  await stakingImplementation.waitForDeployment();
  const stakingImplementationAddress = await stakingImplementation.getAddress();
  console.log(`  Deployed StakingToken implementation: ${stakingImplementationAddress}`);

  const rewardsPerYear = config.rewardsPerSecond * 365n * 24n * 60n * 60n;
  const apyLimit = (rewardsPerYear * ethers.parseEther("1")) / config.minStakingDeposit;

  const StakingVerifier = await ethers.getContractFactory("StakingVerifier", deployer);
  const stakingVerifier = await StakingVerifier.deploy(
    jinnTokenAddress,
    serviceRegistryAddress,
    tokenUtilityAddress,
    config.minStakingDeposit,
    BigInt(config.timeForEmissions),
    BigInt(config.maxNumServices),
    apyLimit,
    await withNonce(withGas(txOverrides, "standard")),
  );
  await stakingVerifier.waitForDeployment();
  const stakingVerifierAddress = await stakingVerifier.getAddress();
  console.log(`  Deployed StakingVerifier: ${stakingVerifierAddress}`);

  const whitelistTx = await stakingVerifier.setImplementationsStatuses(
    [stakingImplementationAddress],
    [true],
    true,
    await withNonce(withGas(txOverrides, "standard")),
  );
  await whitelistTx.wait();
  console.log("  Whitelisted StakingToken implementation in StakingVerifier");

  const StakingFactory = await ethers.getContractFactory("StakingFactory", deployer);
  const stakingFactory = await StakingFactory.deploy(
    stakingVerifierAddress,
    await withNonce(withGas(txOverrides, "standard")),
  );
  await stakingFactory.waitForDeployment();
  const stakingFactoryAddress = await stakingFactory.getAddress();
  console.log(`  Deployed StakingFactory: ${stakingFactoryAddress}`);

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
    proxyHash: config.proxyHash,
    serviceRegistry: serviceRegistryAddress,
    activityChecker: activityCheckerAddress,
  };

  const initPayload = StakingToken.interface.encodeFunctionData("initialize", [
    stakingParams,
    tokenUtilityAddress,
    jinnTokenAddress,
  ]);

  const createTx = await stakingFactory.createStakingInstance(
    stakingImplementationAddress,
    initPayload,
    await withNonce(withGas(txOverrides, "factoryCreate")),
  );
  const createReceipt = await createTx.wait();
  const stakingTokenAddress = parseInstanceCreatedAddress(createReceipt, stakingFactory);
  console.log(`  Deployed StakingToken proxy: ${stakingTokenAddress}`);

  const { verified, emissionsAmount } = await verifyFactoryInstanceWithRetry(
    stakingFactoryAddress,
    stakingTokenAddress,
    provider,
  );
  if (!verified) {
    throw new Error(`Factory verification failed for staking proxy ${stakingTokenAddress}.`);
  }

  if (emissionsAmount === 0n) {
    throw new Error(
      `Factory returned zero emissions for staking proxy ${stakingTokenAddress}. ` +
        "The target dispenser would withhold rewards for this deployment.",
    );
  }

  console.log(`  Factory verification passed with emissions amount: ${emissionsAmount}`);

  return {
    jinnToken: jinnTokenAddress,
    jinnTokenSource: config.jinnTokenSource,
    serviceRegistry: serviceRegistryAddress,
    serviceRegistryTokenUtility: tokenUtilityAddress,
    activityChecker: activityCheckerAddress,
    stakingFactory: stakingFactoryAddress,
    stakingImplementation: stakingImplementationAddress,
    stakingToken: stakingTokenAddress,
  };
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const deployer = await getL2DeployerSigner(networkName);
  const deployerAddress = await deployer.getAddress();
  const balanceProvider =
    deployer.provider ?? (isLocalL2Network(networkName) ? ethers.provider : undefined);
  if (!balanceProvider) {
    throw new Error("Deployer signer is missing a provider; cannot read ETH balance.");
  }

  console.log("=== Jinn Phase 1a L2 Staking Deployment ===");
  console.log(`Network:  ${networkName} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(
    `Balance:  ${ethers.formatEther(await balanceProvider.getBalance(deployerAddress))} ETH`,
  );
  console.log();

  const config = resolveL2DeployConfig(networkName);
  console.log(`Timing profile: ${config.timingProfile}`);

  console.log("Deploying L2 staking stack...\n");
  const txOverrides = isLocalL2Network(networkName) ? {} : liveL2TxOverrides();
  const deployment = await deployL2Stack(deployer, config, txOverrides);

  console.log("\n=== Deployment Summary ===");
  for (const [name, value] of Object.entries(deployment)) {
    console.log(`  ${name.padEnd(35)} ${value}`);
  }

  const output = {
    network: networkName,
    chainId: Number(network.chainId),
    deployer: deployerAddress,
    deployedAt: new Date().toISOString(),
    config: {
      jinnTokenSource: config.jinnTokenSource,
      serviceRegistrySource: config.serviceRegistrySource,
      serviceRegistryTokenUtilitySource: config.serviceRegistryTokenUtilitySource,
      proxyHash: config.proxyHash,
      proxyHashSource: config.proxyHashSource,
      timingProfile: config.timingProfile,
      livenessRatio: config.livenessRatio.toString(),
      maxNumServices: config.maxNumServices,
      rewardsPerSecond: config.rewardsPerSecond.toString(),
      minStakingDeposit: config.minStakingDeposit.toString(),
      minNumStakingPeriods: config.minNumStakingPeriods,
      maxNumInactivityPeriods: config.maxNumInactivityPeriods,
      livenessPeriod: config.livenessPeriod,
      timeForEmissions: config.timeForEmissions,
      numAgentInstances: config.numAgentInstances,
      activityCheckerVersion: config.activityCheckerVersion,
      ...(config.activityCheckerVersion === "v2" ? {
        similarityThreshold: config.similarityThreshold,
        similarDecayMultiplier: config.similarDecayMultiplier.toString(),
        comparisonWindow: config.comparisonWindow,
      } : {}),
    },
    contracts: {
      jinnToken: deployment.jinnToken,
      serviceRegistry: deployment.serviceRegistry,
      serviceRegistryTokenUtility: deployment.serviceRegistryTokenUtility,
      activityChecker: deployment.activityChecker,
      stakingFactory: deployment.stakingFactory,
      stakingImplementation: deployment.stakingImplementation,
      stakingToken: deployment.stakingToken,
    },
  };

  const outPath = path.resolve(process.cwd(), getL2DeploymentArtifactName(networkName));
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nDeployment written to: ${outPath}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
