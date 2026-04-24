/**
 * phase1a-heartbeat-vote-weighting.ts — Keep VoteWeighting.timeSum fresh.
 *
 * Calls VoteWeighting.checkpoint() and checkpointNominee() so the internal
 * _getSum() / _getWeight() walks advance timeSum / timeWeight before the
 * _maxNumPeriods iteration cap kicks in. Skipping this for longer than
 * _maxNumPeriods * _period permanently bricks the contract (jinn-mono-5hc).
 *
 * On fast-test the cap is 10_000 periods * 900s ≈ 104 days post-fix. Run
 * at least weekly — sooner is fine, gas is trivial once timeSum is close
 * to now (the walker only iterates the few periods that have elapsed).
 *
 * Usage (any signer — no access control on either function):
 *   PHASE1A_TIMING_PROFILE=fast-test \
 *     npx hardhat run scripts/phase1a-heartbeat-vote-weighting.ts --network sepolia
 */

import { ethers } from "hardhat";
import {
  BASE_SEPOLIA_CHAIN_ID,
  buildStakingNominee,
  loadPhase1aArtifactsFromDisk,
} from "./lib/phase1a-rollout-helpers";

const VW_ABI = [
  "function WEEK() view returns (uint256)",
  "function MAX_NUM_WEEKS() view returns (uint256)",
  "function timeSum() view returns (uint256)",
  "function checkpoint()",
  "function checkpointNominee(bytes32 account, uint256 chainId)",
];

async function main() {
  const artifacts = loadPhase1aArtifactsFromDisk();
  const [signer] = await ethers.getSigners();
  const vw = new ethers.Contract(artifacts.voteWeightingL1, VW_ABI, signer);

  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const week = (await vw.WEEK()) as bigint;
  const max = (await vw.MAX_NUM_WEEKS()) as bigint;
  const before = (await vw.timeSum()) as bigint;
  const gapBefore = now > before ? (now - before) / week : 0n;

  console.log(`VoteWeighting: ${artifacts.voteWeightingL1}`);
  console.log(`now:           ${now}`);
  console.log(`WEEK:          ${week}s`);
  console.log(`MAX_NUM_WEEKS: ${max}`);
  console.log(`timeSum:       ${before} (gap=${gapBefore} periods)`);

  if (gapBefore >= max) {
    throw new Error(
      `Gap ${gapBefore} ≥ MAX_NUM_WEEKS ${max}. The walker cannot catch up — this deployment needs a full redeploy via phase1a-redeploy-vote-weighting.ts.`,
    );
  }

  const ckTx = await vw.checkpoint();
  const ckReceipt = await ckTx.wait();
  console.log(`checkpoint tx:          ${ckTx.hash} gas=${ckReceipt?.gasUsed}`);

  const { stakingTarget } = buildStakingNominee(artifacts.stakingTokenL2, BASE_SEPOLIA_CHAIN_ID);
  const cnTx = await vw.checkpointNominee(stakingTarget, BASE_SEPOLIA_CHAIN_ID);
  const cnReceipt = await cnTx.wait();
  console.log(`checkpointNominee tx:   ${cnTx.hash} gas=${cnReceipt?.gasUsed}`);

  const after = (await vw.timeSum()) as bigint;
  const nowAfter = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const gapAfter = nowAfter > after ? (nowAfter - after) / week : 0n;
  console.log(`timeSum after: ${after} (gap=${gapAfter} periods)`);

  // Healthy: either timeSum advanced, or it was already ≥ now (nothing to do).
  // Stuck: timeSum < now AND didn't move — iteration cap hit, redeploy required.
  if (after < nowAfter && after <= before) {
    throw new Error(
      `timeSum is behind now and did not advance (before=${before}, after=${after}, now=${nowAfter}). Walker is stuck — redeploy required.`,
    );
  }
  console.log(`✓ Walker healthy.`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
