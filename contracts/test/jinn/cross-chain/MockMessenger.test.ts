/**
 * Tests for MockMessenger (Phase A4 / bd jinn-mono-6lq).
 *
 * Owner-controlled fixture-injection messenger used in unit tests
 * and Phase D burn-in fallback. Verifies the round-trip, access
 * control, and revert paths.
 */

import { expect } from 'chai';
import { network } from 'hardhat';

describe('MockMessenger', function () {
  this.timeout(30000);

  let ethers: Awaited<ReturnType<typeof network.connect>>['ethers'];

  let messenger: any;
  let owner: any;
  let other: any;
  let multisig: any;

  const CLAIM_ID = 101n;
  const CLAIM_ID_2 = 102n;
  const SERVICE_ID = 7n;

  before(async function () {
    ({ ethers } = await network.connect());
  });

  beforeEach(async function () {
    [owner, other, multisig] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('MockMessenger');
    messenger = await Factory.deploy(owner.address);
    await messenger.waitForDeployment();
  });

  it('rejects zero owner at deploy', async function () {
    const Factory = await ethers.getContractFactory('MockMessenger');
    await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWith(
      'MockMessenger: owner=0',
    );
  });

  it('verifyClaim returns the fixture for a known claimId', async function () {
    await messenger.setFixture(CLAIM_ID, {
      serviceId: SERVICE_ID,
      taskCreationWeight: 10n,
      solutionDeliveryWeight: 20n,
      verdictDeliveryWeight: 5n,
      multisig: multisig.address,
    });

    const proof = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [CLAIM_ID]);
    const result = await messenger.verifyClaim(proof);

    expect(result.serviceId).to.equal(SERVICE_ID);
    expect(result.taskCreationWeight).to.equal(10n);
    expect(result.solutionDeliveryWeight).to.equal(20n);
    expect(result.verdictDeliveryWeight).to.equal(5n);
    expect(result.multisig).to.equal(multisig.address);
  });

  it('supports multiple claims for one serviceId', async function () {
    await messenger.setFixture(CLAIM_ID, {
      serviceId: SERVICE_ID,
      taskCreationWeight: 10n,
      solutionDeliveryWeight: 20n,
      verdictDeliveryWeight: 5n,
      multisig: multisig.address,
    });
    await messenger.setFixture(CLAIM_ID_2, {
      serviceId: SERVICE_ID,
      taskCreationWeight: 11n,
      solutionDeliveryWeight: 21n,
      verdictDeliveryWeight: 6n,
      multisig: multisig.address,
    });

    const proof = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [CLAIM_ID_2]);
    const result = await messenger.verifyClaim(proof);
    expect(result.serviceId).to.equal(SERVICE_ID);
    expect(result.taskCreationWeight).to.equal(11n);
  });

  it('reverts when no fixture has been set for the claimId', async function () {
    const proof = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [123n]);
    await expect(messenger.verifyClaim(proof)).to.be.revertedWith(
      'MockMessenger: no fixture',
    );
  });

  it('rejects setFixture from a non-owner', async function () {
    await expect(
      messenger.connect(other).setFixture(CLAIM_ID, {
        serviceId: SERVICE_ID,
        taskCreationWeight: 1n,
        solutionDeliveryWeight: 1n,
        verdictDeliveryWeight: 1n,
        multisig: multisig.address,
      }),
    ).to.be.revertedWith('MockMessenger: not owner');
  });

  it('rejects setFixture with multisig=0 (sentinel for unset)', async function () {
    await expect(
      messenger.setFixture(CLAIM_ID, {
        serviceId: SERVICE_ID,
        taskCreationWeight: 1n,
        solutionDeliveryWeight: 1n,
        verdictDeliveryWeight: 1n,
        multisig: ethers.ZeroAddress,
      }),
    ).to.be.revertedWith('MockMessenger: multisig=0');
  });

  it('emits FixtureSet on setFixture', async function () {
    await expect(
      messenger.setFixture(CLAIM_ID, {
        serviceId: SERVICE_ID,
        taskCreationWeight: 1n,
        solutionDeliveryWeight: 1n,
        verdictDeliveryWeight: 1n,
        multisig: multisig.address,
      }),
    )
      .to.emit(messenger, 'FixtureSet')
      .withArgs(CLAIM_ID, SERVICE_ID, multisig.address);
  });

  it('owner can transfer ownership; new owner can set fixtures', async function () {
    await expect(messenger.transferOwnership(other.address))
      .to.emit(messenger, 'OwnerTransferred')
      .withArgs(owner.address, other.address);
    expect(await messenger.owner()).to.equal(other.address);

    // Old owner can no longer write.
    await expect(
      messenger.setFixture(CLAIM_ID, {
        serviceId: SERVICE_ID,
        taskCreationWeight: 1n,
        solutionDeliveryWeight: 1n,
        verdictDeliveryWeight: 1n,
        multisig: multisig.address,
      }),
    ).to.be.revertedWith('MockMessenger: not owner');

    // New owner can.
    await messenger.connect(other).setFixture(CLAIM_ID, {
      serviceId: SERVICE_ID,
      taskCreationWeight: 99n,
      solutionDeliveryWeight: 88n,
      verdictDeliveryWeight: 77n,
      multisig: multisig.address,
    });
    const proof = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [CLAIM_ID]);
    const result = await messenger.verifyClaim(proof);
    expect(result.taskCreationWeight).to.equal(99n);
  });

  it('transferOwnership rejects non-owner and zero address', async function () {
    await expect(
      messenger.connect(other).transferOwnership(other.address),
    ).to.be.revertedWith('MockMessenger: not owner');
    await expect(messenger.transferOwnership(ethers.ZeroAddress)).to.be.revertedWith(
      'MockMessenger: newOwner=0',
    );
  });
});
