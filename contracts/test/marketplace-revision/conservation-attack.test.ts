import { expect } from "chai";
import { network } from "hardhat";

/**
 * Critical 1 proof: prepare+Mech-deliver without router claim cannot restore budget
 * via release/reap/close; sibling task escrow stays fully recoverable; undelivered
 * prepare still releases/refunds. Per-task exact conservation — no shared-pool stealing.
 */
describe("marketplace-revision conservation-attack", function () {
  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];
  let provider: Awaited<ReturnType<typeof network.connect>>["provider"];

  const TOKEN_PAYMENT_TYPE =
    "0x3679d66ef546e66ce9057c4a052f317b135bc8e8c509638f7966edfd4fcf45e9";
  const RELEASE_MIN_HOLD = 60n;
  const RESPONSE_TIMEOUT = 3600n;

  let SOLUTION_DIGEST: string;

  before(async () => {
    ({ ethers, provider } = await network.connect());
    SOLUTION_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("solution-sha256"));
  });

  async function increaseTime(seconds: number | bigint) {
    await provider.send("evm_increaseTime", [Number(seconds)]);
    await provider.send("evm_mine", []);
  }

  function policy(overrides: Record<string, unknown> = {}) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const base = {
      maxTotal: 1,
      maxConcurrent: 1,
      submissionDeadline: now + 86_400n,
      closeAt: 0n,
      responseTimeout: RESPONSE_TIMEOUT,
      minVerdicts: 1,
      requireDistinctEvaluator: true,
      ...overrides,
    };
    if (Number(base.maxConcurrent) > Number(base.maxTotal)) {
      base.maxConcurrent = base.maxTotal;
    }
    return base;
  }

  async function deploy(solutionRate = 100n, verdictRate = 20n) {
    const [owner, creator, solver, evaluator, other] = await ethers.getSigners();
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
    const solverMech = await Mech.deploy(
      solutionRate,
      TOKEN_PAYMENT_TYPE,
      await solver.getAddress(),
      await marketplace.getAddress(),
    );
    await solverMech.waitForDeployment();
    await marketplace.registerMech(await solverMech.getAddress(), await owner.getAddress());

    const RequestData = await ethers.getContractFactory("MarketplaceRequestDataView");
    const requestDataView = await RequestData.deploy();
    await requestDataView.waitForDeployment();

    return {
      owner,
      creator,
      solver,
      evaluator,
      other,
      olas,
      marketplace,
      tracker,
      coordinator,
      router,
      solverMech,
      requestDataView,
      solutionRate,
      verdictRate,
    };
  }

  async function createTask(ctx: Awaited<ReturnType<typeof deploy>>, p = policy()) {
    const amount = ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    const tx = await ctx.router
      .connect(ctx.creator)
      .createTask(
        ethers.keccak256(ethers.toUtf8Bytes(`task-${Date.now()}-${Math.random()}`)),
        ethers.keccak256(ethers.toUtf8Bytes("sub")),
        p,
        ctx.solutionRate,
        ctx.verdictRate,
      );
    const receipt = await tx.wait();
    const parsed = receipt!.logs
      .map((log: any) => {
        try {
          return ctx.router.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e: any) => e?.name === "TaskCreated");
    return { taskId: Number(parsed!.args.taskId), amount, policy: p };
  }

  async function prepareAndMechDeliverOnly(ctx: Awaited<ReturnType<typeof deploy>>, taskId: number) {
    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST);
    const requestData = await ctx.requestDataView.encodeSolution(taskId, 0, SOLUTION_DIGEST);
    const nonce = await ctx.marketplace.mapNonces(await ctx.router.getAddress());
    // After prepare, nonce advanced? No — prepare only reads nonce; deliver advances it.
    const prep = await ctx.router.solutionPreparations(taskId, 0);
    expect(prep.prepared).to.equal(true);
    const boundNonce = prep.preparedNonce;
    const mech = await ctx.solverMech.getAddress();
    const signature = await ctx.router.encodeAuthSignature(
      1,
      taskId,
      0,
      0,
      mech,
      requestData,
      ctx.solutionRate,
      boundNonce,
    );
    await ctx.solverMech
      .connect(ctx.solver)
      .deliverMarketplaceWithSignatures(
        await ctx.router.getAddress(),
        [{ requestData, signature, deliveryData: "0x01" }],
        [ctx.solutionRate],
        "0x",
      );
    return { requestData, boundNonce, expectedRequestId: prep.expectedRequestId as string };
  }

  it("prepare+Mech-deliver without claim: release/reap/close cannot restore rate; task B fully recoverable", async function () {
    const ctx = await deploy();
    const taskA = await createTask(ctx, policy({ maxTotal: 1 }));
    const taskB = await createTask(ctx, policy({ maxTotal: 1 }));

    await ctx.router.connect(ctx.solver).claimTask(taskA.taskId, await ctx.solverMech.getAddress());
    await prepareAndMechDeliverOnly(ctx, taskA.taskId);

    expect(await ctx.olas.balanceOf(await ctx.tracker.getAddress())).to.equal(ctx.solutionRate);
    let paymentA = await ctx.router.taskPayments(taskA.taskId);
    expect(paymentA.solutionReserved).to.equal(ctx.solutionRate);
    expect(paymentA.solutionBudgetRemaining).to.equal(0n);
    expect(paymentA.solutionSpentOut).to.equal(0n);

    await increaseTime(RELEASE_MIN_HOLD);
    await expect(ctx.router.connect(ctx.solver).releaseAttempt(taskA.taskId, 0)).to.be.revertedWithCustomError(
      ctx.router,
      "RouterV4PreparationDelivered",
    );

    await increaseTime(RESPONSE_TIMEOUT + 1n);
    // Lazy reap via close must not restore delivered reservation into remaining.
    await ctx.router.connect(ctx.creator).closeTask(taskA.taskId);
    paymentA = await ctx.router.taskPayments(taskA.taskId);
    expect(paymentA.solutionReserved).to.equal(ctx.solutionRate);
    expect(paymentA.solutionBudgetRemaining).to.equal(0n);
    // Verdict budget (unreserved) may refund on close — solution reserved must stay out.
    expect(paymentA.solutionSpentOut).to.equal(0n);

    // Task B escrow remains fully recoverable (no shared-pool steal from A).
    const creatorBefore = await ctx.olas.balanceOf(await ctx.creator.getAddress());
    await ctx.router.connect(ctx.creator).closeTask(taskB.taskId);
    const creatorAfter = await ctx.olas.balanceOf(await ctx.creator.getAddress());
    expect(creatorAfter - creatorBefore).to.equal(taskB.amount);

    // Forfeit clears accounting without protocol credit.
    await expect(
      ctx.router
        .connect(ctx.solver)
        .forfeitDeliveredReservation(taskA.taskId, 0, 0, 1),
    ).to.emit(ctx.router, "ReservationForfeited");
    paymentA = await ctx.router.taskPayments(taskA.taskId);
    expect(paymentA.solutionReserved).to.equal(0n);
    expect(paymentA.solutionSpentOut).to.equal(ctx.solutionRate);
  });

  it("undelivered prepare still releases and refunds on close", async function () {
    const ctx = await deploy();
    const { taskId, amount } = await createTask(ctx);
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST);

    await increaseTime(RELEASE_MIN_HOLD);
    await expect(ctx.router.connect(ctx.solver).releaseAttempt(taskId, 0)).to.emit(ctx.router, "AttemptReleased");

    const payment = await ctx.router.taskPayments(taskId);
    expect(payment.solutionReserved).to.equal(0n);
    expect(payment.solutionBudgetRemaining).to.equal(ctx.solutionRate);
    expect(payment.solutionSpentOut).to.equal(0n);
    const prep = await ctx.router.solutionPreparations(taskId, 0);
    expect(prep.prepared).to.equal(false);

    const creatorBefore = await ctx.olas.balanceOf(await ctx.creator.getAddress());
    await ctx.router.connect(ctx.creator).closeTask(taskId);
    const creatorAfter = await ctx.olas.balanceOf(await ctx.creator.getAddress());
    expect(creatorAfter - creatorBefore).to.equal(amount);
  });

  it("per-task conservation: escrowed equals remaining + reserved + spentOut across settle", async function () {
    const ctx = await deploy();
    const { taskId, amount } = await createTask(ctx, policy({ maxTotal: 1 }));
    const escrowed = async () => {
      const p = await ctx.router.taskPayments(taskId);
      return p.solutionBudgetRemaining + p.verdictBudgetRemaining + p.solutionReserved + p.verdictReserved
        + p.solutionSpentOut + p.verdictSpentOut;
    };
    expect(await escrowed()).to.equal(amount);

    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    expect(await escrowed()).to.equal(amount);

    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST);
    const requestData = await ctx.requestDataView.encodeSolution(taskId, 0, SOLUTION_DIGEST);
    const prep = await ctx.router.solutionPreparations(taskId, 0);
    const signature = await ctx.router.encodeAuthSignature(
      1,
      taskId,
      0,
      0,
      await ctx.solverMech.getAddress(),
      requestData,
      ctx.solutionRate,
      prep.preparedNonce,
    );
    await ctx.solverMech
      .connect(ctx.solver)
      .deliverMarketplaceWithSignatures(
        await ctx.router.getAddress(),
        [{ requestData, signature, deliveryData: "0x01" }],
        [ctx.solutionRate],
        "0x",
      );
    // Tokens left router but reserved still counts until claim.
    expect(await escrowed()).to.equal(amount);

    await ctx.router
      .connect(ctx.solver)
      .claimSolutionDelivery(
        await ctx.solverMech.getAddress(),
        requestData,
        ctx.solutionRate,
        TOKEN_PAYMENT_TYPE,
        prep.preparedNonce,
      );
    expect(await escrowed()).to.equal(amount);
    const p = await ctx.router.taskPayments(taskId);
    expect(p.solutionSpentOut).to.equal(ctx.solutionRate);
    expect(p.solutionReserved).to.equal(0n);
  });
});
