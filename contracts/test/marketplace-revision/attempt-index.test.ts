import { expect } from "chai";
import { network } from "hardhat";

/**
 * Attempt-index split: monotonic identity never recycles; live occupancy is separate.
 * Covered in depth by escrow-lifecycle; this file pins the distinct-URI identity invariant.
 */
describe("marketplace-revision attempt-index", function () {
  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];
  let provider: Awaited<ReturnType<typeof network.connect>>["provider"];

  const TOKEN_PAYMENT_TYPE =
    "0x3679d66ef546e66ce9057c4a052f317b135bc8e8c509638f7966edfd4fcf45e9";

  before(async () => {
    ({ ethers, provider } = await network.connect());
  });

  it("claim→expire→reclaim never reuses attemptIndex", async function () {
    const [owner, creator, solver] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("TestERC20");
    const olas = await Token.deploy("OLAS", "OLAS");
    await olas.waitForDeployment();
    const Marketplace = await ethers.getContractFactory("MockTokenMarketplace");
    const marketplace = await Marketplace.deploy();
    await marketplace.waitForDeployment();
    const Tracker = await ethers.getContractFactory("MockTokenBalanceTracker");
    const tracker = await Tracker.deploy(await marketplace.getAddress(), await olas.getAddress());
    await tracker.waitForDeployment();
    await marketplace.setPaymentTypeBalanceTracker(TOKEN_PAYMENT_TYPE, await tracker.getAddress());

    const Coordinator = await ethers.getContractFactory("TaskCoordinatorV4");
    const Router = await ethers.getContractFactory("JinnRouterV4");
    const coordinator = await Coordinator.deploy();
    const router = await Router.deploy();
    await coordinator.waitForDeployment();
    await router.waitForDeployment();
    await coordinator.initialize(await owner.getAddress(), await router.getAddress(), 60n, 0);
    await router.initialize(
      await owner.getAddress(),
      await marketplace.getAddress(),
      await coordinator.getAddress(),
      ethers.ZeroAddress,
      await olas.getAddress(),
      TOKEN_PAYMENT_TYPE,
      await tracker.getAddress(),
    );

    const Mech = await ethers.getContractFactory("MockTokenMech");
    const mech = await Mech.deploy(10n, TOKEN_PAYMENT_TYPE, await solver.getAddress(), await marketplace.getAddress());
    await mech.waitForDeployment();
    await marketplace.registerMech(await mech.getAddress(), await owner.getAddress());

    const now = BigInt(Math.floor(Date.now() / 1000));
    const policy = {
      maxTotal: 2,
      maxConcurrent: 1,
      submissionDeadline: now + 86_400n,
      closeAt: 0n,
      responseTimeout: 100n,
      minVerdicts: 1,
      requireDistinctEvaluator: true,
    };
    const amount = 10n * 2n + 10n * 2n * 1n;
    // verdict rate also 10 for simplicity — create with solution=10 verdict=10
    await olas.mint(await creator.getAddress(), amount);
    await olas.connect(creator).approve(await router.getAddress(), amount);
    // Need matching rates on a verdict mech — use same rate
    await router.connect(creator).createTask(
      ethers.keccak256(ethers.toUtf8Bytes("t")),
      ethers.keccak256(ethers.toUtf8Bytes("s")),
      policy,
      10n,
      10n,
    );

    await router.connect(solver).claimTask(1, await mech.getAddress());
    expect((await coordinator.getAttempt(1, 0)).attemptIndex).to.equal(0n);
    await provider.send("evm_increaseTime", [101]);
    await provider.send("evm_mine", []);
    await router.connect(solver).claimTask(1, await mech.getAddress());
    expect((await coordinator.getAttempt(1, 0)).status).to.equal(4n); // Expired
    expect((await coordinator.getAttempt(1, 1)).attemptIndex).to.equal(1n);
  });
});
