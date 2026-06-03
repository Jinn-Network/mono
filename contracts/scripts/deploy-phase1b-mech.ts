import { isRunEntry } from "./lib/run-entry.js";
/**
 * Deploy the Jinn Phase 1b mech marketplace stack on Base Sepolia.
 *
 * Deployment order:
 *   1. Karma implementation
 *   2. KarmaProxy
 *   3. MechMarketplace implementation
 *   4. MechMarketplaceProxy
 *   5. BalanceTrackerFixedPriceNative
 *   6. MechFactoryFixedPriceNative
 *   7. Register factory in marketplace
 *   8. Register balance tracker in marketplace
 *   9. Whitelist marketplace in Karma
 *  10. Deploy JinnRouter and initialize
 *  11. Create StakingToken proxy via StakingFactory (optional — skipped if L2_DEPLOYMENT_PATH unset)
 *
 * Note: No standalone MechFixedPriceNative template is deployed. The factory creates each mech
 * fresh via CREATE2 (new MechFixedPriceNative{salt:...}), so no pre-deployed template is needed.
 */

import { network } from "hardhat";
import type { Signer, TransactionRequest } from "ethers";
import { ethers as ethersLib, JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  getPhase1aArtifactSuffix,
  resolvePhase1aTimingProfile,
} from "./lib/phase1a-rollout-helpers.js";

type HardhatEthers = Awaited<ReturnType<typeof network.connect>>["ethers"];

// ─── Constants ───────────────────────────────────────────────────────────────

const NATIVE_PAYMENT_TYPE = "0xba699a34be8fe0e7725e93dcbce1701b0211a8ca61330aaeb8a05bf2ec7abed1";
const MARKETPLACE_FEE = 0;
const MIN_RESPONSE_TIMEOUT = 60;
const MAX_RESPONSE_TIMEOUT = 300;
const LIVENESS_RATIO = ethersLib.parseEther("0.001"); // 1e15

// Default OLAS ServiceRegistryL2 on Base Sepolia
const DEFAULT_SERVICE_REGISTRY = "0x31D3202d8744B16A120117A053459DDFAE93c855";
// WETH on Base (both mainnet and sepolia share this deterministic address)
const DEFAULT_WETH = "0x4200000000000000000000000000000000000006";

// ─── Helpers (mirrors deploy-phase1a-l2.ts) ──────────────────────────────────

const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);

function isLocalNetwork(networkName: string): boolean {
  return LOCAL_NETWORKS.has(networkName);
}

