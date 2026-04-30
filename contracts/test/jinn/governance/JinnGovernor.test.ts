/**
 * JinnGovernor.test.ts — Phase A5 of the Jinn v0 MVI.
 *
 * Covers:
 *   1. Deploy state — Governor settings + Timelock min delay match the
 *      configured profile, and JINN ownership is pending the Timelock.
 *   2. Propose → Vote → Queue → Execute end-to-end, on the fast-test
 *      profile so the test fits within the suite's runtime budget.
 *   3. Quorum failure path — a proposal with insufficient votes ends in the
 *      Defeated state.
 *   4. Public getters — every parameter we lock at deploy time is queryable.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { Signer } from "ethers";

import {
  CANONICAL_GOVERNANCE_CONFIG,
  FAST_TEST_GOVERNANCE_CONFIG,
  JinnMviGovernanceConfig,
} from "../../../scripts/lib/jinn-mvi-helpers";
import { deployJinnMviL1 } from "../../../scripts/deploy-jinn-mvi-l1";

// IGovernor.ProposalState (mirrored locally because it's an enum on an
// interface and TypeChain returns it as bigint).
const ProposalState = {
  Pending: 0n,
  Active: 1n,
  Canceled: 2n,
  Defeated: 3n,
  Succeeded: 4n,
  Queued: 5n,
  Expired: 6n,
  Executed: 7n,
} as const;

async function deploy(config: JinnMviGovernanceConfig) {
  const [deployer, alice, bob, carol] = await ethers.getSigners();
  const result = await deployJinnMviL1(deployer, config);

  const jinn = await ethers.getContractAt(
    "src/jinn/token/JINN.sol:JINN",
    result.jinn,
  );
  const timelock = await ethers.getContractAt(
    "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController",
    result.timelock,
  );
  const governor = await ethers.getContractAt(
    "src/jinn/governance/JinnGovernor.sol:JinnGovernor",
    result.governor,
  );

  return { deployer, alice, bob, carol, jinn, timelock, governor, result };
}

/**
 * Move JINN.owner from deployer → Timelock and execute a one-shot
 * `setMinter(address)` via a direct `transferOwnership` race-around: we use
 * impersonation so the Timelock can call `acceptOwnership`. This mirrors the
 * post-deploy state once a first Governor proposal has executed.
 */
async function acceptOwnershipAsTimelock(
  jinn: any,
  timelockAddress: string,
): Promise<void> {
  await ethers.provider.send("hardhat_impersonateAccount", [timelockAddress]);
  await ethers.provider.send("hardhat_setBalance", [
    timelockAddress,
    "0x" + (10n ** 18n).toString(16),
  ]);
  const timelockSigner = await ethers.getSigner(timelockAddress);
  await jinn.connect(timelockSigner).acceptOwnership();
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [
    timelockAddress,
  ]);
}

/**
 * Mint JINN to a list of holders by temporarily setting the deployer as the
 * minter, minting, then unsetting. Requires JINN.owner to be the Timelock
 * and the Timelock to be impersonated.
 */
async function bootstrapVotingPower(
  jinn: any,
  timelockAddress: string,
  holders: { signer: Signer; amount: bigint }[],
): Promise<void> {
  await ethers.provider.send("hardhat_impersonateAccount", [timelockAddress]);
  const timelockSigner = await ethers.getSigner(timelockAddress);

  const [deployer] = await ethers.getSigners();
  await jinn.connect(timelockSigner).setMinter(await deployer.getAddress());

  for (const { signer, amount } of holders) {
    await jinn.connect(deployer).mint(await signer.getAddress(), amount);
    // Self-delegate so balance counts as voting power.
    await jinn.connect(signer).delegate(await signer.getAddress());
  }

  await jinn.connect(timelockSigner).setMinter(ethers.ZeroAddress);
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [
    timelockAddress,
  ]);
}

