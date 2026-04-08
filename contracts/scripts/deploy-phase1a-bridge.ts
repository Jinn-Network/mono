/**
 * Deploy the Jinn Phase 1a bridge contracts across Sepolia (L1) and Base
 * Sepolia (L2) using the Phase 1a deployment artifacts as the source of truth.
 */

import { ethers, network } from "hardhat";
import type { Signer } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  getBridgeDeploymentArtifactName,
  getL1DeploymentArtifactName,
  getL2DeploymentArtifactName,
  resolvePhase1aTimingProfile,
} from "./lib/phase1a-rollout-helpers";

const OP_STACK_SEPOLIA = {
  L1StandardBridgeProxy: "0xfd0Bf71F60660E2f608ed56e1659C450eB113120",
  L1CrossDomainMessengerProxy: "0xC34855F4De64F1840e5686e64278da901e261f20",
};

const OP_STACK_BASE_SEPOLIA = {
  L2CrossDomainMessengerProxy: "0x4200000000000000000000000000000000000007",
};

const SEPOLIA_CHAIN_ID = 11155111;
const BASE_SEPOLIA_CHAIN_ID = 84532;

type EnvMap = Record<string, string | undefined>;
type BridgeTxKind = "l1Deploy" | "l2Deploy" | "link";

export interface BridgeTxOverrides {
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
}

interface BridgeDeployers {
  mode: "local" | "remote";
  l1Deployer: Signer;
  l2Deployer: Signer;
  l1RpcUrl: string;
  l2RpcUrl: string;
}

interface DeploymentArtifact {
  contracts: Record<string, string | undefined>;
}

interface BridgeConfigInput {
  l1Deployment: DeploymentArtifact;
  l2Deployment: DeploymentArtifact;
  env?: EnvMap;
}

export interface BridgeDeployConfig {
  jinnL1: string;
  jinnL2: string;
  dispenserL1: string;
  stakingFactoryL2: string;
  l1TokenRelayer: string;
  l1MessageRelayer: string;
  l2MessageRelayer: string;
  l2ChainId: number;
  l1ChainId: number;
}

export interface BridgeDeployment {
  depositProcessorL1: string;
  targetDispenserL2: string;
}

export function resolveBridgeExecutionMode(runtimeNetworkName: string): "local" | "remote" {
  return runtimeNetworkName === "hardhat" || runtimeNetworkName === "localhost"
    ? "local"
    : "remote";
}

export function bridgeTxFees(chain: "l1" | "l2", env: EnvMap = process.env): BridgeTxOverrides {
  const maxFeeKey = chain === "l1" ? "SEPOLIA_MAX_FEE_GWEI" : "BASE_SEPOLIA_MAX_FEE_GWEI";
  const prioKey = chain === "l1" ? "SEPOLIA_PRIORITY_FEE_GWEI" : "BASE_SEPOLIA_PRIORITY_FEE_GWEI";
  const defaultMax = chain === "l1" ? "20" : "7";
  const defaultPrio = chain === "l1" ? "2" : "2";

  return {
    maxFeePerGas: ethers.parseUnits(env[maxFeeKey] ?? defaultMax, "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits(env[prioKey] ?? defaultPrio, "gwei"),
  };
}

export function bridgeGasLimit(kind: BridgeTxKind, env: EnvMap = process.env): bigint {
  const raw =
    kind === "l1Deploy"
      ? env.PHASE1A_BRIDGE_L1_GAS_LIMIT?.trim()
      : kind === "l2Deploy"
        ? env.PHASE1A_BRIDGE_L2_GAS_LIMIT?.trim()
        : env.PHASE1A_BRIDGE_LINK_GAS_LIMIT?.trim();

  if (raw) {
    return BigInt(raw);
  }

  if (kind === "l1Deploy") {
    return 3_500_000n;
  }
  if (kind === "l2Deploy") {
    return 3_500_000n;
  }
  return 300_000n;
}

export function createNonceAllocator(startNonce: number) {
  let nextNonce = startNonce;
  return (base: BridgeTxOverrides = {}): BridgeTxOverrides => {
    const out = { ...base, nonce: nextNonce };
    nextNonce += 1;
    return out;
  };
}

export function validateBridgeChainIds(l1ChainId: number, l2ChainId: number) {
  if (l1ChainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`L1 RPC is on chain ${l1ChainId}, expected ${SEPOLIA_CHAIN_ID} (Sepolia).`);
  }
  if (l2ChainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`L2 RPC is on chain ${l2ChainId}, expected ${BASE_SEPOLIA_CHAIN_ID} (Base Sepolia).`);
  }
}

