import { ethers } from "hardhat";
import type { Contract } from "ethers";
import {
  BASE_SEPOLIA_CHAIN_ID,
  buildStakingNominee,
  loadPhase1aArtifactsFromDisk,
} from "./lib/phase1a-rollout-helpers";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const VE_ABI = [
  "function lockedEnd(address account) view returns (uint256)",
  "function createLock(uint256 amount, uint256 unlockTime)",
  "function increaseAmount(uint256 amount)",
];

const VOTE_WEIGHTING_ABI = [
  "function WEEK() view returns (uint256)",
  "function WEIGHT_VOTE_DELAY() view returns (uint256)",
  "function getNomineeId(bytes32 account, uint256 chainId) view returns (uint256)",
  "function lastUserVote(address user, bytes32 nomineeHash) view returns (uint256)",
  "function voteForNomineeWeights(bytes32 account, uint256 chainId, uint256 weight)",
  "function nomineeRelativeWeightWrite(bytes32 account, uint256 chainId, uint256 time) returns (uint256,uint256)",
];

const MAX_WEIGHT = 10_000n;
const DEFAULT_CANONICAL_LOCK_DURATION_SECONDS = 28 * 24 * 60 * 60;
const DEFAULT_FAST_TEST_LOCK_DURATION_SECONDS = 7 * 24 * 60 * 60;

function parsePositiveBigInt(value: string | undefined, label: string): bigint | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = BigInt(value);
  if (parsed <= 0n) {
    throw new Error(`${label} must be greater than zero.`);
  }

  return parsed;
}

