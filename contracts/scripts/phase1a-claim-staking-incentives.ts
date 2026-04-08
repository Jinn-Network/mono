import { ethers } from "hardhat";
import {
  BASE_SEPOLIA_CHAIN_ID,
  buildStakingNominee,
  loadPhase1aArtifactsFromDisk,
} from "./lib/phase1a-rollout-helpers";

interface ClaimStakingConfig {
  numClaimedEpochs: bigint;
  chainId: number;
  stakingTarget: string;
  bridgePayload: string;
}

const DISPENSER_ABI = [
  "function getEpochEndTime(uint256 epoch) view returns (uint256)",
  "function claimStakingIncentives(uint256 numClaimedEpochs, uint256 chainId, bytes32 stakingTarget, bytes bridgePayload)",
  "function calculateStakingIncentives(uint256 numClaimedEpochs, uint256 chainId, bytes32 stakingTarget, uint256 bridgingDecimals) returns (uint256,uint256,uint256,bytes32)",
];

const DEPOSIT_PROCESSOR_ABI = [
  "function getBridgingDecimals() view returns (uint256)",
];

export function resolveClaimStakingIncentivesConfig(
  stakingToken: string,
  env: Record<string, string | undefined> = process.env,
): ClaimStakingConfig {
  const chainId = Number(env.PHASE1A_STAKING_CHAIN_ID ?? BASE_SEPOLIA_CHAIN_ID);
  const targetAddress = env.PHASE1A_STAKING_TARGET ?? stakingToken;
  if (!ethers.isAddress(targetAddress)) {
    throw new Error(`Invalid staking target address: ${targetAddress}`);
  }

  const bridgeGasLimit = env.PHASE1A_BRIDGE_MESSAGE_GAS_LIMIT?.trim();
  const bridgePayload = bridgeGasLimit
    ? ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [BigInt(bridgeGasLimit)])
    : "0x";

  return {
    numClaimedEpochs: BigInt(env.PHASE1A_NUM_CLAIMED_EPOCHS ?? "1"),
    chainId,
    stakingTarget: ethers.zeroPadValue(targetAddress, 32),
    bridgePayload,
  };
}

async function main() {
  const artifacts = loadPhase1aArtifactsFromDisk();
  const [signer] = await ethers.getSigners();
  const config = resolveClaimStakingIncentivesConfig(artifacts.stakingTokenL2);
  const dispenser = new ethers.Contract(artifacts.dispenserL1, DISPENSER_ABI, signer);
  const depositProcessor = new ethers.Contract(artifacts.depositProcessorL1, DEPOSIT_PROCESSOR_ABI, signer);
  const bridgingDecimals = (await depositProcessor.getBridgingDecimals()) as bigint;
  const { nomineeHash } = buildStakingNominee(
    ethers.getAddress(ethers.dataSlice(config.stakingTarget, 12)),
    config.chainId,
  );

  const [stakingIncentive, returnAmount, lastClaimedEpoch, probeNomineeHash] =
    (await dispenser.calculateStakingIncentives.staticCall(
      config.numClaimedEpochs,
      config.chainId,
      config.stakingTarget,
      bridgingDecimals,
    )) as [bigint, bigint, bigint, string];

  console.log(`Signer:             ${signer.address}`);
  console.log(`Dispenser:          ${artifacts.dispenserL1}`);
  console.log(`Staking target:     ${config.stakingTarget}`);
  console.log(`Num claimed epochs: ${config.numClaimedEpochs}`);
  console.log(`Bridging decimals:  ${bridgingDecimals}`);
  console.log(`Nominee hash:       ${nomineeHash}`);
  console.log(`Probe nominee hash: ${probeNomineeHash}`);
  console.log(`Claimable JINN:     ${ethers.formatEther(stakingIncentive)}`);
  console.log(`Return amount:      ${ethers.formatEther(returnAmount)}`);
  console.log(`Through epoch:      ${lastClaimedEpoch}`);

  const tx = await dispenser.claimStakingIncentives(
    config.numClaimedEpochs,
    config.chainId,
    config.stakingTarget,
    config.bridgePayload,
  );
  console.log(`Claim tx:           ${tx.hash}`);
  await tx.wait();
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