async function getNonceAllocator(signer: Signer) {
  if (!signer.provider) {
    return null;
  }

  const startNonce = await signer.provider.getTransactionCount(await signer.getAddress(), "pending");
  return createNonceAllocator(startNonce);
}

async function resolveNonceAllocators(
  l1Deployer: Signer,
  l2Deployer: Signer,
): Promise<{
  l1NonceAllocator: ReturnType<typeof createNonceAllocator> | null;
  l2NonceAllocator: ReturnType<typeof createNonceAllocator> | null;
}> {
  const [l1Address, l2Address] = await Promise.all([l1Deployer.getAddress(), l2Deployer.getAddress()]);
  const sameProvider = l1Deployer.provider !== undefined && l1Deployer.provider === l2Deployer.provider;

  if (sameProvider && l1Address.toLowerCase() === l2Address.toLowerCase()) {
    const sharedAllocator = await getNonceAllocator(l1Deployer);
    return {
      l1NonceAllocator: sharedAllocator,
      l2NonceAllocator: sharedAllocator,
    };
  }

  const [l1NonceAllocator, l2NonceAllocator] = await Promise.all([
    getNonceAllocator(l1Deployer),
    getNonceAllocator(l2Deployer),
  ]);
  return { l1NonceAllocator, l2NonceAllocator };
}

