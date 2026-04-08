import { ethers } from "hardhat";
import {
  BASE_SEPOLIA_CHAIN_ID,
  buildStakingNominee,
  isStakingIncentivesEnabled,
  loadPhase1aArtifactsFromDisk,
} from "./lib/phase1a-rollout-helpers";

const DISPENSER_ABI = [
  "function paused() view returns (uint8)",
  "function mapLastClaimedStakingEpochs(bytes32) view returns (uint256)",
];

const VOTE_WEIGHTING_ABI = [
  "function getNomineeId(bytes32 account, uint256 chainId) view returns (uint256)",
  "function addNomineeEVM(address account, uint256 chainId)",
];

async function main() {
  const artifacts = loadPhase1aArtifactsFromDisk();
  const [signer] = await ethers.getSigners();
  const { stakingTarget, nomineeHash } = buildStakingNominee(
    artifacts.stakingTokenL2,
    BASE_SEPOLIA_CHAIN_ID,
  );

  const dispenser = new ethers.Contract(artifacts.dispenserL1, DISPENSER_ABI, signer);
  const voteWeighting = new ethers.Contract(artifacts.voteWeightingL1, VOTE_WEIGHTING_ABI, signer);

  const [pauseState, nomineeIdBefore] = await Promise.all([
    dispenser.paused() as Promise<bigint>,
    voteWeighting.getNomineeId(stakingTarget, BASE_SEPOLIA_CHAIN_ID) as Promise<bigint>,
  ]);

  console.log(`Signer:             ${signer.address}`);
  console.log(`VoteWeighting:      ${artifacts.voteWeightingL1}`);
  console.log(`Dispenser:          ${artifacts.dispenserL1}`);
  console.log(`Staking target L2:  ${artifacts.stakingTokenL2}`);
  console.log(`Staking target key: ${stakingTarget}`);
  console.log(`Nominee hash:       ${nomineeHash}`);
  console.log(`Existing nomineeId: ${nomineeIdBefore}`);

  if (!isStakingIncentivesEnabled(pauseState)) {
    throw new Error(
      `Dispenser pause state is ${pauseState}. Run scripts/phase1a-unpause-dispenser.ts first.`,
    );
  }

  if (nomineeIdBefore > 0n) {
    const bookmark = (await dispenser.mapLastClaimedStakingEpochs(nomineeHash)) as bigint;
    console.log(`Nominee already exists. Last claimed epoch bookmark: ${bookmark}`);
    return;
  }

  const tx = await voteWeighting.addNomineeEVM(artifacts.stakingTokenL2, BASE_SEPOLIA_CHAIN_ID);
  console.log(`Submitted tx:       ${tx.hash}`);
  await tx.wait();

  const [nomineeIdAfter, bookmark] = await Promise.all([
    voteWeighting.getNomineeId(stakingTarget, BASE_SEPOLIA_CHAIN_ID) as Promise<bigint>,
    dispenser.mapLastClaimedStakingEpochs(nomineeHash) as Promise<bigint>,
  ]);

  console.log(`Nominee id:         ${nomineeIdAfter}`);
  console.log(`Epoch bookmark:     ${bookmark}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
