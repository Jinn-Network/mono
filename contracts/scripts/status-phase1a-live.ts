import { isRunEntry } from "./lib/run-entry.js";
import { network } from "hardhat";
import { ethers } from "ethers";
import type { JsonRpcProvider } from "ethers";
import {
  BASE_SEPOLIA_CHAIN_ID,
  buildStakingNominee,
  isStakingIncentivesEnabled,
  loadJson,
  loadPhase1aArtifactsFromDisk,
  resolvePhase1aArtifactPaths,
  SEPOLIA_CHAIN_ID,
} from "./lib/phase1a-rollout-helpers.js";

const PLACEHOLDER_PROXY_HASH = ethers.id("proxy-hash-placeholder");

interface DeploymentArtifact {
  contracts: Record<string, string | undefined>;
  config?: Record<string, unknown>;
}

const TOKENOMICS_ABI = [
  "function epochCounter() view returns (uint32)",
  "function epochLen() view returns (uint32)",
  "function getEpochEndTime(uint256 epoch) view returns (uint256)",
];

const DISPENSER_ABI = [
  "function paused() view returns (uint8)",
  "function mapChainIdDepositProcessors(uint256) view returns (address)",
  "function mapChainIdWithheldAmounts(uint256) view returns (uint256)",
  "function mapLastClaimedStakingEpochs(bytes32) view returns (uint256)",
  "function calculateStakingIncentives(uint256,uint256,bytes32,uint256) returns (uint256,uint256,uint256,bytes32)",
];

const TREASURY_ABI = [
  "function paused() view returns (uint8)",
];

const DEPOSIT_PROCESSOR_ABI = [
  "function getBridgingDecimals() view returns (uint256)",
  "function l2TargetDispenser() view returns (address)",
  "function olasL2() view returns (address)",
];

const VOTE_WEIGHTING_ABI = [
  "function WEEK() view returns (uint256)",
  "function WEIGHT_VOTE_DELAY() view returns (uint256)",
  "function getNomineeId(bytes32,uint256) view returns (uint256)",
  "function nomineeRelativeWeight(bytes32,uint256,uint256) view returns (uint256,uint256)",
];

const STAKING_FACTORY_ABI = [
  "function verifyInstance(address) view returns (bool)",
  "function verifyInstanceAndGetEmissionsAmount(address) view returns (uint256)",
];

const STAKING_PROXY_ABI = [
  "function getImplementation() view returns (address)",
];

const TARGET_DISPENSER_ABI = [
  "function stakingFactory() view returns (address)",
  "function l1DepositProcessor() view returns (address)",
  "function withheldAmount() view returns (uint256)",
  "function paused() view returns (uint256)",
];

const STAKING_ABI = [
  "function balance() view returns (uint256)",
  "function availableRewards() view returns (uint256)",
  "function rewardsPerSecond() view returns (uint256)",
  "function tsCheckpoint() view returns (uint256)",
  "function getNextRewardCheckpointTimestamp() view returns (uint256)",
  "function getServiceIds() view returns (uint256[] memory)",
  "function getStakingState(uint256) view returns (uint8)",
  "function calculateStakingReward(uint256) view returns (uint256)",
  "function getServiceInfo(uint256) view returns ((address multisig,address owner,uint256[] nonces,uint256 tsStart,uint256 reward,uint256 inactivity,uint256 rewardDistributionInfo))",
  "function serviceRegistry() view returns (address)",
  "function serviceRegistryTokenUtility() view returns (address)",
  "function proxyHash() view returns (bytes32)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

function formatToken(amount: bigint): string {
  return ethers.formatEther(amount);
}

function formatTs(ts: bigint): string {
  if (ts === 0n) {
    return "0";
  }

  return `${ts} (${new Date(Number(ts) * 1000).toISOString()})`;
}

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

export function targetDispenserPauseLabel(value: bigint): string {
  switch (value) {
    case 1n:
      return "Unpaused";
    case 2n:
      return "Paused";
    default:
      return `Unknown(${value})`;
  }
}

export function isTargetDispenserUnpaused(value: bigint): boolean {
  return value === 1n;
}

export function getNextActivationBoundary(now: bigint, period: bigint): bigint {
  return ((now + period) / period) * period;
}

function getConfigString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" ? value : undefined;
}

