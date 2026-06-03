import { isRunEntry } from "./lib/run-entry.js";
/**
 * phase1a-redeploy-vote-weighting.ts — Redeploy VoteWeightingFast and rewire.
 *
 * Recovery script for the 10.4-day quiet-tolerance stall in OLAS
 * VoteWeightingFast (jinn-mono-5hc). Once timeSum drifts more than
 * _maxNumPeriods * _period behind block.timestamp, _getSum() can't catch up
 * and nomineeRelativeWeight returns 0 permanently. Since VoteWeighting is
 * not behind a proxy and there is no admin resetTimeSum hook, recovery is
 * a redeploy of this single contract. Everything else in the Phase 1a
 * stack — JINN, Treasury, Tokenomics, Depository, Dispenser, veJINN,
 * bridge, L2 — stays put.
 *
 * Usage:
 *   PHASE1A_TIMING_PROFILE=fast-test \
 *     npx hardhat run scripts/phase1a-redeploy-vote-weighting.ts --network sepolia
 *
 * What it does, in order (order matters — Dispenser.addNominee is gated on
 * msg.sender == voteWeighting, so Dispenser must be pointed at the new VW
 * before the new VW can register a nominee that calls back into Dispenser):
 *
 *   1. Load fast-test artifact + existing contract addresses.
 *   2. Idempotency guard: if existing VoteWeighting already exposes
 *      MAX_NUM_WEEKS() >= 10_000, we already ran this — exit clean.
 *   3. Deploy VoteWeightingFast(existingVeOLAS) → VW_new.
 *   4. Dispenser.changeManagers(0, 0, VW_new) — point Dispenser at VW_new.
 *   5. VW_new.changeDispenser(existingDispenser) — point VW_new at Dispenser.
 *   6. VW_new.addNomineeEVM(stakingTokenL2, BASE_SEPOLIA_CHAIN_ID). Side
 *      effect: Dispenser.addNominee(hash) is called internally and resets
 *      mapLastClaimedStakingEpochs[hash] to the current epochCounter,
 *      abandoning the 137k JINN of stuck return-amount for prior epochs —
 *      those were already permanently unreachable due to zero effective
 *      weight during the stall.
 *   7. Rewrite contracts.VoteWeighting in the fast-test deployment JSON.
 *   8. Print next-step commands (vote → tick → claim).
 *
 * Safe to re-run: step 2 short-circuits the happy path.
 */

import { network } from "hardhat";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import {
  BASE_SEPOLIA_CHAIN_ID,
  buildStakingNominee,
  loadJson,
  resolvePhase1aArtifactPaths,
  resolvePhase1aTimingProfile,
} from "./lib/phase1a-rollout-helpers.js";

interface DeploymentArtifact {
  contracts: Record<string, string | undefined>;
  [key: string]: unknown;
}

const DISPENSER_ABI = [
  "function owner() view returns (address)",
  "function voteWeighting() view returns (address)",
  "function tokenomics() view returns (address)",
  "function treasury() view returns (address)",
  "function paused() view returns (uint8)",
  "function changeManagers(address _tokenomics, address _treasury, address _voteWeighting)",
];

const VW_ABI = [
  "function owner() view returns (address)",
  "function dispenser() view returns (address)",
  "function ve() view returns (address)",
  "function MAX_NUM_WEEKS() view returns (uint256)",
  "function WEEK() view returns (uint256)",
  "function timeSum() view returns (uint256)",
  "function changeDispenser(address newDispenser)",
  "function addNomineeEVM(address account, uint256 chainId)",
  "function getNomineeId(bytes32,uint256) view returns (uint256)",
];

const TREASURY_ABI = ["function paused() view returns (uint8)"];

function requireAddress(value: string | undefined, label: string): string {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`Invalid or missing address for ${label}: ${value}`);
  }
  return value;
}

