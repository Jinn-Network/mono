/**
 * jinn-mvi-helpers.ts — Config + helper utilities for the v0 Jinn MVI L1 deploy
 * (JINN.sol + TimelockController + JinnGovernor + JinnDistributor).
 *
 * The protocol ships in two timing profiles:
 *
 *   - `canonical`  (mainnet defaults): 2-day voting delay, 14-day voting
 *                  period, 2-day timelock min delay. Matches the Doppler /
 *                  standard-OZ-Governor cadence.
 *   - `fast-test`  (compressed): 60s voting delay, 600s voting period, 60s
 *                  timelock min delay. Used on Sepolia and Hardhat for fast
 *                  iteration; compresses the 18-day mainnet path into ~22 min.
 *
 * Profile is selected via the `JINN_MVI_TIMING_PROFILE` environment variable.
 *
 * The L1 deploy also wires the JinnDistributor + a cross-chain messenger.
 * The messenger has two modes:
 *
 *   - `mock`       Deploys {MockMessenger}. Insecure by design — owner can
 *                  inject arbitrary fixtures. Default for `fast-test`.
 *   - `canonical`  Deploys {CanonicalOpStackMessenger} bound to L1 OptimismPortal2,
 *                  DisputeGameFactory, the L2 emitter, and the locked event topic.
 *                  Default for `canonical` timing profile. Live deploys must set
 *                  the address/topic env vars below.
 *
 * Messenger mode is selected via the `JINN_MVI_MESSENGER_MODE` env var; if
 * unset, it follows the timing profile.
 */

import { ethers } from "ethers";

type EnvMap = Record<string, string | undefined>;

/** Identifier for the deploy timing profile. */
export type JinnMviTimingProfile = "canonical" | "fast-test";

/** Identifier for the cross-chain messenger mode. */
export type JinnMviMessengerMode = "mock" | "canonical";

/** Locked Governor + Timelock parameters. */
export interface JinnMviGovernanceConfig {
  /** Profile this config is built for. */
  timingProfile: JinnMviTimingProfile;
  /** {Governor.votingDelay} in seconds (uint48 in the contract). */
  votingDelaySeconds: number;
  /** {Governor.votingPeriod} in seconds (uint32 in the contract). */
  votingPeriodSeconds: number;
  /** Minimum JINN balance (wei) required to submit a proposal. */
  proposalThreshold: bigint;
  /** Quorum numerator; denominator is 100 (so 4 = 4%). */
  quorumNumerator: number;
  /** {TimelockController} minimum delay between schedule and execute. */
  timelockMinDelaySeconds: number;
}

/** Mainnet/canonical profile — protocol-locked v0 numbers. */
export const CANONICAL_GOVERNANCE_CONFIG: JinnMviGovernanceConfig = {
  timingProfile: "canonical",
  votingDelaySeconds: 172_800, // 2 days
  votingPeriodSeconds: 1_209_600, // 14 days
  proposalThreshold: 0n,
  quorumNumerator: 4, // 4%
  timelockMinDelaySeconds: 172_800, // 2 days
};

/** Compressed profile for testnet + local iteration. */
export const FAST_TEST_GOVERNANCE_CONFIG: JinnMviGovernanceConfig = {
  timingProfile: "fast-test",
  votingDelaySeconds: 60, // 1 minute
  votingPeriodSeconds: 600, // 10 minutes
  proposalThreshold: 0n,
  quorumNumerator: 4, // 4%
  timelockMinDelaySeconds: 60, // 1 minute
};

/** Pick a config by profile name. */
export function getJinnMviGovernanceConfig(
  profile: JinnMviTimingProfile,
): JinnMviGovernanceConfig {
  return profile === "fast-test"
    ? { ...FAST_TEST_GOVERNANCE_CONFIG }
    : { ...CANONICAL_GOVERNANCE_CONFIG };
}

// ---------------------------------------------------------------------------
// Chain whitelist + chain-aware defaults
// ---------------------------------------------------------------------------