function loadJson<T>(fileName: string): T {
  const filePath = path.resolve(process.cwd(), fileName);
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function requireAddress(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Missing required bridge input: ${label}.`);
  }

  if (!ethers.isAddress(value)) {
    throw new Error(`Invalid address for ${label}: ${value}`);
  }

  return value;
}

export function resolveBridgeDeployConfig({
  l1Deployment,
  l2Deployment,
  env = process.env,
}: BridgeConfigInput): BridgeDeployConfig {
  const jinnL1 = requireAddress(
    env.JINN_TOKEN_L1 ?? l1Deployment.contracts.JINN,
    "l1Deployment.contracts.JINN",
  );
  const dispenserL1 = requireAddress(
    env.DISPENSER_ADDRESS ?? l1Deployment.contracts.Dispenser,
    "l1Deployment.contracts.Dispenser",
  );
  const jinnL2 = requireAddress(
    env.JINN_TOKEN_L2 ?? l2Deployment.contracts.jinnToken,
    "l2Deployment.contracts.jinnToken",
  );
  const stakingFactoryL2 = requireAddress(
    env.STAKING_FACTORY_ADDRESS ?? l2Deployment.contracts.stakingFactory,
    "l2Deployment.contracts.stakingFactory",
  );

  return {
    jinnL1,
    jinnL2,
    dispenserL1,
    stakingFactoryL2,
    l1TokenRelayer: requireAddress(
      env.L1_STANDARD_BRIDGE_PROXY ?? OP_STACK_SEPOLIA.L1StandardBridgeProxy,
      "L1 standard bridge proxy",
    ),
    l1MessageRelayer: requireAddress(
      env.L1_CDM_PROXY ?? OP_STACK_SEPOLIA.L1CrossDomainMessengerProxy,
      "L1 cross-domain messenger proxy",
    ),
    l2MessageRelayer: requireAddress(
      env.L2_CDM_PROXY ?? OP_STACK_BASE_SEPOLIA.L2CrossDomainMessengerProxy,
      "L2 cross-domain messenger proxy",
    ),
    l2ChainId: BASE_SEPOLIA_CHAIN_ID,
    l1ChainId: SEPOLIA_CHAIN_ID,
  };
}

export async function deployBridgeContracts(
  l1Deployer: Signer,
  l2Deployer: Signer,
  config: BridgeDeployConfig,
): Promise<BridgeDeployment> {
  const { l1NonceAllocator, l2NonceAllocator } = await resolveNonceAllocators(l1Deployer, l2Deployer);

  const l1DeployOverrides = {
    ...bridgeTxFees("l1"),
    gasLimit: bridgeGasLimit("l1Deploy"),
  };
  const l2DeployOverrides = {
    ...bridgeTxFees("l2"),
    gasLimit: bridgeGasLimit("l2Deploy"),
  };
  const linkOverrides = {
    ...bridgeTxFees("l1"),
    gasLimit: bridgeGasLimit("link"),
  };

  console.log("  Deploying OptimismDepositProcessorL1...");
  const DepositProcessor = await ethers.getContractFactory("OptimismDepositProcessorL1", l1Deployer);
  const depositProcessor = await DepositProcessor.deploy(
    config.jinnL1,
    config.dispenserL1,
    config.l1TokenRelayer,
    config.l1MessageRelayer,
    config.l2ChainId,
    config.jinnL2,
    ...(l1NonceAllocator ? [l1NonceAllocator(l1DeployOverrides)] : [l1DeployOverrides]),
  );
  await depositProcessor.waitForDeployment();
  const depositProcessorAddress = await depositProcessor.getAddress();
  console.log(`  OptimismDepositProcessorL1: ${depositProcessorAddress}`);
  console.log(`  L1 deploy tx: ${depositProcessor.deploymentTransaction()?.hash ?? "(unknown)"}`);

  console.log("  Deploying OptimismTargetDispenserL2...");
  const TargetDispenser = await ethers.getContractFactory("OptimismTargetDispenserL2", l2Deployer);
  const targetDispenser = await TargetDispenser.deploy(
    config.jinnL2,
    config.stakingFactoryL2,
    config.l2MessageRelayer,
    depositProcessorAddress,
    config.l1ChainId,
    ...(l2NonceAllocator ? [l2NonceAllocator(l2DeployOverrides)] : [l2DeployOverrides]),
  );
  await targetDispenser.waitForDeployment();
  const targetDispenserAddress = await targetDispenser.getAddress();
  console.log(`  OptimismTargetDispenserL2: ${targetDispenserAddress}`);
  console.log(`  L2 deploy tx: ${targetDispenser.deploymentTransaction()?.hash ?? "(unknown)"}`);

  console.log("  Linking: setL2TargetDispenser on L1 processor...");
  const linkTx = await depositProcessor.setL2TargetDispenser(
    targetDispenserAddress,
    l1NonceAllocator ? l1NonceAllocator(linkOverrides) : linkOverrides,
  );
  console.log(`  Link tx: ${linkTx.hash}`);
  await linkTx.wait();
  console.log("  Linked.");

  return {
    depositProcessorL1: depositProcessorAddress,
    targetDispenserL2: targetDispenserAddress,
  };
}

async function getBridgeDeployers(): Promise<BridgeDeployers> {
  const executionMode = resolveBridgeExecutionMode(network.name);
  if (executionMode === "local") {
    const [deployer] = await ethers.getSigners();
    return {
      mode: "local" as const,
      l1Deployer: deployer,
      l2Deployer: deployer,
      l1RpcUrl: "hardhat",
      l2RpcUrl: "hardhat",
    };
  }

  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("DEPLOYER_PRIVATE_KEY is required for Sepolia/Base Sepolia bridge deployment.");
  }

  const sepoliaRpcUrl = process.env.SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org";
  const baseSepoliaRpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";

  return {
    mode: "remote" as const,
    l1Deployer: new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(sepoliaRpcUrl)),
    l2Deployer: new ethers.Wallet(privateKey, new ethers.JsonRpcProvider(baseSepoliaRpcUrl)),
    l1RpcUrl: sepoliaRpcUrl,
    l2RpcUrl: baseSepoliaRpcUrl,
  };
}

async function main() {
  const timingProfile = resolvePhase1aTimingProfile();
  const artifactPaths = {
    l1: process.env.PHASE1A_L1_DEPLOYMENT ?? getL1DeploymentArtifactName(timingProfile, "sepolia"),
    l2: process.env.PHASE1A_L2_DEPLOYMENT ?? getL2DeploymentArtifactName(timingProfile, "baseSepolia"),
    output:
      process.env.PHASE1A_BRIDGE_DEPLOYMENT ?? getBridgeDeploymentArtifactName(timingProfile),
  };

  const l1Deployment = loadJson<DeploymentArtifact>(artifactPaths.l1);
  const l2Deployment = loadJson<DeploymentArtifact>(artifactPaths.l2);
  const config = resolveBridgeDeployConfig({ l1Deployment, l2Deployment });
  const deployers = await getBridgeDeployers();
  const [l1Network, l2Network] = await Promise.all([
    deployers.l1Deployer.provider!.getNetwork(),
    deployers.l2Deployer.provider!.getNetwork(),
  ]);
  validateBridgeChainIds(Number(l1Network.chainId), Number(l2Network.chainId));

  console.log("=== Jinn Phase 1a Bridge Deployment ===");
  console.log(`L1 RPC:      ${deployers.l1RpcUrl}`);
  console.log(`L2 RPC:      ${deployers.l2RpcUrl}`);
  console.log(`Profile:     ${timingProfile}`);
  console.log(`L1 Chain ID: ${l1Network.chainId}`);
  console.log(`L2 Chain ID: ${l2Network.chainId}`);
  console.log(`L1 Deployer: ${await deployers.l1Deployer.getAddress()}`);
  console.log(`L2 Deployer: ${await deployers.l2Deployer.getAddress()}`);
  console.log(
    `L1 Balance:  ${ethers.formatEther(await deployers.l1Deployer.provider!.getBalance(await deployers.l1Deployer.getAddress()))} ETH`,
  );
  console.log(
    `L2 Balance:  ${ethers.formatEther(await deployers.l2Deployer.provider!.getBalance(await deployers.l2Deployer.getAddress()))} ETH`,
  );
  console.log();

  console.log("Bridge configuration:");
  console.log(`  L1 JINN:                     ${config.jinnL1}`);
  console.log(`  L1 Dispenser:                ${config.dispenserL1}`);
  console.log(`  L2 JINN:                     ${config.jinnL2}`);
  console.log(`  L2 StakingFactory:           ${config.stakingFactoryL2}`);
  console.log(`  L1StandardBridgeProxy:       ${config.l1TokenRelayer}`);
  console.log(`  L1CrossDomainMessengerProxy: ${config.l1MessageRelayer}`);
  console.log(`  L2CrossDomainMessengerProxy: ${config.l2MessageRelayer}`);
  console.log(`  L2 Chain ID:                 ${config.l2ChainId}`);
  console.log(`  L1 Chain ID:                 ${config.l1ChainId}`);
  console.log();

  console.log("Deploying bridge contracts...\n");
  const deployment = await deployBridgeContracts(
    deployers.l1Deployer,
    deployers.l2Deployer,
    config,
  );

  console.log("\n=== Deployment Summary ===");
  console.log(`  OptimismDepositProcessorL1:  ${deployment.depositProcessorL1}`);
  console.log(`  OptimismTargetDispenserL2:   ${deployment.targetDispenserL2}`);

  const output = {
    networks: {
      l1: { name: "sepolia", chainId: SEPOLIA_CHAIN_ID },
      l2: { name: "baseSepolia", chainId: BASE_SEPOLIA_CHAIN_ID },
    },
    deployedAt: new Date().toISOString(),
    deployers: {
      l1: await deployers.l1Deployer.getAddress(),
      l2: await deployers.l2Deployer.getAddress(),
      mode: deployers.mode,
    },
    artifacts: artifactPaths,
    timingProfile,
    config,
    contracts: deployment,
  };

  const outPath = path.resolve(process.cwd(), artifactPaths.output);
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
