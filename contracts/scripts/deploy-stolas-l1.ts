/**
 * Deploy the full stOLAS L1 stack on Sepolia with JINN tokens.
 *
 * Deployment order:
 *   1. stJINN (ERC-4626 vault wrapping JINN)
 *   2. Lock implementation (veJINN governance lock)
 *   3. Lock proxy
 *   4. UnstakeRelayer implementation
 *   5. UnstakeRelayer proxy
 *   6. Distributor implementation (receives bridged rewards)
 *   7. Distributor proxy
 *   8. Depository implementation (user deposit entry point)
 *   9. Depository proxy
 *  10. Treasury implementation (withdraw requests + ERC-6909)
 *  11. Treasury proxy
 *  12. BaseDepositProcessorL1 (OP bridge L1→L2)
 *
 * Post-deploy configuration:
 *  13. stJINN.initialize(treasury, depository, distributor, unstakeRelayer)
 *  14. Depository.changeTreasury(treasury)
 *  15. Depository.setDepositProcessorChainIds([processor], [84532])
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy-stolas-l1.ts --network sepolia
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

// ─── Pre-existing addresses (Sepolia) ───────────────────────────────────────

// L1 JINN token (fast-test)
const L1_JINN = "0xc3ae831f146Eabbb8095E1EDf90a187AA4E5F408";
// veJINN (fast-test Phase 1a)
const VE_JINN = "0x22092213247BFbFC934dAF7D531fcc50820DCc7A";
// L2 JINN token (fast-test, Base Sepolia) — needed for bridge config
const L2_JINN = "0xAB9a01cd4A379e36006ec6df2960CF39EF79df63";
// OP Stack canonical bridge addresses on Sepolia (for Base Sepolia)
const L1_STANDARD_BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";
const L1_CROSS_DOMAIN_MESSENGER = "0xC34855F4De64F1840e5686e64278da901e261f20";
// Base Sepolia chain ID
const BASE_SEPOLIA_CHAIN_ID = 84532;

// Lock factor: 0 = all rewards go to stJINN vault (no veJINN lock on testnet)
const LOCK_FACTOR = 0;
// Withdraw delay: 1 hour on testnet
const WITHDRAW_DELAY = 3600;

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
  if (!privateKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY is required for live deployments.");
  }

  const rpcUrl = process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org";
  return new Wallet(privateKey, new JsonRpcProvider(rpcUrl));
}

function liveL1TxOverrides(): TransactionRequest {
  const maxFeeGwei = process.env.SEPOLIA_MAX_FEE_GWEI ?? "20";
  const prioGwei = process.env.SEPOLIA_PRIORITY_FEE_GWEI ?? "2";
  return {
    maxFeePerGas: ethers.parseUnits(maxFeeGwei, "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits(prioGwei, "gwei"),
  };
}

function deployGasLimit(kind: "standard" | "large" | "call"): bigint {
  if (kind === "large") return 7_000_000n;
  if (kind === "call") return 500_000n;
  return 3_000_000n;
}

function withGas(
  tx: TransactionRequest,
  kind: "standard" | "large" | "call",
  local = false,
): TransactionRequest {
  if (local) return tx;
  return { ...tx, gasLimit: deployGasLimit(kind) };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const deployer = await getDeployerSigner(networkName);
  const deployerAddress = await deployer.getAddress();
  const balanceProvider = deployer.provider ?? (isLocalNetwork(networkName) ? ethers.provider : undefined);
  if (!balanceProvider) {
    throw new Error("Deployer signer is missing a provider.");
  }

  console.log("=== stOLAS L1 Deployment (Sepolia) ===");
  console.log(`Network:  ${networkName} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Balance:  ${ethers.formatEther(await balanceProvider.getBalance(deployerAddress))} ETH`);
  console.log(`L1 JINN:  ${L1_JINN}`);
  console.log(`L2 JINN:  ${L2_JINN}`);
  console.log();

  const timingProfile = resolvePhase1aTimingProfile();
  const local = isLocalNetwork(networkName);
  const txOverrides: TransactionRequest = local ? {} : liveL1TxOverrides();
  const gas = (tx: TransactionRequest, kind: "standard" | "large" | "call") => withGas(tx, kind, local);

  // Nonce pinning
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

  // Proxy factory helper — reuse for all proxied contracts
  const ProxyFactory = await ethers.getContractFactory(
    "src/vendor/stolas/Proxy.sol:Proxy",
    deployer,
  );

  // ── Step 1: stJINN (ERC-4626 vault) ──────────────────────────────────────
  console.log("Step 1: Deploying stJINN (ERC-4626 vault)...");
  const StJinnFactory = await ethers.getContractFactory(
    "src/vendor/stolas/l1/stOLAS.sol:stOLAS",
    deployer,
  );
  const stJinn = await StJinnFactory.deploy(
    L1_JINN,
    await withNonce(gas(txOverrides, "large")),
  );
  await stJinn.waitForDeployment();
  const stJinnAddress = await stJinn.getAddress();
  console.log(`  stJINN: ${stJinnAddress}`);

  // ── Step 2: Lock implementation ──────────────────────────────────────────
  console.log("Step 2: Deploying Lock implementation...");
  const LockFactory = await ethers.getContractFactory(
    "src/vendor/stolas/l1/Lock.sol:Lock",
    deployer,
  );
  const lockImpl = await LockFactory.deploy(
    L1_JINN,
    VE_JINN,
    await withNonce(gas(txOverrides, "standard")),
  );
  await lockImpl.waitForDeployment();
  const lockImplAddress = await lockImpl.getAddress();
  console.log(`  Lock impl: ${lockImplAddress}`);

  // ── Step 3: Lock proxy ───────────────────────────────────────────────────
  console.log("Step 3: Deploying Lock proxy...");
  const lockInitData = lockImpl.interface.encodeFunctionData("initialize");
  const lockProxy = await ProxyFactory.deploy(
    lockImplAddress,
    lockInitData,
    await withNonce(gas(txOverrides, "standard")),
  );
  await lockProxy.waitForDeployment();
  const lockProxyAddress = await lockProxy.getAddress();
  console.log(`  Lock proxy: ${lockProxyAddress}`);

  // ── Step 4: UnstakeRelayer implementation ─────────────────────────────────
  console.log("Step 4: Deploying UnstakeRelayer implementation...");
  const UnstakeRelayerFactory = await ethers.getContractFactory(
    "src/vendor/stolas/l1/UnstakeRelayer.sol:UnstakeRelayer",
    deployer,
  );
  const unstakeRelayerImpl = await UnstakeRelayerFactory.deploy(
    L1_JINN,
    stJinnAddress,
    await withNonce(gas(txOverrides, "standard")),
  );
  await unstakeRelayerImpl.waitForDeployment();
  const unstakeRelayerImplAddress = await unstakeRelayerImpl.getAddress();
  console.log(`  UnstakeRelayer impl: ${unstakeRelayerImplAddress}`);

  // ── Step 5: UnstakeRelayer proxy ──────────────────────────────────────────
  console.log("Step 5: Deploying UnstakeRelayer proxy...");
  const unstakeRelayerInitData = unstakeRelayerImpl.interface.encodeFunctionData("initialize");
  const unstakeRelayerProxy = await ProxyFactory.deploy(
    unstakeRelayerImplAddress,
    unstakeRelayerInitData,
    await withNonce(gas(txOverrides, "standard")),
  );
  await unstakeRelayerProxy.waitForDeployment();
  const unstakeRelayerProxyAddress = await unstakeRelayerProxy.getAddress();
  console.log(`  UnstakeRelayer proxy: ${unstakeRelayerProxyAddress}`);

  // ── Step 6: Distributor implementation ────────────────────────────────────
  console.log("Step 6: Deploying Distributor implementation...");
  const DistributorFactory = await ethers.getContractFactory(
    "src/vendor/stolas/l1/Distributor.sol:Distributor",
    deployer,
  );
  const distributorImpl = await DistributorFactory.deploy(
    L1_JINN,
    stJinnAddress,
    lockProxyAddress,
    await withNonce(gas(txOverrides, "standard")),
  );
  await distributorImpl.waitForDeployment();
  const distributorImplAddress = await distributorImpl.getAddress();
  console.log(`  Distributor impl: ${distributorImplAddress}`);

  // ── Step 7: Distributor proxy ─────────────────────────────────────────────
  console.log("Step 7: Deploying Distributor proxy...");
  const distributorInitData = distributorImpl.interface.encodeFunctionData("initialize", [LOCK_FACTOR]);
  const distributorProxy = await ProxyFactory.deploy(
    distributorImplAddress,
    distributorInitData,
    await withNonce(gas(txOverrides, "standard")),
  );
  await distributorProxy.waitForDeployment();
  const distributorProxyAddress = await distributorProxy.getAddress();
  console.log(`  Distributor proxy: ${distributorProxyAddress}`);

  // ── Step 8: Depository implementation ─────────────────────────────────────
  console.log("Step 8: Deploying Depository implementation...");
  const DepositoryFactory = await ethers.getContractFactory(
    "src/vendor/stolas/l1/Depository.sol:Depository",
    deployer,
  );
  const depositoryImpl = await DepositoryFactory.deploy(
    L1_JINN,
    stJinnAddress,
    await withNonce(gas(txOverrides, "large")),
  );
  await depositoryImpl.waitForDeployment();
  const depositoryImplAddress = await depositoryImpl.getAddress();
  console.log(`  Depository impl: ${depositoryImplAddress}`);

  // ── Step 9: Depository proxy ──────────────────────────────────────────────
  console.log("Step 9: Deploying Depository proxy...");
  const depositoryInitData = depositoryImpl.interface.encodeFunctionData("initialize");
  const depositoryProxy = await ProxyFactory.deploy(
    depositoryImplAddress,
    depositoryInitData,
    await withNonce(gas(txOverrides, "standard")),
  );
  await depositoryProxy.waitForDeployment();
  const depositoryProxyAddress = await depositoryProxy.getAddress();
  console.log(`  Depository proxy: ${depositoryProxyAddress}`);

  // Attach Depository ABI to proxy for config calls
  const depository = DepositoryFactory.attach(depositoryProxyAddress) as typeof depositoryImpl;

  // ── Step 10: Treasury implementation ──────────────────────────────────────
  console.log("Step 10: Deploying Treasury implementation...");
  const TreasuryFactory = await ethers.getContractFactory(
    "src/vendor/stolas/l1/Treasury.sol:Treasury",
    deployer,
  );
  const treasuryImpl = await TreasuryFactory.deploy(
    L1_JINN,
    stJinnAddress,
    depositoryProxyAddress,
    await withNonce(gas(txOverrides, "large")),
  );
  await treasuryImpl.waitForDeployment();
  const treasuryImplAddress = await treasuryImpl.getAddress();
  console.log(`  Treasury impl: ${treasuryImplAddress}`);

  // ── Step 11: Treasury proxy ───────────────────────────────────────────────
  console.log("Step 11: Deploying Treasury proxy...");
  const treasuryInitData = treasuryImpl.interface.encodeFunctionData("initialize", [WITHDRAW_DELAY]);
  const treasuryProxy = await ProxyFactory.deploy(
    treasuryImplAddress,
    treasuryInitData,
    await withNonce(gas(txOverrides, "standard")),
  );
  await treasuryProxy.waitForDeployment();
  const treasuryProxyAddress = await treasuryProxy.getAddress();
  console.log(`  Treasury proxy: ${treasuryProxyAddress}`);

  // ── Step 12: BaseDepositProcessorL1 ───────────────────────────────────────
  console.log("Step 12: Deploying BaseDepositProcessorL1...");
  const BaseDepositProcessorFactory = await ethers.getContractFactory(
    "BaseDepositProcessorL1",
    deployer,
  );
  const baseDepositProcessor = await BaseDepositProcessorFactory.deploy(
    L1_JINN,                    // _olas
    depositoryProxyAddress,     // _l1Dispenser (Depository is the "dispenser" in stOLAS)
    L1_STANDARD_BRIDGE,         // _l1TokenRelayer
    L1_CROSS_DOMAIN_MESSENGER,  // _l1MessageRelayer
    L2_JINN,                    // _olasL2
    await withNonce(gas(txOverrides, "standard")),
  );
  await baseDepositProcessor.waitForDeployment();
  const baseDepositProcessorAddress = await baseDepositProcessor.getAddress();
  console.log(`  BaseDepositProcessorL1: ${baseDepositProcessorAddress}`);

  // ── Step 13: Initialize stJINN ────────────────────────────────────────────
  console.log("Step 13: Initializing stJINN...");
  const stJinnContract = StJinnFactory.attach(stJinnAddress) as typeof stJinn;
  const initStJinnTx = await (stJinnContract as any).initialize(
    treasuryProxyAddress,
    depositoryProxyAddress,
    distributorProxyAddress,
    unstakeRelayerProxyAddress,
    await withNonce(gas(txOverrides, "call")),
  );
  await initStJinnTx.wait();
  console.log("  stJINN initialized.");

  // ── Step 14: Configure Depository — set treasury ──────────────────────────
  console.log("Step 14: Setting treasury on Depository...");
  const setTreasuryTx = await depository.changeTreasury(
    treasuryProxyAddress,
    await withNonce(gas(txOverrides, "call")),
  );
  await setTreasuryTx.wait();
  console.log("  Treasury set.");

  // ── Step 15: Configure Depository — set deposit processor ─────────────────
  console.log("Step 15: Setting deposit processor chain IDs...");
  const setProcessorTx = await depository.setDepositProcessorChainIds(
    [baseDepositProcessorAddress],
    [BASE_SEPOLIA_CHAIN_ID],
    await withNonce(gas(txOverrides, "call")),
  );
  await setProcessorTx.wait();
  console.log(`  Deposit processor set for chain ${BASE_SEPOLIA_CHAIN_ID}.`);

  // NOTE: BaseDepositProcessorL1.setL2StakingProcessor() is called AFTER L2
  // deployment, since it needs the L2 BaseStakingProcessorL2 address.
  // That call is one-time and revokes ownership.

  // NOTE: Depository.createAndActivateStakingModels() is called AFTER L2
  // deployment, since it needs the ExternalStakingDistributor proxy address on L2.

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n=== L1 Deployment Summary ===");
  const summary: Record<string, string> = {
    stJINN: stJinnAddress,
    lockImpl: lockImplAddress,
    lockProxy: lockProxyAddress,
    unstakeRelayerImpl: unstakeRelayerImplAddress,
    unstakeRelayerProxy: unstakeRelayerProxyAddress,
    distributorImpl: distributorImplAddress,
    distributorProxy: distributorProxyAddress,
    depositoryImpl: depositoryImplAddress,
    depositoryProxy: depositoryProxyAddress,
    treasuryImpl: treasuryImplAddress,
    treasuryProxy: treasuryProxyAddress,
    baseDepositProcessorL1: baseDepositProcessorAddress,
  };
  for (const [name, value] of Object.entries(summary)) {
    console.log(`  ${name.padEnd(28)} ${value}`);
  }

  // ── Write artifact ───────────────────────────────────────────────────────
  const suffix = getPhase1aArtifactSuffix(timingProfile);
  const artifactName = `deployment-stolas-l1-sepolia${suffix}.json`;

  const output = {
    network: "sepolia",
    chainId: Number(network.chainId),
    deployer: deployerAddress,
    deployedAt: new Date().toISOString(),
    config: {
      l1Jinn: L1_JINN,
      l2Jinn: L2_JINN,
      veJinn: VE_JINN,
      lockFactor: LOCK_FACTOR,
      withdrawDelay: WITHDRAW_DELAY,
      l1StandardBridge: L1_STANDARD_BRIDGE,
      l1CrossDomainMessenger: L1_CROSS_DOMAIN_MESSENGER,
      baseSepoliaChainId: BASE_SEPOLIA_CHAIN_ID,
    },
    contracts: {
      stJINN: stJinnAddress,
      lockImpl: lockImplAddress,
      lockProxy: lockProxyAddress,
      unstakeRelayerImpl: unstakeRelayerImplAddress,
      unstakeRelayerProxy: unstakeRelayerProxyAddress,
      distributorImpl: distributorImplAddress,
      distributorProxy: distributorProxyAddress,
      depositoryImpl: depositoryImplAddress,
      depositoryProxy: depositoryProxyAddress,
      treasuryImpl: treasuryImplAddress,
      treasuryProxy: treasuryProxyAddress,
      baseDepositProcessorL1: baseDepositProcessorAddress,
    },
  };

  const outPath = path.resolve(process.cwd(), artifactName);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nDeployment artifact written to: ${outPath}`);

  console.log("\n=== Next steps ===");
  console.log("1. Deploy L2 contracts on Base Sepolia (deploy-stolas-l2.ts)");
  console.log("2. Cross-chain wiring:");
  console.log(`   BaseDepositProcessorL1.setL2StakingProcessor(<L2 processor address>)`);
  console.log(`   Depository.createAndActivateStakingModels(...)`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
