import { network } from "hardhat";
import { ethers } from "ethers";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadPhase1aArtifactsFromDisk } from "./lib/phase1a-rollout-helpers.js";
import { isRunEntry } from "./lib/run-entry.js";

type HardhatEthers = Awaited<ReturnType<typeof network.connect>>["ethers"];
type HardhatProvider = HardhatEthers["provider"];

const SAFE_EXECUTION_GAS_LIMIT = 2_000_000n;

interface ClaimL2Config {
  serviceId: bigint;
  mode: "claim" | "checkpointAndClaim";
  dryRun: boolean;
  safeOwnerPrivateKey?: string;
  safeOwnerKeystorePath: string;
}

const STAKING_ABI = [
  "function getServiceInfo(uint256 serviceId) view returns ((address multisig,address owner,uint256[] nonces,uint256 tsStart,uint256 reward,uint256 inactivity,uint256 rewardDistributionInfo))",
  "function calculateStakingReward(uint256 serviceId) view returns (uint256)",
  "function claim(uint256 serviceId) returns (uint256)",
  "function checkpointAndClaim(uint256 serviceId) returns (uint256)",
];

const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
];

interface ServiceInfo {
  owner: string;
  multisig: string;
  reward: bigint;
}

interface SafeInfo {
  owners: string[];
  threshold: bigint;
  nonce: bigint;
}

type CandidateSigner = {
  signer: any;
  address: string;
  source: string;
};

export function resolveClaimL2KeystorePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicitPath = env.PHASE1A_SAFE_OWNER_KEYSTORE_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  const earningDir =
    env.PHASE1A_EARNING_DIR?.trim() ||
    env.JINN_EARNING_DIR?.trim() ||
    path.join(os.homedir(), ".jinn-client", "earning");
  return path.join(earningDir, "agent_keystore.json");
}

export function resolveClaimL2Config(
  env: Record<string, string | undefined> = process.env,
): ClaimL2Config {
  const serviceId = env.PHASE1A_SERVICE_ID;
  if (!serviceId) {
    throw new Error("PHASE1A_SERVICE_ID is required for L2 reward claims.");
  }

  const mode = env.PHASE1A_L2_CLAIM_MODE === "claim" ? "claim" : "checkpointAndClaim";
  return {
    serviceId: BigInt(serviceId),
    mode,
    dryRun: env.PHASE1A_DRY_RUN === "true",
    safeOwnerPrivateKey: env.PHASE1A_SAFE_OWNER_PRIVATE_KEY?.trim() || undefined,
    safeOwnerKeystorePath: resolveClaimL2KeystorePath(env),
  };
}

function isSameAddress(lhs: string, rhs: string) {
  return ethers.getAddress(lhs) === ethers.getAddress(rhs);
}

async function loadSafeInfo(provider: HardhatProvider, owner: string): Promise<SafeInfo | null> {
  const safe = new ethers.Contract(owner, SAFE_ABI, provider);

  try {
    const [owners, threshold, nonce] = (await Promise.all([
      safe.getOwners(),
      safe.getThreshold(),
      safe.nonce(),
    ])) as [string[], bigint, bigint];

    return {
      owners: owners.map((candidate) => ethers.getAddress(candidate)),
      threshold,
      nonce,
    };
  } catch {
    return null;
  }
}

async function buildCandidateSigners(hh: HardhatEthers): Promise<CandidateSigner[]> {
  const [defaultSigner] = await hh.getSigners();
  const defaultAddress = await defaultSigner.getAddress();
  const candidates: CandidateSigner[] = [
    {
      signer: defaultSigner,
      address: ethers.getAddress(defaultAddress),
      source: "hardhat signer",
    },
  ];

  return candidates;
}

