import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type EnvMap = Record<string, string | undefined>;

interface DeploymentArtifact {
  contracts: Record<string, string | undefined>;
}

interface Phase1aArtifactInput {
  l1Deployment: DeploymentArtifact;
  l2Deployment: DeploymentArtifact;
  bridgeDeployment: DeploymentArtifact;
  env?: EnvMap;
}

export interface Phase1aArtifactPaths {
  l1: string;
  l2Token: string;
  l2: string;
  bridge: string;
}

export interface Phase1aArtifacts {
  l1Jinn: string;
  veOLASL1: string;
  tokenomicsL1: string;
  dispenserL1: string;
  voteWeightingL1: string;
  jinnL2: string;
  stakingFactoryL2: string;
  stakingTokenL2: string;
  depositProcessorL1: string;
  targetDispenserL2: string;
}

export const SEPOLIA_CHAIN_ID = 11155111;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

export type Phase1aTimingProfile = "canonical" | "fast-test";

export function resolvePhase1aTimingProfile(env: EnvMap = process.env): Phase1aTimingProfile {
  return env.PHASE1A_TIMING_PROFILE === "fast-test" ? "fast-test" : "canonical";
}

export function getPhase1aArtifactSuffix(profile: Phase1aTimingProfile): string {
  return profile === "fast-test" ? "-fast" : "";
}

export function getL1DeploymentArtifactName(profile: Phase1aTimingProfile, networkName = "sepolia"): string {
  return `deployment-phase1a-${networkName}${getPhase1aArtifactSuffix(profile)}.json`;
}

export function getL2TokenDeploymentArtifactName(
  profile: Phase1aTimingProfile,
  networkName: string,
): string {
  const normalizedNetworkName = networkName === "base-sepolia" ? "baseSepolia" : networkName;
  return `deployment-phase1a-token-${normalizedNetworkName}${getPhase1aArtifactSuffix(profile)}.json`;
}

export function getL2DeploymentArtifactName(
  profile: Phase1aTimingProfile,
  networkName: string,
): string {
  const normalizedNetworkName = networkName === "base-sepolia" ? "baseSepolia" : networkName;
  return `deployment-phase1a-l2-${normalizedNetworkName}${getPhase1aArtifactSuffix(profile)}.json`;
}

export function getBridgeDeploymentArtifactName(
  profile: Phase1aTimingProfile,
  l1NetworkName = "sepolia",
  l2NetworkName = "baseSepolia",
): string {
  return `deployment-phase1a-bridge-${l1NetworkName}-${l2NetworkName}${getPhase1aArtifactSuffix(profile)}.json`;
}

export function loadJson<T>(fileName: string): T {
  const filePath = path.resolve(process.cwd(), fileName);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Missing Phase 1a artifact file: ${filePath}. Deploy the missing rollout phase or override the artifact path env vars before continuing.`,
      );
    }
    throw error;
  }
}

function requireAddress(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Missing Phase 1a rollout address: ${label}`);
  }

  if (!ethers.isAddress(value)) {
    throw new Error(`Invalid Phase 1a rollout address for ${label}: ${value}`);
  }

  return value;
}

export function resolvePhase1aArtifactPaths(env: EnvMap = process.env): Phase1aArtifactPaths {
  const profile = resolvePhase1aTimingProfile(env);
  return {
    l1: env.PHASE1A_L1_DEPLOYMENT ?? getL1DeploymentArtifactName(profile),
    l2Token: env.PHASE1A_L2_TOKEN_DEPLOYMENT ?? getL2TokenDeploymentArtifactName(profile, "baseSepolia"),
    l2: env.PHASE1A_L2_DEPLOYMENT ?? getL2DeploymentArtifactName(profile, "baseSepolia"),
    bridge: env.PHASE1A_BRIDGE_DEPLOYMENT ?? getBridgeDeploymentArtifactName(profile),
  };
}

export function resolvePhase1aArtifacts({
  l1Deployment,
  l2Deployment,
  bridgeDeployment,
  env = process.env,
}: Phase1aArtifactInput): Phase1aArtifacts {
  return {
    l1Jinn: requireAddress(env.JINN_TOKEN_L1 ?? l1Deployment.contracts.JINN, "l1Deployment.contracts.JINN"),
    veOLASL1: requireAddress(env.VE_OLAS_ADDRESS ?? l1Deployment.contracts.veOLAS, "l1Deployment.contracts.veOLAS"),
    tokenomicsL1: requireAddress(
      env.TOKENOMICS_ADDRESS ?? l1Deployment.contracts.Tokenomics,
      "l1Deployment.contracts.Tokenomics",
    ),
    dispenserL1: requireAddress(
      env.DISPENSER_ADDRESS ?? l1Deployment.contracts.Dispenser,
      "l1Deployment.contracts.Dispenser",
    ),
    voteWeightingL1: requireAddress(
      env.VOTE_WEIGHTING_ADDRESS ?? l1Deployment.contracts.VoteWeighting,
      "l1Deployment.contracts.VoteWeighting",
    ),
    jinnL2: requireAddress(env.JINN_TOKEN_L2 ?? l2Deployment.contracts.jinnToken, "l2Deployment.contracts.jinnToken"),
    stakingFactoryL2: requireAddress(
      env.STAKING_FACTORY_ADDRESS ?? l2Deployment.contracts.stakingFactory,
      "l2Deployment.contracts.stakingFactory",
    ),
    stakingTokenL2: requireAddress(
      env.STAKING_TOKEN_ADDRESS ?? l2Deployment.contracts.stakingToken,
      "l2Deployment.contracts.stakingToken",
    ),
    depositProcessorL1: requireAddress(
      env.DEPOSIT_PROCESSOR_L1 ?? bridgeDeployment.contracts.depositProcessorL1,
      "bridgeDeployment.contracts.depositProcessorL1",
    ),
    targetDispenserL2: requireAddress(
      env.TARGET_DISPENSER_L2 ?? bridgeDeployment.contracts.targetDispenserL2,
      "bridgeDeployment.contracts.targetDispenserL2",
    ),
  };
}

export function loadPhase1aArtifactsFromDisk(env: EnvMap = process.env): Phase1aArtifacts {
  const paths = resolvePhase1aArtifactPaths(env);

  return resolvePhase1aArtifacts({
    l1Deployment: loadJson<DeploymentArtifact>(paths.l1),
    l2Deployment: loadJson<DeploymentArtifact>(paths.l2),
    bridgeDeployment: loadJson<DeploymentArtifact>(paths.bridge),
    env,
  });
}

export function buildStakingNominee(stakingToken: string, chainId: number | bigint) {
  if (!ethers.isAddress(stakingToken)) {
    throw new Error(`Invalid staking token address: ${stakingToken}`);
  }

  const normalizedChainId = typeof chainId === "bigint" ? chainId : BigInt(chainId);
  if (normalizedChainId <= 0n) {
    throw new Error(`Invalid staking chain id: ${chainId}`);
  }

  const stakingTarget = ethers.zeroPadValue(stakingToken, 32);
  const nomineeHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [stakingTarget, normalizedChainId]),
  );

  return {
    stakingTarget,
    nomineeHash,
  };
}

export function isStakingIncentivesEnabled(pauseState: bigint): boolean {
  return pauseState === 0n || pauseState === 1n;
}

export function getTargetPauseStateForStaking(currentPauseState: bigint): bigint {
  if (isStakingIncentivesEnabled(currentPauseState)) {
    return currentPauseState;
  }

  return 1n;
}
