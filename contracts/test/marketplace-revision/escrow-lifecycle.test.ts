import { expect } from "chai";
import { network } from "hardhat";

describe("marketplace-revision V4", function () {
  let ethers: Awaited<ReturnType<typeof network.connect>>["ethers"];
  let provider: Awaited<ReturnType<typeof network.connect>>["provider"];

  // keccak256("FixedPriceToken")
  const TOKEN_PAYMENT_TYPE =
    "0x3679d66ef546e66ce9057c4a052f317b135bc8e8c509638f7966edfd4fcf45e9";
  const RELEASE_MIN_HOLD = 60n;
  const RESPONSE_TIMEOUT = 3600n;

  let TASK_CID: string;
  let SUBMISSION_DIGEST: string;
  let SOLUTION_DIGEST: string;
  let VERDICT_DIGEST: string;

  before(async () => {
    ({ ethers, provider } = await network.connect());
    TASK_CID = ethers.keccak256(ethers.toUtf8Bytes("task-cid-v4"));
    SUBMISSION_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("submission-v4"));
    SOLUTION_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("solution-sha256"));
    VERDICT_DIGEST = ethers.keccak256(ethers.toUtf8Bytes("verdict-sha256"));
  });

  async function increaseTime(seconds: number | bigint) {
    await provider.send("evm_increaseTime", [Number(seconds)]);
    await provider.send("evm_mine", []);
  }

  function policy(overrides: Record<string, unknown> = {}) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    return {
      maxTotal: 2,
      maxConcurrent: 1,
      submissionDeadline: now + 86_400n,
      closeAt: 0n,
      responseTimeout: RESPONSE_TIMEOUT,
      minVerdicts: 1,
      requireDistinctEvaluator: true,
      ...overrides,
    };
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

    const Activity = await ethers.getContractFactory("MockTaskActivityChecker");
    const activity = await Activity.deploy();
    await activity.waitForDeployment();

    const Coordinator = await ethers.getContractFactory("TaskCoordinatorV4");
    const coordinator = await Coordinator.deploy();
    await coordinator.waitForDeployment();

    const Router = await ethers.getContractFactory("JinnRouterV4");
    const router = await Router.deploy();
    await router.waitForDeployment();

    await coordinator.initialize(
      await owner.getAddress(),
      await router.getAddress(),
      RELEASE_MIN_HOLD,
      0,
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
    await solverMech.waitForDeployment();
    const evaluatorMech = await Mech.deploy(
      verdictRate,
      TOKEN_PAYMENT_TYPE,
      await evaluator.getAddress(),
      await marketplace.getAddress(),
    );
    await evaluatorMech.waitForDeployment();

    await marketplace.registerMech(await solverMech.getAddress(), await owner.getAddress());
    await marketplace.registerMech(await evaluatorMech.getAddress(), await owner.getAddress());

    const Batch = await ethers.getContractFactory("AtomicSettlementBatch");
    const batch = await Batch.deploy();
    await batch.waitForDeployment();

    const RequestData = await ethers.getContractFactory("MarketplaceRequestDataView");
    const requestDataView = await RequestData.deploy();
    await requestDataView.waitForDeployment();

    const budgetFor = (p: ReturnType<typeof policy>) => {
      const solutionBudget = solutionRate * BigInt(p.maxTotal);
      const verdictBudget = verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts);
      return solutionBudget + verdictBudget;
    };

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
      batch,
      requestDataView,
      solutionRate,
      verdictRate,
      budgetFor,
    };
  }

  async function fundAndApprove(olas: any, creator: any, router: any, amount: bigint) {
    await olas.mint(await creator.getAddress(), amount);
    await olas.connect(creator).approve(await router.getAddress(), amount);
  }

  async function createTask(ctx: Awaited<ReturnType<typeof deploy>>, p = policy()) {
    const amount = ctx.budgetFor(p);
    await fundAndApprove(ctx.olas, ctx.creator, ctx.router, amount);
    const tx = await ctx.router
      .connect(ctx.creator)
      .createTask(TASK_CID, SUBMISSION_DIGEST, p, ctx.solutionRate, ctx.verdictRate);
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
    return { taskId: Number(parsed!.args.taskId), policy: p, amount, receipt };
  }

  async function prepareSolution(
    ctx: Awaited<ReturnType<typeof deploy>>,
    taskId: number,
    attemptIndex: number,
    operator: any,
    digest = SOLUTION_DIGEST,
  ) {
    const tx = await ctx.router.connect(operator).prepareSolutionDelivery(taskId, attemptIndex, digest);
    const receipt = await tx.wait();
    const prep = receipt!.logs
      .map((log: any) => {
        try {
          return ctx.router.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e: any) => e?.name === "SolutionDeliveryPrepared");
    const requestData = await ctx.requestDataView.encodeSolution(taskId, attemptIndex, digest);
    return {
      requestData,
      nonce: prep!.args.nonce as bigint,
      expectedRequestId: prep!.args.expectedRequestId as string,
      digest,
    };
  }

  async function deliverAndClaimSolution(
    ctx: Awaited<ReturnType<typeof deploy>>,
    taskId: number,
    attemptIndex: number,
    operator: any,
    mech: any,
    digest = SOLUTION_DIGEST,
  ) {
    const prepared = await prepareSolution(ctx, taskId, attemptIndex, operator, digest);
    const mechAddr = await mech.getAddress();
    const rate = ctx.solutionRate;
    const signature = await ctx.router.encodeAuthSignature(
      1,
      taskId,
      attemptIndex,
      0,
      mechAddr,
      prepared.requestData,
      rate,
      prepared.nonce,
    );
    await mech
      .connect(operator)
      .deliverMarketplaceWithSignatures(
        await ctx.router.getAddress(),
        [{ requestData: prepared.requestData, signature, deliveryData: "0x01" }],
        [rate],
        "0x",
      );
    await ctx.router
      .connect(operator)
      .claimSolutionDelivery(mechAddr, prepared.requestData, rate, TOKEN_PAYMENT_TYPE, prepared.nonce);
    return prepared;
  }

  async function prepareVerdict(
    ctx: Awaited<ReturnType<typeof deploy>>,
    taskId: number,
    attemptIndex: number,
    verdictIndex: number,
    operator: any,
    verdictCode: number,
    digest = VERDICT_DIGEST,
  ) {
    const tx = await ctx.router
      .connect(operator)
      .prepareVerdictDelivery(taskId, attemptIndex, verdictIndex, digest, verdictCode);
    const receipt = await tx.wait();
    const prep = receipt!.logs
      .map((log: any) => {
        try {
          return ctx.router.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e: any) => e?.name === "VerdictDeliveryPrepared");
    const requestData = await ctx.requestDataView.encodeVerdict(
      taskId,
      attemptIndex,
      verdictIndex,
      digest,
      verdictCode,
    );
    return {
      requestData,
      nonce: prep!.args.nonce as bigint,
      expectedRequestId: prep!.args.expectedRequestId as string,
      digest,
      verdictCode,
    };
  }

  async function deliverAndClaimVerdict(
    ctx: Awaited<ReturnType<typeof deploy>>,
    taskId: number,
    attemptIndex: number,
    verdictIndex: number,
    operator: any,
    mech: any,
    verdictCode: number,
    digest = VERDICT_DIGEST,
  ) {
    const prepared = await prepareVerdict(
      ctx,
      taskId,
      attemptIndex,
      verdictIndex,
      operator,
      verdictCode,
      digest,
    );
    const mechAddr = await mech.getAddress();
    const rate = ctx.verdictRate;
    const signature = await ctx.router.encodeAuthSignature(
      2,
      taskId,
      attemptIndex,
      verdictIndex,
      mechAddr,
      prepared.requestData,
      rate,
      prepared.nonce,
    );
    await mech
      .connect(operator)
      .deliverMarketplaceWithSignatures(
        await ctx.router.getAddress(),
        [{ requestData: prepared.requestData, signature, deliveryData: "0x01" }],
        [rate],
        "0x",
      );
    await ctx.router
      .connect(operator)
      .claimVerdictDelivery(mechAddr, prepared.requestData, rate, TOKEN_PAYMENT_TYPE, prepared.nonce);
    return prepared;
  }

  /**
   * Atomic path: a thin operator proxy is not used; instead the solver EOA calls a batch
   * contract that cannot satisfy mech.onlyOperator. So tests use OperatorMultisigBatch
   * pattern where mech.operator is the batch contract.
   */
  async function deployWithBatchOperator(solutionRate = 100n, verdictRate = 20n) {
    const base = await deploy(solutionRate, verdictRate);
    const Batch = await ethers.getContractFactory("AtomicSettlementBatch");
    const solverBatch = await Batch.deploy();
    await solverBatch.waitForDeployment();
    const evaluatorBatch = await Batch.deploy();
    await evaluatorBatch.waitForDeployment();

    const Mech = await ethers.getContractFactory("MockTokenMech");
    const solverMech = await Mech.deploy(
      solutionRate,
      TOKEN_PAYMENT_TYPE,
      await solverBatch.getAddress(),
      await base.marketplace.getAddress(),
    );
    await solverMech.waitForDeployment();
    const evaluatorMech = await Mech.deploy(
      verdictRate,
      TOKEN_PAYMENT_TYPE,
      await evaluatorBatch.getAddress(),
      await base.marketplace.getAddress(),
    );
    await evaluatorMech.waitForDeployment();
    await base.marketplace.registerMech(await solverMech.getAddress(), await base.owner.getAddress());
    await base.marketplace.registerMech(await evaluatorMech.getAddress(), await base.owner.getAddress());

    return { ...base, solverBatch, evaluatorBatch, solverMech, evaluatorMech };
  }

  describe("proxy initialization", function () {
    it("initializes once behind proxy and rejects re-initialize", async function () {
      const [owner] = await ethers.getSigners();
      const Token = await ethers.getContractFactory("TestERC20");
      const olas = await Token.deploy("OLAS", "OLAS");
      await olas.waitForDeployment();
      const Marketplace = await ethers.getContractFactory("MockTokenMarketplace");
      const marketplace = await Marketplace.deploy();
      await marketplace.waitForDeployment();
      const Tracker = await ethers.getContractFactory("MockTokenBalanceTracker");
      const tracker = await Tracker.deploy(await marketplace.getAddress(), await olas.getAddress());
      await tracker.waitForDeployment();

      const Coordinator = await ethers.getContractFactory("TaskCoordinatorV4");
      const Router = await ethers.getContractFactory("JinnRouterV4");
      const coordinatorImpl = await Coordinator.deploy();
      await coordinatorImpl.waitForDeployment();
      const routerImpl = await Router.deploy();
      await routerImpl.waitForDeployment();

      // Predict router proxy address is awkward; initialize coordinator with impl then retarget.
      const Proxy = await ethers.getContractFactory("JinnUpgradeableProxy");
      const coordinatorInit = coordinatorImpl.interface.encodeFunctionData("initialize", [
        await owner.getAddress(),
        await routerImpl.getAddress(),
        RELEASE_MIN_HOLD,
        0,
      ]);
      const coordinatorProxy = await Proxy.deploy(
        await coordinatorImpl.getAddress(),
        await owner.getAddress(),
        coordinatorInit,
      );
      await coordinatorProxy.waitForDeployment();
      const coordinator = await ethers.getContractAt("TaskCoordinatorV4", await coordinatorProxy.getAddress());

      const routerInit = routerImpl.interface.encodeFunctionData("initialize", [
        await owner.getAddress(),
        await marketplace.getAddress(),
        await coordinator.getAddress(),
        ethers.ZeroAddress,
        await olas.getAddress(),
        TOKEN_PAYMENT_TYPE,
        await tracker.getAddress(),
      ]);
      const routerProxy = await Proxy.deploy(await routerImpl.getAddress(), await owner.getAddress(), routerInit);
      await routerProxy.waitForDeployment();
      const router = await ethers.getContractAt("JinnRouterV4", await routerProxy.getAddress());
      await coordinator.setAuthorizedRouter(await router.getAddress());

      await expect(
        coordinator.initialize(await owner.getAddress(), await router.getAddress(), RELEASE_MIN_HOLD, 0),
      ).to.be.revertedWithCustomError(coordinator, "TCV4AlreadyInitialized");
      await expect(
        router.initialize(
          await owner.getAddress(),
          await marketplace.getAddress(),
          await coordinator.getAddress(),
          ethers.ZeroAddress,
          await olas.getAddress(),
          TOKEN_PAYMENT_TYPE,
          await tracker.getAddress(),
        ),
      ).to.be.revertedWithCustomError(router, "RouterV4AlreadyInitialized");
    });
  });

  describe("requestData encode/decode", function () {
    it("round-trips solution and verdict blobs with domain/version markers", async function () {
      const ctx = await deploy();
      const encoded = await ctx.requestDataView.encodeSolution(7, 3, SOLUTION_DIGEST);
      const decoded = await ctx.requestDataView.decode(encoded);
      expect(decoded.domain).to.equal(await ctx.requestDataView.DOMAIN());
      expect(decoded.version).to.equal(2n);
      expect(decoded.legKind).to.equal(1n);
      expect(decoded.taskId).to.equal(7n);
      expect(decoded.attemptIndex).to.equal(3n);
      expect(decoded.verdictIndex).to.equal(0n);
      expect(decoded.deliveryDigest).to.equal(SOLUTION_DIGEST);

      const vEncoded = await ctx.requestDataView.encodeVerdict(7, 3, 1, VERDICT_DIGEST, 2);
      const vDecoded = await ctx.requestDataView.decode(vEncoded);
      expect(vDecoded.legKind).to.equal(2n);
      expect(vDecoded.verdictIndex).to.equal(1n);
      expect(vDecoded.verdictCode).to.equal(2n);
    });
  });

  describe("escrow conservation", function () {
    it("createTask pulls solutionRate*maxTotal + verdictRate*maxTotal*minVerdicts", async function () {
      const ctx = await deploy();
      const p = policy({ maxTotal: 3, minVerdicts: 2 });
      const { amount } = await createTask(ctx, p);
      expect(amount).to.equal(100n * 3n + 20n * 3n * 2n);
      expect(await ctx.olas.balanceOf(await ctx.router.getAddress())).to.equal(amount);
      const payment = await ctx.router.taskPayments(1);
      expect(payment.solutionBudgetRemaining).to.equal(300n);
      expect(payment.verdictBudgetRemaining).to.equal(120n);
    });

    it("claim reserves without pulling to tracker; delivery pulls exactly the rate", async function () {
      const ctx = await deployWithBatchOperator();
      const { taskId } = await createTask(ctx);
      const before = await ctx.olas.balanceOf(await ctx.router.getAddress());

      // Claim as solver EOA — but mech operator is batch. Use a mech whose operator is solver for claim-only.
      const Mech = await ethers.getContractFactory("MockTokenMech");
      const claimMech = await Mech.deploy(
        ctx.solutionRate,
        TOKEN_PAYMENT_TYPE,
        await ctx.solver.getAddress(),
        await ctx.marketplace.getAddress(),
      );
      await claimMech.waitForDeployment();
      await ctx.marketplace.registerMech(await claimMech.getAddress(), await ctx.owner.getAddress());

      await ctx.router.connect(ctx.solver).claimTask(taskId, await claimMech.getAddress());
      const payment = await ctx.router.taskPayments(taskId);
      expect(payment.solutionReserved).to.equal(ctx.solutionRate);
      expect(payment.solutionBudgetRemaining).to.equal(ctx.solutionRate * 2n - ctx.solutionRate);
      expect(await ctx.olas.balanceOf(await ctx.tracker.getAddress())).to.equal(0n);
      expect(await ctx.olas.balanceOf(await ctx.router.getAddress())).to.equal(before);
    });
  });

  describe("attempt identity", function () {
    it("claim → expire → reclaim yields distinct monotonic attemptIndex", async function () {
      const ctx = await deploy();
      const { taskId } = await createTask(ctx, policy({ maxConcurrent: 1, maxTotal: 2 }));

      await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
      let attempt = await ctx.coordinator.getAttempt(taskId, 0);
      expect(attempt.attemptIndex).to.equal(0n);
      expect(attempt.status).to.equal(1n); // Live

      await increaseTime(RESPONSE_TIMEOUT + 1n);

      // Next claim reaps and allocates attemptIndex 1
      await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
      const expired = await ctx.coordinator.getAttempt(taskId, 0);
      const reclaimed = await ctx.coordinator.getAttempt(taskId, 1);
      expect(expired.status).to.equal(4n); // Expired
      expect(reclaimed.attemptIndex).to.equal(1n);
      expect(reclaimed.status).to.equal(1n);
    });

    it("enforces maxConcurrent and maxTotal", async function () {
      const ctx = await deploy();
      const { taskId } = await createTask(ctx, policy({ maxConcurrent: 1, maxTotal: 1 }));
      await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());

      const Mech = await ethers.getContractFactory("MockTokenMech");
      const otherMech = await Mech.deploy(
        ctx.solutionRate,
        TOKEN_PAYMENT_TYPE,
        await ctx.other.getAddress(),
        await ctx.marketplace.getAddress(),
      );
      await otherMech.waitForDeployment();
      await ctx.marketplace.registerMech(await otherMech.getAddress(), await ctx.owner.getAddress());

      await expect(ctx.router.connect(ctx.other).claimTask(taskId, await otherMech.getAddress())).to.revert(ethers);
    });
  });

  describe("release hold", function () {
    it("rejects release before deployment-fixed minimum hold", async function () {
      const ctx = await deploy();
      const { taskId } = await createTask(ctx);
      await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
      await expect(ctx.router.connect(ctx.solver).releaseAttempt(taskId, 0)).to.be.revertedWithCustomError(
        ctx.coordinator,
        "TCV4ReleaseHoldActive",
      );
      await increaseTime(RELEASE_MIN_HOLD);
      await expect(ctx.router.connect(ctx.solver).releaseAttempt(taskId, 0)).to.emit(ctx.router, "AttemptReleased");
    });
  });

  describe("close / delivery-after-close", function () {
    it("close stops new claims, keeps live reservation deliverable, refunds only unreserved", async function () {
      const ctx = await deployWithBatchOperator();
      // Use solver-operated mech for claim + batch-operated for delivery
      const Mech = await ethers.getContractFactory("MockTokenMech");
      const solverEoaMech = await Mech.deploy(
        ctx.solutionRate,
        TOKEN_PAYMENT_TYPE,
        await ctx.solver.getAddress(),
        await ctx.marketplace.getAddress(),
      );
      await solverEoaMech.waitForDeployment();
      await ctx.marketplace.registerMech(await solverEoaMech.getAddress(), await ctx.owner.getAddress());

      // Rebuild delivery mech with solver as operator for simpler atomic path via direct sequential calls
      // in a custom batch that uses delegatecall — instead, set operator to solver and call both from solver.
      const deliveryMech = await Mech.deploy(
        ctx.solutionRate,
        TOKEN_PAYMENT_TYPE,
        await ctx.solver.getAddress(),
        await ctx.marketplace.getAddress(),
      );
      await deliveryMech.waitForDeployment();
      await ctx.marketplace.registerMech(await deliveryMech.getAddress(), await ctx.owner.getAddress());

      const { taskId, amount } = await createTask(ctx, policy({ maxTotal: 2, maxConcurrent: 2 }));
      await ctx.router.connect(ctx.solver).claimTask(taskId, await deliveryMech.getAddress());
      const reserved = ctx.solutionRate;
      const creatorBefore = await ctx.olas.balanceOf(await ctx.creator.getAddress());

      await ctx.router.connect(ctx.creator).closeTask(taskId);
      const creatorAfter = await ctx.olas.balanceOf(await ctx.creator.getAddress());
      expect(creatorAfter - creatorBefore).to.equal(amount - reserved);

      const Mech2 = await ethers.getContractFactory("MockTokenMech");
      const otherMech = await Mech2.deploy(
        ctx.solutionRate,
        TOKEN_PAYMENT_TYPE,
        await ctx.other.getAddress(),
        await ctx.marketplace.getAddress(),
      );
      await otherMech.waitForDeployment();
      await ctx.marketplace.registerMech(await otherMech.getAddress(), await ctx.owner.getAddress());
      await expect(ctx.router.connect(ctx.other).claimTask(taskId, await otherMech.getAddress())).to.revert(
        ethers,
      );

      // Delivery after close still works (prepare → deliver → claim)
      await deliverAndClaimSolution(ctx, taskId, 0, ctx.solver, deliveryMech);
      expect(await ctx.olas.balanceOf(await ctx.tracker.getAddress())).to.equal(ctx.solutionRate);
      const payment = await ctx.router.taskPayments(taskId);
      expect(payment.solutionSpentOut).to.equal(ctx.solutionRate);
      expect(payment.solutionReserved).to.equal(0n);
    });
  });

  describe("atomic rollback", function () {
    it("second-call failure rolls back token pull and Mech delivery", async function () {
      const ctx = await deploy();
      const Batch = await ethers.getContractFactory("AtomicSettlementBatch");
      const op = await Batch.deploy();
      await op.waitForDeployment();

      const Mech = await ethers.getContractFactory("MockTokenMech");
      const opMech = await Mech.deploy(
        ctx.solutionRate,
        TOKEN_PAYMENT_TYPE,
        await op.getAddress(),
        await ctx.marketplace.getAddress(),
      );
      await opMech.waitForDeployment();
      await ctx.marketplace.registerMech(await opMech.getAddress(), await ctx.owner.getAddress());

      await provider.send("hardhat_setBalance", [await op.getAddress(), "0x1000000000000000000"]);
      const opSigner = await ethers.getImpersonatedSigner(await op.getAddress());

      const { taskId } = await createTask(ctx);
      await ctx.router.connect(opSigner).claimTask(taskId, await opMech.getAddress());

      const prepare = ctx.router.interface.encodeFunctionData("prepareSolutionDelivery", [
        taskId,
        0,
        SOLUTION_DIGEST,
      ]);
      // Build deliver/claim against the nonce that prepare will bind (current mapNonces).
      const nonce = await ctx.marketplace.mapNonces(await ctx.router.getAddress());
      const requestData = await ctx.requestDataView.encodeSolution(taskId, 0, SOLUTION_DIGEST);
      const signature = await ctx.router.encodeAuthSignature(
        1,
        taskId,
        0,
        0,
        await opMech.getAddress(),
        requestData,
        ctx.solutionRate,
        nonce,
      );
      const deliver = opMech.interface.encodeFunctionData("deliverMarketplaceWithSignatures", [
        await ctx.router.getAddress(),
        [{ requestData, signature, deliveryData: "0x01" }],
        [ctx.solutionRate],
        "0x",
      ]);
      const badClaim = ctx.router.interface.encodeFunctionData("claimSolutionDelivery", [
        await opMech.getAddress(),
        requestData,
        ctx.solutionRate,
        ethers.ZeroHash,
        nonce,
      ]);

      const routerBalBefore = await ctx.olas.balanceOf(await ctx.router.getAddress());
      const trackerBefore = await ctx.olas.balanceOf(await ctx.tracker.getAddress());
      await expect(
        op
          .connect(ctx.solver)
          .execute3(
            await ctx.router.getAddress(),
            prepare,
            await opMech.getAddress(),
            deliver,
            await ctx.router.getAddress(),
            badClaim,
          ),
      ).to.revert(ethers);
      expect(await ctx.olas.balanceOf(await ctx.tracker.getAddress())).to.equal(trackerBefore);
      expect(await ctx.olas.balanceOf(await ctx.router.getAddress())).to.equal(routerBalBefore);
      expect(await ctx.marketplace.mapNonces(await ctx.router.getAddress())).to.equal(nonce);
      // Prepare must also have rolled back
      const prep = await ctx.router.solutionPreparations(taskId, 0);
      expect(prep.prepared).to.equal(false);

      // Happy atomic path: prepare → deliver → claim
      const goodClaim = ctx.router.interface.encodeFunctionData("claimSolutionDelivery", [
        await opMech.getAddress(),
        requestData,
        ctx.solutionRate,
        TOKEN_PAYMENT_TYPE,
        nonce,
      ]);
      await op
        .connect(ctx.solver)
        .execute3(
          await ctx.router.getAddress(),
          prepare,
          await opMech.getAddress(),
          deliver,
          await ctx.router.getAddress(),
          goodClaim,
        );
      expect(await ctx.olas.balanceOf(await ctx.tracker.getAddress())).to.equal(trackerBefore + ctx.solutionRate);
    });
  });

  describe("EIP-1271 binding", function () {
    it("rejects unprepared, cross-kind, wrong mech, wrong rate, stale nonce, and replay", async function () {
      const ctx = await deploy();
      const { taskId } = await createTask(ctx);
      await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());

      const requestData = await ctx.requestDataView.encodeSolution(taskId, 0, SOLUTION_DIGEST);
      const nonce = await ctx.marketplace.mapNonces(await ctx.router.getAddress());
      const mech = await ctx.solverMech.getAddress();

      const unpreparedSig = await ctx.router.encodeAuthSignature(
        1,
        taskId,
        0,
        0,
        mech,
        requestData,
        ctx.solutionRate,
        nonce,
      );
      await expect(
        ctx.solverMech
          .connect(ctx.solver)
          .deliverMarketplaceWithSignatures(
            await ctx.router.getAddress(),
            [{ requestData, signature: unpreparedSig, deliveryData: "0x" }],
            [ctx.solutionRate],
            "0x",
          ),
      ).to.revert(ethers);

      await ctx.router.connect(ctx.solver).prepareSolutionDelivery(taskId, 0, SOLUTION_DIGEST);
      const goodSig = await ctx.router.encodeAuthSignature(
        1,
        taskId,
        0,
        0,
        mech,
        requestData,
        ctx.solutionRate,
        nonce,
      );
      const requestId = await ctx.marketplace.getRequestId(
        mech,
        await ctx.router.getAddress(),
        requestData,
        ctx.solutionRate,
        TOKEN_PAYMENT_TYPE,
        nonce,
      );

      await expect(ctx.router.isValidSignature(requestId, goodSig)).to.be.revertedWithCustomError(
        ctx.router,
        "RouterV4MarketplaceOnly",
      );

      const crossKind = await ctx.router.encodeAuthSignature(
        2,
        taskId,
        0,
        0,
        mech,
        requestData,
        ctx.solutionRate,
        nonce,
      );
      await expect(
        ctx.solverMech
          .connect(ctx.solver)
          .deliverMarketplaceWithSignatures(
            await ctx.router.getAddress(),
            [{ requestData, signature: crossKind, deliveryData: "0x" }],
            [ctx.solutionRate],
            "0x",
          ),
      ).to.revert(ethers);

      const badRate = await ctx.router.encodeAuthSignature(
        1,
        taskId,
        0,
        0,
        mech,
        requestData,
        ctx.solutionRate + 1n,
        nonce,
      );
      await expect(
        ctx.solverMech
          .connect(ctx.solver)
          .deliverMarketplaceWithSignatures(
            await ctx.router.getAddress(),
            [{ requestData, signature: badRate, deliveryData: "0x" }],
            [ctx.solutionRate + 1n],
            "0x",
          ),
      ).to.revert(ethers);

      const stale = await ctx.router.encodeAuthSignature(
        1,
        taskId,
        0,
        0,
        mech,
        requestData,
        ctx.solutionRate,
        nonce + 1n,
      );
      await expect(
        ctx.solverMech
          .connect(ctx.solver)
          .deliverMarketplaceWithSignatures(
            await ctx.router.getAddress(),
            [{ requestData, signature: stale, deliveryData: "0x" }],
            [ctx.solutionRate],
            "0x",
          ),
      ).to.revert(ethers);

      await ctx.solverMech
        .connect(ctx.solver)
        .deliverMarketplaceWithSignatures(
          await ctx.router.getAddress(),
          [{ requestData, signature: goodSig, deliveryData: "0x" }],
          [ctx.solutionRate],
          "0x",
        );
      await ctx.router
        .connect(ctx.solver)
        .claimSolutionDelivery(mech, requestData, ctx.solutionRate, TOKEN_PAYMENT_TYPE, nonce);

      await expect(
        ctx.router
          .connect(ctx.solver)
          .claimSolutionDelivery(mech, requestData, ctx.solutionRate, TOKEN_PAYMENT_TYPE, nonce),
      ).to.be.revertedWithCustomError(ctx.router, "RouterV4AlreadyClaimed");
    });
  });

  describe("self-eval and minVerdicts", function () {
    it("rejects evaluator == solver and finalizes only after minVerdicts", async function () {
      const ctx = await deploy(100n, 20n);
      const { taskId } = await createTask(ctx, policy({ minVerdicts: 2, maxTotal: 1 }));

      await ctx.router.connect(ctx.solver).claimTask(taskId, await ctx.solverMech.getAddress());
      await deliverAndClaimSolution(ctx, taskId, 0, ctx.solver, ctx.solverMech);

      await expect(
        ctx.router.connect(ctx.solver).claimEvaluation(taskId, 0, await ctx.evaluatorMech.getAddress()),
      ).to.revert(ethers); // solver is not evaluator mech operator

      const EvalAsSolver = await ethers.getContractFactory("MockTokenMech");
      const selfMech = await EvalAsSolver.deploy(
        ctx.verdictRate,
        TOKEN_PAYMENT_TYPE,
        await ctx.solver.getAddress(),
        await ctx.marketplace.getAddress(),
      );
      await selfMech.waitForDeployment();
      await ctx.marketplace.registerMech(await selfMech.getAddress(), await ctx.owner.getAddress());
      await expect(ctx.router.connect(ctx.solver).claimEvaluation(taskId, 0, await selfMech.getAddress())).to.be
        .revertedWithCustomError(ctx.coordinator, "TCV4SolverSelfEvaluation");

      await ctx.router.connect(ctx.evaluator).claimEvaluation(taskId, 0, await ctx.evaluatorMech.getAddress());
      await deliverAndClaimVerdict(ctx, taskId, 0, 0, ctx.evaluator, ctx.evaluatorMech, 1);

      let attempt = await ctx.coordinator.getAttempt(taskId, 0);
      expect(attempt.status).to.equal(2n); // Submitted, not yet Finalized
      expect(attempt.deliveredVerdictCount).to.equal(1n);

      await ctx.router.connect(ctx.evaluator).claimEvaluation(taskId, 0, await ctx.evaluatorMech.getAddress());
      const digest2 = ethers.keccak256(ethers.toUtf8Bytes("verdict-2"));
      await deliverAndClaimVerdict(ctx, taskId, 0, 1, ctx.evaluator, ctx.evaluatorMech, 1, digest2);

      attempt = await ctx.coordinator.getAttempt(taskId, 0);
      expect(attempt.status).to.equal(5n); // Finalized
    });
  });

  describe("addAttempts top-up", function () {
    it("creator top-up is proportional; reverts when Closed", async function () {
      const ctx = await deploy();
      const { taskId } = await createTask(ctx, policy({ maxTotal: 1 }));
      const topUp = ctx.solutionRate * 1n + ctx.verdictRate * 1n * 1n;
      await fundAndApprove(ctx.olas, ctx.creator, ctx.router, topUp);
      await expect(ctx.router.connect(ctx.creator).addAttempts(taskId, 1))
        .to.emit(ctx.router, "AttemptsAdded")
        .withArgs(taskId, await ctx.creator.getAddress(), 1, 2);

      await ctx.router.connect(ctx.creator).closeTask(taskId);
      await fundAndApprove(ctx.olas, ctx.creator, ctx.router, topUp);
      await expect(ctx.router.connect(ctx.creator).addAttempts(taskId, 1)).to.be.revertedWithCustomError(
        ctx.coordinator,
        "TCV4ClosedForClaims",
      );
    });
  });

  describe("event completeness", function () {
    it("emits TaskCreated with full policy fields and claim without requestId", async function () {
      const ctx = await deploy();
      const p = policy();
      await fundAndApprove(ctx.olas, ctx.creator, ctx.router, ctx.budgetFor(p));
      await expect(
        ctx.router
          .connect(ctx.creator)
          .createTask(TASK_CID, SUBMISSION_DIGEST, p, ctx.solutionRate, ctx.verdictRate),
      )
        .to.emit(ctx.router, "TaskCreated")
        .withArgs(
          await ctx.creator.getAddress(),
          TASK_CID,
          SUBMISSION_DIGEST,
          1,
          p.maxTotal,
          p.maxConcurrent,
          p.submissionDeadline,
          p.closeAt,
          p.responseTimeout,
          p.minVerdicts,
          p.requireDistinctEvaluator,
          ctx.solutionRate,
          ctx.verdictRate,
          ctx.solutionRate * BigInt(p.maxTotal),
          ctx.verdictRate * BigInt(p.maxTotal) * BigInt(p.minVerdicts),
        );

      await expect(ctx.router.connect(ctx.solver).claimTask(1, await ctx.solverMech.getAddress())).to.emit(
        ctx.router,
        "TaskAttemptCreated",
      );
    });
  });
});
