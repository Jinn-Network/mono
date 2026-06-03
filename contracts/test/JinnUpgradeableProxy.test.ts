import { expect } from "chai";
import { network } from "hardhat";

describe("JinnUpgradeableProxy", function () {
  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];
  before(async () => {
    ({ ethers } = await network.connect());
  });

  it("initializes implementation behind proxy and upgrades by owner", async function () {
    const [owner, router, attacker] = await ethers.getSigners();
    const Coordinator = await ethers.getContractFactory("TaskCoordinator");
    const impl1 = await Coordinator.deploy();
    await impl1.waitForDeployment();

    const initData = impl1.interface.encodeFunctionData("initialize", [
      await owner.getAddress(),
      await router.getAddress(),
    ]);
    const Proxy = await ethers.getContractFactory("JinnUpgradeableProxy");
    const proxy = await Proxy.deploy(await impl1.getAddress(), await owner.getAddress(), initData);
    await proxy.waitForDeployment();

    const coordinator = await ethers.getContractAt("TaskCoordinator", await proxy.getAddress());
    expect(await coordinator.owner()).to.equal(await owner.getAddress());
    expect(await coordinator.authorizedRouter()).to.equal(await router.getAddress());

    const impl2 = await Coordinator.deploy();
    await impl2.waitForDeployment();
    await expect(proxy.connect(attacker).upgradeTo(await impl2.getAddress()))
      .to.be.revertedWithCustomError(proxy, "ProxyOwnerOnly");

    await expect(proxy.connect(owner).upgradeTo(await impl2.getAddress()))
      .to.emit(proxy, "Upgraded")
      .withArgs(await impl2.getAddress());
    expect(await proxy.getImplementation()).to.equal(await impl2.getAddress());
  });
});
