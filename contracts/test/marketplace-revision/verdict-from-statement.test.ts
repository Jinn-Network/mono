import { expect } from "chai";
import { network } from "hardhat";

/**
 * Critical 2: on-chain (taskId, attemptIndex, verdictIndex, deliveryDigest, verdictCode)
 * tuple is immutable once prepared/delivered; claim cannot choose code freely.
 * Off-chain semantic comparison to signed JSON remains the adapter's decision-grade gate.
 */
describe("marketplace-revision verdict-from-statement", function () {
  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];

  const TOKEN_PAYMENT_TYPE =
    "0x3679d66ef546e66ce9057c4a052f317b135bc8e8c509638f7966edfd4fcf45e9";
  const RELEASE_MIN_HOLD = 60n;

  before(async () => {
    ({ ethers } = await network.connect());
  });

  it("on-chain prepared verdict tuple is immutable through claim; code comes from requestData", async function () {
    const [owner, creator, solver, evaluator] = await ethers.getSigners();
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
    await coordinator.initialize(await owner.getAddress(), await router.getAddress(), RELEASE_MIN_HOLD, 0);
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
    const solverMech = await Mech.deploy(100n, TOKEN_PAYMENT_TYPE, await solver.getAddress(), await marketplace.getAddress());
    const evaluatorMech = await Mech.deploy(
      20n,
      TOKEN_PAYMENT_TYPE,
      await evaluator.getAddress(),
      await marketplace.getAddress(),
    );
    await solverMech.waitForDeployment();
    await evaluatorMech.waitForDeployment();
    await marketplace.registerMech(await solverMech.getAddress(), await owner.getAddress());
    await marketplace.registerMech(await evaluatorMech.getAddress(), await owner.getAddress());

    const RequestData = await ethers.getContractFactory("MarketplaceRequestDataView");
    const requestDataView = await RequestData.deploy();
    await requestDataView.waitForDeployment();

    const now = BigInt(Math.floor(Date.now() / 1000));
    const policy = {
      maxTotal: 1,
      maxConcurrent: 1,
      submissionDeadline: now + 86_400n,
      closeAt: 0n,
      responseTimeout: 3600n,
      minVerdicts: 1,
      requireDistinctEvaluator: true,
    };
    const amount = 100n + 20n;
    await olas.mint(await creator.getAddress(), amount);
    await olas.connect(creator).approve(await router.getAddress(), amount);
    await router.connect(creator).createTask(ethers.id("stmt-task"), ethers.id("stmt-sub"), policy, 100n, 20n);
    const taskId = Number(await coordinator.nextTaskId()) - 1;

    const solutionDigest = ethers.id("solution-from-statement");
    await router.connect(solver).claimTask(taskId, await solverMech.getAddress());
    await router.connect(solver).prepareSolutionDelivery(taskId, 0, solutionDigest);
    let requestData = await requestDataView.encodeSolution(taskId, 0, solutionDigest);
    let prep = await router.solutionPreparations(taskId, 0);
    let sig = await router.encodeAuthSignature(
      1,
      taskId,
      0,
      0,
      await solverMech.getAddress(),
      requestData,
      100n,
      prep.preparedNonce,
    );
    await solverMech
      .connect(solver)
      .deliverMarketplaceWithSignatures(
        await router.getAddress(),
        [{ requestData, signature: sig, deliveryData: "0x" }],
        [100n],
        "0x",
      );
    await router
      .connect(solver)
      .claimSolutionDelivery(
        await solverMech.getAddress(),
        requestData,
        100n,
        TOKEN_PAYMENT_TYPE,
        prep.preparedNonce,
      );

    // Statement-derived verdict: digest + code frozen at prepare
    const verdictDigest = ethers.id('{"pass":true,"code":3}');
    const verdictCode = 3;
    await router.connect(evaluator).claimEvaluation(taskId, 0, await evaluatorMech.getAddress());
    await router
      .connect(evaluator)
      .prepareVerdictDelivery(taskId, 0, 0, verdictDigest, verdictCode);

    const stored = await router.verdictPreparations(taskId, 0, 0);
    expect(stored.deliveryDigest).to.equal(verdictDigest);
    expect(stored.verdictCode).to.equal(verdictCode);

    requestData = await requestDataView.encodeVerdict(taskId, 0, 0, verdictDigest, verdictCode);
    const decoded = await requestDataView.decode(requestData);
    expect(decoded.deliveryDigest).to.equal(verdictDigest);
    expect(decoded.verdictCode).to.equal(BigInt(verdictCode));
    expect(decoded.taskId).to.equal(BigInt(taskId));
    expect(decoded.attemptIndex).to.equal(0n);
    expect(decoded.verdictIndex).to.equal(0n);

    prep = await router.verdictPreparations(taskId, 0, 0);
    sig = await router.encodeAuthSignature(
      2,
      taskId,
      0,
      0,
      await evaluatorMech.getAddress(),
      requestData,
      20n,
      prep.preparedNonce,
    );
    await evaluatorMech
      .connect(evaluator)
      .deliverMarketplaceWithSignatures(
        await router.getAddress(),
        [{ requestData, signature: sig, deliveryData: "0x" }],
        [20n],
        "0x",
      );

    await expect(
      router
        .connect(evaluator)
        .claimVerdictDelivery(
          await evaluatorMech.getAddress(),
          requestData,
          20n,
          TOKEN_PAYMENT_TYPE,
          prep.preparedNonce,
        ),
    )
      .to.emit(router, "VerdictDeliveryClaimed")
      .withArgs(
        await evaluator.getAddress(),
        prep.expectedRequestId,
        verdictDigest,
        taskId,
        0,
        0,
        verdictCode,
      );

    const verdict = await coordinator.getVerdict(taskId, 0, 0);
    expect(verdict.evaluationDeliveryDigest).to.equal(verdictDigest);
    expect(verdict.verdictCode).to.equal(verdictCode);
  });
});
