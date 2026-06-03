/**
 * Tests for the v0 ERC20Votes JINN governance token (src/jinn/token/JINN.sol).
 */

import { expect } from "chai";
import { network } from "hardhat";

const JINN_FQN = "src/jinn/token/JINN.sol:JINN";

describe("JINN (v0 ERC20Votes governance token)", function () {
  this.timeout(60_000);

  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];
  let networkHelpers: Awaited<ReturnType<typeof network.connect>>["networkHelpers"];

  before(async () => {
    ({ ethers, networkHelpers } = await network.connect());
  });

  async function deployJinnFixture() {
    const [deployer, alice, bob, carol, distributor, newDistributor, newOwner] =
      await ethers.getSigners();

    const Factory = await ethers.getContractFactory(JINN_FQN);
    const jinn = await Factory.deploy("Jinn", "JINN", deployer.address);
    await jinn.waitForDeployment();

    return { jinn, deployer, alice, bob, carol, distributor, newDistributor, newOwner };
  }

  const loadFixture = <T>(fn: () => Promise<T>) => networkHelpers.loadFixture(fn);

  describe("Deploy state", function () {
    it("has zero total supply at deploy", async function () {
      const { jinn } = await loadFixture(deployJinnFixture);
      expect(await jinn.totalSupply()).to.equal(0n);
    });

    it("uses Jinn / JINN name and symbol", async function () {
      const { jinn } = await loadFixture(deployJinnFixture);
      expect(await jinn.name()).to.equal("Jinn");
      expect(await jinn.symbol()).to.equal("JINN");
      expect(await jinn.decimals()).to.equal(18);
    });

    it("sets initialOwner as owner", async function () {
      const { jinn, deployer } = await loadFixture(deployJinnFixture);
      expect(await jinn.owner()).to.equal(deployer.address);
    });

    it("starts with the zero address as minter", async function () {
      const { jinn } = await loadFixture(deployJinnFixture);
      expect(await jinn.minter()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("setMinter access control", function () {
    it("reverts when called by a non-owner with OwnableUnauthorizedAccount", async function () {
      const { jinn, alice, distributor } = await loadFixture(deployJinnFixture);
      await expect(jinn.connect(alice).setMinter(distributor.address))
        .to.be.revertedWithCustomError(jinn, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("lets the owner set the minter and emits MinterUpdated", async function () {
      const { jinn, deployer, distributor } = await loadFixture(deployJinnFixture);
      await expect(jinn.connect(deployer).setMinter(distributor.address))
        .to.emit(jinn, "MinterUpdated")
        .withArgs(distributor.address);
      expect(await jinn.minter()).to.equal(distributor.address);
    });
  });

  describe("mint access control", function () {
    it("reverts with NotMinter for callers other than the minter", async function () {
      const { jinn, alice } = await loadFixture(deployJinnFixture);
      await expect(jinn.connect(alice).mint(alice.address, 100n))
        .to.be.revertedWithCustomError(jinn, "NotMinter")
        .withArgs(alice.address);
    });

    it("lets the configured minter mint successfully", async function () {
      const { jinn, deployer, distributor, alice } = await loadFixture(deployJinnFixture);
      await jinn.connect(deployer).setMinter(distributor.address);
      await expect(jinn.connect(distributor).mint(alice.address, 1_000n))
        .to.emit(jinn, "Transfer")
        .withArgs(ethers.ZeroAddress, alice.address, 1_000n);
      expect(await jinn.balanceOf(alice.address)).to.equal(1_000n);
    });

    it("rejects the prior owner once they are no longer the minter", async function () {
      const { jinn, deployer, distributor, alice } = await loadFixture(deployJinnFixture);
      // Owner is not implicitly a minter — even before setMinter, owner must not mint.
      await expect(jinn.connect(deployer).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(jinn, "NotMinter")
        .withArgs(deployer.address);

      // After setMinter to distributor, owner still cannot mint.
      await jinn.connect(deployer).setMinter(distributor.address);
      await expect(jinn.connect(deployer).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(jinn, "NotMinter")
        .withArgs(deployer.address);
    });
  });

  describe("mint correctness", function () {
    it("aggregates balances and totalSupply across multiple mints", async function () {
      const { jinn, deployer, distributor, alice, bob } =
        await loadFixture(deployJinnFixture);
      await jinn.connect(deployer).setMinter(distributor.address);

      await jinn.connect(distributor).mint(alice.address, 100n);
      await jinn.connect(distributor).mint(bob.address, 50n);
      await jinn.connect(distributor).mint(alice.address, 25n);

      expect(await jinn.balanceOf(alice.address)).to.equal(125n);
      expect(await jinn.balanceOf(bob.address)).to.equal(50n);
      expect(await jinn.totalSupply()).to.equal(175n);
    });
  });

  describe("ERC20Votes checkpoints", function () {
    it("reflects delegated balances and updates voting power on transfer", async function () {
      const { jinn, deployer, distributor, alice, bob } =
        await loadFixture(deployJinnFixture);
      await jinn.connect(deployer).setMinter(distributor.address);

      // Mint to alice and bob, both self-delegate so their balances become voting power.
      await jinn.connect(distributor).mint(alice.address, 1_000n);
      await jinn.connect(distributor).mint(bob.address, 200n);
      await jinn.connect(alice).delegate(alice.address);
      await jinn.connect(bob).delegate(bob.address);

      expect(await jinn.getVotes(alice.address)).to.equal(1_000n);
      expect(await jinn.getVotes(bob.address)).to.equal(200n);

      // Snapshot the timestamp before the transfer so we can probe past votes.
      // (JINN uses ERC-6372 timestamp mode — getPastVotes takes a timestamp,
      // not a block number.)
      const beforeTransferTime = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

      // Advance time so beforeTransferTime is queryable as a strictly-past timepoint.
      await ethers.provider.send("evm_mine", []);

      // Transfer from alice -> bob.
      await jinn.connect(alice).transfer(bob.address, 300n);
      const afterTransferTime = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

      // Advance again to make afterTransferTime queryable as past.
      await ethers.provider.send("evm_mine", []);

      // Live voting power tracks balances.
      expect(await jinn.getVotes(alice.address)).to.equal(700n);
      expect(await jinn.getVotes(bob.address)).to.equal(500n);

      // Past voting power preserves history.
      expect(await jinn.getPastVotes(alice.address, beforeTransferTime)).to.equal(1_000n);
      expect(await jinn.getPastVotes(bob.address, beforeTransferTime)).to.equal(200n);
      expect(await jinn.getPastVotes(alice.address, afterTransferTime)).to.equal(700n);
      expect(await jinn.getPastVotes(bob.address, afterTransferTime)).to.equal(500n);
    });
  });

  describe("Ownable2Step transition", function () {
    it("requires acceptOwnership before the new owner gains privileges", async function () {
      const { jinn, deployer, newOwner, distributor } =
        await loadFixture(deployJinnFixture);

      await jinn.connect(deployer).transferOwnership(newOwner.address);

      // Pending state: old owner still owns, new owner is queued.
      expect(await jinn.owner()).to.equal(deployer.address);
      expect(await jinn.pendingOwner()).to.equal(newOwner.address);

      // newOwner cannot exercise privileges yet.
      await expect(jinn.connect(newOwner).setMinter(distributor.address))
        .to.be.revertedWithCustomError(jinn, "OwnableUnauthorizedAccount")
        .withArgs(newOwner.address);

      // Old owner still can.
      await jinn.connect(deployer).setMinter(distributor.address);
      expect(await jinn.minter()).to.equal(distributor.address);

      // Accept ownership and verify newOwner now controls setMinter.
      await jinn.connect(newOwner).acceptOwnership();
      expect(await jinn.owner()).to.equal(newOwner.address);
      expect(await jinn.pendingOwner()).to.equal(ethers.ZeroAddress);

      await expect(jinn.connect(newOwner).setMinter(ethers.ZeroAddress))
        .to.emit(jinn, "MinterUpdated")
        .withArgs(ethers.ZeroAddress);

      // And the previous owner can no longer set the minter.
      await expect(jinn.connect(deployer).setMinter(distributor.address))
        .to.be.revertedWithCustomError(jinn, "OwnableUnauthorizedAccount")
        .withArgs(deployer.address);
    });
  });

  describe("Minter rotation", function () {
    it("supports unsetting and re-setting the minter", async function () {
      const { jinn, deployer, distributor, newDistributor, alice } =
        await loadFixture(deployJinnFixture);

      // Initial minter mints OK.
      await jinn.connect(deployer).setMinter(distributor.address);
      await jinn.connect(distributor).mint(alice.address, 10n);
      expect(await jinn.balanceOf(alice.address)).to.equal(10n);

      // Unset: previous minter loses privileges.
      await expect(jinn.connect(deployer).setMinter(ethers.ZeroAddress))
        .to.emit(jinn, "MinterUpdated")
        .withArgs(ethers.ZeroAddress);
      expect(await jinn.minter()).to.equal(ethers.ZeroAddress);

      await expect(jinn.connect(distributor).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(jinn, "NotMinter")
        .withArgs(distributor.address);

      // Re-set to a different address: that address can mint, the prior cannot.
      await jinn.connect(deployer).setMinter(newDistributor.address);
      await jinn.connect(newDistributor).mint(alice.address, 5n);
      expect(await jinn.balanceOf(alice.address)).to.equal(15n);

      await expect(jinn.connect(distributor).mint(alice.address, 1n))
        .to.be.revertedWithCustomError(jinn, "NotMinter")
        .withArgs(distributor.address);
    });
  });
});