async function getWorkingBaseSepoliaProvider(): Promise<{
  provider: JsonRpcProvider;
  rpcUrl: string;
}> {
  const candidates = [
    process.env.BASE_SEPOLIA_RPC_URL,
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.publicnode.com",
  ].filter((url): url is string => Boolean(url));

  const errors: string[] = [];
  for (const rpcUrl of candidates) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      await provider.getBlockNumber();
      return { provider, rpcUrl };
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      errors.push(`${rpcUrl}: ${message}`);
    }
  }

  throw new Error(`Unable to connect to Base Sepolia RPC.\n${errors.join("\n")}`);
}

interface ProbeResult {
  stakingIncentive: bigint;
  returnAmount: bigint;
  lastClaimedEpoch: bigint;
  probeNomineeHash: string;
}

interface ProbeAssessmentInput {
  nomineeBookmark: bigint;
  probeError: string | null;
  probeResult: ProbeResult | null;
  nomineeHash: string;
}

export function getStatusNetworkBlockers(l1ChainId: number, l2ChainId: number): string[] {
  const blockers: string[] = [];
  if (l1ChainId !== SEPOLIA_CHAIN_ID) {
    blockers.push(`L1 provider is on chain ${l1ChainId}, expected ${SEPOLIA_CHAIN_ID}.`);
  }
  if (l2ChainId !== BASE_SEPOLIA_CHAIN_ID) {
    blockers.push(`L2 provider is on chain ${l2ChainId}, expected ${BASE_SEPOLIA_CHAIN_ID}.`);
  }
  return blockers;
}

export function getStatusProbeBlockers({
  nomineeBookmark,
  probeError,
  probeResult,
  nomineeHash,
}: ProbeAssessmentInput): string[] {
  const blockers: string[] = [];
  if (nomineeBookmark === 0n) {
    blockers.push(
      "Dispenser nominee bookmark is still zero. The nominee has not advanced into a claimable epoch yet.",
    );
  }
  if (probeError) {
    blockers.push(`Static staking-incentive probe reverted: ${probeError}`);
    return blockers;
  }
  if (!probeResult) {
    return blockers;
  }
  if (probeResult.probeNomineeHash.toLowerCase() !== nomineeHash.toLowerCase()) {
    blockers.push("Static staking-incentive probe returned an unexpected nominee hash.");
  }
  if (probeResult.stakingIncentive === 0n) {
    blockers.push("Static staking-incentive probe returned zero claimable JINN.");
  }
  return blockers;
}

async function readNamedCalls(
  calls: Record<string, Promise<unknown>>,
): Promise<{ values: Record<string, unknown>; errors: Record<string, string> }> {
  const entries = await Promise.all(
    Object.entries(calls).map(async ([key, promise]) => {
      try {
        return { key, value: await promise, error: null as string | null };
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        return { key, value: undefined, error: message };
      }
    }),
  );

  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.error) {
      errors[entry.key] = entry.error;
    } else {
      values[entry.key] = entry.value;
    }
  }
  return { values, errors };
}