async function loadConfiguredSafeOwnerSigner(provider: HardhatProvider, config: ClaimL2Config): Promise<CandidateSigner | null> {
  if (config.safeOwnerPrivateKey) {
    const privateKeyWallet = new ethers.Wallet(config.safeOwnerPrivateKey, provider);
    return {
      signer: privateKeyWallet,
      address: ethers.getAddress(privateKeyWallet.address),
      source: "PHASE1A_SAFE_OWNER_PRIVATE_KEY",
    };
  }

  if (!fs.existsSync(config.safeOwnerKeystorePath)) {
    return null;
  }

  const password = process.env.JINN_PASSWORD;
  if (!password) {
    return null;
  }

  const keystoreJson = fs.readFileSync(config.safeOwnerKeystorePath, "utf8");
  const keystoreWallet = (await ethers.Wallet.fromEncryptedJson(keystoreJson, password)).connect(provider);
  return {
    signer: keystoreWallet,
    address: ethers.getAddress(keystoreWallet.address),
    source: config.safeOwnerKeystorePath,
  };
}

function pickSafeSigner(candidates: CandidateSigner[], safeOwners: string[]): CandidateSigner | undefined {
  return candidates.find((candidate) => safeOwners.some((owner) => isSameAddress(owner, candidate.address)));
}

async function resolveSafeSigner(hh: HardhatEthers, config: ClaimL2Config, safeOwners: string[]): Promise<CandidateSigner | undefined> {
  const candidates = await buildCandidateSigners(hh);
  const directMatch = pickSafeSigner(candidates, safeOwners);
  if (directMatch) {
    return directMatch;
  }

  const configuredSigner = await loadConfiguredSafeOwnerSigner(hh.provider, config);
  if (!configuredSigner) {
    return undefined;
  }

  return safeOwners.some((owner) => isSameAddress(owner, configuredSigner.address)) ? configuredSigner : undefined;
}

async function resolveDirectOwnerSigner(hh: HardhatEthers, config: ClaimL2Config, owner: string): Promise<CandidateSigner | undefined> {
  const candidates = await buildCandidateSigners(hh);
  const directMatch = candidates.find((candidate) => isSameAddress(candidate.address, owner));
  if (directMatch) {
    return directMatch;
  }

  const configuredSigner = await loadConfiguredSafeOwnerSigner(hh.provider, config);
  if (!configuredSigner) {
    return undefined;
  }

  return isSameAddress(configuredSigner.address, owner) ? configuredSigner : undefined;
}

function formatRewardSummary(label: string, value: bigint) {
  return `${label.padEnd(14)} ${ethers.formatEther(value)} JINN`;
}

async function claimAsSafe(
  provider: HardhatProvider,
  config: ClaimL2Config,
  serviceInfo: ServiceInfo,
  safeInfo: SafeInfo,
  candidate: CandidateSigner,
  stakingAddress: string,
) {
  if (safeInfo.threshold !== 1n) {
    throw new Error(
      `Service owner Safe ${serviceInfo.owner} has threshold ${safeInfo.threshold}. ` +
        "This helper only supports 1-of-N Safes.",
    );
  }

  const safe = new ethers.Contract(serviceInfo.owner, SAFE_ABI, candidate.signer);
  const staking = new ethers.Contract(stakingAddress, STAKING_ABI, provider);
  const claimData = staking.interface.encodeFunctionData(config.mode, [config.serviceId]);

  console.log(`Execution:    Safe owner via ${candidate.source}`);
  console.log(`Safe owner:   ${serviceInfo.owner}`);
  console.log(`Safe signer:  ${candidate.address}`);
  console.log(`Safe nonce:   ${safeInfo.nonce}`);
  console.log(`Threshold:    ${safeInfo.threshold}`);

  if (config.dryRun) {
    console.log("Dry run only; not sending Safe transaction.");
    return;
  }

  const safeTxHash = (await safe.getTransactionHash(
    stakingAddress,
    0,
    claimData,
    0,
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    safeInfo.nonce,
  )) as string;

  const signature = await candidate.signer.signMessage(ethers.getBytes(safeTxHash));
  const signatureBytes = ethers.getBytes(signature);
  const adjustedSignature = ethers.concat([
    signatureBytes.slice(0, 32),
    signatureBytes.slice(32, 64),
    new Uint8Array([signatureBytes[64] + 4]),
  ]);

  const tx = await safe.execTransaction(
    stakingAddress,
    0,
    claimData,
    0,
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    adjustedSignature,
    { gasLimit: SAFE_EXECUTION_GAS_LIMIT },
  );

  console.log(`Safe tx:      ${tx.hash}`);
  await tx.wait();
}

