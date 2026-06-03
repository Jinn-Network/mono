/**
 * Tests for JinnClaimEmitter (Phase A4 / bd jinn-mono-6lq).
 *
 * Mocks the three on-chain reads (V2 checker, V2 router, OLAS service
 * registry) and verifies the ClaimTicket event mirrors the snapshot
 * values returned by those mocks at emit time.
 */

import { expect } from 'chai';
import { network } from 'hardhat';

describe('JinnClaimEmitter', function () {
  this.timeout(30000);

  let ethers: Awaited<ReturnType<typeof network.connect>>['ethers'];

  let emitter: any;
  let checker: any;
  let router: any;
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
    verifiedCreations: bigint;
    novelty: bigint;
    evalDelivery: bigint;
    multisig: string;
  }): string {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'address'],
        [
          args.claimId,
          args.serviceId,
          args.verifiedCreations,
          args.novelty,
          args.evalDelivery,
          args.multisig,
        ],
      ),
    );
  }

  beforeEach(async function () {
    [owner, claimer, multisig] = await ethers.getSigners();

    const CheckerFactory = await ethers.getContractFactory('MockCheckerV2');
    checker = await CheckerFactory.deploy();
    await checker.waitForDeployment();

    const RouterFactory = await ethers.getContractFactory('MockRouterV2');
    router = await RouterFactory.deploy();
    await router.waitForDeployment();

    const RegistryFactory = await ethers.getContractFactory('MockServiceRegistryForEmitter');
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EmitterFactory = await ethers.getContractFactory('JinnClaimEmitter');
    emitter = await EmitterFactory.deploy(
      await checker.getAddress(),
      await router.getAddress(),
      await registry.getAddress(),
    );
    await emitter.waitForDeployment();
  });

  it('rejects zero-address constructor args', async function () {
    const EmitterFactory = await ethers.getContractFactory('JinnClaimEmitter');
    await expect(
      EmitterFactory.deploy(
        ethers.ZeroAddress,
        await router.getAddress(),
        await registry.getAddress(),
      ),
    ).to.be.revertedWith('JinnClaimEmitter: checker=0');
    await expect(
      EmitterFactory.deploy(
        await checker.getAddress(),
        ethers.ZeroAddress,
        await registry.getAddress(),
      ),
    ).to.be.revertedWith('JinnClaimEmitter: router=0');
    await expect(
      EmitterFactory.deploy(
        await checker.getAddress(),
        await router.getAddress(),
        ethers.ZeroAddress,
      ),
    ).to.be.revertedWith('JinnClaimEmitter: registry=0');
  });

  it('exposes immutable component addresses', async function () {
    expect(await emitter.checker()).to.equal(await checker.getAddress());
    expect(await emitter.router()).to.equal(await router.getAddress());
    expect(await emitter.serviceRegistry()).to.equal(await registry.getAddress());
  });

  it('emits ClaimTicket with the snapshot of all three counters', async function () {
    await registry.setMultisig(SERVICE_ID, multisig.address);
    await checker.setVerifiedCreations(multisig.address, 7n);
    await checker.setNoveltyWeightedCounts(multisig.address, 11n);
    await router.setEvaluationDeliveryCount(multisig.address, 3n);

    await expect(emitter.connect(claimer).emitClaim(SERVICE_ID))
      .to.emit(emitter, 'ClaimTicket')
      .withArgs(1n, SERVICE_ID, 7n, 11n, 3n, multisig.address, claimer.address);

    expect(await emitter.nextClaimId()).to.equal(1n);
    expect(await emitter.claimSnapshotHashes(1n)).to.equal(
      expectedSnapshotHash({
        claimId: 1n,
        serviceId: SERVICE_ID,
        verifiedCreations: 7n,
        novelty: 11n,
        evalDelivery: 3n,
        multisig: multisig.address,
      }),
    );
  });

  it('reads zero counters when nothing has been set', async function () {
    await registry.setMultisig(SERVICE_ID, multisig.address);

    await expect(emitter.connect(claimer).emitClaim(SERVICE_ID))
      .to.emit(emitter, 'ClaimTicket')
      .withArgs(1n, SERVICE_ID, 0n, 0n, 0n, multisig.address, claimer.address);
  });

  it('reflects subsequent counter updates on re-emit', async function () {
    await registry.setMultisig(SERVICE_ID, multisig.address);
    await checker.setVerifiedCreations(multisig.address, 1n);
    await emitter.connect(claimer).emitClaim(SERVICE_ID);

    await checker.setVerifiedCreations(multisig.address, 5n);
    await checker.setNoveltyWeightedCounts(multisig.address, 9n);
    await router.setEvaluationDeliveryCount(multisig.address, 4n);

    await expect(emitter.connect(claimer).emitClaim(SERVICE_ID))
      .to.emit(emitter, 'ClaimTicket')
      .withArgs(2n, SERVICE_ID, 5n, 9n, 4n, multisig.address, claimer.address);
    expect(await emitter.nextClaimId()).to.equal(2n);
  });

  it('reverts on unknown serviceId (multisig=0)', async function () {
    await expect(emitter.connect(claimer).emitClaim(999n)).to.be.revertedWith(
      'JinnClaimEmitter: unknown service',
    );
  });

  it('is permissionless — any caller can emit', async function () {
    await registry.setMultisig(SERVICE_ID, multisig.address);
    await checker.setVerifiedCreations(multisig.address, 2n);

    await expect(emitter.connect(owner).emitClaim(SERVICE_ID))
      .to.emit(emitter, 'ClaimTicket')
      .withArgs(1n, SERVICE_ID, 2n, 0n, 0n, multisig.address, owner.address);
    await expect(emitter.connect(claimer).emitClaim(SERVICE_ID))
      .to.emit(emitter, 'ClaimTicket')
      .withArgs(2n, SERVICE_ID, 2n, 0n, 0n, multisig.address, claimer.address);
  });
});
