/**
 * DeployL1Stack.test.ts — Sanity test that deploys the full Jinn L1 tokenomics
 * stack on local Hardhat and verifies all contracts are connected correctly.
 */

import { expect } from "chai";
import { network } from "hardhat";
import {
  deployL1Stack,
  DEFAULT_DEPLOY_CONFIG,
  FAST_TEST_DEPLOY_CONFIG,
  type Phase1aDeployment,
} from "../../scripts/lib/deploy-helpers.js";

describe("L1 Stack Deployment", function () {
  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];
  let d: Phase1aDeployment;
  let deployerAddress: string;

  before(async function () {
    // Tokenomics compilation is heavy; give it time
    this.timeout(120_000);

    ({ ethers } = await network.connect());
    const [deployer] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    d = await deployL1Stack(ethers, deployer, DEFAULT_DEPLOY_CONFIG);
  });

  // ---------------------------------------------------------------------------
  // Basic deployment checks — every contract has a non-zero address
  // ---------------------------------------------------------------------------
  it("deploys all contracts to non-zero addresses", async function () {
    const contracts = [
      d.jinn, d.veOLAS, d.tokenomics, d.treasury,
      d.depository, d.dispenser, d.bondCalculator,
      d.voteWeighting, d.componentRegistry, d.agentRegistry, d.serviceRegistry,
    ];
    for (const c of contracts) {
      const addr = await c.getAddress();
      expect(addr).to.not.equal(ethers.ZeroAddress);
    }
  });

  // ---------------------------------------------------------------------------
  // JINN token wiring
  // ---------------------------------------------------------------------------
  it("JINN minter is set to Treasury", async function () {
    const minter = await d.jinn.minter();
    expect(minter).to.equal(await d.treasury.getAddress());
  });

  it("JINN owner is the deployer", async function () {
    const owner = await d.jinn.owner();
    expect(owner).to.equal(deployerAddress);
  });

  // ---------------------------------------------------------------------------
  // veOLAS wiring
  // ---------------------------------------------------------------------------
  it("veOLAS token points to JINN", async function () {
    const token = await d.veOLAS.token();
    expect(token).to.equal(await d.jinn.getAddress());
  });

  // ---------------------------------------------------------------------------
  // Treasury wiring — the key circular-dependency resolution
  // ---------------------------------------------------------------------------
  it("Treasury.depository points to the real Depository", async function () {
    const dep = await d.treasury.depository();
    expect(dep).to.equal(await d.depository.getAddress());
  });

  it("Treasury.dispenser points to the real Dispenser", async function () {
    const disp = await d.treasury.dispenser();
    expect(disp).to.equal(await d.dispenser.getAddress());
  });

  it("Treasury.tokenomics points to Tokenomics", async function () {
    const tok = await d.treasury.tokenomics();
    expect(tok).to.equal(await d.tokenomics.getAddress());
  });

  it("Treasury.olas points to JINN", async function () {
    const olas = await d.treasury.olas();
    expect(olas).to.equal(await d.jinn.getAddress());
  });

  // ---------------------------------------------------------------------------
  // Tokenomics wiring (post-initializeTokenomics)
  // ---------------------------------------------------------------------------
  it("Tokenomics is initialized (owner is set)", async function () {
    const owner = await d.tokenomics.owner();
    expect(owner).to.equal(deployerAddress);
  });

  it("Tokenomics.treasury matches Treasury", async function () {
    const t = await d.tokenomics.treasury();
    expect(t).to.equal(await d.treasury.getAddress());
  });

  it("Tokenomics.depository matches Depository", async function () {
    const dep = await d.tokenomics.depository();
    expect(dep).to.equal(await d.depository.getAddress());
  });

  it("Tokenomics.dispenser matches Dispenser", async function () {
    const disp = await d.tokenomics.dispenser();
    expect(disp).to.equal(await d.dispenser.getAddress());
  });

  it("Tokenomics.ve matches veOLAS", async function () {
    const ve = await d.tokenomics.ve();
    expect(ve).to.equal(await d.veOLAS.getAddress());
  });

  it("Tokenomics epochLen matches config", async function () {
    const epochLen = await d.tokenomics.epochLen();
    expect(epochLen).to.equal(DEFAULT_DEPLOY_CONFIG.epochLen);
  });

  it("Tokenomics epochCounter starts at 1", async function () {
    const counter = await d.tokenomics.epochCounter();
    expect(counter).to.equal(1);
  });

  it("seeds next-epoch staking fractions and staking params", async function () {
    const stakingPoint = await d.tokenomics.mapEpochStakingPoints(2);

    expect(stakingPoint[1]).to.equal(BigInt(DEFAULT_DEPLOY_CONFIG.defaultMaxStakingIncentive));
    expect(stakingPoint[2]).to.equal(DEFAULT_DEPLOY_CONFIG.defaultMinStakingWeight);
    expect(stakingPoint[3]).to.equal(DEFAULT_DEPLOY_CONFIG.stakingFraction);
  });

  // ---------------------------------------------------------------------------
  // Depository wiring
  // ---------------------------------------------------------------------------
  it("Depository.olas is JINN (immutable)", async function () {
    const olas = await d.depository.olas();
    expect(olas).to.equal(await d.jinn.getAddress());
  });

  it("Depository.treasury matches Treasury", async function () {
    const t = await d.depository.treasury();
    expect(t).to.equal(await d.treasury.getAddress());
  });

  it("Depository.tokenomics matches Tokenomics", async function () {
    const tok = await d.depository.tokenomics();
    expect(tok).to.equal(await d.tokenomics.getAddress());
  });

  // ---------------------------------------------------------------------------
  // Dispenser wiring
  // ---------------------------------------------------------------------------
  it("Dispenser.olas is JINN (immutable)", async function () {
    const olas = await d.dispenser.olas();
    expect(olas).to.equal(await d.jinn.getAddress());
  });

  it("Dispenser.treasury matches Treasury", async function () {
    const t = await d.dispenser.treasury();
    expect(t).to.equal(await d.treasury.getAddress());
  });

  it("Dispenser.tokenomics matches Tokenomics", async function () {
    const tok = await d.dispenser.tokenomics();
    expect(tok).to.equal(await d.tokenomics.getAddress());
  });

  it("Dispenser.voteWeighting matches VoteWeighting", async function () {
    const vw = await d.dispenser.voteWeighting();
    expect(vw).to.equal(await d.voteWeighting.getAddress());
  });

  // ---------------------------------------------------------------------------
  // VoteWeighting wiring
  // ---------------------------------------------------------------------------
  it("VoteWeighting.ve matches veOLAS (immutable)", async function () {
    const ve = await d.voteWeighting.ve();
    expect(ve).to.equal(await d.veOLAS.getAddress());
  });

  it("VoteWeighting.dispenser matches Dispenser", async function () {
    const disp = await d.voteWeighting.dispenser();
    expect(disp).to.equal(await d.dispenser.getAddress());
  });

  it("VoteWeighting exposes canonical governance timing", async function () {
    expect(await d.voteWeighting.WEEK()).to.equal(DEFAULT_DEPLOY_CONFIG.votePeriodSeconds);
    expect(await d.voteWeighting.WEIGHT_VOTE_DELAY()).to.equal(DEFAULT_DEPLOY_CONFIG.weightVoteDelaySeconds);
    expect(await d.voteWeighting.MAX_NUM_WEEKS()).to.equal(DEFAULT_DEPLOY_CONFIG.voteCheckpointHorizon);
  });

  // ---------------------------------------------------------------------------
  // GenericBondCalculator wiring
  // ---------------------------------------------------------------------------
  it("GenericBondCalculator.olas is JINN (immutable)", async function () {
    const olas = await d.bondCalculator.olas();
    expect(olas).to.equal(await d.jinn.getAddress());
  });

  it("GenericBondCalculator.tokenomics matches Tokenomics (immutable)", async function () {
    const tok = await d.bondCalculator.tokenomics();
    expect(tok).to.equal(await d.tokenomics.getAddress());
  });

  // ---------------------------------------------------------------------------
  // Double-init protection
  // ---------------------------------------------------------------------------
  it("Tokenomics cannot be initialized twice", async function () {
    const [deployer] = await ethers.getSigners();
    await expect(
      d.tokenomics.initializeTokenomics(
        await d.jinn.getAddress(),
        await d.treasury.getAddress(),
        await d.depository.getAddress(),
        await d.dispenser.getAddress(),
        await d.veOLAS.getAddress(),
        86400,
        await d.componentRegistry.getAddress(),
        await d.agentRegistry.getAddress(),
        await d.serviceRegistry.getAddress(),
        ethers.ZeroAddress
      )
    ).to.revert(ethers);
  });

  it("deploys the fast-test governance timing profile when requested", async function () {
    const [deployer] = await ethers.getSigners();
    const fast = await deployL1Stack(ethers, deployer, FAST_TEST_DEPLOY_CONFIG);

    expect(await fast.tokenomics.epochLen()).to.equal(FAST_TEST_DEPLOY_CONFIG.epochLen);
    expect(await fast.voteWeighting.WEEK()).to.equal(FAST_TEST_DEPLOY_CONFIG.votePeriodSeconds);
    expect(await fast.voteWeighting.WEIGHT_VOTE_DELAY()).to.equal(FAST_TEST_DEPLOY_CONFIG.weightVoteDelaySeconds);
    expect(await fast.voteWeighting.MAX_NUM_WEEKS()).to.equal(FAST_TEST_DEPLOY_CONFIG.voteCheckpointHorizon);

    const stakingPoint = await fast.tokenomics.mapEpochStakingPoints(2);
    expect(stakingPoint[1]).to.equal(BigInt(FAST_TEST_DEPLOY_CONFIG.defaultMaxStakingIncentive));
    expect(stakingPoint[2]).to.equal(FAST_TEST_DEPLOY_CONFIG.defaultMinStakingWeight);
    expect(stakingPoint[3]).to.equal(FAST_TEST_DEPLOY_CONFIG.stakingFraction);
  });
});
