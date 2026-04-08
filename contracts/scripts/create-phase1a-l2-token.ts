/**
 * Create the Base Sepolia bridge-compatible JINN representation using the
 * canonical OptimismMintableERC20Factory.
 */

import { ethers } from "hardhat";
import type { ContractTransactionReceipt, Interface, Log, Signer } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  getL1DeploymentArtifactName,
  getL2TokenDeploymentArtifactName as getProfileAwareL2TokenDeploymentArtifactName,
  loadJson,
  resolvePhase1aTimingProfile,
} from "./lib/phase1a-rollout-helpers";

type EnvMap = Record<string, string | undefined>;

interface DeploymentArtifact {
  contracts: Record<string, string | undefined>;
}

interface TokenCreationConfigInput {
  env?: EnvMap;
  l1Deployment?: DeploymentArtifact;
}

export interface TokenCreationConfig {
  l1DeploymentPath: string;
  l1Token: string;
  name: string;
  symbol: string;
  factoryAddress: string;
  l2StandardBridgeAddress: string;
}

export interface TokenCreationResult {
  l2Token: string;
  remoteToken: string;
  bridge: string;
  txHash: string;
  reusedExisting?: boolean;
}

const BASE_SEPOLIA_MINTABLE_ERC20_FACTORY = "0x4200000000000000000000000000000000000012";
const BASE_SEPOLIA_L2_STANDARD_BRIDGE = "0x4200000000000000000000000000000000000010";

const OPTIMISM_MINTABLE_ERC20_FACTORY_ABI = [
  "function createOptimismMintableERC20(address _remoteToken, string _name, string _symbol) returns (address)",
  "event OptimismMintableERC20Created(address indexed localToken, address indexed remoteToken, address deployer)",
  "event StandardL2TokenCreated(address indexed remoteToken, address indexed localToken)",
];