async function getMechDeployerSigner(ethers: HardhatEthers, networkName: string): Promise<Signer> {
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
    maxFeePerGas: ethersLib.parseUnits(maxFeeGwei, "gwei"),
    maxPriorityFeePerGas: ethersLib.parseUnits(prioGwei, "gwei"),
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
  // On local Hardhat, gas is estimated automatically — don't clamp it.
  if (local) return tx;
  return { ...tx, gasLimit: deployGasLimit(kind) };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { ethers } = await network.connect();
  const net = await ethers.provider.getNetwork();
  const networkName = net.name === "unknown" ? "hardhat" : net.name;
  const deployer = await getMechDeployerSigner(ethers, networkName);
  const deployerAddress = await deployer.getAddress();
  const balanceProvider = deployer.provider ?? (isLocalNetwork(networkName) ? ethers.provider : undefined);
  if (!balanceProvider) {
    throw new Error("Deployer signer is missing a provider; cannot read ETH balance.");
  }

  console.log("=== Jinn Phase 1b Mech Marketplace Deployment ===");
  console.log(`Network:  ${networkName} (chainId: ${net.chainId})`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Balance:  ${ethers.formatEther(await balanceProvider.getBalance(deployerAddress))} ETH`);
  console.log();

  const timingProfile = resolvePhase1aTimingProfile();
  console.log(`Timing profile: ${timingProfile}`);
  console.log();

  const local = isLocalNetwork(networkName);
  const txOverrides: TransactionRequest = local ? {} : liveL2TxOverrides();
  // Bound helper: adds gas limit on live networks only (Hardhat estimates gas automatically)
  const gas = (tx: TransactionRequest, kind: "standard" | "large" | "call") => withGas(tx, kind, local);

  // Resolve env overrides
  const serviceRegistryAddress = process.env.SERVICE_REGISTRY_ADDRESS?.trim() || DEFAULT_SERVICE_REGISTRY;
  const wethAddress = process.env.WETH_ADDRESS?.trim() || DEFAULT_WETH;
  // Drainer for BalanceTracker — defaults to deployer
  const drainerAddress = process.env.DRAINER_ADDRESS?.trim() || deployerAddress;

  if (!ethers.isAddress(serviceRegistryAddress)) {
    throw new Error(`Invalid SERVICE_REGISTRY_ADDRESS: ${serviceRegistryAddress}`);
  }
  if (!ethers.isAddress(wethAddress)) {
    throw new Error(`Invalid WETH_ADDRESS: ${wethAddress}`);
  }

  console.log(`ServiceRegistry: ${serviceRegistryAddress}`);
  console.log(`WETH:            ${wethAddress}`);
  console.log(`Drainer:         ${drainerAddress}`);
  console.log();

  // Nonce pinning — prevents nonce desync on public RPCs
  let nextNonce: number | undefined;
  const withNonce = async (base: TransactionRequest): Promise<TransactionRequest> => {
    if (!balanceProvider) return base;
    if (nextNonce === undefined) {
      nextNonce = await balanceProvider.getTransactionCount(deployerAddress, "pending");
    }
    const out = { ...base, nonce: nextNonce };
    nextNonce += 1;
    return out;
  };

  // ── Step 1: Karma implementation ──────────────────────────────────────────
  console.log("Step 1: Deploying Karma implementation...");
  const KarmaFactory = await ethers.getContractFactory("Karma", deployer);
  const karmaImpl = await KarmaFactory.deploy(await withNonce(gas(txOverrides,"standard")));
  await karmaImpl.waitForDeployment();
  const karmaImplAddress = await karmaImpl.getAddress();
  console.log(`  Karma impl: ${karmaImplAddress}`);

  // ── Step 2: KarmaProxy ────────────────────────────────────────────────────
  console.log("Step 2: Deploying KarmaProxy...");
  const karmaInitData = karmaImpl.interface.encodeFunctionData("initialize");
  const KarmaProxyFactory = await ethers.getContractFactory("KarmaProxy", deployer);
  const karmaProxy = await KarmaProxyFactory.deploy(
    karmaImplAddress,
    karmaInitData,
    await withNonce(gas(txOverrides,"standard")),
  );
  await karmaProxy.waitForDeployment();
  const karmaProxyAddress = await karmaProxy.getAddress();
  console.log(`  KarmaProxy: ${karmaProxyAddress}`);

  // Attach Karma ABI to the proxy for later calls
  const karma = KarmaFactory.attach(karmaProxyAddress) as typeof karmaImpl;

  // ── Step 3: MechMarketplace implementation ────────────────────────────────
  console.log("Step 3: Deploying MechMarketplace implementation...");
  const MarketplaceFactory = await ethers.getContractFactory("MechMarketplace", deployer);
  const marketplaceImpl = await MarketplaceFactory.deploy(
    serviceRegistryAddress,
    karmaProxyAddress,
    await withNonce(gas(txOverrides,"large")),
  );
  await marketplaceImpl.waitForDeployment();
  const marketplaceImplAddress = await marketplaceImpl.getAddress();
  console.log(`  MechMarketplace impl: ${marketplaceImplAddress}`);

  // ── Step 4: MechMarketplaceProxy ──────────────────────────────────────────
  console.log("Step 4: Deploying MechMarketplaceProxy...");
  const marketplaceInitData = marketplaceImpl.interface.encodeFunctionData("initialize", [
    MARKETPLACE_FEE,
    MIN_RESPONSE_TIMEOUT,
    MAX_RESPONSE_TIMEOUT,
  ]);
  const MechMarketplaceProxyFactory = await ethers.getContractFactory("MechMarketplaceProxy", deployer);
  const marketplaceProxy = await MechMarketplaceProxyFactory.deploy(
    marketplaceImplAddress,
    marketplaceInitData,
    await withNonce(gas(txOverrides,"standard")),
  );
  await marketplaceProxy.waitForDeployment();
  const marketplaceProxyAddress = await marketplaceProxy.getAddress();
  console.log(`  MechMarketplaceProxy: ${marketplaceProxyAddress}`);

  // Attach MechMarketplace ABI to the proxy for later admin calls
  const marketplace = MarketplaceFactory.attach(marketplaceProxyAddress) as typeof marketplaceImpl;

  // NOTE: A standalone MechFixedPriceNative template is NOT deployed here.
  // MechFactoryFixedPriceNative creates each mech fresh via CREATE2 (new MechFixedPriceNative{salt:...})
  // so no pre-deployed template is needed or possible (the constructor rejects serviceId=0/maxDeliveryRate=0).

  // ── Step 5: BalanceTrackerFixedPriceNative ────────────────────────────────
  console.log("Step 5: Deploying BalanceTrackerFixedPriceNative...");
  const BalanceTrackerFactory = await ethers.getContractFactory("BalanceTrackerFixedPriceNative", deployer);
  const balanceTracker = await BalanceTrackerFactory.deploy(
    marketplaceProxyAddress,
    drainerAddress,
    wethAddress,
    await withNonce(gas(txOverrides,"standard")),
  );
  await balanceTracker.waitForDeployment();
  const balanceTrackerAddress = await balanceTracker.getAddress();
  console.log(`  BalanceTrackerFixedPriceNative: ${balanceTrackerAddress}`);

  // ── Step 6: MechFactoryFixedPriceNative ───────────────────────────────────
  console.log("Step 6: Deploying MechFactoryFixedPriceNative...");
  const MechFactoryFactory = await ethers.getContractFactory("MechFactoryFixedPriceNative", deployer);
  const mechFactory = await MechFactoryFactory.deploy(
    marketplaceProxyAddress,
    await withNonce(gas(txOverrides,"large")),
  );
  await mechFactory.waitForDeployment();
  const mechFactoryAddress = await mechFactory.getAddress();
  console.log(`  MechFactoryFixedPriceNative: ${mechFactoryAddress}`);

  // ── Step 7: Register factory in marketplace ───────────────────────────────
  console.log("Step 7: Registering factory in marketplace...");
  const setFactoryTx = await marketplace.setMechFactoryStatuses(
    [mechFactoryAddress],
    [true],
    await withNonce(gas(txOverrides,"call")),
  );
  await setFactoryTx.wait();
  console.log("  Factory registered.");

  // ── Step 8: Register balance tracker in marketplace ───────────────────────
  console.log("Step 8: Registering balance tracker in marketplace...");
  const setTrackerTx = await marketplace.setPaymentTypeBalanceTrackers(
    [NATIVE_PAYMENT_TYPE],
    [balanceTrackerAddress],
    await withNonce(gas(txOverrides,"call")),
  );
  await setTrackerTx.wait();
  console.log("  Balance tracker registered.");

  // ── Step 9: Whitelist marketplace in Karma ────────────────────────────────
  console.log("Step 9: Whitelisting marketplace in Karma...");
  const setMarketplaceTx = await karma.setMechMarketplaceStatuses(
    [marketplaceProxyAddress],
    [true],
    await withNonce(gas(txOverrides,"call")),
  );
  await setMarketplaceTx.wait();
  console.log("  Marketplace whitelisted in Karma.");

  // ── Step 10: Deploy JinnRouter and initialize ─────────────────────────────
  console.log("Step 10: Deploying JinnRouter...");
  const JinnRouterFactory = await ethers.getContractFactory("JinnRouter", deployer);
  const jinnRouter = await JinnRouterFactory.deploy(await withNonce(gas(txOverrides,"standard")));
  await jinnRouter.waitForDeployment();
  const jinnRouterAddress = await jinnRouter.getAddress();
  console.log(`  JinnRouter: ${jinnRouterAddress}`);

  console.log("  Initializing JinnRouter...");
  const initRouterTx = await jinnRouter.initialize(
    marketplaceProxyAddress,
    LIVENESS_RATIO,
    await withNonce(gas(txOverrides,"call")),
  );
  await initRouterTx.wait();
  console.log("  JinnRouter initialized.");

  // ── Step 11: Create StakingToken proxy (optional) ─────────────────────────
  let stakingTokenAddress: string | null = null;
  const l2DeploymentPath = process.env.L2_DEPLOYMENT_PATH?.trim();

  if (l2DeploymentPath) {
    console.log(`Step 11: Creating StakingToken proxy via StakingFactory from ${l2DeploymentPath}...`);
    try {
      const l2Artifact = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), l2DeploymentPath), "utf8")) as {
        contracts: Record<string, string | undefined>;
      };

      const stakingFactoryAddress = l2Artifact.contracts.stakingFactory;
      const stakingImplAddress = l2Artifact.contracts.stakingImplementation;
      const activityCheckerAddress = l2Artifact.contracts.activityChecker;
      const jinnTokenAddress = l2Artifact.contracts.jinnToken;
      const serviceRegistryTokenUtilityAddress = l2Artifact.contracts.serviceRegistryTokenUtility;

      if (!stakingFactoryAddress || !stakingImplAddress || !activityCheckerAddress ||
          !jinnTokenAddress || !serviceRegistryTokenUtilityAddress) {
        throw new Error(
          "L2 deployment artifact is missing required fields: " +
          "stakingFactory, stakingImplementation, activityChecker, jinnToken, serviceRegistryTokenUtility",
        );
      }

      const StakingTokenFactory = await ethers.getContractFactory("StakingToken", deployer);
      const StakingFactoryContract = await ethers.getContractFactory("StakingFactory", deployer);
      const stakingFactory = StakingFactoryContract.attach(stakingFactoryAddress);

      const stakingParams = {
        metadataHash: ethers.id("jinn-l2-staking-v1-mech"),
        maxNumServices: 100,
        rewardsPerSecond: ethers.parseEther("0.0001"),
        minStakingDeposit: ethers.parseEther("10"),
        minNumStakingPeriods: timingProfile === "fast-test" ? 2 : 3,
        maxNumInactivityPeriods: timingProfile === "fast-test" ? 1 : 2,
        livenessPeriod: timingProfile === "fast-test" ? 300 : 86400,
        timeForEmissions: timingProfile === "fast-test" ? 21600 : 2592000,
        numAgentInstances: 1,
        agentIds: [] as number[],
        threshold: 0,
        configHash: ethers.ZeroHash,
        proxyHash: ethers.id("proxy-hash-placeholder"),
        serviceRegistry: serviceRegistryAddress,
        activityChecker: jinnRouterAddress, // Use JinnRouter as the activity checker
      };

      const initPayload = StakingTokenFactory.interface.encodeFunctionData("initialize", [
        stakingParams,
        serviceRegistryTokenUtilityAddress,
        jinnTokenAddress,
      ]);

      const createTx = await (stakingFactory as any).createStakingInstance(
        stakingImplAddress,
        initPayload,
        await withNonce(gas(txOverrides,"large")),
      );
      const createReceipt = await createTx.wait();

      // Parse InstanceCreated event
      for (const log of (createReceipt?.logs ?? [])) {
        try {
          const parsed = (stakingFactory as any).interface.parseLog(log);
          if (parsed?.name === "InstanceCreated") {
            stakingTokenAddress = parsed.args.instance as string;
            break;
          }
        } catch {
          // skip unrelated logs
        }
      }

      if (!stakingTokenAddress) {
        console.warn("  WARNING: Could not parse InstanceCreated event from staking factory receipt.");
        console.warn("  Staking proxy creation may have failed silently.");
      } else {
        console.log(`  StakingToken proxy: ${stakingTokenAddress}`);
      }
    } catch (err) {
      console.warn(`  WARNING: StakingToken proxy creation failed: ${err instanceof Error ? err.message : String(err)}`);
      console.warn("  Continuing without staking proxy — create it separately.");
    }
  } else {
    console.log("Step 11: L2_DEPLOYMENT_PATH not set — skipping StakingToken proxy creation.");
    console.log("  Create the staking proxy separately after supplying L2_DEPLOYMENT_PATH.");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n=== Deployment Summary ===");
  const summary: Record<string, string> = {
    karmaImpl:           karmaImplAddress,
    karma:               karmaProxyAddress,
    mechMarketplaceImpl: marketplaceImplAddress,
    mechMarketplace:     marketplaceProxyAddress,
    balanceTracker:      balanceTrackerAddress,
    mechFactory:         mechFactoryAddress,
    jinnRouter:          jinnRouterAddress,
    serviceRegistry:     serviceRegistryAddress,
  };
  if (stakingTokenAddress) {
    summary.stakingToken = stakingTokenAddress;
  }
  for (const [name, value] of Object.entries(summary)) {
    console.log(`  ${name.padEnd(24)} ${value}`);
  }

  // ── Write artifact ────────────────────────────────────────────────────────
  const normalizedNetwork = networkName === "base-sepolia" ? "baseSepolia" : networkName;
  const suffix = getPhase1aArtifactSuffix(timingProfile);
  const artifactName = `deployment-phase1b-mech-${normalizedNetwork}${suffix}.json`;

  const output = {
    network: normalizedNetwork,
    chainId: Number(net.chainId),
    deployer: deployerAddress,
    deployedAt: new Date().toISOString(),
    config: {
      timingProfile,
      fee: MARKETPLACE_FEE,
      minResponseTimeout: MIN_RESPONSE_TIMEOUT,
      maxResponseTimeout: MAX_RESPONSE_TIMEOUT,
      livenessRatio: LIVENESS_RATIO.toString(),
      nativePaymentType: NATIVE_PAYMENT_TYPE,
    },
    contracts: {
      karmaImpl:           karmaImplAddress,
      karma:               karmaProxyAddress,
      mechMarketplaceImpl: marketplaceImplAddress,
      mechMarketplace:     marketplaceProxyAddress,
      balanceTracker:      balanceTrackerAddress,
      mechFactory:         mechFactoryAddress,
      jinnRouter:          jinnRouterAddress,
      serviceRegistry:     serviceRegistryAddress,
      ...(stakingTokenAddress ? { stakingToken: stakingTokenAddress } : {}),
    },
  };

  const outPath = path.resolve(process.cwd(), artifactName);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nDeployment artifact written to: ${outPath}`);
}

if (isRunEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