async function main() {
  const { ethers: hh } = await network.connect();
  if (resolvePhase1aTimingProfile() !== "fast-test") {
    throw new Error(
      "This script targets VoteWeightingFast only. Set PHASE1A_TIMING_PROFILE=fast-test.",
    );
  }

  const paths = resolvePhase1aArtifactPaths();
  const l1Path = path.resolve(process.cwd(), paths.l1);
  const artifact = loadJson<DeploymentArtifact>(paths.l1);

  const jinn = requireAddress(artifact.contracts.JINN, "JINN");
  const treasury = requireAddress(artifact.contracts.Treasury, "Treasury");
  const tokenomics = requireAddress(artifact.contracts.Tokenomics, "Tokenomics");
  const dispenserAddr = requireAddress(artifact.contracts.Dispenser, "Dispenser");
  const veOLAS = requireAddress(artifact.contracts.veOLAS, "veOLAS");
  const vwOld = requireAddress(artifact.contracts.VoteWeighting, "VoteWeighting (existing)");
  const l2Token = requireAddress(
    // Pull from L2 artifact path since the staking-token L2 address is the nominee target.
    loadJson<DeploymentArtifact>(paths.l2).contracts.stakingToken,
    "stakingToken (L2)",
  );

  const [signer] = await hh.getSigners();
  const vwOldContract = new ethers.Contract(vwOld, VW_ABI, signer);
  const dispenser = new ethers.Contract(dispenserAddr, DISPENSER_ABI, signer);
  const treasuryContract = new ethers.Contract(treasury, TREASURY_ABI, signer);

  console.log(`Network:       sepolia (fast-test profile)`);
  console.log(`Signer:        ${signer.address}`);
  console.log(`Deployer key matches:`);
  const dispenserOwner = (await dispenser.owner()) as string;
  console.log(`  Dispenser.owner  = ${dispenserOwner}`);
  if (dispenserOwner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} is not Dispenser.owner ${dispenserOwner}; cannot call changeManagers.`,
    );
  }

  console.log();
  console.log(`Existing addresses (from ${paths.l1}):`);
  console.log(`  JINN:           ${jinn}`);
  console.log(`  Treasury:       ${treasury}`);
  console.log(`  Tokenomics:     ${tokenomics}`);
  console.log(`  Dispenser:      ${dispenserAddr}`);
  console.log(`  veOLAS:         ${veOLAS}`);
  console.log(`  VoteWeighting:  ${vwOld}  (old)`);
  console.log(`  stakingTokenL2: ${l2Token}`);
  console.log();

  // ── Step 2: Idempotency guard ─────────────────────────────────────────
  try {
    const existingMax = (await vwOldContract.MAX_NUM_WEEKS()) as bigint;
    if (existingMax >= 10_000n) {
      console.log(`Existing VoteWeighting already has MAX_NUM_WEEKS=${existingMax}.`);
      console.log(`Nothing to do — redeploy appears to have already run.`);
      return;
    }
    console.log(`Existing VoteWeighting MAX_NUM_WEEKS=${existingMax} → proceeding with redeploy.`);
  } catch (e: any) {
    console.log(`Could not read existing MAX_NUM_WEEKS (${e.message?.slice(0, 80)}); proceeding.`);
  }

  // ── Pause sanity ──────────────────────────────────────────────────────
  const disPause = Number(await dispenser.paused());
  const trePause = Number(await treasuryContract.paused());
  console.log(`Dispenser.paused = ${disPause} (0=Unpaused,1=DevIncentivesPaused,2=StakingIncentivesPaused,3=AllPaused)`);
  console.log(`Treasury.paused  = ${trePause} (1=Unpaused,2=Paused)`);
  if (disPause === 2 || disPause === 3) {
    throw new Error(
      `Dispenser is in a paused state that blocks addNominee (paused=${disPause}). Unpause before retrying.`,
    );
  }
  if (trePause === 2) {
    throw new Error(`Treasury is paused (paused=2). Unpause before retrying.`);
  }

  // ── Step 3: Deploy new VoteWeightingFast ──────────────────────────────
  console.log();
  console.log(`Deploying VoteWeightingFast(${veOLAS})...`);
  const Factory = await hh.getContractFactory("VoteWeightingFast", signer);
  const vwNewContract = await Factory.deploy(veOLAS);
  const deployTx = vwNewContract.deploymentTransaction();
  if (deployTx) {
    console.log(`Deploy tx:     ${deployTx.hash}`);
    await deployTx.wait();
  }
  await vwNewContract.waitForDeployment();
  const vwNew = await vwNewContract.getAddress();
  console.log(`VoteWeighting (new): ${vwNew}`);

  const newVwHandle = new ethers.Contract(vwNew, VW_ABI, signer);
  const newMax = (await newVwHandle.MAX_NUM_WEEKS()) as bigint;
  const newWeek = (await newVwHandle.WEEK()) as bigint;
  const newTimeSum = (await newVwHandle.timeSum()) as bigint;
  console.log(`  MAX_NUM_WEEKS: ${newMax} (expected 10000)`);
  console.log(`  WEEK:          ${newWeek}s (expected 900)`);
  console.log(`  timeSum:       ${newTimeSum} (fresh — should be close to now)`);
  if (newMax !== 10_000n || newWeek !== 900n) {
    throw new Error(`New VoteWeighting has unexpected params; aborting before rewire.`);
  }

  // ── Step 4: Dispenser.changeManagers(0, 0, vwNew) ─────────────────────
  console.log();
  console.log(`Rewiring Dispenser.voteWeighting → ${vwNew}...`);
  const cmTx = await dispenser.changeManagers(ethers.ZeroAddress, ethers.ZeroAddress, vwNew);
  console.log(`changeManagers tx: ${cmTx.hash}`);
  await cmTx.wait();
  const dispenserVw = (await dispenser.voteWeighting()) as string;
  if (dispenserVw.toLowerCase() !== vwNew.toLowerCase()) {
    throw new Error(`Dispenser.voteWeighting = ${dispenserVw} after changeManagers; expected ${vwNew}.`);
  }
  console.log(`  Dispenser.voteWeighting = ${dispenserVw} ✓`);

  // ── Step 5: VW_new.changeDispenser(dispenser) ─────────────────────────
  console.log();
  console.log(`Pointing new VoteWeighting at Dispenser ${dispenserAddr}...`);
  const cdTx = await newVwHandle.changeDispenser(dispenserAddr);
  console.log(`changeDispenser tx: ${cdTx.hash}`);
  await cdTx.wait();
  const vwDispenser = (await newVwHandle.dispenser()) as string;
  if (vwDispenser.toLowerCase() !== dispenserAddr.toLowerCase()) {
    throw new Error(`VW.dispenser = ${vwDispenser} after changeDispenser; expected ${dispenserAddr}.`);
  }
  console.log(`  VW.dispenser = ${vwDispenser} ✓`);

  // ── Step 6: Register the staking nominee on the new VW ────────────────
  console.log();
  console.log(`Registering staking nominee (${l2Token}, chain=${BASE_SEPOLIA_CHAIN_ID}) on new VW...`);
  const anTx = await newVwHandle.addNomineeEVM(l2Token, BASE_SEPOLIA_CHAIN_ID);
  console.log(`addNomineeEVM tx: ${anTx.hash}`);
  await anTx.wait();
  const { stakingTarget, nomineeHash } = buildStakingNominee(l2Token, BASE_SEPOLIA_CHAIN_ID);
  const nomineeId = (await newVwHandle.getNomineeId(stakingTarget, BASE_SEPOLIA_CHAIN_ID)) as bigint;
  if (nomineeId === 0n) {
    throw new Error(`Nominee registration failed: getNomineeId returned 0.`);
  }
  console.log(`  Nominee id:    ${nomineeId}`);
  console.log(`  Nominee hash:  ${nomineeHash}`);

  // ── Step 7: Rewrite the artifact JSON ─────────────────────────────────
  console.log();
  console.log(`Updating ${paths.l1}: contracts.VoteWeighting ${vwOld} → ${vwNew}`);
  artifact.contracts.VoteWeighting = vwNew;
  fs.writeFileSync(l1Path, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  console.log(`  Wrote ${l1Path}`);

  // ── Step 8: Next-step cheatsheet ──────────────────────────────────────
  console.log();
  console.log("─── Next operator steps ─────────────────────────────────────────");
  console.log(`  # Cast the vote from an existing veJINN locker`);
  console.log(`  PHASE1A_TIMING_PROFILE=fast-test PHASE1A_VOTE_WEIGHT_BPS=10000 \\`);
  console.log(`    npx hardhat run scripts/phase1a-vote-staking-weight.ts --network sepolia`);
  console.log();
  console.log(`  # Wait ≥ 15 min for the next WEEK boundary, then close an epoch`);
  console.log(`  PHASE1A_TIMING_PROFILE=fast-test \\`);
  console.log(`    npx hardhat run scripts/checkpoint-and-verify.ts --network sepolia`);
  console.log();
  console.log(`  # Claim — expect Claimable > 0, Return Amount much smaller`);
  console.log(`  PHASE1A_TIMING_PROFILE=fast-test \\`);
  console.log(`    npx hardhat run scripts/phase1a-claim-staking-incentives.ts --network sepolia`);
  console.log();
  console.log(`  # Schedule the heartbeat (weekly) so this doesn't recur`);
  console.log(`  PHASE1A_TIMING_PROFILE=fast-test \\`);
  console.log(`    npx hardhat run scripts/phase1a-heartbeat-vote-weighting.ts --network sepolia`);
  console.log();
}

if (isRunEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
