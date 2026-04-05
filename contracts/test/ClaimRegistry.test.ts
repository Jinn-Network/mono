/**
 * Tests for ClaimRegistry + IEligibilityChecker
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

describe('ClaimRegistry', function () {
  this.timeout(30000);

  const CLAIM_TTL = 300; // 5 minutes
  const REQUEST_ID = ethers.id('test-request-1');
  const REQUEST_ID_2 = ethers.id('test-request-2');

  let registry: any;
  let checker: any;
  let owner: any;
  let operatorA: any;
  let operatorB: any;

  beforeEach(async function () {
    [owner, operatorA, operatorB] = await ethers.getSigners();

    const CheckerFactory = await ethers.getContractFactory('AcceptAllChecker');
    checker = await CheckerFactory.deploy();
    await checker.waitForDeployment();

    const RegistryFactory = await ethers.getContractFactory('ClaimRegistry');
    registry = await RegistryFactory.deploy(CLAIM_TTL, owner.address);
    await registry.waitForDeployment();
  });

  describe('Construction', function () {
    it('should initialize with correct owner and TTL', async function () {
      expect(await registry.owner()).to.equal(owner.address);
      expect(await registry.claimTTL()).to.equal(CLAIM_TTL);
    });

    it('should reject zero TTL', async function () {
      const Factory = await ethers.getContractFactory('ClaimRegistry');
      await expect(Factory.deploy(0, owner.address)).to.be.revertedWithCustomError(
        Factory, 'ZeroValue',
      );
    });

    it('should reject zero owner', async function () {
      const Factory = await ethers.getContractFactory('ClaimRegistry');
      await expect(Factory.deploy(CLAIM_TTL, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        Factory, 'ZeroAddress',
      );
    });
  });

  describe('claimJob', function () {
    it('should allow claiming an unclaimed request', async function () {
      await expect(registry.connect(operatorA).claimJob(REQUEST_ID))
        .to.emit(registry, 'JobClaimed')
        .withArgs(REQUEST_ID, operatorA.address, (v: any) => v > 0);

      const [claimer, expiresAt] = await registry.getJobClaim(REQUEST_ID);
      expect(claimer).to.equal(operatorA.address);
      expect(expiresAt).to.be.gt(0);
    });

    it('should reject claiming an already-claimed request', async function () {
      await registry.connect(operatorA).claimJob(REQUEST_ID);

      await expect(registry.connect(operatorB).claimJob(REQUEST_ID))
        .to.be.revertedWithCustomError(registry, 'JobAlreadyClaimed')
        .withArgs(REQUEST_ID, operatorA.address);
    });

    it('should allow reclaiming after expiry', async function () {
      await registry.connect(operatorA).claimJob(REQUEST_ID);

      // Advance time past TTL
      await time.increase(CLAIM_TTL + 1);

      // B can now claim — A's claim is expired
      await expect(registry.connect(operatorB).claimJob(REQUEST_ID))
        .to.emit(registry, 'ClaimExpired')
        .withArgs(REQUEST_ID, operatorA.address)
        .and.to.emit(registry, 'JobClaimed')
        .withArgs(REQUEST_ID, operatorB.address, (v: any) => v > 0);
    });

    it('should increment expiredClaimCount on reclaim after expiry', async function () {
      await registry.connect(operatorA).claimJob(REQUEST_ID);
      await time.increase(CLAIM_TTL + 1);
      await registry.connect(operatorB).claimJob(REQUEST_ID);

      expect(await registry.expiredClaimCount(operatorA.address)).to.equal(1);
      expect(await registry.expiredClaimCount(operatorB.address)).to.equal(0);
    });
  });

  describe('getJobClaim', function () {
    it('should return zero for unclaimed request', async function () {
      const [claimer, expiresAt] = await registry.getJobClaim(REQUEST_ID);
      expect(claimer).to.equal(ethers.ZeroAddress);
      expect(expiresAt).to.equal(0);
    });

    it('should return zero for expired claim', async function () {
      await registry.connect(operatorA).claimJob(REQUEST_ID);
      await time.increase(CLAIM_TTL + 1);

      const [claimer, expiresAt] = await registry.getJobClaim(REQUEST_ID);
      expect(claimer).to.equal(ethers.ZeroAddress);
      expect(expiresAt).to.equal(0);
    });
  });

  describe('releaseClaim', function () {
    it('should allow claimer to release', async function () {
      await registry.connect(operatorA).claimJob(REQUEST_ID);

      await expect(registry.connect(operatorA).releaseClaim(REQUEST_ID))
        .to.emit(registry, 'ClaimReleased')
        .withArgs(REQUEST_ID, operatorA.address);

      const [claimer] = await registry.getJobClaim(REQUEST_ID);
      expect(claimer).to.equal(ethers.ZeroAddress);
    });

    it('should not increment expiredClaimCount on voluntary release', async function () {
      await registry.connect(operatorA).claimJob(REQUEST_ID);
      await registry.connect(operatorA).releaseClaim(REQUEST_ID);

      expect(await registry.expiredClaimCount(operatorA.address)).to.equal(0);
    });

    it('should reject release from non-claimer', async function () {
      await registry.connect(operatorA).claimJob(REQUEST_ID);

      await expect(registry.connect(operatorB).releaseClaim(REQUEST_ID))
        .to.be.revertedWithCustomError(registry, 'NotClaimOwner');
    });

    it('should reject release of non-existent claim', async function () {
      await expect(registry.connect(operatorA).releaseClaim(REQUEST_ID))
        .to.be.revertedWithCustomError(registry, 'NoClaimExists');
    });

    it('should allow another operator to claim after release', async function () {
      await registry.connect(operatorA).claimJob(REQUEST_ID);
      await registry.connect(operatorA).releaseClaim(REQUEST_ID);
      await registry.connect(operatorB).claimJob(REQUEST_ID);

      const [claimer] = await registry.getJobClaim(REQUEST_ID);
      expect(claimer).to.equal(operatorB.address);
    });
  });

  describe('expireClaim', function () {
    it('should allow anyone to expire a stale claim', async function () {
      await registry.connect(operatorA).claimJob(REQUEST_ID);
      await time.increase(CLAIM_TTL + 1);

      await expect(registry.connect(operatorB).expireClaim(REQUEST_ID))
        .to.emit(registry, 'ClaimExpired')
        .withArgs(REQUEST_ID, operatorA.address);

      expect(await registry.expiredClaimCount(operatorA.address)).to.equal(1);
    });

    it('should reject expiring a non-expired claim', async function () {
      await registry.connect(operatorA).claimJob(REQUEST_ID);

      await expect(registry.connect(operatorB).expireClaim(REQUEST_ID))
        .to.be.revertedWithCustomError(registry, 'ClaimNotExpired');
    });

    it('should reject expiring a non-existent claim', async function () {
      await expect(registry.connect(operatorA).expireClaim(REQUEST_ID))
        .to.be.revertedWithCustomError(registry, 'NoClaimExists');
    });
  });

  describe('Eligibility checker', function () {
    it('should allow claims when no checker is set', async function () {
      await registry.connect(operatorA).claimJob(REQUEST_ID);
      const [claimer] = await registry.getJobClaim(REQUEST_ID);
      expect(claimer).to.equal(operatorA.address);
    });

    it('should allow claims with AcceptAllChecker', async function () {
      await registry.connect(owner).setEligibilityChecker(await checker.getAddress());
      await registry.connect(operatorA).claimJob(REQUEST_ID);
      const [claimer] = await registry.getJobClaim(REQUEST_ID);
      expect(claimer).to.equal(operatorA.address);
    });

    it('should emit EligibilityCheckerUpdated', async function () {
      const checkerAddr = await checker.getAddress();
      await expect(registry.connect(owner).setEligibilityChecker(checkerAddr))
        .to.emit(registry, 'EligibilityCheckerUpdated')
        .withArgs(ethers.ZeroAddress, checkerAddr);
    });

    it('should reject setEligibilityChecker from non-owner', async function () {
      await expect(
        registry.connect(operatorA).setEligibilityChecker(await checker.getAddress()),
      ).to.be.revertedWithCustomError(registry, 'OwnerOnly');
    });
  });

  describe('Admin', function () {
    it('should allow owner to update TTL', async function () {
      await expect(registry.connect(owner).setClaimTTL(600))
        .to.emit(registry, 'ClaimTTLUpdated')
        .withArgs(CLAIM_TTL, 600);
      expect(await registry.claimTTL()).to.equal(600);
    });

    it('should reject zero TTL update', async function () {
      await expect(registry.connect(owner).setClaimTTL(0))
        .to.be.revertedWithCustomError(registry, 'ZeroValue');
    });

    it('should allow ownership transfer', async function () {
      await registry.connect(owner).transferOwnership(operatorA.address);
      expect(await registry.owner()).to.equal(operatorA.address);
    });

    it('should reject non-owner admin calls', async function () {
      await expect(registry.connect(operatorA).setClaimTTL(600))
        .to.be.revertedWithCustomError(registry, 'OwnerOnly');
      await expect(registry.connect(operatorA).transferOwnership(operatorB.address))
        .to.be.revertedWithCustomError(registry, 'OwnerOnly');
    });
  });

  describe('Punishment tracking', function () {
    it('should accumulate expired claim count across multiple requests', async function () {
      // Claim and let expire for two different requests
      await registry.connect(operatorA).claimJob(REQUEST_ID);
      await time.increase(CLAIM_TTL + 1);
      await registry.connect(operatorB).expireClaim(REQUEST_ID);

      await registry.connect(operatorA).claimJob(REQUEST_ID_2);
      await time.increase(CLAIM_TTL + 1);
      await registry.connect(operatorB).expireClaim(REQUEST_ID_2);

      expect(await registry.expiredClaimCount(operatorA.address)).to.equal(2);
    });
  });
});