async function main() {
  const { ethers: hh } = await network.connect();
  const provider = hh.provider;
  const artifacts = loadPhase1aArtifactsFromDisk();
  const config = resolveClaimL2Config();
  const staking = new ethers.Contract(artifacts.stakingTokenL2, STAKING_ABI, provider);
  const serviceInfo = (await staking.getServiceInfo(config.serviceId)) as ServiceInfo;
  const safeInfo = await loadSafeInfo(provider, serviceInfo.owner);
  const calculatedReward = (await staking.calculateStakingReward(config.serviceId)) as bigint;

  console.log(`Staking:      ${artifacts.stakingTokenL2}`);
  console.log(`Service ID:   ${config.serviceId}`);
  console.log(`Owner:        ${serviceInfo.owner}`);
  console.log(`Multisig:     ${serviceInfo.multisig}`);
  console.log(`Mode:         ${config.mode}`);
  console.log(formatRewardSummary("Stored reward:", serviceInfo.reward));
  console.log(formatRewardSummary("Live reward:", calculatedReward));

  if (serviceInfo.reward === 0n && calculatedReward === 0n) {
    console.log("No reward available to claim.");
    return;
  }

  if (safeInfo) {
    console.log("Ownership:    Safe-owned service");
    const safeSigner = await resolveSafeSigner(hh, config, safeInfo.owners);
    if (!safeSigner) {
      const candidates = await buildCandidateSigners(hh);
      const candidateSummary = candidates.map((candidate) => `${candidate.address} (${candidate.source})`).join(", ");
      const keystoreHint =
        fs.existsSync(config.safeOwnerKeystorePath) && !process.env.JINN_PASSWORD
          ? ` Provide JINN_PASSWORD to decrypt ${config.safeOwnerKeystorePath}.`
          : "";
      throw new Error(
        `Service owner ${serviceInfo.owner} is a Safe. None of the available signers is a Safe owner. ` +
          `Candidates: ${candidateSummary || "none"}.${keystoreHint}`,
      );
    }

    await claimAsSafe(provider, config, serviceInfo, safeInfo, safeSigner, artifacts.stakingTokenL2);
    return;
  }

  console.log("Ownership:    Direct EOA-owned service");
  const directSigner = await resolveDirectOwnerSigner(hh, config, serviceInfo.owner);
  if (!directSigner) {
    const candidates = await buildCandidateSigners(hh);
    const candidateSummary = candidates.map((candidate) => `${candidate.address} (${candidate.source})`).join(", ");
    const keystoreHint =
      fs.existsSync(config.safeOwnerKeystorePath) && !process.env.JINN_PASSWORD
        ? ` Provide JINN_PASSWORD to decrypt ${config.safeOwnerKeystorePath}.`
        : "";
    throw new Error(
      `Service owner ${serviceInfo.owner} is not the connected signer. ` +
        `Set PHASE1A_SAFE_OWNER_PRIVATE_KEY or PHASE1A_SAFE_OWNER_KEYSTORE_PATH. Candidates: ${candidateSummary || "none"}.${keystoreHint}`,
    );
  }

  console.log(`Execution:    Direct owner via ${directSigner.source}`);
  console.log(`Signer:       ${directSigner.address}`);

  if (config.dryRun) {
    console.log("Dry run only; not sending owner transaction.");
    return;
  }

  const stakingWithSigner = staking.connect(directSigner.signer) as any;
  const tx = await stakingWithSigner[config.mode](config.serviceId);
  console.log(`${config.mode} tx: ${tx.hash}`);
  await tx.wait();
}

if (isRunEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