const OPTIMISM_MINTABLE_ERC20_ABI = [
  "function remoteToken() view returns (address)",
  "function bridge() view returns (address)",
  "function l1Token() view returns (address)",
  "function l2Bridge() view returns (address)",
  "function REMOTE_TOKEN() view returns (address)",
  "function BRIDGE() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

function requireAddress(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Missing required token creation input: ${label}.`);
  }

  if (!ethers.isAddress(value)) {
    throw new Error(`Invalid address for ${label}: ${value}`);
  }

  return value;
}

export function getL2TokenDeploymentArtifactName(networkName: string): string {
  return getProfileAwareL2TokenDeploymentArtifactName(resolvePhase1aTimingProfile(), networkName);
}

export function resolveTokenCreationConfig(
  networkName: string,
  { env = process.env, l1Deployment }: TokenCreationConfigInput = {},
): TokenCreationConfig {
  const profile = resolvePhase1aTimingProfile(env);
  const l1DeploymentPath = env.PHASE1A_L1_DEPLOYMENT ?? getL1DeploymentArtifactName(profile, "sepolia");
  const resolvedL1Deployment = l1Deployment ?? loadJson<DeploymentArtifact>(l1DeploymentPath);
  const name = env.JINN_TOKEN_NAME?.trim() || "Jinn";
  const symbol = env.JINN_TOKEN_SYMBOL?.trim() || "JINN";

  if (!name) {
    throw new Error("JINN_TOKEN_NAME must not be empty.");
  }

  if (!symbol) {
    throw new Error("JINN_TOKEN_SYMBOL must not be empty.");
  }

  return {
    l1DeploymentPath,
    l1Token: requireAddress(
      env.JINN_TOKEN_L1 ?? resolvedL1Deployment.contracts.JINN,
      `${networkName} L1 JINN token`,
    ),
    name,
    symbol,
    factoryAddress: requireAddress(
      env.OPTIMISM_MINTABLE_ERC20_FACTORY_ADDRESS ?? BASE_SEPOLIA_MINTABLE_ERC20_FACTORY,
      "OptimismMintableERC20Factory",
    ),
    l2StandardBridgeAddress: requireAddress(
      env.L2_STANDARD_BRIDGE_ADDRESS ?? BASE_SEPOLIA_L2_STANDARD_BRIDGE,
      "L2 standard bridge",
    ),
  };
}

export function parseCreatedMintableTokenAddress(
  receipt: Pick<ContractTransactionReceipt, "logs"> | { logs: Array<Pick<Log, "topics" | "data">> } | null,
  factoryInterface: Interface,
): string {
  if (!receipt) {
    throw new Error("Token creation transaction did not return a transaction receipt.");
  }

  for (const log of receipt.logs) {
    try {
      const parsed = factoryInterface.parseLog(log as Log);
      if (parsed?.name === "OptimismMintableERC20Created") {
        return parsed.args.localToken as string;
      }
      if (parsed?.name === "StandardL2TokenCreated") {
        return parsed.args.localToken as string;
      }
    } catch {
      // Ignore unrelated logs and keep scanning.
    }
  }

  throw new Error("Unable to locate the created L2 token in the factory receipt.");
}

async function readAddressField(contract: any, fieldNames: string[], retries = 5): Promise<string> {
  let lastError: string | null = null;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    for (const fieldName of fieldNames) {
      try {
        const value = await contract[fieldName]();
        if (ethers.isAddress(value)) {
          return value;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (attempt + 1 < retries) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }

  const suffix = lastError ? ` Last error: ${lastError}` : "";
  throw new Error(
    `Unable to read any of ${fieldNames.join(", ")} from the Optimism mintable token.${suffix}`,
  );
}

async function findExistingMintableToken(
  provider: Signer["provider"],
  config: TokenCreationConfig,
  factoryInterface: Interface,
): Promise<string | null> {
  if (!provider) {
    return null;
  }

  const latestBlock = await provider.getBlockNumber();
  const topicFilter = [
    factoryInterface.getEvent("OptimismMintableERC20Created")!.topicHash,
    null,
    ethers.zeroPadValue(config.l1Token, 32),
  ];
  const step = 10_000;

  for (let fromBlock = Math.max(0, latestBlock - step); ; fromBlock = Math.max(0, fromBlock - step)) {
    const toBlock = Math.min(latestBlock, fromBlock + step - 1);
    const logs = await provider.getLogs({
      address: config.factoryAddress,
      fromBlock,
      toBlock,
      topics: topicFilter,
    });

    for (const log of logs.slice().reverse()) {
      try {
        const parsed = factoryInterface.parseLog(log);
        if (parsed?.name !== "OptimismMintableERC20Created") {
          continue;
        }

        const candidate = parsed.args.localToken as string;
        const token = new ethers.Contract(candidate, OPTIMISM_MINTABLE_ERC20_ABI, provider);
        const [name, symbol] = (await Promise.all([token.name(), token.symbol()])) as [string, string];
        if (name === config.name && symbol === config.symbol) {
          return candidate;
        }
      } catch {
        // Ignore malformed or non-matching logs and keep scanning.
      }
    }

    if (fromBlock === 0) {
      break;
    }
  }

  return null;
}

export async function createTokenRepresentation(
  deployer: Signer,
  config: TokenCreationConfig,
): Promise<TokenCreationResult> {
  const factory = new ethers.Contract(
    config.factoryAddress,
    OPTIMISM_MINTABLE_ERC20_FACTORY_ABI,
    deployer,
  );

  let txHash = "";
  let reusedExisting = false;
  let l2Token: string;

  try {
    const tx = await factory.createOptimismMintableERC20(config.l1Token, config.name, config.symbol);
    txHash = tx.hash;
    const receipt = await tx.wait();
    l2Token = parseCreatedMintableTokenAddress(receipt, factory.interface);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (!message.includes("execution reverted")) {
      throw error;
    }

    const existingToken = await findExistingMintableToken(deployer.provider, config, factory.interface);
    if (!existingToken) {
      throw error;
    }

    l2Token = existingToken;
    reusedExisting = true;
  }

  // Use the signer (not deployer.provider) so HardhatEthersSigner always has a connected provider.
  const token = new ethers.Contract(l2Token, OPTIMISM_MINTABLE_ERC20_ABI, deployer);
  const remoteToken = await readAddressField(token, ["remoteToken", "l1Token", "REMOTE_TOKEN"]);
  const bridge = await readAddressField(token, ["bridge", "l2Bridge", "BRIDGE"]);

  if (remoteToken.toLowerCase() !== config.l1Token.toLowerCase()) {
    throw new Error(
      `Created token points at unexpected remote token ${remoteToken}; expected ${config.l1Token}.`,
    );
  }

  if (bridge.toLowerCase() !== config.l2StandardBridgeAddress.toLowerCase()) {
    throw new Error(
      `Created token points at unexpected bridge ${bridge}; expected ${config.l2StandardBridgeAddress}.`,
    );
  }

  return {
    l2Token,
    remoteToken,
    bridge,
    txHash,
    reusedExisting,
  };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "hardhat" : network.name;
  const timingProfile = resolvePhase1aTimingProfile();

  console.log("=== Jinn Phase 1a L2 Token Creation ===");
  console.log(`Network:  ${networkName} (chainId: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(
    `Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`,
  );
  console.log();

  const config = resolveTokenCreationConfig(networkName);

  console.log("Creating Optimism mintable JINN representation...\n");
  const result = await createTokenRepresentation(deployer, config);

  console.log("\n=== Token Creation Summary ===");
  console.log(`  l1Token                           ${config.l1Token}`);
  console.log(`  l2Token                           ${result.l2Token}`);
  console.log(`  remoteToken()                     ${result.remoteToken}`);
  console.log(`  bridge()                          ${result.bridge}`);
  console.log(`  factory                           ${config.factoryAddress}`);
  console.log(`  txHash                            ${result.txHash}`);
  console.log(`  reusedExisting                    ${result.reusedExisting ? "yes" : "no"}`);

  const output = {
    network: networkName,
    chainId: Number(network.chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    config: {
      timingProfile,
      l1DeploymentPath: config.l1DeploymentPath,
      l1Token: config.l1Token,
      name: config.name,
      symbol: config.symbol,
      factoryAddress: config.factoryAddress,
      l2StandardBridgeAddress: config.l2StandardBridgeAddress,
    },
    contracts: {
      l1Token: config.l1Token,
      l2Token: result.l2Token,
      mintableFactory: config.factoryAddress,
      l2StandardBridge: result.bridge,
    },
    verification: {
      remoteToken: result.remoteToken,
      bridge: result.bridge,
      txHash: result.txHash,
      reusedExisting: result.reusedExisting ?? false,
    },
  };

  const outPath = path.resolve(
    process.cwd(),
    getProfileAwareL2TokenDeploymentArtifactName(timingProfile, networkName),
  );
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
