/**
 * deploy-helpers.ts — Deployment helpers for the Jinn L1 tokenomics stack.
 *
 * ## Dependency Analysis
 *
 * The OLAS tokenomics contracts have circular constructor dependencies:
 *
 *   Treasury(olas, tokenomics, depository, dispenser)  — needs Depository + Dispenser
 *   Depository(olas, tokenomics, treasury, bondCalc)   — needs Treasury
 *   Dispenser(olas, tokenomics, treasury, voteWeight)  — needs Treasury
 *
 * Resolution: Treasury stores depository/dispenser as MUTABLE storage variables
 * (not immutable). Its constructor requires non-zero addresses, but the owner
 * can update them post-deploy via `changeManagers()`. So we:
 *
 *   1. Deploy Treasury with the deployer's own address as placeholder for
 *      depository and dispenser (satisfies non-zero check).
 *   2. Deploy the real Depository and Dispenser (they now have Treasury's address).
 *   3. Call Treasury.changeManagers() to point to the real contracts.
 *
 * Similarly, Tokenomics uses a two-phase init pattern: empty constructor,
 * then `initializeTokenomics()` with all addresses. This lets us deploy
 * Tokenomics first, collect its address for other constructors, then
 * initialize it after everything else is deployed.
 *
 * ## Deployment Order (10 steps)
 *
 *   Step  1: JINN token           — no dependencies
 *   Step  2: veOLAS               — needs JINN
 *   Step  3: RegistryStub x3      — placeholder registries (Phase 1a has no OLAS registries)
 *   Step  4: Tokenomics           — empty constructor (two-phase init)
 *   Step  5: GenericBondCalculator — needs JINN + Tokenomics address
 *   Step  6: VoteWeighting        — needs veOLAS
 *   Step  7: Treasury             — needs JINN + Tokenomics; uses deployer as placeholder
 *                                   for depository + dispenser
 *   Step  8: Depository           — needs JINN, Tokenomics, Treasury, BondCalculator
 *   Step  9: Dispenser            — needs JINN, Tokenomics, Treasury, VoteWeighting
 *   Step 10: Post-deploy wiring
 *            a. Treasury.changeManagers(0, realDepository, realDispenser)
 *            b. Tokenomics.initializeTokenomics(all addresses)
 *            c. JINN.changeMinter(treasury)  — Treasury is the only minter
 *            d. VoteWeighting.changeDispenser(dispenser)
 */

import { ethers } from "hardhat";
import { Signer, Contract } from "ethers";
import type { Phase1aTimingProfile } from "./phase1a-rollout-helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All deployed contract instances from the L1 stack. */
export interface Phase1aDeployment {
  jinn: Contract;
  veOLAS: Contract;
  tokenomics: Contract;
  treasury: Contract;
  depository: Contract;
  dispenser: Contract;
  bondCalculator: Contract;
  voteWeighting: Contract;
  componentRegistry: Contract;
  agentRegistry: Contract;
  serviceRegistry: Contract;
}

/** Configurable deployment parameters. */
export interface DeployConfig {
  /** Timing profile selector. */
  timingProfile: Phase1aTimingProfile;
  /** Epoch length in seconds. OLAS uses 2592000 (30 days). Testnet min overridden to 1 hour. */
  epochLen: number;
  /** Fraction for component owner rewards funded by ETH donations. */
  rewardComponentFraction: number;
  /** Fraction for agent owner rewards funded by ETH donations. */
  rewardAgentFraction: number;
  /** Fraction for max bond funded by token inflation. */
  maxBondFraction: number;
  /** Fraction for component-owner top-ups funded by token inflation. */
  topUpComponentFraction: number;
  /** Fraction for agent-owner top-ups funded by token inflation. */
  topUpAgentFraction: number;
  /** Fraction for staking funded by token inflation. */
  stakingFraction: number;
  /** Vote activation bucket in seconds. */
  votePeriodSeconds: number;
  /** Vote cooldown in seconds. */
  weightVoteDelaySeconds: number;
  /** Historic checkpoint horizon. */
  voteCheckpointHorizon: number;
  /** Retainer bytes32 for Dispenser. Identifies the protocol-owned retainer nominee. */
  retainer: string;
  /** Max number of epochs a staking target can claim in one call. */
  maxNumClaimingEpochs: number;
  /** Max staking targets claimable per chain per call. */
  maxNumStakingTargets: number;
  /** Minimum staking weight in bps (e.g. 100 = 1%). */
  defaultMinStakingWeight: number;
  /** Maximum staking incentive per epoch in wei (e.g. 10 JINN = 10e18). */
  defaultMaxStakingIncentive: string;
  /** Optional: address for donatorBlacklist (defaults to zero address). */
  donatorBlacklist?: string;
}