/** Hardhat / Anvil dev chain id. */
export const CHAIN_ID_HARDHAT = 31337;
/** Sepolia testnet (the v0 MVI L1 surface). */
export const CHAIN_ID_SEPOLIA = 11155111;
/** Ethereum mainnet — guarded; not whitelisted by default for v0. */
export const CHAIN_ID_MAINNET = 1;

/** Chain ids the L1 deploy script will run on without an explicit override. */
export const JINN_MVI_L1_ALLOWED_CHAINS: readonly number[] = [
  CHAIN_ID_HARDHAT,
  CHAIN_ID_SEPOLIA,
];

/** Base Sepolia (the v0 MVI L2 measurement chain). */
export const CHAIN_ID_BASE_SEPOLIA = 84532;
/** Base mainnet — guarded behind explicit allow-list opt-in. */
export const CHAIN_ID_BASE_MAINNET = 8453;

/** Chain ids the L2 emitter deploy script will run on without an explicit override. */
export const JINN_MVI_L2_ALLOWED_CHAINS: readonly number[] = [
  CHAIN_ID_HARDHAT,
  CHAIN_ID_BASE_SEPOLIA,
];

/**
 * Throw if the connected chainId is not in `allowed`, unless the
 * `JINN_MVI_ALLOW_CHAIN` env var matches the connected chainId. Lets a
 * captain override the guard for explicit deploys (e.g. to mainnet)
 * without weakening the default for everyone else.
 */
export function assertChainIdAllowed(args: {
  chainId: number;
  allowed: readonly number[];
  scriptName: string;
  env?: EnvMap;
}): void {
  const env = args.env ?? process.env;
  if (args.allowed.includes(args.chainId)) return;
  const override = env.JINN_MVI_ALLOW_CHAIN;
  if (override !== undefined && Number(override) === args.chainId) return;
  const allowedList = args.allowed.join(", ");
  throw new Error(
    `Refusing to deploy ${args.scriptName} on chainId ${args.chainId}. ` +
      `Allowed: [${allowedList}]. To override, set ` +
      `JINN_MVI_ALLOW_CHAIN=${args.chainId}.`,
  );
}

/** Resolve the timing profile from env (`JINN_MVI_TIMING_PROFILE`). */
export function resolveJinnMviTimingProfile(
  env: EnvMap = process.env,
): JinnMviTimingProfile {
  return env.JINN_MVI_TIMING_PROFILE === "fast-test" ? "fast-test" : "canonical";
}

/**
 * Resolve the timing profile, accounting for chainId. On Sepolia and
 * Hardhat the canonical 7-day OP-Stack finality is impractical (per
 * the R-1 finality measurement plan); without an explicit override we
 * fall back to `fast-test` for those chains. Mainnet still defaults
 * to the canonical profile when whitelisted.
 *
 * Honors `JINN_MVI_TIMING_PROFILE` if set explicitly.
 */
export function resolveJinnMviTimingProfileForChain(
  chainId: number,
  env: EnvMap = process.env,
): JinnMviTimingProfile {
  const explicit = env.JINN_MVI_TIMING_PROFILE;
  if (explicit === "fast-test" || explicit === "canonical") {
    return explicit;
  }
  if (chainId === CHAIN_ID_SEPOLIA || chainId === CHAIN_ID_HARDHAT) {
    return "fast-test";
  }
  return "canonical";
}

/** Standard artifact name for the v0 L1 deploy, parameterised by network. */
export function getJinnMviL1DeploymentArtifactName(
  profile: JinnMviTimingProfile,
  networkName: string,
): string {
  const suffix = profile === "fast-test" ? "-fast" : "";
  return `deployment-jinn-mvi-l1-${networkName}${suffix}.json`;
}

// ---------------------------------------------------------------------------
// JinnDistributor — locked initial parameters
// ---------------------------------------------------------------------------

/**
 * Initial JinnDistributor parameters locked by
 * {@link file:cargo/docs/planning/2026-04-jinn-mvi-on-olas.md} +
 * {@link file:cargo/docs/planning/2026-04-jinn-cross-chain.md}.
 *
 * The operator/DAO ratios are 1e18 fixed point; weights are unscaled
 * integers. All five values are governance-mutable post-deploy and
 * intentionally not constrained to sum to 1e18 (see distributor docstring).
 */
