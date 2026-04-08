import { ethers } from "hardhat";
import { loadJson, resolvePhase1aArtifactPaths } from "./lib/phase1a-rollout-helpers";

interface DeploymentArtifact {
  contracts: Record<string, string | undefined>;
}

interface RecordActivityConfig {
  multisig?: string;
  serviceId?: bigint;
  activityTypes: number[];
}

const ACTIVITY_CHECKER_ABI = [
  "function recordActivity(address multisig, uint8 activityType)",
];

const STAKING_ABI = [
  "function getServiceInfo(uint256 serviceId) view returns ((address multisig,address owner,uint256[] nonces,uint256 tsStart,uint256 reward,uint256 inactivity,uint256 rewardDistributionInfo))",
];

export function resolveRecordActivityConfig(
  env: Record<string, string | undefined> = process.env,
): RecordActivityConfig {
  const activityTypes = (env.PHASE1A_ACTIVITY_TYPES ?? "0,1,2")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value));

  if (activityTypes.some((value) => !Number.isInteger(value) || value < 0 || value > 2)) {
    throw new Error(`PHASE1A_ACTIVITY_TYPES must only contain 0, 1, or 2. Received: ${activityTypes.join(",")}`);
  }

  return {
    multisig: env.PHASE1A_MULTISIG,
    serviceId: env.PHASE1A_SERVICE_ID ? BigInt(env.PHASE1A_SERVICE_ID) : undefined,
    activityTypes,
  };
}

async function main() {
  const paths = resolvePhase1aArtifactPaths();
  const deployment = loadJson<DeploymentArtifact>(paths.l2);
  const activityCheckerAddress = deployment.contracts.activityChecker;
  const stakingTokenAddress = deployment.contracts.stakingToken;
  if (!activityCheckerAddress || !stakingTokenAddress) {
    throw new Error("L2 deployment artifact must include activityChecker and stakingToken.");
  }

  const [signer] = await ethers.getSigners();
  const config = resolveRecordActivityConfig();
  let multisig = config.multisig;

  if (!multisig) {
    if (config.serviceId === undefined) {
      throw new Error("Set PHASE1A_MULTISIG or PHASE1A_SERVICE_ID.");
    }
    const staking = new ethers.Contract(stakingTokenAddress, STAKING_ABI, signer);
    const serviceInfo = (await staking.getServiceInfo(config.serviceId)) as { multisig: string };
    multisig = serviceInfo.multisig;
  }

  if (!ethers.isAddress(multisig)) {
    throw new Error(`Invalid multisig address: ${multisig}`);
  }

  const checker = new ethers.Contract(activityCheckerAddress, ACTIVITY_CHECKER_ABI, signer);
  console.log(`Signer:           ${signer.address}`);
  console.log(`Activity checker: ${activityCheckerAddress}`);
  console.log(`Multisig:         ${multisig}`);
  console.log(`Activity types:   ${config.activityTypes.join(", ")}`);

  const baseNonce = await signer.getNonce("pending");

  for (const [index, activityType] of config.activityTypes.entries()) {
    const tx = await checker.recordActivity(multisig, activityType, {
      nonce: baseNonce + index,
    });
    console.log(`recordActivity(${activityType}) tx: ${tx.hash}`);
    await tx.wait();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
