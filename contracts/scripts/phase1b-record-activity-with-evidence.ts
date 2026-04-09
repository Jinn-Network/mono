/**
 * Record activity with evidence hash on a V2 activity checker.
 *
 * Usage:
 *   PHASE1A_TIMING_PROFILE=fast-test \
 *   PHASE1A_MULTISIG=0x... \
 *   EVIDENCE_HASH=0x... \
 *   npx hardhat run scripts/phase1b-record-activity-with-evidence.ts --network baseSepolia
 *
 * Env vars:
 *   PHASE1A_TIMING_PROFILE  "canonical" | "fast-test" (selects artifact set)
 *   PHASE1A_MULTISIG        Multisig address (or use PHASE1A_SERVICE_ID to look up)
 *   PHASE1A_SERVICE_ID      Service ID to look up multisig from staking contract
 *   PHASE1A_ACTIVITY_TYPES  Comma-separated activity types (default: "0,1,2")
 *   EVIDENCE_HASH           bytes32 SimHash of evidence (or omit for auto-generated test hashes)
 *   EVIDENCE_MODE           "novel" | "duplicate" | "custom" (default: "custom" if EVIDENCE_HASH set, "novel" otherwise)
 */

import { ethers } from "hardhat";
import { loadJson, resolvePhase1aArtifactPaths } from "./lib/phase1a-rollout-helpers";

interface DeploymentArtifact {
  contracts: Record<string, string | undefined>;
  config?: { activityCheckerVersion?: string };
}

const ACTIVITY_CHECKER_V2_ABI = [
  "function recordActivityWithEvidence(address multisig, uint8 activityType, bytes32 evidenceHash)",
  "function recordActivity(address multisig, uint8 activityType)",
  "function noveltyWeightedCounts(address) view returns (uint256)",
  "function activityCounts(address) view returns (uint256)",
  "function getEvidenceHashCount(address) view returns (uint256)",
  "function similarityThreshold() view returns (uint256)",
  "function similarDecayMultiplier() view returns (uint256)",
  "function comparisonWindow() view returns (uint256)",
];

const STAKING_ABI = [
  "function getServiceInfo(uint256 serviceId) view returns ((address multisig,address owner,uint256[] nonces,uint256 tsStart,uint256 reward,uint256 inactivity,uint256 rewardDistributionInfo))",
];

async function main() {
  const paths = resolvePhase1aArtifactPaths();
  const deployment = loadJson<DeploymentArtifact>(paths.l2);
  const activityCheckerAddress = deployment.contracts.activityChecker;
  const stakingTokenAddress = deployment.contracts.stakingToken;

  if (!activityCheckerAddress || !stakingTokenAddress) {
    throw new Error("L2 deployment artifact must include activityChecker and stakingToken.");
  }

  const [signer] = await ethers.getSigners();
  const env = process.env;

  // Resolve multisig
  let multisig = env.PHASE1A_MULTISIG;
  if (!multisig) {
    const serviceId = env.PHASE1A_SERVICE_ID ? BigInt(env.PHASE1A_SERVICE_ID) : undefined;
    if (serviceId === undefined) {
      throw new Error("Set PHASE1A_MULTISIG or PHASE1A_SERVICE_ID.");
    }
    const staking = new ethers.Contract(stakingTokenAddress, STAKING_ABI, signer);
    const serviceInfo = (await staking.getServiceInfo(serviceId)) as { multisig: string };
    multisig = serviceInfo.multisig;
  }

  if (!ethers.isAddress(multisig)) {
    throw new Error(`Invalid multisig address: ${multisig}`);
  }

  // Parse activity types
  const activityTypes = (env.PHASE1A_ACTIVITY_TYPES ?? "0,1,2")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => Number(v));

  if (activityTypes.some((v) => !Number.isInteger(v) || v < 0 || v > 2)) {
    throw new Error(`PHASE1A_ACTIVITY_TYPES must only contain 0, 1, or 2.`);
  }

  // Resolve evidence hash
  const customHash = env.EVIDENCE_HASH?.trim();
  const evidenceMode = env.EVIDENCE_MODE?.trim() ?? (customHash ? "custom" : "novel");

  const checker = new ethers.Contract(activityCheckerAddress, ACTIVITY_CHECKER_V2_ABI, signer);

  // Print checker info
  const [threshold, decay, window] = await Promise.all([
    checker.similarityThreshold() as Promise<bigint>,
    checker.similarDecayMultiplier() as Promise<bigint>,
    checker.comparisonWindow() as Promise<bigint>,
  ]);

  console.log("=== Phase 1b: Record Activity with Evidence ===");
  console.log(`Signer:              ${signer.address}`);
  console.log(`Activity checker:    ${activityCheckerAddress}`);
  console.log(`Multisig:            ${multisig}`);
  console.log(`Activity types:      ${activityTypes.join(", ")}`);
  console.log(`Evidence mode:       ${evidenceMode}`);
  console.log(`Similarity threshold: ${threshold}`);
  console.log(`Decay multiplier:    ${decay}`);
  console.log(`Comparison window:   ${window}`);
  console.log();

  const countBefore = await checker.activityCounts(multisig);
  const weightBefore = await checker.noveltyWeightedCounts(multisig);
  console.log(`Before: rawCount=${countBefore}, weightedCount=${ethers.formatEther(weightBefore)}`);

  const baseNonce = await signer.getNonce("pending");

  // Generate or use evidence hashes
  let usedHash: string | null = null;
  for (const [index, activityType] of activityTypes.entries()) {
    let evidenceHash: string;

    if (evidenceMode === "custom" && customHash) {
      evidenceHash = customHash;
    } else if (evidenceMode === "duplicate") {
      // Use the same hash for all activities (simulates farming)
      evidenceHash = ethers.id("duplicate-farming-evidence");
    } else {
      // "novel" mode: unique hash per activity
      evidenceHash = ethers.id(`novel-evidence-${Date.now()}-${index}-${activityType}`);
    }

    if (usedHash === null) {
      usedHash = evidenceHash;
    }

    const tx = await checker.recordActivityWithEvidence(multisig, activityType, evidenceHash, {
      nonce: baseNonce + index,
    });
    console.log(`recordActivityWithEvidence(type=${activityType}, hash=${evidenceHash.slice(0, 18)}...) tx: ${tx.hash}`);
    await tx.wait();
  }

  const countAfter = await checker.activityCounts(multisig);
  const weightAfter = await checker.noveltyWeightedCounts(multisig);
  console.log();
  console.log(`After:  rawCount=${countAfter}, weightedCount=${ethers.formatEther(weightAfter)}`);
  console.log(`Delta:  rawCount=+${countAfter - countBefore}, weightedCount=+${ethers.formatEther(weightAfter - weightBefore)}`);

  const hashCount = await checker.getEvidenceHashCount(multisig);
  console.log(`Evidence hashes stored: ${hashCount}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
