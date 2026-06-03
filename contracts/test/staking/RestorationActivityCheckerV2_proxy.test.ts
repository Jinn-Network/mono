import { expect } from "chai";
import { network } from "hardhat";
import type { Signer } from "ethers";

describe("RestorationActivityCheckerV2 — proxy upgrade pattern", function () {
  this.timeout(60_000);

  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];

  const LIVENESS_RATIO = 10n ** 15n;
  const SIM_THRESHOLD = 64n;
  const DECAY = 0n;
  const WINDOW = 20n;

  let deployer: Signer;
  let deployerAddress: string;

  before(async function () {
    ({ ethers } = await network.connect());
    [deployer] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
  });

  async function deployBehindProxy() {
    const Impl = await ethers.getContractFactory("RestorationActivityCheckerV2", deployer);
    const impl = await Impl.deploy();
    await impl.waitForDeployment();
    const initData = impl.interface.encodeFunctionData("initialize", [
      LIVENESS_RATIO,
      deployerAddress,
      SIM_THRESHOLD,
      DECAY,
      WINDOW,
    ]);
    const Proxy = await ethers.getContractFactory("src/vendor/stolas/Proxy.sol:Proxy", deployer);
    const proxy = await Proxy.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();
    const checker = Impl.attach(await proxy.getAddress());
    return { impl, proxy, checker };
  }

  it("deploys behind a proxy and forwards reads", async function () {
    const { checker } = await deployBehindProxy();
    expect(await checker.owner()).to.equal(deployerAddress);
    expect(await checker.livenessRatio()).to.equal(LIVENESS_RATIO);
    expect(await checker.similarityThreshold()).to.equal(SIM_THRESHOLD);
    expect(await checker.similarDecayMultiplier()).to.equal(DECAY);
    expect(await checker.comparisonWindow()).to.equal(WINDOW);
  });

  it("preserves storage when implementation is swapped", async function () {
    const { proxy, checker } = await deployBehindProxy();

    // Wire the deployer as the authorized router so we can write activity.
    await (await checker.setRouterAddresses(deployerAddress, deployerAddress)).wait();

    const multisig = ethers.Wallet.createRandom().address;
    await (await checker.recordActivity(multisig, 0)).wait();
    expect(await checker.activityCounts(multisig)).to.equal(1);
    expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1"));

    // Deploy a new implementation (same bytecode for this test — we only verify
    // that `changeImplementation` flips the slot and storage carries over).
    const Impl = await ethers.getContractFactory("RestorationActivityCheckerV2", deployer);
    const newImpl = await Impl.deploy();
    await newImpl.waitForDeployment();
    const newImplAddress = await newImpl.getAddress();

    await (await checker.changeImplementation(newImplAddress)).wait();

    // Proxy now points at new impl
    const proxyImpl = await proxy.getFunction("getImplementation").staticCall();
    expect(proxyImpl).to.equal(newImplAddress);

    // Storage preserved: same multisig still has the activity recorded
    expect(await checker.activityCounts(multisig)).to.equal(1);
    expect(await checker.noveltyWeightedCounts(multisig)).to.equal(ethers.parseEther("1"));
    expect(await checker.owner()).to.equal(deployerAddress);
    expect(await checker.livenessRatio()).to.equal(LIVENESS_RATIO);
  });

  it("rejects double-initialize", async function () {
    const { checker } = await deployBehindProxy();
    const Impl = await ethers.getContractFactory("RestorationActivityCheckerV2", deployer);
    await expect(
      checker.initialize(LIVENESS_RATIO, deployerAddress, SIM_THRESHOLD, DECAY, WINDOW)
    ).to.be.revertedWithCustomError(Impl, "AlreadyInitialized");
  });

  it("only owner can changeImplementation", async function () {
    const { proxy, checker } = await deployBehindProxy();
    const [, attacker] = await ethers.getSigners();
    const Impl = await ethers.getContractFactory("RestorationActivityCheckerV2", deployer);
    const newImpl = await Impl.deploy();
    await newImpl.waitForDeployment();

    await expect(
      checker.connect(attacker).changeImplementation(await newImpl.getAddress())
    ).to.be.revertedWithCustomError(Impl, "OwnerOnly");
  });
});
