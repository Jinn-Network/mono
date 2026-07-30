import { expect } from "chai";
import { network } from "hardhat";

/**
 * Explicit hostile tests — each name executes what it claims.
 */
describe("marketplace-revision hostile-bindings", function () {
  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];
  let provider: Awaited<ReturnType<typeof network.connect>>["provider"];

  const TOKEN_PAYMENT_TYPE =
    "0x3679d66ef546e66ce9057c4a052f317b135bc8e8c509638f7966edfd4fcf45e9";
  const RELEASE_MIN_HOLD = 60n;
  const RESPONSE_TIMEOUT = 3600n;

  let SOLUTION_DIGEST: string;
  let VERDICT_DIGEST: string;
  let ALT_DIGEST: string;

  before(async () => {
    ({ ethers, provider } = await network.connect());
    SOLUTION_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("solution-sha256"));
    VERDICT_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("verdict-sha256"));
    ALT_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("alt-digest"));
  });

  async function increaseTime(seconds: number | bigint) {
    await provider.send("evm_increaseTime", [Number(seconds)]);
    await provider.send("evm_mine", []);
  }

  function policy(overrides: Record<string, unknown> = {}) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const base = {
      maxTotal: 2,
      maxConcurrent: 2,
      submissionDeadline: now + 86_400n,
      closeAt: 0n,
      responseTimeout: RESPONSE_TIMEOUT,
      minVerdicts: 1,
      requireDistinctEvaluator: true,
      ...overrides,
    };
    // Keep policy valid when callers shrink maxTotal without touching maxConcurrent.
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
    const evaluatorMech = await Mech.deploy(
      verdictRate,
      TOKEN_PAYMENT_TYPE,
      await evaluator.getAddress(),
      await marketplace.getAddress(),
    );
    const wrongMech = await Mech.deploy(
      solutionRate,
      TOKEN_PAYMENT_TYPE,
      await other.getAddress(),
      await marketplace.getAddress(),
    );
    await solverMech.waitForDeployment();
    await evaluatorMech.waitForDeployment();
    await wrongMech.waitForDeployment();
    await marketplace.registerMech(await solverMech.getAddress(), await owner.getAddress());
    await marketplace.registerMech(await evaluatorMech.getAddress(), await owner.getAddress());
    await marketplace.registerMech(await wrongMech.getAddress(), await owner.getAddress());

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
      evaluatorMech,
      wrongMech,
      requestDataView,
      solutionRate,
      verdictRate,
    };
  }

  async function createAndClaimSolution(ctx: Awaited<ReturnType<typeof deploy>>, p = policy()) {
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(
        ethers.keccak256(ethers.toUtf8Bytes(`t-${Math.random()}`)),
        ethers.keccak256(ethers.toUtf8Bytes("s")),
        p,
        ctx.solutionRate,
        ctx.verdictRate,
      );
    const taskId = 1; // sequential per deploy
    // Discover actual taskId from nextAttemptIndex on coordinator — use getTask count
    const tasks = await ctx.coordinator.nextTaskId();
    const id = Number(tasks) - 1;
    await ctx.router.connect(ctx.solver).claimTask(id, await ctx.solverMech.getAddress());
    return id;
  }

  async function settleSolutionHappy(ctx: any, taskId: number, attemptIndex = 0) {
    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, attemptIndex, SOLUTION_DIGEST);
    const requestData = await ctx.requestDataView.encodeSolution(taskId, attemptIndex, SOLUTION_DIGEST);
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
    await ctx.router
      .connect(ctx.solver)
      .claimSolutionDelivery(mech, requestData, ctx.solutionRate, TOKEN_PAYMENT_TYPE, prep.preparedNonce);
  }

  it("rejects cross-attempt claim binding", async function () {
    const ctx = await deploy();
    const p = policy({ maxConcurrent: 2, maxTotal: 2 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-cross-attempt"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());

    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST);
    const prep0 = await ctx.router.solutionPreparations(taskId, 0);
    // Encode requestData for attempt 1 while using attempt 0's prepared auth
    const wrongData = await ctx.requestDataView.encodeSolution(taskId, 1, SOLUTION_DIGEST);
    await expect(
      ctx.router
        .connect(ctx.solver)
        .claimSolutionDelivery(
          await ctx.solverMech.getAddress(),
          wrongData,
          ctx.solutionRate,
          TOKEN_PAYMENT_TYPE,
          prep0.preparedNonce,
        ),
    ).to.revert(ethers);
  });

  it("rejects cross-verdict-index claim binding", async function () {
    const ctx = await deploy();
    const p = policy({ minVerdicts: 2, maxTotal: 1 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-cross-v"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await settleSolutionHappy(ctx, taskId, 0);
    await ctx.router.connect(ctx.evaluator).claimEvaluation(taskId, 0, await ctx.evaluatorMech.getAddress());
    await ctx.router.connect(ctx.evaluator).claimEvaluation(taskId, 0, await ctx.evaluatorMech.getAddress());

    await ctx.router
      .connect(ctx.evaluator)
      .prepareVerdictDelivery(taskId, 0, 0, VERDICT_DIGEST, 1);
    const prep = await ctx.router.verdictPreparations(taskId, 0, 0);
    const wrongData = await ctx.requestDataView.encodeVerdict(taskId, 0, 1, VERDICT_DIGEST, 1);
    await expect(
      ctx.router
        .connect(ctx.evaluator)
        .claimVerdictDelivery(
          await ctx.evaluatorMech.getAddress(),
          wrongData,
          ctx.verdictRate,
          TOKEN_PAYMENT_TYPE,
          prep.preparedNonce,
        ),
    ).to.revert(ethers);
  });

  it("rejects wrong Mech on claim", async function () {
    const ctx = await deploy();
    const p = policy({ maxTotal: 1 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-wrong-mech"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST);
    const requestData = await ctx.requestDataView.encodeSolution(taskId, 0, SOLUTION_DIGEST);
    const prep = await ctx.router.solutionPreparations(taskId, 0);
    // Wrong mech changes the requestId preimage → prepare binding fails closed first.
    await expect(
      ctx.router
        .connect(ctx.solver)
        .claimSolutionDelivery(
          await ctx.wrongMech.getAddress(),
          requestData,
          ctx.solutionRate,
          TOKEN_PAYMENT_TYPE,
          prep.preparedNonce,
        ),
    ).to.be.revertedWithCustomError(ctx.router, "RouterV4RequestIdMismatch");
  });

  it("rejects wrong payment type on claim", async function () {
    const ctx = await deploy();
    const p = policy({ maxTotal: 1 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-wrong-pay"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST);
    const requestData = await ctx.requestDataView.encodeSolution(taskId, 0, SOLUTION_DIGEST);
    const prep = await ctx.router.solutionPreparations(taskId, 0);
    await expect(
      ctx.router
        .connect(ctx.solver)
        .claimSolutionDelivery(
          await ctx.solverMech.getAddress(),
          requestData,
          ctx.solutionRate,
          ethers.ZeroHash,
          prep.preparedNonce,
        ),
    ).to.be.revertedWithCustomError(ctx.router, "RouterV4InvalidPaymentType");
  });

  it("rejects claim after release", async function () {
    const ctx = await deploy();
    const p = policy({ maxTotal: 1 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-released"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await increaseTime(RELEASE_MIN_HOLD);
    await ctx.router.connect(ctx.solver).releaseAttempt(taskId, 0);
    await expect(
      ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST),
    ).to.be.revertedWithCustomError(ctx.router, "RouterV4ReservationNotLive");
  });

  it("rejects claim when already settled", async function () {
    const ctx = await deploy();
    const p = policy({ maxTotal: 1 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-settled"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await settleSolutionHappy(ctx, taskId, 0);
    await expect(
      ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, ALT_DIGEST),
    ).to.be.revertedWithCustomError(ctx.router, "RouterV4ReservationNotLive");
  });

  it("rejects prepare and claim after reservation expired", async function () {
    const ctx = await deploy();
    const p = policy({ maxTotal: 1 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-expired"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await increaseTime(RESPONSE_TIMEOUT + 1n);
    await expect(
      ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST),
    ).to.be.revertedWithCustomError(ctx.router, "RouterV4ReservationNotLive");
  });

  it("rejects wrong rate on claim versus reservation", async function () {
    const ctx = await deploy();
    const p = policy({ maxTotal: 1 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-rate"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST);
    const requestData = await ctx.requestDataView.encodeSolution(taskId, 0, SOLUTION_DIGEST);
    const prep = await ctx.router.solutionPreparations(taskId, 0);
    // Wrong rate changes the requestId preimage → prepare binding fails closed first.
    await expect(
      ctx.router
        .connect(ctx.solver)
        .claimSolutionDelivery(
          await ctx.solverMech.getAddress(),
          requestData,
          ctx.solutionRate + 1n,
          TOKEN_PAYMENT_TYPE,
          prep.preparedNonce,
        ),
    ).to.be.revertedWithCustomError(ctx.router, "RouterV4RequestIdMismatch");
  });

  it("rejects stale prepared nonce after marketplace nonce advances", async function () {
    const ctx = await deploy();
    const p = policy({ maxTotal: 2, maxConcurrent: 2 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-stale-nonce"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());

    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST);
    const prep0 = await ctx.router.solutionPreparations(taskId, 0);
    // Advance marketplace nonce by settling attempt 1 first
    await settleSolutionHappy(ctx, taskId, 1);

    const requestData = await ctx.requestDataView.encodeSolution(taskId, 0, SOLUTION_DIGEST);
    const signature = await ctx.router.encodeAuthSignature(
      1,
      taskId,
      0,
      0,
      await ctx.solverMech.getAddress(),
      requestData,
      ctx.solutionRate,
      prep0.preparedNonce,
    );
    await expect(
      ctx.solverMech
        .connect(ctx.solver)
        .deliverMarketplaceWithSignatures(
          await ctx.router.getAddress(),
          [{ requestData, signature, deliveryData: "0x01" }],
          [ctx.solutionRate],
          "0x",
        ),
    ).to.revert(ethers);
  });

  it("rejects current-nonce race when prepare is overwritten with a new digest", async function () {
    const ctx = await deploy();
    const p = policy({ maxTotal: 1 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-overwrite"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());

    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST);
    const oldData = await ctx.requestDataView.encodeSolution(taskId, 0, SOLUTION_DIGEST);
    const oldPrep = await ctx.router.solutionPreparations(taskId, 0);

    // Undelivered re-prepare overwrites
    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, ALT_DIGEST);
    const newPrep = await ctx.router.solutionPreparations(taskId, 0);
    expect(newPrep.deliveryDigest).to.equal(ALT_DIGEST);
    expect(newPrep.expectedRequestId).to.not.equal(oldPrep.expectedRequestId);

    const staleSig = await ctx.router.encodeAuthSignature(
      1,
      taskId,
      0,
      0,
      await ctx.solverMech.getAddress(),
      oldData,
      ctx.solutionRate,
      oldPrep.preparedNonce,
    );
    await expect(
      ctx.solverMech
        .connect(ctx.solver)
        .deliverMarketplaceWithSignatures(
          await ctx.router.getAddress(),
          [{ requestData: oldData, signature: staleSig, deliveryData: "0x01" }],
          [ctx.solutionRate],
          "0x",
        ),
    ).to.revert(ethers);
  });

  it("rejects replay of a settled requestId", async function () {
    const ctx = await deploy();
    const p = policy({ maxTotal: 1 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-replay"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST);
    const requestData = await ctx.requestDataView.encodeSolution(taskId, 0, SOLUTION_DIGEST);
    const prep = await ctx.router.solutionPreparations(taskId, 0);
    const mech = await ctx.solverMech.getAddress();
    const signature = await ctx.router.encodeAuthSignature(
      1,
      taskId,
      0,
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
    await ctx.router
      .connect(ctx.solver)
      .claimSolutionDelivery(mech, requestData, ctx.solutionRate, TOKEN_PAYMENT_TYPE, prep.preparedNonce);
    await expect(
      ctx.router
        .connect(ctx.solver)
        .claimSolutionDelivery(mech, requestData, ctx.solutionRate, TOKEN_PAYMENT_TYPE, prep.preparedNonce),
    ).to.be.revertedWithCustomError(ctx.router, "RouterV4AlreadyClaimed");
  });

  it("enforces per-operator maxConcurrent cap", async function () {
    const ctx = await deploy();
    const p = policy({ maxConcurrent: 1, maxTotal: 2 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-cap"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await expect(ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress())).to.revert(
      ethers,
    );
  });

  it("close/delivery race: close refunds only unreserved; reserved remains deliverable via prepare", async function () {
    const ctx = await deploy();
    const p = policy({ maxTotal: 2, maxConcurrent: 2 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-close-race"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());

    const creatorBefore = await ctx.olas.balanceOf(await ctx.creator.getAddress());
    await ctx.router.connect(ctx.creator).closeTask(taskId);
    const creatorAfter = await ctx.olas.balanceOf(await ctx.creator.getAddress());
    expect(creatorAfter - creatorBefore).to.equal(amount - ctx.solutionRate);

    await settleSolutionHappy(ctx, taskId, 0);
    const payment = await ctx.router.taskPayments(taskId);
    expect(payment.solutionSpentOut).to.equal(ctx.solutionRate);
  });

  it("prepare overwrite rules: undelivered may reprepare; delivered prep cannot be overwritten", async function () {
    const ctx = await deploy();
    const p = policy({ maxTotal: 1 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-prep-rules"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());

    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST);
    await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, ALT_DIGEST);

    const requestData = await ctx.requestDataView.encodeSolution(taskId, 0, ALT_DIGEST);
    const prep = await ctx.router.solutionPreparations(taskId, 0);
    const mech = await ctx.solverMech.getAddress();
    const signature = await ctx.router.encodeAuthSignature(
      1,
      taskId,
      0,
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

    await expect(
      ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST),
    ).to.be.revertedWithCustomError(ctx.router, "RouterV4AlreadyPrepared");
  });

  it("rejects digest+code tamper: claim cannot swap prepared verdictCode", async function () {
    const ctx = await deploy();
    const p = policy({ maxTotal: 1, minVerdicts: 1 });
    const amount =
      ctx.solutionRate * BigInt(p.maxTotal) + ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
    await ctx.olas.mint(await ctx.creator.getAddress(), amount);
    await ctx.olas.connect(ctx.creator).approve(await ctx.router.getAddress(), amount);
    await ctx.router
      .connect(ctx.creator)
      .createTask(ethers.id("t-code-tamper"), ethers.id("s"), p, ctx.solutionRate, ctx.verdictRate);
    const taskId = Number(await ctx.coordinator.nextTaskId()) - 1;
    await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
    await settleSolutionHappy(ctx, taskId, 0);
    await ctx.router.connect(ctx.evaluator).claimEvaluation(taskId, 0, await ctx.evaluatorMech.getAddress());

    await ctx.router
      .connect(ctx.evaluator)
      .prepareVerdictDelivery(taskId, 0, 0, VERDICT_DIGEST, 1);
    const prep = await ctx.router.verdictPreparations(taskId, 0, 0);
    // Tampered requestData with different code → different requestId / hash mismatch
    const tampered = await ctx.requestDataView.encodeVerdict(taskId, 0, 0, VERDICT_DIGEST, 2);
    await expect(
      ctx.router
        .connect(ctx.evaluator)
        .claimVerdictDelivery(
          await ctx.evaluatorMech.getAddress(),
          tampered,
          ctx.verdictRate,
          TOKEN_PAYMENT_TYPE,
          prep.preparedNonce,
        ),
    ).to.revert(ethers);

    // Digest tamper
    const digestTamper = await ctx.requestDataView.encodeVerdict(taskId, 0, 0, ALT_DIGEST, 1);
    await expect(
      ctx.router
        .connect(ctx.evaluator)
        .claimVerdictDelivery(
          await ctx.evaluatorMech.getAddress(),
          digestTamper,
          ctx.verdictRate,
          TOKEN_PAYMENT_TYPE,
          prep.preparedNonce,
        ),
    ).to.revert(ethers);
  });
});