function asBigInt(value: unknown, fallback = 0n): bigint {
  return typeof value === "bigint" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBigIntArray(value: unknown): bigint[] {
  return Array.isArray(value) ? value.filter((item): item is bigint => typeof item === "bigint") : [];
}

async function main() {
  const artifactPaths = resolvePhase1aArtifactPaths();
  const l1Deployment = loadJson<DeploymentArtifact>(artifactPaths.l1);
  const l2Deployment = loadJson<DeploymentArtifact>(artifactPaths.l2);
  const artifacts = loadPhase1aArtifactsFromDisk();
  const { stakingTarget, nomineeHash } = buildStakingNominee(
    artifacts.stakingTokenL2,
    BASE_SEPOLIA_CHAIN_ID,
  );

  const l2Config = l2Deployment.config;
  const configuredServiceRegistry = l2Deployment.contracts.serviceRegistry;
  const configuredTokenUtility = l2Deployment.contracts.serviceRegistryTokenUtility;
  const configuredProxyHash = getConfigString(l2Config, "proxyHash");
  const configuredServiceRegistrySource = getConfigString(l2Config, "serviceRegistrySource");
  const configuredTokenUtilitySource = getConfigString(l2Config, "serviceRegistryTokenUtilitySource");
  const configuredProxyHashSource = getConfigString(l2Config, "proxyHashSource");
  const treasuryAddress = l1Deployment.contracts.Treasury;

  const { ethers: hh } = await network.connect();
  const [signer] = await hh.getSigners();
  const l1Provider = hh.provider;
  const { provider: l2Provider, rpcUrl: l2RpcUrl } = await getWorkingBaseSepoliaProvider();

  const baseReads = await readNamedCalls({
    l1Block: l1Provider.getBlock("latest"),
    l2Block: l2Provider.getBlock("latest"),
    l1Network: l1Provider.getNetwork(),
    l2Network: l2Provider.getNetwork(),
  });

  const l1Block = (baseReads.values.l1Block as Awaited<ReturnType<typeof l1Provider.getBlock>>) ?? null;
  const l2Block = (baseReads.values.l2Block as Awaited<ReturnType<typeof l2Provider.getBlock>>) ?? null;
  const l1Network =
    (baseReads.values.l1Network as Awaited<ReturnType<typeof l1Provider.getNetwork>>) ?? null;
  const l2Network =
    (baseReads.values.l2Network as Awaited<ReturnType<typeof l2Provider.getNetwork>>) ?? null;

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║        JINN Phase 1a — Live L1/L2 Status Report            ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`  Signer:      ${signer.address}`);
  console.log(`  L1 network:  ${l1Network ? `Sepolia (${l1Network.chainId})` : "(unavailable)"}`);
  console.log(`  L2 network:  ${l2Network ? `Base Sepolia (${l2Network.chainId})` : "(unavailable)"}`);
  console.log(`  L2 RPC:      ${l2RpcUrl}`);
  console.log(`  Time (L1):   ${l1Block ? new Date(Number(l1Block.timestamp) * 1000).toISOString() : "(unavailable)"}`);
  console.log(`  Time (L2):   ${l2Block ? new Date(Number(l2Block.timestamp) * 1000).toISOString() : "(unavailable)"}`);
  console.log();

  const networkBlockers = [
    ...Object.entries(baseReads.errors).map(([key, message]) => `Failed to read ${key}: ${message}`),
    ...(l1Network && l2Network
      ? getStatusNetworkBlockers(Number(l1Network.chainId), Number(l2Network.chainId))
      : ["Unable to determine L1/L2 chain ids before status checks."]),
  ];
  if (networkBlockers.length > 0) {
    console.log("── Preflight Gate ───────────────────────────────────────────");
    for (const blocker of networkBlockers) {
      console.log(`  BLOCKER: ${blocker}`);
    }
    process.exitCode = 1;
    return;
  }

  const tokenomics = new ethers.Contract(artifacts.tokenomicsL1, TOKENOMICS_ABI, signer);
  const dispenser = new ethers.Contract(artifacts.dispenserL1, DISPENSER_ABI, signer);
  const treasury =
    treasuryAddress && ethers.isAddress(treasuryAddress)
      ? new ethers.Contract(treasuryAddress, TREASURY_ABI, signer)
      : null;
  const depositProcessor = new ethers.Contract(artifacts.depositProcessorL1, DEPOSIT_PROCESSOR_ABI, signer);
  const voteWeighting = new ethers.Contract(artifacts.voteWeightingL1, VOTE_WEIGHTING_ABI, signer);

  const stakingFactory = new ethers.Contract(artifacts.stakingFactoryL2, STAKING_FACTORY_ABI, l2Provider);
  const stakingProxy = new ethers.Contract(artifacts.stakingTokenL2, STAKING_PROXY_ABI, l2Provider);
  const targetDispenser = new ethers.Contract(artifacts.targetDispenserL2, TARGET_DISPENSER_ABI, l2Provider);
  const staking = new ethers.Contract(artifacts.stakingTokenL2, STAKING_ABI, l2Provider);
  const l2Jinn = new ethers.Contract(artifacts.jinnL2, ERC20_ABI, l2Provider);

  const l1Reads = await readNamedCalls({
    epochCounter: tokenomics.epochCounter() as Promise<bigint>,
    epochLen: tokenomics.epochLen() as Promise<bigint>,
    dispenserPause: dispenser.paused() as Promise<bigint>,
    depositProcessorMapping: dispenser.mapChainIdDepositProcessors(BASE_SEPOLIA_CHAIN_ID) as Promise<string>,
    chainWithheldAmount: dispenser.mapChainIdWithheldAmounts(BASE_SEPOLIA_CHAIN_ID) as Promise<bigint>,
    nomineeBookmark: dispenser.mapLastClaimedStakingEpochs(nomineeHash) as Promise<bigint>,
    bridgingDecimals: depositProcessor.getBridgingDecimals() as Promise<bigint>,
    mappedTargetDispenser: depositProcessor.l2TargetDispenser() as Promise<string>,
    mappedL2Token: depositProcessor.olasL2() as Promise<string>,
    nomineeId: voteWeighting.getNomineeId(stakingTarget, BASE_SEPOLIA_CHAIN_ID) as Promise<bigint>,
    votePeriodSeconds: voteWeighting.WEEK() as Promise<bigint>,
    weightVoteDelaySeconds: voteWeighting.WEIGHT_VOTE_DELAY() as Promise<bigint>,
  });
  const l2Reads = await readNamedCalls({
    proxyImplementation: stakingProxy.getImplementation() as Promise<string>,
    factoryVerified: stakingFactory.verifyInstance(artifacts.stakingTokenL2) as Promise<boolean>,
    factoryEmissions: stakingFactory.verifyInstanceAndGetEmissionsAmount(artifacts.stakingTokenL2) as Promise<bigint>,
    dispenserFactory: targetDispenser.stakingFactory() as Promise<string>,
    dispenserL1Processor: targetDispenser.l1DepositProcessor() as Promise<string>,
    dispenserWithheldAmount: targetDispenser.withheldAmount() as Promise<bigint>,
    dispenserPauseL2: targetDispenser.paused() as Promise<bigint>,
    stakingBalance: staking.balance() as Promise<bigint>,
    availableRewards: staking.availableRewards() as Promise<bigint>,
    rewardsPerSecond: staking.rewardsPerSecond() as Promise<bigint>,
    tsCheckpoint: staking.tsCheckpoint() as Promise<bigint>,
    nextCheckpointTs: staking.getNextRewardCheckpointTimestamp() as Promise<bigint>,
    serviceIds: staking.getServiceIds() as Promise<bigint[]>,
    l2JinnBalance: l2Jinn.balanceOf(artifacts.stakingTokenL2) as Promise<bigint>,
    stakingServiceRegistry: staking.serviceRegistry() as Promise<string>,
    stakingTokenUtility: staking.serviceRegistryTokenUtility() as Promise<string>,
    stakingProxyHash: staking.proxyHash() as Promise<string>,
  });
  const epochCounter = asBigInt(l1Reads.values.epochCounter);
  const epochLen = asBigInt(l1Reads.values.epochLen);
  const dispenserPause = asBigInt(l1Reads.values.dispenserPause);
  const depositProcessorMapping = asString(l1Reads.values.depositProcessorMapping);
  const chainWithheldAmount = asBigInt(l1Reads.values.chainWithheldAmount);
  const nomineeBookmark = asBigInt(l1Reads.values.nomineeBookmark);
  const bridgingDecimals = asBigInt(l1Reads.values.bridgingDecimals);
  const mappedTargetDispenser = asString(l1Reads.values.mappedTargetDispenser);
  const mappedL2Token = asString(l1Reads.values.mappedL2Token);
  const nomineeId = asBigInt(l1Reads.values.nomineeId);
  const votePeriodSeconds = asBigInt(l1Reads.values.votePeriodSeconds);
  const weightVoteDelaySeconds = asBigInt(l1Reads.values.weightVoteDelaySeconds);
  const proxyImplementation = asString(l2Reads.values.proxyImplementation);
  const factoryVerified = asBoolean(l2Reads.values.factoryVerified);
  const factoryEmissions = asBigInt(l2Reads.values.factoryEmissions);
  const dispenserFactory = asString(l2Reads.values.dispenserFactory);
  const dispenserL1Processor = asString(l2Reads.values.dispenserL1Processor);
  const dispenserWithheldAmount = asBigInt(l2Reads.values.dispenserWithheldAmount);
  const dispenserPauseL2 = asBigInt(l2Reads.values.dispenserPauseL2);
  const stakingBalance = asBigInt(l2Reads.values.stakingBalance);
  const availableRewards = asBigInt(l2Reads.values.availableRewards);
  const rewardsPerSecond = asBigInt(l2Reads.values.rewardsPerSecond);
  const tsCheckpoint = asBigInt(l2Reads.values.tsCheckpoint);
  const nextCheckpointTs = asBigInt(l2Reads.values.nextCheckpointTs);
  const serviceIds = asBigIntArray(l2Reads.values.serviceIds);
  const l2JinnBalance = asBigInt(l2Reads.values.l2JinnBalance);
  const stakingServiceRegistry = asString(l2Reads.values.stakingServiceRegistry);
  const stakingTokenUtility = asString(l2Reads.values.stakingTokenUtility);
  const stakingProxyHash = asString(l2Reads.values.stakingProxyHash);
  const treasuryPause = treasury ? ((await treasury.paused()) as bigint) : null;

  const lastClosedEpoch = epochCounter > 0n ? epochCounter - 1n : 0n;
  let lastClosedEpochEnd = 0n;
  let lastClosedEpochEndError: string | null = null;
  if (epochCounter > 0n) {
    try {
      lastClosedEpochEnd = (await tokenomics.getEpochEndTime(lastClosedEpoch)) as bigint;
    } catch (error) {
      lastClosedEpochEndError = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
  }

  let relativeWeight = 0n;
  let totalWeight = 0n;
  let relativeWeightError: string | null = null;
  if (lastClosedEpochEnd > 0n && nomineeId > 0n) {
    try {
      [relativeWeight, totalWeight] = (await voteWeighting.nomineeRelativeWeight(
        stakingTarget,
        BASE_SEPOLIA_CHAIN_ID,
        lastClosedEpochEnd,
      )) as [bigint, bigint];
    } catch (error) {
      relativeWeightError = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
  }

  const nextVoteBoundary = getNextActivationBoundary(BigInt(l1Block!.timestamp), votePeriodSeconds);
  const preflightBlockers: string[] = [];
  let probeError: string | null = null;
  let probeResult: ProbeResult | null = null;

  for (const [key, message] of Object.entries(l1Reads.errors)) {
    preflightBlockers.push(`Failed to read ${key}: ${message}`);
  }
  for (const [key, message] of Object.entries(l2Reads.errors)) {
    preflightBlockers.push(`Failed to read ${key}: ${message}`);
  }
  if (lastClosedEpochEndError) {
    preflightBlockers.push(`Failed to read last closed epoch end: ${lastClosedEpochEndError}`);
  }
  if (relativeWeightError) {
    preflightBlockers.push(`Failed to read nominee relative weight: ${relativeWeightError}`);
  }
  if (!isStakingIncentivesEnabled(dispenserPause)) {
    preflightBlockers.push(`Dispenser pause state ${pauseLabel(dispenserPause)} still blocks staking incentives.`);
  }
  if (treasuryPause === null) {
    preflightBlockers.push("L1 deployment artifact does not expose a Treasury address for staking pause checks.");
  } else if (!isStakingIncentivesEnabled(treasuryPause)) {
    preflightBlockers.push(`Treasury pause state ${pauseLabel(treasuryPause)} still blocks staking incentives.`);
  }
  if (!isTargetDispenserUnpaused(dispenserPauseL2)) {
    preflightBlockers.push(`L2 target dispenser is paused (${targetDispenserPauseLabel(dispenserPauseL2)}).`);
  }
  if (depositProcessorMapping.toLowerCase() !== artifacts.depositProcessorL1.toLowerCase()) {
    preflightBlockers.push("Dispenser chain-id mapping does not point at the deployed L1 deposit processor.");
  }
  if (mappedTargetDispenser.toLowerCase() !== artifacts.targetDispenserL2.toLowerCase()) {
    preflightBlockers.push("L1 deposit processor does not point at the deployed L2 target dispenser.");
  }
  if (mappedL2Token.toLowerCase() !== artifacts.jinnL2.toLowerCase()) {
    preflightBlockers.push("L1 deposit processor is configured with the wrong L2 JINN token.");
  }
  if (dispenserFactory.toLowerCase() !== artifacts.stakingFactoryL2.toLowerCase()) {
    preflightBlockers.push("L2 target dispenser is not wired to the expected staking factory.");
  }
  if (dispenserL1Processor.toLowerCase() !== artifacts.depositProcessorL1.toLowerCase()) {
    preflightBlockers.push("L2 target dispenser is not wired back to the expected L1 deposit processor.");
  }
  if (nomineeId === 0n) {
    preflightBlockers.push("The staking proxy has not been registered as a VoteWeighting nominee.");
  }
  if (!factoryVerified) {
    preflightBlockers.push("The staking proxy is not recognized by the staking factory.");
  }
  if (factoryEmissions === 0n) {
    preflightBlockers.push("The staking factory returns zero emissions for the staking proxy.");
  }
  if (relativeWeight === 0n) {
    preflightBlockers.push(
      "The staking nominee has zero relative weight at the latest closed epoch. " +
        "Vote weights only become active on configured activation boundaries.",
    );
  }
  if (configuredServiceRegistrySource !== "external") {
    preflightBlockers.push("L2 deployment artifact does not record an external service registry source.");
  }
  if (configuredTokenUtilitySource !== "external") {
    preflightBlockers.push("L2 deployment artifact does not record an external service-registry token utility.");
  }
  if (configuredProxyHashSource !== "external") {
    preflightBlockers.push("L2 deployment artifact does not record an external Safe proxy hash.");
  }
  if (!configuredServiceRegistry || !ethers.isAddress(configuredServiceRegistry)) {
    preflightBlockers.push("L2 deployment artifact is missing a valid service registry address.");
  } else if (stakingServiceRegistry.toLowerCase() !== configuredServiceRegistry.toLowerCase()) {
    preflightBlockers.push("On-chain staking config points at a different service registry than the L2 artifact.");
  }
  if (!configuredTokenUtility || !ethers.isAddress(configuredTokenUtility)) {
    preflightBlockers.push("L2 deployment artifact is missing a valid service-registry token-utility address.");
  } else if (stakingTokenUtility.toLowerCase() !== configuredTokenUtility.toLowerCase()) {
    preflightBlockers.push(
      "On-chain staking config points at a different service-registry token utility than the L2 artifact.",
    );
  }
  if (!configuredProxyHash || !ethers.isHexString(configuredProxyHash, 32)) {
    preflightBlockers.push("L2 deployment artifact is missing a valid Safe proxy hash.");
  } else if (stakingProxyHash.toLowerCase() !== configuredProxyHash.toLowerCase()) {
    preflightBlockers.push("On-chain staking config points at a different Safe proxy hash than the L2 artifact.");
  }
  if (stakingProxyHash.toLowerCase() === PLACEHOLDER_PROXY_HASH.toLowerCase()) {
    preflightBlockers.push("The staking proxy still uses the placeholder Safe proxy hash.");
  }
  if (stakingBalance === 0n) {
    preflightBlockers.push("The staking proxy has no bridged JINN balance yet.");
  }
  if (availableRewards === 0n) {
    preflightBlockers.push("The staking proxy has no available rewards yet.");
  }

  console.log("── L1 Tokenomics ────────────────────────────────────────────");
  console.log(`  Epoch Counter:         ${epochCounter}`);
  console.log(`  Epoch Length:          ${epochLen}s (${(Number(epochLen) / 3600).toFixed(1)}h)`);
  console.log(`  Last Closed Epoch:     ${lastClosedEpoch}`);
  console.log(`  Last Closed Epoch End: ${formatTs(lastClosedEpochEnd)}`);
  console.log(`  Dispenser Pause:       ${pauseLabel(dispenserPause)}`);
  console.log(`  Treasury:              ${treasuryAddress ?? "(missing from artifact)"}`);
  console.log(`  Treasury Pause:        ${treasuryPause === null ? "(unavailable)" : pauseLabel(treasuryPause)}`);
  console.log();

  console.log("── Bridge Wiring ────────────────────────────────────────────");
  console.log(`  Staking Proxy (L2):    ${artifacts.stakingTokenL2}`);
  console.log(`  Staking Target bytes32:${stakingTarget}`);
  console.log(`  Nominee Hash:          ${nomineeHash}`);
  console.log(`  Deposit Processor Map: ${depositProcessorMapping}`);
  console.log(`  Artifact Processor:    ${artifacts.depositProcessorL1}`);
  console.log(`  Bridging Decimals:     ${bridgingDecimals}`);
  console.log(`  L2 Target Dispenser:   ${mappedTargetDispenser}`);
  console.log(`  Artifact Dispenser:    ${artifacts.targetDispenserL2}`);
  console.log(`  L2 Token via Bridge:   ${mappedL2Token}`);
  console.log(`  Artifact L2 Token:     ${artifacts.jinnL2}`);
  console.log(`  Chain Withheld Amount: ${formatToken(chainWithheldAmount)} JINN`);
  console.log();

  console.log("── L2 Bridge Receiver ───────────────────────────────────────");
  console.log(`  Target Dispenser:      ${artifacts.targetDispenserL2}`);
  console.log(`  Staking Factory:       ${dispenserFactory}`);
  console.log(`  L1 Deposit Processor:  ${dispenserL1Processor}`);
  console.log(`  Paused State:          ${targetDispenserPauseLabel(dispenserPauseL2)}`);
  console.log(`  Withheld Amount:       ${formatToken(dispenserWithheldAmount)} JINN`);
  console.log();

  console.log("── L2 Staking Config ────────────────────────────────────────");
  console.log(`  Artifact Registry:     ${configuredServiceRegistry ?? "(missing)"}`);
  console.log(`  On-chain Registry:     ${stakingServiceRegistry}`);
  console.log(`  Registry Source:       ${configuredServiceRegistrySource ?? "(missing)"}`);
  console.log(`  Artifact TokenUtility: ${configuredTokenUtility ?? "(missing)"}`);
  console.log(`  On-chain TokenUtility: ${stakingTokenUtility}`);
  console.log(`  Utility Source:        ${configuredTokenUtilitySource ?? "(missing)"}`);
  console.log(`  Artifact Proxy Hash:   ${configuredProxyHash ?? "(missing)"}`);
  console.log(`  On-chain Proxy Hash:   ${stakingProxyHash}`);
  console.log(`  Proxy Hash Source:     ${configuredProxyHashSource ?? "(missing)"}`);
  console.log();

  console.log("── Factory Verification ─────────────────────────────────────");
  console.log(`  Staking Factory:       ${artifacts.stakingFactoryL2}`);
  console.log(`  Proxy Implementation:  ${proxyImplementation}`);
  console.log(`  Proxy Verified:        ${factoryVerified}`);
  console.log(`  Emissions Amount:      ${formatToken(factoryEmissions)} JINN`);
  console.log();

  console.log("── Vote Weighting ───────────────────────────────────────────");
  console.log(`  Nominee Id:            ${nomineeId}`);
  console.log(`  Last Claimed Epoch:    ${nomineeBookmark}`);
  console.log(`  Relative Weight:       ${relativeWeight}`);
  console.log(`  Total Weight:          ${totalWeight}`);
  console.log(`  Vote Period:           ${votePeriodSeconds}s`);
  console.log(`  Vote Delay:            ${weightVoteDelaySeconds}s`);
  console.log(`  Next Activation:       ${formatTs(nextVoteBoundary)}`);
  console.log();

  console.log("── L2 Staking ───────────────────────────────────────────────");
  console.log(`  Staking Balance:       ${formatToken(stakingBalance)} JINN`);
  console.log(`  Available Rewards:     ${formatToken(availableRewards)} JINN`);
  console.log(`  Rewards / Second:      ${formatToken(rewardsPerSecond)} JINN`);
  console.log(`  tsCheckpoint:          ${formatTs(tsCheckpoint)}`);
  console.log(`  Next Checkpoint:       ${formatTs(nextCheckpointTs)}`);
  console.log(`  JINN Balance:          ${formatToken(l2JinnBalance)} JINN`);
  console.log(`  Staked Services:       ${serviceIds.length === 0 ? "(none)" : serviceIds.map(String).join(", ")}`);

  for (const serviceId of serviceIds) {
    console.log();
    console.log(`  Service ${serviceId}`);
    try {
      const [state, reward, serviceInfo] = await Promise.all([
        staking.getStakingState(serviceId) as Promise<number>,
        staking.calculateStakingReward(serviceId) as Promise<bigint>,
        staking.getServiceInfo(serviceId) as Promise<{
          multisig: string;
          owner: string;
          nonces: bigint[];
          tsStart: bigint;
          reward: bigint;
          inactivity: bigint;
          rewardDistributionInfo: bigint;
        }>,
      ]);

      console.log(`    State:               ${state}`);
      console.log(`    Owner:               ${serviceInfo.owner}`);
      console.log(`    Multisig:            ${serviceInfo.multisig}`);
      console.log(`    Stake Start:         ${formatTs(serviceInfo.tsStart)}`);
      console.log(`    Recorded Reward:     ${formatToken(serviceInfo.reward)} JINN`);
      console.log(`    Pending Reward:      ${formatToken(reward)} JINN`);
      console.log(`    Inactivity:          ${serviceInfo.inactivity}`);
      console.log(`    Nonces:              [${serviceInfo.nonces.map(String).join(", ")}]`);
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      console.log(`    ERROR:               ${message}`);
      preflightBlockers.push(`Failed to read service ${serviceId} details: ${message}`);
    }
  }
  console.log();

  console.log("── Incentive Calculation Probe ─────────────────────────────");
  if (nomineeBookmark === 0n) {
    console.log("  Result:                skipped — nominee bookmark is still zero.");
  } else {
    try {
      const [stakingIncentive, returnAmount, probeLastClaimedEpoch, probeNomineeHash] =
        (await dispenser.calculateStakingIncentives.staticCall(
          1,
          BASE_SEPOLIA_CHAIN_ID,
          stakingTarget,
          bridgingDecimals,
        )) as [bigint, bigint, bigint, string];

      probeResult = {
        stakingIncentive,
        returnAmount,
        lastClaimedEpoch: probeLastClaimedEpoch,
        probeNomineeHash,
      };

      console.log(`  Claimable Incentive:   ${formatToken(stakingIncentive)} JINN`);
      console.log(`  Return Amount:         ${formatToken(returnAmount)} JINN`);
      console.log(`  Through Epoch:         ${probeLastClaimedEpoch}`);
      console.log(`  Probe Nominee Hash:    ${probeNomineeHash}`);
    } catch (error) {
      probeError = error instanceof Error ? error.message.split("\n")[0] : String(error);
      console.log(`  Result:                probe reverted — ${probeError}`);
    }
  }
  console.log();

  preflightBlockers.push(
    ...getStatusProbeBlockers({
      nomineeBookmark,
      probeError,
      probeResult,
      nomineeHash,
    }),
  );

  console.log("── Preflight Gate ───────────────────────────────────────────");
  if (preflightBlockers.length === 0) {
    console.log("  READY: All checked rollout prerequisites currently line up for a staking-claim attempt.");
    return;
  }

  for (const blocker of preflightBlockers) {
    console.log(`  BLOCKER: ${blocker}`);
  }
  process.exitCode = 1;
}

if (isRunEntry(import.meta.url)) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