describe("JinnGovernor", function () {
  this.timeout(120_000);

  // -------------------------------------------------------------------------
  // 1. Deploy state
  // -------------------------------------------------------------------------
  describe("deploy state", function () {
    it("canonical profile records the locked Governor + Timelock parameters", async function () {
      const { governor, timelock } = await deploy(CANONICAL_GOVERNANCE_CONFIG);

      expect(await governor.votingDelay()).to.equal(
        CANONICAL_GOVERNANCE_CONFIG.votingDelaySeconds,
      );
      expect(await governor.votingPeriod()).to.equal(
        CANONICAL_GOVERNANCE_CONFIG.votingPeriodSeconds,
      );
      expect(await governor.proposalThreshold()).to.equal(
        CANONICAL_GOVERNANCE_CONFIG.proposalThreshold,
      );
      expect(await governor.quorumNumerator()).to.equal(
        CANONICAL_GOVERNANCE_CONFIG.quorumNumerator,
      );
      expect(await governor.quorumDenominator()).to.equal(100n);
      expect(await timelock.getMinDelay()).to.equal(
        CANONICAL_GOVERNANCE_CONFIG.timelockMinDelaySeconds,
      );
    });

    it("fast-test profile records compressed timing", async function () {
      const { governor, timelock } = await deploy(FAST_TEST_GOVERNANCE_CONFIG);

      expect(await governor.votingDelay()).to.equal(
        FAST_TEST_GOVERNANCE_CONFIG.votingDelaySeconds,
      );
      expect(await governor.votingPeriod()).to.equal(
        FAST_TEST_GOVERNANCE_CONFIG.votingPeriodSeconds,
      );
      expect(await timelock.getMinDelay()).to.equal(
        FAST_TEST_GOVERNANCE_CONFIG.timelockMinDelaySeconds,
      );
    });

    it("Timelock holds JINN ownership after the new owner accepts", async function () {
      const { jinn, timelock, deployer, result } = await deploy(
        FAST_TEST_GOVERNANCE_CONFIG,
      );

      // Pre-acceptance, ownership is still with the deployer; the Timelock
      // is the *pending* owner.
      expect(await jinn.owner()).to.equal(await deployer.getAddress());
      expect(await jinn.pendingOwner()).to.equal(result.timelock);

      // Once the Timelock accepts, it becomes the canonical owner.
      await acceptOwnershipAsTimelock(jinn, result.timelock);
      expect(await jinn.owner()).to.equal(result.timelock);
      expect(await jinn.pendingOwner()).to.equal(ethers.ZeroAddress);
      void timelock; // (silence unused)
    });

    it("grants the Governor PROPOSER + EXECUTOR + CANCELLER on the Timelock", async function () {
      const { governor, timelock } = await deploy(FAST_TEST_GOVERNANCE_CONFIG);
      const governorAddress = await governor.getAddress();

      const proposer = await timelock.PROPOSER_ROLE();
      const executor = await timelock.EXECUTOR_ROLE();
      const canceller = await timelock.CANCELLER_ROLE();

      expect(await timelock.hasRole(proposer, governorAddress)).to.equal(true);
      expect(await timelock.hasRole(executor, governorAddress)).to.equal(true);
      expect(await timelock.hasRole(canceller, governorAddress)).to.equal(true);
    });

    it("renounces the deployer's optional Timelock admin role", async function () {
      const { timelock, deployer } = await deploy(FAST_TEST_GOVERNANCE_CONFIG);
      const adminRole = await timelock.DEFAULT_ADMIN_ROLE();
      expect(
        await timelock.hasRole(adminRole, await deployer.getAddress()),
      ).to.equal(false);
      // Timelock self-administers.
      expect(
        await timelock.hasRole(adminRole, await timelock.getAddress()),
      ).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Full proposal lifecycle
  // -------------------------------------------------------------------------
  describe("propose → vote → queue → execute", function () {
    it("executes a Governor proposal that updates the Governor's own voting delay", async function () {
      const { jinn, timelock, governor, alice, bob, carol, result } =
        await deploy(FAST_TEST_GOVERNANCE_CONFIG);

      // Move ownership so the Timelock can mint via setMinter.
      await acceptOwnershipAsTimelock(jinn, result.timelock);

      // Mint enough JINN to easily exceed the 4% quorum (1000 JINN total).
      await bootstrapVotingPower(jinn, result.timelock, [
        { signer: alice, amount: ethers.parseEther("400") },
        { signer: bob, amount: ethers.parseEther("400") },
        { signer: carol, amount: ethers.parseEther("200") },
      ]);

      // ERC20Votes checkpoints update at the *end* of the block. Mine one so
      // the proposal snapshot (taken at proposalStart = block + votingDelay)
      // sees the freshly delegated balances.
      await ethers.provider.send("evm_mine", []);

      // Submit a proposal: change votingDelay from 60s to 120s.
      const newVotingDelay = 120;
      const setVotingDelayCall = governor.interface.encodeFunctionData(
        "setVotingDelay",
        [newVotingDelay],
      );
      const description = "Increase voting delay to 120s";
      const targets = [await governor.getAddress()];
      const values = [0n];
      const calldatas = [setVotingDelayCall];

      const tx = await governor
        .connect(alice)
        .propose(targets, values, calldatas, description);
      const receipt = await tx.wait();
      // Recover proposalId from the ProposalCreated event.
      const proposalCreatedTopic =
        governor.interface.getEvent("ProposalCreated").topicHash;
      const log = receipt!.logs.find(
        (l: any) => l.topics[0] === proposalCreatedTopic,
      );
      const parsed = governor.interface.parseLog({
        topics: log!.topics as string[],
        data: log!.data,
      });
      const proposalId: bigint = parsed!.args.proposalId;

      // Pending → wait votingDelay → Active.
      expect(await governor.state(proposalId)).to.equal(ProposalState.Pending);
      await time.increase(FAST_TEST_GOVERNANCE_CONFIG.votingDelaySeconds + 1);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Active);

      // Cast votes (1 = For).
      await governor.connect(alice).castVote(proposalId, 1);
      await governor.connect(bob).castVote(proposalId, 1);
      // Carol abstains; quorum should still be reached on FOR votes alone.

      // Active → wait votingPeriod → Succeeded.
      await time.increase(FAST_TEST_GOVERNANCE_CONFIG.votingPeriodSeconds + 1);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Succeeded);

      // Queue and wait the Timelock min delay.
      const descriptionHash = ethers.id(description);
      await governor.queue(targets, values, calldatas, descriptionHash);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Queued);

      await time.increase(
        FAST_TEST_GOVERNANCE_CONFIG.timelockMinDelaySeconds + 1,
      );

      // Execute. Anyone with EXECUTOR_ROLE on the Timelock can call this on
      // the Governor, and only the Governor itself holds the role here.
      // {governor.execute} routes through the Timelock and ultimately
      // performs the call as the Timelock — which has onlyGovernance access
      // to setVotingDelay because governor._executor() == address(timelock).
      await governor.execute(targets, values, calldatas, descriptionHash);
      expect(await governor.state(proposalId)).to.equal(ProposalState.Executed);

      // The state change actually landed.
      expect(await governor.votingDelay()).to.equal(newVotingDelay);
      void timelock;
    });
  });

  // -------------------------------------------------------------------------
  // 3. Quorum failure path
  // -------------------------------------------------------------------------
  describe("quorum failure", function () {
    it("a proposal with sub-quorum FOR votes ends in Defeated", async function () {
      const { jinn, governor, alice, bob, result } = await deploy(
        FAST_TEST_GOVERNANCE_CONFIG,
      );

      // Move ownership so the Timelock can mint via setMinter.
      await acceptOwnershipAsTimelock(jinn, result.timelock);

      // 100 JINN to alice (the proposer), 9_900 JINN to bob (silent
      // majority). Quorum is 4% of total supply at the proposal block =
      // 400 JINN. Alice's 100 JINN is below quorum, and bob will not vote.
      await bootstrapVotingPower(jinn, result.timelock, [
        { signer: alice, amount: ethers.parseEther("100") },
        { signer: bob, amount: ethers.parseEther("9900") },
      ]);
      await ethers.provider.send("evm_mine", []);

      // No-op proposal targeting the Governor itself.
      const calldata = governor.interface.encodeFunctionData(
        "setProposalThreshold",
        [1n],
      );
      const description = "Bump proposalThreshold to 1 (will not pass quorum)";
      const targets = [await governor.getAddress()];
      const values = [0n];
      const calldatas = [calldata];

      const tx = await governor
        .connect(alice)
        .propose(targets, values, calldatas, description);
      const receipt = await tx.wait();
      const log = receipt!.logs.find(
        (l: any) =>
          l.topics[0] === governor.interface.getEvent("ProposalCreated").topicHash,
      );
      const proposalId: bigint = governor.interface.parseLog({
        topics: log!.topics as string[],
        data: log!.data,
      })!.args.proposalId;

      // Activate, vote with insufficient power, expire.
      await time.increase(FAST_TEST_GOVERNANCE_CONFIG.votingDelaySeconds + 1);
      await governor.connect(alice).castVote(proposalId, 1);
      await time.increase(FAST_TEST_GOVERNANCE_CONFIG.votingPeriodSeconds + 1);

      expect(await governor.state(proposalId)).to.equal(ProposalState.Defeated);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Settings access
  // -------------------------------------------------------------------------
  describe("settings access", function () {
    it("public getters return the deploy-time parameters", async function () {
      const { governor, jinn, timelock } = await deploy(
        FAST_TEST_GOVERNANCE_CONFIG,
      );

      expect(await governor.name()).to.equal("JinnGovernor");
      expect(await governor.token()).to.equal(await jinn.getAddress());
      expect(await governor.timelock()).to.equal(await timelock.getAddress());
      expect(await governor.votingDelay()).to.equal(
        FAST_TEST_GOVERNANCE_CONFIG.votingDelaySeconds,
      );
      expect(await governor.votingPeriod()).to.equal(
        FAST_TEST_GOVERNANCE_CONFIG.votingPeriodSeconds,
      );
      expect(await governor.proposalThreshold()).to.equal(
        FAST_TEST_GOVERNANCE_CONFIG.proposalThreshold,
      );
    });
  });
});