export interface JinnDistributorInitialConfig {
  /** Operator-share multiplier, 1e18 fixed point. Default 0.75e18 (75%). */
  operatorRatio: bigint;
  /** DAO-share multiplier, 1e18 fixed point. Default 0.25e18 (25%). */
  daoRatio: bigint;
  /** Per-channel weight on finalized Task creation. Default 1. */
  wTaskCreation: bigint;
  /** Per-channel weight on Solution deliveries. Default 1. */
  wSolutionDelivery: bigint;
  /** Per-channel weight on Verdict deliveries. Default 1. */
  wVerdictDelivery: bigint;
}

/**
 * Locked v0 distributor parameters per the Phase A spec.
 * Captain note: changing these requires a Governor proposal post-deploy;
 * the constructor seeds them once.
 */
export const LOCKED_DISTRIBUTOR_INITIAL_CONFIG: JinnDistributorInitialConfig = {
  operatorRatio: (10n ** 18n * 75n) / 100n, // 0.75e18
  daoRatio: (10n ** 18n * 25n) / 100n, // 0.25e18
  wTaskCreation: 1n,
  wSolutionDelivery: 1n,
  wVerdictDelivery: 1n,
};

// ---------------------------------------------------------------------------
// Messenger mode resolution
// ---------------------------------------------------------------------------

/** Default messenger mode for a given timing profile. */
export function defaultMessengerMode(
  profile: JinnMviTimingProfile,
): JinnMviMessengerMode {
  return profile === "fast-test" ? "mock" : "canonical";
}

/**
 * Resolve the messenger mode from env (`JINN_MVI_MESSENGER_MODE`). If unset,
 * defaults to {@link defaultMessengerMode} for the given timing profile.
 */
export function resolveJinnMviMessengerMode(
  profile: JinnMviTimingProfile,
  env: EnvMap = process.env,
): JinnMviMessengerMode {
  const raw = env.JINN_MVI_MESSENGER_MODE;
  if (raw === "mock" || raw === "canonical") return raw;
  return defaultMessengerMode(profile);
}

/**
 * Wiring for the canonical {CanonicalOpStackMessenger}.
 *
 * Required for `canonical` mode; deploy reverts if any field is missing.
 * Resolved from env vars on live networks; the integration test injects a
 * pre-cooked fixture instead.
 */
export interface CanonicalMessengerWiring {
  /** L1 OptimismPortal2 anchoring the L2 output roots. */
  optimismPortal: string;
  /** DisputeGameFactory used to look up FaultDisputeGames. */
  disputeGameFactory: string;
  /** Address of the deployed `JinnClaimEmitter` on the measurement chain. */
  expectedEmitter: string;
  /** topic0 of the `ClaimTicket` event. */
  claimTicketTopic: string;
}

/** Canonical `JinnClaimEmitter.ClaimTicket` event topic — locked at deploy. */
export const CLAIM_TICKET_TOPIC: string = ethers.id(
  "ClaimTicket(uint256,uint256,uint256,uint256,uint256,address,address)",
);

/**
 * Resolve canonical-mode wiring from env vars. Returns `null` if any of
 * the required vars is missing (caller decides what to do — the live
 * deploy errors out, while tests pass pre-cooked values directly).
 */
export function resolveCanonicalMessengerWiring(
  env: EnvMap = process.env,
): CanonicalMessengerWiring | null {
  const optimismPortal = env.JINN_MVI_OPTIMISM_PORTAL;
  const disputeGameFactory = env.JINN_MVI_DISPUTE_GAME_FACTORY;
  const expectedEmitter = env.JINN_MVI_CLAIM_EMITTER;
  if (!optimismPortal || !disputeGameFactory || !expectedEmitter) {
    return null;
  }
  return {
    optimismPortal,
    disputeGameFactory,
    expectedEmitter,
    claimTicketTopic: env.JINN_MVI_CLAIM_TICKET_TOPIC ?? CLAIM_TICKET_TOPIC,
  };
}
