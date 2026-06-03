/**
 * Tests for the Task-native TaskClaimEmitter snapshot surface.
 */

import { expect } from 'chai';
import { network } from 'hardhat';

describe('TaskClaimEmitter', function () {
  this.timeout(30000);

  let ethers: Awaited<ReturnType<typeof network.connect>>['ethers'];

  let emitter: any;
  let checker: any;
  let registry: any;
  let owner: any;
  let claimer: any;
  let multisig: any;

  const SERVICE_ID = 42n;

  before(async function () {
    ({ ethers } = await network.connect());
  });

  function expectedSnapshotHash(args: {
    claimId: bigint;
    serviceId: bigint;
    taskCreationWeight: bigint;
    solutionDeliveryWeight: bigint;
    verdictDeliveryWeight: bigint;
    multisig: string;
  }): string {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'address'],
        [
          args.claimId,
          args.serviceId,
          args.taskCreationWeight,
          args.solutionDeliveryWeight,
          args.verdictDeliveryWeight,
          args.multisig,
        ],
      ),
    );
  }

  beforeEach(async function () {
    [owner, claimer, multisig] = await ethers.getSigners();

    const CheckerFactory = await ethers.getContractFactory('MockTaskActivityCheckerSnapshot');
    checker = await CheckerFactory.deploy();
    await checker.waitForDeployment();

    const RegistryFactory = await ethers.getContractFactory('MockServiceRegistryForEmitter');
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EmitterFactory = await ethers.getContractFactory('TaskClaimEmitter');
    emitter = await EmitterFactory.deploy(await checker.getAddress(), await registry.getAddress());
    await emitter.waitForDeployment();
  });

  it('rejects zero-address constructor args', async function () {
    const EmitterFactory = await ethers.getContractFactory('TaskClaimEmitter');
    await expect(
      EmitterFactory.deploy(ethers.ZeroAddress, await registry.getAddress()),
    ).to.be.revertedWith('TaskClaimEmitter: checker=0');
    await expect(
      EmitterFactory.deploy(await checker.getAddress(), ethers.ZeroAddress),
    ).to.be.revertedWith('TaskClaimEmitter: registry=0');
  });

  it('exposes immutable component addresses', async function () {
    expect(await emitter.checker()).to.equal(await checker.getAddress());
    expect(await emitter.serviceRegistry()).to.equal(await registry.getAddress());
  });

  it('emits ClaimTicket with Task-native activity weights', async function () {
    await registry.setMultisig(SERVICE_ID, multisig.address);
    await checker.setTaskCreationWeight(multisig.address, 7n);
    await checker.setSolutionDeliveryWeight(multisig.address, 11n);
    await checker.setVerdictDeliveryWeight(multisig.address, 3n);

    await expect(emitter.connect(claimer).emitClaim(SERVICE_ID))
      .to.emit(emitter, 'ClaimTicket')
      .withArgs(1n, SERVICE_ID, 7n, 11n, 3n, multisig.address, claimer.address);

    expect(await emitter.nextClaimId()).to.equal(1n);
    expect(await emitter.claimSnapshotHashes(1n)).to.equal(
      expectedSnapshotHash({
        claimId: 1n,
        serviceId: SERVICE_ID,
        taskCreationWeight: 7n,
        solutionDeliveryWeight: 11n,
        verdictDeliveryWeight: 3n,
        multisig: multisig.address,
      }),
    );
  });

  it('reads zero weights when nothing has been set', async function () {
    await registry.setMultisig(SERVICE_ID, multisig.address);

    await expect(emitter.connect(claimer).emitClaim(SERVICE_ID))
      .to.emit(emitter, 'ClaimTicket')
      .withArgs(1n, SERVICE_ID, 0n, 0n, 0n, multisig.address, claimer.address);
  });

  it('reverts on unknown serviceId', async function () {
    await expect(emitter.connect(claimer).emitClaim(999n)).to.be.revertedWith(
      'TaskClaimEmitter: unknown service',
    );
  });
});