function parsePositiveInteger(value: string | undefined, label: string, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

function formatTs(ts: bigint): string {
  return `${ts} (${new Date(Number(ts) * 1000).toISOString()})`;
}

async function approveIfNeeded(token: Contract, owner: string, spender: string, amount: bigint) {
  const allowance = (await token.allowance(owner, spender)) as bigint;
  if (allowance >= amount) {
    return;
  }

  const approveTx = await token.approve(spender, amount);
  console.log(`Approve tx:         ${approveTx.hash}`);
  await approveTx.wait();
}

async function main() {
  const artifacts = loadPhase1aArtifactsFromDisk();
  const [signer] = await ethers.getSigners();
  const signerAddress = signer.address;
  const weightBps = parsePositiveBigInt(process.env.PHASE1A_VOTE_WEIGHT_BPS, "PHASE1A_VOTE_WEIGHT_BPS");
  const lockAmount = parsePositiveBigInt(process.env.PHASE1A_VOTE_LOCK_AMOUNT, "PHASE1A_VOTE_LOCK_AMOUNT");

  if (!weightBps || weightBps > MAX_WEIGHT) {
    throw new Error("Set PHASE1A_VOTE_WEIGHT_BPS to a value between 1 and 10000.");
  }

  const { stakingTarget, nomineeHash } = buildStakingNominee(
    artifacts.stakingTokenL2,
    BASE_SEPOLIA_CHAIN_ID,
  );

  const jinn = new ethers.Contract(artifacts.l1Jinn, ERC20_ABI, signer);
  const veOLAS = new ethers.Contract(artifacts.veOLASL1, VE_ABI, signer);
  const voteWeighting = new ethers.Contract(artifacts.voteWeightingL1, VOTE_WEIGHTING_ABI, signer);

  const latestBlock = await ethers.provider.getBlock("latest");
  const now = BigInt(latestBlock!.timestamp);
  const votePeriodSeconds = (await voteWeighting.WEEK()) as bigint;
  const weightVoteDelaySeconds = (await voteWeighting.WEIGHT_VOTE_DELAY()) as bigint;
  const defaultLockDurationSeconds =
    votePeriodSeconds <= 900n ? DEFAULT_FAST_TEST_LOCK_DURATION_SECONDS : DEFAULT_CANONICAL_LOCK_DURATION_SECONDS;
  const lockDurationSeconds = parsePositiveInteger(
    process.env.PHASE1A_VOTE_LOCK_DURATION_SECONDS,
    "PHASE1A_VOTE_LOCK_DURATION_SECONDS",
    defaultLockDurationSeconds,
  );
  const nextVoteBoundary = ((now + votePeriodSeconds) / votePeriodSeconds) * votePeriodSeconds;

  const nomineeId = (await voteWeighting.getNomineeId(stakingTarget, BASE_SEPOLIA_CHAIN_ID)) as bigint;
  if (nomineeId === 0n) {
    throw new Error(
      "The staking nominee is not registered yet. Run scripts/phase1a-add-staking-nominee.ts first.",
    );
  }

  console.log(`Signer:                    ${signerAddress}`);
  console.log(`Nominee id:                ${nomineeId}`);
  console.log(`Staking target key:        ${stakingTarget}`);
  console.log(`Nominee hash:              ${nomineeHash}`);
  console.log(`Requested vote weight:     ${weightBps} / ${MAX_WEIGHT}`);
  console.log(`Vote period:               ${votePeriodSeconds}s`);
  console.log(`Vote delay:                ${weightVoteDelaySeconds}s`);
  console.log(`Next vote boundary:        ${formatTs(nextVoteBoundary)}`);

  let lockEnd = (await veOLAS.lockedEnd(signerAddress)) as bigint;
  if (lockEnd <= now + 1n) {
    if (!lockAmount) {
      throw new Error(
        "No active veJINN lock found. Set PHASE1A_VOTE_LOCK_AMOUNT so the script can create one.",
      );
    }

    const balance = (await jinn.balanceOf(signerAddress)) as bigint;
    if (balance < lockAmount) {
      throw new Error(
        `Signer only has ${balance} JINN but needs ${lockAmount} JINN to create a voting lock.`,
      );
    }

    await approveIfNeeded(jinn, signerAddress, artifacts.veOLASL1, lockAmount);
    const createLockTx = await veOLAS.createLock(lockAmount, lockDurationSeconds);
    console.log(`Create lock tx:            ${createLockTx.hash}`);
    await createLockTx.wait();
    lockEnd = (await veOLAS.lockedEnd(signerAddress)) as bigint;
  } else if (lockAmount) {
    const balance = (await jinn.balanceOf(signerAddress)) as bigint;
    if (balance < lockAmount) {
      throw new Error(
        `Signer only has ${balance} JINN but needs ${lockAmount} JINN to top up the voting lock.`,
      );
    }

    await approveIfNeeded(jinn, signerAddress, artifacts.veOLASL1, lockAmount);
    const topUpTx = await veOLAS.increaseAmount(lockAmount);
    console.log(`Lock top-up tx:            ${topUpTx.hash}`);
    await topUpTx.wait();
    lockEnd = (await veOLAS.lockedEnd(signerAddress)) as bigint;
  }

  console.log(`Active lock end:           ${formatTs(lockEnd)}`);
  if (lockEnd <= nextVoteBoundary) {
    throw new Error(
      "The current veJINN lock expires before the next vote activation boundary. " +
        "Extend the lock manually before voting.",
    );
  }

  const lastUserVote = (await voteWeighting.lastUserVote(signerAddress, nomineeHash)) as bigint;
  const nextAllowedVote = lastUserVote + weightVoteDelaySeconds;
  if (lastUserVote > 0n && nextAllowedVote > now) {
    throw new Error(
      `Vote delay is still active until ${formatTs(nextAllowedVote)}. Wait before sending another vote.`,
    );
  }

  const voteTx = await voteWeighting.voteForNomineeWeights(
    stakingTarget,
    BASE_SEPOLIA_CHAIN_ID,
    weightBps,
  );
  console.log(`Vote tx:                   ${voteTx.hash}`);
  await voteTx.wait();

  const scheduledWeights = (await voteWeighting.nomineeRelativeWeightWrite(
    stakingTarget,
    BASE_SEPOLIA_CHAIN_ID,
    nextVoteBoundary,
  )) as { 0: bigint; 1: bigint } | [bigint, bigint];
  const scheduledRelativeWeight = scheduledWeights[0];
  const scheduledTotalWeight = scheduledWeights[1];

  console.log(`Scheduled relative weight: ${scheduledRelativeWeight}`);
  console.log(`Scheduled total weight:    ${scheduledTotalWeight}`);
  console.log("Note: vote weights are boundary-rounded and do not become active immediately.");
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
