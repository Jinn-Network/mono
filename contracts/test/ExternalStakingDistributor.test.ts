import { expect } from 'chai';
import { network } from 'hardhat';

describe('ExternalStakingDistributor reStake access', function () {
  const SERVICE_ID = 42n;

  let ethers: Awaited<ReturnType<typeof network.connect>>['ethers'];
  before(async () => {
    ({ ethers } = await network.connect());
  });

  let distributor: any;
  let staking: any;
  let registry: any;
  let owner: any;
  let operator: any;
  let managingAgent: any;
  let unrelated: any;

  beforeEach(async function () {
    [owner, operator, managingAgent, unrelated] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory('MockServiceRegistryNft');
    registry = await Registry.deploy();
    await registry.waitForDeployment();

    const ServiceManager = await ethers.getContractFactory('MockStolasServiceManager');
    const serviceManager = await ServiceManager.deploy(await registry.getAddress(), unrelated.address);
    await serviceManager.waitForDeployment();

    const SafeWithRecovery = await ethers.getContractFactory('MockSafeMultisigWithRecoveryModule');
    const safeWithRecovery = await SafeWithRecovery.deploy(unrelated.address);
    await safeWithRecovery.waitForDeployment();

    const Token = await ethers.getContractFactory('TestERC20');
    const token = await Token.deploy('OLAS', 'OLAS');
    await token.waitForDeployment();

    const Harness = await ethers.getContractFactory('ExternalStakingDistributorHarness');
    distributor = await Harness.deploy(
      await token.getAddress(),
      await serviceManager.getAddress(),
      await safeWithRecovery.getAddress(),
      unrelated.address,
      unrelated.address,
      unrelated.address,
      unrelated.address,
    );
    await distributor.waitForDeployment();
    await distributor.initialize();

    const Staking = await ethers.getContractFactory('MockStolasStaking');
    staking = await Staking.deploy();
    await staking.waitForDeployment();

    await distributor.setServiceCuratingAgent(SERVICE_ID, operator.address);
  });

  async function expectRestakeSucceeds(signer: any) {
    await staking.setState(2);

    await expect(distributor.connect(signer).reStake(await staking.getAddress(), SERVICE_ID))
      .to.emit(distributor, 'ExternalServiceRestaked')
      .withArgs(signer.address, await staking.getAddress(), SERVICE_ID);

    expect(await staking.unstakeCalls()).to.equal(1n);
    expect(await staking.stakeCalls()).to.equal(1n);
    expect(await staking.lastStakedServiceId()).to.equal(SERVICE_ID);
    expect(await registry.approvals(SERVICE_ID)).to.equal(await staking.getAddress());
  }

  it('allows the recorded service operator to restake their evicted service', async function () {
    await expectRestakeSucceeds(operator);
  });

  it('rejects an unrelated caller', async function () {
    await expect(distributor.connect(unrelated).reStake(await staking.getAddress(), SERVICE_ID))
      .to.be.revertedWithCustomError(distributor, 'UnauthorizedAccount')
      .withArgs(unrelated.address);
  });

  it('allows the owner as an admin backstop', async function () {
    await expectRestakeSucceeds(owner);
  });

  it('allows a managing agent as an admin backstop', async function () {
    await distributor.setManagingAgents([managingAgent.address], [true]);
    await expectRestakeSucceeds(managingAgent);
  });

  it('rejects non-evicted services', async function () {
    await staking.setState(1);

    await expect(distributor.connect(operator).reStake(await staking.getAddress(), SERVICE_ID))
      .to.be.revertedWithCustomError(distributor, 'ZeroValue');
  });
});
