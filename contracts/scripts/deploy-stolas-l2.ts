/**
 * Deploy the full stOLAS L2 stack on Base Sepolia with JINN tokens.
 *
 * This replaces the earlier deploy-stolas.ts which used the wrong JINN token.
 * All contracts use fast-test L2 JINN (0xAB9a01cd...).
 *
 * Deployment order:
 *   1. RecoveryModule
 *   2. SafeMultisigWithRecoveryModule
 *   3. Collector impl
 *   4. Collector proxy
 *   5. ExternalStakingDistributor impl
 *   6. ExternalStakingDistributor proxy
 *   7. MultisigGuard impl
 *   8. MultisigGuard proxy
 *   9. ModuleActivityChecker
 *  10. ActivityModule
 *  11. Beacon
 *  12. StakingManager impl
 *  13. StakingManager proxy
 *  14. BaseStakingProcessorL2
 *
 * Post-deploy configuration:
 *  15. distributor.changeMultisigGuard(guardProxy)
 *  16. distributor.setStakingProxyConfigs(...)
 *  17. distributor.changeStakingProcessorL2(baseStakingProcessorL2)
 *  18. collector.changeStakingManager(stakingManagerProxy)
 *  19. collector.changeStakingProcessorL2(baseStakingProcessorL2)
 *  20. collector.setOperationReceivers(...)
 *
 * Requires: L1 deployment artifact (deployment-stolas-l1-sepolia-fast.json) for
 *           the BaseDepositProcessorL1 address.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... \
 *   STOLAS_L1_DEPLOYMENT=./deployment-stolas-l1-sepolia-fast.json \
 *   npx hardhat run scripts/deploy-stolas-l2.ts --network baseSepolia
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

// ─── Pre-existing addresses (Base Sepolia) ──────────────────────────────────

// L2 JINN token (fast-test — bridged from L1 0xc3ae831f...)
const L2_JINN = "0xAB9a01cd4A379e36006ec6df2960CF39EF79df63";
// OLAS ServiceManager on Base Sepolia
const SERVICE_MANAGER = "0x5BA58970c2Ae16Cf6218783018100aF2dCcFc915";
// OLAS ServiceRegistry on Base Sepolia
const SERVICE_REGISTRY = "0x31D3202d8744B16A120117A053459DDFAE93c855";
// OLAS ServiceRegistryTokenUtility on Base Sepolia
const SERVICE_REGISTRY_TOKEN_UTILITY = "0xeB49bE5DF00F74bd240DE4535DDe6Bc89CEfb994";
// OLAS StakingFactory on Base Sepolia (fast-test)
const STAKING_FACTORY = "0x4FaF53A13Df420D70FE337F5b77B35B6E7309C48";
// Gnosis Safe singleton (deterministic CREATE2)
const SAFE_SINGLETON = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552";
// Gnosis Safe L2 singleton
const SAFE_L2 = "0x3E5c63644E683549055b9Be8653de26E0B4CD36E";
// Gnosis Safe proxy factory (deterministic CREATE2)
const SAFE_PROXY_FACTORY = "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2";
// Safe same-address multisig implementation
const SAFE_SAME_ADDRESS_MULTISIG = "0x10100e74b7F706222F8A7C0be9FC7Ae1717Ad8B2";
// Safe fallback handler (deterministic CREATE2)
const FALLBACK_HANDLER = "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4";
// MultiSendCallOnly (deterministic CREATE2)
const MULTI_SEND = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D";
// Safe multisig implementation (for StakingManager initialize)
const SAFE_MULTISIG_IMPL = "0x19936159B528C66750992C3cBcEd2e71cF4E4824";
// SafeToL2Setup / safeModuleInitializer
const SAFE_TO_L2_SETUP = "0xBD89A1CE4DDe368FFAB0eC35506eEcE0b1fFdc54";
// OP bridge addresses on Base Sepolia
const L2_STANDARD_BRIDGE = "0x4200000000000000000000000000000000000010";
const L2_CROSS_DOMAIN_MESSENGER = "0x4200000000000000000000000000000000000007";
// Phase 1b staking contract
const STAKING_CONTRACT = "0xf358b5c1ac4ddc4e807b5baf008826bf193eab3b";
// L1 chain ID (Sepolia)
const L1_CHAIN_ID = 11155111;

// Agent ID and config hash for StakingManager
const AGENT_ID = 103;
const CONFIG_HASH = ethers.id("jinn-stolas-staking-v1");
// Liveness ratio for ModuleActivityChecker (matches fast-test profile)
const LIVENESS_RATIO = ethers.parseEther("0.001"); // 1e15

// REWARD operation hash (used by Collector for operation receivers)
const REWARD_HASH = "0x0b9821ae606ebc7c79bf3390bdd3dc93e1b4a7cda27aad60646e7b88ff55b001";
// UNSTAKE operation hash
const UNSTAKE_HASH = ethers.id("UNSTAKE");

// ─── Helpers ────────────────────────────────────────────────────────────────

const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);

function isLocalNetwork(networkName: string): boolean {
  return LOCAL_NETWORKS.has(networkName);
}

async function getDeployerSigner(networkName: string): Promise<Signer> {
  if (isLocalNetwork(networkName)) {
    const [deployer] = await ethers.getSigners();
    return deployer;
  }
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) throw new Error("DEPLOYER_PRIVATE_KEY is required.");
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
  if (kind === "large") return 5_000_000n;
  if (kind === "call") return 500_000n;
  return 2_500_000n;
}

function withGas(tx: TransactionRequest, kind: "standard" | "large" | "call", local = false): TransactionRequest {
  if (local) return tx;
  return { ...tx, gasLimit: deployGasLimit(kind) };
}

/**
 * Pack staking proxy config for setStakingProxyConfigs().
 * Bit layout: stakingGuard(160) | collectorRewardFactor(16) | protocolRewardFactor(16) | curatingAgentRewardFactor(16) | stakingType(8)
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Load L1 deployment artifact for cross-chain reference
  const l1ArtifactPath = process.env.STOLAS_L1_DEPLOYMENT?.trim() || "./deployment-stolas-l1-sepolia-fast.json";
  const l1ArtifactResolved = path.resolve(process.cwd(), l1ArtifactPath);
  if (!fs.existsSync(l1ArtifactResolved)) {
    throw new Error(`L1 deployment artifact not found: ${l1ArtifactResolved}. Set STOLAS_L1_DEPLOYMENT.`);
  }
  const l1Artifact = JSON.parse(fs.readFileSync(l1ArtifactResolved, "utf8")) as {
    contracts: Record<string, string>;
  };
  const baseDepositProcessorL1 = l1Artifact.contracts.baseDepositProcessorL1;
  const l1DistributorProxy = l1Artifact.contracts.distributorProxy;
  const l1TreasuryProxy = l1Artifact.contracts.treasuryProxy;
  const l1UnstakeRelayerProxy = l1Artifact.contracts.unstakeRelayerProxy;
  if (!baseDepositProcessorL1) throw new Error("L1 artifact missing baseDepositProcessorL1");
  if (!l1DistributorProxy) throw new Error("L1 artifact missing distributorProxy");

  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const deployer = await getDeployerSigner(networkName);
  const deployerAddress = await deployer.getAddress();
  const balanceProvider = deployer.provider ?? (isLocalNetwork(networkName) ? ethers.provider : undefined);
  if (!balanceProvider) throw new Error("Deployer signer is missing a provider.");

  console.log("=== stOLAS L2 Deployment (Base Sepolia) ===");
  console.log(`Network:  ${networkName} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Balance:  ${ethers.formatEther(await balanceProvider.getBalance(deployerAddress))} ETH`);
  console.log(`L2 JINN:  ${L2_JINN}`);
  console.log(`L1 DepositProcessor: ${baseDepositProcessorL1}`);
  console.log();

  const timingProfile = resolvePhase1aTimingProfile();
  const local = isLocalNetwork(networkName);
  const txOverrides: TransactionRequest = local ? {} : liveL2TxOverrides();
  const gas = (tx: TransactionRequest, kind: "standard" | "large" | "call") => withGas(tx, kind, local);

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

  const ProxyFactory = await ethers.getContractFactory("src/vendor/stolas/Proxy.sol:Proxy", deployer);

  // ── Step 1: RecoveryModule ───────────────────────────────────────────────
  console.log("Step 1: Deploying RecoveryModule...");
  const RecoveryModuleFactory = await ethers.getContractFactory(
    "src/vendor/stolas/RecoveryModule.sol:RecoveryModule", deployer,
  );
  const recoveryModule = await RecoveryModuleFactory.deploy(
    MULTI_SEND, SERVICE_REGISTRY,
    await withNonce(gas(txOverrides, "standard")),
  );
  await recoveryModule.waitForDeployment();
  const recoveryModuleAddress = await recoveryModule.getAddress();
  console.log(`  RecoveryModule: ${recoveryModuleAddress}`);

  // ── Step 2: SafeMultisigWithRecoveryModule ───────────────────────────────
  console.log("Step 2: Deploying SafeMultisigWithRecoveryModule...");
  const SafeMultisigFactory = await ethers.getContractFactory("SafeMultisigWithRecoveryModule", deployer);
  const safeMultisig = await SafeMultisigFactory.deploy(
    SAFE_SINGLETON, SAFE_PROXY_FACTORY, recoveryModuleAddress,
    await withNonce(gas(txOverrides, "standard")),
  );
  await safeMultisig.waitForDeployment();
  const safeMultisigAddress = await safeMultisig.getAddress();
  console.log(`  SafeMultisigWithRecoveryModule: ${safeMultisigAddress}`);

  // ── Step 3: Collector impl ───────────────────────────────────────────────
  console.log("Step 3: Deploying Collector implementation...");
  const CollectorFactory = await ethers.getContractFactory(
    "src/vendor/stolas/Collector.sol:Collector", deployer,
  );
  const collectorImpl = await CollectorFactory.deploy(
    L2_JINN,
    await withNonce(gas(txOverrides, "standard")),
  );
  await collectorImpl.waitForDeployment();
  const collectorImplAddress = await collectorImpl.getAddress();
  console.log(`  Collector impl: ${collectorImplAddress}`);

  // ── Step 4: Collector proxy ──────────────────────────────────────────────
  console.log("Step 4: Deploying Collector proxy...");
  const collectorProxy = await ProxyFactory.deploy(
    collectorImplAddress,
    collectorImpl.interface.encodeFunctionData("initialize"),
    await withNonce(gas(txOverrides, "standard")),
  );
  await collectorProxy.waitForDeployment();
  const collectorProxyAddress = await collectorProxy.getAddress();
  console.log(`  Collector proxy: ${collectorProxyAddress}`);

  const collector = CollectorFactory.attach(collectorProxyAddress) as typeof collectorImpl;

  // ── Step 5: ExternalStakingDistributor impl ──────────────────────────────
  console.log("Step 5: Deploying ExternalStakingDistributor implementation...");
  const DistributorFactory = await ethers.getContractFactory("ExternalStakingDistributor", deployer);
  const distributorImpl = await DistributorFactory.deploy(
    L2_JINN, SERVICE_MANAGER, safeMultisigAddress,
    SAFE_SAME_ADDRESS_MULTISIG, FALLBACK_HANDLER, MULTI_SEND, collectorProxyAddress,
    await withNonce(gas(txOverrides, "large")),
  );
  await distributorImpl.waitForDeployment();
  const distributorImplAddress = await distributorImpl.getAddress();
  console.log(`  Distributor impl: ${distributorImplAddress}`);

  // ── Step 6: ExternalStakingDistributor proxy ─────────────────────────────
  console.log("Step 6: Deploying ExternalStakingDistributor proxy...");
  const distributorProxy = await ProxyFactory.deploy(
    distributorImplAddress,
    distributorImpl.interface.encodeFunctionData("initialize"),
    await withNonce(gas(txOverrides, "standard")),
  );
  await distributorProxy.waitForDeployment();
  const distributorProxyAddress = await distributorProxy.getAddress();
  console.log(`  Distributor proxy: ${distributorProxyAddress}`);

  const distributor = DistributorFactory.attach(distributorProxyAddress) as typeof distributorImpl;

  // ── Step 7: MultisigGuard impl ───────────────────────────────────────────
  console.log("Step 7: Deploying MultisigGuard implementation...");
  const MultisigGuardFactory = await ethers.getContractFactory(
    "src/vendor/stolas/MultisigGuard.sol:MultisigGuard", deployer,
  );
  const guardImpl = await MultisigGuardFactory.deploy(
    SERVICE_REGISTRY_TOKEN_UTILITY, distributorProxyAddress,
    await withNonce(gas(txOverrides, "standard")),
  );
  await guardImpl.waitForDeployment();
  const guardImplAddress = await guardImpl.getAddress();
  console.log(`  MultisigGuard impl: ${guardImplAddress}`);

  // ── Step 8: MultisigGuard proxy ──────────────────────────────────────────
  console.log("Step 8: Deploying MultisigGuard proxy...");
  const guardProxy = await ProxyFactory.deploy(
    guardImplAddress,
    guardImpl.interface.encodeFunctionData("initialize"),
    await withNonce(gas(txOverrides, "standard")),
  );
  await guardProxy.waitForDeployment();
  const guardProxyAddress = await guardProxy.getAddress();
  console.log(`  MultisigGuard proxy: ${guardProxyAddress}`);

  // ── Step 9: ModuleActivityChecker ────────────────────────────────────────
  console.log("Step 9: Deploying ModuleActivityChecker...");
  const ModuleActivityCheckerFactory = await ethers.getContractFactory(
    "src/vendor/stolas/l2/ModuleActivityChecker.sol:ModuleActivityChecker", deployer,
  );
  const moduleActivityChecker = await ModuleActivityCheckerFactory.deploy(
    LIVENESS_RATIO,
    await withNonce(gas(txOverrides, "standard")),
  );
  await moduleActivityChecker.waitForDeployment();
  const moduleActivityCheckerAddress = await moduleActivityChecker.getAddress();
  console.log(`  ModuleActivityChecker: ${moduleActivityCheckerAddress}`);

  // ── Step 10: ActivityModule ──────────────────────────────────────────────
  console.log("Step 10: Deploying ActivityModule...");
  const ActivityModuleFactory = await ethers.getContractFactory(
    "src/vendor/stolas/l2/ActivityModule.sol:ActivityModule", deployer,
  );
  const activityModule = await ActivityModuleFactory.deploy(
    L2_JINN, collectorProxyAddress, MULTI_SEND,
    await withNonce(gas(txOverrides, "standard")),
  );
  await activityModule.waitForDeployment();
  const activityModuleAddress = await activityModule.getAddress();
  console.log(`  ActivityModule: ${activityModuleAddress}`);

  // ── Step 11: Beacon ──────────────────────────────────────────────────────
  console.log("Step 11: Deploying Beacon...");
  const BeaconFactory = await ethers.getContractFactory(
    "src/vendor/stolas/Beacon.sol:Beacon", deployer,
  );
  const beacon = await BeaconFactory.deploy(
    activityModuleAddress,
    await withNonce(gas(txOverrides, "standard")),
  );
  await beacon.waitForDeployment();
  const beaconAddress = await beacon.getAddress();
  console.log(`  Beacon: ${beaconAddress}`);

  // ── Step 12: StakingManager impl ─────────────────────────────────────────
  console.log("Step 12: Deploying StakingManager implementation...");
  const StakingManagerFactory = await ethers.getContractFactory(
    "src/vendor/stolas/l2/StakingManager.sol:StakingManager", deployer,
  );
  const stakingManagerImpl = await StakingManagerFactory.deploy(
    L2_JINN,
    SERVICE_MANAGER,
    STAKING_FACTORY,
    SAFE_TO_L2_SETUP,
    SAFE_L2,
    beaconAddress,
    collectorProxyAddress,
    AGENT_ID,
    CONFIG_HASH,
    await withNonce(gas(txOverrides, "large")),
  );
  await stakingManagerImpl.waitForDeployment();
  const stakingManagerImplAddress = await stakingManagerImpl.getAddress();
  console.log(`  StakingManager impl: ${stakingManagerImplAddress}`);

  // ── Step 13: StakingManager proxy ────────────────────────────────────────
  console.log("Step 13: Deploying StakingManager proxy...");
  const stakingManagerInitData = stakingManagerImpl.interface.encodeFunctionData("initialize", [
    SAFE_MULTISIG_IMPL,
    SAFE_SAME_ADDRESS_MULTISIG,
    FALLBACK_HANDLER,
  ]);
  const stakingManagerProxy = await ProxyFactory.deploy(
    stakingManagerImplAddress,
    stakingManagerInitData,
    await withNonce(gas(txOverrides, "standard")),
  );
  await stakingManagerProxy.waitForDeployment();
  const stakingManagerProxyAddress = await stakingManagerProxy.getAddress();
  console.log(`  StakingManager proxy: ${stakingManagerProxyAddress}`);

  // ── Step 14: BaseStakingProcessorL2 ──────────────────────────────────────
  console.log("Step 14: Deploying BaseStakingProcessorL2...");
  const BaseStakingProcessorL2Factory = await ethers.getContractFactory(
    "BaseStakingProcessorL2", deployer,
  );
  const baseStakingProcessorL2 = await BaseStakingProcessorL2Factory.deploy(
    L2_JINN,
    stakingManagerProxyAddress,
    distributorProxyAddress,
    collectorProxyAddress,
    L2_STANDARD_BRIDGE,
    L2_CROSS_DOMAIN_MESSENGER,
    baseDepositProcessorL1,
    L1_CHAIN_ID,
    await withNonce(gas(txOverrides, "standard")),
  );
  await baseStakingProcessorL2.waitForDeployment();
  const baseStakingProcessorL2Address = await baseStakingProcessorL2.getAddress();
  console.log(`  BaseStakingProcessorL2: ${baseStakingProcessorL2Address}`);

  // ── Configuration ────────────────────────────────────────────────────────

  // Step 15: distributor.changeMultisigGuard
  console.log("Step 15: Setting multisig guard on distributor...");
  const setGuardTx = await distributor.changeMultisigGuard(
    guardProxyAddress,
    await withNonce(gas(txOverrides, "call")),
  );
  await setGuardTx.wait();
  console.log("  Guard set.");

  // Step 16: distributor.setStakingProxyConfigs
  console.log("Step 16: Whitelisting staking contract in distributor...");
  const packedConfig = packStakingConfig(
    ethers.ZeroAddress, 10000, 0, 0, 1, // stakingGuard=0, 100% collector, V2
  );
  const setConfigTx = await distributor.setStakingProxyConfigs(
    [STAKING_CONTRACT], [packedConfig],
    await withNonce(gas(txOverrides, "call")),
  );
  await setConfigTx.wait();
  console.log("  Staking contract whitelisted.");

  // Step 17: distributor.changeStakingProcessorL2
  console.log("Step 17: Setting L2 staking processor on distributor...");
  const setDistProcessorTx = await distributor.changeStakingProcessorL2(
    baseStakingProcessorL2Address,
    await withNonce(gas(txOverrides, "call")),
  );
  await setDistProcessorTx.wait();
  console.log("  Distributor L2 processor set.");

  // Step 18: collector.changeStakingManager
  console.log("Step 18: Setting staking manager on collector...");
  const setCollMgrTx = await collector.changeStakingManager(
    stakingManagerProxyAddress,
    await withNonce(gas(txOverrides, "call")),
  );
  await setCollMgrTx.wait();
  console.log("  Collector staking manager set.");

  // Step 19: collector.changeStakingProcessorL2
  console.log("Step 19: Setting L2 staking processor on collector...");
  const setCollProcessorTx = await collector.changeStakingProcessorL2(
    baseStakingProcessorL2Address,
    await withNonce(gas(txOverrides, "call")),
  );
  await setCollProcessorTx.wait();
  console.log("  Collector L2 processor set.");

  // Step 20: collector.setOperationReceivers
  console.log("Step 20: Setting operation receivers on collector...");
  const setReceiversTx = await collector.setOperationReceivers(
    [REWARD_HASH, UNSTAKE_HASH],
    [l1DistributorProxy, l1TreasuryProxy || l1DistributorProxy],
    await withNonce(gas(txOverrides, "call")),
  );
  await setReceiversTx.wait();
  console.log("  Operation receivers set.");

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n=== L2 Deployment Summary ===");
  const summary: Record<string, string> = {
    recoveryModule: recoveryModuleAddress,
    safeMultisigWithRecoveryModule: safeMultisigAddress,
    collectorImpl: collectorImplAddress,
    collector: collectorProxyAddress,
    distributorImpl: distributorImplAddress,
    distributor: distributorProxyAddress,
    multisigGuardImpl: guardImplAddress,
    multisigGuard: guardProxyAddress,
    moduleActivityChecker: moduleActivityCheckerAddress,
    activityModule: activityModuleAddress,
    beacon: beaconAddress,
    stakingManagerImpl: stakingManagerImplAddress,
    stakingManager: stakingManagerProxyAddress,
    baseStakingProcessorL2: baseStakingProcessorL2Address,
  };
  for (const [name, value] of Object.entries(summary)) {
    console.log(`  ${name.padEnd(36)} ${value}`);
  }

  // ── Write artifact ───────────────────────────────────────────────────────
  const normalizedNetwork = networkName === "base-sepolia" ? "baseSepolia" : networkName;
  const suffix = getPhase1aArtifactSuffix(timingProfile);
  const artifactName = `deployment-stolas-l2-${normalizedNetwork}${suffix}.json`;

  const output = {
    network: normalizedNetwork,
    chainId: Number(network.chainId),
    deployer: deployerAddress,
    deployedAt: new Date().toISOString(),
    config: {
      l2Jinn: L2_JINN,
      stakingContract: STAKING_CONTRACT,
      l1DepositProcessor: baseDepositProcessorL1,
      l1DistributorProxy: l1DistributorProxy,
      l1TreasuryProxy: l1TreasuryProxy,
      stakingType: 1,
      collectorRewardFactor: 10000,
      protocolRewardFactor: 0,
      curatingAgentRewardFactor: 0,
      agentId: AGENT_ID,
      livenessRatio: LIVENESS_RATIO.toString(),
    },
    contracts: {
      recoveryModule: recoveryModuleAddress,
      safeMultisigWithRecoveryModule: safeMultisigAddress,
      collectorImpl: collectorImplAddress,
      collector: collectorProxyAddress,
      distributorImpl: distributorImplAddress,
      distributor: distributorProxyAddress,
      multisigGuardImpl: guardImplAddress,
      multisigGuard: guardProxyAddress,
      moduleActivityChecker: moduleActivityCheckerAddress,
      activityModule: activityModuleAddress,
      beacon: beaconAddress,
      stakingManagerImpl: stakingManagerImplAddress,
      stakingManager: stakingManagerProxyAddress,
      baseStakingProcessorL2: baseStakingProcessorL2Address,
    },
  };

  const outPath = path.resolve(process.cwd(), artifactName);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nDeployment artifact written to: ${outPath}`);

  console.log("\n=== Next steps (cross-chain wiring on L1) ===");
  console.log(`1. BaseDepositProcessorL1.setL2StakingProcessor(${baseStakingProcessorL2Address})`);
  console.log(`   WARNING: This is a ONE-TIME call that revokes ownership.`);
  console.log(`2. Depository.createAndActivateStakingModels(...)`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
