/**
 * Tests for JinnTestnetFaucet — testnet JINN drip with per-recipient rate limit.
 */

import { expect } from 'chai';
import { network } from 'hardhat';

describe('JinnTestnetFaucet', function () {
  this.timeout(30000);

  let ethers: Awaited<ReturnType<typeof network.connect>>['ethers'];
  let networkHelpers: Awaited<ReturnType<typeof network.connect>>['networkHelpers'];

  let DRIP_AMOUNT: bigint;
  const DRIP_INTERVAL = 24 * 60 * 60; // 24 hours

  let faucet: any;
  let token: any;
  let owner: any;
  let aliceSender: any;
  let aliceRecipient: any;
  let bobRecipient: any;

  before(async function () {
    ({ ethers, networkHelpers } = await network.connect());
    DRIP_AMOUNT = ethers.parseEther('100');
  });

  beforeEach(async function () {
    [owner, aliceSender, aliceRecipient, bobRecipient] = await ethers.getSigners();

    const TokenFactory = await ethers.getContractFactory('TestERC20');
    token = await TokenFactory.deploy('Jinn', 'JINN');
    await token.waitForDeployment();

    const FaucetFactory = await ethers.getContractFactory('JinnTestnetFaucet');
    faucet = await FaucetFactory.deploy(await token.getAddress(), DRIP_AMOUNT, DRIP_INTERVAL);
    await faucet.waitForDeployment();

    // Seed faucet with 1000 JINN (10 drips worth)
    await token.mint(await faucet.getAddress(), ethers.parseEther('1000'));
  });

  describe('Construction', function () {
    it('should initialize with correct params', async function () {
      expect(await faucet.jinn()).to.equal(await token.getAddress());
      expect(await faucet.dripAmount()).to.equal(DRIP_AMOUNT);
      expect(await faucet.dripInterval()).to.equal(DRIP_INTERVAL);
      expect(await faucet.owner()).to.equal(owner.address);
    });

    it('should reject zero token', async function () {
      const Factory = await ethers.getContractFactory('JinnTestnetFaucet');
      await expect(
        Factory.deploy(ethers.ZeroAddress, DRIP_AMOUNT, DRIP_INTERVAL),
      ).to.be.revertedWithCustomError(Factory, 'ZeroAddress');
    });

    it('should reject zero drip amount', async function () {
      const Factory = await ethers.getContractFactory('JinnTestnetFaucet');
      await expect(
        Factory.deploy(await token.getAddress(), 0, DRIP_INTERVAL),
      ).to.be.revertedWithCustomError(Factory, 'ZeroValue');
    });

    it('should reject zero drip interval', async function () {
      const Factory = await ethers.getContractFactory('JinnTestnetFaucet');
      await expect(
        Factory.deploy(await token.getAddress(), DRIP_AMOUNT, 0),
      ).to.be.revertedWithCustomError(Factory, 'ZeroValue');
    });

    it('should emit OwnershipTransferred on construction', async function () {
      const Factory = await ethers.getContractFactory('JinnTestnetFaucet');
      const deploy = await Factory.deploy(await token.getAddress(), DRIP_AMOUNT, DRIP_INTERVAL);
      await expect(deploy.deploymentTransaction())
        .to.emit(deploy, 'OwnershipTransferred')
        .withArgs(ethers.ZeroAddress, owner.address);
    });
  });

  describe('drip', function () {
    it('should transfer dripAmount to recipient when fresh', async function () {
      await expect(faucet.connect(aliceSender).drip(aliceRecipient.address))
        .to.emit(faucet, 'Dripped')
        .withArgs(aliceRecipient.address, DRIP_AMOUNT, (v: any) => v > 0);

      expect(await token.balanceOf(aliceRecipient.address)).to.equal(DRIP_AMOUNT);
    });

    it('should update lastDripAt on success', async function () {
      const tx = await faucet.connect(aliceSender).drip(aliceRecipient.address);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      expect(await faucet.lastDripAt(aliceRecipient.address)).to.equal(block.timestamp);
    });

    it('should revert TooSoon within dripInterval', async function () {
      await faucet.connect(aliceSender).drip(aliceRecipient.address);

      await expect(faucet.connect(aliceSender).drip(aliceRecipient.address))
        .to.be.revertedWithCustomError(faucet, 'TooSoon')
        .withArgs(aliceRecipient.address, (v: any) => v > 0);
    });

    it('should allow second drip after dripInterval + 1', async function () {
      await faucet.connect(aliceSender).drip(aliceRecipient.address);

      await networkHelpers.time.increase(DRIP_INTERVAL + 1);

      await expect(faucet.connect(aliceSender).drip(aliceRecipient.address))
        .to.emit(faucet, 'Dripped');

      expect(await token.balanceOf(aliceRecipient.address)).to.equal(DRIP_AMOUNT * 2n);
    });

    it('should revert FaucetEmpty when balance < dripAmount', async function () {
      // Withdraw most of the seed, leaving < DRIP_AMOUNT
      const seeded = await token.balanceOf(await faucet.getAddress());
      await faucet.connect(owner).withdraw(owner.address, seeded - DRIP_AMOUNT / 2n);

      await expect(faucet.connect(aliceSender).drip(aliceRecipient.address))
        .to.be.revertedWithCustomError(faucet, 'FaucetEmpty')
        .withArgs(DRIP_AMOUNT, DRIP_AMOUNT / 2n);
    });

    it('should revert ZeroAddress for zero recipient', async function () {
      await expect(faucet.connect(aliceSender).drip(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(faucet, 'ZeroAddress');
    });

    it('should rate-limit independently per recipient', async function () {
      await faucet.connect(aliceSender).drip(aliceRecipient.address);

      // Bob should still be eligible — rate limit is per recipient, not global.
      await expect(faucet.connect(aliceSender).drip(bobRecipient.address))
        .to.emit(faucet, 'Dripped');

      expect(await token.balanceOf(aliceRecipient.address)).to.equal(DRIP_AMOUNT);
      expect(await token.balanceOf(bobRecipient.address)).to.equal(DRIP_AMOUNT);
    });

    it('should accept any caller (permissionless)', async function () {
      // Bob (a random sender) tops up Alice — permissionless drip.
      await expect(faucet.connect(bobRecipient).drip(aliceRecipient.address))
        .to.emit(faucet, 'Dripped');
      expect(await token.balanceOf(aliceRecipient.address)).to.equal(DRIP_AMOUNT);
    });
  });

  describe('views', function () {
    it('balance() returns faucet JINN balance', async function () {
      expect(await faucet.balance()).to.equal(ethers.parseEther('1000'));
    });

    it('nextAvailableAt returns 0 for fresh recipient', async function () {
      expect(await faucet.nextAvailableAt(aliceRecipient.address)).to.equal(0);
    });

    it('nextAvailableAt returns lastDripAt + dripInterval after a drip', async function () {
      const tx = await faucet.connect(aliceSender).drip(aliceRecipient.address);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      expect(await faucet.nextAvailableAt(aliceRecipient.address))
        .to.equal(block.timestamp + DRIP_INTERVAL);
    });
  });

  describe('admin', function () {
    it('owner can setDripAmount', async function () {
      const newAmount = ethers.parseEther('50');
      await expect(faucet.connect(owner).setDripAmount(newAmount))
        .to.emit(faucet, 'DripAmountUpdated')
        .withArgs(DRIP_AMOUNT, newAmount);
      expect(await faucet.dripAmount()).to.equal(newAmount);
    });

    it('non-owner cannot setDripAmount', async function () {
      await expect(faucet.connect(aliceSender).setDripAmount(ethers.parseEther('50')))
        .to.be.revertedWithCustomError(faucet, 'OwnerOnly');
    });

    it('setDripAmount rejects zero', async function () {
      await expect(faucet.connect(owner).setDripAmount(0))
        .to.be.revertedWithCustomError(faucet, 'ZeroValue');
    });

    it('owner can setDripInterval', async function () {
      const newInterval = 60 * 60; // 1 hour
      await expect(faucet.connect(owner).setDripInterval(newInterval))
        .to.emit(faucet, 'DripIntervalUpdated')
        .withArgs(DRIP_INTERVAL, newInterval);
      expect(await faucet.dripInterval()).to.equal(newInterval);
    });

    it('non-owner cannot setDripInterval', async function () {
      await expect(faucet.connect(aliceSender).setDripInterval(60))
        .to.be.revertedWithCustomError(faucet, 'OwnerOnly');
    });

    it('setDripInterval rejects zero', async function () {
      await expect(faucet.connect(owner).setDripInterval(0))
        .to.be.revertedWithCustomError(faucet, 'ZeroValue');
    });

    it('owner can transferOwnership', async function () {
      await expect(faucet.connect(owner).transferOwnership(aliceSender.address))
        .to.emit(faucet, 'OwnershipTransferred')
        .withArgs(owner.address, aliceSender.address);
      expect(await faucet.owner()).to.equal(aliceSender.address);
    });

    it('non-owner cannot transferOwnership', async function () {
      await expect(faucet.connect(aliceSender).transferOwnership(aliceSender.address))
        .to.be.revertedWithCustomError(faucet, 'OwnerOnly');
    });

    it('transferOwnership rejects zero', async function () {
      await expect(faucet.connect(owner).transferOwnership(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(faucet, 'ZeroAddress');
    });

    it('owner can withdraw', async function () {
      const amount = ethers.parseEther('200');
      await expect(faucet.connect(owner).withdraw(owner.address, amount))
        .to.emit(faucet, 'Withdrawn')
        .withArgs(owner.address, amount);
      expect(await token.balanceOf(await faucet.getAddress())).to.equal(ethers.parseEther('800'));
    });

    it('non-owner cannot withdraw', async function () {
      await expect(faucet.connect(aliceSender).withdraw(aliceSender.address, ethers.parseEther('1')))
        .to.be.revertedWithCustomError(faucet, 'OwnerOnly');
    });

    it('withdraw rejects zero recipient', async function () {
      await expect(faucet.connect(owner).withdraw(ethers.ZeroAddress, ethers.parseEther('1')))
        .to.be.revertedWithCustomError(faucet, 'ZeroAddress');
    });

    it('withdraw rejects zero amount', async function () {
      await expect(faucet.connect(owner).withdraw(owner.address, 0))
        .to.be.revertedWithCustomError(faucet, 'ZeroValue');
    });
  });
});
