import { isRunEntry } from "./lib/run-entry.js";
/**
 * Deploy Phase 1b JinnRouterV2 + RestorationActivityCheckerV2 on Base Sepolia.
 *
 * Deployment order:
 *   1a. RestorationActivityCheckerV2 implementation
 *   1b. Proxy (vendor/stolas/Proxy.sol) → checker proxy (this is what consumers bind to)
 *   2. JinnRouterV2 implementation
 *   3. JinnRouterProxy (delegatecalls to V2 impl, initialized with mechMarketplace + livenessRatio + checker proxy)
 *   4. Wire checker proxy: checker.setRouterAddresses(routerProxy, routerProxy)
 *   5. (Optional) Create a new StakingToken proxy via existing StakingFactory with activityChecker = checker proxy
 *
 * Mainnet parity: the activity checker is deployed BEHIND a proxy so future
 * hardening lands as `proxy.changeImplementation(newImpl)` — no checker state
 * migration, no staking redeploy, no staker churn. Mirrors mainnet's
 * `0x477C41...` checker proxy pattern.
 *
 * Required env:
 *   MECH_DEPLOYMENT_PATH  — path to Phase 1b mech deployment artifact (for mechMarketplace address)
 *                           Not required on local Hardhat networks.
 *
 * Optional env:
 *   L2_DEPLOYMENT_PATH          — path to Phase 1a L2 deployment artifact (for StakingFactory + JINN token)
 *   DEPLOYER_PRIVATE_KEY        — required on live networks
 *   BASE_SEPOLIA_RPC_URL        — default: https://sepolia.base.org
 *   PHASE1A_TIMING_PROFILE      — "canonical" (default) or "fast-test"
 *   LIVENESS_RATIO              — default: 1000000000000000 (1e15)
 *   SIMILARITY_THRESHOLD        — default: 64
 *   SIMILAR_DECAY_MULTIPLIER    — default: 0
 *   COMPARISON_WINDOW           — default: 20
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

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LIVENESS_RATIO = 1_000_000_000_000_000n; // 1e15
const DEFAULT_SIMILARITY_THRESHOLD = 64;
const DEFAULT_SIMILAR_DECAY_MULTIPLIER = 0n;
const DEFAULT_COMPARISON_WINDOW = 20;

// ─── Helpers (mirrors deploy-phase1b-mech.ts) ────────────────────────────────

const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);

function isLocalNetwork(networkName: string): boolean {
  return LOCAL_NETWORKS.has(networkName);
}

async function getDeployerSigner(ethers: HardhatEthers, networkName: string): Promise<Signer> {
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
  if (local) return tx;
  return { ...tx, gasLimit: deployGasLimit(kind) };
}

// ─── Config resolution ───────────────────────────────────────────────────────

function resolveConfig() {
  const livenessRatioRaw = process.env.LIVENESS_RATIO?.trim();
  const livenessRatio = livenessRatioRaw ? BigInt(livenessRatioRaw) : DEFAULT_LIVENESS_RATIO;

  const similarityThresholdRaw = process.env.SIMILARITY_THRESHOLD?.trim();
  const similarityThreshold = similarityThresholdRaw
    ? parseInt(similarityThresholdRaw, 10)
    : DEFAULT_SIMILARITY_THRESHOLD;

  const similarDecayMultiplierRaw = process.env.SIMILAR_DECAY_MULTIPLIER?.trim();
  const similarDecayMultiplier = similarDecayMultiplierRaw
    ? BigInt(similarDecayMultiplierRaw)
    : DEFAULT_SIMILAR_DECAY_MULTIPLIER;

  const comparisonWindowRaw = process.env.COMPARISON_WINDOW?.trim();
  const comparisonWindow = comparisonWindowRaw
    ? parseInt(comparisonWindowRaw, 10)
    : DEFAULT_COMPARISON_WINDOW;

  return { livenessRatio, similarityThreshold, similarDecayMultiplier, comparisonWindow };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { ethers } = await network.connect();
  const net = await ethers.provider.getNetwork();
  const networkName = net.name === "unknown" ? "hardhat" : net.name;
  const deployer = await getDeployerSigner(ethers, networkName);
  const deployerAddress = await deployer.getAddress();
  const balanceProvider =
    deployer.provider ?? (isLocalNetwork(networkName) ? ethers.provider : undefined);
  if (!balanceProvider) {
    throw new Error("Deployer signer is missing a provider; cannot read ETH balance.");
  }

  console.log("=== Jinn Phase 1b Router + Checker Deployment ===");
  console.log(`Network:  ${networkName} (chainId: ${net.chainId})`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(
    `Balance:  ${ethers.formatEther(await balanceProvider.getBalance(deployerAddress))} ETH`,
  );
  console.log();

  const timingProfile = resolvePhase1aTimingProfile();
  console.log(`Timing profile: ${timingProfile}`);

  const config = resolveConfig();
  console.log(`Liveness ratio:          ${config.livenessRatio}`);
  console.log(`Similarity threshold:    ${config.similarityThreshold}`);
  console.log(`Similar decay mult:      ${config.similarDecayMultiplier}`);
  console.log(`Comparison window:       ${config.comparisonWindow}`);
  console.log();

  const local = isLocalNetwork(networkName);
  const txOverrides: TransactionRequest = local ? {} : liveL2TxOverrides();
  const gas = (tx: TransactionRequest, kind: "standard" | "large" | "call") =>
    withGas(tx, kind, local);

  // ── Resolve mechMarketplace address ──────────────────────────────────────
  let mechMarketplaceAddress: string;

  const mechDeploymentPath = process.env.MECH_DEPLOYMENT_PATH?.trim();
  if (mechDeploymentPath) {
    console.log(`Reading mech deployment from: ${mechDeploymentPath}`);
    const mechArtifact = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), mechDeploymentPath), "utf8"),
    ) as { contracts: Record<string, string | undefined> };
    const addr = mechArtifact.contracts.mechMarketplace;
    if (!addr || !ethers.isAddress(addr)) {
      throw new Error(
        `MECH_DEPLOYMENT_PATH artifact is missing or has invalid contracts.mechMarketplace. Got: ${addr}`,
      );
    }
    mechMarketplaceAddress = addr;
    console.log(`MechMarketplace: ${mechMarketplaceAddress}`);
  } else if (!local) {
    throw new Error(
      "MECH_DEPLOYMENT_PATH must be set on live networks. " +
        "Point it to the Phase 1b mech deployment artifact.",
    );
  } else {
    // Local Hardhat: deploy a minimal mock marketplace so the router initialises
    console.log(
      "MECH_DEPLOYMENT_PATH not set — deploying a mock marketplace for local testing...",
    );
    // Deploy a stub that satisfies the IActivityChecker interface check.
    // On local Hardhat we don't need a real marketplace, just a valid address.
    // We'll use the deployer address as a dummy so the router can initialize.
    mechMarketplaceAddress = deployerAddress;
    console.log(`MechMarketplace (mock): ${mechMarketplaceAddress}`);
  }
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

  // ── Step 1a: Deploy RestorationActivityCheckerV2 implementation ──────────
  console.log("Step 1a: Deploying RestorationActivityCheckerV2 implementation...");
  const CheckerFactory = await ethers.getContractFactory(
    "RestorationActivityCheckerV2",
    deployer,
  );
  const checkerImpl = await CheckerFactory.deploy(
    await withNonce(gas(txOverrides, "standard")),
  );
  await checkerImpl.waitForDeployment();
  const checkerImplAddress = await checkerImpl.getAddress();
  console.log(`  RestorationActivityCheckerV2 impl: ${checkerImplAddress}`);

  // ── Step 1b: Deploy Proxy (vendor/stolas/Proxy.sol) wrapping the impl ─────
  // Mainnet parity: the canonical activity checker on Base mainnet is proxied
  // (945-byte forwarding stub at 0x477C41Cccc8bd08027e40CEF80c25918C595a24d).
  // Deploying behind a proxy here makes future logic upgrades a single
  // `proxy.changeImplementation(newImpl)` instead of a checker redeploy +
  // staking proxy redeploy + staker migration.
  console.log("Step 1b: Deploying activity checker proxy (vendor/stolas/Proxy.sol)...");
  const CheckerProxyFactory = await ethers.getContractFactory(
    "src/vendor/stolas/Proxy.sol:Proxy",
    deployer,
  );
  const checkerInitData = checkerImpl.interface.encodeFunctionData("initialize", [
    config.livenessRatio,
    deployerAddress,
    config.similarityThreshold,
    config.similarDecayMultiplier,
    config.comparisonWindow,
  ]);
  const checkerProxy = await CheckerProxyFactory.deploy(
    checkerImplAddress,
    checkerInitData,
    await withNonce(gas(txOverrides, "standard")),
  );
  await checkerProxy.waitForDeployment();
  const checkerAddress = await checkerProxy.getAddress();
  console.log(`  Activity checker proxy: ${checkerAddress}`);
  // Re-attach as the checker contract (the impl ABI fronts the proxy).
  const checker = CheckerFactory.attach(checkerAddress);

  // ── Step 2: Deploy JinnRouterV2 implementation ────────────────────────────
  console.log("Step 2: Deploying JinnRouterV2 implementation...");
  const RouterV2Factory = await ethers.getContractFactory("JinnRouterV2", deployer);
  const routerV2Impl = await RouterV2Factory.deploy(
    await withNonce(gas(txOverrides, "standard")),
  );
  await routerV2Impl.waitForDeployment();
  const routerV2ImplAddress = await routerV2Impl.getAddress();
  console.log(`  JinnRouterV2 impl: ${routerV2ImplAddress}`);

  // ── Step 3: Deploy JinnRouterProxy ────────────────────────────────────────
  console.log("Step 3: Deploying JinnRouterProxy...");
  const initData = routerV2Impl.interface.encodeFunctionData("initialize", [
    mechMarketplaceAddress,
    config.livenessRatio,
    checkerAddress,
  ]);
  const ProxyFactory = await ethers.getContractFactory("JinnRouterProxy", deployer);
  const routerProxy = await ProxyFactory.deploy(
    routerV2ImplAddress,
    initData,
    await withNonce(gas(txOverrides, "standard")),
  );
  await routerProxy.waitForDeployment();
  const routerProxyAddress = await routerProxy.getAddress();
  console.log(`  JinnRouterProxy: ${routerProxyAddress}`);

  // Verify initialization succeeded by reading back a field through the proxy.
  // On live networks the deployer signer's provider sometimes can't read newly deployed
  // contracts immediately. Use the Hardhat provider as fallback for verification.
  try {
    const verifyProvider = deployer.provider ?? ethers.provider;
    const routerAsV2 = new ethers.Contract(
      routerProxyAddress,
      ["function mechMarketplace() view returns (address)"],
      verifyProvider,
    );
    const storedMarketplace = await routerAsV2.mechMarketplace() as string;
    if (storedMarketplace.toLowerCase() !== mechMarketplaceAddress.toLowerCase()) {
      throw new Error(
        `Router proxy initialization mismatch: expected mechMarketplace=${mechMarketplaceAddress}, got ${storedMarketplace}`,
      );
    }
    console.log("  Proxy initialization verified.");
  } catch (verifyErr) {
    console.log("  Proxy verification skipped (RPC read may need time to settle). Verify manually with:");
    console.log(`    cast call ${routerProxyAddress} "mechMarketplace()(address)" --rpc-url ${process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org"}`);
  }

  // ── Step 4: Wire checker ──────────────────────────────────────────────────
  console.log("Step 4: Wiring checker to router proxy (setRouterAddresses)...");
  const wireTx = await checker.setRouterAddresses(
    routerProxyAddress,
    routerProxyAddress,
    await withNonce(gas(txOverrides, "call")),
  );
  await wireTx.wait();
  console.log("  Checker wired.");

  // ── Step 5: Optionally create StakingToken proxy ──────────────────────────
  let stakingTokenAddress: string | null = null;
  const l2DeploymentPath = process.env.L2_DEPLOYMENT_PATH?.trim();

  if (l2DeploymentPath) {
    console.log(`Step 5: Creating StakingToken proxy from ${l2DeploymentPath}...`);
    try {
      const l2Artifact = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), l2DeploymentPath), "utf8"),
      ) as {
        contracts: Record<string, string | undefined>;
        config?: Record<string, unknown>;
      };

      const stakingFactoryAddress = l2Artifact.contracts.stakingFactory;
      const stakingImplAddress = l2Artifact.contracts.stakingImplementation;
      const jinnTokenAddress = l2Artifact.contracts.jinnToken;
      const serviceRegistryAddress = l2Artifact.contracts.serviceRegistry;
      const serviceRegistryTokenUtilityAddress =
        l2Artifact.contracts.serviceRegistryTokenUtility;

      if (
        !stakingFactoryAddress ||
        !stakingImplAddress ||
        !jinnTokenAddress ||
        !serviceRegistryAddress ||
        !serviceRegistryTokenUtilityAddress
      ) {
        throw new Error(
          "L2 deployment artifact is missing required fields: " +
            "stakingFactory, stakingImplementation, jinnToken, serviceRegistry, serviceRegistryTokenUtility",
        );
      }

      // Read timing-dependent params from the L2 artifact config if available,
      // falling back to timing-profile defaults.
      const l2Config = l2Artifact.config ?? {};
      const minNumStakingPeriods =
        typeof l2Config.minNumStakingPeriods === "number"
          ? l2Config.minNumStakingPeriods
          : timingProfile === "fast-test"
            ? 2
            : 3;
      const maxNumInactivityPeriods =
        typeof l2Config.maxNumInactivityPeriods === "number"
          ? l2Config.maxNumInactivityPeriods
          : timingProfile === "fast-test"
            ? 1
            : 2;
      const livenessPeriod =
        typeof l2Config.livenessPeriod === "number"
          ? l2Config.livenessPeriod
          : timingProfile === "fast-test"
            ? 300
            : 86400;
      const timeForEmissions =
        typeof l2Config.timeForEmissions === "number"
          ? l2Config.timeForEmissions
          : timingProfile === "fast-test"
            ? 21600
            : 2592000;

      const StakingTokenFactory = await ethers.getContractFactory("StakingToken", deployer);
      const StakingFactoryContract = await ethers.getContractFactory("StakingFactory", deployer);
      const stakingFactory = StakingFactoryContract.attach(stakingFactoryAddress);

      const stakingParams = {
        metadataHash: ethers.id("jinn-l2-staking-v2-checker"),
        maxNumServices: 100,
        rewardsPerSecond: ethers.parseEther("0.0001"),
        minStakingDeposit: ethers.parseEther("10"),
        minNumStakingPeriods,
        maxNumInactivityPeriods,
        livenessPeriod,
        timeForEmissions,
        numAgentInstances: 1,
        agentIds: [] as number[],
        threshold: 0,
        configHash: ethers.ZeroHash,
        proxyHash: process.env.SAFE_PROXY_HASH ?? "0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000",
        serviceRegistry: serviceRegistryAddress,
        // Critical: activityChecker points to the V2 checker, NOT the router
        activityChecker: checkerAddress,
      };

      const initPayload = StakingTokenFactory.interface.encodeFunctionData("initialize", [
        stakingParams,
        serviceRegistryTokenUtilityAddress,
        jinnTokenAddress,
      ]);

      const createTx = await (stakingFactory as any).createStakingInstance(
        stakingImplAddress,
        initPayload,
        await withNonce(gas(txOverrides, "large")),
      );
      const createReceipt = await createTx.wait();

      // Parse InstanceCreated event
      for (const log of createReceipt?.logs ?? []) {
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
        console.warn(
          "  WARNING: Could not parse InstanceCreated event from staking factory receipt.",
        );
        console.warn("  Staking proxy creation may have failed silently.");
      } else {
        console.log(`  StakingToken proxy: ${stakingTokenAddress}`);
      }
    } catch (err) {
      console.warn(
        `  WARNING: StakingToken proxy creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.warn("  Continuing without staking proxy — create it separately.");
    }
  } else {
    console.log("Step 5: L2_DEPLOYMENT_PATH not set — skipping StakingToken proxy creation.");
    console.log("  Supply L2_DEPLOYMENT_PATH and re-run to create the staking proxy.");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n=== Deployment Summary ===");
  const summary: Record<string, string> = {
    activityCheckerImpl:  checkerImplAddress,
    activityChecker:      checkerAddress,        // proxy — what consumers bind to
    jinnRouterV2Impl:     routerV2ImplAddress,
    jinnRouterProxy:      routerProxyAddress,
    mechMarketplace:      mechMarketplaceAddress,
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
  const artifactName = `deployment-phase1b-router-checker-${normalizedNetwork}${suffix}.json`;

  const output = {
    network: normalizedNetwork,
    chainId: Number(net.chainId),
    deployer: deployerAddress,
    deployedAt: new Date().toISOString(),
    config: {
      timingProfile,
      livenessRatio: config.livenessRatio.toString(),
      similarityThreshold: config.similarityThreshold,
      similarDecayMultiplier: config.similarDecayMultiplier.toString(),
      comparisonWindow: config.comparisonWindow,
    },
    contracts: {
      activityCheckerImpl:  checkerImplAddress,
      activityChecker:      checkerAddress,        // proxy — bind here
      jinnRouterV2Impl:     routerV2ImplAddress,
      jinnRouterProxy:      routerProxyAddress,
      mechMarketplace:      mechMarketplaceAddress,
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
