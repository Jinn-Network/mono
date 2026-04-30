/**
 * Tests for JINN token contract
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('JINN', function () {
  this.timeout(30000);

  let jinn: any;
  let owner: any;
  let minter: any;
  let other: any;

  beforeEach(async function () {
    [owner, minter, other] = await ethers.getSigners();

    const JINNFactory = await ethers.getContractFactory('src/vendor/governance/JINN.sol:JINN');
    jinn = await JINNFactory.deploy();
    await jinn.waitForDeployment();
  });

  describe('Deployment', function () {
    it('should have correct name', async function () {
      expect(await jinn.name()).to.equal('Jinn');
    });

    it('should have correct symbol', async function () {
      expect(await jinn.symbol()).to.equal('JINN');
    });

    it('should have 18 decimals', async function () {
      expect(await jinn.decimals()).to.equal(18);
    });

    it('should set deployer as owner', async function () {
      expect(await jinn.owner()).to.equal(owner.address);
    });

    it('should set deployer as initial minter', async function () {
      expect(await jinn.minter()).to.equal(owner.address);
    });

    it('should have zero total supply', async function () {
      expect(await jinn.totalSupply()).to.equal(0);
    });
  });

  describe('Minting', function () {
    const mintAmount = ethers.parseEther('1000');

    it('should allow minter to mint tokens', async function () {
      await jinn.connect(owner).mint(other.address, mintAmount);
      expect(await jinn.balanceOf(other.address)).to.equal(mintAmount);
      expect(await jinn.totalSupply()).to.equal(mintAmount);
    });

    it('should not mint if amount exceeds inflation cap', async function () {
      // Minting more than tenYearSupplyCap should silently not mint
      const overCap = (await jinn.tenYearSupplyCap()) + 1n;
      await jinn.connect(owner).mint(other.address, overCap);
      expect(await jinn.totalSupply()).to.equal(0);
      expect(await jinn.balanceOf(other.address)).to.equal(0);
    });

    it('should revert when non-minter tries to mint', async function () {
      await expect(jinn.connect(other).mint(other.address, mintAmount))
        .to.be.revertedWithCustomError(jinn, 'ManagerOnly')
        .withArgs(other.address, owner.address);
    });

    it('should allow new minter to mint after changeMinter', async function () {
      await jinn.connect(owner).changeMinter(minter.address);
      await jinn.connect(minter).mint(other.address, mintAmount);
      expect(await jinn.balanceOf(other.address)).to.equal(mintAmount);
    });

    it('should revert when old minter tries to mint after changeMinter', async function () {
      await jinn.connect(owner).changeMinter(minter.address);
      await expect(jinn.connect(owner).mint(other.address, mintAmount))
        .to.be.revertedWithCustomError(jinn, 'ManagerOnly')
        .withArgs(owner.address, minter.address);
    });
  });

  describe('Ownership', function () {
    it('should allow owner to transfer ownership via changeOwner', async function () {
      await jinn.connect(owner).changeOwner(other.address);
      expect(await jinn.owner()).to.equal(other.address);
    });

    it('should emit OwnerUpdated on changeOwner', async function () {
      await expect(jinn.connect(owner).changeOwner(other.address))
        .to.emit(jinn, 'OwnerUpdated')
        .withArgs(other.address);
    });

    it('should revert changeOwner from non-owner', async function () {
      await expect(jinn.connect(other).changeOwner(other.address))
        .to.be.revertedWithCustomError(jinn, 'ManagerOnly')
        .withArgs(other.address, owner.address);
    });

    it('should revert changeOwner with zero address', async function () {
      await expect(jinn.connect(owner).changeOwner(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(jinn, 'ZeroAddress');
    });

    it('should allow new owner to act after transfer', async function () {
      await jinn.connect(owner).changeOwner(other.address);
      // New owner can change minter
      await jinn.connect(other).changeMinter(minter.address);
      expect(await jinn.minter()).to.equal(minter.address);
    });
  });

  describe('changeMinter', function () {
    it('should allow owner to change minter', async function () {
      await jinn.connect(owner).changeMinter(minter.address);
      expect(await jinn.minter()).to.equal(minter.address);
    });

    it('should emit MinterUpdated on changeMinter', async function () {
      await expect(jinn.connect(owner).changeMinter(minter.address))
        .to.emit(jinn, 'MinterUpdated')
        .withArgs(minter.address);
    });

    it('should revert changeMinter from non-owner', async function () {
      await expect(jinn.connect(other).changeMinter(minter.address))
        .to.be.revertedWithCustomError(jinn, 'ManagerOnly')
        .withArgs(other.address, owner.address);
    });

    it('should revert changeMinter with zero address', async function () {
      await expect(jinn.connect(owner).changeMinter(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(jinn, 'ZeroAddress');
    });
  });
});
