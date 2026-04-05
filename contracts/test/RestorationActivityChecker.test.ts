const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('RestorationActivityChecker', function () {
  this.timeout(30000);

  let checker: any;
  let owner: any;
  let worker: any;
  let other: any;

  before(async function () {
    [owner, worker, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('RestorationActivityChecker');
    checker = await Factory.deploy('11574074074074', owner.address);
    await checker.waitForDeployment();
  });

  it('should initialize with correct owner and ratio', async function () {
    expect(await checker.owner()).to.equal(owner.address);
    expect(await checker.livenessRatio()).to.equal(11574074074074n);
  });

  it('should allow any caller to record activity (permissionless)', async function () {
    await checker.connect(worker).recordActivity(owner.address, 0);
    expect(await checker.activityCounts(owner.address)).to.equal(1n);
    expect(await checker.activityCountsByType(owner.address, 0)).to.equal(1n);
  });

  it('should record DELIVER activity', async function () {
    await checker.connect(worker).recordActivity(owner.address, 1);
    expect(await checker.activityCounts(owner.address)).to.equal(2n);
    expect(await checker.activityCountsByType(owner.address, 1)).to.equal(1n);
  });

  it('should record EVALUATE activity', async function () {
    await checker.connect(other).recordActivity(owner.address, 2);
    expect(await checker.activityCounts(owner.address)).to.equal(3n);
    expect(await checker.activityCountsByType(owner.address, 2)).to.equal(1n);
  });

  it('should reject invalid activity type', async function () {
    await expect(
      checker.connect(worker).recordActivity(owner.address, 3),
    ).to.be.revertedWith('RestorationActivityChecker: invalid type');
  });

  it('should pass ratio with 3 activities in 1 day', async function () {
    expect(await checker.isRatioPass([10, 3], [7, 0], 86400)).to.be.true;
  });

  it('should fail ratio with 0 activities', async function () {
    expect(await checker.isRatioPass([10, 0], [7, 0], 86400)).to.be.false;
  });

  it('should fail ratio with 0 time diff', async function () {
    expect(await checker.isRatioPass([10, 3], [7, 0], 0)).to.be.false;
  });

  it('should transfer ownership', async function () {
    await checker.transferOwnership(other.address);
    expect(await checker.owner()).to.equal(other.address);
  });
});
