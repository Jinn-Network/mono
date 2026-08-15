import { expect } from "chai";
import { network } from "hardhat";

/**
 * Round-2: forfeit must clear coordinator Live occupancy / operator caps immediately,
 * without budget restore, activity credit, or later double-decrement.
 */
describe("marketplace-revision forfeit-occupancy", function () {
  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];
  let provider: Awaited<ReturnType<typeof network.connect>>["provider"];

  const TOKEN_PAYMENT_TYPE =
    "0x3679d66ef546e66ce9057c4a052f317b135bc8e8c509638f7966edfd4fcf45e9";
  const RELEASE_MIN_HOLD = 60n;
  const RESPONSE_TIMEOUT = 3600n;
  const OPERATOR_CAP = 1;

  let SOLUTION_DIGEST: string;
  let VERDICT_DIGEST: string;

  // AttemptStatus.Forfeited / VerdictStatus.Forfeited once added to coordinator.
  const ATTEMPT_FORFEITED = 6n;
  const VERDICT_FORFEITED = 5n;

  before(async () => {
    ({ ethers, provider } = await network.connect());
    SOLUTION_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("solution-forfeit"));
    VERDICT_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("verdict-forfeit"));
  });

  async function increaseTime(seconds: number | bigint) {
    await provider.send("evm_increaseTime", [Number(seconds)]);
    await provider.send("evm_mine", []);
  }

  function policy(overrides: Record<string, unknown> = {}) {
    const now = BigInt(Math.floor(Date.now() / 1000)) + 10_000n;
    const base = {
      maxTotal: 2,
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

  async function deploy(solutionRate = 100n, verdictRate = 20n, operatorCap = OPERATOR_CAP) {
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

    const Activity = await ethers.getContractFactory("MockTaskActivityChecker");
    const activity = await Activity.deploy();
    await activity.waitForDeployment();

    const Coordinator = await ethers.getContractFactory("TaskCoordinatorV4");
    const Router = await ethers.getContractFactory("JinnRouterV4");
    const coordinator = await Coordinator.deploy();
    const router = await Router.deploy();
    await coordinator.waitForDeployment();
    await router.waitForDeployment();
    await coordinator.initialize(
      await owner.getAddress(),
      await router.getAddress(),
      RELEASE_MIN_HOLD,
      operatorCap,
    );
    await router.initialize(
      await owner.getAddress(),
      await marketplace.getAddress(),
      await coordinator.getAddress(),
      await activity.getAddress(),
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
    const evaluatorMech = await Mech.deploy(
      verdictRate,
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

    return {
      owner,
      creator,
      solver,
      evaluator,
      other,
      olas,
      marketplace,
      tracker,
      activity,
      coordinator,
      router,
      solverMech,
      evaluatorMech,
      requestDataView,
      solutionRate,
      verdictRate,
    };
  }

  async function createTask(ctx: Awaited<ReturnType<typeof deploy>>, p = policy()) {
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id(`forfeit-${Math.random()}`), ethers.id("sub"), p, ctx.solutionRate, ctx.verdictRate);
    return {
      taskId: Number(await ctx.coordinator.nextTaskId()) - 1,
      amount,
      policy: p,
    };
  }

  async function prepareAndMechDeliverSolution(
    ctx: Awaited<ReturnType<typeof deploy>>,
    taskId: number,
    attemptIndex = 0,
    digest = SOLUTION_DIGEST,
  ) {
    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, attemptIndex, digest);
    const requestData = await ctx.requestDataView.encodeSolution(taskId, attemptIndex, digest);
    const prep = await ctx.router.solutionPreparations(taskId, attemptIndex);
    const mech = await ctx.solverMech.getAddress();
    const signature = await ctx.router.encodeAuthSignature(
      1,
      taskId,
      attemptIndex,
      0,
      mech,
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
    return { requestData, prep };
  }

  async function settleSolution(
    ctx: Awaited<ReturnType<typeof deploy>>,
    taskId: number,
    attemptIndex = 0,
  ) {
    const { requestData, prep } = await prepareAndMechDeliverSolution(ctx, taskId, attemptIndex);
    await ctx.router
      .connect(ctx.solver)
      .claimSolutionDelivery(
        await ctx.solverMech.getAddress(),
        requestData,
        ctx.solutionRate,
        TOKEN_PAYMENT_TYPE,
        prep.preparedNonce,
      );
  }

  async function prepareAndMechDeliverVerdict(
    ctx: Awaited<ReturnType<typeof deploy>>,
    taskId: number,
    attemptIndex: number,
    verdictIndex: number,
    verdictCode = 1,
  ) {
    await ctx.router
      .connect(ctx.evaluator)
      .prepareVerdictDelivery(taskId, attemptIndex, verdictIndex, VERDICT_DIGEST, verdictCode);
    const requestData = await ctx.requestDataView.encodeVerdict(
      taskId,
      attemptIndex,
      verdictIndex,
      VERDICT_DIGEST,
      verdictCode,
    );
    const prep = await ctx.router.verdictPreparations(taskId, attemptIndex, verdictIndex);
    const mech = await ctx.evaluatorMech.getAddress();
    const signature = await ctx.router.encodeAuthSignature(
      2,
      taskId,
      attemptIndex,
      verdictIndex,
      mech,
      requestData,
      ctx.verdictRate,
      prep.preparedNonce,
    );
    await ctx.evaluatorMech
      .connect(ctx.evaluator)
      .deliverMarketplaceWithSignatures(
        await ctx.router.getAddress(),
        [{ requestData, signature, deliveryData: "0x01" }],
        [ctx.verdictRate],
        "0x",
      );
    return { requestData, prep };
  }

  it("solution forfeit clears occupancy and operator cap before deadline; no credit/restore; replacement proceeds", async function () {
    const ctx = await deploy();
    const { taskId } = await createTask(ctx, policy({ maxConcurrent: 1, maxTotal: 2 }));

    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    expect((await ctx.coordinator.getTask(taskId)).liveOccupancy).to.equal(1n);
    expect(await ctx.coordinator.operatorLiveClaims(await ctx.solver.getAddress())).to.equal(1n);

    // Cap blocks a second simultaneous claim by the same operator.
    await expect(ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress())).to.revert(
      ethers,
    );

    await prepareAndMechDeliverSolution(ctx, taskId, 0);
    const activityBefore = await ctx.activity.solutionDeliveryWeight(await ctx.solver.getAddress());

    await expect(ctx.router.connect(ctx.solver).forfeitDeliveredReservation(taskId, 0, 0, 1))
      .to.emit(ctx.router, "ReservationForfeited")
      .and.to.emit(ctx.coordinator, "AttemptForfeited");

    const attempt = await ctx.coordinator.getAttempt(taskId, 0);
    expect(attempt.status).to.equal(ATTEMPT_FORFEITED);
    expect((await ctx.coordinator.getTask(taskId)).liveOccupancy).to.equal(0n);
    expect(await ctx.coordinator.operatorLiveClaims(await ctx.solver.getAddress())).to.equal(0n);

    const payment = await ctx.router.taskPayments(taskId);
    expect(payment.solutionReserved).to.equal(0n);
    expect(payment.solutionSpentOut).to.equal(ctx.solutionRate);
    expect(payment.solutionBudgetRemaining).to.equal(ctx.solutionRate); // maxTotal=2, one spentOut
    expect(await ctx.activity.solutionDeliveryWeight(await ctx.solver.getAddress())).to.equal(activityBefore);

    // Replacement claim proceeds immediately (before deadline) under ordinary index/cap rules.
    await expect(ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress())).to.emit(
      ctx.router,
      "TaskAttemptCreated",
    );
    expect((await ctx.coordinator.getAttempt(taskId, 1)).attemptIndex).to.equal(1n);
    expect((await ctx.coordinator.getAttempt(taskId, 1)).status).to.equal(1n); // Live
  });

  it("solution forfeit rejects replay/release and does not double-decrement on later reap", async function () {
    const ctx = await deploy();
    const { taskId } = await createTask(ctx, policy({ maxConcurrent: 1, maxTotal: 2 }));
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await prepareAndMechDeliverSolution(ctx, taskId, 0);
    await ctx.router.connect(ctx.solver).forfeitDeliveredReservation(taskId, 0, 0, 1);

    await expect(
      ctx.router.connect(ctx.solver).forfeitDeliveredReservation(taskId, 0, 0, 1),
    ).to.be.revertedWithCustomError(ctx.router, "RouterV4ReservationNotLive");

    await expect(ctx.router.connect(ctx.solver).releaseAttempt(taskId, 0)).to.revert(ethers);

    // Unauthorized direct coordinator call fails.
    await expect(ctx.coordinator.connect(ctx.solver).forfeitAttempt(taskId, 0)).to.be.revertedWithCustomError(
      ctx.coordinator,
      "TCV4RouterOnly",
    );

    const occBefore = (await ctx.coordinator.getTask(taskId)).liveOccupancy;
    const opBefore = await ctx.coordinator.operatorLiveClaims(await ctx.solver.getAddress());
    await increaseTime(RESPONSE_TIMEOUT + 1n);
    // Trigger lazy reap via a no-op path that calls _reap (claim on another funded slot after reclaim).
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    // liveOccupancy should be 1 (new claim only) — not underflow / not double-decrement from forfeited #0
    expect((await ctx.coordinator.getTask(taskId)).liveOccupancy).to.equal(1n);
    expect(await ctx.coordinator.operatorLiveClaims(await ctx.solver.getAddress())).to.equal(1n);
    expect(occBefore).to.equal(0n);
    expect(opBefore).to.equal(0n);
    expect((await ctx.coordinator.getAttempt(taskId, 0)).status).to.equal(ATTEMPT_FORFEITED);
  });

  it("verdict forfeit is terminal without credit/restore; replacement evaluation can proceed when funded", async function () {
    const ctx = await deploy();
    const { taskId } = await createTask(ctx, policy({ maxTotal: 1, maxConcurrent: 1, minVerdicts: 1 }));
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await settleSolution(ctx, taskId, 0);

    await ctx.router.connect(ctx.evaluator).claimEvaluation(taskId, 0, await ctx.evaluatorMech.getAddress());
    await prepareAndMechDeliverVerdict(ctx, taskId, 0, 0, 1);
    const activityBefore = await ctx.activity.verdictDeliveryWeight(await ctx.evaluator.getAddress());
    const paymentBefore = await ctx.router.taskPayments(taskId);

    await expect(ctx.router.connect(ctx.evaluator).forfeitDeliveredReservation(taskId, 0, 0, 2))
      .to.emit(ctx.router, "ReservationForfeited")
      .and.to.emit(ctx.coordinator, "VerdictForfeited");

    const verdict = await ctx.coordinator.getVerdict(taskId, 0, 0);
    expect(verdict.status).to.equal(VERDICT_FORFEITED);

    const payment = await ctx.router.taskPayments(taskId);
    expect(payment.verdictReserved).to.equal(0n);
    expect(payment.verdictSpentOut).to.equal(ctx.verdictRate);
    expect(payment.verdictBudgetRemaining).to.equal(0n); // maxTotal=1,minVerdicts=1 — fully spentOut
    expect(await ctx.activity.verdictDeliveryWeight(await ctx.evaluator.getAddress())).to.equal(activityBefore);
    // No budget restore relative to pre-forfeit remaining
    expect(payment.verdictBudgetRemaining).to.equal(paymentBefore.verdictBudgetRemaining);

    // Replay / release / unauthorized coordinator
    await expect(
      ctx.router.connect(ctx.evaluator).forfeitDeliveredReservation(taskId, 0, 0, 2),
    ).to.be.revertedWithCustomError(ctx.router, "RouterV4ReservationNotLive");
    await expect(ctx.router.connect(ctx.evaluator).releaseVerdict(taskId, 0, 0)).to.revert(ethers);
    await expect(
      ctx.coordinator.connect(ctx.evaluator).forfeitVerdict(taskId, 0, 0),
    ).to.be.revertedWithCustomError(ctx.coordinator, "TCV4RouterOnly");

    // Fund a replacement evaluation slot via addAttempts top-up, then claim new verdict index.
    const topUp = ctx.solutionRate * 1n + ctx.verdictRate * 1n * 1n;
    await ctx.olas.mint(await ctx.creator.getAddress(), topUp);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), topUp);
    // Task already has settled solution; addAttempts grows maxTotal for more solution+verdict budget.
    // For verdict-only replacement on same submitted attempt, top up by creating remaining budget:
    // With maxTotal=1 the verdict budget is exhausted via spentOut. Top-up via addAttempts.
    await ctx.router.connect(ctx.creator).addAttempts(taskId, 1);
    // Claim a new evaluation on the same submitted attempt (nextVerdictIndex=1).
    await expect(
      ctx.router.connect(ctx.evaluator).claimEvaluation(taskId, 0, await ctx.evaluatorMech.getAddress()),
    ).to.emit(ctx.router, "EvaluationAttemptCreated");
    expect((await ctx.coordinator.getVerdict(taskId, 0, 1)).status).to.equal(1n); // Live
    expect((await ctx.coordinator.getVerdict(taskId, 0, 0)).status).to.equal(VERDICT_FORFEITED);
  });

  it("solution forfeit after deadline reap clears accounting without double-decrement", async function () {
    const ctx = await deploy();
    const { taskId } = await createTask(ctx, policy({ maxConcurrent: 1, maxTotal: 2 }));
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await prepareAndMechDeliverSolution(ctx, taskId, 0);

    await increaseTime(RESPONSE_TIMEOUT + 1n);
    // Lazy reap via close of a sibling path: touch router close on a second task, or claim path.
    // Force reap by attempting a claim (will reap expired Live→Expired and free occupancy).
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    expect((await ctx.coordinator.getAttempt(taskId, 0)).status).to.equal(4n); // Expired
    expect((await ctx.coordinator.getTask(taskId)).liveOccupancy).to.equal(1n); // only new claim

    // Release the replacement so we can forfeit the delivered-unclaimed #0 in isolation.
    await increaseTime(RELEASE_MIN_HOLD);
    await ctx.router.connect(ctx.solver).releaseAttempt(taskId, 1);
    expect((await ctx.coordinator.getTask(taskId)).liveOccupancy).to.equal(0n);
    expect(await ctx.coordinator.operatorLiveClaims(await ctx.solver.getAddress())).to.equal(0n);

    await expect(ctx.router.connect(ctx.solver).forfeitDeliveredReservation(taskId, 0, 0, 1)).to.emit(
      ctx.coordinator,
      "AttemptForfeited",
    );
    expect((await ctx.coordinator.getAttempt(taskId, 0)).status).to.equal(ATTEMPT_FORFEITED);
    expect((await ctx.coordinator.getTask(taskId)).liveOccupancy).to.equal(0n);
    expect(await ctx.coordinator.operatorLiveClaims(await ctx.solver.getAddress())).to.equal(0n);
    const payment = await ctx.router.taskPayments(taskId);
    expect(payment.solutionSpentOut).to.equal(ctx.solutionRate);
    expect(payment.solutionReserved).to.equal(0n);
  });

  it("rejects cross-kind and cross-attempt forfeit misuse", async function () {
    const ctx = await deploy(100n, 20n, 2);
    const { taskId } = await createTask(ctx, policy({ maxConcurrent: 2, maxTotal: 2 }));
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await prepareAndMechDeliverSolution(ctx, taskId, 0);

    // Cross-kind: solution prep delivered but forfeit as verdict
    await expect(
      ctx.router.connect(ctx.solver).forfeitDeliveredReservation(taskId, 0, 0, 2),
    ).to.be.revertedWithCustomError(ctx.router, "RouterV4ReservationNotLive");

    // Cross-attempt: attempt 1 not prepared/delivered
    await expect(
      ctx.router.connect(ctx.solver).forfeitDeliveredReservation(taskId, 1, 0, 1),
    ).to.be.revertedWithCustomError(ctx.router, "RouterV4NotPrepared");
  });
});