/** Sensible defaults for local/testnet deployment. */
export const DEFAULT_DEPLOY_CONFIG: DeployConfig = {
  timingProfile: "canonical",
  epochLen: 7200, // 2 hours — testnet override (MIN_EPOCH_LENGTH reduced to 1 hour)
  rewardComponentFraction: 0,
  rewardAgentFraction: 0,
  maxBondFraction: 0,
  topUpComponentFraction: 0,
  topUpAgentFraction: 0,
  stakingFraction: 100,
  votePeriodSeconds: 604800,
  weightVoteDelaySeconds: 864000,
  voteCheckpointHorizon: 250,
  retainer: ethers.zeroPadValue("0x01", 32), // arbitrary non-zero bytes32
  maxNumClaimingEpochs: 10,
  maxNumStakingTargets: 100,
  defaultMinStakingWeight: 100, // 1%
  defaultMaxStakingIncentive: ethers.parseEther("100").toString(), // 100 JINN
  donatorBlacklist: ethers.ZeroAddress,
};

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/**
 * Deploys the full Jinn L1 tokenomics stack in the correct order.
 *
 * @param deployer  Signer that will own all contracts initially.
 * @param config    Deployment parameters (epoch length, staking params, etc.).
 * @returns All deployed contract instances.
 */
export async function deployL1Stack(
  deployer: Signer,
  config: DeployConfig = DEFAULT_DEPLOY_CONFIG
): Promise<Phase1aDeployment> {
  const deployerAddress = await deployer.getAddress();

  // -----------------------------------------------------------------------
  // Step 1: JINN token — no constructor params, deployer becomes owner+minter
  // -----------------------------------------------------------------------
  const JINN = await ethers.getContractFactory("JINN", deployer);
  const jinn = await JINN.deploy();
  await jinn.waitForDeployment();

  // -----------------------------------------------------------------------
  // Step 2: veOLAS — constructor(token, name, symbol)
  // -----------------------------------------------------------------------
  const VeOLAS = await ethers.getContractFactory("veOLAS", deployer);
  const veOLAS = await VeOLAS.deploy(
    await jinn.getAddress(),
    "Voting Escrow JINN",
    "veJINN"
  );
  await veOLAS.waitForDeployment();

  // -----------------------------------------------------------------------
  // Step 3: Registry stubs — Phase 1a doesn't use OLAS registries
  // Tokenomics.initializeTokenomics() requires non-zero addresses for
  // componentRegistry, agentRegistry, serviceRegistry. These stubs satisfy
  // the non-zero check; the registries are only called during epoch
  // settlement for developer incentive tracking (unused in Phase 1a).
  // -----------------------------------------------------------------------
  const RegistryStub = await ethers.getContractFactory("RegistryStub", deployer);
  const componentRegistry = await RegistryStub.deploy();
  await componentRegistry.waitForDeployment();
  const agentRegistry = await RegistryStub.deploy();
  await agentRegistry.waitForDeployment();
  const serviceRegistry = await RegistryStub.deploy();
  await serviceRegistry.waitForDeployment();

  // -----------------------------------------------------------------------
  // Step 4: Tokenomics — empty constructor (two-phase init pattern)
  // We deploy now to get its address for other contracts. It gets
  // initialized in Step 10b after all addresses are known.
  // -----------------------------------------------------------------------
  const Tokenomics = await ethers.getContractFactory("Tokenomics", deployer);
  const tokenomics = await Tokenomics.deploy();
  await tokenomics.waitForDeployment();

  // -----------------------------------------------------------------------
  // Step 5: GenericBondCalculator — constructor(olas, tokenomics)
  // Both are immutable. Tokenomics doesn't need to be initialized yet;
  // the calculator just stores the address for later getLastIDF() calls.
  // -----------------------------------------------------------------------
  const BondCalc = await ethers.getContractFactory("GenericBondCalculator", deployer);
  const bondCalculator = await BondCalc.deploy(
    await jinn.getAddress(),
    await tokenomics.getAddress()
  );
  await bondCalculator.waitForDeployment();

  // -----------------------------------------------------------------------
  // Step 6: VoteWeighting — constructor(ve)
  // ve is immutable. dispenser is set post-deploy via changeDispenser().
  // -----------------------------------------------------------------------
  const voteWeightingContractName = config.timingProfile === "fast-test" ? "VoteWeightingFast" : "VoteWeighting";
  const VoteWeighting = await ethers.getContractFactory(voteWeightingContractName, deployer);
  const voteWeighting = await VoteWeighting.deploy(await veOLAS.getAddress());
  await voteWeighting.waitForDeployment();

  // -----------------------------------------------------------------------
  // Step 7: Treasury — constructor(olas, tokenomics, depository, dispenser)
  //
  // CIRCULAR DEPENDENCY RESOLUTION:
  // Treasury requires all four addresses to be non-zero, but depository
  // and dispenser haven't been deployed yet (they need Treasury's address).
  //
  // The trick: Treasury stores depository/dispenser as MUTABLE storage
  // variables (not immutable). We pass the deployer's address as a
  // placeholder. After deploying the real Depository and Dispenser, we
  // call Treasury.changeManagers() to swap in the real addresses.
  // -----------------------------------------------------------------------
  const Treasury = await ethers.getContractFactory(
    "src/vendor/tokenomics/Treasury.sol:Treasury",
    deployer
  );
  const treasury = await Treasury.deploy(
    await jinn.getAddress(),
    await tokenomics.getAddress(),
    deployerAddress,  // placeholder for depository (will be updated in Step 10a)
    deployerAddress   // placeholder for dispenser  (will be updated in Step 10a)
  );
  await treasury.waitForDeployment();

  // -----------------------------------------------------------------------
  // Step 8: Depository — constructor(olas, tokenomics, treasury, bondCalculator)
  // olas is immutable; tokenomics, treasury, bondCalculator are mutable storage.
  // All addresses are now available.
  // -----------------------------------------------------------------------
  const Depository = await ethers.getContractFactory(
    "src/vendor/tokenomics/Depository.sol:Depository",
    deployer
  );
  const depository = await Depository.deploy(
    await jinn.getAddress(),
    await tokenomics.getAddress(),
    await treasury.getAddress(),
    await bondCalculator.getAddress()
  );
  await depository.waitForDeployment();

  // -----------------------------------------------------------------------
  // Step 9: Dispenser — constructor(olas, tokenomics, treasury, voteWeighting,
  //                                  retainer, maxClaimEpochs, maxStakingTargets,
  //                                  defaultMinWeight, defaultMaxIncentive)
  // olas is immutable; tokenomics, treasury, voteWeighting are mutable storage.
  // -----------------------------------------------------------------------
  const Dispenser = await ethers.getContractFactory("Dispenser", deployer);
  const dispenser = await Dispenser.deploy(
    await jinn.getAddress(),
    await tokenomics.getAddress(),
    await treasury.getAddress(),
    await voteWeighting.getAddress(),
    config.retainer,
    config.maxNumClaimingEpochs,
    config.maxNumStakingTargets,
    config.defaultMinStakingWeight,
    config.defaultMaxStakingIncentive
  );
  await dispenser.waitForDeployment();

  // -----------------------------------------------------------------------
  // Step 10: Post-deploy wiring
  // -----------------------------------------------------------------------

  // 10a. Treasury: swap placeholder depository/dispenser for real addresses.
  //      changeManagers(tokenomics, depository, dispenser) — pass zero for
  //      tokenomics since it's already correct.
  const treasuryTx = await treasury.changeManagers(
    ethers.ZeroAddress,                // tokenomics already set correctly
    await depository.getAddress(),     // real depository
    await dispenser.getAddress()       // real dispenser
  );
  await treasuryTx.wait();

  // 10b. Tokenomics: initialize with all addresses.
  //      This is the two-phase init. Must be called within 1 year of JINN deploy.
  const initTx = await tokenomics.initializeTokenomics(
    await jinn.getAddress(),
    await treasury.getAddress(),
    await depository.getAddress(),
    await dispenser.getAddress(),
    await veOLAS.getAddress(),
    config.epochLen,
    await componentRegistry.getAddress(),
    await agentRegistry.getAddress(),
    await serviceRegistry.getAddress(),
    config.donatorBlacklist || ethers.ZeroAddress
  );
  await initTx.wait();

  // 10c. JINN: set Treasury as the minter.
  //      Treasury.depositTokenForOLAS() and Treasury.withdrawToAccount() call
  //      JINN.mint(), so Treasury must be the minter.
  const minterTx = await jinn.changeMinter(await treasury.getAddress());
  await minterTx.wait();

  // 10d. VoteWeighting: set Dispenser so addNominee/removeNominee callbacks work.
  const vwTx = await voteWeighting.changeDispenser(await dispenser.getAddress());
  await vwTx.wait();

  // 10e. Seed next-epoch staking fractions and staking params so the first
  //      claimable epochs on testnet have non-zero staking allocation.
  const incentiveFractionsTx = await tokenomics.changeIncentiveFractions(
    config.rewardComponentFraction,
    config.rewardAgentFraction,
    config.maxBondFraction,
    config.topUpComponentFraction,
    config.topUpAgentFraction,
    config.stakingFraction,
  );
  await incentiveFractionsTx.wait();

  const stakingParamsTx = await tokenomics.changeStakingParams(
    config.defaultMaxStakingIncentive,
    config.defaultMinStakingWeight,
  );
  await stakingParamsTx.wait();

  return {
    jinn,
    veOLAS,
    tokenomics,
    treasury,
    depository,
    dispenser,
    bondCalculator,
    voteWeighting,
    componentRegistry,
    agentRegistry,
    serviceRegistry,
  };
}
export const FAST_TEST_DEPLOY_CONFIG: DeployConfig = {
  ...DEFAULT_DEPLOY_CONFIG,
  timingProfile: "fast-test",
  epochLen: 900,
  votePeriodSeconds: 900,
  weightVoteDelaySeconds: 900,
  voteCheckpointHorizon: 1000,
};
