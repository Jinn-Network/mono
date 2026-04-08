import { ethers } from "hardhat";
import {
  getTargetPauseStateForStaking,
  isStakingIncentivesEnabled,
  loadPhase1aArtifactsFromDisk,
} from "./lib/phase1a-rollout-helpers";

const DISPENSER_ABI = [
  "function paused() view returns (uint8)",
  "function setPauseState(uint8 pauseState)",
];

function pauseLabel(value: bigint): string {
  switch (value) {
    case 0n:
      return "Unpaused";
    case 1n:
      return "DevIncentivesPaused";
    case 2n:
      return "StakingIncentivesPaused";
    case 3n:
      return "AllPaused";
    default:
      return `Unknown(${value})`;
  }
}

async function main() {
  const artifacts = loadPhase1aArtifactsFromDisk();
  const [signer] = await ethers.getSigners();
  const dispenser = new ethers.Contract(artifacts.dispenserL1, DISPENSER_ABI, signer);

  const before = (await dispenser.paused()) as bigint;
  const requestedPauseState = process.env.PHASE1A_DISPENSER_PAUSE_STATE?.trim();
  const targetPauseState =
    requestedPauseState !== undefined && requestedPauseState !== ""
      ? BigInt(requestedPauseState)
      : getTargetPauseStateForStaking(before);
  console.log(`Signer:              ${signer.address}`);
  console.log(`Dispenser:           ${artifacts.dispenserL1}`);
  console.log(`Current pause state: ${pauseLabel(before)}`);
  console.log(`Target pause state:  ${pauseLabel(targetPauseState)}`);

  if (!isStakingIncentivesEnabled(targetPauseState)) {
    throw new Error(
      `Target pause state ${targetPauseState} does not permit staking incentives. ` +
        "Use 0 (Unpaused) or 1 (DevIncentivesPaused).",
    );
  }

  if (before === targetPauseState) {
    console.log("Dispenser already allows staking incentives.");
    return;
  }

  const tx = await dispenser.setPauseState(Number(targetPauseState));
  console.log(`Submitted tx:        ${tx.hash}`);
  await tx.wait();

  const after = (await dispenser.paused()) as bigint;
  console.log(`Updated pause state: ${pauseLabel(after)}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
